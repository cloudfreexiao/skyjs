-- run-bench.js memory-scaling driver (stock Lua side). Mirrors
-- test/service/bench-mem-main.js: launches N idle echo services on a dedicated
-- node so the steady-state RSS at that service count can be attributed cleanly.
-- The count N comes from the config env "mem_count" (the harness writes a temp
-- config per count); the Lua side has no snjs_param, so getenv is used.
local skynet = require "skynet"

local P20 = "ping_" .. string.rep("m", 15)

skynet.register_protocol {
    name = "text",
    id = skynet.PTYPE_TEXT,
    pack = function(m) return m end,
    unpack = skynet.tostring,
}

skynet.start(function()
    local n = tonumber(skynet.getenv("mem_count") or 0) or 0
    local handles = {}
    for _ = 1, n do handles[#handles + 1] = skynet.newservice("test/bench-lua/echo") end
    -- one RTT each so the service actually loaded (snlua loads lazily)
    for _, h in ipairs(handles) do skynet.call(h, "text", P20) end
    collectgarbage("collect")   -- report post-GC footprint
    skynet.error(string.format("BENCH case=mem_scale n=%d mps=0 gc_kib=%.0f",
        n, collectgarbage("count")))
    skynet.error("BENCH_MEM_READY count=" .. n)
    -- idle on purpose: the harness samples steady-state RSS then kills us
end)
