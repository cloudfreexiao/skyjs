// TLS acceptance: HTTPS + WSS echo server. Listens on two ports:
// HTTPS (server-side TLS upgrade + HTTP echo) and WSS (websocket.accept
// with TLS). Responds to "text" protocol for port discovery and conn_count.
"use strict";

const HTTPS_PORT = 18870;
const WSS_PORT = 18871;
let conn_count = 0;

// ---- HTTPS handler (mirrors http_server.js with TLS upgrade) ----

function handle_https(fd, addr) {
    conn_count++;
    const reader = sockethelper.reader(fd);

    skynet.fork(async () => {
        try {
            await sockethelper.tls_upgrade(reader, null, true,
                "test/certs/server.pem", "test/certs/server.key");

            const write_fn = (data) => reader.write(data);

            while (true) {
                const req = await httpd.read_request(reader);
                if (req.code !== 200) {
                    httpd.write_response(write_fn, req.code, "Bad request");
                    break;
                }

                const echo = JSON.stringify({
                    method: req.method,
                    url: req.url,
                    body: req.body,
                    body_len: req.body ? req.body.length : 0,
                });

                // default: echo with keep-alive
                httpd.write_response(write_fn, 200, echo);
            }
        } catch (e) {
            // socket closed or TLS error
        }
        try { socket.close(fd); } catch (_) { /* ignore */ }
    });
}

// ---- WSS handler (mirrors ws_server.js echo with TLS) ----

const wss_handler = {
    message(id, data, opcode) {
        if (opcode === "text") {
            const text = new TextDecoder().decode(new Uint8Array(data));
            if (text === "close_me") {
                websocket.close(id, 1000, "server_close");
                return;
            }
        }
        // echo back with same opcode
        websocket.write(id, data, opcode);
    },
    close(id, code, reason) {
        // normal close — nothing to do
    },
};

skynet.start(() => {
    socket.listen("127.0.0.1", HTTPS_PORT, handle_https);
    console.log("TLS_HTTPS listening on " + HTTPS_PORT);

    socket.listen("127.0.0.1", WSS_PORT, (fd, addr) => {
        skynet.fork(async () => {
            await websocket.accept(fd, wss_handler, "wss", addr, {
                tls: {
                    certfile: "test/certs/server.pem",
                    keyfile: "test/certs/server.key",
                },
            });
        });
    });
    console.log("TLS_WSS listening on " + WSS_PORT);

    skynet.dispatch("text", (msg) => {
        if (msg === "ping_https") return String(HTTPS_PORT);
        if (msg === "ping_wss") return String(WSS_PORT);
        if (msg === "conn_count") return String(conn_count);
        return "";
    });
});
