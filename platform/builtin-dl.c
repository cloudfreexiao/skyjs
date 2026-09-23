/*
 * builtin-dl.c — static-link support for cservice modules (STATIC=1 build).
 *
 * skynet loads C services via dlopen(cpath) + dlsym("<name>_create"/...),
 * hardcoded in 3rd/skynet/skynet-src/skynet_module.c (never modified).  To
 * fold selected cservice .so files into the skyjs executable without touching
 * that loader, we intercept exactly one call: dlopen.
 *
 * When the requested path resolves to a builtin module name, dlopen returns
 * the handle for the main program itself (dlopen(NULL)).  The module's four
 * ABI entry points are linked into skyjs and exported (-rdynamic on Linux,
 * -Wl,-export_dynamic on macOS), so the *unmodified* dlsym() in skynet_module.c
 * finds "<name>_create" etc. right there.  Every other path (test services,
 * third-party plugins) falls through to the real dlopen — fallback preserved.
 *
 * Only dlopen is wrapped; dlsym is left untouched.
 *
 *   Linux : ld --wrap=dlopen (__real_dlopen supplied by the linker).
 *   macOS : dyld __interpose; the real dlopen pointer is fetched once via
 *           dlsym(RTLD_NEXT, ...) so calling it does not re-enter the
 *           interposer (dlsym is not interposed).
 */

#ifndef _WIN32

#define _GNU_SOURCE
#include <dlfcn.h>
#include <string.h>

/* Modules folded into skyjs.  Extend here to build in more services. */
static const char *builtin[] = { "snjs", "logger", "skyclusterd", NULL };

/*
 * A cpath entry expands to something like "./cservice/snjs.so".  Take the
 * basename, drop a trailing ".so", and match against builtin[].
 */
static int
is_builtin_path(const char *path) {
	const char *base = strrchr(path, '/');
	base = base ? base + 1 : path;

	size_t len = strlen(base);
	if (len > 3 && strcmp(base + len - 3, ".so") == 0) {
		len -= 3;
	}

	for (int i = 0; builtin[i] != NULL; i++) {
		if (strlen(builtin[i]) == len && strncmp(base, builtin[i], len) == 0) {
			return 1;
		}
	}
	return 0;
}

#if defined(__linux__)

extern void *__real_dlopen(const char *path, int flag);

void *
__wrap_dlopen(const char *path, int flag) {
	if (path && is_builtin_path(path)) {
		return __real_dlopen(NULL, flag);	/* open self */
	}
	return __real_dlopen(path, flag);
}

#elif defined(__APPLE__)

static void *(*real_dlopen)(const char *, int);

__attribute__((constructor))
static void
init_real_dlopen(void) {
	/* dlsym is not interposed, so this yields the genuine libdyld dlopen. */
	real_dlopen = dlsym(RTLD_NEXT, "dlopen");
}

static void *
my_dlopen(const char *path, int flag) {
	if (path && is_builtin_path(path)) {
		return real_dlopen(NULL, flag);		/* open self */
	}
	return real_dlopen(path, flag);
}

/* Route every dlopen call in the image (incl. skynet_module.c) to my_dlopen. */
__attribute__((used))
static struct { const void *replacement; const void *replacee; }
interposers[] __attribute__((section("__DATA,__interpose"))) = {
	{ (const void *)my_dlopen, (const void *)dlopen },
};

#endif	/* platform */

#endif	/* !_WIN32 */
