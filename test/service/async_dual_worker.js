// Async session acceptance: reply to the second call before releasing the first.
let first_waiter = null;

skynet.start(() => {
    skynet.dispatch("text", async (msg) => {
        const separator = msg.indexOf("|");
        if (separator <= 0) throw new Error("invalid dual request: " + msg);
        const command = msg.slice(0, separator);
        const token = msg.slice(separator + 1);
        if (command === "first") {
            if (first_waiter !== null) throw new Error("duplicate first dual request");
            return await new Promise((resolve) => {
                first_waiter = { resolve, token };
            });
        }
        if (command === "second") {
            if (first_waiter === null) throw new Error("second dual request arrived first");
            const waiter = first_waiter;
            first_waiter = null;
            skynet.timeout(1, () => waiter.resolve("X(" + waiter.token + ")"));
            return "X(" + token + ")";
        }
        throw new Error("unknown dual command: " + command);
    });
});
