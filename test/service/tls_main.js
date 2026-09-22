// TLS acceptance: client test orchestration. Starts the TLS echo server,
// runs HTTPS + WSS client tests, prints TLS <scenario> OK / TLS FAIL markers.
"use strict";

let fail_count = 0;

function check(label, ok, detail) {
    if (ok) {
        console.log("TLS " + label + " OK");
    } else {
        console.log("TLS FAIL " + label + (detail ? ": " + detail : ""));
        fail_count++;
    }
}

skynet.start(() => {
    skynet.dispatch("text", (msg) => msg);
});

skynet.timeout(1, async () => {
    // TLS availability check
    if (!skynetcore.tls) {
        console.log("TLS SKIP (OpenSSL not available)");
        console.log("TLS ALL OK");
        return;
    }

    const server = skynet.newservice("snjs test/service/tls_server.js");
    const https_port = await skynet.call(server, "text", "ping_https");
    const wss_port = await skynet.call(server, "text", "ping_wss");
    const base = "https://127.0.0.1:" + https_port;
    const wss_url = "wss://127.0.0.1:" + wss_port;
    const tls_opts = { ca_file: "test/certs/ca.pem" };

    try {
        // ==== HTTPS tests ====

        // GET 200
        {
            const r = await httpc.get(base, "/echo", {}, null, tls_opts);
            const p = JSON.parse(r.body);
            check("https_get", r.status === 200 && p.method === "GET" && p.url === "/echo",
                "status=" + r.status + " body=" + r.body);
        }

        // POST binary
        {
            const r = await httpc.request("POST", base, "/echo", {},
                { "content-type": "application/octet-stream" }, "tls_payload", tls_opts);
            const p = JSON.parse(r.body);
            check("https_post", r.status === 200 && p.body === "tls_payload",
                "body=" + p.body);
        }

        // Keep-alive reuse (3 GETs on 1 TCP connection)
        {
            httpc.close_all_keepalive();
            const before = parseInt(await skynet.call(server, "text", "conn_count"), 10);
            console.error("TLS keepalive: baseline conn_count=" + before);
            console.error("TLS keepalive req1 sending");
            await httpc.get(base, "/echo", {}, null, tls_opts);
            console.error("TLS keepalive resp1 OK");
            console.error("TLS keepalive req2 sending");
            await httpc.get(base, "/echo", {}, null, tls_opts);
            console.error("TLS keepalive resp2 OK");
            console.error("TLS keepalive req3 sending");
            await httpc.get(base, "/echo", {}, null, tls_opts);
            console.error("TLS keepalive resp3 OK");
            const after = parseInt(await skynet.call(server, "text", "conn_count"), 10);
            console.error("TLS keepalive: final conn_count=" + after);
            check("https_keepalive", after - before === 1,
                "conn_delta=" + (after - before) + " expected=1");
        }

        // ==== WSS tests ====
        const decoder = new TextDecoder();
        function decode(ab) { return decoder.decode(new Uint8Array(ab)); }

        // Text echo
        {
            const id = await websocket.connect(wss_url, null, null, tls_opts);
            websocket.write(id, "hello wss");
            const r = await websocket.read(id);
            check("wss_text", !r.close && r.type === "text" &&
                decode(r.data) === "hello wss",
                "got " + (r.close ? "close" : decode(r.data)));
            websocket.close(id, 1000);
        }

        // Binary echo
        {
            const id = await websocket.connect(wss_url, null, null, tls_opts);
            const bin = new Uint8Array([1, 2, 3, 0, 255, 128]).buffer;
            const bin_hex = crypt.hex_encode(bin);
            websocket.write(id, bin, "binary");
            const r = await websocket.read(id);
            check("wss_binary", !r.close && r.type === "binary" &&
                crypt.hex_encode(r.data) === bin_hex,
                "type=" + r.type + " hex=" + crypt.hex_encode(r.data));
            websocket.close(id, 1000);
        }

        // Client close
        {
            const id = await websocket.connect(wss_url, null, null, tls_opts);
            websocket.write(id, "before_close");
            const r = await websocket.read(id);
            check("wss_echo_before_close", !r.close && decode(r.data) === "before_close",
                "got " + (r.close ? "close" : decode(r.data)));
            websocket.close(id, 1000, "goodbye");
            check("wss_client_close", websocket.is_close(id), "not closed");
        }

        // Server close
        {
            const id = await websocket.connect(wss_url, null, null, tls_opts);
            websocket.write(id, "close_me");
            const r = await websocket.read(id);
            check("wss_server_close", r.close === true && r.code === 1000,
                "close=" + r.close + " code=" + r.code);
        }

    } catch (e) {
        console.log("TLS FAIL exception: " + (e && (e.message || e)));
        console.log(e && e.stack || "");
        fail_count++;
    }

    httpc.close_all_keepalive();

    if (fail_count === 0) {
        console.log("TLS ALL OK");
    } else {
        console.log("TLS FAIL total=" + fail_count);
    }
});
