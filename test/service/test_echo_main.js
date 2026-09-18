// Task 2 acceptance: bootstrap script. Launches the JS echo service, then a
// C driver that calls it with "hello_from_js" after 300ms.
const h = skynetcore.int_command("LAUNCH", "snjs test/service/js_echo.js");
skynetcore.error("MAIN js_echo handle = " + h);
skynetcore.int_command("LAUNCH", "driver " + h + " 300 hello_from_js 0");

globalThis.dispatch = function (msg, session, source) {
    return "MAIN_OK:" + msg;
};
