UNAME := $(shell uname)

CC ?= cc
CFLAGS ?= -g -O2 -Wall

ifeq ($(UNAME), Darwin)
  SHARED := -fPIC -dynamiclib -Wl,-undefined,dynamic_lookup
  SKYNET_LIBS := -lpthread -lm -ldl
else
  SHARED := -fPIC --shared
  SKYNET_LIBS := -lpthread -lm -ldl -lrt
endif

# NOUSE_JEMALLOC: system malloc, per-service memstat still active (malloc_hook.c)
SKYNET_DEFINES := -DNOUSE_JEMALLOC

SKYNET_INC := 3rd/skynet/skynet-src

# 15 of the 17 original SKYNET_SRC files; skynet_main.c and skynet_env.c are
# replaced by platform/main.c and platform/env.c (skynet sources untouched).
SKYNET_SRC := skynet_handle.c skynet_module.c skynet_mq.c skynet_server.c \
  skynet_start.c skynet_timer.c skynet_error.c skynet_harbor.c skynet_monitor.c \
  skynet_socket.c socket_server.c mem_info.c malloc_hook.c skynet_daemon.c skynet_log.c

SKYNET_OBJ := $(addprefix build/skynet_,$(SKYNET_SRC:.c=.o))
PLATFORM_OBJ := build/env.o build/main.o build/lua_stub.o

# quickjs-ng core (statically linked into snjs.so, symbols hidden)
QJS_SRC := 3rd/quickjs/quickjs.c 3rd/quickjs/libregexp.c 3rd/quickjs/libunicode.c 3rd/quickjs/dtoa.c
QJS_OBJ := $(addprefix build/qjs_,$(notdir $(QJS_SRC:.c=.o)))

TARGET := skyjs

all: $(TARGET) cservice/logger.so cservice/snjs.so cservice/skyclusterd.so \
	test/cservice/echo.so test/cservice/driver.so

build:
	mkdir -p build
cservice:
	mkdir -p cservice
test/cservice:
	mkdir -p test/cservice

build/skynet_%.o: 3rd/skynet/skynet-src/%.c | build
	$(CC) $(CFLAGS) $(SKYNET_DEFINES) -I$(SKYNET_INC) -Iplatform -c $< -o $@

build/%.o: platform/%.c | build
	$(CC) $(CFLAGS) $(SKYNET_DEFINES) -I$(SKYNET_INC) -Iplatform -c $< -o $@

build/qjs_%.o: 3rd/quickjs/%.c | build
	$(CC) $(CFLAGS) -fvisibility=hidden -D_GNU_SOURCE -I3rd/quickjs -c $< -o $@

build/snjs.o: service-src/snjs.c | build
	$(CC) $(CFLAGS) -fvisibility=hidden -I$(SKYNET_INC) -Iplatform -I3rd/quickjs -c $< -o $@

build/seri.o: service-src/js-seri.c | build
	$(CC) $(CFLAGS) -fvisibility=hidden -I$(SKYNET_INC) -Iplatform -I3rd/quickjs -c $< -o $@

build/netpack.o: service-src/js-netpack.c | build
	$(CC) $(CFLAGS) -fvisibility=hidden -I$(SKYNET_INC) -Iplatform -I3rd/quickjs -c $< -o $@

# host compiler used to precompile the JS runtime libraries into bytecode
# (quickjs-libc provides the std helpers qjsc references).
# NOTE: kept below the `all` rule so plain `make` still builds everything.
build/qjsc: 3rd/quickjs/qjsc.c 3rd/quickjs/quickjs-libc.c $(QJS_OBJ) | build
	$(CC) $(CFLAGS) -I3rd/quickjs -o $@ 3rd/quickjs/qjsc.c 3rd/quickjs/quickjs-libc.c $(QJS_OBJ) -lm

# embedded bytecode of js/skynet.js + js/socket.js + js/cluster.js +
# js/gateserver.js: snjs loads these instead of parsing the sources per
# service. Regenerated whenever the sources or the quickjs submodule move;
# never committed.
build/rt_bc.c: build/qjsc js/skynet.js js/socket.js js/cluster.js js/gateserver.js | build
	./build/qjsc -s -N snjs_bc_skynet -o build/bc_skynet.c js/skynet.js
	./build/qjsc -s -N snjs_bc_socket -o build/bc_socket.c js/socket.js
	./build/qjsc -s -N snjs_bc_cluster -o build/bc_cluster.c js/cluster.js
	./build/qjsc -s -N snjs_bc_gateserver -o build/bc_gateserver.c js/gateserver.js
	cat build/bc_skynet.c build/bc_socket.c build/bc_cluster.c build/bc_gateserver.c > $@

build/rt_bc.o: build/rt_bc.c | build
	$(CC) $(CFLAGS) -c $< -o $@

cservice/snjs.so: build/snjs.o build/seri.o build/netpack.o build/rt_bc.o $(QJS_OBJ) | cservice
	$(CC) $(CFLAGS) $(SHARED) -fvisibility=hidden -o $@ $^

# reference tool: original lua-seri.c linked with the stock Lua 5.5.1 shipped
# in 3rd/skynet's 3rd/lua (byte-exact ground truth for the seri format).
# The layout is flat, same as how the stock skynet Makefile consumes it; exclude
# the interpreter entry points lua.c/luac.c and the all-in-one onelua.c.
LUA_SRC := $(filter-out 3rd/skynet/3rd/lua/lua.c 3rd/skynet/3rd/lua/luac.c 3rd/skynet/3rd/lua/onelua.c,$(wildcard 3rd/skynet/3rd/lua/*.c))

test/seri_tool: test/seri_tool.c 3rd/skynet/lualib-src/lua-seri.c $(LUA_SRC)
	$(CC) $(CFLAGS) -I3rd/skynet/skynet-src -I3rd/skynet/lualib-src -I3rd/skynet/3rd/lua -o $@ test/seri_tool.c $(LUA_SRC) -lm

$(TARGET): $(SKYNET_OBJ) $(PLATFORM_OBJ)
	$(CC) $(CFLAGS) -o $@ $^ $(SKYNET_LIBS)

cservice/logger.so: 3rd/skynet/service-src/service_logger.c | cservice
	$(CC) $(CFLAGS) $(SHARED) $< -o $@ -I$(SKYNET_INC)

test/cservice/%.so: test/service-src/%.c | test/cservice
	$(CC) $(CFLAGS) $(SHARED) $< -o $@ -I$(SKYNET_INC)

cservice/skyclusterd.so: service-src/skyclusterd.c | cservice
	$(CC) $(CFLAGS) $(SHARED) -fvisibility=hidden $< -o $@ -I$(SKYNET_INC) -Iplatform

clean:
	rm -rf build $(TARGET) test/seri_tool cservice/*.so test/cservice/*.so

lint:
	node tools/lint.js js test/service tools

# acceptance suite: builds everything first, then drives all scenarios
# (see tools/run_tests.js header for the pass/fail model); seri_tool is a
# separate target because `all` does not build it
test: all test/seri_tool
	node tools/run_tests.js

# one-command interop acceptance against the stock Lua skynet node:
# builds the 3rd/skynet submodule, boots both nodes, asserts both directions
interop: all
	node tools/run_interop.js

# benchmark suite: skyjs vs stock skynet, three phases (core + cluster +
# socket, methodology + baseline in docs/bench.md); override with e.g.
# make bench PHASE=core REPEAT=5
PHASE ?= all
REPEAT ?= 3
bench: all
	node tools/run_bench.js --phase $(PHASE) --repeat $(REPEAT)

# long-run soak with memstat/RSS reconciliation (tools/run_longrun.js);
# default 30 minutes, override with e.g. make longrun DURATION=5
DURATION ?= 30
longrun: all
	node tools/run_longrun.js --minutes $(DURATION)

.PHONY: all clean lint test interop bench longrun
