"use strict";
// tools/run_bench.js -- zero-dependency benchmark harness: ./skyjs (QuickJS
// services) vs the stock Lua skynet node (methodology in docs/bench.md).
//
// Model: both sides run case-for-case mirrored bench scripts emitting
//   BENCH_BEGIN <case> / BENCH_END <case>   coarse wall markers (sanity only)
//   BENCH case=<name> n=<N> mps=<v> ms=<ms> THE timing: in-process monotonic
//                                           clock around the measured loop
//   BENCH_SUITE_DONE                        kill switch
// The in-process ms field wins because log lines cross the logger service
// asynchronously and lag under CPU saturation. Phases:
//   core    single node, core messaging cases (bench_main.js / main.lua)
//   cluster two nodes over skyclusterd / lua clusterd, three pair types
//   socket  TCP echo servers on :2601 + the shared node load client
// The two sides run SEQUENTIALLY per round so they never contend for CPU;
// --repeat rounds give median + min/max per case. Environment (commit, CPU,
// allocator check, RSS peaks) is captured into build/bench/report.md and a
// raw_*.json for regression comparisons.
//
// Usage: node tools/run_bench.js [--phase core|cluster|socket|all]
//        [--repeat N] [--timeout ms]

const fs = require("fs");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const rt = require("./run_tests.js");        // ROOT / BIN / watch_lines / kill_tree / free_cluster_ports

const SKYNET_DIR = path.join(rt.ROOT, "3rd", "skynet");
const OUT_DIR = path.join(rt.ROOT, "build", "bench");
const CLIENT = path.join(rt.ROOT, "tools", "bench_socket_client.js");
const DEFAULT_TIMEOUT_MS = 180000;
const SOCKET_PORT = 2601;
const SOCKET_SIZES = [64, 4096, 65536];
const SOCKET_TOTAL = { 64: 100000, 4096: 50000, 65536: 10000 };

// case display order; per phase the rows present in results are reported
const CORE_ORDER = [
    "rt_text_c", "rt_text_self", "rt_text_s256", "rt_text_s4k", "rt_text_s64k",
    "rt_lua_self", "send_self", "conc_self_k1", "conc_self_k8",
    "sp_t10", "sp_t1000", "sp_s64k", "startup_c", "startup_self", "timer_wake",
    "mem_report",
];
const CLUSTER_ORDER = [];
for (const pair of ["jsjs", "lualua", "mixed"]) {
    for (const size of ["100", "40k"]) CLUSTER_ORDER.push("cl_" + pair + "_" + size);
}
const SOCKET_ORDER = SOCKET_SIZES.map((s) => "sock_" + s);
const ALL_ORDER = CORE_ORDER.concat(CLUSTER_ORDER, SOCKET_ORDER);
const MEM_CASE = "mem_report";

function log(msg) {
    process.stdout.write(msg + "\n");
}

/* ------------------------------------------------------------- utilities */

function median(arr) {
    if (arr.length === 0) return NaN;
    const s = [...arr].sort((a, b) => a - b);
    return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
}

// peak-RSS sampling for one child process (250ms poll, best effort; kept
// coarse on purpose -- `ps` forks are not free and would pollute the runs)
function rss_sampler(pid) {
    let peak_kb = 0;
    const t = setInterval(() => {
        const r = spawnSync("ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8" });
        const kb = parseInt((r.stdout || "").trim(), 10);
        if (Number.isFinite(kb) && kb > peak_kb) peak_kb = kb;
    }, 250);
    return {
        peak: () => peak_kb,
        stop: () => clearInterval(t),
    };
}

function env_info() {
    const sh = (cmd) => {
        const r = spawnSync("sh", ["-c", cmd], { encoding: "utf8" });
        return (r.stdout || "").trim();
    };
    const rev = sh("git rev-parse --short HEAD 2>/dev/null") || "unknown";
    const cpu = sh("sysctl -n machdep.cpu.brand_string 2>/dev/null") || "unknown";
    const osver = sh("sw_vers -productVersion 2>/dev/null") || "unknown";
    // allocator fairness check: the stock node must be built without jemalloc
    // (on macOS platform.mk already forces -DNOUSE_JEMALLOC, same as skyjs)
    const je = sh("nm -gU '" + SKYNET_DIR + "/skynet' 2>/dev/null | grep -c ' T _je_'") || "0";
    return {
        rev, cpu, osver,
        ref_node_jemalloc_symbols: parseInt(je, 10) || 0,
        date: new Date().toISOString(),
        node: process.version,
    };
}

/* ------------------------------------------------------- shared protocol */

// parse one log line of the bench protocol into state; side/idx disambiguate
// concurrent children. Timing authority is the "ms" field (in-process clock);
// the cross-process BEGIN/END hrtime is only a coarse sanity check.
function bench_parser(state, side, idx) {
    return (line) => {
        if (state.log.length < 3000) state.log.push("[" + side + "] " + line);
        if (state.bad) return;
        if (line.includes("BENCH_FAIL:")) {
            state.bad = side + " " + line.trim();
            state.kill_all();
            return;
        }
        let m = line.match(/BENCH_BEGIN (\S+)/);
        if (m) {
            state.open.set(idx + ":" + m[1], process.hrtime.bigint());
            return;
        }
        m = line.match(/BENCH_END (\S+)/);
        if (m) {
            const t0 = state.open.get(idx + ":" + m[1]);
            if (t0 !== undefined) {
                state.wall.set(idx + ":" + m[1], Number(process.hrtime.bigint() - t0) / 1e6);
            }
            return;
        }
        m = line.match(/BENCH case=(\S+) n=(\d+) mps=(\d+)(.*)/);
        if (m) {
            const extra = {};
            for (const kv of (m[4] || "").matchAll(/([a-z_]+)=(\S+)/g)) extra[kv[1]] = kv[2];
            const wall_ms = state.wall.get(idx + ":" + m[1]);
            const ms = extra.ms !== undefined ? parseFloat(extra.ms) : NaN;
            if (Number.isFinite(ms) && ms > 0 && Number.isFinite(wall_ms) &&
                (wall_ms > ms * 3 + 100 || wall_ms < ms / 3 - 100)) {
                state.warns.push(side + "/" + m[1] + ": marker wall " +
                    Math.round(wall_ms) + "ms far from in-process " +
                    Math.round(ms) + "ms (logger lag / scheduling noise)");
            }
            state.records.push({
                case: state.rename ? state.rename(m[1]) : m[1],
                n: parseInt(m[2], 10),
                mps_reported: parseInt(m[3], 10),
                wall_ms,
                extra,
                side,
            });
            return;
        }
        if (state.on_marker) state.on_marker(line, side);
    };
}

function new_state() {
    return {
        records: [],
        log: [],
        open: new Map(),
        wall: new Map(),
        bad: null,
        warns: [],
        rename: null,
        on_marker: null,
        kill_all: () => {},
    };
}

// store parsed records into the results table; mps comes from the in-process
// ms field (falls back to the marker wall only if ms is missing). mem_report
// is a footprint-only marker (n=0, no timing): extras are kept, no mps row.
function store_records(results, records, warns) {
    for (const rec of records) {
        const r = results[rec.case] || (results[rec.case] = {
            n: rec.n, skyjs: [], lua: [], skyjs_extra: {}, lua_extra: {},
        });
        for (const k of Object.keys(rec.extra)) {
            const v = parseFloat(rec.extra[k]);
            if (Number.isFinite(v)) {
                const store = r[rec.side + "_extra"];
                (store[k] || (store[k] = [])).push(v);
            }
        }
        if (rec.case === MEM_CASE || rec.n === 0) continue;
        const ms = rec.extra.ms !== undefined ? parseFloat(rec.extra.ms) : NaN;
        let mps;
        if (Number.isFinite(ms) && ms > 0) {
            mps = rec.n * 1000 / ms;
        } else if (Number.isFinite(rec.wall_ms) && rec.wall_ms > 0) {
            warns.push(rec.side + "/" + rec.case + ": missing in-process ms, using marker wall");
            mps = rec.n * 1000 / rec.wall_ms;
        } else {
            continue;
        }
        r[rec.side].push(mps);
    }
}

/* -------------------------------------------------------- core phase */

// watch one bench node until BENCH_SUITE_DONE (or failure)
function run_bench_process(cmd, args, opts, timeout_ms) {
    return new Promise((resolve) => {
        const child = spawn(cmd, args, opts);
        const rss = rss_sampler(child.pid);
        const state = new_state();
        state.on_marker = (line) => {
            if (line.includes("BENCH_SUITE_DONE")) rt.kill_tree(child);
        };
        const timer = setTimeout(() => {
            state.bad = "timeout after " + timeout_ms + "ms (" + state.records.length + " cases so far)";
            rt.kill_tree(child);
        }, timeout_ms);

        rt.watch_lines(child, bench_parser(state, opts.side || "node", 0)).then(() => {
            clearTimeout(timer);
            rss.stop();
            const peak = rss.peak();
            if (state.bad) {
                return resolve({ ok: false, why: state.bad, records: state.records,
                    log: state.log, rss_kb: peak });
            }
            if (child.signalCode === "SIGSEGV" || child.signalCode === "SIGBUS" ||
                child.signalCode === "SIGABRT") {
                return resolve({ ok: false, why: "crashed: " + child.signalCode,
                    records: state.records, log: state.log, rss_kb: peak });
            }
            if (state.records.length === 0) {
                return resolve({ ok: false, why: "no BENCH records produced",
                    records: state.records, log: state.log, rss_kb: peak });
            }
            resolve({ ok: true, why: "", records: state.records, log: state.log, rss_kb: peak });
        });
    });
}

function run_skyjs_bench(timeout_ms) {
    return run_bench_process(rt.BIN, ["test/config_bench_suite.json"],
        { cwd: rt.ROOT, side: "skyjs" }, timeout_ms);
}

function run_lua_bench(timeout_ms) {
    return run_bench_process("./skynet", ["../../test/bench_lua/config"],
        { cwd: SKYNET_DIR, side: "lua" }, timeout_ms);
}

async function run_core_phase(opts) {
    const results = {};
    const rss = { skyjs: [], lua: [] };
    const warns = [];
    let failed = "";
    let last_bad_log = [];

    for (let round = 1; round <= opts.repeat && !failed; round++) {
        log("== core round " + round + "/" + opts.repeat + " ==");
        // sequential on purpose: both nodes saturate all cores while benching
        const t0 = Date.now();
        const js = await run_skyjs_bench(opts.timeout_ms);
        const js_s = ((Date.now() - t0) / 1000).toFixed(1);
        if (!js.ok) {
            failed = "skyjs node: " + js.why;
            last_bad_log = js.log;
            break;
        }
        const t1 = Date.now();
        const lua = await run_lua_bench(opts.timeout_ms);
        const lua_s = ((Date.now() - t1) / 1000).toFixed(1);
        if (!lua.ok) {
            failed = "lua node: " + lua.why;
            last_bad_log = lua.log;
            break;
        }
        log("   skyjs " + js_s + "s (" + js.records.length + " cases), " +
            "lua " + lua_s + "s (" + lua.records.length + " cases)");

        rss.skyjs.push(js.rss_kb);
        rss.lua.push(lua.rss_kb);
        store_records(results, js.records, warns);
        store_records(results, lua.records, warns);
    }
    return { results, rss, warns, failed, last_bad_log };
}

/* ----------------------------------------------------- cluster phase */

// pair specs: node B boots first (echo + reverse runner), node A second
// (caller + orchestrator); sides label the result columns
function cluster_pairs() {
    return [
        {
            key: "jsjs",
            b: { side: "skyjs", cmd: rt.BIN, args: ["test/config_bench_cluster_b.json"], cwd: rt.ROOT },
            a: { side: "skyjs", cmd: rt.BIN, args: ["test/config_bench_cluster_a.json"], cwd: rt.ROOT },
        },
        {
            key: "lualua",
            b: { side: "lua", cmd: "./skynet", args: ["../../test/bench_lua/cluster_b_config"], cwd: SKYNET_DIR },
            a: { side: "lua", cmd: "./skynet", args: ["../../test/bench_lua/cluster_a_config"], cwd: SKYNET_DIR },
        },
        {
            key: "mixed",
            b: { side: "lua", cmd: "./skynet", args: ["../../test/bench_lua/cluster_b_config"], cwd: SKYNET_DIR },
            a: { side: "skyjs", cmd: rt.BIN, args: ["test/config_bench_cluster_a.json"], cwd: rt.ROOT },
        },
    ];
}

// one pair: boot B, wait for its BENCH_CLUSTER_READY, boot A, collect both
// streams until both sides printed BENCH_SUITE_DONE (or timeout/failure)
function run_cluster_pair(pair, timeout_ms) {
    return new Promise((resolve) => {
        rt.free_cluster_ports();
        const state = new_state();
        state.rename = (base) => base.replace("cl_", "cl_" + pair.key + "_");
        const rss = {};
        let a = null;
        let b_done = false;
        let a_done = false;
        let open_streams = 1;
        const kill_all = () => {
            rt.kill_tree(pair.b.child);
            if (a) rt.kill_tree(a.child);
        };
        state.kill_all = kill_all;
        const timer = setTimeout(() => {
            state.bad = "timeout after " + timeout_ms + "ms (" + state.records.length + " records)";
            kill_all();
        }, timeout_ms);

        const check_done = () => {
            if (b_done && a_done) kill_all();
        };
        const finish_if_closed = () => {
            if (open_streams === 0) {
                clearTimeout(timer);
                for (const k of Object.keys(rss)) {
                    rss[k].stop();          // leaked intervals would keep node alive
                    rss[k] = rss[k].peak();
                }
                resolve({ ok: !state.bad, why: state.bad || "", records: state.records,
                    log: state.log, warns: state.warns, rss });
            }
        };
        const on_line_side_done = (which) => (line) => {
            if (line.includes("BENCH_SUITE_DONE")) {
                if (which === "b") b_done = true;
                else a_done = true;
                check_done();
            }
        };

        const parser_b = (line) => {
            bench_parser(state, pair.b.side, 0)(line);
            if (!state.bad && !a && line.includes("BENCH_CLUSTER_READY")) {
                a = { child: spawn(pair.a.cmd, pair.a.args, { cwd: pair.a.cwd }) };
                rss[pair.a.side + "_a"] = rss_sampler(a.child.pid);
                open_streams++;
                rt.watch_lines(a.child, (aline) => {
                    bench_parser(state, pair.a.side, 1)(aline);
                    on_line_side_done("a")(aline);
                }).then(() => {
                    open_streams--;
                    finish_if_closed();
                });
            }
            on_line_side_done("b")(line);
        };

        pair.b.child = spawn(pair.b.cmd, pair.b.args, { cwd: pair.b.cwd });
        rss[pair.b.side + "_b"] = rss_sampler(pair.b.child.pid);
        rt.watch_lines(pair.b.child, parser_b).then(() => {
            open_streams--;
            if (!a) state.bad = state.bad || "node B exited before BENCH_CLUSTER_READY";
            finish_if_closed();
        });
    });
}

async function run_cluster_phase(opts) {
    const results = {};
    const warns = [];
    const rss_by_pair = {};
    let failed = "";
    let last_bad_log = [];
    const pairs = cluster_pairs();

    for (let round = 1; round <= opts.repeat && !failed; round++) {
        for (const pair of pairs) {
            log("== cluster round " + round + "/" + opts.repeat + " pair " + pair.key + " ==");
            const r = await run_cluster_pair(pair, opts.timeout_ms);
            rss_by_pair[pair.key] = r.rss;
            if (!r.ok) {
                failed = "pair " + pair.key + ": " + r.why;
                last_bad_log = r.log;
                break;
            }
            if (r.records.length === 0) {
                failed = "pair " + pair.key + ": no BENCH records produced";
                last_bad_log = r.log;
                break;
            }
            store_records(results, r.records, warns);
            for (const w of r.warns) warns.push(w);
        }
    }
    return { results, warns, failed, last_bad_log, rss_by_pair };
}

/* ------------------------------------------------------ socket phase */

// boot an echo server and wait for its ready marker; the watch stays attached
// (exactly one watch per child) and the child is killed by the caller
function boot_wait(spec, marker, timeout_ms) {
    return new Promise((resolve) => {
        const child = spawn(spec.cmd, spec.args, { cwd: spec.cwd });
        const timer = setTimeout(() => {
            rt.kill_tree(child);
            resolve({ child, ready: false, log: ["timeout waiting for " + marker] });
        }, timeout_ms);
        const log = [];
        rt.watch_lines(child, (line) => {
            if (log.length < 200) log.push(line);
            if (line.includes(marker)) {
                clearTimeout(timer);
                resolve({ child, ready: true, log });
            }
        });
    });
}

// server + shared client for one (side, size); returns a parsed record
async function run_socket_case(spec, size, total, timeout_ms) {
    const boot = await boot_wait(spec, "BENCH_SOCKET_READY", 15000);
    if (!boot.ready) {
        rt.kill_tree(boot.child);
        return { err: spec.side + " socket server never became ready" };
    }
    const rss = rss_sampler(boot.child.pid);
    const r = await new Promise((resolve) => {
        const c = spawn(process.execPath, [CLIENT, "--port", String(SOCKET_PORT),
            "--size", String(size), "--total", String(total), "--conc", "4"], { cwd: rt.ROOT });
        let out = "";
        const timer = setTimeout(() => rt.kill_tree(c), timeout_ms);
        c.stdout.on("data", (d) => { out += d; });
        c.stderr.on("data", () => {});
        c.on("close", (code) => {
            clearTimeout(timer);
            resolve({ code, out });
        });
    });
    rss.stop();
    rt.kill_tree(boot.child);
    const line = r.out.split("\n").find((l) => l.startsWith("BENCH case="));
    if (r.code !== 0 || !line) {
        return { err: spec.side + " socket client failed: " +
            (r.out || "(no output)").slice(-200) };
    }
    const m = line.match(/BENCH case=(\S+) n=(\d+) mps=(\d+)(.*)/);
    if (!m) return { err: "unparsable client line: " + line };
    const extra = {};
    for (const kv of (m[4] || "").matchAll(/([a-z_]+)=(\S+)/g)) extra[kv[1]] = kv[2];
    return {
        rec: {
            case: m[1],
            n: parseInt(m[2], 10),
            mps_reported: parseInt(m[3], 10),
            wall_ms: undefined,
            extra,
            side: spec.side,
        },
        rss_kb: rss.peak(),
    };
}

async function run_socket_phase(opts) {
    const results = {};
    const warns = [];
    const rss_samples = { skyjs: {}, lua: {} };
    let failed = "";
    const sides = [
        { side: "skyjs", cmd: rt.BIN, args: ["test/config_bench_socket.json"], cwd: rt.ROOT },
        { side: "lua", cmd: "./skynet", args: ["../../test/bench_lua/socket_config"], cwd: SKYNET_DIR },
    ];
    for (let round = 1; round <= opts.repeat && !failed; round++) {
        for (const size of SOCKET_SIZES) {
            for (const spec of sides) {
                log("== socket round " + round + "/" + opts.repeat +
                    " size " + size + " side " + spec.side + " ==");
                const r = await run_socket_case(spec, size, SOCKET_TOTAL[size], 60000);
                if (r.err) {
                    failed = r.err;
                    break;
                }
                const key = "sock_" + size;
                const row = results[key] || (results[key] = {
                    n: r.rec.n, skyjs: [], lua: [], skyjs_extra: {}, lua_extra: {},
                });
                row[spec.side].push(r.rec.mps_reported);
                for (const k of Object.keys(r.rec.extra)) {
                    const v = parseFloat(r.rec.extra[k]);
                    if (Number.isFinite(v)) {
                        const store = row[spec.side + "_extra"];
                        (store[k] || (store[k] = [])).push(v);
                    }
                }
                (rss_samples[spec.side][key] || (rss_samples[spec.side][key] = [])).push(r.rss_kb);
            }
            if (failed) break;
        }
    }
    return { results, warns, failed, rss_samples };
}

/* --------------------------------------------------------------- reports */

function fmt(n) {
    if (!Number.isFinite(n)) return "n/a";
    return n >= 10000 ? Math.round(n).toLocaleString("en-US") :
        (Math.round(n * 10) / 10).toString();
}

function build_report(env, merged) {
    const lines = [];
    const rows = [];
    for (const name of ALL_ORDER) {
        if (name === MEM_CASE) continue;
        const r = merged.results[name];
        if (!r) continue;
        const js_med = median(r.skyjs);
        const lua_med = median(r.lua);
        const ratio = lua_med > 0 ? js_med / lua_med : NaN;
        rows.push({
            name, n: r.n, js_med, lua_med, ratio,
            js_range: fmt(Math.min(...r.skyjs)) + ".." + fmt(Math.max(...r.skyjs)),
            lua_range: fmt(Math.min(...r.lua)) + ".." + fmt(Math.max(...r.lua)),
        });
    }
    lines.push("# SkyJS vs stock skynet benchmark", "");
    lines.push("- date: " + env.date + "  commit: " + env.rev + "  node: " + env.node);
    lines.push("- cpu: " + env.cpu + "  os: macOS " + env.osver);
    lines.push("- reference node jemalloc symbols: " + env.ref_node_jemalloc_symbols +
        (env.ref_node_jemalloc_symbols > 0 ? "  **(allocator mismatch: rebuild without jemalloc)**" : ""));
    lines.push("- repeat: rounds aggregated as median (min..max); timing = in-process monotonic clock reported per case");
    lines.push("- cl_<pair>_*: cluster.call RTT over the pair (both directions); sock_*: TCP echo responses/s via the shared node client");
    lines.push("");
    lines.push("| case | n | skyjs msg/s | lua msg/s | ratio skyjs/lua | skyjs min..max | lua min..max |");
    lines.push("|---|---|---|---|---|---|---|");
    for (const row of rows) {
        lines.push("| " + row.name + " | " + row.n +
            " | " + fmt(row.js_med) + " | " + fmt(row.lua_med) +
            " | " + (Number.isFinite(row.ratio) ? row.ratio.toFixed(2) : "n/a") +
            " | " + row.js_range + " | " + row.lua_range + " |");
    }
    lines.push("");
    lines.push("## footprint (core phase)");
    lines.push("");
    lines.push("| metric | skyjs | stock lua |");
    lines.push("|---|---|---|");
    const mr = merged.results[MEM_CASE];
    const js_heap = mr && mr.skyjs_extra.js_mem ? median(mr.skyjs_extra.js_mem) : NaN;
    const lua_heap = mr && mr.lua_extra.gc_kib ? median(mr.lua_extra.gc_kib) * 1024 : NaN;
    const js_rss = median(merged.rss.skyjs || []);
    const lua_rss = median(merged.rss.lua || []);
    lines.push("| bench main heap (framework accounting) | " +
        fmt(js_heap / 1048576) + " MB | " + fmt(lua_heap / 1048576) + " MB |");
    lines.push("| process RSS peak (whole node) | " + fmt(js_rss / 1024) + " MB | " +
        fmt(lua_rss / 1024) + " MB |");
    lines.push("");
    if (merged.warns.length) {
        lines.push("## warnings");
        lines.push("");
        for (const w of merged.warns) lines.push("- " + w);
        lines.push("");
    }
    return { lines, rows };
}

/* ------------------------------------------------------------------ main */

function parse_args(argv) {
    const opts = { phase: "core", repeat: 3, timeout_ms: DEFAULT_TIMEOUT_MS };
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === "--phase") opts.phase = argv[++i];
        else if (argv[i] === "--repeat") opts.repeat = parseInt(argv[++i], 10);
        else if (argv[i] === "--timeout") opts.timeout_ms = parseInt(argv[++i], 10);
    }
    return opts;
}

function ensure_bins() {
    if (!fs.existsSync(rt.BIN)) return "skyjs binary not found (run make first)";
    if (!fs.existsSync(SKYNET_DIR + "/skynet")) {
        const target = process.platform === "darwin" ? "macosx" : "linux";
        log("reference node missing; building 3rd/skynet via make " + target + " ...");
        const r = spawnSync("make", [target], { cwd: SKYNET_DIR, encoding: "utf8" });
        if (r.status !== 0 || !fs.existsSync(SKYNET_DIR + "/skynet")) {
            return "3rd/skynet/skynet missing and make failed:\n" +
                ((r.stderr || "") + (r.stdout || "")).slice(-800);
        }
    }
    return "";
}

const EMPTY = () => ({ results: {}, warns: [], failed: "" });

async function main() {
    const opts = parse_args(process.argv.slice(2));
    if (!["core", "cluster", "socket", "all"].includes(opts.phase)) {
        log("unknown phase: " + opts.phase);
        process.exit(2);
    }
    const bin_err = ensure_bins();
    if (bin_err) {
        log("FAIL bench -- " + bin_err);
        process.exit(1);
    }
    const env = env_info();
    log("bench: commit " + env.rev + ", " + env.cpu + ", repeat=" + opts.repeat +
        ", phase=" + opts.phase);

    const core = (opts.phase === "core" || opts.phase === "all")
        ? await run_core_phase(opts) : { ...EMPTY(), rss: { skyjs: [], lua: [] } };
    if (core.failed) {
        log("FAIL bench -- " + core.failed);
        for (const l of (core.last_bad_log || []).slice(-25)) log("      | " + l);
        process.exit(1);
    }
    const cluster = (opts.phase === "cluster" || opts.phase === "all")
        ? await run_cluster_phase(opts) : EMPTY();
    if (cluster.failed) {
        log("FAIL bench -- " + cluster.failed);
        for (const l of (cluster.last_bad_log || []).slice(-25)) log("      | " + l);
        process.exit(1);
    }
    const socket = (opts.phase === "socket" || opts.phase === "all")
        ? await run_socket_phase(opts) : EMPTY();
    if (socket.failed) {
        log("FAIL bench -- " + socket.failed);
        process.exit(1);
    }

    const merged = {
        results: { ...core.results, ...cluster.results, ...socket.results },
        rss: core.rss,
        warns: [...core.warns, ...cluster.warns, ...socket.warns],
    };
    const { lines } = build_report(env, merged);
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const report_path = path.join(OUT_DIR, "report.md");
    fs.writeFileSync(report_path, lines.join("\n") + "\n");
    const raw_path = path.join(OUT_DIR, "raw_" + Date.now() + ".json");
    fs.writeFileSync(raw_path, JSON.stringify({
        env, merged,
        rss_core: core.rss,
        rss_cluster: cluster.rss_by_pair || {},
        rss_socket: socket.rss_samples || {},
    }, null, 2));

    for (const l of lines) log(l);
    log("report: " + report_path);
    log("raw:    " + raw_path);
    process.exit(0);   // don't let any leaked handle keep the loop alive
}

if (require.main === module) {
    main();
}

module.exports = { run_bench_process, run_skyjs_bench, run_lua_bench, run_core_phase,
    run_cluster_phase, run_socket_phase, env_info, median, ALL_ORDER, CORE_ORDER,
    CLUSTER_ORDER, SOCKET_ORDER, MEM_CASE };
