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
  it('allows a first touch under the cap', () => {
    expect(checkNewBrandTouchCap({ newBrandTouchesToday: 0, maxNewBrandTouchesPerDay: 2, isFirstTouch: true }).ok).toBe(
      true,
    )
    expect(checkNewBrandTouchCap({ newBrandTouchesToday: 1, maxNewBrandTouchesPerDay: 2, isFirstTouch: true }).ok).toBe(
      true,
    )
  })

  it('REFUSES at the cap, and names the cap in the reason', () => {
    const r = checkNewBrandTouchCap({ newBrandTouchesToday: 2, maxNewBrandTouchesPerDay: 2, isFirstTouch: true })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason).toBe(BRAND_BLOCKS.NEW_BRAND_DAILY_CAP)
      // "nothing happened" with no explanation is the failure this project keeps hitting.
      expect(r.detail).toContain('2')
      expect(r.detail).toContain('tomorrow')
    }
  })

  it('refuses when already over the cap, not just exactly at it', () => {
    expect(checkNewBrandTouchCap({ newBrandTouchesToday: 9, maxNewBrandTouchesPerDay: 2, isFirstTouch: true }).ok).toBe(
      false,
    )
  })

  it('does NOT cap follow-ups — they are a continuing conversation', () => {
    /**
     * A follow-up is already spaced by cooldownDays and bounded by maxUnansweredTouches.
     * Counting it here would make a legitimate second message compete with a new prospect
     * for the same daily slot, and quietly starve one of them.
     */
    expect(
      checkNewBrandTouchCap({ newBrandTouchesToday: 99, maxNewBrandTouchesPerDay: 2, isFirstTouch: false }).ok,
    ).toBe(true)
  })

  it('a cap of 0 stops all new brands but still permits follow-ups', () => {
    // Pausing discovery-driven outreach must not also halt live conversations.
    expect(checkNewBrandTouchCap({ newBrandTouchesToday: 0, maxNewBrandTouchesPerDay: 0, isFirstTouch: true }).ok).toBe(
      false,
    )
    expect(checkNewBrandTouchCap({ newBrandTouchesToday: 0, maxNewBrandTouchesPerDay: 0, isFirstTouch: false }).ok).toBe(
      true,
    )
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

  it('compares only what RENDERS — a name nobody sees cannot make two accounts distinct', () => {
    /**
     * Since 2026-08-07 the signature is the channel name + contacts; `personaName` never
     * reaches a recipient. Two accounts differing ONLY by that hidden field produce
     * byte-identical signatures, so they must CLASH — this exact case passed as
     * "distinct" under the old five-field fingerprint, which would have let two pages
     * sign off identically while the gate reported them distinct.
     */
    const hiddenFieldOnly = { ...KAPIL, personaName: 'Different Person' }
    expect(checkPersonaDistinct({ persona: hiddenFieldOnly, otherPersonas: [KAPIL], targetKind: 'BRAND' }).ok).toBe(false)

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
