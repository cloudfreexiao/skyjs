-- Bench echo target (Lua side): text echoes the string untouched; lua
-- unpacks and repacks, matching test/service/bench_echo_js.js on the skyjs
-- side. Text protocol registration follows launcher.lua's pattern
-- (unpack = skynet.tostring); pack passes the string through raw.
local skynet = require "skynet"

skynet.register_protocol {
    name = "text",
    id = skynet.PTYPE_TEXT,
    pack = function(m) return m end,
    unpack = skynet.tostring,
}

skynet.start(function()
    skynet.dispatch("text", function(session, source, msg)
        skynet.ret(msg)
    end)
    skynet.dispatch("lua", function(session, source, ...)
        skynet.ret(skynet.pack(...))
    end)
end)
