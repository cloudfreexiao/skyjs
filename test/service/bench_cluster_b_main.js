// run_bench.js phase-2 driver, node B (port 2529): echo + reverse-direction
// runner, started BEFORE node A by the harness. The @bench dispatch echoes
// ordinary payloads and treats the "__ctl_run" control payload as "run your
// direction back into node A, then sign off". Pair-agnostic; lockstep with
// test/bench_lua/cluster_main_b.lua.
skynet.register("main");
skynet.newservice("skyclusterd");
cluster.init();
cluster.register("main");
cluster.set_nodes({ a: "127.0.0.1:2528" });
cluster.open(2529);
cluster.register("bench");

const P100 = "x".repeat(100);
const P40K = "x".repeat(40000);
const CASES = [
    { name: "cl_100", payload: P100, n: 5000, warm: 200 },
    { name: "cl_40k", payload: P40K, n: 1000, warm: 50 },
    // pipelined: conc concurrent callers, mirrored with bench_cluster_a_main.js
    { name: "cl_pipe", payload: P100, n: 5000, warm: 200, conc: 8 },
];

function mark(name) {
    skynetcore.error("BENCH_BEGIN " + name);
}

function unmark(name) {
    skynetcore.error("BENCH_END " + name);
}

function report(name, n, t0) {
    const dt = Date.now() - t0;
    const mps = dt > 0 ? Math.round(n * 1000 / dt) : 0;
    skynetcore.error("BENCH case=" + name + " n=" + n + " mps=" + mps + " ms=" + dt);
}

async function run_case(peer, c) {
    if (!c.conc) {
        for (let i = 0; i < c.n; i++) await cluster.call(peer, "@bench", c.payload);
        return;
    }
    const per = Math.floor(c.n / c.conc);
    const jobs = [];
    for (let w = 0; w < c.conc; w++) {
        jobs.push((async () => {
            for (let i = 0; i < per; i++) await cluster.call(peer, "@bench", c.payload);
        })());
    }
    await Promise.all(jobs);
}

async function run_direction(peer) {
    for (const c of CASES) {
        for (let i = 0; i < c.warm; i++) await cluster.call(peer, "@bench", c.payload);
        mark(c.name);
        const t0 = Date.now();
        await run_case(peer, c);
        unmark(c.name);
        report(c.name, c.n, t0);
    }
}

skynet.start(() => {
    skynet.dispatch("lua", (buf) => {
        const vals = skynet.unpack(buf);
        if (vals[0] === "__ctl_run") {
            // ack only after the reverse direction finished
            return (async () => {
                await run_direction("a");
                skynetcore.error("BENCH_SUITE_DONE");
                return skynet.pack("ctl-done");
            })();
        }
        return skynet.pack(...vals);
    });
    skynetcore.error("BENCH_CLUSTER_READY");
});
