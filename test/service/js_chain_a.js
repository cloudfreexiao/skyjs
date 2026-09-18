// Task 3 acceptance: chain hop A. Awaits a call to chain_b before replying.
var bH = skynetcore.intcommand("LAUNCH", "snjs test/service/js_chain_b.js");

skynet.start(() => {
    skynet.dispatch("text", async (msg) => {
        const r = await skynet.call(bH, "text", msg + "->B");
        return "A(" + r + ")";
    });
});
