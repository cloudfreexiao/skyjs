-- run_bench.js phase-2 driver, node B (port 2529): echo + reverse-direction
-- runner, booted BEFORE node A by the harness. Mirrors
-- test/service/bench_cluster_b.js.
local skynet = require "skynet"
local cluster = require "skynet.cluster"

local P100 = string.rep("x", 100)
local P40K = string.rep("x", 40000)
local CASES = {
    { name = "cl_100", payload = P100, n = 5000, warm = 200 },
    { name = "cl_40k", payload = P40K, n = 1000, warm = 50 },
}

local function mark(name) skynet.error("BENCH_BEGIN " .. name) end
local function unmark(name) skynet.error("BENCH_END " .. name) end
local function report(name, n, t0)   -- t0 = skynet.hpc() nanoseconds
    local dt_ms = (skynet.hpc() - t0) / 1e6
    local mps = dt_ms > 0 and math.floor(n * 1000 / dt_ms) or 0
    skynet.error(string.format("BENCH case=%s n=%d mps=%d ms=%.1f", name, n, mps, dt_ms))
end

local function run_direction(peer)
    for _, c in ipairs(CASES) do
        for _ = 1, c.warm do cluster.call(peer, "@bench", c.payload) end
        mark(c.name)
        local t0 = skynet.hpc()
        for _ = 1, c.n do cluster.call(peer, "@bench", c.payload) end
        unmark(c.name)
        report(c.name, c.n, t0)
    end
end

skynet.start(function()
    cluster.open(2529)
    cluster.register("main")
    cluster.register("bench")
    skynet.dispatch("lua", function(session, source, cmd)
        if cmd == "__ctl_run" then
            -- ack only after the reverse direction finished
            run_direction("a")
            skynet.error("BENCH_SUITE_DONE")
            skynet.ret(skynet.pack("ctl-done"))
        else
            skynet.ret(skynet.pack(cmd))
        end
    end)
    skynet.error("BENCH_CLUSTER_READY")
end)
