// Task 7: message throughput benchmark (single node, serial round trips).
// Compares JS->C echo vs JS->JS echo; timing via skynetcore.now (centiseconds).
const c_echo = skynetcore.int_command("LAUNCH", "echo");
const j_echo = skynetcore.int_command("LAUNCH", "snjs test/service/js_echo_async.js");
skynet.register("main");
skynetcore.int_command("LAUNCH", "driver .main 300 bench 0");

skynet.start(() => {
    skynet.dispatch("text", async (msg) => {
        if (msg !== "bench") return "OK";
        const N = 20000;
        for (let i = 0; i < 100; i++) await skynet.call(c_echo, "text", "w");
        let t0 = skynetcore.now();
        for (let i = 0; i < N; i++) await skynet.call(c_echo, "text", "m" + i);
        let t1 = skynetcore.now();
        for (let i = 0; i < 100; i++) await skynet.call(j_echo, "text", "w");
        let t2 = skynetcore.now();
        for (let i = 0; i < N; i++) await skynet.call(j_echo, "text", "m" + i);
        let t3 = skynetcore.now();
        const r = "BENCH N=" + N
            + " c_echo=" + ((N * 100) / (t1 - t0)).toFixed(0) + " msg/s"
            + " j_echo=" + ((N * 100) / (t3 - t2)).toFixed(0) + " msg/s"
            + " js_mem=" + skynet.mem_stat() + "B";
        skynetcore.error(r);
        return r;
    });
});
