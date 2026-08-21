import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * A CAPPED FEED MUST ANNOUNCE ITS CAP — the 07:51 incident, 2026-08-21.
 *
 * The fleet ran all night at ~30 sends an hour: **280 delivered, the first at 00:01:43 IST**,
 * every hour of the night in the high twenties or low thirties. Tabish read the activity feed
 * and asked why the day's first message was at **07:51**. It was not. `recentSends` is
 * `take: 40`, and 07:51:32 is exactly the 40th-newest send — the feed was showing the newest
 * forty of two hundred and eighty, silently, so its bottom row became a start time.
 *
 * ── WHY THIS IS A TEST AND NOT A COMMENT ──────────────────────────────────
 *
 * Every NUMBER on that page was correct. The counter said 280; the rows it drew were real
 * sends at real times. What was wrong was an INFERENCE the layout invited, and no assertion
 * about a value could have failed for it — which is precisely why the day before, a `take: 50`
 * feeding `sentToday` was catchable by a 60-row fixture and this was not.
 *
 * So the guard is structural: the day carries its own total, and the render must compare the
 * two. A grep, because the failure mode is somebody deleting the sentence — and because the
 * data half (`shown`/`total`) is worthless if nothing draws it, the same
 * missing-caller shape as `usage.today` reaching no screen.
 */

const root = join(import.meta.dirname, '..')
const read = (p: string) => readFileSync(join(root, p), 'utf8')

describe('the activity feed cannot be read as a complete record', () => {
  it('a day carries its own delivered total, counted independently of the capped list', () => {
    const src = read('src/app/view-model.ts')
    expect(src).toMatch(/shown:\s*evs\.filter/)
    expect(src).toMatch(/perDayDelivered/)
    /**
     * The total must come from a real count, NOT from the list the cap applies to.
     * Deriving it from `recentSends` would agree with the truncation and report 40 of 40 —
     * a check that verifies its own symmetry, already recorded in this repo twice.
     */
    const window = src.slice(src.indexOf('const perDayDelivered'), src.indexOf('const activity: ActivityDay[]'))
    expect(window).toMatch(/prisma\.outreachAttempt\.findMany/)
    expect(window).not.toMatch(/recentSends/)
  })

  it('the page renders the comparison, not just the rows', () => {
    const src = read('src/app/analytics/page.tsx')
    /* The guard is the CONDITION: a day that is complete must say nothing. */
    expect(src).toMatch(/day\.total\s*>\s*day\.shown/)
    expect(src).toMatch(/\{day\.shown\}/)
    expect(src).toMatch(/\{day\.total\}/)
  })
})
