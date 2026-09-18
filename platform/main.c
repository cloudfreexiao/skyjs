#include "skynet.h"

#include "skynet_imp.h"
#include "skynet_env.h"
#include "skynet_server.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <signal.h>
#include <assert.h>

#ifndef SKYNET_MAXTHREAD
#define SKYNET_MAXTHREAD 1024
#endif

/*
 * Pure-C replacement for skynet-src/skynet_main.c.
 *
 * The original boots a throwaway Lua VM to execute the config file (which
 * is Lua code, supporting $VAR substitution and `include`). skyjs configs
 * are flat JSON instead. Everything else is a faithful port of the
 * original main(): env defaults, skynet_start(), clean exit.
 */

static int
optint(const char *key, int opt) {
	const char * str = skynet_getenv(key);
	if (str == NULL) {
		char tmp[20];
		sprintf(tmp,"%d",opt);
		skynet_setenv(key, tmp);
		return opt;
	}
	return strtol(str, NULL, 10);
}

static int
optboolean(const char *key, int opt) {
	const char * str = skynet_getenv(key);
	if (str == NULL) {
		skynet_setenv(key, opt ? "true" : "false");
		return opt;
	}
	return strcmp(str,"true")==0;
}

static const char *
optstring(const char *key,const char * opt) {
	const char * str = skynet_getenv(key);
	if (str == NULL) {
		if (opt) {
			skynet_setenv(key, opt);
			opt = skynet_getenv(key);
		}
		return opt;
	}
	return str;
}

int
sigign(void) {
	struct sigaction sa;
	sa.sa_handler = SIG_IGN;
	sa.sa_flags = 0;
	sigemptyset(&sa.sa_mask);
	sigaction(SIGPIPE, &sa, 0);
	return 0;
}

/* ---------------------------------------------------------------- flat JSON */

static void
skip_ws(const char **p) {
	while (**p == ' ' || **p == '\t' || **p == '\r' || **p == '\n') {
		++*p;
	}
}

// parse a JSON string literal at *p (which points at the opening quote),
// write the unescaped content into out (nul-terminated), advance *p past
// the closing quote. Returns 0 on success, -1 on error.
// Supports the common escapes; \uXXXX is decoded for BMP, \uXXXX\uXXXX
// surrogate pairs are kept simple (surrogate pair -> utf8).
static int
json_string(const char **p, char *out, size_t outsz) {
	const char * s = *p + 1;	// skip opening quote
	size_t n = 0;
	while (*s != '"') {
		if (*s == '\0')
			return -1;
		char c = *s;
		if (c == '\\') {
			++s;
			switch (*s) {
			case '"': c = '"'; break;
			case '\\': c = '\\'; break;
			case '/': c = '/'; break;
			case 'b': c = '\b'; break;
			case 'f': c = '\f'; break;
			case 'n': c = '\n'; break;
			case 'r': c = '\r'; break;
			case 't': c = '\t'; break;
			case 'u': {
				// \uXXXX (pass-through of BMP codepoint as UTF-8)
				if (s[1] && s[2] && s[3] && s[4]) {
					char hex[5] = { s[1], s[2], s[3], s[4], 0 };
					unsigned cp = (unsigned)strtoul(hex, NULL, 16);
					s += 4;
					if (n + 4 >= outsz) return -1;
					if (cp < 0x80) {
						out[n++] = (char)cp;
					} else if (cp < 0x800) {
						out[n++] = (char)(0xc0 | (cp >> 6));
						out[n++] = (char)(0x80 | (cp & 0x3f));
					} else {
						out[n++] = (char)(0xe0 | (cp >> 12));
						out[n++] = (char)(0x80 | ((cp >> 6) & 0x3f));
						out[n++] = (char)(0x80 | (cp & 0x3f));
					}
					++s;
					continue;
				}
				return -1;
			}
			default:
				return -1;
			}
			++s;
		} else {
			++s;
		}
		if (n + 1 >= outsz)
			return -1;
		out[n++] = c;
	}
	out[n] = '\0';
	*p = s + 1;
	return 0;
}

// walk a flat JSON object, calling setenv for every key/value pair.
// numbers keep their literal text, booleans become "true"/"false",
// null values are skipped (mirrors the original: nil never lands in the
 // Lua table either).
static int
parse_config(const char *json) {
	const char * p = json;
	skip_ws(&p);
	if (*p != '{') {
		fprintf(stderr, "Invalid config: expect '{' at top level\n");
		return 1;
	}
	++p;
	char key[256];
	char val[1024];
	for (;;) {
		skip_ws(&p);
		if (*p == '}') {
			break;
		}
		if (*p != '"') {
			fprintf(stderr, "Invalid config: expect key string\n");
			return 1;
		}
		if (json_string(&p, key, sizeof(key))) {
			fprintf(stderr, "Invalid config: bad key string\n");
			return 1;
		}
		skip_ws(&p);
		if (*p != ':') {
			fprintf(stderr, "Invalid config: expect ':' after key %s\n", key);
			return 1;
		}
		++p;
		skip_ws(&p);
		if (*p == '"') {
			if (json_string(&p, val, sizeof(val))) {
				fprintf(stderr, "Invalid config: bad value of key %s\n", key);
				return 1;
			}
			skynet_setenv(key, val);
		} else if (strncmp(p, "true", 4) == 0) {
			skynet_setenv(key, "true");
			p += 4;
		} else if (strncmp(p, "false", 5) == 0) {
			skynet_setenv(key, "false");
			p += 5;
		} else if (strncmp(p, "null", 4) == 0) {
			p += 4;	// skip, no env entry
		} else {
			// number (or anything atomic): copy the literal
			const char * s = p;
			while (*p && *p != ',' && *p != '}' && *p != ' ' && *p != '\t' && *p != '\r' && *p != '\n') {
				++p;
			}
			size_t n = (size_t)(p - s);
			if (n == 0 || n >= sizeof(val)) {
				fprintf(stderr, "Invalid config: bad value of key %s\n", key);
				return 1;
			}
			memcpy(val, s, n);
			val[n] = '\0';
			skynet_setenv(key, val);
		}
		skip_ws(&p);
		if (*p == ',') {
			++p;
		} else if (*p == '}') {
			break;
		} else {
			fprintf(stderr, "Invalid config: expect ',' or '}' after key %s\n", key);
			return 1;
		}
	}
	return 0;
}

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

int
main(int argc, char *argv[]) {
	const char * config_file = NULL;
	if (argc > 1) {
		config_file = argv[1];
	} else {
		fprintf(stderr, "Need a config file.\n"
			"usage: skyjs configfilename\n");
		return 1;
	}

	skynet_globalinit();
	skynet_env_init();

	sigign();

	char * json = read_file(config_file);
	if (json == NULL) {
		fprintf(stderr, "Can't open config file %s\n", config_file);
		return 1;
	}
	int err = parse_config(json);
	skynet_free(json);
	if (err) {
		return 1;
	}

	struct skynet_config config;

	config.thread =  optint("thread",8);
	if (config.thread < 1 || config.thread > SKYNET_MAXTHREAD) {
		fprintf(stderr, "Invalid thread %d , should be in [1,%d]\n", config.thread, SKYNET_MAXTHREAD);
		return 1;
	}
	config.module_path = optstring("cpath","./cservice/?.so");
	config.harbor = optint("harbor", 0);
	config.bootstrap = optstring("bootstrap","snjs service/bootstrap.js");
	config.daemon = optstring("daemon", NULL);
	config.logger = optstring("logger", NULL);
	config.logservice = optstring("logservice", "logger");
	config.profile = optboolean("profile", 1);

	skynet_start(&config);
	skynet_globalexit();

	return 0;
}
