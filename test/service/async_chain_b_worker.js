// Task 3 acceptance: chain hop B. Sleeps 200ms to prove timers wake awaits.
skynet.start(() => {
    skynet.dispatch("text", async (msg) => {
        await skynet.sleep(200);
        return "B(" + msg + ")";
    });
});
