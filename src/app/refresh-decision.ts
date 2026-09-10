/**
 * SHOULD THIS TICK RE-RENDER THE PAGE? — PURE, so `auto-refresh.tsx` stays a thin wrapper.
 *
 * `auto-refresh.tsx` is a `'use client'` component and this module is imported by it, so it
 * must stay free of server-only imports (no `db.ts`, no `gate.ts`, no view models — the
 * `waiting.tsx → gate.ts → better-sqlite3` trap that once returned HTTP 500 on every route).
 * It imports nothing.
 *
 * The four answers, in the order they are asked:
 *
 *   hidden     → skip      a backgrounded tab renders for nobody. Nothing is recorded
 *                          either, so the first poll after the tab returns sets the
 *                          baseline afresh and a change while hidden is caught then.
 *   no prev    → baseline  the FIRST stamp only records what "unchanged" looks like. It never
 *                          refreshes: the page was server-rendered moments ago and a refresh
 *                          on mount would be one more render for nothing — which, on the
 *                          starved box this exists for, is exactly the pile-up.
 *   same       → skip      the common case, and the whole point: an idle dashboard renders
 *                          nothing.
 *   pending    → skip      a refresh is still in flight. The old timer fired again while a
 *                          60-second refresh was still running, so renders stacked behind
 *                          each other. Skipping does not lose the change — `prev` is NOT
 *                          advanced on a skip, so the next tick sees the same difference and
 *                          refreshes once the transition has settled.
 *   otherwise  → refresh   and the caller records `next` as the new baseline.
 */
export type RefreshDecision = 'baseline' | 'refresh' | 'skip'

export function decideRefresh(input: {
  /** The stamp last recorded, or null before the first successful poll. */
  prev: string | null
  /** The stamp the pulse just returned. */
  next: string
  /** Is a `router.refresh()` transition still running? */
  pending: boolean
  /** `document.hidden` at the moment of the poll. */
  hidden: boolean
}): RefreshDecision {
  if (input.hidden) return 'skip'
  if (input.prev === null) return 'baseline'
  if (input.next === input.prev) return 'skip'
  if (input.pending) return 'skip'
  return 'refresh'
}
/**
 * SHOULD THIS TAB RELOAD ITSELF? The server's build (from the pulse) against the build this
 * page was rendered by. Unknown on either side is a skip — "we could not compare" must never
 * reload a page someone is typing into — and so is a hidden tab, which reloads when it is next
 * looked at (the visibility handler polls immediately).
 */
export type ReloadDecision = 'reload' | 'skip'
export function decideReload(input: { rendered: string; live: string | null; hidden: boolean }): ReloadDecision {
  if (input.hidden) return 'skip'
  if (input.live === null || input.live === '' || input.live === 'unknown') return 'skip'
  if (input.rendered === '' || input.rendered === 'unknown') return 'skip'
  return input.live === input.rendered ? 'skip' : 'reload'
}
