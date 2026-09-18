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

all: $(TARGET) cservice/logger.so cservice/snjs.so test/cservice/echo.so test/cservice/driver.so

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

cservice/snjs.so: build/snjs.o build/seri.o $(QJS_OBJ) | cservice
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

.PHONY: all clean
