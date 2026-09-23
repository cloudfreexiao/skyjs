"use strict";
// tools/run-interop.js -- one-command interop acceptance against the STOCK
// Lua skynet node (README acceptance row "与原版互通"). Chains:
//   1. build the 3rd/skynet submodule (incremental make; untracked artifacts)
//   2. clean stale listeners on the cluster ports
//   3. boot the skyjs interop node (port 2528) -- MUST be first: the Lua
//      node's own startup blocks on a cluster.call INTO this node
//   4. boot the stock Lua node (port 2530, CWD = 3rd/skynet)
//   5. assert BOTH directions across the two log streams:
//        JS -> lua  "JS2LUA RESULT: [\"lua:from-js\",43]"
//        lua -> JS  "LUA2JS RESULT: svc1:from-lua 8" + "LUA_NODE_READY"
//
// Usage: node tools/run-interop.js [--timeout ms]   (zero npm dependencies;
// watch/assert helpers are shared with tools/run-tests.js)

const { spawn, spawnSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const rt = require("./run-tests.js");

const SKYNET_DIR = path.join(rt.ROOT, "3rd", "skynet");
const DEFAULT_TIMEOUT_MS = 30000;
// a script-side failure is asserted instantly instead of waiting out the clock;
// the NEVER sentinels are for the SKYJS stream only -- the stock Lua node
// legitimately logs "KILL self" on every boot (its bootstrap service exits
// itself after the startup sequence), so that list must not apply there
const NEVER = [...rt.NEVER, "INTEROP FAIL"];

function log(msg) {
    process.stdout.write(msg + "\n");
}

// incremental make; also covers a fresh checkout where the untracked build
// tree is missing entirely (full build, may take a while)
function buildSubmodule() {
    if (!fs.existsSync(path.join(SKYNET_DIR, "Makefile"))) {
        return { ok: false, why: "3rd/skynet submodule missing (git submodule update --init)" };
    }
    const t0 = Date.now();
    const r = spawnSync("make", { cwd: SKYNET_DIR, encoding: "utf8" });
    if (r.status !== 0) {
        return { ok: false, why: "make in 3rd/skynet failed:\n" +
            ((r.stderr || "") + (r.stdout || "")).slice(-1500) };
    }
    if (!fs.existsSync(path.join(SKYNET_DIR, "skynet"))) {
        return { ok: false, why: "3rd/skynet/skynet binary not found after make" };
    }
    log("built  3rd/skynet  " + ((Date.now() - t0) / 1000).toFixed(1) + "s");
    return { ok: true, why: "" };
}

// one marker pool over BOTH log streams: each child gets exactly one watch
// (re-watching a dead child would never see its already-emitted end/close
// events), and NOTHING is killed before every marker is in -- the lua node
// may still hold an in-flight call into the skyjs node
function runInterop(timeoutMs) {
    rt.freeClusterPorts();
    return new Promise((resolve) => {
        const a = spawn(rt.BIN, ["test/config-cluster-interop.json"], { cwd: rt.ROOT });
        const lua = spawn("./skynet", ["../../test/cluster-lua/config"], { cwd: SKYNET_DIR });
        const pending = new Set([
            "JS2LUA RESULT: [\"lua:from-js\",43]",      // JS -> lua direction
            "LUA2JS RESULT: svc1:from-lua 8",           // lua -> JS direction
            "LUA_NODE_READY",
        ]);
        const lines = [];
        let bad = null;
        const cleanup = () => { rt.killTree(a); rt.killTree(lua); };
        const timer = setTimeout(() => {
            bad = "timeout after " + timeoutMs + "ms; missing: [" +
                [...pending].join("; ") + "]";
            cleanup();
        }, timeoutMs);

        const check = (name) => {
            const never = (name === "skyjs") ? NEVER : ["INTEROP FAIL"];
            return (line) => {
                if (lines.length < 400) lines.push("[" + name + "] " + line);
                if (bad) return;
                for (const n of never) {
                    if (line.includes(n)) {
                        bad = "forbidden marker (" + name + "): " + n;
                        cleanup();
                        return;
                    }
                }
                for (const m of [...pending]) {
                    if (line.includes(m)) pending.delete(m);
                }
                if (pending.size === 0) {
                    clearTimeout(timer);
                    cleanup();
                }
            };
        };

        Promise.all([
            rt.watchLines(a, check("skyjs")),
            rt.watchLines(lua, check("lua")),
        ]).then(() => {
            clearTimeout(timer);
            if (bad) return resolve({ ok: false, why: bad, log: lines });
            const crashed = [a, lua].find((ch) => ch.signalCode === "SIGSEGV" ||
                ch.signalCode === "SIGBUS" || ch.signalCode === "SIGABRT");
            if (crashed) {
                return resolve({ ok: false,
                    why: "crashed: " + (crashed === a ? "skyjs " : "lua ") + crashed.signalCode,
                    log: lines });
            }
            if (pending.size > 0) {
                return resolve({ ok: false, why: "exit before markers; missing: [" +
                    [...pending].join("; ") + "]", log: lines });
            }
            resolve({ ok: true, why: "", log: lines });
        });
    });
}

function parseArgs(argv) {
    let timeoutMs = DEFAULT_TIMEOUT_MS;
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === "--timeout") timeoutMs = parseInt(argv[++i], 10);
    }
    return { timeoutMs };
}

async function main() {
    const { timeoutMs } = parseArgs(process.argv.slice(2));
    const build = buildSubmodule();
    if (!build.ok) {
        log("FAIL interop  -- " + build.why);
        process.exit(1);
    }
    const t0 = Date.now();
    const r = await runInterop(timeoutMs);
    const ms = ((Date.now() - t0) / 1000).toFixed(1);
    log((r.ok ? "PASS " : "FAIL ") + "interop    " + ms.padStart(6) + "s" +
        (r.ok ? "" : "  -- " + r.why));
    if (!r.ok) {
        for (const l of r.log.slice(-25)) log("      | " + l);
    }
    process.exit(r.ok ? 0 : 1);
}

if (require.main === module) {
    main();
}

module.exports = { buildSubmodule, runInterop };
