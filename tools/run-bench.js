"use strict";
// tools/run-bench.js -- zero-dependency benchmark harness: ./skyjs (QuickJS
// services) vs the stock Lua skynet node (methodology in docs/bench.md).
//
// Model: both sides run case-for-case mirrored bench scripts emitting
//   BENCH_BEGIN <case> / BENCH_END <case>   coarse wall markers (sanity only)
//   BENCH case=<name> n=<N> mps=<v> ms=<ms> THE timing: in-process monotonic
//                                           clock around the measured loop
//   BENCH_SUITE_DONE                        kill switch
// The in-process ms field wins because log lines cross the logger service
// asynchronously and lag under CPU saturation. Phases:
//   core    single node, core messaging cases (bench-suite-main.js / main.lua)
//   cluster two nodes over skyclusterd / lua clusterd, three pair types
//   socket  TCP echo servers on :2601 + the shared node load client
// The two sides run SEQUENTIALLY per round so they never contend for CPU;
// --repeat rounds give median + min/max per case. Environment (commit, CPU,
// allocator check, RSS peaks) is captured into build/bench/report.md and a
// raw_*.json for regression comparisons.
//
// Usage: node tools/run-bench.js [--phase core|cluster|socket|all]
//        [--repeat N] [--timeout ms]

const fs = require("fs");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const rt = require("./run-tests.js");        // ROOT / BIN / watch_lines / kill_tree / free_cluster_ports

const SKYNET_DIR = path.join(rt.ROOT, "3rd", "skynet");
const OUT_DIR = path.join(rt.ROOT, "build", "bench");
const CLIENT = path.join(rt.ROOT, "tools", "bench-socket-client.js");
const DEFAULT_TIMEOUT_MS = 180000;
const SOCKET_PORT = 2601;
const SOCKET_SIZES = [64, 4096, 65536];
const SOCKET_TOTAL = { 64: 100000, 4096: 50000, 65536: 10000 };
// memory-scaling ladder: idle echo services per dedicated node (0 = baseline)
const DEFAULT_MEM_COUNTS = [0, 100, 500, 1000, 3000, 5000, 10000];
const MEM_SETTLE_MS = 1000;             // let allocator/GC settle before sampling
const MEM_MS_PER_SVC = 50;              // per-node timeout budget per service

// case display order; per phase the rows present in results are reported
const CORE_ORDER = [
    "rt_text_c", "rt_text_self", "rt_text_s256", "rt_text_s4k", "rt_text_s64k",
    "rt_lua_self", "send_self", "conc_self_k1", "conc_self_k8",
    "sp_t10", "sp_t1000", "sp_s64k", "startup_c", "startup_self", "timer_wake",
    "mem_report",
];
const CLUSTER_ORDER = [];
for (const pair of ["jsjs", "lualua", "mixed"]) {
    for (const size of ["100", "40k", "pipe"]) CLUSTER_ORDER.push("cl_" + pair + "_" + size);
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
function rssSampler(pid) {
    let peakKb = 0;
    const t = setInterval(() => {
        const r = spawnSync("ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8" });
        const kb = parseInt((r.stdout || "").trim(), 10);
        if (Number.isFinite(kb) && kb > peakKb) peakKb = kb;
    }, 250);
    return {
        peak: () => peakKb,
        stop: () => clearInterval(t),
    };
}

function envInfo() {
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
        refNodeJemallocSymbols: parseInt(je, 10) || 0,
        date: new Date().toISOString(),
        node: process.version,
    };
}

/* ------------------------------------------------------- shared protocol */

// parse one log line of the bench protocol into state; side/idx disambiguate
// concurrent children. Timing authority is the "ms" field (in-process clock);
// the cross-process BEGIN/END hrtime is only a coarse sanity check.
function benchParser(state, side, idx) {
    return (line) => {
        if (state.log.length < 3000) state.log.push("[" + side + "] " + line);
        if (state.bad) return;
        if (line.includes("BENCH_FAIL:")) {
            state.bad = side + " " + line.trim();
            state.killAll();
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
            const wallMs = state.wall.get(idx + ":" + m[1]);
            const ms = extra.ms !== undefined ? parseFloat(extra.ms) : NaN;
            if (Number.isFinite(ms) && ms > 0 && Number.isFinite(wallMs) &&
                (wallMs > ms * 3 + 100 || wallMs < ms / 3 - 100)) {
                state.warns.push(side + "/" + m[1] + ": marker wall " +
                    Math.round(wallMs) + "ms far from in-process " +
                    Math.round(ms) + "ms (logger lag / scheduling noise)");
            }
            state.records.push({
                case: state.rename ? state.rename(m[1]) : m[1],
                n: parseInt(m[2], 10),
                mpsReported: parseInt(m[3], 10),
                wallMs,
                extra,
                side,
            });
            return;
        }
        if (state.onMarker) state.onMarker(line, side);
    };
}

function newState() {
    return {
        records: [],
        log: [],
        open: new Map(),
        wall: new Map(),
        bad: null,
        warns: [],
        rename: null,
        onMarker: null,
        killAll: () => {},
    };
}

// store parsed records into the results table; mps comes from the in-process
// ms field (falls back to the marker wall only if ms is missing). mem_report
// is a footprint-only marker (n=0, no timing): extras are kept, no mps row.
function storeRecords(results, records, warns) {
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
        } else if (Number.isFinite(rec.wallMs) && rec.wallMs > 0) {
            warns.push(rec.side + "/" + rec.case + ": missing in-process ms, using marker wall");
            mps = rec.n * 1000 / rec.wallMs;
        } else {
            continue;
        }
        r[rec.side].push(mps);
    }
}

/* -------------------------------------------------------- core phase */

// watch one bench node until BENCH_SUITE_DONE (or failure)
function runBenchProcess(cmd, args, opts, timeoutMs) {
    return new Promise((resolve) => {
        const child = spawn(cmd, args, opts);
        const rss = rssSampler(child.pid);
        const state = newState();
        state.onMarker = (line) => {
            if (line.includes("BENCH_SUITE_DONE")) rt.killTree(child);
        };
        const timer = setTimeout(() => {
            state.bad = "timeout after " + timeoutMs + "ms (" + state.records.length + " cases so far)";
            rt.killTree(child);
        }, timeoutMs);

        rt.watchLines(child, benchParser(state, opts.side || "node", 0)).then(() => {
            clearTimeout(timer);
            rss.stop();
            const peak = rss.peak();
            if (state.bad) {
                return resolve({ ok: false, why: state.bad, records: state.records,
                    log: state.log, rssKb: peak });
            }
            if (child.signalCode === "SIGSEGV" || child.signalCode === "SIGBUS" ||
                child.signalCode === "SIGABRT") {
                return resolve({ ok: false, why: "crashed: " + child.signalCode,
                    records: state.records, log: state.log, rssKb: peak });
            }
            if (state.records.length === 0) {
                return resolve({ ok: false, why: "no BENCH records produced",
                    records: state.records, log: state.log, rssKb: peak });
            }
            resolve({ ok: true, why: "", records: state.records, log: state.log, rssKb: peak });
        });
    });
}

function runSkyjsBench(timeoutMs) {
    return runBenchProcess(rt.BIN, ["test/config-bench-suite.json"],
        { cwd: rt.ROOT, side: "skyjs" }, timeoutMs);
}

function runLuaBench(timeoutMs) {
    return runBenchProcess("./skynet", ["../../test/bench-lua/config"],
        { cwd: SKYNET_DIR, side: "lua" }, timeoutMs);
}

async function runCorePhase(opts) {
    const results = {};
    const rss = { skyjs: [], lua: [] };
    const warns = [];
    let failed = "";
    let lastBadLog = [];

    for (let round = 1; round <= opts.repeat && !failed; round++) {
        log("== core round " + round + "/" + opts.repeat + " ==");
        // sequential on purpose: both nodes saturate all cores while benching
        const t0 = Date.now();
        const js = await runSkyjsBench(opts.timeoutMs);
        const jsS = ((Date.now() - t0) / 1000).toFixed(1);
        if (!js.ok) {
            failed = "skyjs node: " + js.why;
            lastBadLog = js.log;
            break;
        }
        const t1 = Date.now();
        const lua = await runLuaBench(opts.timeoutMs);
        const luaS = ((Date.now() - t1) / 1000).toFixed(1);
        if (!lua.ok) {
            failed = "lua node: " + lua.why;
            lastBadLog = lua.log;
            break;
        }
        log("   skyjs " + jsS + "s (" + js.records.length + " cases), " +
            "lua " + luaS + "s (" + lua.records.length + " cases)");

        rss.skyjs.push(js.rssKb);
        rss.lua.push(lua.rssKb);
        storeRecords(results, js.records, warns);
        storeRecords(results, lua.records, warns);
    }
    return { results, rss, warns, failed, lastBadLog };
}

/* ----------------------------------------------------- cluster phase */

// pair specs: node B boots first (echo + reverse runner), node A second
// (caller + orchestrator); sides label the result columns
function clusterPairs() {
    return [
        {
            key: "jsjs",
            b: { side: "skyjs", cmd: rt.BIN, args: ["test/config-bench-cluster-b.json"], cwd: rt.ROOT },
            a: { side: "skyjs", cmd: rt.BIN, args: ["test/config-bench-cluster-a.json"], cwd: rt.ROOT },
        },
        {
            key: "lualua",
            b: { side: "lua", cmd: "./skynet", args: ["../../test/bench-lua/cluster-b-config"], cwd: SKYNET_DIR },
            a: { side: "lua", cmd: "./skynet", args: ["../../test/bench-lua/cluster-a-config"], cwd: SKYNET_DIR },
        },
        {
            key: "mixed",
            b: { side: "lua", cmd: "./skynet", args: ["../../test/bench-lua/cluster-b-config"], cwd: SKYNET_DIR },
            a: { side: "skyjs", cmd: rt.BIN, args: ["test/config-bench-cluster-a.json"], cwd: rt.ROOT },
        },
    ];
}

// one pair: boot B, wait for its BENCH_CLUSTER_READY, boot A, collect both
// streams until both sides printed BENCH_SUITE_DONE (or timeout/failure)
function runClusterPair(pair, timeoutMs) {
    return new Promise((resolve) => {
        rt.freeClusterPorts();
        const state = newState();
        state.rename = (base) => base.replace("cl_", "cl_" + pair.key + "_");
        const rss = {};
        let a = null;
        let bDone = false;
        let aDone = false;
        let openStreams = 1;
        const killAll = () => {
            rt.killTree(pair.b.child);
            if (a) rt.killTree(a.child);
        };
        state.killAll = killAll;
        const timer = setTimeout(() => {
            state.bad = "timeout after " + timeoutMs + "ms (" + state.records.length + " records)";
            killAll();
        }, timeoutMs);

        const checkDone = () => {
            if (bDone && aDone) killAll();
        };
        const finishIfClosed = () => {
            if (openStreams === 0) {
                clearTimeout(timer);
                for (const k of Object.keys(rss)) {
                    rss[k].stop();          // leaked intervals would keep node alive
                    rss[k] = rss[k].peak();
                }
                resolve({ ok: !state.bad, why: state.bad || "", records: state.records,
                    log: state.log, warns: state.warns, rss });
            }
        };
        const onLineSideDone = (which) => (line) => {
            if (line.includes("BENCH_SUITE_DONE")) {
                if (which === "b") bDone = true;
                else aDone = true;
                checkDone();
            }
        };

        const parserB = (line) => {
            benchParser(state, pair.b.side, 0)(line);
            if (!state.bad && !a && line.includes("BENCH_CLUSTER_READY")) {
                a = { child: spawn(pair.a.cmd, pair.a.args, { cwd: pair.a.cwd }) };
                rss[pair.a.side + "_a"] = rssSampler(a.child.pid);
                openStreams++;
                rt.watchLines(a.child, (aline) => {
                    benchParser(state, pair.a.side, 1)(aline);
                    onLineSideDone("a")(aline);
                }).then(() => {
                    openStreams--;
                    finishIfClosed();
                });
            }
            onLineSideDone("b")(line);
        };

        pair.b.child = spawn(pair.b.cmd, pair.b.args, { cwd: pair.b.cwd });
        rss[pair.b.side + "_b"] = rssSampler(pair.b.child.pid);
        rt.watchLines(pair.b.child, parserB).then(() => {
            openStreams--;
            if (!a) state.bad = state.bad || "node B exited before BENCH_CLUSTER_READY";
            finishIfClosed();
        });
    });
}

async function runClusterPhase(opts) {
    const results = {};
    const warns = [];
    const rssByPair = {};
    let failed = "";
    let lastBadLog = [];
    const pairs = clusterPairs();

    for (let round = 1; round <= opts.repeat && !failed; round++) {
        for (const pair of pairs) {
            log("== cluster round " + round + "/" + opts.repeat + " pair " + pair.key + " ==");
            const r = await runClusterPair(pair, opts.timeoutMs);
            rssByPair[pair.key] = r.rss;
            if (!r.ok) {
                failed = "pair " + pair.key + ": " + r.why;
                lastBadLog = r.log;
                break;
            }
            if (r.records.length === 0) {
                failed = "pair " + pair.key + ": no BENCH records produced";
                lastBadLog = r.log;
                break;
            }
            storeRecords(results, r.records, warns);
            for (const w of r.warns) warns.push(w);
        }
    }
    return { results, warns, failed, lastBadLog, rssByPair };
}

/* ------------------------------------------------------ socket phase */

// boot an echo server and wait for its ready marker; the watch stays attached
// (exactly one watch per child) and the child is killed by the caller
function bootWait(spec, marker, timeoutMs) {
    return new Promise((resolve) => {
        const child = spawn(spec.cmd, spec.args, { cwd: spec.cwd });
        const timer = setTimeout(() => {
            rt.killTree(child);
            resolve({ child, ready: false, log: ["timeout waiting for " + marker] });
        }, timeoutMs);
        const log = [];
        rt.watchLines(child, (line) => {
            if (log.length < 200) log.push(line);
            if (line.includes(marker)) {
                clearTimeout(timer);
                resolve({ child, ready: true, log });
            }
        });
    });
}

// server + shared client for one (side, size); returns a parsed record
async function runSocketCase(spec, size, total, timeoutMs) {
    const boot = await bootWait(spec, "BENCH_SOCKET_READY", 15000);
    if (!boot.ready) {
        rt.killTree(boot.child);
        return { err: spec.side + " socket server never became ready" };
    }
    const rss = rssSampler(boot.child.pid);
    const r = await new Promise((resolve) => {
        const c = spawn(process.execPath, [CLIENT, "--port", String(SOCKET_PORT),
            "--size", String(size), "--total", String(total), "--conc", "4"], { cwd: rt.ROOT });
        let out = "";
        const timer = setTimeout(() => rt.killTree(c), timeoutMs);
        c.stdout.on("data", (d) => { out += d; });
        c.stderr.on("data", () => {});
        c.on("close", (code) => {
            clearTimeout(timer);
            resolve({ code, out });
        });
    });
    rss.stop();
    rt.killTree(boot.child);
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
            mpsReported: parseInt(m[3], 10),
            wallMs: undefined,
            extra,
            side: spec.side,
        },
        rssKb: rss.peak(),
    };
}

async function runSocketPhase(opts) {
    const results = {};
    const warns = [];
    const rssSamples = { skyjs: {}, lua: {} };
    let failed = "";
    const sides = [
        { side: "skyjs", cmd: rt.BIN, args: ["test/config-bench-socket.json"], cwd: rt.ROOT },
        { side: "lua", cmd: "./skynet", args: ["../../test/bench-lua/socket-config"], cwd: SKYNET_DIR },
    ];
    for (let round = 1; round <= opts.repeat && !failed; round++) {
        for (const size of SOCKET_SIZES) {
            for (const spec of sides) {
                log("== socket round " + round + "/" + opts.repeat +
                    " size " + size + " side " + spec.side + " ==");
                const r = await runSocketCase(spec, size, SOCKET_TOTAL[size], 60000);
                if (r.err) {
                    failed = r.err;
                    break;
                }
                const key = "sock_" + size;
                const row = results[key] || (results[key] = {
                    n: r.rec.n, skyjs: [], lua: [], skyjs_extra: {}, lua_extra: {},
                });
                row[spec.side].push(r.rec.mpsReported);
                for (const k of Object.keys(r.rec.extra)) {
                    const v = parseFloat(r.rec.extra[k]);
                    if (Number.isFinite(v)) {
                        const store = row[spec.side + "_extra"];
                        (store[k] || (store[k] = [])).push(v);
                    }
                }
                (rssSamples[spec.side][key] || (rssSamples[spec.side][key] = [])).push(r.rssKb);
            }
            if (failed) break;
        }
    }
    return { results, warns, failed, rssSamples };
}

/* -------------------------------------------------------- memory phase */

// write the two temp configs (JS + Lua) for one service count; the count is
// passed to the JS side via snjs_param (bootstrap arg) and to the Lua side via
// the config env "mem_count". Mirrors tools/rss-trim.sh's temp-config pattern.
function writeMemConfigs(count) {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const jsCfg = path.join(OUT_DIR, "config-mem-js-" + count + ".json");
    fs.writeFileSync(jsCfg, JSON.stringify({
        thread: 4,
        cpath: "./cservice/?.so;./test/cservice/?.so",
        bootstrap: "snjs test/service/bench-mem-main.js " + count,
        logservice: "logger",
        profile: true,
    }, null, 2) + "\n");
    const luaCfg = path.join(OUT_DIR, "config-mem-lua-" + count);
    fs.writeFileSync(luaCfg,
        "thread = 4\n" +
        "harbor = 0\n" +
        "logservice = \"logger\"\n" +
        "profile = true\n" +
        "mem_count = " + count + "\n" +
        "bootstrap = \"snlua bootstrap\"\n" +
        "start = \"test/bench-lua/mem_main\"\n" +
        "cpath = \"./cservice/?.so;../../test/cservice/?.so\"\n" +
        "lua_path = \"./lualib/?.lua;./lualib/?/init.lua\"\n" +
        "lua_cpath = \"./luaclib/?.so\"\n" +
        "luaservice = \"./?.lua;./service/?.lua;../../?.lua;../../test/bench-lua/?.lua\"\n");
    return { jsCfg, luaCfg };
}

// boot one dedicated node, wait for BENCH_MEM_READY, let it settle, then sample
// RSS a few times (median) as the steady-state footprint at this service count
function runMemNode(spec, timeoutMs, settleMs) {
    return new Promise((resolve) => {
        const child = spawn(spec.cmd, spec.args, { cwd: spec.cwd });
        const outLog = [];
        let ready = false;
        let bad = null;
        let jsMem = NaN;
        let gcKib = NaN;
        let rssKb = NaN;
        const timer = setTimeout(() => {
            if (!ready) bad = "timeout after " + timeoutMs + "ms waiting for BENCH_MEM_READY";
            rt.killTree(child);
        }, timeoutMs);

        const sampleAndKill = async () => {
            await new Promise((r) => setTimeout(r, settleMs));
            const samples = [];
            for (let i = 0; i < 6; i++) {
                const r = spawnSync("ps", ["-o", "rss=", "-p", String(child.pid)], { encoding: "utf8" });
                const kb = parseInt((r.stdout || "").trim(), 10);
                if (Number.isFinite(kb)) samples.push(kb);
                if (i < 5) await new Promise((r2) => setTimeout(r2, 100));
            }
            rssKb = median(samples);
            clearTimeout(timer);
            rt.killTree(child);
        };

        rt.watchLines(child, (line) => {
            if (outLog.length < 500) outLog.push("[" + spec.side + "] " + line);
            if (bad) return;
            if (line.includes("BENCH_FAIL:")) {
                bad = spec.side + " " + line.trim();
                rt.killTree(child);
                return;
            }
            const m = line.match(/BENCH case=mem_scale n=\d+ mps=0(.*)/);
            if (m) {
                for (const kv of (m[1] || "").matchAll(/([a-z_]+)=(\S+)/g)) {
                    if (kv[1] === "js_mem") jsMem = parseFloat(kv[2]);
                    else if (kv[1] === "gc_kib") gcKib = parseFloat(kv[2]);
                }
            }
            if (!ready && line.includes("BENCH_MEM_READY")) {
                ready = true;
                sampleAndKill();
            }
        }).then(() => {
            clearTimeout(timer);
            if (bad) return resolve({ ok: false, why: bad, log: outLog });
            if (!ready) return resolve({ ok: false, why: "node exited before BENCH_MEM_READY", log: outLog });
            if (!Number.isFinite(rssKb)) return resolve({ ok: false, why: "no RSS sample collected", log: outLog });
            resolve({ ok: true, why: "", rssKb, jsMem, gcKib, log: outLog });
        });
    });
}

async function runMemPhase(opts) {
    const rows = {};   // count -> { skyjs:[], lua:[], skyjs_mem:[], lua_gc:[] }
    let failed = "";
    let lastBadLog = [];
    for (let round = 1; round <= opts.repeat && !failed; round++) {
        for (const count of opts.counts) {
            const { jsCfg, luaCfg } = writeMemConfigs(count);
            const sides = [
                { side: "skyjs", cmd: rt.BIN, args: [jsCfg], cwd: rt.ROOT },
                { side: "lua", cmd: "./skynet", args: [luaCfg], cwd: SKYNET_DIR },
            ];
            // high counts create thousands of runtimes: scale the per-node timeout
            const nodeTimeout = Math.max(opts.timeoutMs, count * MEM_MS_PER_SVC + 30000);
            for (const spec of sides) {
                log("== mem round " + round + "/" + opts.repeat + " count " + count +
                    " side " + spec.side + " ==");
                const r = await runMemNode(spec, nodeTimeout, opts.settleMs);
                if (!r.ok) {
                    failed = "count " + count + " " + spec.side + ": " + r.why;
                    lastBadLog = r.log;
                    break;
                }
                const row = rows[count] || (rows[count] = { skyjs: [], lua: [], skyjsMem: [], luaGc: [] });
                row[spec.side].push(r.rssKb);
                if (spec.side === "skyjs" && Number.isFinite(r.jsMem)) row.skyjsMem.push(r.jsMem);
                if (spec.side === "lua" && Number.isFinite(r.gcKib)) row.luaGc.push(r.gcKib);
            }
            if (failed) break;
        }
    }
    return { rows, counts: opts.counts, failed, lastBadLog };
}

/* --------------------------------------------------------------- reports */

function fmt(n) {
    if (!Number.isFinite(n)) return "n/a";
    return n >= 10000 ? Math.round(n).toLocaleString("en-US") :
        (Math.round(n * 10) / 10).toString();
}

function buildReport(env, merged) {
    const lines = [];
    const rows = [];
    for (const name of ALL_ORDER) {
        if (name === MEM_CASE) continue;
        const r = merged.results[name];
        if (!r) continue;
        const jsMed = median(r.skyjs);
        const luaMed = median(r.lua);
        const ratio = luaMed > 0 ? jsMed / luaMed : NaN;
        rows.push({
            name, n: r.n, jsMed, luaMed, ratio,
            jsRange: fmt(Math.min(...r.skyjs)) + ".." + fmt(Math.max(...r.skyjs)),
            luaRange: fmt(Math.min(...r.lua)) + ".." + fmt(Math.max(...r.lua)),
        });
    }
    lines.push("# SkyJS vs stock skynet benchmark", "");
    lines.push("- date: " + env.date + "  commit: " + env.rev + "  node: " + env.node);
    lines.push("- cpu: " + env.cpu + "  os: macOS " + env.osver);
    lines.push("- reference node jemalloc symbols: " + env.refNodeJemallocSymbols +
        (env.refNodeJemallocSymbols > 0 ? "  **(allocator mismatch: rebuild without jemalloc)**" : ""));
    lines.push("- repeat: rounds aggregated as median (min..max); timing = in-process monotonic clock reported per case");
    lines.push("- cl_<pair>_*: cluster.call RTT over the pair (both directions); sock_*: TCP echo responses/s via the shared node client");
    lines.push("");
    lines.push("| case | n | skyjs msg/s | lua msg/s | ratio skyjs/lua | skyjs min..max | lua min..max |");
    lines.push("|---|---|---|---|---|---|---|");
    for (const row of rows) {
        lines.push("| " + row.name + " | " + row.n +
            " | " + fmt(row.jsMed) + " | " + fmt(row.luaMed) +
            " | " + (Number.isFinite(row.ratio) ? row.ratio.toFixed(2) : "n/a") +
            " | " + row.jsRange + " | " + row.luaRange + " |");
    }
    lines.push("");
    lines.push("## footprint (core phase)");
    lines.push("");
    lines.push("| metric | skyjs | stock lua |");
    lines.push("|---|---|---|");
    const mr = merged.results[MEM_CASE];
    const jsHeap = mr && mr.skyjs_extra.js_mem ? median(mr.skyjs_extra.js_mem) : NaN;
    const luaHeap = mr && mr.lua_extra.gc_kib ? median(mr.lua_extra.gc_kib) * 1024 : NaN;
    const jsRss = median(merged.rss.skyjs || []);
    const luaRss = median(merged.rss.lua || []);
    lines.push("| bench main heap (framework accounting) | " +
        fmt(jsHeap / 1048576) + " MB | " + fmt(luaHeap / 1048576) + " MB |");
    lines.push("| process RSS peak (whole node) | " + fmt(jsRss / 1024) + " MB | " +
        fmt(luaRss / 1024) + " MB |");
    lines.push("");
    if (merged.mem && merged.mem.counts && merged.mem.counts.length) {
        const counts = merged.mem.counts;
        lines.push("## memory scaling (idle echo services, dedicated node per count)");
        lines.push("");
        lines.push("| services | skyjs RSS MB | lua RSS MB | ratio skyjs/lua |");
        lines.push("|---|---|---|---|");
        const jsAt = {};
        const luaAt = {};
        for (const c of counts) {
            const row = merged.mem.rows[c] || {};
            const js = median(row.skyjs || []);
            const lua = median(row.lua || []);
            jsAt[c] = js;
            luaAt[c] = lua;
            const ratio = lua > 0 ? js / lua : NaN;
            lines.push("| " + c + " | " + fmt(js / 1024) + " | " + fmt(lua / 1024) +
                " | " + (Number.isFinite(ratio) ? ratio.toFixed(2) : "n/a") + " |");
        }
        // per-service slope vs the N=baseline node (KB per service)
        const base = counts[0];
        const top = counts[counts.length - 1];
        const denom = top - base;
        const jsSlope = denom > 0 ? (jsAt[top] - jsAt[base]) / denom : NaN;
        const luaSlope = denom > 0 ? (luaAt[top] - luaAt[base]) / denom : NaN;
        const slopeRatio = luaSlope > 0 ? jsSlope / luaSlope : NaN;
        lines.push("| per-service (KB, slope vs N=" + base + ") | " + fmt(jsSlope) +
            " | " + fmt(luaSlope) + " | " +
            (Number.isFinite(slopeRatio) ? slopeRatio.toFixed(2) : "n/a") + " |");
        lines.push("");
    }
    if (merged.warns.length) {
        lines.push("## warnings");
        lines.push("");
        for (const w of merged.warns) lines.push("- " + w);
        lines.push("");
    }
    return { lines, rows };
}

/* ------------------------------------------------------------------ main */

function parseCounts(s) {
    return String(s).split(",").map((x) => parseInt(x.trim(), 10))
        .filter((x) => Number.isFinite(x) && x >= 0);
}

function parseArgs(argv) {
    const opts = { phase: "core", repeat: 3, timeoutMs: DEFAULT_TIMEOUT_MS,
        counts: DEFAULT_MEM_COUNTS.slice(), settleMs: MEM_SETTLE_MS };
    let countsFromCli = false;
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === "--phase") opts.phase = argv[++i];
        else if (argv[i] === "--repeat") opts.repeat = parseInt(argv[++i], 10);
        else if (argv[i] === "--timeout") opts.timeoutMs = parseInt(argv[++i], 10);
        else if (argv[i] === "--counts") { opts.counts = parseCounts(argv[++i]); countsFromCli = true; }
        else if (argv[i] === "--settle") opts.settleMs = parseInt(argv[++i], 10);
    }
    if (!countsFromCli && process.env.MEM_COUNTS) opts.counts = parseCounts(process.env.MEM_COUNTS);
    return opts;
}

function ensureBins() {
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
    const opts = parseArgs(process.argv.slice(2));
    if (!["core", "cluster", "socket", "mem", "all"].includes(opts.phase)) {
        log("unknown phase: " + opts.phase);
        process.exit(2);
    }
    const binErr = ensureBins();
    if (binErr) {
        log("FAIL bench -- " + binErr);
        process.exit(1);
    }
    const env = envInfo();
    log("bench: commit " + env.rev + ", " + env.cpu + ", repeat=" + opts.repeat +
        ", phase=" + opts.phase);

    const core = (opts.phase === "core" || opts.phase === "all")
        ? await runCorePhase(opts) : { ...EMPTY(), rss: { skyjs: [], lua: [] } };
    if (core.failed) {
        log("FAIL bench -- " + core.failed);
        for (const l of (core.lastBadLog || []).slice(-25)) log("      | " + l);
        process.exit(1);
    }
    const cluster = (opts.phase === "cluster" || opts.phase === "all")
        ? await runClusterPhase(opts) : EMPTY();
    if (cluster.failed) {
        log("FAIL bench -- " + cluster.failed);
        for (const l of (cluster.lastBadLog || []).slice(-25)) log("      | " + l);
        process.exit(1);
    }
    const socket = (opts.phase === "socket" || opts.phase === "all")
        ? await runSocketPhase(opts) : EMPTY();
    if (socket.failed) {
        log("FAIL bench -- " + socket.failed);
        process.exit(1);
    }
    const mem = (opts.phase === "mem" || opts.phase === "all")
        ? await runMemPhase(opts) : { rows: {}, counts: [], failed: "" };
    if (mem.failed) {
        log("FAIL bench -- " + mem.failed);
        for (const l of (mem.lastBadLog || []).slice(-25)) log("      | " + l);
        process.exit(1);
    }

    const merged = {
        results: { ...core.results, ...cluster.results, ...socket.results },
        rss: core.rss,
        mem: { rows: mem.rows, counts: mem.counts },
        warns: [...core.warns, ...cluster.warns, ...socket.warns],
    };
    const { lines } = buildReport(env, merged);
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const reportPath = path.join(OUT_DIR, "report.md");
    fs.writeFileSync(reportPath, lines.join("\n") + "\n");
    const rawPath = path.join(OUT_DIR, "raw_" + Date.now() + ".json");
    fs.writeFileSync(rawPath, JSON.stringify({
        env, merged,
        rssCore: core.rss,
        rssCluster: cluster.rssByPair || {},
        rssSocket: socket.rssSamples || {},
        memScale: mem.rows || {},
    }, null, 2));

    for (const l of lines) log(l);
    log("report: " + reportPath);
    log("raw:    " + rawPath);
    process.exit(0);   // don't let any leaked handle keep the loop alive
}

if (require.main === module) {
    main();
}

module.exports = { runBenchProcess, runSkyjsBench, runLuaBench, runCorePhase,
    runClusterPhase, runSocketPhase, runMemPhase, envInfo, median, ALL_ORDER, CORE_ORDER,
    CLUSTER_ORDER, SOCKET_ORDER, MEM_CASE };
