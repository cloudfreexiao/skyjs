// run_bench.js memory-scaling driver (JS side): launches N idle echo services
// on a dedicated node so the steady-state RSS at that service count can be
// attributed cleanly. The count N comes from snjs_param (see the temp config
// tools/run_bench.js writes: bootstrap "snjs test/service/bench_mem_main.js N").
// snjs_param is injected only after the user script finishes eval, so a driver
// service kicks "run" 300ms after start, mirroring bench_trim_main.js. Case set
// stays in lockstep with test/bench_lua/mem_main.lua.
skynet.register("main");

const P20 = "ping_" + "m".repeat(15);      // 20 bytes, constant payload

async function run_scale() {
    const n = parseInt(globalThis.snjs_param, 10) || 0;
    const handles = [];
    for (let i = 0; i < n; i++) {
        handles.push(skynetcore.int_command("LAUNCH", "snjs test/service/bench_echo_worker.js"));
    }
    // one RTT each so the service actually loaded (snjs loads lazily)
    for (const h of handles) await skynet.call(h, "text", P20);
    skynetcore.error("BENCH case=mem_scale n=" + n + " mps=0 js_mem=" + skynet.mem_stat());
    skynetcore.error("BENCH_MEM_READY count=" + n);
    // idle on purpose: the harness samples steady-state RSS then kills us
}

skynet.start(() => {
    skynetcore.int_command("LAUNCH", "driver .main 300 run x");
    skynet.dispatch("text", (msg) => {
        if (msg !== "run") return "OK";
        run_scale().catch(e => {
            skynetcore.error("BENCH_FAIL: " + (e && (e.message || e)));
        });
        return undefined;
    });
});
