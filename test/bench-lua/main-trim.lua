-- Memory-attribution trim driver (stock Lua side): runs ONE bench case per
-- dedicated node, case name from the snlua bootstrap param (chunk vararg),
-- mirroring test/service/bench-trim-main.js. Keep the case set in lockstep
-- with it; see that file and build/rss_trim*.sh for the sampling harness.
local skynet = require "skynet"
local case = ...

local P20 = "ping_" .. string.rep("m", 15)
local P64K = string.rep("x", 65536)

local STARTUP_N = 500

skynet.register_protocol {
    name = "text",
    id = skynet.PTYPE_TEXT,
    pack = function(m) return m end,
    unpack = skynet.tostring,
}

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
    mark("send_self")
    local t0 = skynet.hpc()
    for _ = 1, n do skynet.send(l_echo, "text", P20) end
    skynet.call(l_echo, "text", P20)
    unmark("send_self")
    report("send_self", n, t0)
end

local function fork_join(body, count)
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

local function case_startup(name, launch)
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
    fork_join(function() skynet.sleep(1) end, n)
    unmark("timer_wake")
    report("timer_wake", n, t0)
end

skynet.start(function()
    c_echo = skynet.newservice("echo")
    l_echo = skynet.newservice("test/bench-lua/echo")

    for _ = 1, 100 do skynet.call(c_echo, "text", P20) end
    for _ = 1, 100 do skynet.call(l_echo, "text", P20) end

    if case == "rt_text_self" then
        case_rt("rt_text_self", l_echo, "text", P20, 50000)
    elseif case == "rt_text_s64k" then
        case_rt("rt_text_s64k", l_echo, "text", P64K, 10000)
    elseif case == "send_self" then
        case_send(500000)
    elseif case == "timer_wake" then
        case_timer(50000)
    elseif case == "startup_self" then
        case_startup("startup_self",
            function() return skynet.newservice("test/bench-lua/echo") end)
    elseif case == "idle" then
        -- base node footprint only
    else
        error("unknown case " .. tostring(case))
    end

    skynet.error("BENCH case=mem_trim n=0 mps=0 gc_kib=" ..
        string.format("%.0f", collectgarbage("count")))
    skynet.error("BENCH_TRIM_DONE")
end)
