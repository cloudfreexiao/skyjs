// Task 10 acceptance: io module test orchestration.
// All test artefacts go into build/io_test/ and are cleaned up at the end.
"use strict";

const TEST_DIR = "build/io_test";

let fail_count = 0;

function check(label, ok, detail) {
    if (ok) {
        console.log("IO " + label + " OK");
    } else {
        console.log("IO FAIL " + label + (detail ? ": " + detail : ""));
        fail_count++;
    }
}

function ab_eq(a, b) {
    if (a.byteLength !== b.byteLength) return false;
    const va = new Uint8Array(a);
    const vb = new Uint8Array(b);
    for (let i = 0; i < va.length; i++) {
        if (va[i] !== vb[i]) return false;
    }
    return true;
}

// cleanup helper: remove file if exists, ignore errors
function safe_remove(p) {
    try { if (io.exists(p)) io.remove(p); } catch (_) { /* ignore */ }
}

function safe_rmdir(p) {
    try {
        if (io.exists(p)) {
            const entries = io.readdir(p);
            for (let i = 0; i < entries.length; i++) {
                const child = p + "/" + entries[i];
                const s = io.stat(child);
                if (s.is_dir) {
                    safe_rmdir(child);
                } else {
                    io.remove(child);
                }
            }
            io.remove(p);
        }
    } catch (_) { /* ignore */ }
}

skynet.start(() => {});

skynet.timeout(1, async () => {
    // ensure clean test directory
    safe_rmdir(TEST_DIR);
    io.mkdir(TEST_DIR, true);

    try {
        // ---- sync: write_file + read_file binary roundtrip ----
        {
            const src = new Uint8Array([0, 1, 2, 127, 128, 255]);
            const p = TEST_DIR + "/bin.dat";
            io.write_file(p, src.buffer);
            const back = io.read_file(p);
            check("sync_binary_roundtrip", ab_eq(src.buffer, back),
                "len=" + back.byteLength);
        }

        // ---- sync: write_file(string) + read_text_file text roundtrip ----
        {
            const text = "hello\nworld\n你好";
            const p = TEST_DIR + "/text.txt";
            io.write_file(p, text);
            const back = io.read_text_file(p);
            check("sync_text_roundtrip", back === text,
                "got=" + JSON.stringify(back));
        }

        // ---- sync: append_file ----
        {
            const p = TEST_DIR + "/append.txt";
            io.write_file(p, "AAA");
            io.append_file(p, "BBB");
            const back = io.read_text_file(p);
            check("sync_append", back === "AAABBB", "got=" + back);
        }

        // ---- sync: exists ----
        {
            const p = TEST_DIR + "/exist_test.txt";
            io.write_file(p, "x");
            check("exists_true", io.exists(p) === true);
            check("exists_false", io.exists(TEST_DIR + "/no_such_file.xyz") === false);
        }

        // ---- sync: stat file ----
        {
            const p = TEST_DIR + "/stat_file.txt";
            io.write_file(p, "12345");
            const s = io.stat(p);
            check("stat_file_size", s.size === 5, "size=" + s.size);
            check("stat_is_file", s.is_file === true);
            check("stat_is_dir_false", s.is_dir === false);
        }

        // ---- sync: stat directory ----
        {
            const s = io.stat(TEST_DIR);
            check("stat_dir_is_dir", s.is_dir === true);
        }

        // ---- sync: mkdir + readdir ----
        {
            const sub = TEST_DIR + "/subdir";
            io.mkdir(sub);
            io.write_file(sub + "/a.txt", "a");
            io.write_file(sub + "/b.txt", "b");
            const entries = io.readdir(sub);
            check("readdir", entries.includes("a.txt") && entries.includes("b.txt"),
                "entries=" + JSON.stringify(entries));
        }

        // ---- sync: mkdir recursive ----
        {
            const deep = TEST_DIR + "/x/y/z";
            io.mkdir(deep, true);
            check("mkdir_recursive", io.exists(deep) && io.stat(deep).is_dir);
        }

        // ---- sync: rename ----
        {
            const old_p = TEST_DIR + "/rename_src.txt";
            const new_p = TEST_DIR + "/rename_dst.txt";
            io.write_file(old_p, "ren");
            io.rename(old_p, new_p);
            check("rename_old_gone", io.exists(old_p) === false);
            check("rename_new_exists", io.exists(new_p) === true);
            const back = io.read_text_file(new_p);
            check("rename_content", back === "ren", "got=" + back);
        }

        // ---- sync: remove ----
        {
            const p = TEST_DIR + "/remove_me.txt";
            io.write_file(p, "bye");
            io.remove(p);
            check("remove", io.exists(p) === false);
        }

        // ---- sync: File streaming ----
        {
            const p = TEST_DIR + "/stream.bin";
            const f_w = io.open(p, "w");
            f_w.write("ABCD");
            f_w.write("EFGH");
            f_w.close();

            const f_r = io.open(p, "r");
            // seek to offset 2, read 4 bytes => "CDEF"
            f_r.seek(2, 0);
            const pos = f_r.tell();
            check("file_tell", pos === 2, "pos=" + pos);
            const chunk = f_r.read(4);
            const chunk_str = skynetcore.str(chunk);
            check("file_seek_read", chunk_str === "CDEF",
                "got=" + JSON.stringify(chunk_str));
            // read remaining => "GH"
            const rest = f_r.read(2);
            const rest_str = skynetcore.str(rest);
            check("file_read_rest", rest_str === "GH",
                "got=" + JSON.stringify(rest_str));
            f_r.close();
        }

        // ---- async: write_file_async + read_file_async binary roundtrip ----
        {
            const src = new Uint8Array([10, 20, 30, 40, 50]);
            const p = TEST_DIR + "/async_bin.dat";
            await io.write_file_async(p, src.buffer);
            const back = await io.read_file_async(p);
            check("async_binary_roundtrip", ab_eq(src.buffer, back),
                "len=" + back.byteLength);
        }

        // ---- async: read_text_file_async ----
        {
            const text = "async_hello";
            const p = TEST_DIR + "/async_text.txt";
            io.write_file(p, text);
            const back = await io.read_text_file_async(p);
            check("async_text", back === text, "got=" + back);
        }

        // ---- async: stat_async ----
        {
            const p = TEST_DIR + "/async_stat.txt";
            io.write_file(p, "abc");
            const s = await io.stat_async(p);
            check("async_stat", s.size === 3 && s.is_file === true,
                "size=" + s.size + " is_file=" + s.is_file);
        }

        // ---- error: read_file on non-existent path ----
        {
            let caught = false;
            try {
                io.read_file(TEST_DIR + "/no_such_file_ever.bin");
            } catch (e) {
                caught = true;
            }
            check("error_read_missing", caught, "expected exception");
        }

    } catch (e) {
        console.log("IO FAIL exception: " + (e && (e.message || e)));
        console.log(e && e.stack || "");
        fail_count++;
    }

    // cleanup
    safe_rmdir(TEST_DIR);

    if (fail_count === 0) {
        console.log("IO ALL OK");
    } else {
        console.log("IO FAIL total=" + fail_count);
    }
});
