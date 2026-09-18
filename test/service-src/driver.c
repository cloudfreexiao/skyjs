#include "skynet.h"
#include "skynet_server.h"

#include <ctype.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/*
 * Test driver service for skyjs acceptance runs.
 *
 * args: "<dest> <delay_ms> <msg> [signal_delay_ms]"
 *   dest          "0xNNNN" (numeric handle, as returned by intcommand LAUNCH)
 *                 or ".name" (local registered name)
 *   delay_ms      send <msg> to dest after this many ms (PTYPE_TEXT)
 *   msg           payload string
 *   signal_delay  if > 0, send command SIGNAL "<dest> 0" after this many ms
 *
 * Responses (PTYPE_RESPONSE) and errors (PTYPE_ERROR) are logged with the
 * DRIVER prefix so acceptance can be verified from the log output.
 */

struct driver {
	struct skynet_context * ctx;
	uint32_t dest;
	int call_session;
	int timer_session;
	int signal_timer;
	int signal_delay;
	int signaled;
	char msg[256];
};

static uint32_t
resolve_dest(struct skynet_context *ctx, const char * s) {
	if (isdigit((unsigned char)s[0])) {
		// accepts both "0xNNNN" and decimal
		return strtoul(s, NULL, 0);
	}
	if (s[0] == '.') {
		const char * r = skynet_command(ctx, "QUERY", s);
		if (r) {
			return strtoul(r + 1, NULL, 16);
		}
	}
	return 0;
}

static int
intcmd(struct skynet_context *ctx, const char * cmd, const char * parm) {
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
driver_cb(struct skynet_context * ctx, void * ud, int type, int session, uint32_t source, const void * msg, size_t sz) {
	struct driver * d = ud;
	if (type == PTYPE_RESPONSE && session == d->timer_session) {
		// fire the call
		char * buf = skynet_malloc(strlen(d->msg) + 1);
		strcpy(buf, d->msg);
		d->call_session = skynet_context_newsession(d->ctx);
		skynet_send(d->ctx, 0, d->dest, PTYPE_TEXT, d->call_session, buf, strlen(buf));
		if (d->signal_delay > 0 && !d->signaled) {
			// skynet TIMEOUT is in centiseconds (10ms units)
			char tmp[16];
			sprintf(tmp, "%d", d->signal_delay / 10);
			d->signal_timer = intcmd(ctx, "TIMEOUT", tmp);
		}
	} else if (type == PTYPE_RESPONSE && d->signal_timer && session == d->signal_timer) {
		if (!d->signaled) {
			d->signaled = 1;
			// tohandle() requires ":hex" (or ".name") form
			char parm[32];
			sprintf(parm, ":%x 0", d->dest);
			skynet_command(d->ctx, "SIGNAL", parm);
			skynet_error(d->ctx, "DRIVER signal 0 sent to %u", d->dest);
		}
	} else if (type == PTYPE_RESPONSE && session == d->call_session) {
		skynet_error(d->ctx, "DRIVER RESP: %.*s", (int)sz, msg ? (const char *)msg : "");
	} else if (type == PTYPE_ERROR) {
		skynet_error(d->ctx, "DRIVER ERROR from %08x session %d", source, session);
	}
	return 0;
}

int
driver_init(struct driver * d, struct skynet_context * ctx, const char * args) {
	d->ctx = ctx;
	char tmp[512];
	strncpy(tmp, args ? args : "", sizeof(tmp) - 1);
	tmp[sizeof(tmp) - 1] = '\0';
	char * dest = strtok(tmp, " ");
	char * delay = strtok(NULL, " ");
	char * msg = strtok(NULL, " ");
	char * sd = strtok(NULL, " ");
	if (dest == NULL || delay == NULL || msg == NULL) {
		skynet_error(ctx, "DRIVER usage: <dest> <delay_ms> <msg> [signal_delay_ms]");
		skynet_command(ctx, "EXIT", NULL);
		return 0;
	}
	d->dest = resolve_dest(ctx, dest);
	d->signal_delay = sd ? atoi(sd) : 0;
	d->signaled = 0;
	d->signal_timer = 0;
	d->call_session = 0;
	strncpy(d->msg, msg, sizeof(d->msg) - 1);
	d->msg[sizeof(d->msg) - 1] = '\0';
	if (d->dest == 0) {
		skynet_error(ctx, "DRIVER can't resolve dest %s", dest);
		skynet_command(ctx, "EXIT", NULL);
		return 0;
	}
	skynet_error(ctx, "DRIVER start dest=%u delay=%sms msg=%s signal_delay=%dms", d->dest, delay, d->msg, d->signal_delay);
	skynet_callback(ctx, d, driver_cb);
	char tbuf[16];
	// skynet TIMEOUT is in centiseconds (10ms units)
	sprintf(tbuf, "%d", atoi(delay) / 10);
	d->timer_session = intcmd(ctx, "TIMEOUT", tbuf);
	return 0;
}

struct driver *
driver_create(void) {
	struct driver * d = skynet_malloc(sizeof(*d));
	memset(d, 0, sizeof(*d));
	return d;
}

void
driver_release(struct driver * d) {
	skynet_free(d);
}
