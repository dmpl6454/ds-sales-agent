import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * TODAY'S SEND COUNT REACHES A SCREEN — a SOURCE GREP, deliberately.
 *
 * ── WHAT HAPPENED, AND WHY A BEHAVIOURAL TEST COULD NOT HAVE CAUGHT IT ────────
 *
 * On 2026-08-20 Tabish counted 59 delivered messages and asked where the dashboard says so.
 * It did not, anywhere. `fleetUsage()` had been computing `{ thisHour, today }` correctly for
 * days — `tests/fleet-reservations.test.ts` covers both halves in both directions — and the
 * page passed ONLY `thisHour` to the pace band. `today` was computed on every render and
 * thrown away.
 *
 * So every function was right and the product still could not answer the question. That is
 * the failure this file exists for, and it is this codebase's most repeated one: 166 cover
 * frames saved in a day and none read; `resetBrandResolverLimit` with zero callers;
 * `addSender` with no UI caller for weeks; `repliedAt` read in six places and written in
 * none. **The defect is a missing CALLER, and no behavioural test can fail for a caller
 * nobody has written.** Hence a grep, the same instrument as
 * `tests/one-route-rule.test.ts` and `tests/tag-evidence.test.ts`.
 *
 * ── AND THE SECOND HALF: THE FIGURE MUST NOT BE A `LIMIT` IN DISGUISE ─────────
 *
 * `buildMessagesPage` computed `sentToday` as `recentRaw.filter(...).length`, and `recentRaw`
 * is `take: 50`. With 59 sends that reads 50, then keeps reading 50 all day, under a label
 * saying "today". It has to come from `dispatch.usage.today` — the uncapped count the pacing
 * guard itself reads — so the page cannot report the day by a different rule than the
 * dispatcher, which is the `MAX_TOTAL_SENDS` lesson (the planner saw 6/6 and drafted nothing
 * for two days while the page showed 3/6 and rendered no blocker at all).
 *
 * The behavioural half of that lives in `tests/fleet-reservations.test.ts` — 60 rows against
 * a bound of 50, mutation-tested — because a grep cannot prove a number is uncapped. This
 * file only proves the page asks the right thing.
 */

const read = (p: string) => readFileSync(p, 'utf8')

const MESSAGES_PAGE = 'src/app/view-model/messages-page.ts'
const LANDING = 'src/app/page.tsx'
const PACE = 'src/app/pace.tsx'
const ANALYTICS = 'src/app/analytics/page.tsx'

describe('the day’s send count is taken from the enforcer', () => {
  it('buildMessagesPage reads dispatch.usage.today', () => {
    expect(read(MESSAGES_PAGE)).toMatch(/sentToday:\s*dispatch\.usage\.today/)
  })

  /**
   * The specific expression that was wrong, named so it cannot come back by hand. Anything
   * deriving the day from the recent-sends list is a page size masquerading as a total —
   * `recentRaw` is `take: 50` and every list on this page is bounded for rendering.
   */
  it('does not derive the day from the capped recent-sends list', () => {
    const src = read(MESSAGES_PAGE)
    const assignment = src.match(/sentToday:[^\n]*/g) ?? []
    expect(assignment.length).toBeGreaterThan(0)
    for (const line of assignment) {
      expect(line).not.toMatch(/recentRaw/)
    }
  })
})

describe('and it reaches a screen', () => {
  it('the landing page hands it to the pace band', () => {
    /* Both on one element: the prop is useless if the component never receives it. */
    expect(read(LANDING)).toMatch(/sentToday=\{m\.sentToday\}/)
    expect(read(LANDING)).toMatch(/<PaceBand/)
  })

  /**
   * RENDERED, not merely accepted as a prop. A component can take a value and draw nothing
   * with it, which is indistinguishable from this bug — so both the accessible label and a
   * visible node have to use it.
   */
  it('the pace band draws it and names it in the accessible label', () => {
    const src = read(PACE)
    expect(src).toMatch(/sentToday/)
    /* The phrase built from it, and the phrase folded into the band's aria-label. */
    expect(src).toMatch(/todayPhrase\s*=/)
    expect(src).toMatch(/\{todayPhrase\}/)
    expect(src).toMatch(/\$\{todayPhrase\}/)
  })

  /**
   * `/analytics` is the page Tabish looked at, and every stat in its headline grid is a
   * ROLLING SEVEN DAYS — so "messages sent" there reads as an answer to "how many today"
   * and is not one. It must state the day separately, from the same `fleetUsage`.
   */
  it('analytics states the day separately, from fleetUsage', () => {
    const src = read(ANALYTICS)
    expect(src).toMatch(/from '@\/outreach\/reservations'/)
    expect(src).toMatch(/fleetUsage\(\)/)
    expect(src).toMatch(/\{usage\.today\}/)
  })

  /**
   * The boundary is stated on screen wherever the figure is. It is the only thing that makes
   * the number checkable against Instagram by hand — and this repo has already shipped a day
   * boundary on the host's own clock once: the Linode is not on IST, so a machine-local
   * midnight is 5.5 hours out and the figure would be quietly wrong on the one host that
   * runs the schedule.
   */
  it('says which midnight, on both screens', () => {
    expect(read(PACE)).toMatch(/midnight IST/)
    expect(read(ANALYTICS)).toMatch(/midnight IST/)
  })
})
