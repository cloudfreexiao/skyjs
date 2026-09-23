// Task 2 acceptance: deadloop service. "loop" message enters an infinite
// interpreted loop; the driver sends SIGNAL 0 after 2000ms, which must
// interrupt the loop via JS_SetInterruptHandler.
globalThis.dispatch = function (msg, session, source) {
    if (msg === "loop") {
        let x = 0;
        while (true) {
            x++;
        }
    }
    return "DEADLOOP_OK";
};
