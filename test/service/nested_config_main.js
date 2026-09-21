// Task 2 acceptance: skynet.getenv over the QuickJS-parsed config.
// Exercises every JSON type (number/float/bool/string/null/object/array/mixed)
// plus nested objects, standard config keys, and the deep-frozen guarantee.
// Prints [PASS]/[FAIL] per assertion and a NESTED CONFIG TEST PASSED marker.
// Uses the global `skynet` (js/skynet.js), like the other test services --
// snjs eval's scripts as global code, so no ES `import` here.
"use strict";

skynet.start(async () => {
    let pass = 0;
    let fail = 0;

    function assert_eq(label, got, expected) {
        // deep equal for objects/arrays via JSON, === for primitives
        const ok = (typeof expected === "object" && expected !== null)
            ? JSON.stringify(got) === JSON.stringify(expected)
            : got === expected;
        if (ok) {
            pass++;
            console.log("[PASS]", label);
        } else {
            fail++;
            console.error("[FAIL]", label, "got:", JSON.stringify(got),
                "expected:", JSON.stringify(expected));
        }
    }

    function assert_type(label, got, expected_type) {
        const got_type = Array.isArray(got) ? "array" : typeof got;
        if (got_type === expected_type) {
            pass++;
            console.log("[PASS]", label);
        } else {
            fail++;
            console.error("[FAIL]", label, "got type:", got_type,
                "expected:", expected_type);
        }
    }

    // number
    assert_type("test_number type", skynet.getenv("test_number"), "number");
    assert_eq("test_number value", skynet.getenv("test_number"), 42);

    // float
    assert_type("test_float type", skynet.getenv("test_float"), "number");
    assert_eq("test_float value", skynet.getenv("test_float"), 3.14);

    // boolean
    assert_type("test_bool_true type", skynet.getenv("test_bool_true"), "boolean");
    assert_eq("test_bool_true value", skynet.getenv("test_bool_true"), true);
    assert_eq("test_bool_false value", skynet.getenv("test_bool_false"), false);

    // string
    assert_type("test_string type", skynet.getenv("test_string"), "string");
    assert_eq("test_string value", skynet.getenv("test_string"), "hello world");

    // null
    assert_eq("test_null value", skynet.getenv("test_null"), null);

    // object (nested)
    assert_type("test_object type", skynet.getenv("test_object"), "object");
    const obj = skynet.getenv("test_object");
    assert_eq("test_object.host", obj.host, "127.0.0.1");
    assert_eq("test_object.port", obj.port, 8080);
    assert_eq("test_object.nested.deep", obj.nested.deep, true);

    // array
    assert_eq("test_array is array", Array.isArray(skynet.getenv("test_array")), true);
    assert_eq("test_array value", skynet.getenv("test_array"), [1, 2, 3]);

    // mixed array
    assert_eq("test_mixed_array value", skynet.getenv("test_mixed_array"),
        ["a", 1, true, null]);

    // standard config keys also work (primitives flattened into env too)
    assert_type("thread type", skynet.getenv("thread"), "number");
    assert_eq("thread value", skynet.getenv("thread"), 2);
    assert_type("bootstrap type", skynet.getenv("bootstrap"), "string");

    // a key absent from the JSON falls back to the flat env string (C default)
    assert_type("cpath type", skynet.getenv("cpath"), "string");

    // frozen (immutable): mutating a returned object must have no effect
    let frozen_ok = false;
    try {
        const o = skynet.getenv("test_object");
        o.host = "MUTATED";
        frozen_ok = (o.host !== "MUTATED"); // sloppy: silently fails; strict: throws
    } catch (e) {
        frozen_ok = true; // TypeError from frozen object
    }
    assert_eq("config is frozen", frozen_ok, true);

    // summary
    console.log(`\ngetenv test: ${pass} passed, ${fail} failed`);
    if (fail > 0) {
        console.error("NESTED CONFIG TEST FAILED");
    } else {
        console.log("NESTED CONFIG TEST PASSED");
    }

    skynet.exit();
});
