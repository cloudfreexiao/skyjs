-- Cluster interop acceptance: stock Lua node side.
-- Boot with the skynet submodule's own build (run from skyjs/3rd/skynet):
--   cd 3rd/skynet && make && ./skynet ../../test/cluster_lua/config
--
-- Serves lua-protocol cluster requests and makes one call INTO the skyjs
-- node (its skyclusterd listens on 2528, service registered as "main").
local skynet = require "skynet"
local cluster = require "skynet.cluster"

skynet.start(function()
    cluster.open(2530)
    cluster.register("main")
    skynet.dispatch("lua", function(session, source, cmd, ...)
        local args = { ... }
        skynet.ret(skynet.pack("lua:" .. tostring(cmd), (tonumber(args[1]) or 0) + 10))
    end)
    local r1, r2 = cluster.call("skyjs", "@main", "from-lua", 7)
    skynet.error("LUA2JS RESULT:", r1, r2)
    skynet.error("LUA_NODE_READY")
end)
