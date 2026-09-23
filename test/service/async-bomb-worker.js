// Task 3 acceptance: a handler that always throws -> PTYPE_ERROR to caller.
skynet.start(() => {
    skynet.dispatch("text", (msg) => {
        throw new Error("bomb exploded: " + msg);
    });
});
