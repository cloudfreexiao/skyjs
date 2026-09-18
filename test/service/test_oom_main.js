// Task 2 acceptance: bootstrap for the OOM scenario.
var h = skynetcore.intcommand("LAUNCH", "snjs test/service/js_oom.js");
skynetcore.error("MAIN js_oom handle = " + h);
skynetcore.intcommand("LAUNCH", "driver " + h + " 300 oom 0");

globalThis.dispatch = function (msg, session, source) {
    return "MAIN_OK";
};
