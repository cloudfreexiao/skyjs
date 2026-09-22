// Async reentry acceptance: C asks D to call back into the waiting B service.
const d_h = skynetcore.int_command("LAUNCH", "snjs test/service/async_chain_d_worker.js");

skynet.start(() => {
    skynet.dispatch("text", async (msg) => {
        const separator = msg.indexOf("|");
        if (separator <= 0) throw new Error("invalid C request: " + msg);
        const b_h = Number(msg.slice(0, separator));
        const token = msg.slice(separator + 1);
        const r = await skynet.call(d_h, "text", b_h + "|" + token);
        return "C(" + r + ")";
    });
});
