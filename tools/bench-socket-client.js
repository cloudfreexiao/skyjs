"use strict";
// tools/bench-socket-client.js -- shared load client for run-bench.js
// phase 3 (identical against both server sides, so only the server framework
// differs). Opens K connections, each pipelining SIZE-byte ASCII frames
// ('x'*size + '\n'); the server echoes raw bytes, and a response is counted
// for every (size+1) bytes received (TCP ordering makes that exact).
//
// Usage: node tools/bench-socket-client.js --host 127.0.0.1 --port 2601
//        --size 1024 --total 20000 --conc 4
// Output: "BENCH case=sock_<size> n=<N> mps=<v> mbps=<v>" + BENCH_SUITE_DONE
// (parsed by tools/run-bench.js; the client's own hrtime is the authority).

const net = require("net");

function parseArgs(argv) {
    const o = { host: "127.0.0.1", port: 2601, size: 1024, total: 20000, conc: 4 };
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === "--host") o.host = argv[++i];
        else if (argv[i] === "--port") o.port = parseInt(argv[++i], 10);
        else if (argv[i] === "--size") o.size = parseInt(argv[++i], 10);
        else if (argv[i] === "--total") o.total = parseInt(argv[++i], 10);
        else if (argv[i] === "--conc") o.conc = parseInt(argv[++i], 10);
    }
    return o;
}

// one connection: send nreq frames with at most `cap` in flight, count echoes
function runConn(host, port, frame, nreq, cap) {
    return new Promise((resolve, reject) => {
        const sock = net.connect(port, host);
        const expect = frame.length;
        let sent = 0;
        let recv = 0;
        let done = 0;
        const pump = () => {
            while (sent < nreq && sent - done < cap) {
                sock.write(frame);
                sent++;
            }
        };
        sock.on("error", reject);
        sock.on("connect", pump);
        sock.on("data", (chunk) => {
            recv += chunk.length;
            done = Math.floor(recv / expect);
            if (done >= nreq) {
                // destroy (not end): a half-closed socket would keep this
                // process alive waiting for the server's FIN
                sock.destroy();
                resolve(done);
                return;
            }
            pump();
        });
    });
}

async function main() {
    const o = parseArgs(process.argv.slice(2));
    const frame = Buffer.alloc(o.size + 1);
    frame.fill(120);            // 'x'
    frame[o.size] = 10;         // '\n'
    const per = Math.floor(o.total / o.conc);
    const t0 = process.hrtime.bigint();
    const jobs = [];
    for (let i = 0; i < o.conc; i++) {
        jobs.push(runConn(o.host, o.port, frame, per, 256));
    }
    const counts = await Promise.all(jobs);
    const wallMs = Number(process.hrtime.bigint() - t0) / 1e6;
    const done = counts.reduce((a, b) => a + b, 0);
    const mps = wallMs > 0 ? Math.round(done * 1000 / wallMs) : 0;
    const mbps = wallMs > 0 ? (done * (o.size + 1) / (wallMs / 1000) / 1e6) : 0;
    process.stdout.write("BENCH case=sock_" + o.size + " n=" + done +
        " mps=" + mps + " mbps=" + mbps.toFixed(1) + "\n");
    process.stdout.write("BENCH_SUITE_DONE\n");
    process.exit(0);   // sockets are destroyed above; belt and suspenders
}

main().catch(e => {
    process.stdout.write("BENCH_FAIL: client " + (e && (e.message || e)) + "\n");
    process.exit(1);
});
