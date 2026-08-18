import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { decideSlotLock } from '@/worker/runSlot'
import { readNumericSetting, describeCap } from '@/lib/settings'
import { FAILURE_CODES } from '@/lib/constants'

/**
 * Phase 0 — the live defects.
 *
 * Every guard here is exercised in BOTH directions: firing and permitting. This codebase
 * has an eleven-instance history of guards checked only where they pass, and each of
 * those read as healthy for exactly that reason.
 *
 * (a) lives in `matching.test.ts`, next to the function it fixes.
 * (c) lives in `session-paths.test.ts`, next to the other enforcement tests.
 */

describe('decideSlotLock — a hung slot is not a dead slot  [defect e]', () => {
  const HELD = { pid: 4242, slot: '11:00', at: '2026-08-04T05:30:00.000Z' }
  const OURS = 999

  /**
   * THE FIX. Age used to overrule liveness (`alive && ageMs < STALE`), so a slot running
   * for longer than 30 minutes was declared dead and a second one started beside it.
   * `feed.ts` had no request timeout and `ScrapeRun` holds runs of 3957 s, 7574 s and
   * 24674 s — every one of those was hung but ALIVE.
   */
  it('declines while the holder is alive, however old the lock is', () => {
    expect(decideSlotLock({ held: HELD, holderAlive: true, ourPid: OURS, ageMs: 1_000 })).toEqual({
      action: 'decline',
      stalled: false,
    })
    expect(decideSlotLock({ held: HELD, holderAlive: true, ourPid: OURS, ageMs: 10 * 60 * 60_000 })).toEqual({
      action: 'decline',
      stalled: true,
    })
  })

  it('flags a live-but-stalled holder so it is an alarm rather than a silence', () => {
    const fresh = decideSlotLock({ held: HELD, holderAlive: true, ourPid: OURS, ageMs: 29 * 60_000 })
    const stalled = decideSlotLock({ held: HELD, holderAlive: true, ourPid: OURS, ageMs: 31 * 60_000 })
    expect(fresh).toEqual({ action: 'decline', stalled: false })
    expect(stalled).toEqual({ action: 'decline', stalled: true })
  })

  /** The other direction: the lock must still be reclaimable, or a crash deadlocks it forever. */
  it('takes over when the holder process is gone', () => {
    expect(decideSlotLock({ held: HELD, holderAlive: false, ourPid: OURS, ageMs: 1_000 })).toEqual({
      action: 'take-over',
    })
  })

  it('takes over our own row', () => {
    expect(decideSlotLock({ held: { ...HELD, pid: OURS }, holderAlive: true, ourPid: OURS, ageMs: 1_000 })).toEqual({
      action: 'take-over',
    })
  })

  it('takes over an unparseable row rather than deadlocking forever', () => {
    expect(decideSlotLock({ held: null, holderAlive: false, ourPid: OURS, ageMs: Infinity })).toEqual({
      action: 'take-over',
    })
  })
})

describe('readNumericSetting — a Setting row overriding validated env  [defect h]', () => {
  let warn: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    warn.mockRestore()
  })

  it('uses the fallback when no row exists', () => {
    expect(readNumericSetting('maxPerPairPerDay', undefined, 2)).toBe(2)
    expect(warn).not.toHaveBeenCalled()
  })

  it('accepts a sane whole number', () => {
    expect(readNumericSetting('maxPerPairPerDay', '5', 2)).toBe(5)
    expect(warn).not.toHaveBeenCalled()
  })

  /**
   * NO CEILING, deliberately. Tabish reversed the 1/day per-recipient cap on 2026-08-04
   * — he considers it "laughingly low" — so this clamps the SHAPE and leaves the
   * magnitude to the operator. What changed is that 1000 is no longer accepted SILENTLY
   * while the range-checked env value it replaced quietly stopped applying.
   */
  it('accepts a large value — the shape is clamped, not the ceiling', () => {
    expect(readNumericSetting('maxPerPairPerDay', '1000', 2)).toBe(1000)
  })

  it.each([
    ['not a number', 'banana'],
    ['empty', '   '],
    ['fractional', '2.5'],
    ['zero', '0'],
    ['negative', '-5'],
  ])('refuses a %s value, falls back, and says so loudly', (_label, raw) => {
    expect(readNumericSetting('maxPerPairPerDay', raw, 2)).toBe(2)
    expect(warn).toHaveBeenCalledOnce()
    expect(String(warn.mock.calls[0]?.[0])).toContain('maxPerPairPerDay')
  })

  describe('unlimited', () => {
    it('is accepted ONLY where the caller allows it', () => {
      expect(readNumericSetting('maxPerPairPerDay', 'unlimited', 2, { allowUnlimited: true })).toBe(Infinity)
      expect(readNumericSetting('unlimited', 'none', 2, { allowUnlimited: true })).toBe(Infinity)
      // Not allowed here: a minimum gap has no meaningful "unlimited", so it is a typo.
      expect(readNumericSetting('fleetMinGapMinutes', 'unlimited', 5)).toBe(5)
      expect(warn).toHaveBeenCalledOnce()
    })

    /** Infinity beats every count, which is what "no cap" has to mean downstream. */
    it('makes every cap comparison pass', () => {
      const cap = readNumericSetting('maxPerPairPerDay', 'unlimited', 2, { allowUnlimited: true })
      expect(0 >= cap).toBe(false)
      expect(14 >= cap).toBe(false)
      expect(1_000_000 >= cap).toBe(false)
    })

    /** ...and the other direction: a real cap still binds. */
    it('a real cap still binds', () => {
      const cap = readNumericSetting('maxPerPairPerDay', '2', 1)
      expect(1 >= cap).toBe(false)
      expect(2 >= cap).toBe(true)
    })

    it('never reaches a screen as the word "Infinity"', () => {
      expect(describeCap(Infinity)).toBe('unlimited')
      expect(describeCap(2)).toBe('2')
    })
  })
})

describe('FAILURE_CODES  [defect g]', () => {
  /**
   * `not-in-thread` is the reason this union exists. It means the composer CLEARED and
   * the message never appeared — simultaneously what a shadow restriction looks like from
   * outside AND the one failure where the recipient may actually have the message. It
   * must never be indistinguishable from "the paste did not land".
   */
  it('distinguishes not-in-thread from an ordinary failure', () => {
    expect(FAILURE_CODES).toContain('not-in-thread')
    expect(FAILURE_CODES).toContain('still-staged')
    expect(new Set(FAILURE_CODES).size).toBe(FAILURE_CODES.length)
  })

  it('is a closed list', () => {
    expect(FAILURE_CODES).not.toContain('')
    for (const c of FAILURE_CODES) expect(c).toMatch(/^[a-z-]+$/)
  })
})
