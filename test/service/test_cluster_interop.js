// Interop acceptance, skyjs side (port 2528). The stock Lua node in
// test/cluster_lua/ finishes its own startup only after a cluster.call INTO
// this node, so it must boot SECOND; conversely its 2530 listener is not up
// when our "start" arrives, so the query polls -- each poll is a single
// connect attempt, matching the stock socketchannel semantics. Assertions
// live in tools/run_interop.js.
skynet.register("main");
skynet.newservice("skyclusterd");
cluster.init();
cluster.register("main");
cluster.set_nodes({ lua: "127.0.0.1:2530" });
cluster.open(2528);
cluster.register("svc1");
skynetcore.int_command("LAUNCH", "driver .main 300 start 0");

skynet.start(() => {
    skynet.dispatch("text", async (msg) => {
        if (msg !== "start") return "OK";
        let lh = 0;
        for (let i = 0; i < 50; i++) {
            try {
                lh = await cluster.query("lua", "main");
                break;
            } catch (e) { await skynet.sleep(200); }    // lua node not up yet
        }
        if (!lh) {
            skynetcore.error("INTEROP FAIL: lua node never resolved");
            return "FAIL";
        }
        skynetcore.error("JS2LUA handle=" + lh);
        try {
            const r = await cluster.call("lua", "@main", "from-js", 33);
            skynetcore.error("JS2LUA RESULT: " + JSON.stringify(r.map(v => v instanceof Map ? [...v.entries()] : v)));
            return "INTEROP_OK";
        } catch (e) {
            skynetcore.error("INTEROP FAIL: " + (e && e.message));
            return "FAIL";
        }
    });
    skynet.dispatch("lua", (buf) => {
        const vals = skynet.unpack(buf);
        return skynet.pack("svc1:" + vals[0], vals[1] + 1);
    });
});
