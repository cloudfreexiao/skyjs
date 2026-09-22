// skyjs socket helper: buffered reader layer (Task 5).
// Bridges the callback-based socket model (js/socket.js) to Promise-based
// exact-length reads. Used by higher-level protocols (HTTP, WebSocket, TLS)
// that need to consume exact byte counts or line-delimited frames from a
// stream.
//
// Loaded by snjs after socket.js (env key "js_sockethelper", default
// "./js/sockethelper.js"). Provides globalThis.sockethelper with:
//   - socket_error sentinel (=== comparison for socket errors vs logic errors)
//   - BufferedReader class (exact-length read / readline with CRLF)
//   - connect(host, port, timeout) -> Promise<fd>
//   - writefunc(fd) -> (data) => void
(function () {
    "use strict";

    const CR = 0x0D;
    const LF = 0x0A;

    // sentinel object: callers use === to distinguish socket-layer failures
    // from application-level errors (never instanceof, never string compare)
    const socket_error = Object.create(null);

    // ---------------------------------------------------------------- helpers

    const text_decoder = new TextDecoder("utf-8");

    /**
     * Concatenate an array of ArrayBuffers into one.
     */
    function concat_buffers(chunks, total) {
        const out = new Uint8Array(total);
        let off = 0;
        for (let i = 0; i < chunks.length; i++) {
            const src = new Uint8Array(chunks[i]);
            out.set(src, off);
            off += src.byteLength;
        }
        return out.buffer;
    }

    // --------------------------------------------------------- BufferedReader

    class BufferedReader {
        constructor(fd) {
            this.fd = fd;
            this.chunks = [];       // ArrayBuffer queue
            this.total = 0;         // total buffered bytes
            this.pending = null;    // { resolve, reject, needed, is_line }
            this.closed = false;
            this.error_msg = null;
        }

        // -- callback methods (bound and passed to socket.start) -------------

        _on_data(data) {
            if (!(data instanceof ArrayBuffer) || data.byteLength === 0) return;
            this.chunks.push(data);
            this.total += data.byteLength;
            this._try_resolve();
        }

        _on_close() {
            this.closed = true;
            if (this.pending) {
                const p = this.pending;
                this.pending = null;
                p.reject(socket_error);
            }
        }

        _on_error(msg) {
            this.error_msg = msg;
            this.closed = true;
            if (this.pending) {
                const p = this.pending;
                this.pending = null;
                p.reject(socket_error);
            }
        }

        // -- public read methods --------------------------------------------

        /**
         * Read exactly `n` bytes. Returns a Promise<ArrayBuffer>.
         */
        read(n) {
            if (this.pending) {
                throw new Error("sockethelper: concurrent read not allowed");
            }
            if (n <= 0) {
                return Promise.resolve(new ArrayBuffer(0));
            }
            // fast path: already have enough data
            if (this.total >= n) {
                return Promise.resolve(this._consume(n));
            }
            if (this.closed) {
                return Promise.reject(socket_error);
            }
            return new Promise((resolve, reject) => {
                this.pending = { resolve, reject, needed: n, is_line: false };
            });
        }

        /**
         * Read until CRLF (\r\n). Returns a Promise<string> WITHOUT the \r\n.
         */
        readline() {
            if (this.pending) {
                throw new Error("sockethelper: concurrent read not allowed");
            }
            // scan existing buffer for CRLF
            const pos = this._scan_crlf();
            if (pos >= 0) {
                // consume pos bytes (the line) + 2 bytes (CRLF)
                const line_buf = this._consume(pos + 2);
                // return string without trailing CRLF
                const view = new Uint8Array(line_buf, 0, pos);
                return Promise.resolve(text_decoder.decode(view));
            }
            if (this.closed) {
                return Promise.reject(socket_error);
            }
            return new Promise((resolve, reject) => {
                this.pending = { resolve, reject, needed: 0, is_line: true };
            });
        }

        // -- write (replaceable by TLS upgrade) -----------------------------

        write(data) {
            socket.write(this.fd, data);
        }

        // -- internal methods -----------------------------------------------

        /**
         * Check if the pending promise can be resolved now.
         */
        _try_resolve() {
            if (!this.pending) return;
            if (this.pending.is_line) {
                const pos = this._scan_crlf();
                if (pos >= 0) {
                    const p = this.pending;
                    this.pending = null;
                    const line_buf = this._consume(pos + 2);
                    const view = new Uint8Array(line_buf, 0, pos);
                    p.resolve(text_decoder.decode(view));
                }
            } else {
                if (this.total >= this.pending.needed) {
                    const p = this.pending;
                    this.pending = null;
                    p.resolve(this._consume(p.needed));
                }
            }
        }

        /**
         * Consume exactly `n` bytes from the chunk queue. Returns ArrayBuffer.
         * Handles partial chunk consumption (keeps remainder).
         */
        _consume(n) {
            if (n === 0) return new ArrayBuffer(0);

            // optimisation: if the first chunk has exactly n bytes, return it
            if (this.chunks.length > 0 && this.chunks[0].byteLength === n) {
                const buf = this.chunks.shift();
                this.total -= n;
                return buf;
            }

            const out = new Uint8Array(n);
            let remaining = n;
            let off = 0;
            while (remaining > 0) {
                const chunk = this.chunks[0];
                const avail = chunk.byteLength;
                if (avail <= remaining) {
                    // consume entire chunk
                    out.set(new Uint8Array(chunk), off);
                    off += avail;
                    remaining -= avail;
                    this.chunks.shift();
                } else {
                    // partial chunk: take what we need, keep remainder
                    out.set(new Uint8Array(chunk, 0, remaining), off);
                    this.chunks[0] = chunk.slice(remaining);
                    remaining = 0;
                }
            }
            this.total -= n;
            return out.buffer;
        }

        /**
         * Scan buffered chunks for \r\n (CRLF). Returns the byte offset of
         * the start of the CRLF pair, or -1 if not found.
         */
        _scan_crlf() {
            let offset = 0;
            let prev_byte = -1;
            for (let i = 0; i < this.chunks.length; i++) {
                const view = new Uint8Array(this.chunks[i]);
                for (let j = 0; j < view.length; j++) {
                    if (prev_byte === CR && view[j] === LF) {
                        // found CRLF: the CR is at (offset + j - 1) in global
                        // terms, but we track offset as the position of view[0]
                        // in the global stream
                        return offset + j - 1;
                    }
                    prev_byte = view[j];
                }
                offset += view.length;
            }
            return -1;
        }
    }

    // -------------------------------------------------------- connect helper

    /**
     * Connect to host:port with optional timeout (centiseconds).
     * Returns Promise<fd>.
     */
    function helper_connect(host, port, timeout) {
        return new Promise((resolve, reject) => {
            let settled = false;
            let timer_session = 0;

            const fd = socket.connect(host, port, function on_connect(id) {
                if (settled) return;
                settled = true;
                resolve(id);
            });

            if (fd < 0) {
                settled = true;
                reject(socket_error);
                return;
            }

            // register an error handler so early failures reject the promise
            socket.start(fd,
                null,   // on_data: not needed yet
                function on_close() {
                    if (settled) return;
                    settled = true;
                    reject(socket_error);
                },
                function on_error(_id, msg) {
                    if (settled) return;
                    settled = true;
                    reject(socket_error);
                }
            );

            if (timeout !== undefined && timeout > 0) {
                timer_session = skynet.timeout(timeout, function () {
                    if (settled) return;
                    settled = true;
                    socket.close(fd);
                    reject(socket_error);
                });
            }
        });
    }

    // ------------------------------------------------------- writefunc helper

    /**
     * Returns a write closure that calls socket.write and throws socket_error
     * on failure.
     */
    function helper_writefunc(fd) {
        return function (data) {
            const r = socket.write(fd, data);
            if (r === undefined || r < 0) {
                throw socket_error;
            }
        };
    }

    // ------------------------------------------------------- public interface

    // --------------------------------------------------------- TLS upgrade

    /**
     * Upgrade a BufferedReader to TLS. Replaces the reader's _on_data
     * and write methods to transparently encrypt/decrypt. Drives the
     * TLS handshake to completion before returning.
     *
     * @param {BufferedReader} reader - reader to upgrade (in-place)
     * @param {string} [hostname] - SNI hostname (client mode)
     * @param {boolean} [is_server] - server mode if true
     * @param {string} [certfile] - PEM cert chain (server mode)
     * @param {string} [keyfile] - PEM private key (server mode)
     * @returns {Promise<void>}
     */
    async function tls_upgrade(reader, hostname, is_server, certfile, keyfile, ca_file) {
        const tls = skynetcore.tls;
        if (!tls) throw new Error("TLS requires OpenSSL build (make TLS=openssl)");

        tls.init();  // idempotent
        const ctx = tls.ctx_new(!!is_server);
        if (is_server && certfile && keyfile) {
            tls.ctx_set_cert(ctx, certfile, keyfile);
        }
        if (!is_server) {
            tls.ctx_set_verify(ctx, ca_file || undefined);
        }

        const method = is_server ? "server" : "client";
        const session = tls.newtls(method, ctx, hostname || undefined);

        // Save original pipeline methods
        const orig_on_data = reader._on_data.bind(reader);
        const orig_write = reader.write.bind(reader);

        // Replace write: plaintext → TLS encrypt → raw socket write
        reader.write = function (data) {
            if (typeof data === "string") {
                const enc = new TextEncoder();
                data = enc.encode(data).buffer;
            } else if (!(data instanceof ArrayBuffer)) {
                if (ArrayBuffer.isView(data)) {
                    data = data.buffer.slice(
                        data.byteOffset,
                        data.byteOffset + data.byteLength
                    );
                }
            }
            const encrypted = tls.write(session, data);
            if (encrypted) orig_write(encrypted);
        };

        // Store session for reference
        reader._tls_session = session;
        reader._tls_ctx = ctx;

        // Drive TLS handshake
        // Client sends first (ClientHello)
        const initial = tls.handshake(session);
        if (initial) orig_write(initial);

        // Handshake loop: wait for data, feed to handshake, send responses
        if (!tls.finished(session)) {
            await new Promise((resolve, reject) => {
                // Temporarily intercept _on_data for the handshake phase
                reader._on_data = function (encrypted) {
                    try {
                        const out = tls.handshake(session, encrypted);
                        if (out) orig_write(out);
                        if (tls.finished(session)) {
                            // Handshake complete: install decrypt pipeline
                            reader._on_data = function (enc_data) {
                                const plaintext = tls.read(session, enc_data);
                                if (plaintext && plaintext.byteLength > 0) {
                                    orig_on_data(plaintext);
                                }
                            };
                            // The peer may have coalesced application data
                            // (e.g. the WebSocket upgrade request) into the
                            // same TCP segment as its final handshake record.
                            // Such data is now buffered in the TLS input BIO
                            // but would never trigger another _on_data (the
                            // peer is waiting for our reply). Drain it now so
                            // the awaiting reader sees it, avoiding a deadlock.
                            const leftover = tls.read(session);
                            if (leftover && leftover.byteLength > 0) {
                                orig_on_data(leftover);
                            }
                            resolve();
                        }
                    } catch (e) {
                        reject(e);
                    }
                };
            });
        } else {
            // Handshake already finished (unlikely but handle it)
            reader._on_data = function (enc_data) {
                const plaintext = tls.read(session, enc_data);
                if (plaintext && plaintext.byteLength > 0) {
                    orig_on_data(plaintext);
                }
            };
        }
    }

    // ------------------------------------------------------- public interface

    globalThis.sockethelper = {
        socket_error,
        BufferedReader,
        connect: helper_connect,
        writefunc: helper_writefunc,
        tls_upgrade,

        /**
         * Convenience: create a BufferedReader for `fd`, register socket
         * callbacks with binary mode, and resume the socket.
         */
        reader(fd) {
            const r = new BufferedReader(fd);
            socket.start(fd,
                (data) => r._on_data(data),
                () => r._on_close(),
                (_id, msg) => r._on_error(msg),
                { binary: true }
            );
            socket.resume(fd);
            return r;
        },
    };
})();
