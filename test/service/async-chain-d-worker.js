// Async reentry acceptance: D calls B while B's original handler awaits C.
skynet.start(() => {
    skynet.dispatch("text", async (msg) => {
        const separator = msg.indexOf("|");
        if (separator <= 0) throw new Error("invalid D request: " + msg);
        const bH = Number(msg.slice(0, separator));
        const token = msg.slice(separator + 1);
        const r = await skynet.call(bH, "text", "resume:" + token);
        return "D(" + r + ")";
    });
});
