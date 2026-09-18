// Task 2 acceptance: bootstrap for the OOM scenario.
const h = skynetcore.int_command("LAUNCH", "snjs test/service/js_oom.js");
skynetcore.error("MAIN js_oom handle = " + h);
skynetcore.int_command("LAUNCH", "driver " + h + " 300 oom 0");

globalThis.dispatch = function (msg, session, source) {
    return "MAIN_OK";
};
