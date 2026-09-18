#ifndef LUA_STUB_LAUXLIB_H
#define LUA_STUB_LAUXLIB_H

/*
 * Minimal Lua API stub for the skyjs Lua-free build.
 *
 * It exists solely to satisfy malloc_hook.c's dump_mem_lua(), whose only
 * real caller is luaclib/memory.so (a Lua extension that is never built
 * or loaded in skyjs). The stub functions abort() so an unexpected call
 * would fail loudly instead of silently corrupting state.
 */

typedef struct lua_State lua_State;

void lua_createtable(lua_State *L, int narr, int nrec);
void lua_pushinteger(lua_State *L, long long n);
void lua_rawseti(lua_State *L, int index, long long n);

// same expansion as real Lua
#define lua_newtable(L) lua_createtable(L, 0, 0)

#endif
