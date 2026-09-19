// skyjs async service core (Task 3).
// Loaded by snjs before the user script (env key "js_loader", default "./js/skynet.js").
// The C layer then calls globalThis.dispatch (wrapped by __snjs_wrap) with
// (msg, session, source, type).
//
// Scheduling model (isomorphic to lualib/skynet.lua):
//   skynet.lua                     skynet.js
//   session <-> coroutine map      session <-> {resolve, reject} in pending_calls
//   coroutine.yield()              await (dispatch returns a Promise)
//   wakeup via resume              resolve() on the matching response message
// Every await waits on an external event (response/timer), so the pending-job
// queue always drains before the C dispatch returns the worker thread.
//
// Structure note: like socket.js/cluster.js, everything lives in an IIFE; only
// globalThis.skynet and the __snjs_* C-layer contracts are global.
(function () {
    "use strict";

    const PTYPE_TEXT = 0;
    const PTYPE_RESPONSE = 1;
    const PTYPE_ERROR = 7;
    const PTYPE_LUA = 10;
    const PTYPE_SOCKET = 6;

    const proto = {};                 // id -> { name, id, dispatch }
    const pending_calls = new Map();   // session -> { resolve, reject }
    const pending_timers = new Map();  // session -> fn
    let socket_handler = null;
    let cluster_resp_handler = null;
    let cluster_err_handler = null;

    function register_protocol(p) {
        if (typeof p.id !== "number" || p.id < 0 || p.id > 255) throw new Error("invalid protocol id");
        proto[p.id] = p;
    }

    register_protocol({ name: "text", id: PTYPE_TEXT });
    register_protocol({ name: "lua", id: PTYPE_LUA });

    function find_type(typename) {
        for (const k in proto) {
            if (proto[k].name === typename) return proto[k].id;
        }
        throw new Error("Unknown protocol " + typename);
    }

    function skynet_dispatch(typename, fn) {
        const id = find_type(typename);
        proto[id].dispatch = fn;
    }

    function skynet_call(addr, typename, msg) {
        const type = find_type(typename);
        const session = skynetcore.gen_id();
        // responses cross as raw bytes (binary-safe); text protocols decode here
        const is_binary = (type === PTYPE_LUA);
        return new Promise((resolve, reject) => {
            pending_calls.set(session, {
                resolve: v => resolve(is_binary ? v : (v instanceof ArrayBuffer ? skynetcore.str(v) : v)),
                reject,
            });
            // ArrayBuffer payloads (skynet.pack) cross untouched; everything else
            // is coerced to its string form
            const payload = (msg === undefined || msg === null) ? "" : msg;
            const r = skynetcore.send(addr, type, payload, session);
            if (r < 0) {
                pending_calls.delete(session);
                reject(new Error("skynet.call: send to " + addr + " failed"));
            }
        });
    }

    function skynet_timeout(ti, fn) {
        // ti is in centiseconds (10ms units), same as skynet.lua
        const s = skynetcore.int_command("TIMEOUT", String(ti));
        pending_timers.set(s, fn);
        return s;
    }

    function skynet_sleep(ms) {
        return new Promise(resolve => skynet_timeout(Math.max(1, Math.round(ms / 10)), resolve));
    }

    function skynet_fork(fn) {
        return Promise.resolve().then(fn);
    }

    function skynet_newservice(name, param) {
        return skynetcore.int_command("LAUNCH", param ? (name + " " + param) : name);
    }

    function skynet_self() {
        const r = skynetcore.command("REG");   // ":hex"
        return r ? parseInt(r.slice(1), 16) : 0;
    }

    function skynet_register(name) {
        const self = skynetcore.command("REG");
        skynetcore.command("NAME", "." + name + " " + self);
    }

    // socket events come pre-parsed as {type, id, ud, data} objects (snjs.c);
    // js/socket.js installs the actual handler via __snjs_set_socket_handler.
    globalThis.__snjs_set_socket_handler = function (fn) { socket_handler = fn; };
    // js/cluster.js installs handlers for responses that don't belong to skynet.call
    // (cluster.call bookkeeping): (session, payload) and (session, source)
    globalThis.__snjs_set_cluster_handlers = function (resp, err) {
        cluster_resp_handler = resp;
        cluster_err_handler = err;
    };

    // internal router: the C layer calls this (through __snjs_wrap) for every message
    function internal_dispatch(msg, session, source, type) {
        if (type === PTYPE_SOCKET) {
            if (socket_handler) socket_handler(msg);
            return;
        }
        if (type === PTYPE_RESPONSE) {
            // routing order: skynet.call sessions, then timer sessions, and only
            // as a last resort the cluster bridge (its handler ignores unknown
            // sessions, so putting it first would swallow TIMEOUT replies)
            const p = pending_calls.get(session);
            if (p) {
                pending_calls.delete(session);
                p.resolve(msg);
                return;
            }
            const t = pending_timers.get(session);
            if (t) {
                pending_timers.delete(session);
                t();
                return;
            }
            if (cluster_resp_handler) {
                cluster_resp_handler(session, msg);
            }
            return;
        }
        if (type === PTYPE_ERROR) {
            const p = pending_calls.get(session);
            if (p) {
                pending_calls.delete(session);
                p.reject(new Error("skynet.call: error response from :" + source.toString(16)));
                return;
            }
            if (cluster_err_handler) {
                cluster_err_handler(session, source);
            }
            return;
        }
        const pr = proto[type];
        if (!pr || typeof pr.dispatch !== "function") {
            throw new Error("No dispatch for protocol " + type);
        }
        return pr.dispatch(msg, source, session);
    }

    // C layer wraps globalThis.dispatch with this once, after the user script ran.
    // The wrapper owns response/error sending so handlers can be sync or async
    // uniformly. RESPONSE/ERROR messages are fully handled by internal_dispatch and
    // never produce a reply.
    globalThis.__snjs_wrap = function (ud) {
        return function (msg, session, source, type) {
            let ret;
            try {
                ret = ud(msg, session, source, type);
            } catch (e) {
                skynetcore.error("dispatch error: " + (e && (e.message || e)) + "\n" + (e && e.stack || ""));
                if (session !== 0) skynetcore.error_response(session, source);
                return;
            }
            if (ret && typeof ret.then === "function") {
                return ret.then(
                    v => {
                        if (session !== 0 && type !== PTYPE_RESPONSE && type !== PTYPE_ERROR) {
                            // pass through as-is: string or ArrayBuffer (lua payloads)
                            skynetcore.response(session, source, v === undefined ? "" : v);
                        }
                        return v;
                    },
                    e => {
                        skynetcore.error("dispatch rejected: " + (e && (e.message || e)) + "\n" + (e && e.stack || ""));
                        if (session !== 0 && type !== PTYPE_RESPONSE && type !== PTYPE_ERROR) {
                            skynetcore.error_response(session, source);
                        }
                    }
                );
            }
            if (session !== 0 && type !== PTYPE_RESPONSE && type !== PTYPE_ERROR) {
                skynetcore.response(session, source, ret === undefined ? "" : ret);
            }
            return ret;
        };
    };

    globalThis.dispatch = internal_dispatch;

    // console.* debug surface: every level funnels into the skynet log channel
    // (via skynetcore.error) so output stays unified in the logger, prefixed
    // with the service handle. Non-string values are rendered recursively:
    // Maps as entries, BigInt with a trailing "n", binary as length summaries.
    function to_display(v, depth) {
        if (v === null) return "null";
        if (v === undefined) return "undefined";
        const t = typeof v;
        if (t === "string") return v;
        if (t === "number" || t === "boolean") return String(v);
        if (t === "bigint") return String(v) + "n";
        if (t === "function") return "[function " + (v.name || "anonymous") + "]";
        if (depth > 3) return "...";
        if (v instanceof ArrayBuffer) return "<ArrayBuffer " + v.byteLength + ">";
        if (v instanceof Uint8Array) return "<Uint8Array " + v.length + " [" +
            Array.from(v.slice(0, 16)).map(x => x.toString(16).padStart(2, "0")).join(" ") +
            (v.length > 16 ? " ..." : "") + "]>";
        if (v instanceof Array) {
            return "[" + v.map(x => to_display(x, depth + 1)).join(", ") + "]";
        }
        if (v instanceof Map) {
            return "{ " + Array.from(v.entries()).map(e =>
                to_display(e[0], depth + 1) + ": " + to_display(e[1], depth + 1)).join(", ") + " }";
        }
        if (t === "object") {
            try {
                return "{ " + Object.keys(v).map(k => k + ": " + to_display(v[k], depth + 1)).join(", ") + " }";
            } catch (e) {
                return String(v);
            }
        }
        return String(v);
    }

    function console_line(args) {
        return args.map(a => to_display(a, 0)).join(" ");
    }

    // printf-style formatting, a subset of node's util.format: enabled only
    // when the first argument is a string holding "%"; unknown specifiers and
    // out-of-argument placeholders stay literal, extra arguments are appended
    const FORMAT_SPECS = "sdifjo%";
    function format_line(args) {
        if (typeof args[0] !== "string" || args[0].indexOf("%") < 0) {
            return console_line(args);
        }
        const fmt = args[0];
        const rest = args.slice(1);
        let ri = 0;
        let out = "";
        for (let i = 0; i < fmt.length; i++) {
            const ch = fmt[i];
            if (ch !== "%" || i + 1 >= fmt.length || FORMAT_SPECS.indexOf(fmt[i + 1]) < 0) {
                out += ch;
                continue;
            }
            const spec = fmt[i + 1];
            i += 1;
            if (spec === "%") { out += "%"; continue; }
            if (ri >= rest.length) { out += "%" + spec; continue; }
            const v = rest[ri++];
            if (spec === "s") {
                out += (typeof v === "string") ? v : to_display(v, 0);
            } else if (spec === "d" || spec === "i") {
                const n = (typeof v === "bigint") ? v : parseInt(v, 10);
                out += String(n);
            } else if (spec === "f") {
                out += String(parseFloat(v));
            } else if (spec === "j") {
                try { out += JSON.stringify(v); } catch (e) { out += "[unserializable]"; }
            } else {  // %o / %O
                out += to_display(v, 0);
            }
        }
        while (ri < rest.length) {
            out += " " + to_display(rest[ri++], 0);
        }
        return out;
    }

    // console.time family: wall-clock via Date.now(), purely observational --
    // nothing here ever suspends a dispatch, so the worker-thread guarantee
    // of the scheduling model is untouched
    const time_labels = new Map();
    const time_label = (label) => (label === undefined ? "default" : label);
    function elapsed_line(prefix, label, args) {
        const t0 = time_labels.get(label);
        if (t0 === undefined) {
            return prefix + ": no such label '" + label + "'";
        }
        let line = label + ": " + (Date.now() - t0) + "ms";
        if (args.length) line += " " + console_line(args);
        return line;
    }

    const console_obj = {};
    for (const level of ["log", "info", "debug", "warn", "error", "trace"]) {
        console_obj[level] = function (...args) { skynetcore.error(format_line(args)); };
    }
    // standard console API names (web/node surface), like console.log itself
    console_obj.time = function (label) {
        time_labels.set(time_label(label), Date.now());
    };
    console_obj.timeLog = function (label, ...args) {
        const k = time_label(label);
        skynetcore.error(elapsed_line("console.timeLog", k, args));
    };
    console_obj.timeEnd = function (label, ...args) {
        const k = time_label(label);
        skynetcore.error(elapsed_line("console.timeEnd", k, args));
        time_labels.delete(k);
    };
    globalThis.console = console_obj;

    globalThis.skynet = {
        PTYPE_TEXT, PTYPE_RESPONSE, PTYPE_ERROR, PTYPE_LUA,
        start: function (start_func) { start_func(); },
        dispatch: skynet_dispatch,
        register_protocol,
        call: skynet_call,
        timeout: skynet_timeout,
        sleep: skynet_sleep,
        fork: skynet_fork,
        newservice: skynet_newservice,
        self: skynet_self,
        register: skynet_register,
        now: function () { return skynetcore.now(); },
        mem_stat: function () { return skynetcore.mem(); },
        pack: function (...args) { return skynetcore.pack(...args); },
        unpack: function (buf) { return skynetcore.unpack(buf); },
        exit: function () { skynetcore.command("EXIT"); },
    };
})();
