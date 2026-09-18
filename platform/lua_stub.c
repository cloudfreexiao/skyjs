#include "lauxlib.h"

#include <stdio.h>
#include <stdlib.h>

/*
 * See platform/lauxlib.h. dump_mem_lua() must never be reached in a
 * Lua-free build; abort loudly if it ever is.
 */

static void
never_call(const char *api) {
	fprintf(stderr, "lua stub: %s must not be called in a Lua-free build\n", api);
	abort();
}

void
lua_createtable(lua_State *L, int narr, int nrec) {
	(void)L;
	(void)narr;
	(void)nrec;
	never_call("lua_createtable");
}

void
lua_pushinteger(lua_State *L, long long n) {
	(void)L;
	(void)n;
	never_call("lua_pushinteger");
}

void
lua_rawseti(lua_State *L, int index, long long n) {
	(void)L;
	(void)index;
	(void)n;
	never_call("lua_rawseti");
}
