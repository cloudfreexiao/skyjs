/*
 * js-tls.c -- TLS 1.3 bridge for SkyJS via OpenSSL BIO_mem.
 * Compiled only when USE_OPENSSL is defined (make TLS=openssl).
 * Architecture ported from 3rd/skynet/lualib-src/ltls.c but modernised
 * for OpenSSL 3.x and QuickJS opaque-object lifecycle.
 *
 * Registered as skynetcore.tls namespace (see register_tls_bridge).
 */

#include <quickjs.h>
#include <stdint.h>
#include <string.h>
#include <openssl/ssl.h>
#include <openssl/err.h>
#include <openssl/bio.h>
#include <openssl/x509.h>
#include "skynet.h"
#include "snjs_internal.h"

/* ================================================================
 * Opaque types wrapped in QuickJS objects with release callbacks
 * ================================================================ */

struct ssl_ctx_ud {
	SSL_CTX *ctx;
};

struct tls_context_ud {
	SSL *ssl;
	BIO *in_bio;
	BIO *out_bio;
	int is_server;
	int is_close;
};

/* QuickJS class IDs for opaque wrapping */
static JSClassID js_ssl_ctx_class_id = 0;
static JSClassID js_tls_ctx_class_id = 0;

/* ---- Release callbacks (invoked by GC) ---- */

static void ssl_ctx_finalizer(JSRuntime *rt, JSValue val) {
	(void)rt;
	struct ssl_ctx_ud *ud = JS_GetOpaque(val, js_ssl_ctx_class_id);
	if (ud && ud->ctx) {
		SSL_CTX_free(ud->ctx);
		ud->ctx = NULL;
	}
}

static void tls_context_finalizer(JSRuntime *rt, JSValue val) {
	(void)rt;
	struct tls_context_ud *ud = JS_GetOpaque(val, js_tls_ctx_class_id);
	if (ud && !ud->is_close) {
		SSL_free(ud->ssl);  /* also frees associated BIOs */
		ud->ssl = NULL;
		ud->in_bio = NULL;
		ud->out_bio = NULL;
		ud->is_close = 1;
	}
}

static JSClassDef js_ssl_ctx_class = {
	"SSLCtx",
	.finalizer = ssl_ctx_finalizer,
};

static JSClassDef js_tls_ctx_class = {
	"TLSContext",
	.finalizer = tls_context_finalizer,
};

/* ---- Helper: read all pending out_bio data into an ArrayBuffer ---- */
static JSValue bio_read_output(JSContext *ctx, BIO *out_bio) {
	int pending = BIO_ctrl_pending(out_bio);
	if (pending <= 0) return JS_NULL;

	uint8_t *buf = skynet_malloc(pending);
	int total = 0;
	while (pending > 0) {
		int r = BIO_read(out_bio, buf + total, pending);
		if (r <= 0) break;
		total += r;
		pending = BIO_ctrl_pending(out_bio);
	}
	if (total <= 0) {
		skynet_free(buf);
		return JS_NULL;
	}
	JSValue ret = JS_NewArrayBufferCopy(ctx, buf, total);
	skynet_free(buf);
	return ret;
}

/* ---- Helper: write all data to in_bio ---- */
static int bio_write_input(JSContext *ctx, BIO *in_bio, const uint8_t *data, size_t len) {
	(void)ctx;
	const uint8_t *p = data;
	size_t remaining = len;
	while (remaining > 0) {
		int w = BIO_write(in_bio, p, (int)remaining);
		if (w <= 0) return -1;
		p += w;
		remaining -= w;
	}
	return 0;
}

/* ================================================================
 * TLS bridge functions (registered on skynetcore.tls)
 * ================================================================ */

static ATOM_INT tls_is_init = 0;

/* tls.init() — idempotent OpenSSL initialization */
static JSValue js_tls_init(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
	(void)tv; (void)argc; (void)argv;
	if (ATOM_CAS(&tls_is_init, 0, 1)) {
		/* OpenSSL 3.x auto-inits; for 1.1.x compat do explicit init */
#if OPENSSL_VERSION_NUMBER < 0x10100000L
		SSL_library_init();
		SSL_load_error_strings();
		OpenSSL_add_all_algorithms();
#endif
	}
	return JS_UNDEFINED;
}

/* tls.ctx_new(is_server: boolean) → opaque */
static JSValue js_tls_ctx_new(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
	(void)tv; (void)argc;
	int is_server = JS_ToBool(ctx, argv[0]);

	SSL_CTX *ssl_ctx = SSL_CTX_new(TLS_method());
	if (!ssl_ctx) {
		return JS_ThrowInternalError(ctx, "SSL_CTX_new failed");
	}

	/* TLS 1.2 minimum, TLS 1.3 preferred */
	SSL_CTX_set_min_proto_version(ssl_ctx, TLS1_2_VERSION);

	(void)is_server; /* method is generic TLS_method(); client/server state is set in newtls */

	struct ssl_ctx_ud *ud = js_mallocz(ctx, sizeof(*ud));
	if (!ud) {
		SSL_CTX_free(ssl_ctx);
		return JS_EXCEPTION;
	}
	ud->ctx = ssl_ctx;

	JSValue obj = JS_NewObjectClass(ctx, js_ssl_ctx_class_id);
	if (JS_IsException(obj)) {
		SSL_CTX_free(ssl_ctx);
		js_free(ctx, ud);
		return JS_EXCEPTION;
	}
	JS_SetOpaque(obj, ud);
	return obj;
}

/* tls.ctx_set_cert(ctx_obj, certfile: string, keyfile: string) */
static JSValue js_tls_ctx_set_cert(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
	(void)tv; (void)argc;
	struct ssl_ctx_ud *ud = JS_GetOpaque(argv[0], js_ssl_ctx_class_id);
	if (!ud || !ud->ctx) return JS_ThrowTypeError(ctx, "tls.ctx_set_cert: invalid ctx");

	const char *certfile = JS_ToCString(ctx, argv[1]);
	if (!certfile) return JS_EXCEPTION;
	const char *keyfile = JS_ToCString(ctx, argv[2]);
	if (!keyfile) { JS_FreeCString(ctx, certfile); return JS_EXCEPTION; }

	int ret = SSL_CTX_use_certificate_chain_file(ud->ctx, certfile);
	if (ret != 1) {
		JS_FreeCString(ctx, certfile);
		JS_FreeCString(ctx, keyfile);
		return JS_ThrowInternalError(ctx, "SSL_CTX_use_certificate_chain_file failed");
	}

	ret = SSL_CTX_use_PrivateKey_file(ud->ctx, keyfile, SSL_FILETYPE_PEM);
	JS_FreeCString(ctx, certfile);
	JS_FreeCString(ctx, keyfile);
	if (ret != 1) return JS_ThrowInternalError(ctx, "SSL_CTX_use_PrivateKey_file failed");

	ret = SSL_CTX_check_private_key(ud->ctx);
	if (ret != 1) return JS_ThrowInternalError(ctx, "SSL_CTX_check_private_key failed");

	return JS_UNDEFINED;
}

/* tls.ctx_set_verify(ctx_obj) — enable peer certificate verification */
static JSValue js_tls_ctx_set_verify(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
	(void)tv; (void)argc;
	struct ssl_ctx_ud *ud = JS_GetOpaque(argv[0], js_ssl_ctx_class_id);
	if (!ud || !ud->ctx) return JS_ThrowTypeError(ctx, "tls.ctx_set_verify: invalid ctx");

	SSL_CTX_set_default_verify_paths(ud->ctx);
	SSL_CTX_set_verify(ud->ctx, SSL_VERIFY_PEER, NULL);
	return JS_UNDEFINED;
}

/* tls.newtls(method: string, ctx_obj, hostname?: string) → opaque */
static JSValue js_tls_newtls(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
	(void)tv;
	const char *method = JS_ToCString(ctx, argv[0]);
	if (!method) return JS_EXCEPTION;

	struct ssl_ctx_ud *ctx_ud = JS_GetOpaque(argv[1], js_ssl_ctx_class_id);
	if (!ctx_ud || !ctx_ud->ctx) {
		JS_FreeCString(ctx, method);
		return JS_ThrowTypeError(ctx, "tls.newtls: invalid ssl ctx");
	}

	int is_server;
	if (strcmp(method, "client") == 0) {
		is_server = 0;
	} else if (strcmp(method, "server") == 0) {
		is_server = 1;
	} else {
		JS_FreeCString(ctx, method);
		return JS_ThrowTypeError(ctx, "tls.newtls: method must be 'client' or 'server'");
	}
	JS_FreeCString(ctx, method);

	SSL *ssl = SSL_new(ctx_ud->ctx);
	if (!ssl) return JS_ThrowInternalError(ctx, "SSL_new failed");

	BIO *in_bio = BIO_new(BIO_s_mem());
	BIO *out_bio = BIO_new(BIO_s_mem());
	if (!in_bio || !out_bio) {
		if (in_bio) BIO_free(in_bio);
		if (out_bio) BIO_free(out_bio);
		SSL_free(ssl);
		return JS_ThrowInternalError(ctx, "BIO_new failed");
	}
	BIO_set_mem_eof_return(in_bio, -1);
	BIO_set_mem_eof_return(out_bio, -1);
	SSL_set_bio(ssl, in_bio, out_bio);

	if (is_server) {
		SSL_set_accept_state(ssl);
	} else {
		SSL_set_connect_state(ssl);
		/* SNI: set hostname if provided */
		if (argc > 2 && JS_IsString(argv[2])) {
			const char *hostname = JS_ToCString(ctx, argv[2]);
			if (hostname) {
				SSL_set_tlsext_host_name(ssl, hostname);
				JS_FreeCString(ctx, hostname);
			}
		}
	}

	struct tls_context_ud *ud = js_mallocz(ctx, sizeof(*ud));
	if (!ud) {
		SSL_free(ssl);  /* frees BIOs too */
		return JS_EXCEPTION;
	}
	ud->ssl = ssl;
	ud->in_bio = in_bio;
	ud->out_bio = out_bio;
	ud->is_server = is_server;
	ud->is_close = 0;

	JSValue obj = JS_NewObjectClass(ctx, js_tls_ctx_class_id);
	if (JS_IsException(obj)) {
		SSL_free(ssl);
		js_free(ctx, ud);
		return JS_EXCEPTION;
	}
	JS_SetOpaque(obj, ud);
	return obj;
}

/* tls.handshake(session, data?: AB) → AB | null */
static JSValue js_tls_handshake(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
	(void)tv;
	struct tls_context_ud *ud = JS_GetOpaque(argv[0], js_tls_ctx_class_id);
	if (!ud || ud->is_close) return JS_ThrowTypeError(ctx, "tls.handshake: invalid session");

	/* feed incoming data if provided */
	if (argc > 1 && JS_IsArrayBuffer(argv[1])) {
		size_t sz;
		uint8_t *data = JS_GetArrayBuffer(ctx, &sz, argv[1]);
		if (data && sz > 0) {
			if (bio_write_input(ctx, ud->in_bio, data, sz) < 0) {
				return JS_ThrowInternalError(ctx, "tls.handshake: BIO_write failed");
			}
		}
	}

	int ret = SSL_do_handshake(ud->ssl);
	if (ret == 1) {
		/* handshake complete; read any remaining out_bio data */
		return bio_read_output(ctx, ud->out_bio);
	} else if (ret < 0) {
		int err = SSL_get_error(ud->ssl, ret);
		ERR_clear_error();
		if (err == SSL_ERROR_WANT_READ || err == SSL_ERROR_WANT_WRITE) {
			return bio_read_output(ctx, ud->out_bio);
		}
		return JS_ThrowInternalError(ctx, "SSL_do_handshake error: %d", err);
	} else {
		int err = SSL_get_error(ud->ssl, ret);
		ERR_clear_error();
		return JS_ThrowInternalError(ctx, "SSL_do_handshake error: %d ret: %d", err, ret);
	}
}

/* tls.finished(session) → boolean */
static JSValue js_tls_finished(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
	(void)tv; (void)argc;
	struct tls_context_ud *ud = JS_GetOpaque(argv[0], js_tls_ctx_class_id);
	if (!ud || ud->is_close) return JS_NewBool(ctx, 0);
	return JS_NewBool(ctx, SSL_is_init_finished(ud->ssl));
}

/* tls.read(session, encrypted: AB) → AB (plaintext) */
static JSValue js_tls_read(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
	(void)tv; (void)argc;
	struct tls_context_ud *ud = JS_GetOpaque(argv[0], js_tls_ctx_class_id);
	if (!ud || ud->is_close) return JS_ThrowTypeError(ctx, "tls.read: invalid session");

	size_t enc_sz;
	uint8_t *enc = JS_GetArrayBuffer(ctx, &enc_sz, argv[1]);
	if (!enc) return JS_EXCEPTION;

	if (enc_sz > 0) {
		if (bio_write_input(ctx, ud->in_bio, enc, enc_sz) < 0) {
			return JS_ThrowInternalError(ctx, "tls.read: BIO_write failed");
		}
	}

	/* SSL_read loop: accumulate plaintext */
	uint8_t tmp[8192];
	size_t total = 0;
	size_t cap = 16384;
	uint8_t *out = skynet_malloc(cap);

	while (1) {
		int r = SSL_read(ud->ssl, tmp, sizeof(tmp));
		if (r > 0) {
			if (total + r > cap) {
				while (total + r > cap) cap *= 2;
				uint8_t *nout = skynet_realloc(out, cap);
				if (!nout) {
					skynet_free(out);
					return JS_ThrowInternalError(ctx, "tls read: out of memory");
				}
				out = nout;
			}
			memcpy(out + total, tmp, r);
			total += r;
		} else {
			int err = SSL_get_error(ud->ssl, r);
			ERR_clear_error();
			if (err == SSL_ERROR_WANT_READ || err == SSL_ERROR_WANT_WRITE) {
				break;
			}
			if (err == SSL_ERROR_ZERO_RETURN) {
				break;  /* peer closed cleanly */
			}
			skynet_free(out);
			return JS_ThrowInternalError(ctx, "SSL_read error: %d", err);
		}
	}

	JSValue ret = JS_NewArrayBufferCopy(ctx, out, total);
	skynet_free(out);
	return ret;
}

/* tls.write(session, plaintext: AB) → AB (encrypted) */
static JSValue js_tls_write(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
	(void)tv; (void)argc;
	struct tls_context_ud *ud = JS_GetOpaque(argv[0], js_tls_ctx_class_id);
	if (!ud || ud->is_close) return JS_ThrowTypeError(ctx, "tls.write: invalid session");

	size_t pt_sz;
	uint8_t *pt = JS_GetArrayBuffer(ctx, &pt_sz, argv[1]);
	if (!pt) return JS_EXCEPTION;

	size_t remaining = pt_sz;
	uint8_t *p = pt;
	while (remaining > 0) {
		int w = SSL_write(ud->ssl, p, (int)remaining);
		if (w <= 0) {
			int err = SSL_get_error(ud->ssl, w);
			ERR_clear_error();
			return JS_ThrowInternalError(ctx, "SSL_write error: %d", err);
		}
		p += w;
		remaining -= w;
	}

	return bio_read_output(ctx, ud->out_bio);
}

/* tls.close(session) — free SSL + BIOs */
static JSValue js_tls_close(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
	(void)tv; (void)argc;
	struct tls_context_ud *ud = JS_GetOpaque(argv[0], js_tls_ctx_class_id);
	if (!ud) return JS_UNDEFINED;
	if (!ud->is_close) {
		SSL_free(ud->ssl);
		ud->ssl = NULL;
		ud->in_bio = NULL;
		ud->out_bio = NULL;
		ud->is_close = 1;
	}
	return JS_UNDEFINED;
}

/* tls.ctx_free(ctx_obj) — free SSL_CTX */
static JSValue js_tls_ctx_free(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
	(void)tv; (void)argc;
	struct ssl_ctx_ud *ud = JS_GetOpaque(argv[0], js_ssl_ctx_class_id);
	if (!ud) return JS_UNDEFINED;
	if (ud->ctx) {
		SSL_CTX_free(ud->ctx);
		ud->ctx = NULL;
	}
	return JS_UNDEFINED;
}

/* ================================================================
 * Registration
 * ================================================================ */

void register_tls_bridge(JSContext *ctx, JSValue global) {
	/* Register class IDs */
	JS_NewClassID(JS_GetRuntime(ctx), &js_ssl_ctx_class_id);
	JS_NewClass(JS_GetRuntime(ctx), js_ssl_ctx_class_id, &js_ssl_ctx_class);
	JS_NewClassID(JS_GetRuntime(ctx), &js_tls_ctx_class_id);
	JS_NewClass(JS_GetRuntime(ctx), js_tls_ctx_class_id, &js_tls_ctx_class);

	JSValue skynetcore = JS_GetPropertyStr(ctx, global, "skynetcore");
	JSValue tls = JS_NewObject(ctx);

	JS_SetPropertyStr(ctx, tls, "init", JS_NewCFunction(ctx, js_tls_init, "init", 0));
	JS_SetPropertyStr(ctx, tls, "ctx_new", JS_NewCFunction(ctx, js_tls_ctx_new, "ctx_new", 1));
	JS_SetPropertyStr(ctx, tls, "ctx_set_cert", JS_NewCFunction(ctx, js_tls_ctx_set_cert, "ctx_set_cert", 3));
	JS_SetPropertyStr(ctx, tls, "ctx_set_verify", JS_NewCFunction(ctx, js_tls_ctx_set_verify, "ctx_set_verify", 1));
	JS_SetPropertyStr(ctx, tls, "ctx_free", JS_NewCFunction(ctx, js_tls_ctx_free, "ctx_free", 1));
	JS_SetPropertyStr(ctx, tls, "newtls", JS_NewCFunction(ctx, js_tls_newtls, "newtls", 3));
	JS_SetPropertyStr(ctx, tls, "handshake", JS_NewCFunction(ctx, js_tls_handshake, "handshake", 2));
	JS_SetPropertyStr(ctx, tls, "finished", JS_NewCFunction(ctx, js_tls_finished, "finished", 1));
	JS_SetPropertyStr(ctx, tls, "read", JS_NewCFunction(ctx, js_tls_read, "read", 2));
	JS_SetPropertyStr(ctx, tls, "write", JS_NewCFunction(ctx, js_tls_write, "write", 2));
	JS_SetPropertyStr(ctx, tls, "close", JS_NewCFunction(ctx, js_tls_close, "close", 1));

	JS_SetPropertyStr(ctx, skynetcore, "tls", tls);
	JS_FreeValue(ctx, skynetcore);
}
