/**
 * ── A TAB OPEN FROM BEFORE A DEPLOY ────────────────────────────────────────────────────
 *
 * A server action is addressed by a build-specific id. Deploy, and every dashboard tab that
 * was open beforehand goes on calling ids the new server no longer has: Next answers
 * `Server Action "…" was not found on the server`, and the button does nothing useful.
 * MEASURED 2026-09-10: Tabish switched the sending Mac back and the switch failed with exactly
 * that sentence — two deploys had happened under his open tab. `router.refresh()` does not
 * help (it re-renders server components, the client bundle and its ids stay old); only a full
 * reload does. Two closures share this module: `build-watch.tsx` reloads a tab proactively
 * when the pulse reports a different build, and the controls that matter most catch the
 * rejection and reload at once, saying why. Client-safe: imports nothing.
 */
export function isStaleServerAction(err: unknown): boolean {
  const text = err instanceof Error ? err.message : String(err)
  return /Server Action .* was not found/i.test(text) || /failed-to-find-server-action/i.test(text)
}

export const STALE_BUILD_MESSAGE = 'This page was open before the dashboard was updated — reloading it now…'

/** A moment for the sentence to be read, then the reload that fixes it. */
export function reloadForStaleBuild(delayMs = 1200): void {
  if (typeof window === 'undefined') return
  window.setTimeout(() => window.location.reload(), delayMs)
}
