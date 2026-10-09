/**
 * parkedRows.ts — ONE query's rows, TWO facts: this PAIR's unsettled park, and whether the
 * RECIPIENT's page is gone.
 *
 * The parked-failure stop is per pair — the pair that failed is the pair that rests — and that is
 * right for every failure but one. A page that answers "Sorry, this page isn't available" is a
 * fact about the RECIPIENT, and per-pair scoping is how four senders each drove Chrome three times
 * at @hemantpandeyji's dead page (8–9 Sept 2026): every pair's first look was its own. So the
 * planner and the gate now read all FAILED rows to the recipient in one query (the pair's own, plus
 * any `profile-gone` inside the re-check window) and split them here — one rule, two callers,
 * because the two disagreeing is the drift `gate.ts` was extracted to stop.
 *
 * PURE. The window is a week: long enough that a deleted account costs one anonymous probe a week
 * instead of twelve browser drives a day, short enough that a page renamed and restored is written
 * to again without anyone remembering to un-park anything.
 */
export const PROFILE_GONE_RECHECK_DAYS = 7

export interface ParkRow {
  failureCode: string | null
  queuedAt: Date
  pair: { senderId: string }
}

export function profileGoneFloor(now: Date): Date {
  return new Date(now.getTime() - PROFILE_GONE_RECHECK_DAYS * 86_400_000)
}

export function splitParks(
  rows: ParkRow[],
  senderId: string,
  now: Date,
): { parkedFailureCode: string | null; targetProfileGoneAt: Date | null } {
  // The pair's own park, in the order the old findFirst used: failureCode asc, then newest.
  const own = rows
    .filter((r) => r.pair.senderId === senderId && r.failureCode !== null && r.failureCode !== 'unreadable')
    .sort((a, b) => (a.failureCode! < b.failureCode! ? -1 : a.failureCode! > b.failureCode! ? 1 : b.queuedAt.getTime() - a.queuedAt.getTime()))
  const floor = profileGoneFloor(now).getTime()
  const gone = rows
    .filter((r) => r.failureCode === 'profile-gone' && r.queuedAt.getTime() >= floor)
    .sort((a, b) => b.queuedAt.getTime() - a.queuedAt.getTime())
  return { parkedFailureCode: own[0]?.failureCode ?? null, targetProfileGoneAt: gone[0]?.queuedAt ?? null }
}

/**
 * ── DOES A PARK KEEP ROTATION OFF THIS ROUTE? (2026-10-09) ─────────────────────────────
 *
 * Every parked failure rests its route — except `unreadable`, which only rests it for a WEEK.
 *
 * `unreadable` is a follow-up's pre-send READ that could not vouch for the thread three times,
 * not a failed send, so the gate and the governor do not count it (above): retiring a pair
 * forever because Instagram rendered a deep thread partially is the 3 Sept mistake. But
 * rotation was the one thing standing between that park and a fresh draft. With it gone
 * entirely the planner re-elected the same page on its next pass, wrote a new follow-up with
 * `attempts: 0`, and its pre-send read drove the same Chrome profile three more times — every
 * pass, without bound: the 1 Sept read-path loop, found by review before it shipped. With it
 * permanent (the state before), a recipient whose every page carried one stalled forever.
 *
 * A week is the `profile-gone` re-check window for the same reason: one bounded retry a week
 * instead of either a permanent stop or a loop. `queuedAt` is the park's clock, as it is for
 * `profile-gone` — a park does not move it, so it records the last time the draft was lined up.
 */
export const UNREADABLE_RECHECK_DAYS = 7

export function parkBlocksRoute(r: { failureCode: string | null; queuedAt: Date }, now: Date): boolean {
  if (r.failureCode === null) return false
  if (r.failureCode !== 'unreadable') return true
  return r.queuedAt.getTime() >= now.getTime() - UNREADABLE_RECHECK_DAYS * 86_400_000
}
