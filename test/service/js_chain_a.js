// Task 3 acceptance: chain hop A. Awaits a call to chain_b before replying.
const b_h = skynetcore.int_command("LAUNCH", "snjs test/service/js_chain_b.js");

skynet.start(() => {
    skynet.dispatch("text", async (msg) => {
        const r = await skynet.call(b_h, "text", msg + "->B");
        return "A(" + r + ")";
    });
});
