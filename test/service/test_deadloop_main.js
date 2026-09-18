// Task 2 acceptance: bootstrap for the deadloop scenario.
var h = skynetcore.intcommand("LAUNCH", "snjs test/service/js_deadloop.js");
skynetcore.error("MAIN js_deadloop handle = " + h);
skynetcore.intcommand("LAUNCH", "driver " + h + " 300 loop 2000");

globalThis.dispatch = function (msg, session, source) {
    return "MAIN_OK";
};
