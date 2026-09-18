"use strict";
// tools/run_tests.js -- zero-dependency acceptance runner (replaces manual
// log-watching, see README acceptance matrix).
//
// Model: every scenario boots ./skyjs with a test config and watches stdout+
// stderr line by line. A scenario PASSES when ALL "must" markers appear and
// NO "never" marker ever does; the process is killed as soon as it passes, so
// healthy runs finish in ~1s instead of waiting out a fixed sleep.
//
// Design points learned from real regressions:
//   - "never" includes "Maximum call stack size exceeded" and "KILL self":
//     the cross-thread stack_top bug only showed up ~1 run in 5, so use
//     --repeat N to sweep flaky failures (default 2).
//   - cluster: node B must log "listen port 2529 -> id <positive>" before
//     node A starts; a negative id means a stale process held the port and
//     the acceptance would look green while testing the wrong binary.
//   - crash detection: a child dying by signal (segfault etc.) fails its
//     scenario even if markers matched.
//
// Usage: node tools/run_tests.js [--repeat N] [--filter substr] [--timeout ms]

const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { spawn, spawnSync } = require("child_process");

const ROOT = process.cwd();
const BIN = path.join(ROOT, "skyjs");
const SERI_TOOL = path.join(ROOT, "test", "seri_tool");
const SERI_REF = path.join(ROOT, "build", "seri_ref.bin");

const DEFAULT_TIMEOUT_MS = 15000;

// markers that must never appear in ANY scenario (regression sentinels)
const NEVER = [
    "Maximum call stack size exceeded",
    "snjs seri init error",
    "snjs loader error",
    "snjs load error",
    "snjs wrap error",
    "KILL self",
    "SERI FAIL",
    "CLUSTER FAIL",
    "dispatch rejected",
];

// the acceptance suite; one entry per README acceptance-matrix row
const SUITE = [
    { name: "c_core", config: "test/config.json",
        must: ["echo service started", "LAUNCH echo"] },
    { name: "js_echo", config: "test/config_js_echo.json",
        must: ["DRIVER RESP: JS_ECHO:hello_from_js"] },
    { name: "js_async", config: "test/config_js_async.json",
        must: ["ASYNC RESULT: R1=ping|R2=A(B(go->B))|CONC=c0,c1,c2,c3,c4,c5,c6,c7,c8,c9|ERR=true"] },
    { name: "js_deadloop", config: "test/config_js_deadloop.json", timeout_ms: 20000,
        must: ["DRIVER ERROR from"] },
    { name: "js_oom", config: "test/config_js_oom.json",
        must: ["DRIVER RESP: OOM_CAUGHT:InternalError:out of memory"] },
    { name: "js_socket", config: "test/config_js_socket.json",
        must: ["SOCKTEST ALL_ECHO_OK", "SOCKTEST conn 3 closed"] },
    { name: "js_seri", config: "test/config_js_seri.json", special: run_seri },
    // JS<->JS variant: the original config_cluster_a.json also queries a stock
    // lua node on :2530, which only exists in the manual interop scenario
    { name: "cluster", config: "test/config_cluster_jsjs.json", special: run_cluster },
    // reconnect semantics: peer down -> calls fail immediately (no hang, no
    // background retry); peer up -> the next call reconnects on demand
    { name: "cluster_fail", config: "test/config_cluster_fail.json", special: run_cluster_fail },
    { name: "bench", config: "test/config_bench.json", timeout_ms: 60000,
        must_re: [/BENCH N=20000 c_echo=\d+ msg\/s j_echo=\d+ msg\/s/] },
];

/* ------------------------------------------------------------------ utils */

function log(msg) {
    process.stdout.write(msg + "\n");
}

function kill_tree(child) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    const t = setTimeout(() => child.kill("SIGKILL"), 500);
    t.unref();
}

// watch one child's stdout+stderr; on_line gets every line; resolves on exit
function watch_lines(child, on_line) {
    const streams = [child.stdout, child.stderr];
    const done = new Promise((resolve) => {
        let open = streams.length;
        for (const st of streams) {
            readline.createInterface({ input: st }).on("line", on_line);
            st.on("end", () => { if (--open === 0) resolve(); });
        }
        child.on("close", () => resolve());
    });
    return done;
}

/* --------------------------------------------------------- scenario runner */

// watch an already-running child for must/never markers; returns { ok, why, log }
function watch_markers(child, must, never, timeout_ms, must_re) {
    return new Promise((resolve) => {
        const pending = new Set(must);
        const lines = [];
        let bad = null;
        const timer = setTimeout(() => {
            bad = "timeout after " + timeout_ms + "ms; missing: [" +
                [...pending].join("; ") + "]";
            kill_tree(child);
        }, timeout_ms);

        watch_lines(child, (line) => {
            if (lines.length < 400) lines.push(line);
            if (bad) return;
            for (const n of never) {
                if (line.includes(n)) {
                    bad = "forbidden marker: " + n;
                    kill_tree(child);
                    return;
                }
            }
            for (const m of [...pending]) {
                if (line.includes(m)) pending.delete(m);
            }
            for (const re of must_re) {
                if (re.test(line)) pending.delete(String(re));
            }
            if (pending.size === 0) {
                clearTimeout(timer);
                kill_tree(child);
            }
        }).then(() => {
            clearTimeout(timer);
            if (bad) return resolve({ ok: false, why: bad, log: lines });
            if (child.signalCode === "SIGSEGV" || child.signalCode === "SIGBUS" ||
                child.signalCode === "SIGABRT") {
                return resolve({ ok: false, why: "crashed: " + child.signalCode, log: lines });
            }
            if (pending.size > 0) {
                return resolve({ ok: false, why: "exit before markers; missing: [" +
                    [...pending].join("; ") + "]", log: lines });
            }
            resolve({ ok: true, why: "", log: lines });
        });
    });
}

// launch one ./skyjs <config> and wait for markers; returns { ok, why, log }
function run_config(cfg, must, never, timeout_ms, must_re) {
    const child = spawn(BIN, [cfg], { cwd: ROOT });
    return watch_markers(child, must, never, timeout_ms, must_re);
}

/* ---------------------------------------------------- special: lua-seri */

async function run_seri(cfg, never, timeout_ms) {
    fs.mkdirSync(path.join(ROOT, "build"), { recursive: true });
    const gen = spawnSync(SERI_TOOL, ["gen", SERI_REF], { cwd: ROOT, encoding: "utf8" });
    if (gen.status !== 0) {
        return { ok: false, why: "seri_tool gen failed: " + (gen.stderr || gen.status) };
    }
    const r = await run_config(cfg,
        ["SERI RESULT: ALL_OK", "DRIVER RESP: SERI_ALL_OK"], never, timeout_ms, []);
    if (!r.ok) return r;

    // the JS-packed file must survive the ORIGINAL unpacker: byte-level
    // compatibility is proven when the stock lua-seri can dump it back
    // (test_seri_main.js writes to this hardcoded path)
    const dump = spawnSync(SERI_TOOL, ["dump", "/tmp/seri_js.bin"],
        { cwd: ROOT, encoding: "utf8" });
    if (dump.status !== 0) {
        return { ok: false, why: "seri_tool dump crashed (status " + dump.status + ")" };
    }
    const want = ["[1] str:two", "[3] table:", "str:k", "int:5", "str:pi", "real:3.14", "[4] table:"];
    const missing = want.filter((w) => !dump.stdout.includes(w));
    if (missing.length > 0) {
        return { ok: false, why: "dump missing: [" + missing.join("; ") + "]" };
    }
    return { ok: true, why: "" };
}

/* --------------------------------------------------- special: cluster x2 */

function free_cluster_ports() {
    // stale listeners from a previous run make acceptance look green while
    // testing the wrong binary; best-effort cleanup, the id check below
    // catches anything that survives
    const r = spawnSync("sh", ["-c",
        "lsof -nP -tiTCP:2528 -tiTCP:2529 -tiTCP:2530 -sTCP:LISTEN | xargs kill"],
        { cwd: ROOT });
    void r;
}

async function run_cluster(cfg, never, timeout_ms) {
    free_cluster_ports();
    const node_b = path.join(ROOT, "test", "config_cluster_b.json");
    const b = spawn(BIN, [node_b], { cwd: ROOT });
    const b_ready = new Promise((resolve) => {
        watch_lines(b, (line) => {
            // id must be positive: "id -1" means the port was taken
            if (/listen port 2529 -> id [1-9]/.test(line)) resolve(true);
        });
        setTimeout(() => resolve(false), timeout_ms);
    });
    const ready = await b_ready;
    if (!ready) {
        kill_tree(b);
        return { ok: false, why: "node B never logged a positive listen id" };
    }

    const r = await run_config(cfg,
        ["CLUSTER RESULT: [\"svc2:hello\",42]", "DRIVER RESP: CLUSTER_OK"],
        never, timeout_ms, []);
    kill_tree(b);
    return r;
}

/* ------------------------------------------- special: reconnect semantics */

// Two phases over ONE node A process (a second watch after A dies would
// never see its already-emitted 'end'/'close' events, so one watch_lines
// state machine covers both phases):
//   phase 1: node2 down -> two calls 500ms apart are rejected immediately
//   (a background-retry regression hangs here and times out);
//   phase 2: node B boots mid-stream and A's next call reconnects on demand.
async function run_cluster_fail(cfg, never, timeout_ms) {
    free_cluster_ports();
    return new Promise((resolve) => {
        const a = spawn(BIN, [cfg], { cwd: ROOT });
        const b_ready_re = /listen port 2529 -> id [1-9]/;
        const pending = new Set(["CLUSTER DOWN OK1", "CLUSTER DOWN OK2",
            "CLUSTER RESULT: [\"svc2:hello\",42]"]);
        const lines = [];
        let b = null;
        let b_up = false;
        let bad = null;
        const cleanup = () => {
            kill_tree(a);
            if (b) kill_tree(b);
        };
        const timer = setTimeout(() => {
            bad = "timeout after " + timeout_ms + "ms; missing: [" +
                [...pending].join("; ") + "]";
            cleanup();
        }, timeout_ms);

        watch_lines(a, (line) => {
            if (lines.length < 400) lines.push(line);
            if (bad) return;
            for (const n of never) {
                if (line.includes(n)) {
                    bad = "forbidden marker: " + n;
                    cleanup();
                    return;
                }
            }
            for (const m of [...pending]) {
                if (line.includes(m)) pending.delete(m);
            }
            if (!pending.has("CLUSTER DOWN OK2") && b === null) {
                // phase 1 complete: boot node B; A keeps calling and will
                // reconnect on demand once B listens
                b = spawn(BIN, [path.join(ROOT, "test", "config_cluster_b.json")],
                    { cwd: ROOT });
                watch_lines(b, (bline) => {
                    // id must be positive: "id -1" means the port was taken
                    if (b_ready_re.test(bline)) b_up = true;
                });
            }
            if (pending.size === 0) {
                clearTimeout(timer);
                cleanup();
            }
        }).then(() => {
            clearTimeout(timer);
            if (bad) return resolve({ ok: false, why: bad, log: lines });
            if (a.signalCode === "SIGSEGV" || a.signalCode === "SIGBUS" ||
                a.signalCode === "SIGABRT") {
                return resolve({ ok: false, why: "crashed: " + a.signalCode, log: lines });
            }
            if (pending.size > 0) {
                return resolve({ ok: false, why: "exit before markers; missing: [" +
                    [...pending].join("; ") + "]" +
                    (b && !b_up ? " (node B never ready)" : ""), log: lines });
            }
            resolve({ ok: true, why: "", log: lines });
        });
    });
}

/* ------------------------------------------------------------------ main */

function parse_args(argv) {
    const opts = { repeat: 2, filter: "", timeout_ms: DEFAULT_TIMEOUT_MS };
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === "--repeat") opts.repeat = parseInt(argv[++i], 10);
        else if (argv[i] === "--filter") opts.filter = argv[++i];
        else if (argv[i] === "--timeout") opts.timeout_ms = parseInt(argv[++i], 10);
    }
    return opts;
}

async function main() {
    const opts = parse_args(process.argv.slice(2));
    if (!fs.existsSync(BIN)) {
        log("skyjs binary not found: " + BIN + " (run make first)");
        process.exit(1);
    }
    const cases = SUITE.filter((c) => c.name.includes(opts.filter));
    if (cases.length === 0) {
        log("no scenario matches filter: " + opts.filter);
        process.exit(1);
    }

    let failed = 0;
    for (let round = 1; round <= opts.repeat && failed === 0; round++) {
        log("== round " + round + "/" + opts.repeat + " ==");
        for (const c of cases) {
            const t0 = Date.now();
            const never = NEVER;
            const timeout_ms = c.timeout_ms || opts.timeout_ms;
            const r = c.special
                ? await c.special(c.config, never, timeout_ms)
                : await run_config(c.config, c.must || [], never, timeout_ms, c.must_re || []);
            const ms = ((Date.now() - t0) / 1000).toFixed(1);
            const tag = r.ok ? "PASS" : "FAIL";
            log(tag.padEnd(5) + c.name.padEnd(12) + ms.padStart(6) + "s" +
                (r.ok ? "" : "  -- " + r.why));
            if (!r.ok && r.log) {
                for (const l of r.log.slice(-25)) log("      | " + l);
            }
            if (!r.ok) failed++;
        }
    }

    log("== summary: " + (failed === 0 ? "ALL PASS" : failed + " FAILURE(S)") +
        " (" + opts.repeat + " round" + (opts.repeat > 1 ? "s" : "") + ") ==");
    process.exit(failed === 0 ? 0 : 1);
}

main();
