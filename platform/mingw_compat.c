/*
 * SkyJS MinGW compatibility wrapper.
 *
 * Modern MSYS2 mingw-w64 (winpthreads) already provides several POSIX
 * functions that skynet's legacy 3rd/compat-mingw layer also defines.
 * Compiling compat.c directly causes "redefinition" errors for these
 * symbols.
 *
 * Fix: rename the conflicting *definitions* via preprocessor macros
 * before including the original source.  The rest of skynet (and SkyJS)
 * will call the toolchain-provided versions, which is the correct
 * behaviour on a modern toolchain.  The renamed symbols compile into
 * compat.o as dead code and are harmless.
 *
 * IMPORTANT: 3rd/ files are NEVER modified (project hard constraint).
 *
 * --- Conflict inventory (checked against MSYS2 mingw-w64 12.x) ---
 *
 * clock_gettime  - provided by winpthreads (pthread_time.h).  CONFIRMED
 *                  CI failure: redefinition error.
 * usleep         - provided by mingw-w64 <unistd.h>.
 * sleep          - provided by mingw-w64 <unistd.h>.
 *
 * Functions NOT renamed (toolchain does NOT provide a conflicting
 * definition, or the compat implementation is specifically needed):
 *   kill, pipe (TCP-loopback), flock, fcntl, sigfillset, sigemptyset,
 *   sigaction, write, read, close (Winsock variants), daemon, strsep,
 *   dlopen, dlerror, dlsym, wepoll (epoll shim).
 */

/* Pull in the toolchain's own headers first so we can detect what it already
   provides.  On modern mingw-w64 <time.h> includes <pthread_time.h>, which
   defines _POSIX_TIMERS and an inline clock_gettime -- that inline is exactly
   what collides with skynet's own definition. */
#include <time.h>
#include <unistd.h>

/* Only rename clock_gettime out of the way when the toolchain actually ships
   its own (signalled by _POSIX_TIMERS from winpthreads).  If a toolchain does
   NOT provide it, keep skynet's definition -- otherwise renaming would turn
   the symbol into an undefined reference (Homebrew mingw vs. MSYS2 differ in
   principle; both current toolchains do provide it). */
#if defined(_POSIX_TIMERS)
#define clock_gettime  skyjs_compat_clock_gettime_unused
#endif

/* usleep/sleep are always provided by mingw-w64 (libmingwex); rename skynet's
   duplicate definitions so the toolchain versions are the ones that link. */
#define usleep         skyjs_compat_usleep_unused
#define sleep          skyjs_compat_sleep_unused

#include "../3rd/skynet/3rd/compat-mingw/compat.c"
