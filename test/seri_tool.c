/*
 * test/seri_tool.c -- reference packer/dumper for Task 5 acceptance.
 * Links the ORIGINAL lua-seri.c from 3rd/skynet/lualib-src against the stock
 * Lua 5.5.1 shipped in 3rd/skynet's 3rd/lua, byte-for-byte identical to what
 * a Lua node produces.
 *
 *   test/seri_tool gen  <file>   write a fixed scalar + array-table sequence
 *   test/seri_tool dump <file>   unpack and print the value sequence
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <lua.h>
#include <lauxlib.h>

// pull in the original implementation wholesale (statics included)
#include "lua-seri.c"

static void
dump_value(lua_State *L, int idx, int depth) {
	// recursion pushes new frames: pin the index absolutely or the nested
	// lua_next below would read a stale negative index
	idx = lua_absindex(L, idx);
	int t = lua_type(L, idx);
	switch (t) {
	case LUA_TNIL:
		printf("nil\n");
		break;
	case LUA_TBOOLEAN:
		printf("bool:%d\n", lua_toboolean(L, idx));
		break;
	case LUA_TNUMBER:
		if (lua_isinteger(L, idx)) {
			printf("int:%lld\n", (long long)lua_tointeger(L, idx));
		} else {
			printf("real:%g\n", lua_tonumber(L, idx));
		}
		break;
	case LUA_TSTRING: {
		size_t l = 0;
		const char *s = lua_tolstring(L, idx, &l);
		printf("str:%.*s\n", (int)l, s);
		break;
	}
	case LUA_TTABLE: {
		printf("table:\n");
		lua_pushnil(L);
		while (lua_next(L, idx)) {
			printf("%*s", depth * 2 + 2, "");
			dump_value(L, -2, depth + 1);
			printf("%*s", depth * 2 + 2, "");
			dump_value(L, -1, depth + 1);
			lua_pop(L, 1);
		}
		break;
	}
	default:
		printf("other:%s\n", lua_typename(L, t));
		break;
	}
}

int
main(int argc, char *argv[]) {
	if (argc < 3) {
		fprintf(stderr, "usage: seri_tool gen <file> | seri_tool dump <file>\n");
		return 1;
	}
	lua_State *L = luaL_newstate();
	if (strcmp(argv[1], "gen") == 0) {
		// sequence must stay in sync with test/service/test_seri_main.js
		lua_pushnil(L);
		lua_pushboolean(L, 1);
		lua_pushboolean(L, 0);
		lua_pushinteger(L, 0);
		lua_pushinteger(L, 1);
		lua_pushinteger(L, 200);
		lua_pushinteger(L, 70000);
		lua_pushinteger(L, -1234567);
		lua_pushinteger(L, 5000000000LL);
		lua_pushnumber(L, 1.5);
		lua_pushnumber(L, 0.25);
		lua_pushliteral(L, "hello");
		{
			char buf[101];
			memset(buf, 'x', 100);
			buf[100] = 0;
			lua_pushlstring(L, buf, 100);
		}
		lua_createtable(L, 3, 0);
		lua_pushinteger(L, 10);
		lua_rawseti(L, -2, 1);
		lua_pushinteger(L, 20);
		lua_rawseti(L, -2, 2);
		lua_pushinteger(L, 30);
		lua_rawseti(L, -2, 3);
		luaseri_pack(L);	// -> lightuserdata buffer, integer len
		void *ptr = lua_touserdata(L, -2);
		int sz = (int)lua_tointeger(L, -1);
		FILE *f = fopen(argv[2], "wb");
		if (f == NULL) {
			fprintf(stderr, "can't write %s\n", argv[2]);
			return 1;
		}
		fwrite(ptr, 1, sz, f);
		fclose(f);
		printf("gen %s: %d bytes\n", argv[2], sz);
	} else {
		FILE *f = fopen(argv[2], "rb");
		if (f == NULL) {
			fprintf(stderr, "can't open %s\n", argv[2]);
			return 1;
		}
		fseek(f, 0, SEEK_END);
		long sz = ftell(f);
		fseek(f, 0, SEEK_SET);
		char *buf = malloc(sz);
		if (fread(buf, 1, sz, f) != (size_t)sz) {
			fprintf(stderr, "short read\n");
			return 1;
		}
		fclose(f);
		lua_pushlstring(L, buf, sz);
		free(buf);
		int n = luaseri_unpack(L);
		// lua-seri keeps the buffer string at index 1 (lua_settop), values start at 2
		for (int i = 2; i <= n + 1; i++) {
			printf("[%d] ", i - 1);
			dump_value(L, i, 0);
		}
	}
	return 0;
}
