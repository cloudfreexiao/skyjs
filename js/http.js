// skyjs HTTP server + client with Keep-Alive connection pool (Task 6).
// Loaded by snjs after sockethelper.js (env key "js_http", default
// "./js/http.js"). Provides globalThis.httpd (server), globalThis.httpc
// (client), and globalThis.http_internal (internal parsing functions
// exported for websocket.js to reuse).
//
// Ported from 3rd/skynet/lualib/http/{internal,httpd,httpc,url}.lua.
// Builds entirely on BufferedReader (js/sockethelper.js): readline() for
// header lines, read(n) for exact-length body reads.
(function () {
    "use strict";

    const LIMIT = 8192;
    const text_decoder = new TextDecoder("utf-8");
    const text_encoder = new TextEncoder();

    // -------------------------------------------------- internal helpers

    function ab_to_str(buf) {
        return text_decoder.decode(new Uint8Array(buf));
    }

    // --------------------------------------------- internal HTTP parsing
    // Exported via globalThis.http_internal for websocket.js to reuse.

    /**
     * Read HTTP header lines from reader until the empty line (end of
     * headers). Returns { lines: string[], ok: boolean }. Enforces an
     * 8192-byte header size limit (matching original LIMIT).
     */
    async function recv_header(reader) {
        const lines = [];
        let total = 0;
        while (true) {
            const line = await reader.readline();
            total += line.length + 2;   // +2 for the consumed CRLF
            if (total > LIMIT) {
                return { lines, ok: false };
            }
            if (line === "") {
                break;
            }
            lines.push(line);
        }
        return { lines, ok: true };
    }

    /**
     * Parse "Name: Value" header lines starting at index `from`.
     * Header names are lowercased. TAB/space continuation lines are
     * appended. Duplicate headers are merged into arrays. Returns the
     * header object, or null on malformed input.
     */
    function parse_header(lines, from, header) {
        if (!header) header = {};
        let name = null;
        for (let i = from; i < lines.length; i++) {
            const line = lines[i];
            const ch = line.charCodeAt(0);
            if (ch === 9 || ch === 32) {
                // line folding (TAB or SPACE continuation)
                if (name === null) return null;
                header[name] = header[name] + line.substring(1);
            } else {
                const colon = line.indexOf(":");
                if (colon < 0) return null;
                name = line.substring(0, colon).toLowerCase();
                const value = line.substring(colon + 1).trimStart();
                if (header[name] !== undefined) {
                    const old = header[name];
                    if (Array.isArray(old)) {
                        old.push(value);
                    } else {
                        header[name] = [old, value];
                    }
                } else {
                    header[name] = value;
                }
            }
        }
        return header;
    }

    /**
     * Read a chunked transfer-encoding body. Loops reading hex chunk-size
     * lines -> chunk data -> trailing CRLF -> repeat until size 0. Parses
     * trailer headers. Enforces bodylimit. Returns { body, header } or
     * null on error.
     */
    async function recv_chunked_body(reader, bodylimit, header) {
        const parts = [];
        let size = 0;
        while (true) {
            const size_line = await reader.readline();
            // chunk-size may have extensions after semicolon; ignore them
            const semi = size_line.indexOf(";");
            const sz_str = semi >= 0 ? size_line.substring(0, semi) : size_line;
            const sz = parseInt(sz_str, 16);
            if (isNaN(sz)) return null;
            if (sz === 0) break;
            size += sz;
            if (bodylimit && size > bodylimit) return null;
            const chunk_buf = await reader.read(sz);
            parts.push(ab_to_str(chunk_buf));
            // consume trailing CRLF after chunk data
            await reader.read(2);
        }
        // parse trailer headers (after the last 0-sized chunk)
        const trailer = await recv_header(reader);
        if (trailer.ok && trailer.lines.length > 0) {
            header = parse_header(trailer.lines, 0, header || {});
        }
        return { body: parts.join(""), header: header };
    }

    /**
     * Read body based on content-length / status code / transfer-encoding.
     * For responses with no content-length and no chunked encoding (e.g.
     * HTTP/1.0 close-delimited), attempts to read until socket close.
     */
    async function recv_body(reader, code, header) {
        const length_str = header["content-length"];
        let length = null;
        if (length_str !== undefined) {
            length = parseInt(length_str, 10);
            if (isNaN(length)) length = null;
        }
        if (length !== null) {
            if (length === 0) return "";
            const buf = await reader.read(length);
            return ab_to_str(buf);
        } else if (code === 204 || code === 304 || code < 200) {
            return "";
        } else {
            // no content-length: read until connection close (HTTP/1.0
            // style). drain any buffered data, then keep reading until
            // socket_error (close).
            const parts = [];
            // drain already-buffered bytes
            if (reader.total > 0) {
                const buf = await reader.read(reader.total);
                parts.push(ab_to_str(buf));
            }
            // read more until the socket closes
            try {
                while (!reader.closed) {
                    const line = await reader.readline();
                    parts.push(line);
                    parts.push("\r\n");
                }
            } catch (e) {
                if (e !== sockethelper.socket_error) throw e;
                // socket closed: drain remaining buffered data
                if (reader.total > 0) {
                    try {
                        const remaining = reader._consume(reader.total);
                        parts.push(ab_to_str(remaining));
                    } catch (_) {
                        // ignore
                    }
                }
            }
            return parts.join("");
        }
    }

    // ---------------------------------------------- HTTP status code table

    const http_status_msg = {
        100: "Continue",
        101: "Switching Protocols",
        200: "OK",
        201: "Created",
        202: "Accepted",
        203: "Non-Authoritative Information",
        204: "No Content",
        205: "Reset Content",
        206: "Partial Content",
        300: "Multiple Choices",
        301: "Moved Permanently",
        302: "Found",
        303: "See Other",
        304: "Not Modified",
        305: "Use Proxy",
        307: "Temporary Redirect",
        400: "Bad Request",
        401: "Unauthorized",
        402: "Payment Required",
        403: "Forbidden",
        404: "Not Found",
        405: "Method Not Allowed",
        406: "Not Acceptable",
        407: "Proxy Authentication Required",
        408: "Request Time-out",
        409: "Conflict",
        410: "Gone",
        411: "Length Required",
        412: "Precondition Failed",
        413: "Request Entity Too Large",
        414: "Request-URI Too Large",
        415: "Unsupported Media Type",
        416: "Requested range not satisfiable",
        417: "Expectation Failed",
        500: "Internal Server Error",
        501: "Not Implemented",
        502: "Bad Gateway",
        503: "Service Unavailable",
        504: "Gateway Time-out",
        505: "HTTP Version not supported",
    };

    // ========================================================== httpd
    //
    // HTTP server: read_request parses an incoming HTTP request from a
    // BufferedReader; write_response sends an HTTP response.

    const httpd_obj = {};

    /**
     * Read and parse an HTTP request from `reader`.
     * Returns { code, url?, method?, header?, body? }.
     * On success code === 200; on error code is the HTTP error status.
     */
    httpd_obj.read_request = async function (reader, bodylimit) {
        try {
            const hdr = await recv_header(reader);
            if (!hdr.ok) return { code: 413 };
            if (hdr.lines.length === 0) return { code: 400 };

            // parse request line: "METHOD URL HTTP/VERSION"
            const request_line = hdr.lines[0];
            const match = request_line.match(
                /^([A-Za-z]+)\s+(.*?)\s+HTTP\/(\d+\.\d+)$/
            );
            if (!match) return { code: 400 };

            const method = match[1];
            const url = match[2];
            const httpver = parseFloat(match[3]);
            if (httpver < 1.0 || httpver > 1.1) return { code: 505 };

            const header = parse_header(hdr.lines, 1, {});
            if (!header) return { code: 400 };

            const mode = header["transfer-encoding"];
            if (mode && mode !== "identity" && mode !== "chunked") {
                return { code: 501 };
            }

            let body = "";
            if (mode === "chunked") {
                const result = await recv_chunked_body(
                    reader, bodylimit, header
                );
                if (!result) return { code: 413 };
                body = result.body;
            } else {
                const length_str = header["content-length"];
                if (length_str !== undefined) {
                    const length = parseInt(length_str, 10);
                    if (bodylimit && length > bodylimit) return { code: 413 };
                    if (length > 0) {
                        const buf = await reader.read(length);
                        body = ab_to_str(buf);
                    }
                }
            }

            return { code: 200, url, method, header, body };
        } catch (e) {
            if (e === sockethelper.socket_error) return { code: 400 };
            return { code: 400 };
        }
    };

    /**
     * Write an HTTP response.
     *   write_fn(data): write function (string or ArrayBuffer)
     *   statuscode: numeric HTTP status
     *   body: string (full body), function (chunked generator), or null
     *   header: object of name→value (value may be array for multi-value)
     * Returns true on success, false on write error.
     */
    httpd_obj.write_response = function (write_fn, statuscode, body, header) {
        try {
            const code_str = String(statuscode);
            const padded = code_str.length < 3
                ? ("000" + code_str).slice(-3)
                : code_str;
            let head = "HTTP/1.1 " + padded + " " +
                (http_status_msg[statuscode] || "") + "\r\n";

            if (header) {
                const keys = Object.keys(header);
                for (let i = 0; i < keys.length; i++) {
                    const k = keys[i];
                    const v = header[k];
                    if (Array.isArray(v)) {
                        for (let j = 0; j < v.length; j++) {
                            head += k + ": " + v[j] + "\r\n";
                        }
                    } else {
                        head += k + ": " + v + "\r\n";
                    }
                }
            }

            if (typeof body === "string") {
                const body_bytes = text_encoder.encode(body);
                head += "content-length: " + body_bytes.byteLength +
                    "\r\n\r\n";
                write_fn(head);
                write_fn(body);
            } else if (typeof body === "function") {
                head += "transfer-encoding: chunked\r\n";
                write_fn(head);
                while (true) {
                    const chunk = body();
                    if (chunk !== null && chunk !== undefined) {
                        if (chunk !== "") {
                            const chunk_bytes = text_encoder.encode(chunk);
                            write_fn("\r\n" +
                                chunk_bytes.byteLength.toString(16) +
                                "\r\n");
                            write_fn(chunk);
                        }
                    } else {
                        write_fn("\r\n0\r\n\r\n");
                        break;
                    }
                }
            } else {
                // null/undefined: headers only, end with blank line
                head += "\r\n";
                write_fn(head);
            }
            return true;
        } catch (e) {
            return false;
        }
    };

    // ========================================================== httpc
    //
    // HTTP client with Keep-Alive connection pool.

    // --------------------------------------------- connection pool

    const conn_pool = new Map();   // key -> [{ fd, reader, expire_time }]
    const MAX_PER_HOST = 8;
    const DEFAULT_KEEPALIVE_SEC = 60;
    let cleanup_timer_started = false;

    function pool_key_str(host, port, protocol) {
        return host + ":" + port + ":" + protocol;
    }

    /**
     * Take a reusable connection from the pool. Validates expiry and
     * closed state. Returns { fd, reader } or null.
     */
    function pool_get(key) {
        const conns = conn_pool.get(key);
        if (!conns) return null;
        while (conns.length > 0) {
            const conn = conns.pop();
            if (!conn.reader.closed && skynet.now() < conn.expire_time) {
                return conn;
            }
            // expired or closed — discard silently
            try { socket.close(conn.fd); } catch (_) { /* ignore */ }
        }
        conn_pool.delete(key);
        return null;
    }

    /**
     * Return a connection to the pool (or close it if not reusable).
     * Checks Connection: close header and parses Keep-Alive timeout.
     */
    function pool_put(key, fd, reader, resp_header) {
        // "Connection: close" means the server will close the connection
        const conn_hdr = resp_header ? resp_header["connection"] : null;
        if (typeof conn_hdr === "string" &&
            conn_hdr.toLowerCase() === "close") {
            try { socket.close(fd); } catch (_) { /* ignore */ }
            return;
        }

        // parse Keep-Alive: timeout=N
        let timeout_sec = DEFAULT_KEEPALIVE_SEC;
        const ka_hdr = resp_header ? resp_header["keep-alive"] : null;
        if (typeof ka_hdr === "string") {
            const m = ka_hdr.match(/timeout\s*=\s*(\d+)/i);
            if (m) timeout_sec = parseInt(m[1], 10);
        }

        // skynet.now() is centiseconds (10ms ticks)
        const expire_time = skynet.now() + timeout_sec * 100;

        let conns = conn_pool.get(key);
        if (!conns) {
            conns = [];
            conn_pool.set(key, conns);
        }

        // cap per-host connections: evict oldest if full
        while (conns.length >= MAX_PER_HOST) {
            const oldest = conns.shift();
            try { socket.close(oldest.fd); } catch (_) { /* ignore */ }
        }

        conns.push({ fd, reader, expire_time });
        ensure_cleanup_timer();
    }

    function ensure_cleanup_timer() {
        if (cleanup_timer_started) return;
        cleanup_timer_started = true;
        schedule_cleanup();
    }

    function schedule_cleanup() {
        // 30 seconds = 3000 centiseconds
        skynet.timeout(3000, function () {
            const now = skynet.now();
            for (const [key, conns] of conn_pool) {
                for (let i = conns.length - 1; i >= 0; i--) {
                    const c = conns[i];
                    if (c.reader.closed || now >= c.expire_time) {
                        try { socket.close(c.fd); } catch (_) { /* ignore */ }
                        conns.splice(i, 1);
                    }
                }
                if (conns.length === 0) conn_pool.delete(key);
            }
            if (conn_pool.size > 0) {
                schedule_cleanup();
            } else {
                cleanup_timer_started = false;
            }
        });
    }

    // --------------------------------------------- URL utilities

    const default_port = { http: 80, https: 443 };

    function parse_host_part(host) {
        const colon1 = host.indexOf(":");
        if (colon1 < 0) {
            return { hostname: host, port: null };
        }
        // more than one colon → IPv6
        if (host.indexOf(":", colon1 + 1) >= 0) {
            const m = host.match(/^\[(.+?)\]:?(\d*)$/);
            if (m) {
                return {
                    hostname: m[1],
                    port: m[2] ? parseInt(m[2], 10) : null,
                };
            }
            throw new Error(
                "Invalid host: bare IPv6 address '" + host +
                "', use '[" + host + "]' instead"
            );
        }
        // single colon → host:port
        const m = host.match(/^(.*?):(\d+)$/);
        if (m) {
            return { hostname: m[1], port: parseInt(m[2], 10) };
        }
        return { hostname: host, port: null };
    }

    /**
     * Parse a full URL like "http://host:port/path" into its components.
     * Returns { protocol, host, port, path, host_header }.
     */
    function client_parse_url(url) {
        let protocol, rest;
        const proto_match = url.match(/^([a-zA-Z]+):\/\/(.*)/);
        if (proto_match) {
            protocol = proto_match[1].toLowerCase();
            rest = proto_match[2];
        } else {
            protocol = "http";
            rest = url;
        }
        const host_header = rest;
        // separate path from host
        const slash = rest.indexOf("/");
        let host_part, path;
        if (slash >= 0) {
            host_part = rest.substring(0, slash);
            path = rest.substring(slash);
        } else {
            host_part = rest;
            path = "/";
        }
        const parsed = parse_host_part(host_part);
        const port = parsed.port || default_port[protocol];
        if (!port) throw new Error("Invalid protocol: " + protocol);
        return {
            protocol,
            host: parsed.hostname,
            port,
            path,
            host_header: host_part,
        };
    }

    function httpc_escape(s) {
        let out = "";
        for (let i = 0; i < s.length; i++) {
            const c = s.charCodeAt(i);
            if ((c >= 65 && c <= 90) ||   // A-Z
                (c >= 97 && c <= 122) ||   // a-z
                (c >= 48 && c <= 57) ||    // 0-9
                c === 95) {                // _
                out += s[i];
            } else {
                // encode each UTF-8 byte as %XX
                const bytes = text_encoder.encode(s[i]);
                for (let j = 0; j < bytes.length; j++) {
                    out += "%" +
                        bytes[j].toString(16).toUpperCase().padStart(2, "0");
                }
            }
        }
        return out;
    }

    function url_decode(str) {
        str = str.replace(/\+/g, " ");
        return str.replace(/%([0-9A-Fa-f]{2})/g, function (_, hex) {
            return String.fromCharCode(parseInt(hex, 16));
        });
    }

    function httpc_url_parse(url) {
        const qmark = url.indexOf("?");
        if (qmark >= 0) {
            return {
                path: url_decode(url.substring(0, qmark)),
                query: url.substring(qmark + 1),
            };
        }
        return { path: url_decode(url), query: "" };
    }

    function httpc_url_parse_query(q) {
        const r = {};
        if (!q) return r;
        const pairs = q.split("&");
        for (let i = 0; i < pairs.length; i++) {
            const eq = pairs[i].indexOf("=");
            if (eq < 0) continue;
            const dk = url_decode(pairs[i].substring(0, eq));
            const dv = url_decode(pairs[i].substring(eq + 1));
            if (r[dk] !== undefined) {
                if (Array.isArray(r[dk])) {
                    r[dk].push(dv);
                } else {
                    r[dk] = [r[dk], dv];
                }
            } else {
                r[dk] = dv;
            }
        }
        return r;
    }

    // --------------------------------------------- client internals

    /**
     * Build the HTTP request header string and optional body. Matches the
     * original internal.request() layout.
     */
    function build_request(method, host_header, url, header, content) {
        let header_content = "";
        if (header) {
            let has_host = false;
            const keys = Object.keys(header);
            for (let i = 0; i < keys.length; i++) {
                const k = keys[i];
                if (k.toLowerCase() === "host") has_host = true;
                const v = header[k];
                if (Array.isArray(v)) {
                    for (let j = 0; j < v.length; j++) {
                        header_content += k + ":" + v[j] + "\r\n";
                    }
                } else {
                    header_content += k + ":" + v + "\r\n";
                }
            }
            if (!has_host) {
                header_content = "Host:" + host_header + "\r\n" +
                    header_content;
            }
        } else {
            header_content = "Host:" + host_header + "\r\n";
        }

        let request_head;
        if (content !== undefined && content !== null && content !== "") {
            if (header &&
                header["transfer-encoding"] === "chunked") {
                request_head = method + " " + url + " HTTP/1.1\r\n" +
                    header_content + "\r\n";
            } else {
                const content_bytes = (typeof content === "string")
                    ? text_encoder.encode(content)
                    : content;
                request_head = method + " " + url + " HTTP/1.1\r\n" +
                    header_content +
                    "Content-length:" + content_bytes.byteLength +
                    "\r\n\r\n";
            }
        } else {
            request_head = method + " " + url + " HTTP/1.1\r\n" +
                header_content + "Content-length:0\r\n\r\n";
        }
        return request_head;
    }

    /**
     * Perform an HTTP request over an existing reader. Returns
     * { status, body, header } or throws on error.
     */
    async function do_request_on(reader, method, host_header, url,
        recv_header_out, header, content) {
        // send request
        const request_head = build_request(
            method, host_header, url, header, content
        );
        reader.write(request_head);
        if (content !== undefined && content !== null && content !== "") {
            reader.write(content);
        }

        // receive response headers
        const hdr = await recv_header(reader);
        if (!hdr.ok || hdr.lines.length === 0) {
            throw new Error("Recv header failed");
        }

        // parse status line "HTTP/x.x CODE INFO"
        const status_line = hdr.lines[0];
        const sm = status_line.match(/HTTP\/[\d.]+\s+(\d+)\s*(.*)/);
        if (!sm) throw new Error("Invalid HTTP status line");
        const status_code = parseInt(sm[1], 10);

        const resp_header = parse_header(
            hdr.lines, 1, recv_header_out || {}
        );
        if (!resp_header) throw new Error("Invalid HTTP response header");

        return { status: status_code, header: resp_header };
    }

    /**
     * Open a new connection (with optional TLS upgrade).
     */
    async function open_connection(parsed, timeout) {
        const fd = await sockethelper.connect(
            parsed.host, parsed.port, timeout
        );
        const reader = sockethelper.reader(fd);

        if (parsed.protocol === "https") {
            if (typeof sockethelper.tls_upgrade !== "function") {
                socket.close(fd);
                throw new Error("HTTPS requires OpenSSL build");
            }
            await sockethelper.tls_upgrade(reader, parsed.host_header);
        }

        return { fd, reader };
    }

    // --------------------------------------------- httpc public API

    const httpc_obj = {
        timeout: null,   // global timeout in skynet ticks (centiseconds)
    };

    /**
     * Full HTTP request. Returns Promise<{ status, body, header }>.
     * Supports connection pooling with retry-on-stale.
     */
    httpc_obj.request = async function (method, hostname, url,
        recv_header_out, header, content) {
        const parsed = client_parse_url(hostname);
        const key = pool_key_str(parsed.host, parsed.port, parsed.protocol);
        const timeout = httpc_obj.timeout || undefined;

        let fd, reader, from_pool = false;
        const pooled = pool_get(key);
        if (pooled) {
            fd = pooled.fd;
            reader = pooled.reader;
            from_pool = true;
        }

        // retry-on-stale: if pooled connection fails on first write,
        // open a fresh one and retry (max 1 retry)
        for (let attempt = 0; attempt < 2; attempt++) {
            if (!from_pool || attempt > 0) {
                const conn = await open_connection(parsed, timeout);
                fd = conn.fd;
                reader = conn.reader;
                from_pool = false;
            }

            try {
                const result = await do_request_on(
                    reader, method, parsed.host_header, url,
                    recv_header_out, header, content
                );

                // read body
                const mode = result.header["transfer-encoding"];
                let body;
                if (method === "HEAD") {
                    body = "";
                } else if (mode && mode !== "identity" &&
                    mode === "chunked") {
                    const chunked = await recv_chunked_body(
                        reader, null, result.header
                    );
                    if (!chunked) throw new Error("Invalid response body");
                    body = chunked.body;
                } else {
                    body = await recv_body(
                        reader, result.status, result.header
                    );
                }

                // keep-alive decision
                const has_content_length =
                    result.header["content-length"] !== undefined;
                const is_chunked = mode === "chunked";
                const can_pool = has_content_length || is_chunked ||
                    result.status === 204 || result.status === 304 ||
                    result.status < 200 || method === "HEAD";

                if (can_pool) {
                    pool_put(key, fd, reader, result.header);
                } else {
                    try { socket.close(fd); } catch (_) { /* ignore */ }
                }

                return {
                    status: result.status,
                    body: body,
                    header: result.header,
                };
            } catch (e) {
                // stale pooled connection: retry once with a fresh one
                if (from_pool && attempt === 0) {
                    try { socket.close(fd); } catch (_) { /* ignore */ }
                    from_pool = false;
                    continue;
                }
                // real failure: close and rethrow
                try { socket.close(fd); } catch (_) { /* ignore */ }
                throw e;
            }
        }
    };

    /**
     * HTTP GET shorthand.
     */
    httpc_obj.get = async function (hostname, url, recv_header_out, header) {
        const r = await httpc_obj.request(
            "GET", hostname, url, recv_header_out, header
        );
        return { status: r.status, body: r.body };
    };

    /**
     * HTTP POST with form-encoded body.
     */
    httpc_obj.post = async function (hostname, url, form, recv_header_out) {
        const hdr = {
            "content-type": "application/x-www-form-urlencoded",
        };
        const parts = [];
        const keys = Object.keys(form);
        for (let i = 0; i < keys.length; i++) {
            parts.push(
                httpc_escape(keys[i]) + "=" + httpc_escape(String(form[keys[i]]))
            );
        }
        const body = parts.join("&");
        const r = await httpc_obj.request(
            "POST", hostname, url, recv_header_out, hdr, body
        );
        return { status: r.status, body: r.body };
    };

    /**
     * HTTP HEAD — returns only the status code.
     */
    httpc_obj.head = async function (hostname, url, recv_header_out,
        header) {
        const parsed = client_parse_url(hostname);
        const key = pool_key_str(parsed.host, parsed.port, parsed.protocol);
        const timeout = httpc_obj.timeout || undefined;

        let fd, reader;
        const pooled = pool_get(key);
        if (pooled) {
            fd = pooled.fd;
            reader = pooled.reader;
        } else {
            const conn = await open_connection(parsed, timeout);
            fd = conn.fd;
            reader = conn.reader;
        }

        try {
            const result = await do_request_on(
                reader, "HEAD", parsed.host_header, url,
                recv_header_out, header
            );
            pool_put(key, fd, reader, result.header);
            return result.status;
        } catch (e) {
            try { socket.close(fd); } catch (_) { /* ignore */ }
            throw e;
        }
    };

    /**
     * Streaming HTTP request. Returns a stream object with read() method.
     */
    httpc_obj.request_stream = async function (method, hostname, url,
        recv_header_out, header, content) {
        const parsed = client_parse_url(hostname);
        const timeout = httpc_obj.timeout || undefined;

        const conn = await open_connection(parsed, timeout);
        const fd = conn.fd;
        const reader = conn.reader;

        try {
            const result = await do_request_on(
                reader, method, parsed.host_header, url,
                recv_header_out, header, content
            );

            const mode = result.header["transfer-encoding"];
            const is_chunked = mode === "chunked";
            const length_str = result.header["content-length"];
            let remaining = length_str !== undefined
                ? parseInt(length_str, 10)
                : null;
            const status = result.status;

            // build stream object
            const stream = {
                status: status,
                header: result.header,
                connected: true,
                _closed: false,

                /** Read next chunk. Returns string or null when done. */
                read: async function () {
                    if (stream._closed) return null;
                    if (is_chunked) {
                        const size_line = await reader.readline();
                        const semi = size_line.indexOf(";");
                        const sz_str = semi >= 0
                            ? size_line.substring(0, semi)
                            : size_line;
                        const sz = parseInt(sz_str, 16);
                        if (isNaN(sz) || sz === 0) {
                            // last chunk: parse trailers
                            const trailer = await recv_header(reader);
                            if (trailer.ok && trailer.lines.length > 0) {
                                parse_header(
                                    trailer.lines, 0, stream.header
                                );
                            }
                            stream._closed = true;
                            stream.connected = false;
                            return null;
                        }
                        const buf = await reader.read(sz);
                        await reader.read(2);   // trailing CRLF
                        return ab_to_str(buf);
                    } else if (remaining !== null) {
                        if (remaining <= 0) {
                            stream._closed = true;
                            stream.connected = false;
                            return null;
                        }
                        const to_read = Math.min(remaining, 8192);
                        const buf = await reader.read(to_read);
                        remaining -= to_read;
                        return ab_to_str(buf);
                    } else {
                        // read-all mode: one shot
                        stream._closed = true;
                        stream.connected = false;
                        return null;
                    }
                },

                close: function () {
                    if (!stream._closed) {
                        stream._closed = true;
                        stream.connected = false;
                        try { socket.close(fd); } catch (_) { /* ignore */ }
                    }
                },
            };

            return stream;
        } catch (e) {
            try { socket.close(fd); } catch (_) { /* ignore */ }
            throw e;
        }
    };

    httpc_obj.escape = httpc_escape;
    httpc_obj.url_parse = httpc_url_parse;
    httpc_obj.url_parse_query = httpc_url_parse_query;
    httpc_obj.parse_url = function (url) {
        const p = client_parse_url(url);
        return {
            protocol: p.protocol,
            host: p.host,
            port: p.port,
            path: p.path,
        };
    };

    httpc_obj.close_all_keepalive = function () {
        for (const [_key, conns] of conn_pool) {
            for (let i = 0; i < conns.length; i++) {
                try { socket.close(conns[i].fd); } catch (_) { /* ignore */ }
            }
        }
        conn_pool.clear();
    };

    // ---------------------------------------- export to globalThis

    globalThis.httpd = httpd_obj;
    globalThis.httpc = httpc_obj;

    // Internal parsing functions exported for websocket.js to reuse.
    // websocket.js needs recv_header and parse_header to handle the HTTP
    // upgrade handshake. Access via globalThis.http_internal.
    globalThis.http_internal = {
        recv_header,
        parse_header,
        recv_chunked_body,
        recv_body,
        http_status_msg,
    };
})();
