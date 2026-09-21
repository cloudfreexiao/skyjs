// Task 2 acceptance: bootstrap for the deadloop scenario.
const h = skynetcore.int_command("LAUNCH", "snjs test/service/deadloop_worker.js");
skynetcore.error("MAIN deadloop_worker handle = " + h);
skynetcore.int_command("LAUNCH", "driver " + h + " 300 loop 2000");

globalThis.dispatch = function (msg, session, source) {
    return "MAIN_OK";
};
