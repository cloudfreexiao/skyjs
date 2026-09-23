"use strict";
// tools/run-longrun.js -- sustained-load long-run harness with memstat/RSS
// reconciliation (docs/TODO.md「平台与稳定性」: 30-min soak + accounting check).
//
// Boots ./skyjs with test/service/longrun-main.js under a generated config,
// samples process RSS every second (harness side) while the service emits one
// LONGRUN tick per second carrying its JS heap accounting, then reports:
//   - throughput stability (first vs last third of ticks)
//   - RSS growth vs js_mem growth -> memstat blind-zone estimate
//     (RSS holds the kernel/C baseline too, so only the GROWTH reconciles;
//     quickjs internal caches would show up as RSS growth without js_mem growth)
//
// Usage: node tools/run-longrun.js [--minutes 30] [--out build/longrun]

const fs = require("fs");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const rt = require("./run-tests.js");           // ROOT / BIN / watch_lines / kill_tree

function log(msg) {
    process.stdout.write(msg + "\n");
}

function fmtMb(kb) {
    return (Math.round(kb / 1024 * 10) / 10).toFixed(1) + " MB";
}

// 1s RSS sampling (finer than run_bench's 250ms -- long runs want a series,
// not just a peak); caller MUST stop() or node never exits
function rssSampler1s(pid) {
    const series = [];
    const t = setInterval(() => {
        const r = spawnSync("ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8" });
        const kb = parseInt((r.stdout || "").trim(), 10);
        if (Number.isFinite(kb)) series.push({ at: Date.now(), kb });
    }, 1000);
    return { series, stop: () => clearInterval(t) };
}

// mean of the first (head=false) or last (head=true) `frac` fraction of a
// numeric series (stable endpoints for growth estimates -- single endpoints
// are noise)
function edgeMean(arr, frac, tail) {
    if (arr.length === 0) return NaN;
    const n = Math.max(1, Math.floor(arr.length * frac));
    let sum = 0;
    for (let i = 0; i < n; i++) sum += tail ? arr[arr.length - 1 - i] : arr[i];
    return sum / n;
}

// measured throughput for a contiguous [begin, end) tick range; elapsed_ms is
// produced by the service's Date.now clock, so logger lag cannot skew it
function segmentRate(ticks, begin, end) {
    if (end - begin < 2) return NaN;
    const first = ticks[begin];
    const last = ticks[end - 1];
    const dOps = last.done - first.done;
    const dMs = last.elapsedMs - first.elapsedMs;
    return dMs > 0 ? dOps * 1000 / dMs : NaN;
}

function parseArgs(argv) {
    const opts = { minutes: 30, out: path.join(rt.ROOT, "build", "longrun") };
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === "--minutes") opts.minutes = parseInt(argv[++i], 10);
        else if (argv[i] === "--out") opts.out = path.resolve(argv[++i]);
    }
    return opts;
}

async function main() {
    const opts = parseArgs(process.argv.slice(2));
    if (!fs.existsSync(rt.BIN)) {
        log("FAIL longrun -- skyjs binary not found (run make first)");
        process.exit(1);
    }
    fs.mkdirSync(opts.out, { recursive: true });
    const cfg = {
        thread: 4,
        cpath: "./cservice/?.so;./test/cservice/?.so",
        bootstrap: "snjs test/service/longrun-main.js " + opts.minutes,
        logservice: "logger",
        profile: true,
    };
    const cfgPath = path.join(opts.out, "config.json");
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + "\n");

    log("longrun: " + opts.minutes + " min, config " + cfgPath);
    const child = spawn(rt.BIN, [cfgPath], { cwd: rt.ROOT });
    const rss = rssSampler1s(child.pid);
    const ticks = [];
    let doneInfo = null;
    let fail = null;
    // generous guard: expected runtime + 2 min for boot/teardown
    const timer = setTimeout(() => {
        fail = "timeout after " + (opts.minutes + 2) + " min (" +
            ticks.length + " ticks so far)";
        rt.killTree(child);
    }, (opts.minutes + 2) * 60000);

    await rt.watchLines(child, (line) => {
        let m = line.match(/LONGRUN tick=(\d+) done=(\d+) js_mem=(\d+) elapsed_ms=(\d+)/);
        if (m) {
            ticks.push({ tick: parseInt(m[1], 10), done: parseInt(m[2], 10),
                jsMem: parseInt(m[3], 10), elapsedMs: parseInt(m[4], 10) });
            return;
        }
        m = line.match(/LONGRUN_DONE done=(\d+) js_mem=(\d+) elapsed_ms=(\d+)/);
        if (m) {
            doneInfo = { done: parseInt(m[1], 10), jsMem: parseInt(m[2], 10),
                elapsedMs: parseInt(m[3], 10) };
            rt.killTree(child);
            return;
        }
        if (line.includes("LONGRUN_FAIL:") || line.includes("BENCH_FAIL:")) {
            fail = line.trim();
            rt.killTree(child);
        }
    });
    clearTimeout(timer);
    rss.stop();

    if (!doneInfo || ticks.length === 0) {
        log("FAIL longrun -- " + (fail || "no LONGRUN records (crash before start?)"));
        process.exit(1);
    }
    if (fail) {
        log("FAIL longrun -- " + fail);
        process.exit(1);
    }

    // growth estimates: mean of first/last 10% of each series; RSS and js_mem
    // series are sampled at different instants, so only growth deltas compare
    const jsMems = ticks.map((t) => t.jsMem / 1024);      // KB
    const rssKbs = rss.series.map((s) => s.kb);            // KB
    const jsBase = edgeMean(jsMems, 0.1, false);
    const jsTail = edgeMean(jsMems, 0.1, true);
    const rssBase = edgeMean(rssKbs, 0.1, false);
    const rssTail = edgeMean(rssKbs, 0.1, true);
    const rssPeak = Math.max(...rssKbs);
    const jsGrowth = jsTail - jsBase;
    const rssGrowth = rssTail - rssBase;
    const blind = rssGrowth - jsGrowth;

    const third = Math.max(1, Math.floor(ticks.length / 3));
    const mpsFirst = segmentRate(ticks, 0, third);
    const mpsLast = segmentRate(ticks, ticks.length - third, ticks.length);

    const summary = {
        minutes: opts.minutes,
        elapsedMs: doneInfo.elapsedMs,
        ticks: ticks.length,
        opsTotal: doneInfo.done,
        opsPerSFirstThird: Math.round(mpsFirst),
        opsPerSLastThird: Math.round(mpsLast),
        rssBaseKb: Math.round(rssBase),
        rssTailKb: Math.round(rssTail),
        rssPeakKb: Math.round(rssPeak),
        rssGrowthKb: Math.round(rssGrowth),
        jsMemBaseKb: Math.round(jsBase),
        jsMemTailKb: Math.round(jsTail),
        jsMemGrowthKb: Math.round(jsGrowth),
        memstatBlindZoneKb: Math.round(blind),
        jsMemFinalBytes: doneInfo.jsMem,
    };
    const outJson = path.join(opts.out, "longrun_" + Date.now() + ".json");
    fs.writeFileSync(outJson, JSON.stringify({
        summary, ticks, rssSeries: rss.series,
    }, null, 2) + "\n");

    log("");
    log("== longrun summary ==");
    log("duration  " + (doneInfo.elapsedMs / 60000).toFixed(2) + " min, " +
        ticks.length + " ticks, " + doneInfo.done + " ops");
    log("throughput  first-third ~" + summary.opsPerSFirstThird +
        " ops/s, last-third ~" + summary.opsPerSLastThird + " ops/s");
    log("RSS (harness 1s ps sampling)  base " + fmtMb(rssBase) + " -> tail " +
        fmtMb(rssTail) + " (growth " + (rssGrowth >= 0 ? "+" : "") +
        fmtMb(rssGrowth) + "), peak " + fmtMb(rssPeak));
    log("JS heap (service accounting)  base " + fmtMb(jsBase) + " -> tail " +
        fmtMb(jsTail) + " (growth " + (jsGrowth >= 0 ? "+" : "") +
        fmtMb(jsGrowth) + ")");
    log("memstat blind zone  RSS growth - js_mem growth = " +
        (blind >= 0 ? "+" : "") + fmtMb(blind) + " over " + opts.minutes + " min");
    log("report: " + outJson);
    process.exit(0);    // don't let any leaked handle keep the loop alive
}

if (require.main === module) {
    main();
}
