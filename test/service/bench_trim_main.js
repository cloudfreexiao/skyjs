// Memory-attribution trim driver: runs ONE bench case per dedicated node so
// its RSS peak can be attributed cleanly (case name comes from snjs_param,
// see test/config_bench_*.json bootstrap args). A driver service kicks "run"
// 300ms after start, when snjs_param is already set. Case set mirrors
// bench_suite_main.js; keep the two in lockstep when bench cases change.
skynet.register("main");

const P20 = "ping_" + "m".repeat(15);
const P256 = "x".repeat(256);
const P4K = "x".repeat(4096);
const P64K = "x".repeat(65536);
const TBL10 = { id: 1, type: 2, hp: 100, mp: 50, x: 3, y: 4, lv: 10, exp: 999, gold: 88, flag: 1 };
const ARR1000 = Array.from({ length: 1000 }, (v, i) => i);
const STARTUP_N = 500;

const c_echo = skynetcore.int_command("LAUNCH", "echo");
const j_echo = skynetcore.int_command("LAUNCH", "snjs test/service/bench_echo_worker.js");

function mark(name) {
    skynetcore.error("BENCH_BEGIN " + name);
}

function unmark(name) {
    skynetcore.error("BENCH_END " + name);
}

function report(name, n, t0) {
    const dt = Date.now() - t0;
    const mps = dt > 0 ? Math.round(n * 1000 / dt) : 0;
    skynetcore.error("BENCH case=" + name + " n=" + n + " mps=" + mps + " ms=" + dt);
}

async function case_rt(name, target, proto, payload, n, decode) {
    mark(name);
    const t0 = Date.now();
    if (decode) {
        for (let i = 0; i < n; i++) skynet.unpack(await skynet.call(target, proto, payload));
    } else {
        for (let i = 0; i < n; i++) await skynet.call(target, proto, payload);
    }
    unmark(name);
    report(name, n, t0);
}

async function case_conc(k, n, name) {
    mark(name);
    const t0 = Date.now();
    const per = Math.floor(n / k);
    const jobs = [];
    for (let c = 0; c < k; c++) {
        jobs.push((async () => {
            for (let i = 0; i < per; i++) await skynet.call(j_echo, "text", P20);
        })());
    }
    await Promise.all(jobs);
    unmark(name);
    report(name, n, t0);
}

function case_seri(name, n, payload) {
    mark(name);
    const t0 = Date.now();
    for (let i = 0; i < n; i++) {
        skynet.unpack(skynet.pack(payload));
    }
    unmark(name);
    report(name, n, t0);
}

async function case_startup(name, launch) {
    mark(name);
    const t0 = Date.now();
    const handles = [];
    for (let i = 0; i < STARTUP_N; i++) handles.push(launch());
    for (const h of handles) await skynet.call(h, "text", P20);
    unmark(name);
    report(name, STARTUP_N, t0);
}

async function case_send(n) {
    mark("send_self");
    const t0 = Date.now();
    for (let i = 0; i < n; i++) skynetcore.send(j_echo, 0, P20, 0);
    await skynet.call(j_echo, "text", P20);
    unmark("send_self");
    report("send_self", n, t0);
}

async function case_timer(n) {
    mark("timer_wake");
    const t0 = Date.now();
    const ps = [];
    for (let i = 0; i < n; i++) ps.push(skynet.sleep(10));
    await Promise.all(ps);
    unmark("timer_wake");
    report("timer_wake", n, t0);
}

async function run_one(name) {
    switch (name) {
        case "idle":
            break;
        case "rt_text_c":
            await case_rt("rt_text_c", c_echo, "text", P20, 50000, false);
            break;
        case "rt_text_self":
            await case_rt("rt_text_self", j_echo, "text", P20, 50000, false);
            break;
        case "rt_text_s256":
            await case_rt("rt_text_s256", j_echo, "text", P256, 50000, false);
            break;
        case "rt_text_s4k":
            await case_rt("rt_text_s4k", j_echo, "text", P4K, 50000, false);
            break;
        case "rt_text_s64k":
            await case_rt("rt_text_s64k", j_echo, "text", P64K, 10000, false);
            break;
        case "rt_lua_self":
            await case_rt("rt_lua_self", j_echo, "lua", skynet.pack(TBL10), 20000, true);
            break;
        case "send_self":
            await case_send(500000);
            break;
        case "conc_self_k1":
            await case_conc(1, 100000, "conc_self_k1");
            break;
        case "conc_self_k8":
            await case_conc(8, 100000, "conc_self_k8");
            break;
        case "sp_t10":
            case_seri("sp_t10", 100000, TBL10);
            break;
        case "sp_t1000":
            case_seri("sp_t1000", 5000, ARR1000);
            break;
        case "sp_s64k":
            case_seri("sp_s64k", 2000, P64K);
            break;
        case "startup_c":
            await case_startup("startup_c", () => skynetcore.int_command("LAUNCH", "echo"));
            break;
        case "startup_self":
            await case_startup("startup_self",
                () => skynetcore.int_command("LAUNCH", "snjs test/service/bench_echo_worker.js"));
            break;
        case "timer_wake":
            await case_timer(50000);
            break;
        default:
            throw new Error("unknown case " + name);
    }
    skynetcore.error("BENCH case=mem_trim n=0 mps=0 js_mem=" + skynet.mem_stat());
    skynetcore.error("BENCH_TRIM_DONE");
}

skynet.start(() => {
    skynetcore.int_command("LAUNCH", "driver .main 300 run x");
    skynet.dispatch("text", (msg) => {
        if (msg !== "run") return "OK";
        run_one(globalThis.snjs_param).catch(e => {
            skynetcore.error("BENCH_TRIM_FAIL: " + (e && (e.message || e)));
        });
        return undefined;
    });
});
