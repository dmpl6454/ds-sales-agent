import { describe, expect, it } from 'vitest'
import { BRAND_BLOCKS, checkNewBrandTouchCap, checkPersonaDistinct } from '@/outreach/brandGuards'

/**
 * Both brand guards, both directions.
 *
 * A guard verified only where it refuses is this codebase's signature failure — eight
 * instances, documented. For an auth-shaped or cap-shaped rule, "blocks everything" and
 * "blocks nothing" pass the same one-sided test.
 */

const KAPIL = {
  personaName: 'Kapil Jain',
  personaRole: 'Co-founder',
  personaBrand: 'Bollywood Society',
  personaPhone: '+91 60000 189766',
  personaEmail: 'kapil@digitalsukoon.com',
}

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
     * A follow-up is already spaced by cooldownDays and bounded by maxUnansweredTouches.
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

describe('checkPersonaDistinct — decision 3b, enforced', () => {
  it('REFUSES a brand pitch when the persona is shared with another sender', () => {
    /**
     * The live state as of 2026-08-03: all four senders carry the identical
     * "Kapil Jain, Co-founder, Bollywood Society" block, so a DM from
     * @madaboutmarketingg introduces the co-founder of a different company.
     */
    const r = checkPersonaDistinct({ persona: KAPIL, otherPersonas: [KAPIL], targetKind: 'BRAND' })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason).toBe(BRAND_BLOCKS.PERSONA_NOT_DISTINCT)
      // The refusal names what the recipient actually sees — the signature block, which
      // since 2026-08-07 is the page name and contacts, not a person.
      expect(r.detail).toContain('Bollywood Society')
      expect(r.detail).toContain('kapil@digitalsukoon.com')
    }
  })

  it('ALLOWS a brand pitch once the persona is genuinely its own', () => {
    // The direction that must work, or the gate is just an off switch and supplying real
    // personas would change nothing.
    const distinct = { ...KAPIL, personaName: 'Someone Else', personaEmail: 'someone@digitalsukoon.com' }
    expect(checkPersonaDistinct({ persona: distinct, otherPersonas: [KAPIL], targetKind: 'BRAND' }).ok).toBe(true)
  })

  it('allows a brand pitch when there are no other senders at all', () => {
    expect(checkPersonaDistinct({ persona: KAPIL, otherPersonas: [], targetKind: 'BRAND' }).ok).toBe(true)
  })

  /**
   * ── DECISION 6, taken by Tabish 2026-08-04 ──────────────────────────────
   *
   * The gate now covers CHANNEL sends too. It used to cover brands only, on the
   * reasoning that a brand's social team reads pitches for a living while a publisher is
   * a softer audience — and that halting channel outreach was a bigger change than this
   * guard was entitled to make alone.
   *
   * At 65 accounts that inverts. 63 pages emitting one byte-identical contact block is
   * the cross-account fingerprint decision 3 exists to prevent, and rotation makes it
   * worse in the specific way that matters: the whole point is that a recipient hears
   * from a different page each time, and an identical signature underneath every one
   * announces that the pages are one operation.
   *
   * THE ACCEPTED CONSEQUENCE: with every account still carrying *Kapil Jain, Co-founder,
   * Bollywood Society*, this halts ALL outreach until each has a persona of its own.
   */
  it('NOW gates channels too — decision 6', () => {
    expect(checkPersonaDistinct({ persona: KAPIL, otherPersonas: [KAPIL], targetKind: 'CHANNEL' }).ok).toBe(false)
  })

  it('names the audience correctly in each case', () => {
    const brand = checkPersonaDistinct({ persona: KAPIL, otherPersonas: [KAPIL], targetKind: 'BRAND' })
    const channel = checkPersonaDistinct({ persona: KAPIL, otherPersonas: [KAPIL], targetKind: 'CHANNEL' })
    expect(brand.ok).toBe(false)
    expect(channel.ok).toBe(false)
    if (!brand.ok) expect(brand.detail).toContain('a brand pitch must sign off as')
    if (!channel.ok) expect(channel.detail).toContain('a message must sign off as')
  })

  /**
   * A FLAG, not a hardcode, because switching it on halts live outreach and whoever is
   * mid-way through editing 63 personas has to be able to finish. Default is ON — the
   * safe direction is the one that refuses.
   */
  it('can be switched off for channels while brands stay gated', () => {
    expect(
      checkPersonaDistinct({ persona: KAPIL, otherPersonas: [KAPIL], targetKind: 'CHANNEL', gateChannels: false }).ok,
    ).toBe(true)
    // ...and a brand is STILL refused, whatever the channel flag says.
    expect(
      checkPersonaDistinct({ persona: KAPIL, otherPersonas: [KAPIL], targetKind: 'BRAND', gateChannels: false }).ok,
    ).toBe(false)
  })

  it('defaults to ON when the flag is not supplied at all', () => {
    expect(checkPersonaDistinct({ persona: KAPIL, otherPersonas: [KAPIL], targetKind: 'CHANNEL' }).ok).toBe(false)
  })

  /** The direction that must work, or the gate is just an off switch. */
  it('ALLOWS a channel message once the persona is genuinely its own', () => {
    const distinct = { ...KAPIL, personaName: 'Someone Else', personaEmail: 'someone@digitalsukoon.com' }
    expect(checkPersonaDistinct({ persona: distinct, otherPersonas: [KAPIL], targetKind: 'CHANNEL' }).ok).toBe(true)
  })

  it('catches a clash differing only in case or whitespace', () => {
    // "Distinct" must mean distinct to a reader, not to a byte comparison.
    const sneaky = { ...KAPIL, personaName: '  KAPIL JAIN  ' }
    expect(checkPersonaDistinct({ persona: sneaky, otherPersonas: [KAPIL], targetKind: 'BRAND' }).ok).toBe(false)
  })

  it('compares exactly what RENDERS, which grew back on 2026-08-17', () => {
    /**
     * The fingerprint's contract is "excludes nothing that appears in the message, includes
     * nothing that does not" — the RULE is the contract, not the field list, and the field
     * list follows the copy.
     *
     * 2026-08-07 → the signature was the page name and contacts alone, so `personaName`
     * reached nobody and two accounts differing only by it had to CLASH.
     * 2026-08-17 → Tabish's standard message opens "I'm Kapil Jain, Co-founder of <page>."
     * and signs with both, so the name renders again and now DOES distinguish.
     *
     * Note this does not weaken the gate: all four live accounts share the name, so the
     * page name is still what separates them in practice.
     */
    const differentPerson = { ...KAPIL, personaName: 'Different Person' }
    expect(checkPersonaDistinct({ persona: differentPerson, otherPersonas: [KAPIL], targetKind: 'BRAND' }).ok).toBe(true)

    // What the recipient DOES see makes accounts distinct: the page name, or a contact.
    const ownBrand = { ...KAPIL, personaBrand: 'Bollywood Chronicle' }
    expect(checkPersonaDistinct({ persona: ownBrand, otherPersonas: [KAPIL], targetKind: 'BRAND' }).ok).toBe(true)
    const ownPhone = { ...KAPIL, personaPhone: '+91 98765 43210' }
    expect(checkPersonaDistinct({ persona: ownPhone, otherPersonas: [KAPIL], targetKind: 'BRAND' }).ok).toBe(true)

    const identical = { ...KAPIL }
    expect(checkPersonaDistinct({ persona: identical, otherPersonas: [KAPIL], targetKind: 'BRAND' }).ok).toBe(false)
  })

  it('detects a clash against ANY of several other senders, not just the first', () => {
    const a = { ...KAPIL, personaName: 'Person A', personaEmail: 'a@x.com' }
    const b = { ...KAPIL, personaName: 'Person B', personaEmail: 'b@x.com' }
    expect(checkPersonaDistinct({ persona: b, otherPersonas: [a, b], targetKind: 'BRAND' }).ok).toBe(false)
    const c = { ...KAPIL, personaName: 'Person C', personaEmail: 'c@x.com' }
    expect(checkPersonaDistinct({ persona: c, otherPersonas: [a, b], targetKind: 'BRAND' }).ok).toBe(true)
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
