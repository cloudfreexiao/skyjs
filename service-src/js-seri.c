/*
 * js-seri.c -- lua-seri compatible binary serialization for skyjs (Task 5).
 *
 * The stream core (write_block/read_block and the type/cookie format) is
 * copied verbatim from 3rd/skynet/lualib-src/lua-seri.c so bytes match the
 * original byte for byte. The value walking is rewritten from the Lua stack
 * onto JSValue:
 *
 *   Lua nil      <-> JS null/undefined        (null values vanish, like Lua)
 *   boolean      <-> boolean
 *   integer      <-> number when |v| fits an exact double, else BigInt
 *   qword        <-> BigInt (always, preserves >2^53)
 *   real         <-> number (non-integer)
 *   string       <-> string (UTF-8; arbitrary binary needs ArrayBuffer in JS)
 *   table array  <-> JS Array (1-based, byte-compatible with Lua {10,20,30})
 *   table hash   <-> JS Map (keys keep number/string/BigInt type)
 *   userdata     <-> error (pointers never cross VMs)
 *
 * Map iteration is impossible through plain C property APIs, so the helpers
 * below are evaluated once in JS (js_seri_init) and called back from C.
 */

#include <quickjs.h>

#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "skynet.h"
#include "skynet_malloc.h"
#include "snjs_internal.h"

#define TYPE_NIL 0
#define TYPE_BOOLEAN 1
// hibits 0 false 1 true
#define TYPE_NUMBER 2
// hibits 0 : 0 , 1: byte, 2:word, 4: dword, 6: qword, 8 : double
#define TYPE_NUMBER_ZERO 0
#define TYPE_NUMBER_BYTE 1
#define TYPE_NUMBER_WORD 2
#define TYPE_NUMBER_DWORD 4
#define TYPE_NUMBER_QWORD 6
#define TYPE_NUMBER_REAL 8

#define TYPE_USERDATA 3
#define TYPE_SHORT_STRING 4
// hibits 0~31 : len
#define TYPE_LONG_STRING 5
#define TYPE_TABLE 6

#define MAX_COOKIE 32
#define COMBINE_TYPE(t, v) ((t) | (v) << 3)

#define BLOCK_SIZE 128
#define MAX_DEPTH 32

/* ----------------------------- stream core (verbatim from lua-seri.c) --- */

struct block {
	struct block *next;
	char buffer[BLOCK_SIZE];
};

struct write_block {
	struct block *head;
	struct block *current;
	int len;
	int ptr;
};

struct read_block {
	char *buffer;
	int len;
	int ptr;
};

inline static struct block *
blk_alloc(void) {
	struct block *b = skynet_malloc(sizeof(struct block));
	b->next = NULL;
	return b;
}

inline static void
wb_push(struct write_block *b, const void *buf, int sz) {
	const char *buffer = buf;
	if (b->ptr == BLOCK_SIZE) {
_again:
		b->current = b->current->next = blk_alloc();
		b->ptr = 0;
	}
	if (b->ptr <= BLOCK_SIZE - sz) {
		memcpy(b->current->buffer + b->ptr, buffer, sz);
		b->ptr += sz;
		b->len += sz;
	} else {
		int copy = BLOCK_SIZE - b->ptr;
		memcpy(b->current->buffer + b->ptr, buffer, copy);
		buffer += copy;
		b->len += copy;
		sz -= copy;
		goto _again;
	}
}

static void
wb_init(struct write_block *wb, struct block *b) {
	wb->head = b;
	assert(b->next == NULL);
	wb->len = 0;
	wb->current = wb->head;
	wb->ptr = 0;
}

static void
wb_free(struct write_block *wb) {
	struct block *blk = wb->head;
	blk = blk->next;	// the first block is on the stack
	while (blk) {
		struct block *next = blk->next;
		skynet_free(blk);
		blk = next;
	}
	wb->head = NULL;
	wb->current = NULL;
	wb->ptr = 0;
	wb->len = 0;
}

static void
rball_init(struct read_block *rb, char *buffer, int size) {
	rb->buffer = buffer;
	rb->len = size;
	rb->ptr = 0;
}

static const void *
rb_read(struct read_block *rb, int sz) {
	if (rb->len < sz) {
		return NULL;
	}
	int ptr = rb->ptr;
	rb->ptr += sz;
	rb->len -= sz;
	return rb->buffer + ptr;
}

/* ----------------------------- primitives (format-identical) ------------ */

inline static void
wb_nil(struct write_block *wb) {
	uint8_t n = TYPE_NIL;
	wb_push(wb, &n, 1);
}

inline static void
wb_boolean(struct write_block *wb, int boolean) {
	uint8_t n = COMBINE_TYPE(TYPE_BOOLEAN, boolean ? 1 : 0);
	wb_push(wb, &n, 1);
}

inline static void
wb_integer(struct write_block *wb, int64_t v) {
	int type = TYPE_NUMBER;
	if (v == 0) {
		uint8_t n = COMBINE_TYPE(type, TYPE_NUMBER_ZERO);
		wb_push(wb, &n, 1);
	} else if (v != (int32_t)v) {
		uint8_t n = COMBINE_TYPE(type, TYPE_NUMBER_QWORD);
		wb_push(wb, &n, 1);
		wb_push(wb, &v, sizeof(v));
	} else if (v < 0) {
		uint8_t n = COMBINE_TYPE(type, TYPE_NUMBER_DWORD);
		wb_push(wb, &n, 1);
		int32_t v32 = (int32_t)v;
		wb_push(wb, &v32, sizeof(v32));
	} else if (v < 0x100) {
		uint8_t n = COMBINE_TYPE(type, TYPE_NUMBER_BYTE);
		wb_push(wb, &n, 1);
		uint8_t byte = (uint8_t)v;
		wb_push(wb, &byte, sizeof(byte));
	} else if (v < 0x10000) {
		uint8_t n = COMBINE_TYPE(type, TYPE_NUMBER_WORD);
		wb_push(wb, &n, 1);
		uint16_t word = (uint16_t)v;
		wb_push(wb, &word, sizeof(word));
	} else {
		uint8_t n = COMBINE_TYPE(type, TYPE_NUMBER_DWORD);
		wb_push(wb, &n, 1);
		uint32_t v32 = (uint32_t)v;
		wb_push(wb, &v32, sizeof(v32));
	}
}

inline static void
wb_real(struct write_block *wb, double v) {
	uint8_t n = COMBINE_TYPE(TYPE_NUMBER, TYPE_NUMBER_REAL);
	wb_push(wb, &n, 1);
	wb_push(wb, &v, sizeof(v));
}

inline static void
wb_string(struct write_block *wb, const char *str, int len) {
	if (len < MAX_COOKIE) {
		uint8_t n = COMBINE_TYPE(TYPE_SHORT_STRING, len);
		wb_push(wb, &n, 1);
		if (len > 0) {
			wb_push(wb, str, len);
		}
	} else {
		uint8_t n;
		if (len < 0x10000) {
			n = COMBINE_TYPE(TYPE_LONG_STRING, 2);
			wb_push(wb, &n, 1);
			uint16_t x = (uint16_t)len;
			wb_push(wb, &x, 2);
		} else {
			n = COMBINE_TYPE(TYPE_LONG_STRING, 4);
			wb_push(wb, &n, 1);
			uint32_t x = (uint32_t)len;
			assert(x == len);
			wb_push(wb, &x, 4);
		}
		wb_push(wb, str, len);
	}
}

static int64_t
get_integer(struct read_block *rb, int cookie, bool *err) {
	*err = false;
	switch (cookie) {
	case TYPE_NUMBER_ZERO:
		return 0;
	case TYPE_NUMBER_BYTE: {
		const uint8_t *pn = (const uint8_t *)rb_read(rb, sizeof(uint8_t));
		if (pn == NULL) { *err = true; return 0; }
		return (int64_t)*pn;
	}
	case TYPE_NUMBER_WORD: {
		const uint16_t *pn = (const uint16_t *)rb_read(rb, sizeof(uint16_t));
		if (pn == NULL) { *err = true; return 0; }
		uint16_t n;
		memcpy(&n, pn, sizeof(n));
		return n;
	}
	case TYPE_NUMBER_DWORD: {
		const int32_t *pn = (const int32_t *)rb_read(rb, sizeof(int32_t));
		if (pn == NULL) { *err = true; return 0; }
		int32_t n;
		memcpy(&n, pn, sizeof(n));
		return n;
	}
	case TYPE_NUMBER_QWORD: {
		const int64_t *pn = (const int64_t *)rb_read(rb, sizeof(int64_t));
		if (pn == NULL) { *err = true; return 0; }
		int64_t n;
		memcpy(&n, pn, sizeof(n));
		return n;
	}
	default:
		*err = true;
		return 0;
	}
}

static double
get_real(struct read_block *rb, bool *err) {
	double n = 0;
	*err = false;
	const void *pn = rb_read(rb, sizeof(n));
	if (pn == NULL) {
		*err = true;
		return 0;
	}
	memcpy(&n, pn, sizeof(n));
	return n;
}

/* ----------------------------- pack ------------------------------------- */

static JSValue
seri_error(JSContext *ctx, struct write_block *b, const char *fmt, int line) {
	wb_free(b);
	return JS_ThrowTypeError(ctx, "seri error (%s:%d)", fmt, line);
}

static int
pack_one(JSContext *ctx, struct snjs *l, struct write_block *b, JSValueConst v, int depth);

// Object own enumerable string properties -> hash part
static int
pack_object(JSContext *ctx, struct snjs *l, struct write_block *b, JSValueConst v, int depth) {
	JSPropertyEnum *tab = NULL;
	uint32_t nprops = 0;
	if (JS_GetOwnPropertyNames(ctx, &tab, &nprops, v, JS_GPN_STRING_MASK | JS_GPN_ENUM_ONLY)) {
		return -1;
	}
	// hash-only table: still needs the TYPE_TABLE cookie header
	uint8_t hdr = COMBINE_TYPE(TYPE_TABLE, 0);
	wb_push(b, &hdr, 1);
	for (uint32_t i = 0; i < nprops; i++) {
		JSValue k = JS_AtomToValue(ctx, tab[i].atom);
		JSValue val = JS_GetProperty(ctx, v, tab[i].atom);
		int r1 = pack_one(ctx, l, b, k, depth + 1);
		int r2 = pack_one(ctx, l, b, val, depth + 1);
		JS_FreeValue(ctx, k);
		JS_FreeValue(ctx, val);
		if (r1 || r2) {
			JS_FreePropertyEnum(ctx, tab, nprops);
			return -1;
		}
	}
	JS_FreePropertyEnum(ctx, tab, nprops);
	wb_nil(b);
	return 0;
}

static int
pack_one(JSContext *ctx, struct snjs *l, struct write_block *b, JSValueConst v, int depth) {
	if (depth > MAX_DEPTH) {
		seri_error(ctx, b, "pack too deep", __LINE__);
		return -1;
	}
	if (JS_IsNull(v) || JS_IsUndefined(v)) {
		wb_nil(b);
		return 0;
	}
	if (JS_IsBigInt(v)) {
		int64_t iv;
		if (JS_ToInt64Ext(ctx, &iv, v)) return -1;
		wb_integer(b, iv);
		return 0;
	}
	if (JS_IsNumber(v)) {
		double dv;
		if (JS_ToFloat64(ctx, &dv, v)) return -1;
		// exact integers (|v| <= 2^53) take the integer path, like Lua 5.5
		const double LIMIT = 9007199254740992.0;
		if (dv >= -LIMIT && dv <= LIMIT && dv == (double)(int64_t)dv) {
			wb_integer(b, (int64_t)dv);
		} else {
			wb_real(b, dv);
		}
		return 0;
	}
	if (JS_IsBool(v)) {
		wb_boolean(b, JS_VALUE_GET_BOOL(v));
		return 0;
	}
	if (JS_IsString(v)) {
		size_t sz = 0;
		const char *s = JS_ToCStringLen(ctx, &sz, v);
		if (s == NULL) return -1;
		if (sz > 0x7fffffff) {
			JS_FreeCString(ctx, s);
			seri_error(ctx, b, "string too long", __LINE__);
			return -1;
		}
		wb_string(b, s, (int)sz);
		JS_FreeCString(ctx, s);
		return 0;
	}
	if (JS_IsArray(v)) {
		JSValue lenv = JS_GetPropertyStr(ctx, v, "length");
		int32_t arr_len = 0;
		JS_ToInt32(ctx, &arr_len, lenv);
		JS_FreeValue(ctx, lenv);
		if (arr_len < 0) {
			seri_error(ctx, b, "negative array length", __LINE__);
			return -1;
		}
		if (arr_len >= MAX_COOKIE - 1) {
			uint8_t n = COMBINE_TYPE(TYPE_TABLE, MAX_COOKIE - 1);
			wb_push(b, &n, 1);
			wb_integer(b, arr_len);
		} else {
			uint8_t n = COMBINE_TYPE(TYPE_TABLE, (uint8_t)arr_len);
			wb_push(b, &n, 1);
		}
		for (int32_t i = 0; i < arr_len; i++) {
			JSValue elem = JS_GetPropertyUint32(ctx, v, (uint32_t)i);
			int r = pack_one(ctx, l, b, elem, depth + 1);
			JS_FreeValue(ctx, elem);
			if (r) return -1;
		}
		wb_nil(b);	// hash terminator (empty hash part)
		return 0;
	}
	if (JS_IsObject(v)) {
		// Map? (C property APIs can't see Map slots; use the JS helper)
		JSValue entries = JS_Call(ctx, l->map_entries_fn, JS_UNDEFINED, 1, (JSValueConst *)&v);
		if (JS_IsException(entries)) return -1;
		if (!JS_IsNull(entries)) {
			// hash-only table: still needs the TYPE_TABLE cookie header
			uint8_t hdr = COMBINE_TYPE(TYPE_TABLE, 0);
			wb_push(b, &hdr, 1);
			JSValue lenv = JS_GetPropertyStr(ctx, entries, "length");
			int32_t n = 0;
			JS_ToInt32(ctx, &n, lenv);
			JS_FreeValue(ctx, lenv);
			for (int32_t i = 0; i < n; i++) {
				JSValue entry = JS_GetPropertyUint32(ctx, entries, (uint32_t)i);
				JSValue k = JS_GetPropertyUint32(ctx, entry, 0);
				JSValue val = JS_GetPropertyUint32(ctx, entry, 1);
				int r1 = pack_one(ctx, l, b, k, depth + 1);
				int r2 = pack_one(ctx, l, b, val, depth + 1);
				JS_FreeValue(ctx, k);
				JS_FreeValue(ctx, val);
				JS_FreeValue(ctx, entry);
				if (r1 || r2) {
					JS_FreeValue(ctx, entries);
					return -1;
				}
			}
			JS_FreeValue(ctx, entries);
			wb_nil(b);
			return 0;
		}
		JS_FreeValue(ctx, entries);
		return pack_object(ctx, l, b, v, depth);
	}
	seri_error(ctx, b, "unsupported type", __LINE__);
	return -1;
}

/* ----------------------------- unpack ----------------------------------- */

static JSValue
unpack_one(JSContext *ctx, struct snjs *l, struct read_block *rb);

static JSValue
unpack_table(JSContext *ctx, struct snjs *l, struct read_block *rb, int array_size) {
	if (array_size == MAX_COOKIE - 1) {
		const uint8_t *t = (const uint8_t *)rb_read(rb, sizeof(uint8_t));
		if (t == NULL) {
			return JS_ThrowTypeError(ctx, "Invalid serialize stream (%d)", __LINE__);
		}
		int type = *t & 0x7;
		int cookie = *t >> 3;
		if (type != TYPE_NUMBER || cookie == TYPE_NUMBER_REAL) {
			return JS_ThrowTypeError(ctx, "Invalid serialize stream (%d)", __LINE__);
		}
		bool err;
		int64_t n = get_integer(rb, cookie, &err);
		if (err) {
			return JS_ThrowTypeError(ctx, "Invalid serialize stream (%d)", __LINE__);
		}
		array_size = (int)n;
	}
	JSValue entries = JS_NewArray(ctx);
	int64_t idx = 0;
	for (int i = 0; i < array_size; i++) {
		// array part becomes Map keys 1..n (1-based, like Lua)
		JSValue e = unpack_one(ctx, l, rb);
		if (JS_IsException(e)) return e;
		JSValue pair = JS_NewArray(ctx);
		JS_SetPropertyUint32(ctx, pair, 0, JS_NewInt64(ctx, i + 1));
		JS_SetPropertyUint32(ctx, pair, 1, e);
		JS_SetPropertyUint32(ctx, entries, (uint32_t)idx++, pair);
	}
	for (;;) {
		JSValue k = unpack_one(ctx, l, rb);
		if (JS_IsException(k)) return k;
		if (JS_IsNull(k)) {
			JS_FreeValue(ctx, k);
			break;
		}
		JSValue v = unpack_one(ctx, l, rb);
		if (JS_IsException(v)) {
			JS_FreeValue(ctx, k);
			return v;
		}
		JSValue entry = JS_NewArray(ctx);
		JS_SetPropertyUint32(ctx, entry, 0, k);
		JS_SetPropertyUint32(ctx, entry, 1, v);
		JS_SetPropertyUint32(ctx, entries, (uint32_t)idx++, entry);
	}
	JSValue map = JS_Call(ctx, l->new_map_fn, JS_UNDEFINED, 1, (JSValueConst *)&entries);
	JS_FreeValue(ctx, entries);
	return map;
}

static JSValue
unpack_value(JSContext *ctx, struct snjs *l, struct read_block *rb, int type, int cookie) {
	switch (type) {
	case TYPE_NIL:
		return JS_NULL;
	case TYPE_BOOLEAN:
		return JS_NewBool(ctx, cookie);
	case TYPE_NUMBER:
		if (cookie == TYPE_NUMBER_REAL) {
			bool err;
			double d = get_real(rb, &err);
			if (err) return JS_ThrowTypeError(ctx, "Invalid serialize stream (%d)", __LINE__);
			return JS_NewFloat64(ctx, d);
		}
		{
			bool err;
			int64_t iv = get_integer(rb, cookie, &err);
			if (err) return JS_ThrowTypeError(ctx, "Invalid serialize stream (%d)", __LINE__);
			if (cookie == TYPE_NUMBER_QWORD) {
				return JS_NewBigInt64(ctx, iv);
			}
			return JS_NewInt64(ctx, iv);
		}
	case TYPE_USERDATA:
		return JS_ThrowTypeError(ctx, "seri: userdata can't cross VMs");
	case TYPE_SHORT_STRING: {
		const char *p = (const char *)rb_read(rb, cookie);
		if (p == NULL) return JS_ThrowTypeError(ctx, "Invalid serialize stream (%d)", __LINE__);
		return JS_NewStringLen(ctx, p, (size_t)cookie);
	}
	case TYPE_LONG_STRING: {
		uint32_t len;
		if (cookie == 2) {
			const uint16_t *plen = (const uint16_t *)rb_read(rb, 2);
			if (plen == NULL) return JS_ThrowTypeError(ctx, "Invalid serialize stream (%d)", __LINE__);
			uint16_t n;
			memcpy(&n, plen, sizeof(n));
			len = n;
		} else if (cookie == 4) {
			const uint32_t *plen = (const uint32_t *)rb_read(rb, 4);
			if (plen == NULL) return JS_ThrowTypeError(ctx, "Invalid serialize stream (%d)", __LINE__);
			uint32_t n;
			memcpy(&n, plen, sizeof(n));
			len = n;
		} else {
			return JS_ThrowTypeError(ctx, "Invalid serialize stream (%d)", __LINE__);
		}
		const char *p = (const char *)rb_read(rb, (int)len);
		if (p == NULL) return JS_ThrowTypeError(ctx, "Invalid serialize stream (%d)", __LINE__);
		return JS_NewStringLen(ctx, p, (size_t)len);
	}
	case TYPE_TABLE:
		return unpack_table(ctx, l, rb, cookie);
	default:
		return JS_ThrowTypeError(ctx, "Invalid serialize stream type %d", type);
	}
}

static JSValue
unpack_one(JSContext *ctx, struct snjs *l, struct read_block *rb) {
	const uint8_t *t = (const uint8_t *)rb_read(rb, sizeof(uint8_t));
	if (t == NULL) {
		return JS_ThrowTypeError(ctx, "Invalid serialize stream (%d)", __LINE__);
	}
	return unpack_value(ctx, l, rb, *t & 0x7, *t >> 3);
}

/* ----------------------------- JS bridge -------------------------------- */

// pack(...values) -> ArrayBuffer
JSValue
js_seri_pack(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
	struct snjs *l = JS_GetContextOpaque(ctx);
	(void)this_val;
	struct block temp;
	temp.next = NULL;
	struct write_block wb;
	wb_init(&wb, &temp);
	for (int i = 0; i < argc; i++) {
		if (pack_one(ctx, l, &wb, argv[i], 0)) {
			return JS_EXCEPTION;
		}
	}
	int len = wb.len;
	if (len < 0) {
		wb_free(&wb);
		return JS_ThrowTypeError(ctx, "seri too large");
	}
	uint8_t *buffer = skynet_malloc(len);
	uint8_t *ptr = buffer;
	struct block *b = &temp;
	int remain = len;
	while (remain > 0) {
		int sz = remain > BLOCK_SIZE ? BLOCK_SIZE : remain;
		memcpy(ptr, b->buffer, sz);
		ptr += sz;
		remain -= sz;
		b = b->next;
	}
	wb_free(&wb);
	JSValue ab = JS_NewArrayBufferCopy(ctx, buffer, (size_t)len);
	skynet_free(buffer);
	return ab;
}

// unpack(ArrayBuffer | string) -> Array of values
JSValue
js_seri_unpack(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
	struct snjs *l = JS_GetContextOpaque(ctx);
	(void)this_val;
	char *buffer = NULL;
	int len = 0;
	size_t bsz = 0;
	if (JS_IsArrayBuffer(argv[0])) {
		uint8_t *p = JS_GetArrayBuffer(ctx, &bsz, argv[0]);
		if (p == NULL) return JS_EXCEPTION;
		buffer = (char *)p;
		len = (int)bsz;
	} else if (JS_IsString(argv[0])) {
		size_t ssz = 0;
		const char *s = JS_ToCStringLen(ctx, &ssz, argv[0]);
		if (s == NULL) return JS_EXCEPTION;
		buffer = skynet_malloc(ssz);
		memcpy(buffer, s, ssz);
		JS_FreeCString(ctx, s);
		len = (int)ssz;
	} else {
		return JS_ThrowTypeError(ctx, "unpack expects ArrayBuffer or string");
	}
	if (len == 0) {
		if (buffer != (char *)0 && JS_IsString(argv[0])) skynet_free(buffer);
		return JS_NewArray(ctx);
	}
	struct read_block rb;
	rball_init(&rb, buffer, len);
	JSValue out = JS_NewArray(ctx);
	int64_t idx = 0;
	for (;;) {
		const uint8_t *t = (const uint8_t *)rb_read(&rb, sizeof(uint8_t));
		if (t == NULL) break;
		JSValue v = unpack_value(ctx, l, &rb, *t & 0x7, *t >> 3);
		if (JS_IsException(v)) {
			JS_FreeValue(ctx, out);
			if (JS_IsString(argv[0])) skynet_free(buffer);
			return v;
		}
		JS_SetPropertyUint32(ctx, out, (uint32_t)idx++, v);
	}
	if (JS_IsString(argv[0])) skynet_free(buffer);
	return out;
}

// readfile(path) -> ArrayBuffer (acceptance/testing aid)
JSValue
js_seri_readfile(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
	(void)this_val; (void)argc;
	const char *path = JS_ToCString(ctx, argv[0]);
	if (path == NULL) return JS_EXCEPTION;
	FILE *f = fopen(path, "rb");
	if (f == NULL) {
		JS_FreeCString(ctx, path);
		return JS_ThrowTypeError(ctx, "can't open %s", path);
	}
	fseek(f, 0, SEEK_END);
	long sz = ftell(f);
	fseek(f, 0, SEEK_SET);
	JSValue ret = JS_NULL;
	if (sz >= 0) {
		uint8_t *buf = skynet_malloc(sz);
		size_t rd = fread(buf, 1, sz, f);
		ret = JS_NewArrayBufferCopy(ctx, buf, rd);
		skynet_free(buf);
	}
	fclose(f);
	JS_FreeCString(ctx, path);
	return ret;
}

// writefile(path, ArrayBuffer)
JSValue
js_seri_writefile(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
	(void)this_val; (void)argc;
	const char *path = JS_ToCString(ctx, argv[0]);
	if (path == NULL) return JS_EXCEPTION;
	size_t sz = 0;
	uint8_t *p = JS_GetArrayBuffer(ctx, &sz, argv[1]);
	if (p == NULL) {
		JS_FreeCString(ctx, path);
		return JS_EXCEPTION;
	}
	FILE *f = fopen(path, "wb");
	if (f == NULL) {
		JS_FreeCString(ctx, path);
		return JS_ThrowTypeError(ctx, "can't write %s", path);
	}
	fwrite(p, 1, sz, f);
	fclose(f);
	JS_FreeCString(ctx, path);
	return JS_UNDEFINED;
}

// ab2str(ArrayBuffer) -> string (UTF-8 decode of raw bytes)
JSValue
js_seri_ab2str(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
	(void)this_val; (void)argc;
	size_t sz = 0;
	uint8_t *p = JS_GetArrayBuffer(ctx, &sz, argv[0]);
	if (p == NULL) return JS_EXCEPTION;
	return JS_NewStringLen(ctx, (const char *)p, sz);
}

// evaluated once in JS: Map detection/iteration helpers
static const char *seri_helpers_js =
	"globalThis.__snjs_seri = {\n"
	"    entries: function (m) { return (m instanceof Map) ? Array.from(m.entries()) : null; },\n"
	"    newmap: function (entries) { const m = new Map(); for (const e of entries) m.set(e[0], e[1]); return m; },\n"
	"};\n";

int
js_seri_init(struct snjs *l) {
	JSValue ret = JS_Eval(l->jsc, seri_helpers_js, strlen(seri_helpers_js), "<seri>", JS_EVAL_TYPE_GLOBAL);
	if (JS_IsException(ret)) {
		return -1;
	}
	JS_FreeValue(l->jsc, ret);
	JSValue g = JS_GetGlobalObject(l->jsc);
	JSValue obj = JS_GetPropertyStr(l->jsc, g, "__snjs_seri");
	JS_FreeValue(l->jsc, g);
	JSValue entries_fn = JS_GetPropertyStr(l->jsc, obj, "entries");
	JSValue new_map_fn = JS_GetPropertyStr(l->jsc, obj, "newmap");
	l->map_entries_fn = JS_DupValue(l->jsc, entries_fn);
	l->new_map_fn = JS_DupValue(l->jsc, new_map_fn);
	JS_FreeValue(l->jsc, entries_fn);
	JS_FreeValue(l->jsc, new_map_fn);
	JS_FreeValue(l->jsc, obj);
	return 0;
}
