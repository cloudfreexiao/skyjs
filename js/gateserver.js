// skyjs gateserver runtime lib. Port of 3rd/skynet/lualib/snax/gateserver.lua:
// a TCP gate front-end that frames traffic with the C netpack buffer (2-byte
// big-endian length prefix) and dispatches per-connection events to a handler.
//
// Loaded by snjs after cluster.js (env key "js_gateserver", default
// "./js/gateserver.js"). A gate service calls gateserver.start(handler), which
// switches the service into netpack mode (skynetcore.socket.netpack_mode) and
// installs the socket event handler; the C worker_cb then routes PTYPE_SOCKET
// DATA through the frame buffer and delivers {np, event, id, ud, data} objects.
//
// Design note (mirrors gateserver.lua): an accepted connection is registered on
// the "open" (ACCEPT) event but NOT read from until gateserver.openclient(fd)
// -- the gate forwards the fd to an agent/watchdog first, then opens it.
(function () {
    "use strict";

    const sock = skynetcore.socket;
    const netpack = skynetcore.netpack;

    let listen_socket = 0;
    let maxclient = 1024;
    let client_number = 0;
    let use_nodelay = false;
    let user_handler = null;

    // fd -> true (connected) / false (read-closed); nil (deleted) once gone
    const connection = new Map();

    function dispatch_msg(fd, msg) {
        if (connection.get(fd)) {
            user_handler.message(fd, msg);
        } else {
            skynetcore.error("gateserver drop message from fd " + fd);
        }
    }

    // the single socket handler installed via __snjs_set_socket_handler; every
    // event carries m.np === true and a string m.event naming the MSG kind
    function on_socket(m) {
        switch (m.event) {
            case "data":
                dispatch_msg(m.id, m.data);
                break;
            case "more": {
                let p = netpack.pop();
                while (p) {
                    dispatch_msg(p.fd, p.data);
                    p = netpack.pop();
                }
                break;
            }
            case "open":
                // ACCEPT: m.id is the newly accepted connection fd
                client_number += 1;
                if (client_number >= maxclient) {
                    sock.shutdown(m.id);
                    return;
                }
                if (use_nodelay) sock.nodelay(m.id);
                connection.set(m.id, true);
                user_handler.connect(m.id, m.data);
                break;
            case "close":
                if (m.id !== listen_socket) {
                    client_number -= 1;
                    if (connection.has(m.id)) connection.set(m.id, false);
                    if (user_handler.disconnect) user_handler.disconnect(m.id);
                } else {
                    listen_socket = 0;
                }
                break;
            case "error":
                if (m.id === listen_socket) {
                    skynetcore.error("gateserver accept error: " + m.data);
                } else {
                    sock.shutdown(m.id);
                    if (user_handler.error) user_handler.error(m.id, m.data);
                }
                break;
            case "warning":
                if (user_handler.warning) user_handler.warning(m.id, m.ud);
                break;
            case "init":
                // listen socket bind confirmation; nothing to do
                break;
        }
    }

    globalThis.gateserver = {
        // start reading an accepted connection (after forward/accept)
        openclient(fd) {
            if (connection.get(fd)) sock.start(fd | 0);
        },
        closeclient(fd) {
            if (connection.has(fd)) {
                connection.delete(fd);
                sock.close(fd | 0);
            }
        },
        // create and start the listen socket; returns the listen fd
        open(host, port, backlog, max_client, nodelay) {
            maxclient = max_client || 1024;
            use_nodelay = !!nodelay;
            listen_socket = sock.listen(String(host || "0.0.0.0"), port | 0, backlog || 64);
            skynetcore.error("gateserver listen port " + port + " -> id " + listen_socket);
            if (listen_socket >= 0) sock.start(listen_socket | 0);
            return listen_socket;
        },
        close() {
            if (listen_socket) sock.close(listen_socket | 0);
        },
        // install handler + switch this service into netpack mode
        start(handler) {
            if (!handler || typeof handler.message !== "function" ||
                typeof handler.connect !== "function") {
                throw new Error("gateserver.start: handler.message and handler.connect are required");
            }
            user_handler = handler;
            sock.netpack_mode();
            __snjs_set_socket_handler(on_socket);
        },
    };
})();
