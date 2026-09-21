// Task 8 acceptance: HTTP echo server. Listens on a port, parses HTTP
// requests via httpd, and echoes method+url+body back as JSON. Supports
// keep-alive, chunked responses, forced close, and stale-connection testing.
"use strict";

const PORT = 18860;
let conn_count = 0;

function handle_connection(fd, addr) {
    conn_count++;
    const reader = sockethelper.reader(fd);
    const write_fn = (data) => reader.write(data);

    skynet.fork(async () => {
        try {
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

                if (req.url === "/404") {
                    httpd.write_response(write_fn, 404, "Not Found");
                    continue;
                }

                if (req.url === "/close") {
                    httpd.write_response(write_fn, 200, echo,
                        { "Connection": "close" });
                    break;
                }

                // stale-connection test: respond normally (no Connection: close)
                // then break the loop so the socket closes server-side
                if (req.url === "/stale_close") {
                    httpd.write_response(write_fn, 200, echo);
                    break;
                }

                if (req.url === "/chunked") {
                    const data = "chunk1|chunk2|chunk3";
                    const parts = data.split("|");
                    let idx = 0;
                    httpd.write_response(write_fn, 200, () => {
                        if (idx >= parts.length) return null;
                        return parts[idx++];
                    });
                    continue;
                }

                // default: echo with keep-alive
                httpd.write_response(write_fn, 200, echo);
            }
        } catch (e) {
            // socket closed or other error
        }
        try { socket.close(fd); } catch (_) { /* ignore */ }
    });
}

skynet.start(() => {
    socket.listen("127.0.0.1", PORT, handle_connection);
    console.log("HTTP_ECHO listening on " + PORT);

    skynet.dispatch("text", (msg) => {
        if (msg === "ping") return String(PORT);
        if (msg === "conn_count") return String(conn_count);
        return "";
    });
});
