// skyjs async IO service (Phase C).
// A dedicated skynet service that executes synchronous io.* calls on behalf
// of callers, turning blocking file I/O into non-blocking skynet.call RPCs.
//
// Protocol: PTYPE_LUA (seri pack/unpack).
//   Request:  skynet.pack(op, arg1, arg2, ...)
//   Response: skynet.pack(true, result)   -- success
//             skynet.pack(false, errmsg)  -- failure
//
// Binary data (read_file result, write_file/append_file input) is transported
// as base64 strings because js-seri does not support ArrayBuffer round-trip.
// stat() returns a JSON string; readdir() returns a JSON string (array).

skynet.start(() => {
    skynet.dispatch("lua", (msg) => {
        const args = skynet.unpack(msg);
        const op = args[0];
        try {
            switch (op) {
            case "read_file": {
                const ab = io.read_file(args[1]);
                return skynet.pack(true, crypt.base64_encode(ab));
            }
            case "read_text_file": {
                const text = io.read_text_file(args[1]);
                return skynet.pack(true, text);
            }
            case "write_file": {
                const ab = crypt.base64_decode(args[2]);
                io.write_file(args[1], ab);
                return skynet.pack(true);
            }
            case "append_file": {
                const ab = crypt.base64_decode(args[2]);
                io.append_file(args[1], ab);
                return skynet.pack(true);
            }
            case "stat": {
                const st = io.stat(args[1]);
                return skynet.pack(true, st === null ? null : JSON.stringify(st));
            }
            case "readdir": {
                const entries = io.readdir(args[1]);
                return skynet.pack(true, JSON.stringify(entries));
            }
            case "mkdir": {
                io.mkdir(args[1], !!args[2]);
                return skynet.pack(true);
            }
            case "remove": {
                io.remove(args[1]);
                return skynet.pack(true);
            }
            case "rename": {
                io.rename(args[1], args[2]);
                return skynet.pack(true);
            }
            default:
                return skynet.pack(false, "ioservice: unknown op " + op);
            }
        } catch (e) {
            return skynet.pack(false, String(e && e.message ? e.message : e));
        }
    });
});
