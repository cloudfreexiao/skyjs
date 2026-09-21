// Task 3 acceptance: async core end-to-end.
// 1. JS -> C echo (await a reply from a C service)
// 2. chain A -> B (two JS services, nested awaits + timer)
// 3. concurrency: 10 interleaved sleep+call promises
// 4. error propagation: call async_bomb_worker -> PTYPE_ERROR -> reject -> catch
// The driver triggers "start" and logs the returned summary.

const echo_h = skynetcore.int_command("LAUNCH", "echo");
const chain_h = skynetcore.int_command("LAUNCH", "snjs test/service/async_chain_a_worker.js");
const bomb_h = skynetcore.int_command("LAUNCH", "snjs test/service/async_bomb_worker.js");
skynetcore.error("MAIN echo=" + echo_h + " chain=" + chain_h + " bomb=" + bomb_h);
skynet.register("main");
skynetcore.int_command("LAUNCH", "driver .main 300 start 0");

async function run_tests() {
    const r1 = await skynet.call(echo_h, "text", "ping");
    const r2 = await skynet.call(chain_h, "text", "go");

    const ps = [];
    for (let i = 0; i < 10; i++) {
        ps.push((async () => {
            await skynet.sleep(50 + i * 10);
            return await skynet.call(echo_h, "text", "c" + i);
        })());
    }
    const rs = await Promise.all(ps);

    let err_caught = false;
    try {
        await skynet.call(bomb_h, "text", "boom");
    } catch (e) {
        err_caught = true;
    }

    const result = "R1=" + r1 + "|R2=" + r2 + "|CONC=" + rs.join(",") + "|ERR=" + err_caught;
    skynetcore.error("ASYNC RESULT: " + result);
    return result;
}

skynet.start(() => {
    skynet.dispatch("text", async (msg) => {
        if (msg === "start") return await run_tests();
        return "TEXT:" + msg;
    });
});
