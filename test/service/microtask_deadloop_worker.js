// Deadloop acceptance: a Promise chain that continuously queues another job.
skynet.start(() => {
    const spin = () => Promise.resolve().then(spin);
    skynet.dispatch("text", (msg) => {
        if (msg === "loop") {
            spin();
            return new Promise(() => {});
        }
        return "MICROTASK_DEADLOOP_OK";
    });
});
