// skyjs WebSocket server + client (Task 7, RFC 6455).
// Loaded by snjs after http.js (env key "js_websocket", default
// "./js/websocket.js"). Provides globalThis.websocket.
//
// Ported from 3rd/skynet/lualib/http/websocket.lua. Reuses
// http_internal.recv_header / parse_header for the HTTP upgrade handshake.
// Frame masking uses crypt.xor_str (C-layer, hot path).
//
// Two usage modes:
//   Handler mode (server): websocket.accept(fd, handler, "ws", addr)
//   Manual mode  (client): websocket.connect("ws://...") → id
(function () {
    "use strict";

    const GLOBAL_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
    const MAX_FRAME_SIZE = 256 * 1024;   // 256 KB

    const text_encoder = new TextEncoder();
    const text_decoder = new TextDecoder("utf-8");

    // ---- opcode tables (name↔value) ----

    const op_code = {
        "frame":  0x00,
        "text":   0x01,
        "binary": 0x02,
        "close":  0x08,
        "ping":   0x09,
        "pong":   0x0A,
    };
    const op_name = {};
    op_name[0x00] = "frame";
    op_name[0x01] = "text";
    op_name[0x02] = "binary";
    op_name[0x08] = "close";
    op_name[0x09] = "ping";
    op_name[0x0A] = "pong";

    // ---- helpers ----

    function to_ab(data) {
        if (data instanceof ArrayBuffer) return data;
        if (typeof data === "string") return text_encoder.encode(data).buffer;
        if (ArrayBuffer.isView(data)) {
            return data.buffer.slice(
                data.byteOffset, data.byteOffset + data.byteLength
            );
        }
        return new ArrayBuffer(0);
    }

    function ab_to_str(buf) {
        return text_decoder.decode(new Uint8Array(buf));
    }

    function concat_ab(chunks, total) {
        const out = new Uint8Array(total);
        let off = 0;
        for (let i = 0; i < chunks.length; i++) {
            const src = new Uint8Array(chunks[i]);
            out.set(src, off);
            off += src.byteLength;
        }
        return out.buffer;
    }

    // ---- per-connection pool ----

    const ws_pool = new Map();   // id → ws object

    function close_websocket(ws) {
        ws_pool.delete(ws.id);
        if (!ws.closed) {
            ws.closed = true;
            try { socket.close(ws.fd); } catch (_) { /* ignore */ }
        }
    }

    function is_ws_closed(id) {
        return !ws_pool.has(id);
    }

    // ---- frame codec (RFC 6455 §5) ----

    /**
     * Write a single WebSocket frame.
     *   write_fn(data): write closure (string or ArrayBuffer)
     *   opcode: "text" | "binary" | "close" | "ping" | "pong"
     *   payload: ArrayBuffer | string | null
     *   masking_key: 4-byte ArrayBuffer (client→server) or null (server→client)
     */
    function write_frame(write_fn, opcode, payload, masking_key) {
        payload = payload ? to_ab(payload) : new ArrayBuffer(0);
        const payload_len = payload.byteLength;
        const op_v = op_code[opcode];
        if (op_v === undefined) {
            throw new Error("websocket: unknown opcode " + opcode);
        }
        const v1 = 0x80 | op_v;   // FIN = 1, no fragmented sends
        const mask_bit = masking_key ? 0x80 : 0x00;

        // calculate header layout
        let len_extra = 0;
        if (payload_len >= 126 && payload_len <= 0xFFFF) {
            len_extra = 2;
        } else if (payload_len > 0xFFFF) {
            len_extra = 8;
        }
        const mask_extra = masking_key ? 4 : 0;
        const hdr_size = 2 + len_extra + mask_extra;

        const hdr = new Uint8Array(hdr_size);
        const dv = new DataView(hdr.buffer);
        hdr[0] = v1;

        let off = 2;
        if (payload_len < 126) {
            hdr[1] = mask_bit | payload_len;
        } else if (payload_len <= 0xFFFF) {
            hdr[1] = mask_bit | 126;
            dv.setUint16(2, payload_len, false);   // big-endian
            off = 4;
        } else {
            hdr[1] = mask_bit | 127;
            dv.setUint32(2,
                Math.floor(payload_len / 0x100000000), false);
            dv.setUint32(6, payload_len >>> 0, false);
            off = 10;
        }

        if (masking_key) {
            const mk = new Uint8Array(to_ab(masking_key));
            hdr[off]     = mk[0];
            hdr[off + 1] = mk[1];
            hdr[off + 2] = mk[2];
            hdr[off + 3] = mk[3];
            // XOR payload with mask key (C-layer xor_str for performance)
            payload = crypt.xor_str(payload, masking_key);
        }

        write_fn(hdr.buffer);
        if (payload_len > 0) {
            write_fn(payload);
        }
    }

    /**
     * Read one WebSocket frame from `reader`.
     * Returns Promise<{ fin, opcode, payload: ArrayBuffer }>.
     */
    async function read_frame(reader, mode) {
        const s = await reader.read(2);
        const v = new Uint8Array(s);
        const fin  = (v[0] & 0x80) !== 0;
        const op   = v[0] & 0x0F;
        const mask = (v[1] & 0x80) !== 0;
        let payload_len = v[1] & 0x7F;

        if (payload_len === 126) {
            const ext = await reader.read(2);
            payload_len = new DataView(ext).getUint16(0, false);
        } else if (payload_len === 127) {
            const ext = await reader.read(8);
            const edv = new DataView(ext);
            payload_len = edv.getUint32(0, false) * 0x100000000 +
                          edv.getUint32(4, false);
        }

        if (mode === "server" && payload_len > MAX_FRAME_SIZE) {
            throw new Error("websocket: payload_len is too large");
        }

        const masking_key = mask ? await reader.read(4) : null;
        let payload = payload_len > 0
            ? await reader.read(payload_len)
            : new ArrayBuffer(0);

        if (masking_key) {
            payload = crypt.xor_str(payload, masking_key);
        }

        const name = op_name[op];
        if (!name) {
            throw new Error(
                "websocket: unknown opcode 0x" + op.toString(16)
            );
        }
        return { fin, opcode: name, payload };
    }

    /** Parse a close frame payload → { code, reason }. */
    function read_close(payload) {
        const len = payload.byteLength;
        if (len >= 2) {
            const dv = new DataView(payload);
            const code = dv.getUint16(0, false);
            const reason = len > 2 ? ab_to_str(payload.slice(2)) : "";
            return { code, reason };
        }
        return { code: undefined, reason: "" };
    }

    // ---- handler dispatch helper ----

    function try_handle(ws, method, a1, a2) {
        const handle = ws.handle;
        if (!handle) return;
        const f = handle[method];
        if (!f) return;
        try {
            if (a2 !== undefined) f(ws.id, a1, a2);
            else if (a1 !== undefined) f(ws.id, a1);
            else f(ws.id);
        } catch (e) {
            if (e === sockethelper.socket_error) throw e;
            skynetcore.error("websocket handler." + method + " error: " + (e && e.stack || e));
        }
    }

    // ---- server handshake (read_handshake) ----

    async function read_handshake(ws, upgrade_ops) {
        let header, method, url;

        if (upgrade_ops) {
            header = upgrade_ops.header;
            method = upgrade_ops.method;
            url = upgrade_ops.url;
        } else {
            const hdr = await http_internal.recv_header(ws.reader);
            if (!hdr.ok) return { code: 413 };
            if (hdr.lines.length === 0) return { code: 400 };

            const request_line = hdr.lines[0];
            const m = request_line.match(
                /^([A-Za-z]+)\s+(.*?)\s+HTTP\/(\d+\.\d+)$/
            );
            if (!m) return { code: 400, reason: "Bad Request" };

            method = m[1];
            url = m[2];
            const httpver = parseFloat(m[3]);

            if (method !== "GET") {
                return { code: 400, reason: "need GET method" };
            }
            if (httpver < 1.1) {
                return { code: 505 };
            }

            header = http_internal.parse_header(hdr.lines, 1, {});
        }

        if (!header) return { code: 400 };

        // Validate required WebSocket headers (RFC 6455 §4.2.1)
        const upgrade = header["upgrade"];
        if (!upgrade || upgrade.toLowerCase() !== "websocket") {
            return { code: 426, reason: "Upgrade Required" };
        }

        if (!header["host"]) {
            return { code: 400, reason: "host Required" };
        }

        const connection = header["connection"];
        if (!connection ||
            connection.toLowerCase().indexOf("upgrade") < 0) {
            return { code: 400, reason: "Connection must Upgrade" };
        }

        const sw_key = header["sec-websocket-key"];
        if (!sw_key) {
            return { code: 400, reason: "Sec-WebSocket-Key Required" };
        }
        const raw_key = crypt.base64_decode(sw_key);
        if (raw_key.byteLength !== 16) {
            return { code: 400, reason: "Sec-WebSocket-Key invalid" };
        }

        const sw_ver = header["sec-websocket-version"];
        if (!sw_ver || sw_ver !== "13") {
            return { code: 400, reason: "Sec-WebSocket-Version must 13" };
        }

        // sub-protocol negotiation (mirror original Lua behavior)
        let sub_pro = "";
        const sw_protocol = header["sec-websocket-protocol"];
        if (sw_protocol) {
            const protocols = sw_protocol.split(/[\s,]+/);
            if (protocols.indexOf("chat") >= 0) {
                sub_pro = "Sec-WebSocket-Protocol: chat\r\n";
            }
        }

        // x-real-ip from reverse proxy (nginx)
        ws.real_ip = header["x-real-ip"] || null;

        // generate Sec-WebSocket-Accept and send 101
        const accept = crypt.base64_encode(
            crypt.sha1(sw_key + GLOBAL_GUID)
        );
        const resp = "HTTP/1.1 101 Switching Protocols\r\n" +
            "Upgrade: websocket\r\n" +
            "Connection: Upgrade\r\n" +
            "Sec-WebSocket-Accept: " + accept + "\r\n" +
            sub_pro +
            "\r\n";
        ws.reader.write(resp);

        return { code: null, header, url };
    }

    // ---- client handshake (write_handshake) ----

    async function write_handshake(ws, host, url, header) {
        // 16-byte random key: two 8-byte crypt.randomkey() concatenated
        const rk1 = crypt.randomkey();
        const rk2 = crypt.randomkey();
        const key_buf = new Uint8Array(16);
        key_buf.set(new Uint8Array(rk1), 0);
        key_buf.set(new Uint8Array(rk2), 8);
        const key = crypt.base64_encode(key_buf.buffer);

        const req_hdr = {
            "Upgrade": "websocket",
            "Connection": "Upgrade",
            "Sec-WebSocket-Version": "13",
            "Sec-WebSocket-Key": key,
        };
        if (header) {
            const keys = Object.keys(header);
            for (let i = 0; i < keys.length; i++) {
                req_hdr[keys[i]] = header[keys[i]];
            }
        }

        // build HTTP GET request
        let req = "GET " + url + " HTTP/1.1\r\n";
        req += "Host: " + host + "\r\n";
        const hkeys = Object.keys(req_hdr);
        for (let i = 0; i < hkeys.length; i++) {
            req += hkeys[i] + ": " + req_hdr[hkeys[i]] + "\r\n";
        }
        req += "\r\n";
        ws.reader.write(req);

        // read 101 response
        const hdr = await http_internal.recv_header(ws.reader);
        if (!hdr.ok || hdr.lines.length === 0) {
            throw new Error("websocket handshake: recv header failed");
        }

        const sm = hdr.lines[0].match(/HTTP\/[\d.]+\s+(\d+)\s*(.*)/);
        if (!sm) {
            throw new Error("websocket handshake: invalid status line");
        }
        const code = parseInt(sm[1], 10);
        if (code !== 101) {
            throw new Error(
                "websocket handshake error: code[" + code +
                "] info:" + sm[2]
            );
        }

        const recv_hdr = http_internal.parse_header(hdr.lines, 1, {});
        if (!recv_hdr) {
            throw new Error(
                "websocket handshake: invalid response header"
            );
        }

        if (!recv_hdr["upgrade"] ||
            recv_hdr["upgrade"].toLowerCase() !== "websocket") {
            throw new Error(
                "websocket handshake: upgrade must websocket"
            );
        }

        if (!recv_hdr["connection"] ||
            recv_hdr["connection"].toLowerCase() !== "upgrade") {
            throw new Error(
                "websocket handshake: connection must upgrade"
            );
        }

        const sw_accept = recv_hdr["sec-websocket-accept"];
        if (!sw_accept) {
            throw new Error(
                "websocket handshake: need Sec-WebSocket-Accept"
            );
        }

        const expected = crypt.base64_encode(
            crypt.sha1(key + GLOBAL_GUID)
        );
        if (sw_accept !== expected) {
            throw new Error(
                "websocket handshake: invalid Sec-WebSocket-Accept"
            );
        }
    }

    // ---- server accept message loop ----

    async function resolve_accept(ws, options) {
        try_handle(ws, "connect");

        const hs = await read_handshake(
            ws, options && options.upgrade
        );
        if (hs.code !== null) {
            // handshake failed: send HTTP error response
            const wf = function (d) { ws.reader.write(d); };
            httpd.write_response(wf, hs.code, hs.reason || "");
            try_handle(ws, "close");
            return;
        }

        try_handle(ws, "handshake", hs.header, hs.url);

        // fragment reassembly state
        const recv_buf = [];
        let recv_count = 0;
        let first_op = null;

        while (true) {
            if (is_ws_closed(ws.id)) {
                try_handle(ws, "close");
                return;
            }

            const frame = await read_frame(ws.reader, ws.mode);

            if (frame.opcode === "close") {
                const ci = read_close(frame.payload);
                // echo close frame back
                write_frame(
                    function (d) { ws.reader.write(d); }, "close"
                );
                try_handle(ws, "close", ci.code, ci.reason);
                return;
            }

            if (frame.opcode === "ping") {
                write_frame(
                    function (d) { ws.reader.write(d); },
                    "pong", frame.payload
                );
                try_handle(ws, "ping");
                continue;
            }

            if (frame.opcode === "pong") {
                try_handle(ws, "pong");
                continue;
            }

            // data frame (text / binary / continuation)
            if (frame.fin && recv_buf.length === 0) {
                // single-frame message
                try_handle(ws, "message", frame.payload, frame.opcode);
            } else {
                // fragmented message: accumulate
                recv_buf.push(frame.payload);
                recv_count += frame.payload.byteLength;
                if (recv_count > MAX_FRAME_SIZE) {
                    throw new Error(
                        "websocket: payload_len is too large"
                    );
                }
                if (!first_op) first_op = frame.opcode;
                if (frame.fin) {
                    const full = concat_ab(recv_buf, recv_count);
                    try_handle(ws, "message", full, first_op);
                    recv_buf.length = 0;
                    recv_count = 0;
                    first_op = null;
                }
            }
        }
    }

    // ---- URL parsing ----

    function parse_ws_url(url) {
        const m = url.match(/^(wss?):\/\/([^/]+)(.*)?$/);
        if (!m) throw new Error("websocket: invalid URL " + url);
        const protocol = m[1];
        const host = m[2];
        let uri = m[3] || "/";
        if (uri === "") uri = "/";

        const hm = host.match(/^([^:]+):?(\d*)$/);
        if (!hm) throw new Error("websocket: invalid host " + host);
        const host_addr = hm[1];
        let host_port = hm[2] ? parseInt(hm[2], 10) : 0;
        if (!host_port) {
            host_port = protocol === "ws" ? 80 : 443;
        }

        // hostname for TLS SNI (only if not a bare IP address)
        let hostname = null;
        if (!/\d+$/.test(host_addr)) {
            hostname = host_addr;
        }

        return {
            protocol, host, host_addr, host_port, hostname, uri,
        };
    }

    // ========================================== public API

    const ws_api = {};

    /**
     * Server entry: accept a WebSocket connection on `fd`.
     *   handler: { connect?, handshake?, message, ping?, pong?,
     *              close?, error?, warning? }
     *   protocol: "ws" (default) | "wss"
     *   options.upgrade: { header, method, url } to skip HTTP parsing
     *   options.reader: existing BufferedReader to reuse
     * Returns Promise<boolean>.
     */
    ws_api.accept = async function (fd, handler, protocol, addr,
        options) {
        protocol = protocol || "ws";

        // reuse caller's reader if provided (e.g. HTTP server upgrade),
        // otherwise create a fresh one
        let reader;
        if (options && options.reader) {
            reader = options.reader;
        } else {
            reader = sockethelper.reader(fd);
        }

        if (protocol === "wss") {
            if (!skynetcore.tls) {
                socket.close(fd);
                throw new Error(
                    "WSS requires OpenSSL build (make TLS=openssl)"
                );
            }
            const tls_opts = (options && options.tls) || {};
            if (!tls_opts.certfile || !tls_opts.keyfile) {
                socket.close(fd);
                throw new Error(
                    "WSS server requires options.tls.certfile and options.tls.keyfile"
                );
            }
            await sockethelper.tls_upgrade(
                reader, null, true, tls_opts.certfile, tls_opts.keyfile
            );
        }

        const ws = {
            id: fd, fd: fd, reader: reader,
            mode: "server", handle: handler,
            addr: addr || "", real_ip: null, closed: false,
        };
        ws_pool.set(fd, ws);

        try {
            await resolve_accept(ws, options);
        } catch (e) {
            const closed = is_ws_closed(fd);
            if (!closed) {
                close_websocket(ws);
            }
            if (e === sockethelper.socket_error) {
                if (closed) {
                    try_handle(ws, "close");
                } else {
                    try_handle(ws, "error", e);
                }
            } else {
                return false;
            }
            return true;
        }

        if (!is_ws_closed(fd)) {
            close_websocket(ws);
        }
        return true;
    };

    /**
     * Client entry: connect to a WebSocket server.
     *   url: "ws://host:port/path" or "wss://..."
     *   header: extra headers object (optional)
     *   timeout: connect timeout in centiseconds (optional)
     * Returns Promise<id> (the fd).
     */
    ws_api.connect = async function (url, header, timeout, options) {
        const parsed = parse_ws_url(url);

        const fd = await sockethelper.connect(
            parsed.host_addr, parsed.host_port, timeout
        );
        const reader = sockethelper.reader(fd);

        if (parsed.protocol === "wss") {
            if (!skynetcore.tls) {
                socket.close(fd);
                throw new Error(
                    "WSS requires OpenSSL build (make TLS=openssl)"
                );
            }
            const ca = (options && options.ca_file) || undefined;
            await sockethelper.tls_upgrade(
                reader, parsed.hostname, false, null, null, ca
            );
        }

        const ws = {
            id: fd, fd: fd, reader: reader,
            mode: "client", handle: null,
            addr: parsed.host, real_ip: null, closed: false,
        };
        ws_pool.set(fd, ws);

        try {
            await write_handshake(
                ws, parsed.host, parsed.uri, header
            );
        } catch (e) {
            close_websocket(ws);
            throw e;
        }

        return fd;
    };

    /**
     * Manual read: read one complete message (auto ping/pong,
     * fragment reassembly).
     * Returns { data: ArrayBuffer, type: "text"|"binary", close: false }
     *      or { data: null, close: true, code, reason }.
     */
    ws_api.read = async function (id) {
        const ws = ws_pool.get(id);
        if (!ws) throw new Error("websocket: invalid id " + id);

        const recv_buf = [];
        let recv_count = 0;
        let first_op = null;

        while (true) {
            const frame = await read_frame(ws.reader, ws.mode);

            if (frame.opcode === "close") {
                close_websocket(ws);
                const ci = read_close(frame.payload);
                return {
                    data: null, close: true,
                    code: ci.code, reason: ci.reason,
                };
            }

            if (frame.opcode === "ping") {
                // auto-respond with pong (masking for client only)
                const mk = ws.mode === "client"
                    ? crypt.random_bytes(4) : null;
                write_frame(
                    function (d) { ws.reader.write(d); },
                    "pong", frame.payload, mk
                );
                continue;
            }

            if (frame.opcode === "pong") {
                continue;   // ignore, read next frame
            }

            // data frame (text / binary / continuation)
            if (frame.fin && recv_buf.length === 0) {
                return {
                    data: frame.payload, type: frame.opcode,
                    close: false,
                };
            }

            recv_buf.push(frame.payload);
            recv_count += frame.payload.byteLength;
            if (recv_count > MAX_FRAME_SIZE) {
                throw new Error("websocket: payload_len is too large");
            }
            if (!first_op) first_op = frame.opcode;
            if (frame.fin) {
                const full = concat_ab(recv_buf, recv_count);
                return {
                    data: full, type: first_op, close: false,
                };
            }
        }
    };

    /**
     * Send a WebSocket frame.
     *   fmt: "text" (default) | "binary"
     *   data: string | ArrayBuffer
     * Client frames are automatically masked (RFC 6455 §5.3).
     */
    ws_api.write = function (id, data, fmt) {
        const ws = ws_pool.get(id);
        if (!ws) throw new Error("websocket: invalid id " + id);
        fmt = fmt || "text";
        if (fmt !== "text" && fmt !== "binary") {
            throw new Error(
                "websocket: fmt must be 'text' or 'binary'"
            );
        }
        const payload = to_ab(data);
        const mk = ws.mode === "client"
            ? crypt.random_bytes(4) : null;
        write_frame(
            function (d) { ws.reader.write(d); }, fmt, payload, mk
        );
    };

    /** Send a ping frame. */
    ws_api.ping = function (id) {
        const ws = ws_pool.get(id);
        if (!ws) throw new Error("websocket: invalid id " + id);
        const mk = ws.mode === "client"
            ? crypt.random_bytes(4) : null;
        write_frame(
            function (d) { ws.reader.write(d); }, "ping", null, mk
        );
    };

    /** Send a close frame and close the connection. */
    ws_api.close = function (id, code, reason) {
        const ws = ws_pool.get(id);
        if (!ws) return;
        try {
            reason = reason || "";
            let payload = null;
            if (code !== undefined && code !== null) {
                const reason_bytes = text_encoder.encode(reason);
                const buf = new ArrayBuffer(
                    2 + reason_bytes.byteLength
                );
                new DataView(buf).setUint16(0, code, false);
                new Uint8Array(buf).set(reason_bytes, 2);
                payload = buf;
            }
            const mk = ws.mode === "client"
                ? crypt.random_bytes(4) : null;
            write_frame(
                function (d) { ws.reader.write(d); },
                "close", payload, mk
            );
        } catch (_) {
            // ignore write errors during close
        }
        close_websocket(ws);
    };

    /** Return connection address info. */
    ws_api.addrinfo = function (id) {
        const ws = ws_pool.get(id);
        return ws ? ws.addr : "";
    };

    /** Return x-real-ip header value (from reverse proxy). */
    ws_api.real_ip = function (id) {
        const ws = ws_pool.get(id);
        return ws ? (ws.real_ip || "") : "";
    };

    /** Check if connection is closed. */
    ws_api.is_close = function (id) {
        return is_ws_closed(id);
    };

    globalThis.websocket = ws_api;
})();
