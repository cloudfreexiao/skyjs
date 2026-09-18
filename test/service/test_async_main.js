// Task 3 acceptance: async core end-to-end.
// 1. JS -> C echo (await a reply from a C service)
// 2. chain A -> B (two JS services, nested awaits + timer)
// 3. concurrency: 10 interleaved sleep+call promises
// 4. error propagation: call js_bomb -> PTYPE_ERROR -> reject -> catch
// The driver triggers "start" and logs the returned summary.

var echoH = skynetcore.intcommand("LAUNCH", "echo");
var chainH = skynetcore.intcommand("LAUNCH", "snjs test/service/js_chain_a.js");
var bombH = skynetcore.intcommand("LAUNCH", "snjs test/service/js_bomb.js");
skynetcore.error("MAIN echo=" + echoH + " chain=" + chainH + " bomb=" + bombH);
skynet.register("main");
skynetcore.intcommand("LAUNCH", "driver .main 300 start 0");

async function runTests() {
    const r1 = await skynet.call(echoH, "text", "ping");
    const r2 = await skynet.call(chainH, "text", "go");

    const ps = [];
    for (let i = 0; i < 10; i++) {
        ps.push((async () => {
            await skynet.sleep(50 + i * 10);
            return await skynet.call(echoH, "text", "c" + i);
        })());
    }
    const rs = await Promise.all(ps);

    let errCaught = false;
    try {
        await skynet.call(bombH, "text", "boom");
    } catch (e) {
        errCaught = true;
    }

    const result = "R1=" + r1 + "|R2=" + r2 + "|CONC=" + rs.join(",") + "|ERR=" + errCaught;
    skynetcore.error("ASYNC RESULT: " + result);
    return result;
}

skynet.start(() => {
    skynet.dispatch("text", async (msg) => {
        if (msg === "start") return await runTests();
        return "TEXT:" + msg;
    });
});
