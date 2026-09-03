/*
 * The .app's main executable — a real Mach-O, because notarisation needs one.
 *
 * ── WHY THIS EXISTS (2026-09-03) ───────────────────────────────────────────
 *
 * The bundle used to run `launcher.sh` directly as CFBundleExecutable. That is signable but
 * NOT reliably notarisable: the hardened runtime Apple requires is a load command in a Mach-O
 * header, and a shell script has no header to carry it. Every tool that ships a script as an
 * app (Platypus and its imitators) wraps it in a compiled stub for exactly this reason.
 *
 * So this stub is the executable and the shell script became a RESOURCE — sealed by the same
 * signature, so its integrity is protected, while the thing Gatekeeper inspects is a proper
 * universal binary. All behaviour stayed in the script, where it is readable and editable.
 *
 * Spawning /bin/bash from a hardened-runtime process is allowed: the runtime restricts what
 * can be loaded INTO this process (library validation, injection), not what it may exec.
 */
#include <limits.h>
#include <mach-o/dyld.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

int main(void) {
  char exe[PATH_MAX];
  uint32_t size = (uint32_t)sizeof(exe);
  if (_NSGetExecutablePath(exe, &size) != 0) return 1;

  /* Resolve symlinks, then strip MacOS/<name> to reach Contents. `dirname` is avoided on
     purpose: on macOS it may return a pointer to static storage that the next call reuses. */
  char path[PATH_MAX];
  if (realpath(exe, path) == NULL) return 1;
  char *slash = strrchr(path, '/');
  if (slash == NULL) return 1;
  *slash = '\0';                    /* .../Contents/MacOS */
  slash = strrchr(path, '/');
  if (slash == NULL) return 1;
  *slash = '\0';                    /* .../Contents      */

  char script[PATH_MAX];
  if (snprintf(script, sizeof(script), "%s/Resources/launcher.sh", path) >= (int)sizeof(script)) return 1;

  execl("/bin/bash", "bash", script, (char *)NULL);
  perror("DS Sales Agent: could not start the launcher");
  return 1;
}
