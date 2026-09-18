// console.* acceptance: every level maps to the skynet log channel; values
// beyond strings are rendered recursively (Maps as entries, BigInt with "n",
// binary as length/hex summaries). Verify the rendered lines in the log.
console.log("log", 1, 1.5, true, null, undefined, 10n);
console.info("info", [1, 2], new Map([[1, "a"], ["k", 5n]]));
console.warn("warn", { k: "v", nested: { x: 1 } });
console.error("error", new Uint8Array([1, 2, 3]), new ArrayBuffer(4));
console.debug("debug", "tail");
console.trace("trace", function named() {});
skynetcore.error("CONSOLE_OK");
skynet.register("main");

skynet.start(() => {
    skynet.dispatch("text", (msg) => "OK:" + msg);
});
