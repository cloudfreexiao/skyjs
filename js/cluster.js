// skyjs cluster API (Task 6). Protocol-compatible with the original skynet
// cluster: frames are built by cservice/skyclusterd.so, lua-seri payloads are
// produced/consumed here with skynet.pack/unpack.
//
// Usage:
//   cluster.init()                       locate ".clusterd" (must be launched)
//   cluster.setNodes({ n1: "ip:port" })  declare remote node addresses
//   cluster.open(port)                   accept remote connections
//   cluster.register("name")             publish a local name
//   await cluster.call(node, "@name", ...args)  -> unpacked response values
//   cluster.send(node, "@name", ...args)        one-way
//   await cluster.query(node, "name")    resolve a remote registered name
(function () {
    "use strict";

    const PTYPE_TEXT = 0;
    let clusterd = 0;
    const pending = new Map();   // js_session -> { resolve, reject }

    __snjs_set_cluster_handlers(
        (session, msg) => {
            const p = pending.get(session);
            if (p) {
                pending.delete(session);
                p.resolve(msg);
            }
        },
        (session) => {
            const p = pending.get(session);
            if (p) {
                pending.delete(session);
                p.reject(new Error("cluster.call failed (error response)"));
            }
        }
    );

    function init() {
        clusterd = skynetcore.intcommand("QUERY", ".clusterd");
        if (!clusterd) throw new Error("cluster: .clusterd not found, launch skyclusterd first");
    }

    // send a command line (+ optional binary payload) to skyclusterd
    function rawcmd(line, payloadBytes) {
        const head = new Uint8Array(line.length + 1);
        for (let i = 0; i < line.length; i++) head[i] = line.charCodeAt(i) & 0xff;
        head[line.length] = 10;	// '\n'
        let msg = head;
        if (payloadBytes) {
            msg = new Uint8Array(head.length + payloadBytes.length);
            msg.set(head, 0);
            msg.set(payloadBytes, head.length);
        }
        const s = skynetcore.genid();
        skynetcore.send(clusterd, PTYPE_TEXT, msg.buffer, s);
        return s;
    }

    function addrstr(addr) {
        // numeric handles cross as hex strings; names get the '@' prefix
        if (typeof addr === "number") return addr.toString(16);
        return addr.charCodeAt(0) === 64 ? addr : "@" + addr;
    }

    globalThis.cluster = {
        init,
        setNodes(obj) {
            for (const k in obj) {
                const sep = obj[k].lastIndexOf(":");
                rawcmd("node " + k + " " + obj[k].slice(0, sep) + " " + obj[k].slice(sep + 1));
            }
        },
        open(port) {
            rawcmd("listen " + port);
        },
        register(name) {
            rawcmd("register " + name);
        },
        call(node, addr, ...vals) {
            const payload = new Uint8Array(skynet.pack(...vals));
            const session = rawcmd("req " + node + " " + addrstr(addr), payload);
            return new Promise((resolve, reject) => {
                pending.set(session, {
                    resolve: ab => resolve(skynet.unpack(ab)),
                    reject,
                });
            });
        },
        send(node, addr, ...vals) {
            const payload = new Uint8Array(skynet.pack(...vals));
            rawcmd("push " + node + " " + addrstr(addr), payload);
        },
        query(node, name) {
            const payload = new Uint8Array(skynet.pack(name));
            const session = rawcmd("req " + node + " 0", payload);
            return new Promise((resolve, reject) => {
                pending.set(session, {
                    resolve: ab => resolve(skynet.unpack(ab)[0]),
                    reject,
                });
            });
        },
    };
})();
