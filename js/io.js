// skyjs synchronous file I/O bridge (Phase B).
// Loaded by snjs (env key "js_io", default "./js/io.js").
// Wraps the C-layer skynetcore.io.* primitives with convenience sugar:
//   - read_file / read_text_file / write_file / append_file (whole-file)
//   - exists / stat / readdir / mkdir / remove / rename (metadata)
//   - File class for streaming read/write/seek/tell/close
(function () {
    "use strict";

    const cio = skynetcore.io;

    // ---- data coercion helper ----
    // Accepts string | ArrayBuffer | TypedArray, returns ArrayBuffer.
    function to_ab(data) {
        if (data instanceof ArrayBuffer) return data;
        if (ArrayBuffer.isView(data)) return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
        if (typeof data === "string") return cio.str2ab(data);
        throw new TypeError("io: data must be string, ArrayBuffer, or TypedArray");
    }

    // ---- whole-file ----

    function read_file(path) {
        return cio.read_file(path);
    }

    function read_text_file(path) {
        return skynetcore.str(cio.read_file(path));
    }

    function write_file(path, data) {
        return cio.write_file(path, to_ab(data));
    }

    function append_file(path, data) {
        return cio.append_file(path, to_ab(data));
    }

    // ---- metadata / directory ----

    function exists(path) {
        return cio.exists(path);
    }

    function stat(path) {
        return cio.stat(path);
    }

    function readdir(path) {
        return cio.readdir(path);
    }

    function mkdir(path, recursive) {
        if (recursive) {
            const parts = path.split("/");
            let cur = "";
            for (let i = 0; i < parts.length; i++) {
                if (i === 0 && parts[i] === "") {
                    cur = "/";
                    continue;
                }
                if (parts[i] === "") continue;
                cur = cur ? cur + "/" + parts[i] : parts[i];
                cio.mkdir(cur);
            }
            return;
        }
        return cio.mkdir(path);
    }

    function remove(path) {
        return cio.remove(path);
    }

    function rename(old_path, new_path) {
        return cio.rename(old_path, new_path);
    }

    // ---- streaming File class ----

    class File {
        constructor(handle) {
            this._handle = handle;
        }

        read(n) {
            return cio.fread(this._handle, n);
        }

        write(data) {
            return cio.fwrite(this._handle, to_ab(data));
        }

        seek(offset, whence) {
            return cio.fseek(this._handle, offset, whence !== undefined ? whence : 0);
        }

        tell() {
            return cio.ftell(this._handle);
        }

        close() {
            return cio.fclose(this._handle);
        }
    }

    function open(path, mode) {
        const handle = cio.open(path, mode);
        return new File(handle);
    }

    // ---- async API (Phase C) ----
    // Each _async method delegates to a dedicated ioservice via skynet.call,
    // so the caller's service is never blocked by file I/O. Binary data is
    // base64-encoded because js-seri cannot round-trip ArrayBuffer.
    //
    // These methods may only be called inside a skynet coroutine context
    // (skynet.fork / dispatch / timeout callbacks).

    let _io_svc = 0;   // cached ioservice handle (launched once, lazily)

    async function ensure_io_service() {
        if (_io_svc !== 0) return _io_svc;
        _io_svc = skynet.newservice("snjs js/ioservice.js");
        return _io_svc;
    }

    // helper: call ioservice, unpack response, throw on failure
    async function io_call(...pack_args) {
        const svc = await ensure_io_service();
        const resp = await skynet.call(svc, "lua", skynet.pack(...pack_args));
        const vals = skynet.unpack(resp);
        if (!vals[0]) throw new Error(vals[1] || "ioservice error");
        return vals[1];   // may be undefined for void ops
    }

    async function read_file_async(path) {
        const b64 = await io_call("read_file", path);
        return crypt.base64_decode(b64);
    }

    async function read_text_file_async(path) {
        return await io_call("read_text_file", path);
    }

    async function write_file_async(path, data) {
        const b64 = crypt.base64_encode(to_ab(data));
        await io_call("write_file", path, b64);
    }

    async function append_file_async(path, data) {
        const b64 = crypt.base64_encode(to_ab(data));
        await io_call("append_file", path, b64);
    }

    async function stat_async(path) {
        const json_str = await io_call("stat", path);
        return json_str === null || json_str === undefined ? null : JSON.parse(json_str);
    }

    async function readdir_async(path) {
        const json_str = await io_call("readdir", path);
        return JSON.parse(json_str);
    }

    async function mkdir_async(path, recursive) {
        await io_call("mkdir", path, !!recursive);
    }

    async function remove_async(path) {
        await io_call("remove", path);
    }

    async function rename_async(old_path, new_path) {
        await io_call("rename", old_path, new_path);
    }

    globalThis.io = {
        read_file,
        read_text_file,
        write_file,
        append_file,
        exists,
        stat,
        readdir,
        mkdir,
        remove,
        rename,
        open,
        File,
        // async API (Phase C)
        read_file_async,
        read_text_file_async,
        write_file_async,
        append_file_async,
        stat_async,
        readdir_async,
        mkdir_async,
        remove_async,
        rename_async,
    };
})();
