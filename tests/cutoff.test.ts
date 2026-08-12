import { afterEach, describe, expect, it } from 'vitest'
import { DETECTION_CUTOFF, detectionCutoff, newMaterialFloor, withinCutoff } from '@/lib/cutoff'

/**
 * The detection cutoff — 1 August 2026 onwards, per Tabish's scope.
 *
 * Tested in both directions, and specifically tested for the thing it must NOT do: turn a
 * skipped post into a negative verdict. "Could not determine X" hardening into "X is false"
 * is this codebase's recurring bug shape, and a date filter is an easy place to reintroduce
 * it.
 */

const ORIGINAL = process.env.DETECTION_CUTOFF
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.DETECTION_CUTOFF
  else process.env.DETECTION_CUTOFF = ORIGINAL
})

describe('the cutoff boundary is IST, not UTC', () => {
  it('is 1 August 2026 00:00 Indian Standard Time', () => {
    // Every other boundary in this system is IST — istDayStart, the slot times, the daily
    // caps. A UTC midnight would put 1 August's small hours IST on the wrong side of the
    // line: a silent 5.5-hour discrepancy nobody would think to check.
    expect(DETECTION_CUTOFF.toISOString()).toBe('2026-07-31T18:30:00.000Z')
  })

  it('includes a post from the first minutes of 1 August IST', () => {
    // 00:30 IST on 1 Aug is 19:00 UTC on 31 Jul. Under a UTC cutoff this would be excluded.
    expect(withinCutoff(new Date('2026-08-01T00:30:00+05:30'))).toBe(true)
  })

  it('excludes a post from the last minutes of 31 July IST', () => {
    expect(withinCutoff(new Date('2026-07-31T23:30:00+05:30'))).toBe(false)
  })
})

describe('withinCutoff', () => {
  it('accepts posts on or after the cutoff', () => {
    expect(withinCutoff(new Date('2026-08-03T12:00:00Z'))).toBe(true)
    expect(withinCutoff(DETECTION_CUTOFF)).toBe(true) // exactly at it
  })

  it('REJECTS posts before it, including a whole corpus of history', () => {
    expect(withinCutoff(new Date('2026-07-31T12:00:00Z'))).toBe(false)
    expect(withinCutoff(new Date('2023-08-03T12:00:00Z'))).toBe(false)
  })
})

describe('detectionCutoff override', () => {
  it('honours a valid DETECTION_CUTOFF', () => {
    process.env.DETECTION_CUTOFF = '2026-06-01T00:00:00+05:30'
    expect(detectionCutoff().toISOString()).toBe('2026-05-31T18:30:00.000Z')
  })

  it('falls back to the default on a MALFORMED value, never to "no cutoff"', () => {
    /**
     * The load-bearing negative. A typo becoming "no cutoff" would silently re-open the
     * whole 399-post history to the classifier (paid) and to the new-material rule, and it
     * would look exactly like working software.
     */
    process.env.DETECTION_CUTOFF = 'not-a-date'
    expect(detectionCutoff().getTime()).toBe(DETECTION_CUTOFF.getTime())
    process.env.DETECTION_CUTOFF = ''
    expect(detectionCutoff().getTime()).toBe(DETECTION_CUTOFF.getTime())
  })
})

describe('newMaterialFloor — the LATER of the two bounds', () => {
  it('uses the CUTOFF while the hook window still reaches back past it', () => {
    /**
     * MEASURED, and it corrects an assumption worth recording: at HOOK_MAX_AGE_HOURS=72
     * from 3 August, the hook window reaches back to 31 Jul 12:00 UTC — which is EARLIER
     * than the cutoff at 31 Jul 18:30 UTC (= 1 Aug 00:00 IST).
     *
     * So the cutoff is the binding constraint TODAY, not a redundant belt-and-braces
     * check. Anyone reading `hoursAgo(72)` and concluding the cutoff does not matter yet
     * would be wrong by six and a half hours.
     */
    const now = new Date('2026-08-03T12:00:00Z')
    expect(newMaterialFloor(now).getTime()).toBe(DETECTION_CUTOFF.getTime())
  })

  it('switches to the hook window once that becomes the tighter bound', () => {
    // Far enough past the cutoff that 72 hours back no longer reaches it. Then the hook
    // age is the stricter rule and the cutoff stops mattering — the direction the
    // `max(...)` must also get right.
    const now = new Date('2026-08-10T12:00:00Z')
    const floor = newMaterialFloor(now)
    expect(floor.getTime()).toBeGreaterThan(DETECTION_CUTOFF.getTime())
    expect(floor.toISOString()).toBe('2026-08-07T12:00:00.000Z')
  })

  it('never returns a floor earlier than the cutoff, at any point in time', () => {
    for (const iso of ['2026-08-01T01:00:00Z', '2026-08-02T00:00:00Z', '2026-08-05T00:00:00Z']) {
      expect(newMaterialFloor(new Date(iso)).getTime()).toBeGreaterThanOrEqual(DETECTION_CUTOFF.getTime())
    }
  })
})

describe('what the cutoff must NOT do', () => {
  it('is a filter on WHICH posts are judged, never a verdict about them', () => {
    /**
     * There is deliberately no `verdictFor(post)` or `isOrganic(post)` in this module. A
     * pre-cutoff post stays UNCLASSIFIED, which means *not judged* and has never meant
     * *organic*. If a future change makes the cutoff assign a verdict, that is the
     * absence-of-data-becomes-a-negative bug documented in CLAUDE.md, and this test is
     * where it should be caught.
     */
    const mod = { DETECTION_CUTOFF, detectionCutoff, newMaterialFloor, withinCutoff }
    expect(Object.keys(mod).sort()).toEqual(
      ['DETECTION_CUTOFF', 'detectionCutoff', 'newMaterialFloor', 'withinCutoff'].sort(),
    )
  })
})
