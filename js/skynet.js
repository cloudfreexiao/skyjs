// skyjs async service core (Task 3).
// Loaded by snjs before the user script (env key "js_loader", default "./js/skynet.js").
// The C layer then calls globalThis.dispatch (wrapped by __snjs_wrap) with
// (msg, session, source, type).
//
// Scheduling model (isomorphic to lualib/skynet.lua):
//   skynet.lua                     skynet.js
//   session <-> coroutine map      session <-> {resolve, reject} in pendingCalls
//   coroutine.yield()              await (dispatch returns a Promise)
//   wakeup via resume              resolve() on the matching response message
// Every await waits on an external event (response/timer), so the pending-job
// queue always drains before the C dispatch returns the worker thread.

"use strict";

const PTYPE_TEXT = 0;
const PTYPE_RESPONSE = 1;
const PTYPE_ERROR = 7;
const PTYPE_LUA = 10;
const PTYPE_SOCKET = 6;

const proto = {};                 // id -> { name, id, dispatch }
const pendingCalls = new Map();   // session -> { resolve, reject }
const pendingTimers = new Map();  // session -> fn
let socketHandler = null;
let clusterRespHandler = null;
let clusterErrHandler = null;

function register_protocol(p) {
    if (typeof p.id !== "number" || p.id < 0 || p.id > 255) throw new Error("invalid protocol id");
    proto[p.id] = p;
}

register_protocol({ name: "text", id: PTYPE_TEXT });
register_protocol({ name: "lua", id: PTYPE_LUA });

function findType(typename) {
    for (const k in proto) {
        if (proto[k].name === typename) return proto[k].id;
    }
    throw new Error("Unknown protocol " + typename);
}

function skynet_dispatch(typename, fn) {
    const id = findType(typename);
    proto[id].dispatch = fn;
}

function skynet_call(addr, typename, msg) {
    const type = findType(typename);
    const session = skynetcore.genid();
    // responses cross as raw bytes (binary-safe); text protocols decode here
    const isBinary = (type === PTYPE_LUA);
    return new Promise((resolve, reject) => {
        pendingCalls.set(session, {
            resolve: v => resolve(isBinary ? v : (v instanceof ArrayBuffer ? skynetcore.str(v) : v)),
            reject,
        });
        // ArrayBuffer payloads (skynet.pack) cross untouched; everything else
        // is coerced to its string form
        const payload = (msg === undefined || msg === null) ? "" : msg;
        const r = skynetcore.send(addr, type, payload, session);
        if (r < 0) {
            pendingCalls.delete(session);
            reject(new Error("skynet.call: send to " + addr + " failed"));
        }
    });
}

function skynet_timeout(ti, fn) {
    // ti is in centiseconds (10ms units), same as skynet.lua
    const s = skynetcore.intcommand("TIMEOUT", String(ti));
    pendingTimers.set(s, fn);
    return s;
}

function skynet_sleep(ms) {
    return new Promise(resolve => skynet_timeout(Math.max(1, Math.round(ms / 10)), resolve));
}

function skynet_fork(fn) {
    return Promise.resolve().then(fn);
}

function skynet_newservice(name, param) {
    return skynetcore.intcommand("LAUNCH", param ? (name + " " + param) : name);
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
globalThis.__snjs_set_socket_handler = function (fn) { socketHandler = fn; };
// js/cluster.js installs handlers for responses that don't belong to skynet.call
// (cluster.call bookkeeping): (session, payload) and (session, source)
globalThis.__snjs_set_cluster_handlers = function (resp, err) {
    clusterRespHandler = resp;
    clusterErrHandler = err;
};

// internal router: the C layer calls this (through __snjs_wrap) for every message
function internalDispatch(msg, session, source, type) {
    if (type === PTYPE_SOCKET) {
        if (socketHandler) socketHandler(msg);
        return;
    }
    if (type === PTYPE_RESPONSE) {
        const p = pendingCalls.get(session);
        if (p) {
            pendingCalls.delete(session);
            p.resolve(msg);
            return;
        }
        if (clusterRespHandler) {
            clusterRespHandler(session, msg);
            return;
        }
        const t = pendingTimers.get(session);
        if (t) {
            pendingTimers.delete(session);
            t();
        }
        return;
    }
    if (type === PTYPE_ERROR) {
        const p = pendingCalls.get(session);
        if (p) {
            pendingCalls.delete(session);
            p.reject(new Error("skynet.call: error response from :" + source.toString(16)));
            return;
        }
        if (clusterErrHandler) {
            clusterErrHandler(session, source);
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
// uniformly. RESPONSE/ERROR messages are fully handled by internalDispatch and
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

globalThis.dispatch = internalDispatch;

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
    memstat: function () { return skynetcore.mem(); },
    pack: function (...args) { return skynetcore.pack(...args); },
    unpack: function (buf) { return skynetcore.unpack(buf); },
    exit: function () { skynetcore.command("EXIT"); },
};
