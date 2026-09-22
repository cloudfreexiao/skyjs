// HTTPS + WSS multi-user chat demo.
// Single port serves both static HTML (HTTP GET) and WebSocket upgrade.
// Usage: ./skyjs examples/chat/config.json
"use strict";

const HTTP_PORT = 8080;
const HTTPS_PORT = 8443;
const CERT_FILE = "test/certs/server.pem";
const KEY_FILE = "test/certs/server.key";

// --------------- global client state ---------------

const clients = new Map();   // fd -> { name, fd }
let next_id = 1;

const history = [];          // recent chat messages (msg-type broadcast objects)
const HISTORY_LIMIT = 50;

function format_time() {
    const d = new Date();
    const h = String(d.getHours()).padStart(2, "0");
    const m = String(d.getMinutes()).padStart(2, "0");
    const s = String(d.getSeconds()).padStart(2, "0");
    return h + ":" + m + ":" + s;
}

function broadcast(msg) {
    const json = JSON.stringify(msg);
    for (const [_, client] of clients) {
        try { websocket.write(client.fd, json); } catch (_e) { /* ignore */ }
    }
}

function broadcast_online() {
    const names = [];
    for (const [_, c] of clients) { names.push(c.name); }
    broadcast({ type: "online", count: names.length, names: names });
}

function on_disconnect(fd) {
    const client = clients.get(fd);
    if (client) {
        clients.delete(fd);
        broadcast({ type: "leave", name: client.name });
        broadcast_online();
    }
}

// --------------- websocket handler factory ---------------

function make_handler(fd) {
    let logged_in = false;

    return {
        connect: function (_id) {
            // connection established, waiting for login message
        },
        message: function (_id, data, _opcode) {
            const text = new TextDecoder().decode(new Uint8Array(data));
            let msg;
            try { msg = JSON.parse(text); } catch (_e) { return; }

            if (!logged_in) {
                if (msg.type === "login" && msg.name) {
                    const name = String(msg.name).trim();
                    if (!name) return;
                    for (const [_, c] of clients) {
                        if (c.name === name) {
                            websocket.write(fd, JSON.stringify({
                                type: "error",
                                text: "\u6635\u79f0 \"" + name + "\" \u5df2\u88ab\u4f7f\u7528",
                            }));
                            return;
                        }
                    }
                    logged_in = true;
                    clients.set(fd, { name: name, fd: fd });

                    // replay chat history to the new user only
                    for (let i = 0; i < history.length; i++) {
                        try { websocket.write(fd, JSON.stringify(history[i])); } catch (_e) { /* ignore */ }
                    }
                    if (history.length > 0) {
                        try { websocket.write(fd, JSON.stringify({ type: "history_end" })); } catch (_e) { /* ignore */ }
                    }

                    broadcast({ type: "join", name: name });
                    broadcast_online();
                }
                return;
            }

            if (msg.type === "msg" && msg.text) {
                const client = clients.get(fd);
                if (!client) return;
                const chat_msg = {
                    type: "msg",
                    name: client.name,
                    text: String(msg.text),
                    time: format_time(),
                };
                history.push(chat_msg);
                if (history.length > HISTORY_LIMIT) {
                    history.shift();
                }
                broadcast(chat_msg);
            }
        },
        close: function (_id, _code, _reason) {
            on_disconnect(fd);
        },
        error: function (_id, _err) {
            on_disconnect(fd);
        },
    };
}

// --------------- connection handler ---------------

function handle_connection(fd, addr, use_tls) {
    skynet.fork(async () => {
        const reader = sockethelper.reader(fd);
        try {
            if (use_tls) {
                await sockethelper.tls_upgrade(reader, null, true, CERT_FILE, KEY_FILE);
            }

            const req = await httpd.read_request(reader);
            if (req.code !== 200) {
                const wf = (d) => reader.write(d);
                httpd.write_response(wf, req.code, "Bad Request");
                socket.close(fd);
                return;
            }

            const upgrade = req.header["upgrade"];
            if (upgrade && upgrade.toLowerCase() === "websocket") {
                await websocket.accept(fd, make_handler(fd), "ws", addr, {
                    upgrade: { header: req.header, method: req.method, url: req.url },
                    reader: reader,
                });
            } else {
                const wf = (d) => reader.write(d);
                httpd.write_response(wf, 200, html_content, {
                    "Content-Type": "text/html; charset=utf-8",
                });
                socket.close(fd);
            }
        } catch (_e) {
            on_disconnect(fd);
            try { socket.close(fd); } catch (_e2) { /* ignore */ }
        }
    });
}

// --------------- html loader ---------------

let html_content = "";

function load_html() {
    try {
        html_content = io.read_text_file("examples/chat/chat.html");
        console.log("chat: loaded chat.html (" + html_content.length + " bytes)");
    } catch (e) {
        skynetcore.error("chat: failed to read examples/chat/chat.html: " + (e && (e.message || e)));
        html_content = "<!doctype html><meta charset=\"utf-8\"><title>error</title>" +
            "<h1>chat.html not found</h1>" +
            "<p>Run skyjs from the repository root directory.</p>";
    }
}

// --------------- start ---------------

skynet.start(() => {
    load_html();

    socket.listen("0.0.0.0", HTTP_PORT, (fd, addr) => handle_connection(fd, addr, false));
    console.log("Chat HTTP  listening on http://0.0.0.0:" + HTTP_PORT + "/");

    if (skynetcore.tls) {
        socket.listen("0.0.0.0", HTTPS_PORT, (fd, addr) => handle_connection(fd, addr, true));
        console.log("Chat HTTPS listening on https://0.0.0.0:" + HTTPS_PORT + "/");
    } else {
        console.log("TLS not available (build with make TLS=openssl for HTTPS)");
    }
});
