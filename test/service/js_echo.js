// Task 2 acceptance: JS echo service, called by the C test driver.
globalThis.dispatch = function (msg, session, source) {
    return "JS_ECHO:" + msg;
};
