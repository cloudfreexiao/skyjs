// Task 5 acceptance: lua protocol echo. Unpacks a seri payload, mutates one
// number, and packs the response back as ArrayBuffer.
skynet.start(() => {
    skynet.dispatch("lua", (buf) => {
        const vals = skynet.unpack(buf);
        const n = vals[1] + 1;
        return skynet.pack("seri_b_ok", n, vals[2]);
    });
});
