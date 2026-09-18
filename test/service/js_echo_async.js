// Task 7 benchmark target: minimal async echo service.
skynet.start(() => {
    skynet.dispatch("text", async (msg) => "E:" + msg);
});
