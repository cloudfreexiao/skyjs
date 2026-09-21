"use strict";
// tools/run_longrun.js -- sustained-load long-run harness with memstat/RSS
// reconciliation (docs/TODO.md「平台与稳定性」: 30-min soak + accounting check).
//
// Boots ./skyjs with test/service/longrun_main.js under a generated config,
// samples process RSS every second (harness side) while the service emits one
// LONGRUN tick per second carrying its JS heap accounting, then reports:
//   - throughput stability (first vs last third of ticks)
//   - RSS growth vs js_mem growth -> memstat blind-zone estimate
//     (RSS holds the kernel/C baseline too, so only the GROWTH reconciles;
//     quickjs internal caches would show up as RSS growth without js_mem growth)
//
// Usage: node tools/run_longrun.js [--minutes 30] [--out build/longrun]

const fs = require("fs");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const rt = require("./run_tests.js");           // ROOT / BIN / watch_lines / kill_tree

function log(msg) {
    process.stdout.write(msg + "\n");
}

function fmt_mb(kb) {
    return (Math.round(kb / 1024 * 10) / 10).toFixed(1) + " MB";
}

// 1s RSS sampling (finer than run_bench's 250ms -- long runs want a series,
// not just a peak); caller MUST stop() or node never exits
function rss_sampler_1s(pid) {
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
function edge_mean(arr, frac, tail) {
    if (arr.length === 0) return NaN;
    const n = Math.max(1, Math.floor(arr.length * frac));
    let sum = 0;
    for (let i = 0; i < n; i++) sum += tail ? arr[arr.length - 1 - i] : arr[i];
    return sum / n;
}

// measured throughput for a contiguous [begin, end) tick range; elapsed_ms is
// produced by the service's Date.now clock, so logger lag cannot skew it
function segment_rate(ticks, begin, end) {
    if (end - begin < 2) return NaN;
    const first = ticks[begin];
    const last = ticks[end - 1];
    const d_ops = last.done - first.done;
    const d_ms = last.elapsed_ms - first.elapsed_ms;
    return d_ms > 0 ? d_ops * 1000 / d_ms : NaN;
}

function parse_args(argv) {
    const opts = { minutes: 30, out: path.join(rt.ROOT, "build", "longrun") };
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === "--minutes") opts.minutes = parseInt(argv[++i], 10);
        else if (argv[i] === "--out") opts.out = path.resolve(argv[++i]);
    }
    return opts;
}

async function main() {
    const opts = parse_args(process.argv.slice(2));
    if (!fs.existsSync(rt.BIN)) {
        log("FAIL longrun -- skyjs binary not found (run make first)");
        process.exit(1);
    }
    fs.mkdirSync(opts.out, { recursive: true });
    const cfg = {
        thread: 4,
        cpath: "./cservice/?.so;./test/cservice/?.so",
        bootstrap: "snjs test/service/longrun_main.js " + opts.minutes,
        logservice: "logger",
        profile: true,
    };
    const cfg_path = path.join(opts.out, "config.json");
    fs.writeFileSync(cfg_path, JSON.stringify(cfg, null, 2) + "\n");

    log("longrun: " + opts.minutes + " min, config " + cfg_path);
    const child = spawn(rt.BIN, [cfg_path], { cwd: rt.ROOT });
    const rss = rss_sampler_1s(child.pid);
    const ticks = [];
    let done_info = null;
    let fail = null;
    // generous guard: expected runtime + 2 min for boot/teardown
    const timer = setTimeout(() => {
        fail = "timeout after " + (opts.minutes + 2) + " min (" +
            ticks.length + " ticks so far)";
        rt.kill_tree(child);
    }, (opts.minutes + 2) * 60000);

    await rt.watch_lines(child, (line) => {
        let m = line.match(/LONGRUN tick=(\d+) done=(\d+) js_mem=(\d+) elapsed_ms=(\d+)/);
        if (m) {
            ticks.push({ tick: parseInt(m[1], 10), done: parseInt(m[2], 10),
                js_mem: parseInt(m[3], 10), elapsed_ms: parseInt(m[4], 10) });
            return;
        }
        m = line.match(/LONGRUN_DONE done=(\d+) js_mem=(\d+) elapsed_ms=(\d+)/);
        if (m) {
            done_info = { done: parseInt(m[1], 10), js_mem: parseInt(m[2], 10),
                elapsed_ms: parseInt(m[3], 10) };
            rt.kill_tree(child);
            return;
        }
        if (line.includes("LONGRUN_FAIL:") || line.includes("BENCH_FAIL:")) {
            fail = line.trim();
            rt.kill_tree(child);
        }
    });
    clearTimeout(timer);
    rss.stop();

    if (!done_info || ticks.length === 0) {
        log("FAIL longrun -- " + (fail || "no LONGRUN records (crash before start?)"));
        process.exit(1);
    }
    if (fail) {
        log("FAIL longrun -- " + fail);
        process.exit(1);
    }

    // growth estimates: mean of first/last 10% of each series; RSS and js_mem
    // series are sampled at different instants, so only growth deltas compare
    const js_mems = ticks.map((t) => t.js_mem / 1024);      // KB
    const rss_kbs = rss.series.map((s) => s.kb);            // KB
    const js_base = edge_mean(js_mems, 0.1, false);
    const js_tail = edge_mean(js_mems, 0.1, true);
    const rss_base = edge_mean(rss_kbs, 0.1, false);
    const rss_tail = edge_mean(rss_kbs, 0.1, true);
    const rss_peak = Math.max(...rss_kbs);
    const js_growth = js_tail - js_base;
    const rss_growth = rss_tail - rss_base;
    const blind = rss_growth - js_growth;

    const third = Math.max(1, Math.floor(ticks.length / 3));
    const mps_first = segment_rate(ticks, 0, third);
    const mps_last = segment_rate(ticks, ticks.length - third, ticks.length);

    const summary = {
        minutes: opts.minutes,
        elapsed_ms: done_info.elapsed_ms,
        ticks: ticks.length,
        ops_total: done_info.done,
        ops_per_s_first_third: Math.round(mps_first),
        ops_per_s_last_third: Math.round(mps_last),
        rss_base_kb: Math.round(rss_base),
        rss_tail_kb: Math.round(rss_tail),
        rss_peak_kb: Math.round(rss_peak),
        rss_growth_kb: Math.round(rss_growth),
        js_mem_base_kb: Math.round(js_base),
        js_mem_tail_kb: Math.round(js_tail),
        js_mem_growth_kb: Math.round(js_growth),
        memstat_blind_zone_kb: Math.round(blind),
        js_mem_final_bytes: done_info.js_mem,
    };
    const out_json = path.join(opts.out, "longrun_" + Date.now() + ".json");
    fs.writeFileSync(out_json, JSON.stringify({
        summary, ticks, rss_series: rss.series,
    }, null, 2) + "\n");

    log("");
    log("== longrun summary ==");
    log("duration  " + (done_info.elapsed_ms / 60000).toFixed(2) + " min, " +
        ticks.length + " ticks, " + done_info.done + " ops");
    log("throughput  first-third ~" + summary.ops_per_s_first_third +
        " ops/s, last-third ~" + summary.ops_per_s_last_third + " ops/s");
    log("RSS (harness 1s ps sampling)  base " + fmt_mb(rss_base) + " -> tail " +
        fmt_mb(rss_tail) + " (growth " + (rss_growth >= 0 ? "+" : "") +
        fmt_mb(rss_growth) + "), peak " + fmt_mb(rss_peak));
    log("JS heap (service accounting)  base " + fmt_mb(js_base) + " -> tail " +
        fmt_mb(js_tail) + " (growth " + (js_growth >= 0 ? "+" : "") +
        fmt_mb(js_growth) + ")");
    log("memstat blind zone  RSS growth - js_mem growth = " +
        (blind >= 0 ? "+" : "") + fmt_mb(blind) + " over " + opts.minutes + " min");
    log("report: " + out_json);
    process.exit(0);    // don't let any leaked handle keep the loop alive
}

if (require.main === module) {
    main();
}
