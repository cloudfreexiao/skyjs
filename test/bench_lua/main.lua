-- run_bench.js phase-1 driver (stock Lua side). Mirrors
-- test/service/bench_suite_main.js case-for-case; see that file for the output
-- protocol. Payloads, N and case order must stay in lockstep with it.
-- Timing is in-process skynet.hpc() (CLOCK_MONOTONIC, nanoseconds) around
-- each loop: log lines cross the logger service asynchronously and lag under
-- CPU saturation, so the harness's cross-process marker hrtime is only a
-- gross sanity check.
local skynet = require "skynet"

local P20 = "ping_" .. string.rep("m", 15)
local P256 = string.rep("x", 256)
local P4K = string.rep("x", 4096)
local P64K = string.rep("x", 65536)
local TBL10 = { id = 1, type = 2, hp = 100, mp = 50, x = 3, y = 4, lv = 10, exp = 999, gold = 88, flag = 1 }
local ARR1000 = {}
for i = 1, 1000 do ARR1000[i] = i end

local STARTUP_N = 500

skynet.register_protocol {
    name = "text",
    id = skynet.PTYPE_TEXT,
    pack = function(m) return m end,
    unpack = skynet.tostring,
}

-- echo targets are launched inside skynet.start: newservice needs a
-- yieldable context (skynetcore.int_command needs none on the JS side, so
-- bench_suite_main.js can stay at file scope)
local c_echo, l_echo

local function mark(name) skynet.error("BENCH_BEGIN " .. name) end
local function unmark(name) skynet.error("BENCH_END " .. name) end
local function report(name, n, t0)   -- t0 = skynet.hpc() nanoseconds
    local dt_ms = (skynet.hpc() - t0) / 1e6
    local mps = dt_ms > 0 and math.floor(n * 1000 / dt_ms) or 0
    skynet.error(string.format("BENCH case=%s n=%d mps=%d ms=%.1f", name, n, mps, dt_ms))
end

local function case_rt(name, target, proto, payload, n)
    mark(name)
    local t0 = skynet.hpc()
    for _ = 1, n do skynet.call(target, proto, payload) end
    unmark(name)
    report(name, n, t0)
end

local function case_send(n)
    -- fire-and-forget (session 0, echo ignores those); the trailing call is
    -- the FIFO drain barrier, mirroring bench_suite_main.js
    mark("send_self")
    local t0 = skynet.hpc()
    for _ = 1, n do skynet.send(l_echo, "text", P20) end
    skynet.call(l_echo, "text", P20)
    unmark("send_self")
    report("send_self", n, t0)
end

local function fork_join(body, count)
    -- skynet.wait() is a condition-variable wait (it blocks until someone
    -- calls skynet.wakeup on THIS coroutine), not a fork-join; the standard
    -- join is: last finishing fork wakes the caller
    local me = coroutine.running()
    local remaining = count
    for _ = 1, count do
        skynet.fork(function()
            body()
            remaining = remaining - 1
            if remaining == 0 then skynet.wakeup(me) end
        end)
    end
    if remaining > 0 then skynet.wait() end
end

local function case_conc(k, n, name)
    mark(name)
    local t0 = skynet.hpc()
    local per = math.floor(n / k)
    fork_join(function()
        for _ = 1, per do skynet.call(l_echo, "text", P20) end
    end, k)
    unmark(name)
    report(name, n, t0)
end

local function case_seri(name, n, payload)
    mark(name)
    local t0 = skynet.hpc()
    for _ = 1, n do
        local buf, sz = skynet.pack(payload)
        skynet.unpack(buf, sz)
    end
    unmark(name)
    report(name, n, t0)
end

local function case_startup(name, launch)
    -- creation + one round trip each, so the service actually processed its
    -- first message (snlua loads lazily), mirroring bench_suite_main.js
    mark(name)
    local t0 = skynet.hpc()
    local handles = {}
    for _ = 1, STARTUP_N do handles[#handles + 1] = launch() end
    for _, h in ipairs(handles) do skynet.call(h, "text", P20) end
    unmark(name)
    report(name, STARTUP_N, t0)
end

local function case_timer(n)
    mark("timer_wake")
    local t0 = skynet.hpc()
    fork_join(function() skynet.sleep(1) end, n)   -- 1cs = 10ms each
    unmark("timer_wake")
    report("timer_wake", n, t0)
end

skynet.start(function()
    c_echo = skynet.newservice("echo")
    l_echo = skynet.newservice("test/bench_lua/echo")

    -- warmup (untimed), mirroring bench_suite_main.js
    for _ = 1, 300 do skynet.call(c_echo, "text", P20) end
    for _ = 1, 300 do skynet.call(l_echo, "text", P20) end
    for _ = 1, 100 do
        local buf, sz = skynet.pack(TBL10)
        skynet.unpack(buf, sz)
    end

    case_rt("rt_text_c", c_echo, "text", P20, 50000)
    case_rt("rt_text_self", l_echo, "text", P20, 50000)
    case_rt("rt_text_s256", l_echo, "text", P256, 50000)
    case_rt("rt_text_s4k", l_echo, "text", P4K, 50000)
    case_rt("rt_text_s64k", l_echo, "text", P64K, 10000)
    case_rt("rt_lua_self", l_echo, "lua", TBL10, 20000)

    case_send(500000)
    case_conc(1, 100000, "conc_self_k1")
    case_conc(8, 100000, "conc_self_k8")

    case_seri("sp_t10", 100000, TBL10)
    case_seri("sp_t1000", 5000, ARR1000)
    case_seri("sp_s64k", 2000, P64K)

    case_startup("startup_c", function() return skynet.newservice("echo") end)
    case_startup("startup_self",
        function() return skynet.newservice("test/bench_lua/echo") end)

    case_timer(50000)

    mark("mem_report")
    unmark("mem_report")
    collectgarbage("collect")   -- report post-GC footprint
    skynet.error("BENCH case=mem_report n=0 mps=0 gc_kib=" ..
        string.format("%.0f", collectgarbage("count")))
    skynet.error("BENCH_SUITE_DONE")
end)
