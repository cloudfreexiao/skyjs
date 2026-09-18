// Task 2 acceptance: OOM service. Allocates 1GiB in 1MiB ArrayBuffer chunks;
// with js_memlimit set, the allocator must refuse and QuickJS must throw
// (caught here), proving memlimit semantics end-to-end.
globalThis.dispatch = function (msg, session, source) {
    if (msg === "oom") {
        const keep = [];
        try {
            for (let i = 0; i < 1024; i++) {
                keep.push(new ArrayBuffer(1024 * 1024));
            }
            return "OOM_NOT_TRIGGERED";
        } catch (e) {
            return "OOM_CAUGHT:" + e.name + ":" + e.message;
        }
    }
    return "OK";
};
