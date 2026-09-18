// Acceptance: request-driven reconnect (mirrors the stock socketchannel
// connect-once-per-request). With node2 DOWN, each cluster.call must be
// rejected IMMEDIATELY -- a regression to background-retry hangs here and
// times out the scenario; after node2 comes up, a new call reconnects on
// demand and must succeed.
skynet.register("main");
skynet.newservice("skyclusterd");
cluster.init();
cluster.register("main");
cluster.set_nodes({ node2: "127.0.0.1:2529" });
cluster.open(2528);
cluster.register("svc1");
skynetcore.int_command("LAUNCH", "driver .main 300 start 0");

skynet.start(() => {
    skynet.dispatch("text", async (msg) => {
        if (msg !== "start") return "OK";
        // phase 1: peer is down -- both calls fail right away, at least 500ms
        // apart (no retry storm in between, the rejection is immediate)
        try {
            await cluster.call("node2", "svc2", "hello", 1);
            skynetcore.error("CLUSTER FAIL: call1 should have been rejected");
            return "FAIL";
        } catch (e) {
            skynetcore.error("CLUSTER DOWN OK1: " + (e && e.message));
        }
        await skynet.sleep(500);
        try {
            await cluster.call("node2", "svc2", "hello", 2);
            skynetcore.error("CLUSTER FAIL: call2 should have been rejected");
            return "FAIL";
        } catch (e) {
            skynetcore.error("CLUSTER DOWN OK2: " + (e && e.message));
        }
        // phase 2: the runner starts node2 while we wait; every call still
        // makes ONE connect attempt, so keep calling until the peer is up
        for (let i = 0; i < 20; i++) {
            await skynet.sleep(300);
            try {
                const r = await cluster.call("node2", "svc2", "hello", 41);
                skynetcore.error("CLUSTER RESULT: " + JSON.stringify(r.map(v => v instanceof Map ? [...v.entries()] : v)));
                return "CLUSTER_OK";
            } catch (e) { /* peer not listening yet, next call retries */ }
        }
        skynetcore.error("CLUSTER FAIL: reconnect did not succeed");
        return "FAIL";
    });
    skynet.dispatch("lua", (buf) => {
        const vals = skynet.unpack(buf);
        return skynet.pack("svc1:" + vals[0], vals[1] + 1);
    });
});
