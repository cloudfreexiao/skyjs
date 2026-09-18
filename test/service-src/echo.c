#include "skynet.h"

#include <string.h>
#include <stdlib.h>

/*
 * Minimal C test service for skyjs (Task 1 acceptance).
 * Echoes any message back to its sender as PTYPE_RESPONSE.
 * Symbol names follow the skynet_module.c convention: <module>_create/
 * _init/_release, module name = "echo".
 */

struct echo {
	struct skynet_context * ctx;
};

static int
echo_cb(struct skynet_context * ctx, void * ud, int type, int session, uint32_t source, const void * msg, size_t sz) {
	struct echo * e = ud;
	(void)type;
	if (session != 0 && sz > 0) {
		char * buf = skynet_malloc(sz);
		memcpy(buf, msg, sz);
		skynet_send(e->ctx, 0, source, PTYPE_RESPONSE | PTYPE_TAG_DONTCOPY, session, buf, sz);
	}
	return 0;
}

int
echo_init(struct echo * e, struct skynet_context * ctx, const char * args) {
	e->ctx = ctx;
	skynet_error(ctx, "echo service started, args = %s", args ? args : "");
	skynet_callback(ctx, e, echo_cb);
	return 0;
}

struct echo *
echo_create(void) {
	struct echo * e = skynet_malloc(sizeof(*e));
	memset(e, 0, sizeof(*e));
	return e;
}

void
echo_release(struct echo * e) {
	skynet_free(e);
}
