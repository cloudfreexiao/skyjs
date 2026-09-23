// Deadloop acceptance: interrupt both a synchronous loop and an infinite microtask chain.
const h = skynetcore.intCommand("LAUNCH", "snjs test/service/deadloop-worker.js");
const microtaskH = skynetcore.intCommand("LAUNCH", "snjs test/service/microtask-deadloop-worker.js");
skynetcore.error("MAIN deadloop_worker handle = " + h + " microtask=" + microtaskH);
skynetcore.intCommand("LAUNCH", "driver " + h + " 300 loop 2000");
skynetcore.intCommand("LAUNCH", "driver " + microtaskH + " 300 loop 100");

globalThis.dispatch = function (msg, session, source) {
    return "MAIN_OK";
};
