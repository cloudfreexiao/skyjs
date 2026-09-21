// Long-run stability driver: sustained mixed load for <minutes> (snjs_param,
// default 30), emitting one LONGRUN tick per second with the framework's
// per-service JS heap so the harness can reconcile js_mem growth against RSS
// growth (memstat blind-zone check, docs/TODO.md「平台与稳定性」).
// Load model per tick (~1s, 233 fixed ops):
//   50 text 20B RTT (C echo) + 50 text 20B RTT (JS echo)
//   10 lua-protocol 10-field table RTT + 1 text 64KB RTT (copy path)
//   100 fire-and-forget + 20 concurrent 10ms timers
//   2 transient JS echo services: create -> call -> KILL (lifecycle churn)
skynet.register("main");

const c_echo = skynetcore.int_command("LAUNCH", "echo");
const j_echo = skynetcore.int_command("LAUNCH", "snjs test/service/bench_echo_worker.js");

const P20 = "ping_" + "m".repeat(15);
const P64K = "x".repeat(65536);
const TBL10 = { id: 1, type: 2, hp: 100, mp: 50, x: 3, y: 4, lv: 10, exp: 999, gold: 88, flag: 1 };
const OPS_PER_TICK = 233;   // 50+50+10+1+100+20+2 fixed ops per tick
const TICK_MS = 1000;

async function one_tick() {
    for (let i = 0; i < 50; i++) await skynet.call(c_echo, "text", P20);
    for (let i = 0; i < 50; i++) await skynet.call(j_echo, "text", P20);
    for (let i = 0; i < 10; i++) {
        skynet.unpack(await skynet.call(j_echo, "lua", skynet.pack(TBL10)));
    }
    await skynet.call(j_echo, "text", P64K);
    for (let i = 0; i < 100; i++) skynetcore.send(j_echo, 0, P20, 0);
    const ps = [];
    for (let i = 0; i < 20; i++) ps.push(skynet.sleep(10));
    await Promise.all(ps);
    for (let i = 0; i < 2; i++) {
        const h = skynetcore.int_command("LAUNCH", "snjs test/service/bench_echo_worker.js");
        await skynet.call(h, "text", P20);
        // KILL 参数是 :hex 格式（内核 tohandle 只认 :hex/.name，十进制会被拒）
        skynetcore.command("KILL", ":" + h.toString(16));
    }
}

async function run_load() {
    // snjs_param is injected AFTER the user script eval completes (snjs.c
    // injects it post-JS_Eval; skynet.start runs synchronously inside eval),
    // so wait one dispatch turn before reading it
    await skynet.sleep(30);
    const minutes = parseInt(globalThis.snjs_param, 10) || 30;
    const duration_ms = minutes * 60 * 1000;
    skynetcore.error("LONGRUN start param=" + globalThis.snjs_param +
        " duration_ms=" + duration_ms);
    let tick = 0;
    let done = 0;
    const t_start = Date.now();
    const t_end = t_start + duration_ms;
    try {
        while (Date.now() < t_end) {
            const t0 = Date.now();
            await one_tick();
            done += OPS_PER_TICK;
            tick++;
            skynetcore.error("LONGRUN tick=" + tick + " done=" + done +
                " js_mem=" + skynet.mem_stat() + " elapsed_ms=" + (Date.now() - t_start));
            // keep the tick cadence ~1s even when a load burst runs faster
            const spent = Date.now() - t0;
            if (spent < TICK_MS) await skynet.sleep(TICK_MS - spent);
        }
        skynetcore.error("LONGRUN_DONE done=" + done + " js_mem=" + skynet.mem_stat() +
            " elapsed_ms=" + (Date.now() - t_start));
    } catch (e) {
        skynetcore.error("LONGRUN_FAIL: " + (e && (e.message || e)));
    }
    skynet.exit();
}

skynet.start(() => {
    run_load();
});
