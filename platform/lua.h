#ifndef LUA_STUB_LUA_H
#define LUA_STUB_LUA_H

/*
 * Minimal lua.h stub for the skyjs Lua-free build.
 *
 * skynet's malloc_hook.h includes <lua.h> for the lua_State typedef used
 * by dump_mem_lua().  On macOS a system-installed Lua may satisfy this,
 * but a clean Linux build has no Lua headers.  This stub ensures the
 * project compiles on every platform without an external Lua dependency.
 *
 * The real declarations live in platform/lauxlib.h; we just forward to it.
 */

#include "lauxlib.h"

#endif /* LUA_STUB_LUA_H */
