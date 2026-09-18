// skyjs socket bridge (Task 4).
// Loaded by snjs after skynet.js (env key "js_socket", default "./js/socket.js").
// Wraps the skynet socket API (event-driven, one C socket thread) with
// per-connection callbacks. All data crossing this bridge is UTF-8 strings;
// binary will come later via ArrayBuffer-backed messages.
(function () {
    "use strict";

    const DATA = 1, CONNECT = 2, CLOSE = 3, ACCEPT = 4, ERROR = 5;

    const handlers = new Map();   // socket id -> { onData, onConnect, onClose, onError, onAccept }

    function dispatchEvent(m) {
        const h = handlers.get(m.id);
        if (!h) return;
        switch (m.type) {
            case DATA:
                if (h.onData) h.onData(m.data, m.ud);
                break;
            case CONNECT:
                // resume_socket() re-reports OPEN with a status text; only a
                // real connection established (data = host) triggers onConnect
                if (m.data === "transfer" || m.data === "start" || m.data === "binding") return;
                if (h.onConnect) h.onConnect(m.id);
                break;
            case ACCEPT: {
                // m.ud is the new connection id owned by this service
                if (h.onAccept) h.onAccept(m.ud, m.data);
                break;
            }
            case CLOSE:
                handlers.delete(m.id);
                if (h.onClose) h.onClose(m.id);
                break;
            case ERROR:
                handlers.delete(m.id);
                if (h.onError) h.onError(m.id, m.data);
                break;
        }
    }

    __snjs_set_socket_handler(dispatchEvent);

    const sock = skynetcore.socket;

    globalThis.socket = {
        listen(host, port, onAccept, backlog) {
            const id = sock.listen(String(host), port | 0, backlog || 64);
            if (id >= 0) {
                handlers.set(id, { onAccept });
                // a freshly created listener is in PListen state; start it
                // (emits an OPEN/"start" event which dispatchEvent filters out)
                sock.start(id | 0);
            }
            return id;
        },
        connect(host, port, onConnect) {
            const id = sock.connect(String(host), port | 0);
            if (id >= 0) handlers.set(id, { onConnect });
            return id;
        },
        // register data callbacks only; does NOT resume the socket
        start(id, onData, onClose, onError) {
            const h = handlers.get(id) || {};
            h.onData = onData;
            h.onClose = onClose;
            h.onError = onError;
            handlers.set(id, h);
        },
        // required for accepted connections (PAccept -> Connected)
        resume(id) {
            sock.start(id | 0);
        },
        write(id, data) {
            return sock.send(id | 0, String(data));
        },
        close(id) {
            handlers.delete(id);
            sock.close(id | 0);
        },
        shutdown(id) {
            sock.shutdown(id | 0);
        },
    };
})();
