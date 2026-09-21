-- run_bench.js phase-3 target (stock Lua side): raw TCP echo on 2601.
-- socket.lua has no per-data callback for TCP, so each connection gets a
-- forked blocking read/write loop (the documented skynet echo pattern).
-- Lockstep with test/service/bench_socket_main.js.
local skynet = require "skynet"
local socket = require "skynet.socket"

local function echo_loop(client)
    socket.start(client)
    while true do
        local str = socket.read(client)
        if not str then break end
        socket.write(client, str)
    end
    socket.close(client)
end

skynet.start(function()
    local id = socket.listen("127.0.0.1", 2601)
    socket.start(id, function(client, addr)
        skynet.fork(echo_loop, client)
    end)
    skynet.error("BENCH_SOCKET_READY")
end)
