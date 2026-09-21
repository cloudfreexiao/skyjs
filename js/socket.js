// skyjs socket bridge (Task 4).
// Loaded by snjs after skynet.js (env key "js_socket", default "./js/socket.js").
// Wraps the skynet socket API (event-driven, one C socket thread) with
// per-connection callbacks. Socket DATA crosses the C boundary as an
// ArrayBuffer (binary-safe); by default on_data receives a decoded UTF-8
// string, or the raw ArrayBuffer when a connection opts into binary mode.
(function () {
    "use strict";

    const DATA = 1, CONNECT = 2, CLOSE = 3, ACCEPT = 4, ERROR = 5;

    const handlers = new Map();   // socket id -> { on_data, on_connect, on_close, on_error, on_accept }

    function dispatch_event(m) {
        const h = handlers.get(m.id);
        if (!h) return;
        switch (m.type) {
            case DATA:
                // C delivers DATA as an ArrayBuffer; decode to a string unless
                // this connection opted into per-connection binary mode
                if (h.on_data) h.on_data(h.binary ? m.data : skynetcore.str(m.data), m.ud);
                break;
            case CONNECT:
                // resume_socket() re-reports OPEN with a status text; only a
                // real connection established (data = host) triggers on_connect
                if (m.data === "transfer" || m.data === "start" || m.data === "binding") return;
                if (h.on_connect) h.on_connect(m.id);
                break;
            case ACCEPT: {
                // m.ud is the new connection id owned by this service
                if (h.on_accept) h.on_accept(m.ud, m.data);
                break;
            }
            case CLOSE:
                handlers.delete(m.id);
                if (h.on_close) h.on_close(m.id);
                break;
            case ERROR:
                handlers.delete(m.id);
                if (h.on_error) h.on_error(m.id, m.data);
                break;
        }
    }

    __snjs_set_socket_handler(dispatch_event);

    const sock = skynetcore.socket;

    globalThis.socket = {
        listen(host, port, on_accept, backlog) {
            const id = sock.listen(String(host), port | 0, backlog || 64);
            if (id >= 0) {
                handlers.set(id, { on_accept });
                // a freshly created listener is in PListen state; start it
                // (emits an OPEN/"start" event which dispatch_event filters out)
                sock.start(id | 0);
            }
            return id;
        },
        /**
         * Initiate a TCP connection.
         * NOTE: Only on_connect is registered at this stage. You MUST call
         * socket.start(id, on_data, on_close, on_error) after connect resolves
         * to receive error/close notifications. If the connection fails before
         * start() is called, the error is silently dropped.
         */
        connect(host, port, on_connect) {
            const id = sock.connect(String(host), port | 0);
            if (id >= 0) handlers.set(id, { on_connect });
            return id;
        },
        // register data callbacks only; does NOT resume the socket. opts.binary
        // delivers on_data payloads as raw ArrayBuffer (default: UTF-8 string).
        start(id, on_data, on_close, on_error, opts) {
            const h = handlers.get(id) || {};
            h.on_data = on_data;
            h.on_close = on_close;
            h.on_error = on_error;
            h.binary = !!(opts && opts.binary);
            handlers.set(id, h);
        },
        // required for accepted connections (PAccept -> Connected)
        resume(id) {
            sock.start(id | 0);
        },
        // data may be a string (UTF-8), an ArrayBuffer, or a typed-array view
        write(id, data) {
            if (data instanceof ArrayBuffer) return sock.send(id | 0, data);
            if (ArrayBuffer.isView(data)) {
                return sock.send(id | 0,
                    data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
            }
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
