#ifndef SNJS_INTERNAL_H
#define SNJS_INTERNAL_H

/*
 * Shared internal state of the snjs service module. snjs.c owns the struct;
 * js-seri.c (and later extensions) attach to it. Not part of the module ABI:
 * only snjs_* symbols are exported.
 */

#include <quickjs.h>
#include "atomic.h"

struct skynet_context;

struct snjs {
	JSRuntime *rt;
	JSContext *jsc;
	struct skynet_context *ctx;   // declared in skynet.h/skynet_server.h
	size_t mem;
	size_t mem_report;
	size_t mem_limit;
	ATOM_INT trap;
	JSValue dispatch;
	int js_managed;   // skynet.js loaded: responses are sent from JS (__snjs_wrap)

	// js-seri helpers (evaluated in js_seri_init)
	JSValue map_entries_fn;   // (m) => Array<[k,v]> | null
	JSValue new_map_fn;       // (entries) => Map
};

// js-seri.c exports (used by snjs.c's register_bridge and init)
int js_seri_init(struct snjs *l);
JSValue js_seri_pack(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv);
JSValue js_seri_unpack(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv);
JSValue js_seri_readfile(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv);
JSValue js_seri_writefile(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv);
JSValue js_seri_ab2str(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv);

#endif
