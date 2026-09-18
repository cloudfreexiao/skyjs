#include "skynet.h"
#include "skynet_env.h"
#include "skynet_imp.h"
#include "spinlock.h"

#include <stdlib.h>
#include <string.h>
#include <assert.h>

/*
 * Pure-C replacement for skynet-src/skynet_env.c (which stores env in a
 * Lua VM global table). API is identical (see 3rd/skynet/skynet-src/skynet_env.h).
 *
 * CRITICAL SEMANTIC: the original implementation returned pointers to Lua
 * interned strings, which stay alive as long as the global table holds
 * them -- effectively forever. Consumers (skynet_command "GETENV",
 * optstring in main.c) rely on the returned pointer remaining valid.
 * Therefore key/value are strdup'ed and never freed here.
 */

#define ENV_SLOT 256

struct env_node {
	struct env_node * next;
	char * key;
	char * value;
};

struct skynet_env {
	struct spinlock lock;
	struct env_node * slots[ENV_SLOT];
};

static struct skynet_env * E = NULL;

static unsigned
env_hash(const char * s) {
	unsigned h = 0;
	while (*s) {
		h = h * 31 + (unsigned char)*s;
		++s;
	}
	return h;
}

const char *
skynet_getenv(const char *key) {
	SPIN_LOCK(E)

	struct env_node * n = E->slots[env_hash(key) & (ENV_SLOT - 1)];
	const char * result = NULL;
	while (n) {
		if (strcmp(n->key, key) == 0) {
			result = n->value;
			break;
		}
		n = n->next;
	}

	SPIN_UNLOCK(E)

	return result;
}

void
skynet_setenv(const char *key, const char *value) {
	SPIN_LOCK(E)

	unsigned idx = env_hash(key) & (ENV_SLOT - 1);
	struct env_node * n = E->slots[idx];
	while (n) {
		// same contract as the original: env keys are set once
		assert(strcmp(n->key, key) != 0);
		n = n->next;
	}

	n = skynet_malloc(sizeof(*n));
	n->key = skynet_strdup(key);
	n->value = skynet_strdup(value);
	n->next = E->slots[idx];
	E->slots[idx] = n;

	SPIN_UNLOCK(E)
}

void
skynet_env_init(void) {
	E = skynet_malloc(sizeof(*E));
	memset(E, 0, sizeof(*E));
	SPIN_INIT(E)
}
