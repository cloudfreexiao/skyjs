// Bench echo target (run_bench.js phase 1, JS side).
// text: echoes the string untouched; lua: unpack + repack so both language
// sides pay the same seri work inside the echo hop (on the Lua side the
// lua-seri unpack happens in skynet.lua's dispatcher and the repack in
// skynet.retpack).
skynet.start(() => {
    skynet.dispatch("text", (msg) => msg);
    skynet.dispatch("lua", (buf) => skynet.pack(...skynet.unpack(buf)));
});
