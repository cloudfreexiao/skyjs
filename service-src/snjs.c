/*
 * service_snjs.c -- QuickJS service loader for skyjs (Lua-free skynet).
 *
 * Structure mirrors service_snlua.c / service_snluajit.c:
 *   snjs_create/_init/_release/_signal + a self-sent first message that
 *   triggers init (skynet_module ABI, see 3rd/skynet/skynet-src/skynet_module.c).
 *
 * Task 2 (sync form): every message calls the JS function
 *   dispatch(msg, session, source)
 * registered on globalThis by the service script. If dispatch returns a
 * string and the message had a session, it is sent back as PTYPE_RESPONSE.
 * Errors are reported to the caller as PTYPE_ERROR.
 *
 * Isolation: this .so statically embeds quickjs-ng compiled with
 * -fvisibility=hidden; only the four snjs_* ABI symbols are exported
 * (dlopen uses RTLD_GLOBAL, see skynet_module.c _try_open).
 *
 * Memory: JS_NewRuntime2(&mf, l) routes every QuickJS allocation through
 * a header-accounted allocator, so l->mem tracks the JS heap exactly and
 * l->mem_limit enforces skynet's memlimit semantics (allocation fails ->
 * JS throws OutOfMemory). js_memlimit config key sets the limit in bytes.
 *
 * Deadloop protection: JS_SetInterruptHandler + the "SIGNAL" command.
 * snjs_signal(0) arms the trap; the next interrupt-handler poll aborts the
 * running script with an "interrupted" error. (Unlike LuaJIT's count hook,
 * QuickJS polls the handler inside interpreted loops, so this actually
 * fires. Caveat: if the signal arrives while no JS code is running, the
 * trap stays armed and the next dispatched message is interrupted instead.)
 */

#include "skynet.h"
#include "skynet_server.h"
#include "skynet_socket.h"
#include "atomic.h"
#include "snjs_internal.h"

#include <quickjs.h>

#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define MODAPI __attribute__((visibility("default")))

#define DEFAULT_MEM_REPORT (1024 * 1024 * 32)
#define JS_HDR sizeof(struct js_block)

struct js_block {
	size_t size;	// total malloc'ed size including this header
};

/* js-seri.c extensions (Task 5) */
int js_seri_init(struct snjs *l);

/* ------------------------------------------------------------------ allocator */

static void
mem_report_check(struct snjs *l) {
	if (l->mem > l->mem_report) {
		l->mem_report *= 2;
		skynet_error(l->ctx, "JS memory warning %.2f M", (float)l->mem / (1024 * 1024));
	}
}

static void *
js_allocf(void *ud, size_t size) {
	struct snjs *l = ud;
	if (size == 0) {
		size = 1;
	}
	size_t total = size + JS_HDR;
	if (l->mem_limit != 0 && l->mem + total > l->mem_limit) {
		return NULL;
	}
	struct js_block *b = skynet_malloc(total);
	if (b == NULL) {
		return NULL;
	}
	b->size = total;
	l->mem += total;
	mem_report_check(l);
	return b + 1;
}

static void
js_releasef(void *ud, void *ptr) {
	struct snjs *l = ud;
	if (ptr == NULL) {
		return;
	}
	struct js_block *b = (struct js_block *)ptr - 1;
	l->mem -= b->size;
	skynet_free(b);
}

static void *
js_callocf(void *ud, size_t count, size_t size) {
	if (size != 0 && count > (size_t)-1 / size) {
		return NULL;
	}
	size_t total = count * size;
	void *p = js_allocf(ud, total);
	if (p) {
		memset(p, 0, total);
	}
	return p;
}

static void *
js_mallocf(void *ud, size_t size) {
	return js_allocf(ud, size);
}

static void
js_freef(void *ud, void *ptr) {
	js_releasef(ud, ptr);
}

static void *
js_reallocf(void *ud, void *ptr, size_t size) {
	struct snjs *l = ud;
	if (ptr == NULL) {
		return js_allocf(ud, size);
	}
	if (size == 0) {
		js_releasef(ud, ptr);
		return NULL;
	}
	struct js_block *b = (struct js_block *)ptr - 1;
	size_t total = size + JS_HDR;
	if (l->mem_limit != 0 && total > b->size && l->mem + (total - b->size) > l->mem_limit) {
		return NULL;	// original block stays valid, QuickJS throws OOM
	}
	struct js_block *nb = skynet_realloc(b, total);
	if (nb == NULL) {
		return NULL;
	}
	l->mem += total - nb->size;
	nb->size = total;
	mem_report_check(l);
	return nb + 1;
}

static size_t
js_usablef(const void *ptr) {
	if (ptr == NULL) {
		return 0;
	}
	const struct js_block *b = (const struct js_block *)ptr - 1;
	return b->size;
}

static const JSMallocFunctions js_mf = {
	js_callocf,
	js_mallocf,
	js_freef,
	js_reallocf,
	js_usablef,
};

/* ------------------------------------------------------------------ helpers */

static void
dump_exception(struct snjs *l, const char *where) {
	JSValue exc = JS_GetException(l->jsc);
	if (JS_IsNull(exc)) {
		skynet_error(l->ctx, "%s: unknown exception", where);
		return;
	}
	size_t len = 0;
	const char *s = JS_ToCStringLen(l->jsc, &len, exc);
	skynet_error(l->ctx, "%s: %s", where, s ? s : "(no message)");
	if (s) {
		JS_FreeCString(l->jsc, s);
	}
	JSValue stack = JS_GetPropertyStr(l->jsc, exc, "stack");
	if (JS_IsString(stack)) {
		s = JS_ToCStringLen(l->jsc, &len, stack);
		if (s) {
			skynet_error(l->ctx, "%s", s);
			JS_FreeCString(l->jsc, s);
		}
	}
	JS_FreeValue(l->jsc, stack);
	JS_FreeValue(l->jsc, exc);
}

// int_command: skynet_command results are ":hex" (REG/QUERY/LAUNCH) or decimal
// (TIMEOUT); mirror the lua intcommand behavior of skipping the leading ':'.
static int
intcmd(struct skynet_context *ctx, const char *cmd, const char *parm) {
	const char * r = skynet_command(ctx, cmd, parm);
	if (r == NULL) {
		return 0;
	}
	if (r[0] == ':') {
		return (int)strtoul(r + 1, NULL, 16);
	}
	return atoi(r);
}

static int
interrupt_handler(JSRuntime *rt, void *ud) {
	struct snjs *l = ud;
	(void)rt;
	if (ATOM_LOAD(&l->trap)) {
		ATOM_STORE(&l->trap, 0);
		// returning non-zero makes QuickJS throw "interrupted"
		return 1;
	}
	return 0;
}

/* ------------------------------------------------------------------ bridge */

static struct snjs *
getinst(JSContext *ctx) {
	return JS_GetContextOpaque(ctx);
}

static JSValue
js_send(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
	struct snjs *l = getinst(ctx);
	(void)this_val;
	if (argc < 3) {
		return JS_ThrowTypeError(ctx, "skynetcore.send(dest, type, msg, session=0)");
	}
	int32_t dest, type, session = 0;
	if (JS_ToInt32(ctx, &dest, argv[0])) return JS_EXCEPTION;
	if (JS_ToInt32(ctx, &type, argv[1])) return JS_EXCEPTION;
	if (argc > 3 && JS_ToInt32(ctx, &session, argv[3])) return JS_EXCEPTION;
	void *buf = NULL;
	size_t sz = 0;
	if (JS_IsArrayBuffer(argv[2])) {
		// binary payloads (lua-seri) cross as ArrayBuffer
		uint8_t *p = JS_GetArrayBuffer(ctx, &sz, argv[2]);
		if (p == NULL) return JS_EXCEPTION;
		buf = skynet_malloc(sz);
		memcpy(buf, p, sz);
	} else if (!JS_IsUndefined(argv[2]) && !JS_IsNull(argv[2])) {
		size_t msz = 0;
		const char *msg = JS_ToCStringLen(ctx, &msz, argv[2]);
		if (msg == NULL) return JS_EXCEPTION;
		sz = msz;
		if (sz > 0) {
			buf = skynet_malloc(sz);
			memcpy(buf, msg, sz);
		}
		JS_FreeCString(ctx, msg);
	}
	int r = skynet_send(l->ctx, 0, (uint32_t)dest, type, session, buf, sz);
	return JS_NewInt32(ctx, r);
}

static JSValue
js_command(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
	struct snjs *l = getinst(ctx);
	(void)this_val;
	const char *cmd = JS_ToCString(ctx, argv[0]);
	if (cmd == NULL) return JS_EXCEPTION;
	const char *parm = NULL;
	if (argc > 1 && JS_IsString(argv[1])) {
		parm = JS_ToCString(ctx, argv[1]);
	}
	const char * r = skynet_command(l->ctx, cmd, parm);
	JSValue ret = r ? JS_NewString(ctx, r) : JS_NULL;
	JS_FreeCString(ctx, cmd);
	JS_FreeCString(ctx, parm);
	return ret;
}

static JSValue
js_intcommand(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
	struct snjs *l = getinst(ctx);
	(void)this_val;
	const char *cmd = JS_ToCString(ctx, argv[0]);
	if (cmd == NULL) return JS_EXCEPTION;
	const char *parm = NULL;
	if (argc > 1 && JS_IsString(argv[1])) {
		parm = JS_ToCString(ctx, argv[1]);
	}
	int r = intcmd(l->ctx, cmd, parm);
	JS_FreeCString(ctx, cmd);
	JS_FreeCString(ctx, parm);
	return JS_NewInt32(ctx, r);
}

static JSValue
js_genid(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
	struct snjs *l = getinst(ctx);
	(void)this_val; (void)argc; (void)argv;
	return JS_NewInt32(ctx, skynet_context_newsession(l->ctx));
}

static JSValue
js_now(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
	(void)this_val; (void)argc; (void)argv;
	return JS_NewInt64(ctx, (int64_t)skynet_now());
}

static JSValue
js_error(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
	struct snjs *l = getinst(ctx);
	(void)this_val;
	const char *msg = JS_ToCString(ctx, argv[0]);
	if (msg == NULL) return JS_EXCEPTION;
	skynet_error(l->ctx, "%s", msg);
	JS_FreeCString(ctx, msg);
	return JS_UNDEFINED;
}

static JSValue
js_mem(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
	struct snjs *l = getinst(ctx);
	(void)this_val; (void)argc; (void)argv;
	return JS_NewFloat64(ctx, (double)l->mem);
}

// response(session, source, msg): reply to a caller from JS (used by __snjs_wrap
// and skynet.call internals). The message is copied; DONTCOPY semantics.
// msg may be a string or an ArrayBuffer (lua-seri payloads).
static JSValue
js_response(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
	struct snjs *l = getinst(ctx);
	(void)this_val;
	int32_t session;
	uint32_t source;
	if (JS_ToInt32(ctx, &session, argv[0])) return JS_EXCEPTION;
	if (JS_ToUint32(ctx, &source, argv[1])) return JS_EXCEPTION;
	void *buf = NULL;
	size_t sz = 0;
	if (JS_IsArrayBuffer(argv[2])) {
		uint8_t *p = JS_GetArrayBuffer(ctx, &sz, argv[2]);
		if (p == NULL) return JS_EXCEPTION;
		buf = skynet_malloc(sz);
		memcpy(buf, p, sz);
	} else if (!JS_IsUndefined(argv[2]) && !JS_IsNull(argv[2])) {
		const char *msg = JS_ToCStringLen(ctx, &sz, argv[2]);
		if (msg == NULL) return JS_EXCEPTION;
		if (sz > 0) {
			buf = skynet_malloc(sz);
			memcpy(buf, msg, sz);
		}
		JS_FreeCString(ctx, msg);
	}
	skynet_send(l->ctx, 0, source, PTYPE_RESPONSE | PTYPE_TAG_DONTCOPY, session, buf, sz);
	return JS_UNDEFINED;
}

// error_response(session, source): reject a pending call with PTYPE_ERROR
static JSValue
js_error_response(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
	struct snjs *l = getinst(ctx);
	(void)this_val;
	int32_t session;
	uint32_t source;
	if (JS_ToInt32(ctx, &session, argv[0])) return JS_EXCEPTION;
	if (JS_ToUint32(ctx, &source, argv[1])) return JS_EXCEPTION;
	skynet_send(l->ctx, 0, source, PTYPE_ERROR, session, NULL, 0);
	return JS_UNDEFINED;
}

/* ------------------------------------------------------- socket bridge */

static JSValue
js_sock_listen(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
	struct snjs *l = getinst(ctx);
	(void)this_val;
	const char *host = JS_ToCString(ctx, argv[0]);
	if (host == NULL) return JS_EXCEPTION;
	int32_t port, backlog = 64;
	if (JS_ToInt32(ctx, &port, argv[1])) { JS_FreeCString(ctx, host); return JS_EXCEPTION; }
	if (argc > 2) JS_ToInt32(ctx, &backlog, argv[2]);
	int id = skynet_socket_listen(l->ctx, host, port, backlog);
	JS_FreeCString(ctx, host);
	return JS_NewInt32(ctx, id);
}

static JSValue
js_sock_connect(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
	struct snjs *l = getinst(ctx);
	(void)this_val;
	const char *host = JS_ToCString(ctx, argv[0]);
	if (host == NULL) return JS_EXCEPTION;
	int32_t port;
	if (JS_ToInt32(ctx, &port, argv[1])) { JS_FreeCString(ctx, host); return JS_EXCEPTION; }
	int id = skynet_socket_connect(l->ctx, host, port);
	JS_FreeCString(ctx, host);
	return JS_NewInt32(ctx, id);
}

static JSValue
js_sock_start(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
	struct snjs *l = getinst(ctx);
	(void)this_val; (void)argc;
	int32_t id;
	if (JS_ToInt32(ctx, &id, argv[0])) return JS_EXCEPTION;
	skynet_socket_start(l->ctx, id);
	return JS_UNDEFINED;
}

// send(id, data): buffer ownership transfers to the socket layer
static JSValue
js_sock_send(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
	struct snjs *l = getinst(ctx);
	(void)this_val;
	int32_t id;
	if (JS_ToInt32(ctx, &id, argv[0])) return JS_EXCEPTION;
	size_t sz = 0;
	const char *data = JS_ToCStringLen(ctx, &sz, argv[1]);
	if (data == NULL) return JS_EXCEPTION;
	void *buf = skynet_malloc(sz);
	memcpy(buf, data, sz);
	JS_FreeCString(ctx, data);
	int r = skynet_socket_send(l->ctx, id, buf, (int)sz);
	return JS_NewInt32(ctx, r);
}

static JSValue
js_sock_close(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
	struct snjs *l = getinst(ctx);
	(void)this_val; (void)argc;
	int32_t id;
	if (JS_ToInt32(ctx, &id, argv[0])) return JS_EXCEPTION;
	skynet_socket_close(l->ctx, id);
	return JS_UNDEFINED;
}

static JSValue
js_sock_shutdown(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
	struct snjs *l = getinst(ctx);
	(void)this_val; (void)argc;
	int32_t id;
	if (JS_ToInt32(ctx, &id, argv[0])) return JS_EXCEPTION;
	skynet_socket_shutdown(l->ctx, id);
	return JS_UNDEFINED;
}

static void
register_bridge(struct snjs *l) {
	JSValue obj = JS_NewObject(l->jsc);
	JS_SetPropertyStr(l->jsc, obj, "send", JS_NewCFunction(l->jsc, js_send, "send", 4));
	JS_SetPropertyStr(l->jsc, obj, "command", JS_NewCFunction(l->jsc, js_command, "command", 2));
	JS_SetPropertyStr(l->jsc, obj, "int_command", JS_NewCFunction(l->jsc, js_intcommand, "int_command", 2));
	JS_SetPropertyStr(l->jsc, obj, "gen_id", JS_NewCFunction(l->jsc, js_genid, "gen_id", 0));
	JS_SetPropertyStr(l->jsc, obj, "now", JS_NewCFunction(l->jsc, js_now, "now", 0));
	JS_SetPropertyStr(l->jsc, obj, "error", JS_NewCFunction(l->jsc, js_error, "error", 1));
	JS_SetPropertyStr(l->jsc, obj, "mem", JS_NewCFunction(l->jsc, js_mem, "mem", 0));
	JS_SetPropertyStr(l->jsc, obj, "response", JS_NewCFunction(l->jsc, js_response, "response", 3));
	JS_SetPropertyStr(l->jsc, obj, "error_response", JS_NewCFunction(l->jsc, js_error_response, "error_response", 2));
	JSValue sock = JS_NewObject(l->jsc);
	JS_SetPropertyStr(l->jsc, sock, "listen", JS_NewCFunction(l->jsc, js_sock_listen, "listen", 3));
	JS_SetPropertyStr(l->jsc, sock, "connect", JS_NewCFunction(l->jsc, js_sock_connect, "connect", 2));
	JS_SetPropertyStr(l->jsc, sock, "start", JS_NewCFunction(l->jsc, js_sock_start, "start", 1));
	JS_SetPropertyStr(l->jsc, sock, "send", JS_NewCFunction(l->jsc, js_sock_send, "send", 2));
	JS_SetPropertyStr(l->jsc, sock, "close", JS_NewCFunction(l->jsc, js_sock_close, "close", 1));
	JS_SetPropertyStr(l->jsc, sock, "shutdown", JS_NewCFunction(l->jsc, js_sock_shutdown, "shutdown", 1));
	JS_SetPropertyStr(l->jsc, obj, "socket", sock);
	// js-seri extensions (pack/unpack/io, see js-seri.c)
	JS_SetPropertyStr(l->jsc, obj, "pack", JS_NewCFunction(l->jsc, js_seri_pack, "pack", 0));
	JS_SetPropertyStr(l->jsc, obj, "unpack", JS_NewCFunction(l->jsc, js_seri_unpack, "unpack", 1));
	JS_SetPropertyStr(l->jsc, obj, "read_file", JS_NewCFunction(l->jsc, js_seri_readfile, "read_file", 1));
	JS_SetPropertyStr(l->jsc, obj, "write_file", JS_NewCFunction(l->jsc, js_seri_writefile, "write_file", 2));
	JS_SetPropertyStr(l->jsc, obj, "str", JS_NewCFunction(l->jsc, js_seri_ab2str, "str", 1));
	JSValue g = JS_GetGlobalObject(l->jsc);
	JS_SetPropertyStr(l->jsc, g, "skynetcore", obj);
	JS_FreeValue(l->jsc, g);
}

/* ------------------------------------------------------------------ worker */

static int
worker_cb(struct skynet_context *ctx, void *ud, int type, int session, uint32_t source, const void *msg, size_t sz) {
	struct snjs *l = ud;
	JSValue payload;
	// the runtime may have been created on another worker thread (a nested
	// LAUNCH during a foreign dispatch): re-anchor stack_top so QuickJS's
	// stack-overflow check is measured against THIS thread's stack
	JS_UpdateStackTop(l->rt);
	if (type == PTYPE_SOCKET) {
		// skynet_socket_message: {type, id, ud, buffer}; buffer points into the
		// socket thread's rx buffer (DATA) or is NULL with text at sm+1 (padding)
		struct skynet_socket_message *sm = (struct skynet_socket_message *)msg;
		payload = JS_NewObject(l->jsc);
		JS_SetPropertyStr(l->jsc, payload, "type", JS_NewInt32(l->jsc, sm->type));
		JS_SetPropertyStr(l->jsc, payload, "id", JS_NewInt32(l->jsc, sm->id));
		JS_SetPropertyStr(l->jsc, payload, "ud", JS_NewInt32(l->jsc, sm->ud));
		if (sm->buffer != NULL) {
			JS_SetPropertyStr(l->jsc, payload, "data", JS_NewStringLen(l->jsc, sm->buffer, sm->ud));
		} else if (sz > sizeof(*sm)) {
			JS_SetPropertyStr(l->jsc, payload, "data", JS_NewString(l->jsc, (const char *)(sm + 1)));
		} else {
			JS_SetPropertyStr(l->jsc, payload, "data", JS_NULL);
		}
	} else if (type == PTYPE_RESERVED_LUA || type == PTYPE_RESPONSE) {
		// binary-safe: lua payloads and responses to lua calls cross as
		// ArrayBuffer; skynet.js decodes text responses per call protocol
		payload = JS_NewArrayBufferCopy(l->jsc, msg ? (const uint8_t *)msg : (const uint8_t *)"", sz);
	} else {
		payload = JS_NewStringLen(l->jsc, msg ? (const char *)msg : "", sz);
	}
	JSValueConst argv[4] = {
		payload,
		JS_NewInt32(l->jsc, session),
		JS_NewUint32(l->jsc, source),
		JS_NewInt32(l->jsc, type),
	};
	if (JS_IsException(argv[0])) {
		dump_exception(l, "snjs: can't build message");
		return 0;
	}
	JSValue ret = JS_Call(l->jsc, l->dispatch, JS_UNDEFINED, 4, argv);
	JS_FreeValue(l->jsc, argv[0]);
	if (JS_IsException(ret)) {
		dump_exception(l, "snjs dispatch error");
		if (session != 0) {
			skynet_send(ctx, 0, source, PTYPE_ERROR, session, NULL, 0);
		}
	} else if (!l->js_managed && session != 0) {
		// legacy sync form (no skynet.js loader): string result -> response
		size_t rsz = 0;
		const char *r = JS_ToCStringLen(l->jsc, &rsz, ret);
		if (r != NULL && rsz > 0) {
			char *buf = skynet_malloc(rsz);
			memcpy(buf, r, rsz);
			skynet_send(ctx, 0, source, PTYPE_RESPONSE | PTYPE_TAG_DONTCOPY, session, buf, rsz);
			JS_FreeCString(l->jsc, r);
		}
	}
	JS_FreeValue(l->jsc, ret);
	// drive pending microtasks: every await point hangs on an external event,
	// so this loop terminates before returning the worker thread to skynet.
	JSContext *c1;
	while (JS_ExecutePendingJob(l->rt, &c1) > 0) {
	}
	return 0;
}

/* ------------------------------------------------------------------ launch */

static char *
read_file(const char *path) {
	FILE * f = fopen(path, "rb");
	if (f == NULL) {
		return NULL;
	}
	fseek(f, 0, SEEK_END);
	long sz = ftell(f);
	fseek(f, 0, SEEK_SET);
	if (sz < 0) {
		fclose(f);
		return NULL;
	}
	char * buf = skynet_malloc(sz + 1);
	size_t rd = fread(buf, 1, sz, f);
	fclose(f);
	buf[rd] = '\0';
	return buf;
}

static const char *
optstring(struct skynet_context *ctx, const char *key, const char * str) {
	const char * ret = skynet_command(ctx, "GETENV", key);
	return ret ? ret : str;
}

/*
 * Embedded bytecode of the default runtime libraries (generated by the
 * Makefile via qjsc from js/skynet.js, js/socket.js, js/cluster.js; see
 * build/rt_bc.c). Loading bytecode skips the per-service parse cost and the
 * retained source text. A non-default js_loader/js_socket/js_cluster env
 * value falls back to source eval, as does an unreadable bytecode blob
 * (submodule/version skew) -- behaviour stays identical either way.
 */
extern const uint8_t snjs_bc_skynet[];
extern const uint32_t snjs_bc_skynet_size;
extern const uint8_t snjs_bc_socket[];
extern const uint32_t snjs_bc_socket_size;
extern const uint8_t snjs_bc_cluster[];
extern const uint32_t snjs_bc_cluster_size;

static const uint8_t *
embedded_runtime_bc(const char *path, size_t *len) {
	if (strcmp(path, "./js/skynet.js") == 0) {
		*len = snjs_bc_skynet_size;
		return snjs_bc_skynet;
	}
	if (strcmp(path, "./js/socket.js") == 0) {
		*len = snjs_bc_socket_size;
		return snjs_bc_socket;
	}
	if (strcmp(path, "./js/cluster.js") == 0) {
		*len = snjs_bc_cluster_size;
		return snjs_bc_cluster;
	}
	return NULL;
}

/*
 * Evaluate one runtime library. Returns 1 when it was loaded, 0 when the
 * file was absent (optional loader skipped, matching the original
 * read_file behaviour) and -1 on a fatal evaluation error (exception
 * already dumped).
 */
static int
eval_runtime(struct snjs *l, const char *path, const char *where) {
	size_t blen = 0;
	const uint8_t *bc = embedded_runtime_bc(path, &blen);
	if (bc != NULL) {
		JSValue fun = JS_ReadObject(l->jsc, bc, blen, JS_READ_OBJ_BYTECODE);
		if (!JS_IsException(fun)) {
			JSValue ret = JS_EvalFunction(l->jsc, fun);   // consumes fun
			if (!JS_IsException(ret)) {
				JS_FreeValue(l->jsc, ret);
				return 1;
			}
			dump_exception(l, where);
			return -1;   // bytecode parsed but errored: a real failure
		}
		// version skew or corruption: discard and fall back to source
		JS_FreeValue(l->jsc, JS_GetException(l->jsc));
	}
	char *code = read_file(path);
	if (code == NULL) {
		return 0;   // optional loader absent
	}
	JSValue ret = JS_Eval(l->jsc, code, strlen(code), path, JS_EVAL_TYPE_GLOBAL);
	skynet_free(code);
	if (JS_IsException(ret)) {
		dump_exception(l, where);
		return -1;
	}
	JS_FreeValue(l->jsc, ret);
	return 1;
}

static int
init_cb(struct snjs *l, struct skynet_context *ctx, const char * args, size_t sz) {
	l->ctx = ctx;
	// see worker_cb: init may run on a worker whose stack differs from the
	// thread that called JS_NewRuntime2 (the nested-LAUNCH case)
	JS_UpdateStackTop(l->rt);

	const char *limit = optstring(ctx, "js_memlimit", NULL);
	if (limit) {
		l->mem_limit = (size_t)strtoull(limit, NULL, 10);
		if (l->mem_limit > 0) {
			JS_SetMemoryLimit(l->rt, l->mem_limit);
			skynet_error(ctx, "JS memlimit set to %.2f M", (float)l->mem_limit / (1024 * 1024));
		}
	}

	JS_SetInterruptHandler(l->rt, interrupt_handler, l);
	register_bridge(l);
	if (js_seri_init(l)) {
		dump_exception(l, "snjs seri init error");
		return 1;
	}

	// Preload the JS runtime core (skynet.js) unless overridden or absent.
	// Its presence switches the service to managed mode: responses are sent
	// from JS via __snjs_wrap, enabling async dispatch.
	const char *loader = optstring(ctx, "js_loader", "./js/skynet.js");
	int lr = eval_runtime(l, loader, "snjs loader error");
	if (lr < 0) return 1;
	if (lr > 0) l->js_managed = 1;

	// optional secondary loaders: socket bridge, cluster bridge
	if (eval_runtime(l, optstring(ctx, "js_socket", "./js/socket.js"), "snjs socket loader error") < 0) return 1;
	if (eval_runtime(l, optstring(ctx, "js_cluster", "./js/cluster.js"), "snjs cluster loader error") < 0) return 1;

	// args: "<script path> [param]"
	char tmp[512];
	size_t n = sz < sizeof(tmp) - 1 ? sz : sizeof(tmp) - 1;
	memcpy(tmp, args, n);
	tmp[n] = '\0';
	char *sp = strchr(tmp, ' ');
	const char *param = "";
	if (sp) {
		*sp = '\0';
		param = sp + 1;
	}

	char *code = read_file(tmp);
	if (code == NULL) {
		skynet_error(ctx, "snjs can't open script %s", tmp);
		return 1;
	}
	JSValue ret = JS_Eval(l->jsc, code, strlen(code), tmp, JS_EVAL_TYPE_GLOBAL);
	skynet_free(code);
	if (JS_IsException(ret)) {
		dump_exception(l, "snjs load error");
		return 1;
	}
	JS_FreeValue(l->jsc, ret);

	JSValue g = JS_GetGlobalObject(l->jsc);
	JS_SetPropertyStr(l->jsc, g, "snjs_param", JS_NewString(l->jsc, param));
	JSValue dispatch = JS_GetPropertyStr(l->jsc, g, "dispatch");
	if (!JS_IsFunction(l->jsc, dispatch)) {
		skynet_error(ctx, "snjs script %s must define globalThis.dispatch", tmp);
		JS_FreeValue(l->jsc, dispatch);
		JS_FreeValue(l->jsc, g);
		return 1;
	}
	l->dispatch = JS_DupValue(l->jsc, dispatch);
	if (l->js_managed) {
		// wrap the user-visible dispatch: owns response/error sending and
		// turns Promise results into replies after the pending jobs drain.
		JSValue wrap = JS_GetPropertyStr(l->jsc, g, "__snjs_wrap");
		if (JS_IsFunction(l->jsc, wrap)) {
			JSValueConst warg[1] = { dispatch };
			JSValue wrapped = JS_Call(l->jsc, wrap, JS_UNDEFINED, 1, warg);
			if (JS_IsException(wrapped)) {
				dump_exception(l, "snjs wrap error");
				return 1;
			}
			JS_FreeValue(l->jsc, l->dispatch);
			l->dispatch = JS_DupValue(l->jsc, wrapped);
			JS_FreeValue(l->jsc, wrapped);
		}
		JS_FreeValue(l->jsc, wrap);
	}
	JS_FreeValue(l->jsc, dispatch);
	JS_FreeValue(l->jsc, g);

	skynet_callback(ctx, l, worker_cb);
	return 0;
}

static int
launch_cb(struct skynet_context *ctx, void *ud, int type, int session, uint32_t source, const void *msg, size_t sz) {
	assert(type == 0 && session == 0);
	struct snjs *l = ud;
	skynet_callback(ctx, NULL, NULL);
	if (init_cb(l, ctx, msg ? (const char *)msg : "", sz)) {
		skynet_command(ctx, "EXIT", NULL);
	}
	return 0;
}

MODAPI int
snjs_init(struct snjs *l, struct skynet_context *ctx, const char * args) {
	int sz = strlen(args);
	char * tmp = skynet_malloc(sz);
	memcpy(tmp, args, sz);
	skynet_callback(ctx, l, launch_cb);
	const char * self = skynet_command(ctx, "REG", NULL);
	uint32_t handle_id = strtoul(self + 1, NULL, 16);
	skynet_send(ctx, 0, handle_id, PTYPE_TAG_DONTCOPY, 0, tmp, sz);
	return 0;
}

/* ------------------------------------------------------------------ ABI */

MODAPI struct snjs *
snjs_create(void) {
	struct snjs * l = skynet_malloc(sizeof(*l));
	memset(l, 0, sizeof(*l));
	l->mem_report = DEFAULT_MEM_REPORT;
	l->mem_limit = 0;
	l->dispatch = JS_UNDEFINED;
	l->map_entries_fn = JS_UNDEFINED;
	l->build_map_fn = JS_UNDEFINED;
	ATOM_INIT(&l->trap, 0);
	l->rt = JS_NewRuntime2(&js_mf, l);
	if (l->rt == NULL) {
		skynet_free(l);
		return NULL;
	}
	l->jsc = JS_NewContext(l->rt);
	if (l->jsc == NULL) {
		JS_FreeRuntime(l->rt);
		skynet_free(l);
		return NULL;
	}
	JS_SetContextOpaque(l->jsc, l);
	return l;
}

MODAPI void
snjs_release(struct snjs *l) {
	JS_FreeValue(l->jsc, l->dispatch);
	JS_FreeValue(l->jsc, l->map_entries_fn);
	JS_FreeValue(l->jsc, l->build_map_fn);
	JS_FreeContext(l->jsc);
	JS_FreeRuntime(l->rt);
	skynet_free(l);
}

MODAPI void
snjs_signal(struct snjs *l, int signal) {
	if (signal == 1) {
		skynet_error(l->ctx, "Current JS memory %.3f K", (float)l->mem / 1024);
	} else {
		// arm the interrupt trap; see file header comment
		ATOM_STORE(&l->trap, 1);
	}
}
