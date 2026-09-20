/*
 * service_skyclusterd.c -- cluster service for skyjs (Task 6).
 *
 * Replaces skynet's clusterd + clusteragent + clustersender with ONE
 * message-driven C service (no gate). The wire protocol is byte-compatible
 * with the original lua-cluster.c so skyjs nodes can join a network with
 * stock Lua skynet nodes:
 *
 *   frame        = WORD big-endian size + content
 *   request      = type 0/0x80 (small), 1/0x41/0x81/0xc1 (large header),
 *                  2/3 (multipart chunk), 4 (trace)
 *   response     = DWORD session (LE) + BYTE type (0 err/1 ok/2/3/4 multi)
 *   DWORDs are little-endian, frame length big-endian (mixed on purpose,
 *   matches fill_header/fill_uint32 in lua-cluster.c)
 *
 * Address 0 requests are name queries: payload = lua-seri packed string,
 * reply = lua-seri packed handle (mirrors clusteragent.lua L78-89).
 *
 * Service-side protocol (JS <-> this service, PTYPE_TEXT):
 *   "listen <port>\n"                    start listening
 *   "node <name> <host> <port>\n"        register remote node address
 *   "req <node> <addr>\n" + payload      roundtrip call (session = sender's)
 *   "push <node> <addr>\n" + payload     one-way
 *   "register <name>\n"                  register local name (handle = sender)
 * Replies to "req" come back as PTYPE_RESPONSE with the caller's session and
 * the untouched remote payload.
 *
 * Reconnect semantics mirror the stock socketchannel as used by
 * clustersender: NO background retry loop. A request landing on a
 * disconnected node issues ONE connect attempt; if the attempt fails, or a
 * live connection dies, every request pending on that node fails right away
 * (PTYPE_ERROR back to the JS caller) and the NEXT request re-attempts the
 * connect.
 */

#include "skynet.h"
#include "skynet_server.h"
#include "skynet_socket.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define MODAPI __attribute__((visibility("default")))

#define MULTI_PART 0x8000
#define COMBINE_T(t, v) ((uint8_t)((t) | ((v) << 3)))
#define MAX_NODE 32
#define MAX_CONN 64
#define MAX_PENDING 256
#define MAX_NAME 64

/* frame types (request) */
#define FREQ_SMALL_ID 0     /* BYTE 0 | DWORD addr | DWORD session | payload */
#define FREQ_LARGE_ID 1     /* large, numeric addr */
#define FPUSH_LARGE_ID 0x41
#define FPART 2
#define FPART_END 3
#define FTRACE 4
#define FREQ_SMALL_NAME 0x80
#define FREQ_LARGE_NAME 0x81
#define FPUSH_LARGE_NAME 0xc1

/* response types */
#define RESP_ERR 0
#define RESP_OK 1
#define RESP_MULTI_BEGIN 2
#define RESP_MULTI_PART 3
#define RESP_MULTI_END 4

struct pmsg {
	struct pmsg *next;
	void *buf;
	size_t sz;
};

// in-progress multipart body reassembly, shared by the inbound request path
// (large REQUEST bodies) and the outbound response path (large RESPONSE
// bodies): a body is opened by its header frame and filled by PART frames
// until total bytes have arrived
struct reasm {
	int active;
	uint32_t session;
	uint32_t total;
	uint8_t *buf;
	size_t len;
};

struct node {
	char used;
	char name[MAX_NAME];
	char host[MAX_NAME];
	int port;
	int sock_id;		// socket id or -1
	int connecting;		// a connect attempt is in flight
	struct pmsg *qhead, *qtail;
};

struct conn {
	char used;
	int sock_id;
	uint8_t *rx;		// frame reassembly buffer
	size_t rxlen, rxcap;
	// in-progress large request body (one per connection, remote sessions
	// are unique per sender so this is unambiguous); the header-phase
	// addr/name/push metadata is remembered until the last chunk arrives
	struct reasm rq;
	uint32_t rq_addr;
	char rq_name[MAX_NAME];
	char rq_has_name;
	char rq_push;
	// outbound connections read RESPONSE frames (with multipart assembly);
	// inbound connections read REQUEST frames
	char outbound;
	// only sockets whose CONNECT/ACCEPT completed are ready: sending on a
	// connecting socket that later fails would hit the dec_sending_ref
	// assertion in socket_server.c
	char ready;
	// in-progress large response body
	struct reasm rs;
};

struct pending_recv {	// forwarded to a local service, awaiting its reply
	char used;
	int local_session;
	int conn_id;		// index into conns
	uint32_t remote_session;
};

struct pending_send {	// sent to a remote node, awaiting its reply
	char used;
	uint32_t remote_session;
	uint32_t source;	// JS caller handle
	int js_session;		// caller's session (for PTYPE_RESPONSE back)
	int node_idx;		// index into nodes[] (failed on disconnect)
};

struct name_entry {
	char used;
	char name[MAX_NAME];
	uint32_t handle;
};

struct clusterd {
	struct skynet_context *ctx;
	struct node nodes[MAX_NODE];
	struct conn conns[MAX_CONN];
	struct pending_recv precv[MAX_PENDING];
	struct pending_send psend[MAX_PENDING];
	struct name_entry names[MAX_NODE];
	uint32_t send_session;	// outbound session counter (>INT32_MAX wraps to 1)
};

/* ------------------------- helpers -------------------------------------- */

static void
fill_header(uint8_t *buf, int sz) {
	buf[0] = (sz >> 8) & 0xff;
	buf[1] = sz & 0xff;
}

static void
fill_uint32(uint8_t *buf, uint32_t n) {
	buf[0] = n & 0xff;
	buf[1] = (n >> 8) & 0xff;
	buf[2] = (n >> 16) & 0xff;
	buf[3] = (n >> 24) & 0xff;
}

static uint32_t
get_uint32(const uint8_t *buf) {
	return buf[0] | buf[1] << 8 | buf[2] << 16 | buf[3] << 24;
}

// mini lua-seri: pack an integer (clusteragent replies with packed handle)
static size_t
seri_pack_int(uint8_t *out, int64_t v) {
	size_t n = 0;
	if (v != (int32_t)v) {
		out[n++] = COMBINE_T(2, 6);
		int64_t v64 = v;
		memcpy(out + n, &v64, 8);
		n += 8;
	} else if (v < 0) {
		out[n++] = COMBINE_T(2, 4);
		int32_t v32 = (int32_t)v;
		memcpy(out + n, &v32, 4);
		n += 4;
	} else {
		out[n++] = COMBINE_T(2, 1);
		out[n++] = (uint8_t)v;
	}
	return n;
}

// mini lua-seri: read the first value if it is a string
static const char *
seri_first_string(const uint8_t *buf, size_t sz, size_t *outlen) {
	if (sz == 0) return NULL;
	uint8_t t = buf[0];
	if ((t & 7) != 4) return NULL;	// not TYPE_SHORT_STRING
	int len = t >> 3;
	if ((size_t)len + 1 > sz) return NULL;
	*outlen = len;
	return (const char *)buf + 1;
}

/* ------------------------- multipart reassembly (shared) ------------------ */

// open (or re-open) a body for the given session; a still-active older body
// is discarded
static void
reasm_start(struct reasm *r, uint32_t session, uint32_t total) {
	if (r->active) skynet_free(r->buf);
	r->active = 1;
	r->session = session;
	r->total = total;
	r->len = 0;
	r->buf = skynet_malloc(total);
}

// append one chunk. Returns 1 only when is_end closes a matching body: *out
// then hands the malloc'd buffer (ownership included) to the caller. Chunks
// for an unknown/stale session or overflowing total are dropped silently,
// same as the per-path checks this layer replaces.
static int
reasm_chunk(struct reasm *r, uint32_t session, int is_end, const uint8_t *data, size_t sz, uint8_t **out, size_t *outlen) {
	if (!r->active || r->session != session) return 0;
	if (r->len + sz > r->total) return 0;
	memcpy(r->buf + r->len, data, sz);
	r->len += sz;
	if (!is_end) return 0;
	*out = r->buf;
	*outlen = r->len;
	r->buf = NULL;
	r->active = 0;
	return 1;
}

// drop an unfinished body (connection closed)
static void
reasm_clear(struct reasm *r) {
	if (r->active) {
		skynet_free(r->buf);
		r->buf = NULL;
		r->active = 0;
	}
}

/* ------------------------- pending tables -------------------------------- */

static void
precv_release(struct pending_recv *pr) {
	pr->used = 0;
}

static struct pending_recv *
precv_alloc(struct clusterd *cd) {
	for (int i = 0; i < MAX_PENDING; i++) {
		if (!cd->precv[i].used) return &cd->precv[i];
	}
	return NULL;
}

static struct pending_recv *
precv_find(struct clusterd *cd, int session) {
	for (int i = 0; i < MAX_PENDING; i++) {
		if (cd->precv[i].used && cd->precv[i].local_session == session) return &cd->precv[i];
	}
	return NULL;
}

static struct pending_send *
psend_alloc(struct clusterd *cd) {
	for (int i = 0; i < MAX_PENDING; i++) {
		if (!cd->psend[i].used) return &cd->psend[i];
	}
	return NULL;
}

static struct pending_send *
psend_find_remote(struct clusterd *cd, uint32_t remote_session) {
	for (int i = 0; i < MAX_PENDING; i++) {
		if (cd->psend[i].used && cd->psend[i].remote_session == remote_session) return &cd->psend[i];
	}
	return NULL;
}

static struct pending_send *
psend_find(struct clusterd *cd, int session) {
	for (int i = 0; i < MAX_PENDING; i++) {
		if (cd->psend[i].used && cd->psend[i].js_session == session) return &cd->psend[i];
	}
	return NULL;
}

/* ------------------------- socket I/O ------------------------------------ */

static struct conn *
conn_by_sock(struct clusterd *cd, int sock_id) {
	for (int i = 0; i < MAX_CONN; i++) {
		if (cd->conns[i].used && cd->conns[i].sock_id == sock_id) return &cd->conns[i];
	}
	return NULL;
}

static struct conn *
conn_alloc(struct clusterd *cd) {
	for (int i = 0; i < MAX_CONN; i++) {
		if (!cd->conns[i].used) {
			struct conn *c = &cd->conns[i];
			memset(c, 0, sizeof(*c));
			c->used = 1;
			return c;
		}
	}
	return NULL;
}

static void
conn_close(struct clusterd *cd, struct conn *c) {
	// NOTE: on CLOSE/ERROR events the socket is already dead at the socket
	// layer -- never call skynet_socket_close here (asserts in
	// socket_server.c dec_sending_ref). Only local state is released.
	skynet_free(c->rx);
	reasm_clear(&c->rq);
	reasm_clear(&c->rs);
	memset(c, 0, sizeof(*c));
}

static void
conn_send_raw(struct clusterd *cd, struct conn *c, const void *buf, size_t sz) {
	void *copy = skynet_malloc(sz);
	memcpy(copy, buf, sz);
	skynet_socket_send(cd->ctx, c->sock_id, copy, (int)sz);
}

// send a response, splitting into multipart frames when needed
static void
conn_send_response(struct clusterd *cd, struct conn *c, uint32_t session, int ok, const void *payload, size_t psz) {
	if (psz <= MULTI_PART) {
		uint8_t *frame = skynet_malloc(psz + 7);
		fill_header(frame, (int)(psz + 5));
		fill_uint32(frame + 2, session);
		frame[6] = ok ? RESP_OK : RESP_ERR;
		memcpy(frame + 7, payload, psz);
		conn_send_raw(cd, c, frame, psz + 7);
		skynet_free(frame);
		return;
	}
	// multipart
	int parts = (int)((psz - 1) / MULTI_PART + 1);
	uint8_t begin[11];
	fill_header(begin, 9);
	fill_uint32(begin + 2, session);
	begin[6] = RESP_MULTI_BEGIN;
	fill_uint32(begin + 7, (uint32_t)psz);
	conn_send_raw(cd, c, begin, 11);
	const uint8_t *p = payload;
	size_t left = psz;
	for (int i = 0; i < parts; i++) {
		size_t s = left > MULTI_PART ? MULTI_PART : left;
		uint8_t *frame = skynet_malloc(s + 7);
		fill_header(frame, (int)(s + 5));
		fill_uint32(frame + 2, session);
		frame[6] = (i == parts - 1) ? RESP_MULTI_END : RESP_MULTI_PART;
		memcpy(frame + 7, p, s);
		conn_send_raw(cd, c, frame, s + 7);
		skynet_free(frame);
		p += s;
		left -= s;
	}
}

/* ------------------------- response parsing (outbound conns) ------------- */

// outbound connections carry RESPONSE frames: DWORD session + BYTE type + payload
static void
handle_response(struct clusterd *cd, struct conn *c, const uint8_t *frame, size_t sz) {
	if (sz < 5) return;
	uint32_t session = get_uint32(frame);
	uint8_t type = frame[4];
	const uint8_t *payload = frame + 5;
	size_t psz = sz - 5;
	struct pending_send *ps = psend_find_remote(cd, session);
	if (ps == NULL) return;
	if (type == RESP_ERR) {
		skynet_send(cd->ctx, 0, ps->source, PTYPE_ERROR, ps->js_session, NULL, 0);
		ps->used = 0;
		return;
	}
	if (type == RESP_MULTI_BEGIN) {
		if (sz < 9) return;
		uint32_t total = get_uint32(frame + 5);
		reasm_start(&c->rs, session, total);
		return;
	}
	if (type == RESP_MULTI_PART || type == RESP_MULTI_END) {
		uint8_t *done;
		size_t done_len;
		if (reasm_chunk(&c->rs, session, type == RESP_MULTI_END, payload, psz, &done, &done_len)) {
			// the reasm buffer is already a skynet_malloc'd block: hand its
			// ownership to skynet directly (PTYPE_TAG_DONTCOPY)
			skynet_send(cd->ctx, 0, ps->source, PTYPE_RESPONSE | PTYPE_TAG_DONTCOPY, ps->js_session, done, done_len);
			ps->used = 0;
		}
		return;
	}
	// RESP_OK
	void *copy = skynet_malloc(psz);
	memcpy(copy, payload, psz);
	skynet_send(cd->ctx, 0, ps->source, PTYPE_RESPONSE | PTYPE_TAG_DONTCOPY, ps->js_session, copy, psz);
	ps->used = 0;
}

/* ------------------------- request dispatch (inbound) -------------------- */

static uint32_t
name_lookup(struct clusterd *cd, const char *name) {
	const char *key = (name[0] == '@') ? name + 1 : name;
	for (int i = 0; i < MAX_NODE; i++) {
		if (cd->names[i].used && strcmp(cd->names[i].name, key) == 0) {
			return cd->names[i].handle;
		}
	}
	return 0;
}

// deliver a fully-parsed request to a local service (or answer a name query)
static void
dispatch_request(struct clusterd *cd, struct conn *c, int is_push, uint32_t session,
                 uint32_t addr, const char *name, const uint8_t *payload, size_t psz) {
	if (name == NULL && addr == 0) {
		// name query: payload is a lua-seri packed string (clusteragent semantics)
		size_t namelen = 0;
		const char *qn = seri_first_string(payload, psz, &namelen);
		if (qn == NULL) {
			if (!is_push) conn_send_response(cd, c, session, 0, "Invalid name", 12);
			return;
		}
		char qname[MAX_NAME];
		size_t cp = namelen < MAX_NAME - 1 ? namelen : MAX_NAME - 1;
		memcpy(qname, qn, cp);
		qname[cp] = 0;
		uint32_t handle = name_lookup(cd, qname);
		if (handle) {
			uint8_t packed[16];
			size_t pn = seri_pack_int(packed, handle);
			conn_send_response(cd, c, session, 1, packed, pn);
		} else {
			conn_send_response(cd, c, session, 0, "name not found", 14);
		}
		return;
	}
	uint32_t handle = addr;
	if (name != NULL) {
		handle = name_lookup(cd, name);
		if (handle == 0) {
			if (!is_push) conn_send_response(cd, c, session, 0, "Invalid name", 12);
			return;
		}
	}
	int local_session = skynet_context_newsession(cd->ctx);
	struct pending_recv *pr = precv_alloc(cd);
	if (pr == NULL) {
		if (!is_push) conn_send_response(cd, c, session, 0, "clusterd busy", 13);
		return;
	}
	pr->used = 1;
	pr->local_session = local_session;
	pr->conn_id = (int)(c - cd->conns);
	pr->remote_session = session;
	void *copy = skynet_malloc(psz);
	memcpy(copy, payload, psz);
	// both branches transfer `copy` ownership to the kernel
	// (PTYPE_TAG_DONTCOPY): the receiver's dispatch frees it. Without the
	// tag skynet_send would copy and this block would leak on the request
	// path (the push branch used to free explicitly, same class of bug).
	if (is_push) {
		skynet_send(cd->ctx, 0, handle, PTYPE_RESERVED_LUA | PTYPE_TAG_DONTCOPY, 0, copy, psz);
		precv_release(pr);
	} else {
		skynet_send(cd->ctx, 0, handle, PTYPE_RESERVED_LUA | PTYPE_TAG_DONTCOPY, local_session, copy, psz);
	}
}

static void
handle_request(struct clusterd *cd, struct conn *c, const uint8_t *frame, size_t sz) {
	if (sz == 0) return;
	uint8_t t = frame[0];
	uint32_t addr = 0;
	uint32_t session = 0;
	const uint8_t *payload = NULL;
	size_t psz = 0;
	char name[MAX_NAME];
	name[0] = 0;
	int is_push = 0;
	size_t large_total = 0;
	int is_large_header = 0;
	int is_part = 0;
	int part_end = 0;
	int has_name = 0;

	switch (t) {
	case FREQ_SMALL_ID:
		if (sz < 9) return;
		addr = get_uint32(frame + 1);
		session = get_uint32(frame + 5);
		payload = frame + 9;
		psz = sz - 9;
		break;
	case FREQ_LARGE_ID:
	case FPUSH_LARGE_ID:
		if (sz < 13) return;
		addr = get_uint32(frame + 1);
		session = get_uint32(frame + 5);
		large_total = get_uint32(frame + 9);
		is_large_header = 1;
		is_push = (t == FPUSH_LARGE_ID);
		break;
	case FREQ_SMALL_NAME:
		if (sz < 6) return;
		{
			size_t namelen = frame[1];
			if (sz < namelen + 6) return;
			memcpy(name, frame + 2, namelen);
			name[namelen] = 0;
			session = get_uint32(frame + 2 + namelen);
			payload = frame + 6 + namelen;
			psz = sz - namelen - 6;
			has_name = 1;
		}
		break;
	case FREQ_LARGE_NAME:
	case FPUSH_LARGE_NAME:
		if (sz < 10) return;
		{
			size_t namelen = frame[1];
			if (sz < namelen + 10) return;
			memcpy(name, frame + 2, namelen);
			name[namelen] = 0;
			session = get_uint32(frame + 2 + namelen);
			large_total = get_uint32(frame + 6 + namelen);
			is_large_header = 1;
			is_push = (t == FPUSH_LARGE_NAME);
			has_name = 1;
		}
		break;
	case FPART:
	case FPART_END:
		if (sz < 5) return;
		session = get_uint32(frame + 1);
		payload = frame + 5;
		psz = sz - 5;
		is_part = 1;
		part_end = (t == FPART_END);
		break;
	case FTRACE:
		return;	// parsed and ignored
	default:
		return;
	}

	if (is_part) {
		uint8_t *done;
		size_t done_len;
		if (reasm_chunk(&c->rq, session, part_end, payload, psz, &done, &done_len)) {
			// assembled: dispatch with the header-phase address/name
			dispatch_request(cd, c, c->rq_push, c->rq.session, c->rq_addr,
			                 c->rq_has_name ? c->rq_name : NULL, done, done_len);
			skynet_free(done);
		}
		return;
	}

	if (is_large_header) {
		reasm_start(&c->rq, session, large_total);
		c->rq_addr = addr;
		c->rq_push = (char)is_push;
		c->rq_has_name = (char)has_name;
		if (has_name) {
			strncpy(c->rq_name, name, MAX_NAME - 1);
		}
		return;
	}

	// small frames: push is encoded as session == 0
	dispatch_request(cd, c, session == 0, session, addr, has_name ? name : NULL, payload, psz);
}

/* ------------------------- inbound data (framing) ------------------------ */

static void
conn_data(struct clusterd *cd, struct conn *c, const uint8_t *data, size_t sz) {
	// append to rx buffer
	if (c->rxlen + sz > c->rxcap) {
		size_t cap = c->rxcap ? c->rxcap * 2 : 4096;
		while (cap < c->rxlen + sz) cap *= 2;
		c->rx = skynet_realloc(c->rx, cap);
		c->rxcap = cap;
	}
	memcpy(c->rx + c->rxlen, data, sz);
	c->rxlen += sz;

	for (;;) {
		if (c->rxlen < 2) return;
		size_t flen = (c->rx[0] << 8) | c->rx[1];
		if (c->rxlen < 2 + flen) return;
		if (c->outbound) {
			handle_response(cd, c, c->rx + 2, flen);
		} else {
			handle_request(cd, c, c->rx + 2, flen);
		}
		memmove(c->rx, c->rx + 2 + flen, c->rxlen - 2 - flen);
		c->rxlen -= 2 + flen;
	}
}

/* ------------------------- outbound (sender side) ------------------------ */

static struct node *
node_find(struct clusterd *cd, const char *name) {
	for (int i = 0; i < MAX_NODE; i++) {
		if (cd->nodes[i].used && strcmp(cd->nodes[i].name, name) == 0) return &cd->nodes[i];
	}
	return NULL;
}

static struct node *
node_get(struct clusterd *cd, const char *name) {
	struct node *n = node_find(cd, name);
	if (n) return n;
	for (int i = 0; i < MAX_NODE; i++) {
		if (!cd->nodes[i].used) {
			memset(&cd->nodes[i], 0, sizeof(cd->nodes[i]));
			cd->nodes[i].used = 1;
			strncpy(cd->nodes[i].name, name, MAX_NAME - 1);
			cd->nodes[i].sock_id = -1;
			return &cd->nodes[i];
		}
	}
	return NULL;
}

// issue ONE connect attempt for a node. Returns 0 when the attempt could
// not even be started (the caller must fail the request right away); 1 when
// the attempt is in flight (or a connection already exists). The outcome
// arrives later as a CONNECT/ERROR event; nothing is retried in the
// background -- the next request re-attempts the connect.
static int
node_connect(struct clusterd *cd, struct node *n) {
	if (n->sock_id >= 0 || n->connecting) return 1;
	if (n->port == 0) return 0;
	n->connecting = 1;
	int id = skynet_socket_connect(cd->ctx, n->host, n->port);
	if (id < 0) {
		n->connecting = 0;
		return 0;
	}
	n->sock_id = id;
	struct conn *c = conn_alloc(cd);
	if (c) {
		c->sock_id = id;
		c->outbound = 1;
		// ready is set when the CONNECT event arrives
	}
	return 1;
}

static void
node_clear_queue(struct node *n) {
	struct pmsg *m = n->qhead;
	while (m) {
		struct pmsg *next = m->next;
		skynet_free(m->buf);
		skynet_free(m);
		m = next;
	}
	n->qhead = n->qtail = NULL;
}

// the node's connection is down and will NOT be retried in the background:
// drop queued frames and fail every pending request on this node at once,
// so callers observe the outage immediately instead of hanging
static void
node_fail_pending(struct clusterd *cd, int idx) {
	node_clear_queue(&cd->nodes[idx]);
	for (int i = 0; i < MAX_PENDING; i++) {
		struct pending_send *ps = &cd->psend[i];
		if (ps->used && ps->node_idx == idx) {
			skynet_send(cd->ctx, 0, ps->source, PTYPE_ERROR, ps->js_session, NULL, 0);
			ps->used = 0;
		}
	}
}

// emit one framed message (content + 2-byte big-endian length prefix)
static void
emit_frame(struct clusterd *cd, struct node *n, const uint8_t *content, size_t sz) {
	uint8_t *frame = skynet_malloc(sz + 2);
	fill_header(frame, (int)sz);
	memcpy(frame + 2, content, sz);
	struct conn *c = conn_by_sock(cd, n->sock_id);
	if (c && c->ready) {
		conn_send_raw(cd, c, frame, sz + 2);
	} else {
		// not connected (or still connecting): queue until CONNECT arrives
		struct pmsg *m = skynet_malloc(sizeof(*m));
		void *copy = skynet_malloc(sz + 2);
		memcpy(copy, frame, sz + 2);
		m->buf = copy;
		m->sz = sz + 2;
		m->next = NULL;
		if (n->qtail) n->qtail->next = m; else n->qhead = m;
		n->qtail = m;
	}
	skynet_free(frame);
}

static void
node_flush_queue(struct clusterd *cd, struct node *n) {
	struct conn *c = conn_by_sock(cd, n->sock_id);
	if (c == NULL) return;
	struct pmsg *m = n->qhead;
	while (m) {
		conn_send_raw(cd, c, m->buf, m->sz);
		skynet_free(m->buf);
		struct pmsg *next = m->next;
		skynet_free(m);
		m = next;
	}
	n->qhead = n->qtail = NULL;
}

// build a request frame (or header+chunks for large payloads) and returns
// the outbound session
static uint32_t
node_send_request(struct clusterd *cd, struct node *n, uint32_t addr, const char *name, const void *payload, size_t psz, int is_push) {
	// outbound session: uint32 counter wrapping at INT32_MAX (lua-cluster.c)
	uint32_t session = ++cd->send_session;
	if (session > 0x7fffffff) {
		cd->send_session = 1;
		session = 1;
	}
	uint32_t session_field = is_push ? 0 : session;
	if (psz < MULTI_PART) {
		uint8_t *content = skynet_malloc(psz + 16);
		size_t off = 0;
		if (name) {
			size_t namelen = strlen(name);
			content[off++] = FREQ_SMALL_NAME;
			content[off++] = (uint8_t)namelen;
			memcpy(content + off, name, namelen);
			off += namelen;
			fill_uint32(content + off, session_field);
			off += 4;
		} else {
			content[off++] = FREQ_SMALL_ID;
			fill_uint32(content + off, addr);
			off += 4;
			fill_uint32(content + off, session_field);
			off += 4;
		}
		memcpy(content + off, payload, psz);
		off += psz;
		emit_frame(cd, n, content, off);
		skynet_free(content);
		return session;
	}
	// large request: header frame + multipart chunks
	uint8_t *content = skynet_malloc(16);
	size_t off = 0;
	if (name) {
		size_t namelen = strlen(name);
		content[off++] = is_push ? FPUSH_LARGE_NAME : FREQ_LARGE_NAME;
		content[off++] = (uint8_t)namelen;
		memcpy(content + off, name, namelen);
		off += namelen;
		fill_uint32(content + off, session_field);
		off += 4;
		fill_uint32(content + off, (uint32_t)psz);
		off += 4;
	} else {
		content[off++] = is_push ? FPUSH_LARGE_ID : FREQ_LARGE_ID;
		fill_uint32(content + off, addr);
		off += 4;
		fill_uint32(content + off, session_field);
		off += 4;
		fill_uint32(content + off, (uint32_t)psz);
		off += 4;
	}
	emit_frame(cd, n, content, off);
	skynet_free(content);
	const uint8_t *p = payload;
	size_t left = psz;
	while (left > 0) {
		size_t s = left > MULTI_PART ? MULTI_PART : left;
		uint8_t *part = skynet_malloc(s + 5);
		part[0] = (left > MULTI_PART) ? FPART : FPART_END;
		fill_uint32(part + 1, session);
		memcpy(part + 5, p, s);
		emit_frame(cd, n, part, s + 5);
		skynet_free(part);
		p += s;
		left -= s;
	}
	return session;
}

/* ------------------------- skynet callbacks ------------------------------ */

static void
dispatch_local_reply(struct clusterd *cd, int session, const void *msg, size_t sz) {
	// reply from a local service: forward to the remote node, or to a JS caller
	struct pending_recv *pr = precv_find(cd, session);
	if (pr) {
		struct conn *c = &cd->conns[pr->conn_id];
		if (c->used) {
			conn_send_response(cd, c, pr->remote_session, 1, msg ? msg : "", sz);
		}
		precv_release(pr);
		return;
	}
	struct pending_send *ps = psend_find(cd, session);
	if (ps) {
		// remote node's reply -> JS caller
		void *copy = skynet_malloc(sz);
		memcpy(copy, msg ? msg : "", sz);
		skynet_send(cd->ctx, 0, ps->source, PTYPE_RESPONSE | PTYPE_TAG_DONTCOPY, ps->js_session, copy, sz);
		ps->used = 0;
	}
}

static void
handle_command(struct clusterd *cd, uint32_t source, int session, const char *msg, size_t sz) {
	// first line = command, remainder = binary payload
	const char *nl = memchr(msg, '\n', sz);
	size_t linelen = nl ? (size_t)(nl - msg) : sz;
	char line[256];
	if (linelen >= sizeof(line)) linelen = sizeof(line) - 1;
	memcpy(line, msg, linelen);
	line[linelen] = 0;
	const uint8_t *payload = (const uint8_t *)(nl ? nl + 1 : msg + sz);
	size_t psz = nl ? sz - linelen - 1 : 0;

	if (strncmp(line, "listen ", 7) == 0) {
		int port = atoi(line + 7);
		int id = skynet_socket_listen(cd->ctx, "0.0.0.0", port, 64);
		if (id >= 0) {
			// PListen -> Listen: start accepting (like socket.lua does)
			skynet_socket_start(cd->ctx, id);
		}
		skynet_error(cd->ctx, "CLUSTERD listen port %d -> id %d", port, id);
		if (session != 0) {
			skynet_send(cd->ctx, 0, source, PTYPE_RESPONSE | PTYPE_TAG_DONTCOPY, session, NULL, 0);
		}
		return;
	}
	if (strncmp(line, "node ", 5) == 0) {
		char name[MAX_NAME], host[MAX_NAME];
		int port = 0;
		sscanf(line + 5, "%63s %63s %d", name, host, &port);
		struct node *n = node_get(cd, name);
		if (n) {
			strncpy(n->host, host, MAX_NAME - 1);
			n->port = port;
			if (n->sock_id < 0) {
				// register-time attempt; failure is not fatal -- requests
				// re-attempt on demand
				node_connect(cd, n);
			}
		}
		if (session != 0) {
			skynet_send(cd->ctx, 0, source, PTYPE_RESPONSE | PTYPE_TAG_DONTCOPY, session, NULL, 0);
		}
		return;
	}
	if (strncmp(line, "register ", 9) == 0) {
		const char *name = line + 9;
		for (int i = 0; i < MAX_NODE; i++) {
			if (!cd->names[i].used) {
				cd->names[i].used = 1;
				strncpy(cd->names[i].name, name, MAX_NAME - 1);
				cd->names[i].handle = source;
				skynet_error(cd->ctx, "CLUSTERD register [%s] :%08x", name, source);
				break;
			}
		}
		if (session != 0) {
			skynet_send(cd->ctx, 0, source, PTYPE_RESPONSE | PTYPE_TAG_DONTCOPY, session, NULL, 0);
		}
		return;
	}
	if (strncmp(line, "req ", 4) == 0 || strncmp(line, "push ", 5) == 0) {
		int is_push = (line[0] == 'p');
		char nodename[MAX_NAME], addrstr[MAX_NAME];
		sscanf(line + (is_push ? 5 : 4), "%63s %63s", nodename, addrstr);
		struct node *n = node_find(cd, nodename);
		if (n == NULL) {
			skynet_error(cd->ctx, "CLUSTERD unknown node %s", nodename);
			skynet_send(cd->ctx, 0, source, PTYPE_ERROR, session, NULL, 0);
			return;
		}
		if (n->sock_id < 0 && !n->connecting) {
			if (!node_connect(cd, n)) {
				skynet_error(cd->ctx, "CLUSTERD node [%s] connect failed", nodename);
				skynet_send(cd->ctx, 0, source, PTYPE_ERROR, session, NULL, 0);
				return;
			}	// frames queue until the connection is up
		}
		uint32_t addr = 0;
		const char *name = NULL;
		if (addrstr[0] == '@' || !(addrstr[0] >= '0' && addrstr[0] <= '9')) {
			name = addrstr;	// '@name' (or name) -> resolved by the remote node
		} else {
			addr = strtoul(addrstr, NULL, 16);	// ":hex" handles too via strtoul base 16
		}
		uint32_t remote_session = node_send_request(cd, n, addr, name, payload, psz, is_push);
		if (!is_push) {
			struct pending_send *ps = psend_alloc(cd);
			if (ps == NULL) {
				skynet_send(cd->ctx, 0, source, PTYPE_ERROR, session, NULL, 0);
				return;
			}
			ps->used = 1;
			ps->remote_session = remote_session;
			ps->source = source;
			ps->js_session = session;
			ps->node_idx = (int)(n - cd->nodes);
		}
		return;
	}
	skynet_error(cd->ctx, "CLUSTERD unknown command: %s", line);
}

static int
clusterd_cb(struct skynet_context *ctx, void *ud, int type, int session, uint32_t source, const void *msg, size_t sz) {
	struct clusterd *cd = ud;
	switch (type) {
	case PTYPE_SOCKET: {
		const struct skynet_socket_message *sm = msg;
		switch (sm->type) {
		case SKYNET_SOCKET_TYPE_CONNECT: {
			// an outbound connection to a remote node is up: flush queued frames.
			// Outbound = the sender side, so TCP_NODELAY matches the stock
			// clustersender.lua (nodelay = true); accepted sockets keep the
			// stock clusteragent behavior (no nodelay on the response side).
			skynet_socket_nodelay(cd->ctx, sm->id);
			struct conn *cc = conn_by_sock(cd, sm->id);
			if (cc) cc->ready = 1;
			for (int i = 0; i < MAX_NODE; i++) {
				if (cd->nodes[i].used && cd->nodes[i].sock_id == sm->id) {
					skynet_error(cd->ctx, "CLUSTERD node [%s] connected", cd->nodes[i].name);
					node_flush_queue(cd, &cd->nodes[i]);
					break;
				}
			}
			break;
		}
		case SKYNET_SOCKET_TYPE_ACCEPT: {
			struct conn *c = conn_alloc(cd);
			if (c) {
				c->sock_id = sm->ud;
				c->outbound = 0;
				c->ready = 1;
				skynet_socket_start(ctx, sm->ud);
			}
			break;
		}
		case SKYNET_SOCKET_TYPE_DATA: {
			struct conn *c = conn_by_sock(cd, sm->id);
			if (c) {
				conn_data(cd, c, (const uint8_t *)sm->buffer, (size_t)sm->ud);
			}
			// sm->buffer is a fresh skynet_malloc block owned by this service
			// (skynet_server frees only the sm struct); conn_data already copied
			// the bytes into c->rx, so release it here to avoid leaking every
			// inbound DATA buffer (same ownership contract as lua socket.lua).
			skynet_free((void *)sm->buffer);
			break;
		}
		case SKYNET_SOCKET_TYPE_CLOSE:
		case SKYNET_SOCKET_TYPE_ERROR: {
			struct conn *c = conn_by_sock(cd, sm->id);
			if (c) conn_close(cd, c);
			for (int i = 0; i < MAX_NODE; i++) {
				if (cd->nodes[i].used && cd->nodes[i].sock_id == sm->id) {
					cd->nodes[i].sock_id = -1;
					cd->nodes[i].connecting = 0;
					// no background retry: fail everything pending on this
					// node now; the next request re-attempts the connect
					node_fail_pending(cd, i);
					break;
				}
			}
			break;
		}
		}
		break;
	}
	case PTYPE_TEXT:
		handle_command(cd, source, session, msg, sz);
		break;
	case PTYPE_RESPONSE:
		dispatch_local_reply(cd, session, msg, sz);
		break;
	case PTYPE_ERROR: {
		// local service failed: reply error to remote (or JS caller)
		struct pending_recv *pr = precv_find(cd, session);
		if (pr) {
			struct conn *c = &cd->conns[pr->conn_id];
			if (c->used) {
				conn_send_response(cd, c, pr->remote_session, 0, "error", 5);
			}
			precv_release(pr);
		}
		break;
	}
	}
	return 0;
}

/* ------------------------- module ABI ------------------------------------ */

MODAPI int
skyclusterd_init(struct clusterd *cd, struct skynet_context *ctx, const char *args) {
	(void)args;
	cd->ctx = ctx;
	for (int i = 0; i < MAX_NODE; i++) {
		cd->nodes[i].sock_id = -1;
	}
	skynet_callback(ctx, cd, clusterd_cb);
	// register as the well-known singleton: NAME takes ".name :hexhandle"
	char parm[32];
	sprintf(parm, ".clusterd :%x", skynet_context_handle(ctx));
	skynet_command(ctx, "NAME", parm);
	skynet_error(ctx, "CLUSTERD started :%08x", skynet_context_handle(ctx));
	return 0;
}

MODAPI struct clusterd *
skyclusterd_create(void) {
	struct clusterd *cd = skynet_malloc(sizeof(*cd));
	memset(cd, 0, sizeof(*cd));
	return cd;
}

MODAPI void
skyclusterd_release(struct clusterd *cd) {
	skynet_free(cd);
}
