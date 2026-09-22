// Deadloop acceptance: interrupt both a synchronous loop and an infinite microtask chain.
const h = skynetcore.int_command("LAUNCH", "snjs test/service/deadloop_worker.js");
const microtask_h = skynetcore.int_command("LAUNCH", "snjs test/service/microtask_deadloop_worker.js");
skynetcore.error("MAIN deadloop_worker handle = " + h + " microtask=" + microtask_h);
skynetcore.int_command("LAUNCH", "driver " + h + " 300 loop 2000");
skynetcore.int_command("LAUNCH", "driver " + microtask_h + " 300 loop 100");

globalThis.dispatch = function (msg, session, source) {
    return "MAIN_OK";
};
