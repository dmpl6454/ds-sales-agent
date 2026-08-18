import { describe, expect, it } from 'vitest'
import { BRAND_BLOCKS, checkNewBrandTouchCap } from '@/outreach/brandGuards'

/**
 * The brand guards, both directions.
 *
 * A guard verified only where it refuses is this codebase's signature failure — eight
 * instances, documented. For an auth-shaped or cap-shaped rule, "blocks everything" and
 * "blocks nothing" pass the same one-sided test.
 *
 * THE PERSONA GATE IS GONE (2026-08-18): the standard message is sent verbatim with no
 * signature block, so persona distinctness stopped being a property of anything a
 * recipient sees. `checkPersonaDistinct` and its tests were deleted with it.
 */

describe('checkNewBrandTouchCap', () => {
  /**
   * ── TWO COUNTERS SINCE 2026-08-13, AND THE OLD ONE COULD NOT BIND ──────────────────
   *
   * This suite used to pass a single `newBrandTouchesToday`, and every case here passed
   * against a rule that was inert in production: the number came from DELIVERED messages,
   * nothing has ever been delivered, so it was permanently 0. The only thing bounding new
   * brand outreach was a counter reset at the top of every planner run — "2 a day"
   * enforced as "2 a run".
   *
   * Note what that means about these tests: they were CORRECT and they were measuring a
   * function whose real input was always zero. A pure test cannot see that; it is why the
   * two counters are now separate arguments, so a call site cannot pass the inert one and
   * look complete.
   */
  const ask = (over: Partial<Parameters<typeof checkNewBrandTouchCap>[0]> = {}) =>
    checkNewBrandTouchCap({
      waitingFirstTouches: 0,
      maxWaitingNewBrandDrafts: 2,
      firstTouchesDeliveredToday: 0,
      maxNewBrandTouchesPerDay: 2,
      isFirstTouch: true,
      ...over,
    })

  it('allows a first touch under the cap', () => {
    expect(ask().ok).toBe(true)
    expect(ask({ waitingFirstTouches: 1, firstTouchesDeliveredToday: 1 }).ok).toBe(true)
  })

  it('REFUSES when the WAITING queue is full, and names the room', () => {
    const r = ask({ waitingFirstTouches: 2 })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason).toBe(BRAND_BLOCKS.NEW_BRAND_DAILY_CAP)
      // "nothing happened" with no explanation is the failure this project keeps hitting.
      expect(r.detail).toContain('2')
      /*
        NOT "tomorrow" any more, and that word going is the point of the 2026-08-17 change.
        The queue bound is a DEPTH, so waiting is not what clears it — sending or discarding
        is, and that can happen in the next minute. Telling an operator to wait for tomorrow
        would now be false, and it is exactly the class of statement this project treats as a
        defect: a page reporting a limit by a different rule than the one enforcing it.
      */
      expect(r.detail).not.toContain('tomorrow')
      expect(r.detail).toMatch(/send or discard/i)
      expect(r.detail, 'the refusal must say which of the two counters bound').toContain('waiting')
    }
  })

  /**
   * THE HALF THAT WAS THE ONLY ONE IMPLEMENTED, AND WHICH STILL MATTERS. Drafts can be
   * discarded and rewritten; what a stranger actually received is the fact the rule was
   * written about. It binds on its own, with nothing written today.
   */
  it('REFUSES at the cap on messages DELIVERED, independently of what was written', () => {
    const r = ask({ waitingFirstTouches: 0, firstTouchesDeliveredToday: 2 })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.detail).toContain('contacted today')
  })

  it('neither counter is a substitute for the other — one at the cap is enough', () => {
    expect(ask({ waitingFirstTouches: 2, firstTouchesDeliveredToday: 0 }).ok).toBe(false)
    expect(ask({ waitingFirstTouches: 0, firstTouchesDeliveredToday: 2 }).ok).toBe(false)
    expect(ask({ waitingFirstTouches: 1, firstTouchesDeliveredToday: 1 }).ok).toBe(true)
  })

  it('refuses when already over the cap, not just exactly at it', () => {
    expect(ask({ waitingFirstTouches: 9 }).ok).toBe(false)
    expect(ask({ firstTouchesDeliveredToday: 9 }).ok).toBe(false)
  })

  it('does NOT cap follow-ups — they are a continuing conversation', () => {
    /**
     * A follow-up is already bounded by the pair daily cap and the new-material rule.
     * Counting it here would make a legitimate second message compete with a new prospect
     * for the same daily slot, and quietly starve one of them.
     */
    expect(ask({ waitingFirstTouches: 99, firstTouchesDeliveredToday: 99, isFirstTouch: false }).ok).toBe(true)
  })

  it('a cap of 0 stops all new brands but still permits follow-ups', () => {
    // Pausing discovery-driven outreach must not also halt live conversations.
    expect(ask({ maxNewBrandTouchesPerDay: 0 }).ok).toBe(false)
    expect(ask({ maxNewBrandTouchesPerDay: 0, isFirstTouch: false }).ok).toBe(true)
  })
})

/**
 * ── THE TWO CAPS ARE INDEPENDENT NUMBERS NOW (2026-08-17, Tabish) ─────────────────────
 *
 * *"cap should not exist for drafts should it, what if we discover several targets?"*
 *
 * They shared one number and the queue counter was checked FIRST, so once the queue held N
 * first touches nothing more was written — and the DELIVERY cap could therefore never be
 * reached. The counter carrying the actual safety argument was unreachable in practice.
 *
 * And because the queue counter was a daily CREATION rate, discarding a draft spent the
 * day's allowance on a message nobody received. MEASURED: 9 discarded + 1 written read
 * 10/10, and no new company could be contacted for the rest of that day.
 */
describe('the queue bound and the delivery cap are separate', () => {
  const ask = (over: Partial<Parameters<typeof checkNewBrandTouchCap>[0]> = {}) =>
    checkNewBrandTouchCap({
      waitingFirstTouches: 0,
      maxWaitingNewBrandDrafts: 150,
      firstTouchesDeliveredToday: 0,
      maxNewBrandTouchesPerDay: 10,
      isFirstTouch: true,
      ...over,
    })

  /** Discovering a lot of companies must fill the queue, not stall drafting for the day. */
  it('keeps writing well past the DELIVERY cap, because a draft reaches nobody', () => {
    expect(ask({ waitingFirstTouches: 40 }).ok).toBe(true)
    expect(ask({ waitingFirstTouches: 149 }).ok).toBe(true)
  })

  it('stops at the queue depth, and says how to make room', () => {
    const r = ask({ waitingFirstTouches: 150 })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.detail).toMatch(/send or discard/i)
  })

  /**
   * THE ONE THAT WAS UNREACHABLE. With a shared number the queue check fired first and the
   * delivery cap never got a chance; here the queue is nearly empty and delivery still binds.
   */
  it('the DELIVERY cap binds on its own, with an empty queue', () => {
    const r = ask({ waitingFirstTouches: 0, firstTouchesDeliveredToday: 10 })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.detail).toMatch(/contacted today/i)
  })

  /**
   * MUTATION TEST for the regression that prompted this: a discarded draft is not waiting,
   * so it must not hold a slot. Modelled by the count simply being lower — which is exactly
   * what `readNewBrandTouchCounts` now reports, because it queries READY/QUEUED only.
   */
  it('room returns as soon as the queue shrinks', () => {
    expect(ask({ waitingFirstTouches: 150 }).ok).toBe(false)
    expect(ask({ waitingFirstTouches: 149 }).ok).toBe(true)
  })
})
