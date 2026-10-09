/**
 * The ring spacing rule (2026-08-19, Tabish): a recipient may hear from every one of our
 * pages; the 7-day rest applies only once ALL of them have written. The inter-page gap
 * is a KEPT MECHANISM shipping at ZERO since 2026-08-20 ("7 day constraint only no other
 * limitation") — the fixtures below still drive it with an explicit 24 so it stays
 * enforceable if it is ever wanted back, and the last block pins the shipped default.
 *
 * The rule this replaces (any other page in 7 days → hold) halted the entire fleet the
 * day after the 1-minute pace shipped: MEASURED 33/33 waiting drafts held, first clear
 * five days out, while 76 recipients had heard from exactly ONE page.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { crossSpacingVerdict, crossSpacingDetail } from '@/outreach/crossSpacing'

const now = new Date('2026-08-19T12:00:00Z')
const daysAgo = (d: number) => new Date(now.getTime() - d * 24 * 3600 * 1000)
const hoursAgo = (h: number) => new Date(now.getTime() - h * 3600 * 1000)
/**
 * No fleet memberships: every page and every recipient reads as the default fleet, so the
 * ring is exactly the eligible list these cases name — the meaning they had before the
 * ring was narrowed to the recipient's own fleet (M12). The two-fleet cases are below.
 */
const NO_FLEETS = { bySenderHandle: new Map<string, string[]>(), byTargetHandle: new Map<string, string[]>() }
const base = { now, windowDays: 7, crossPageGapHours: 24, thisSenderId: 's1', targetHandle: 't', memberships: NO_FLEETS }
const delivery = (sentAt: Date, handle = 'other') => ({ sentAt, handle })
/** Eligible pages whose handle IS their id — the memberships are keyed by handle. */
const pages = (ids: string[]) => ids.map((id) => ({ id, handle: id }))

describe('crossSpacingVerdict', () => {
  it('clear when nobody has written to the recipient', () => {
    expect(
      crossSpacingVerdict({ ...base, eligibleSenders: pages(['s1', 's2']), lastDeliveryBySender: new Map() }),
    ).toEqual({ held: false })
  })

  it('clear when ONE other page wrote outside the inter-page gap — the rule Tabish reversed', () => {
    const v = crossSpacingVerdict({
      ...base,
      eligibleSenders: pages(['s1', 's2', 's3']),
      lastDeliveryBySender: new Map([['s2', delivery(hoursAgo(30))]]),
    })
    expect(v.held).toBe(false)
  })

  it('held (inter-page-gap) when a DIFFERENT page wrote within crossPageGapHours', () => {
    const v = crossSpacingVerdict({
      ...base,
      eligibleSenders: pages(['s1', 's2']),
      lastDeliveryBySender: new Map([['s2', delivery(hoursAgo(3), 'bollywoodchronicle')]]),
    })
    expect(v).toMatchObject({ held: true, kind: 'inter-page-gap', otherHandle: 'bollywoodchronicle' })
  })

  it("own delivery within the gap does NOT hold — self-repetition is the pair rules' job", () => {
    const v = crossSpacingVerdict({
      ...base,
      eligibleSenders: pages(['s1', 's2']),
      lastDeliveryBySender: new Map([['s1', delivery(hoursAgo(3))]]),
    })
    expect(v.held).toBe(false)
  })

  it('held (ring-complete) when EVERY eligible sender delivered within the window', () => {
    const v = crossSpacingVerdict({
      ...base,
      eligibleSenders: pages(['s1', 's2', 's3']),
      lastDeliveryBySender: new Map([
        ['s1', delivery(daysAgo(6))],
        ['s2', delivery(daysAgo(4))],
        ['s3', delivery(daysAgo(2))],
      ]),
    })
    expect(v).toMatchObject({ held: true, kind: 'ring-complete', senderCount: 3 })
    if (v.held && v.kind === 'ring-complete') {
      // releases when the OLDEST in-window delivery ages out: 6 days ago + 7-day window
      expect(v.resumesAt.getTime()).toBe(daysAgo(6).getTime() + 7 * 24 * 3600 * 1000)
    }
  })

  it('NOT ring-complete when one eligible sender wrote before the window (aged out reopens the ring)', () => {
    const v = crossSpacingVerdict({
      ...base,
      eligibleSenders: pages(['s1', 's2', 's3']),
      lastDeliveryBySender: new Map([
        ['s1', delivery(daysAgo(2))],
        ['s2', delivery(daysAgo(8))],
        ['s3', delivery(daysAgo(3))],
      ]),
    })
    expect(v.held).toBe(false)
  })

  it('ring-complete counts a sender the recipient has NEVER heard from as missing', () => {
    const v = crossSpacingVerdict({
      ...base,
      eligibleSenders: pages(['s1', 's2', 's3']),
      lastDeliveryBySender: new Map([
        ['s1', delivery(daysAgo(1))],
        ['s2', delivery(daysAgo(2))],
      ]),
    })
    expect(v.held).toBe(false)
  })

  it('empty eligible set never holds (a vacuous "all" must not fire)', () => {
    const v = crossSpacingVerdict({ ...base, eligibleSenders: pages([]), lastDeliveryBySender: new Map() })
    expect(v.held).toBe(false)
  })

  it('crossPageGapHours: 0 disables the inter-page gap entirely', () => {
    const v = crossSpacingVerdict({
      ...base,
      crossPageGapHours: 0,
      eligibleSenders: pages(['s1', 's2']),
      lastDeliveryBySender: new Map([['s2', delivery(hoursAgo(0.02))]]),
    })
    expect(v.held).toBe(false)
  })

  it('the inter-page gap reads the NEWEST other-page delivery, not an older one', () => {
    const v = crossSpacingVerdict({
      ...base,
      eligibleSenders: pages(['s1', 's2', 's3']),
      lastDeliveryBySender: new Map([
        ['s2', delivery(hoursAgo(40), 'older')],
        ['s3', delivery(hoursAgo(2), 'newer')],
      ]),
    })
    expect(v).toMatchObject({ held: true, kind: 'inter-page-gap', otherHandle: 'newer' })
  })
})

/**
 * ── "ALL OUR PAGES" MEANS THE PAGES THAT CAN WRITE TO THIS RECIPIENT (M12) ──
 *
 * The live memberships (src/scripts/sender-fleets.ts, run 2026-09-04): the four bollywood
 * pages send for BOTH fleets, @madaboutmarketingg for marketing ONLY. A bollywood recipient
 * carries no membership row (the default fleet). The marketing page can never deliver to it
 * — routes.ts refuses the route, gate.ts refuses the send, rotation never elects it — so a
 * ring rule counting it as one of "all" could never fire for any bollywood recipient, which
 * is exactly what the code did until this fix.
 */
describe('crossSpacingVerdict — the ring is the recipient\'s own fleet', () => {
  const BOLLYWOOD_PAGES = ['chron', 'soc', 'pap', 'tf']
  const TWO_FLEETS = {
    bySenderHandle: new Map<string, string[]>([
      ...BOLLYWOOD_PAGES.map((h) => [h, ['bollywood', 'marketing']] as [string, string[]]),
      ['mad', ['marketing']],
    ]),
    byTargetHandle: new Map<string, string[]>([
      ['mkt-co', ['marketing']],
      ['both-co', ['bollywood', 'marketing']],
    ]),
  }
  const ALL_FIVE = pages([...BOLLYWOOD_PAGES, 'mad'])
  const fleetBase = { now, windowDays: 7, crossPageGapHours: 0, thisSenderId: 'chron', memberships: TWO_FLEETS, eligibleSenders: ALL_FIVE }
  const fourWrote = new Map([
    ['chron', delivery(daysAgo(6))],
    ['soc', delivery(daysAgo(4))],
    ['pap', delivery(daysAgo(2))],
    ['tf', delivery(daysAgo(1))],
  ])

  it('a bollywood recipient rests once the FOUR bollywood pages have written — the marketing page is not one of "all"', () => {
    const v = crossSpacingVerdict({ ...fleetBase, targetHandle: 'boll-co', lastDeliveryBySender: fourWrote })
    expect(v).toMatchObject({ held: true, kind: 'ring-complete', senderCount: 4 })
    if (v.held && v.kind === 'ring-complete') {
      // releases when the OLDEST of the four ages out — a time-based release, so no stall
      expect(v.resumesAt.getTime()).toBe(daysAgo(6).getTime() + 7 * 24 * 3600 * 1000)
    }
  })

  it('a bollywood recipient is NOT resting while one bollywood page has yet to write', () => {
    const three = new Map(fourWrote)
    three.delete('tf')
    expect(crossSpacingVerdict({ ...fleetBase, targetHandle: 'boll-co', lastDeliveryBySender: three }).held).toBe(false)
  })

  it('a marketing recipient still counts all five — the marketing page CAN write to it', () => {
    expect(crossSpacingVerdict({ ...fleetBase, targetHandle: 'mkt-co', lastDeliveryBySender: fourWrote }).held).toBe(false)
    const five = new Map(fourWrote).set('mad', delivery(daysAgo(3)))
    expect(crossSpacingVerdict({ ...fleetBase, targetHandle: 'mkt-co', lastDeliveryBySender: five })).toMatchObject({
      held: true,
      kind: 'ring-complete',
      senderCount: 5,
    })
  })

  it('a recipient BOTH fleets found counts all five, like a marketing one ("common elsewhere")', () => {
    expect(crossSpacingVerdict({ ...fleetBase, targetHandle: 'both-co', lastDeliveryBySender: fourWrote }).held).toBe(false)
    const five = new Map(fourWrote).set('mad', delivery(daysAgo(3)))
    expect(crossSpacingVerdict({ ...fleetBase, targetHandle: 'both-co', lastDeliveryBySender: five })).toMatchObject({
      held: true,
      senderCount: 5,
    })
  })

  it('a recipient no eligible page shares a fleet with never holds — an empty ring is a vacuous "all"', () => {
    const onlyMad = pages(['mad'])
    expect(
      crossSpacingVerdict({
        ...fleetBase,
        eligibleSenders: onlyMad,
        targetHandle: 'boll-co',
        lastDeliveryBySender: new Map([['mad', delivery(daysAgo(1))]]),
      }).held,
    ).toBe(false)
  })
})

/**
 * ── A RING OF ONE PAGE SELF-HOLDS — PINNED, PENDING TABISH'S CALL ───────────
 *
 * The literal reading of "contacted by all": with one page able to write, that page alone is
 * "all", so its own delivery starts the 7-day rest. Unreachable for the bollywood fleet while
 * the marketing page padded every set; reachable after M12 whenever three of the four
 * bollywood pages are signed out or proved dead (the 13 Aug state). Kept because it is the
 * conservative direction and what the code already did for a single-member fleet. If Tabish
 * decides a lone page should not rest, the change is a `ring.length > 1` guard and THIS
 * expectation flips — together with the crossSpacing.ts docblock that states the same answer.
 */
describe('crossSpacingVerdict — a one-page ring', () => {
  it('holds for the window once its only page has written (the n=1 case of "all")', () => {
    const v = crossSpacingVerdict({
      ...base,
      crossPageGapHours: 0,
      thisSenderId: 'pap',
      eligibleSenders: pages(['pap']),
      lastDeliveryBySender: new Map([['pap', delivery(hoursAgo(10), 'pap')]]),
    })
    expect(v).toMatchObject({ held: true, kind: 'ring-complete', senderCount: 1 })
  })

  it('a one-page fleet with the other fleet\'s page signed in still self-holds — the other page is not in its ring', () => {
    const v = crossSpacingVerdict({
      ...base,
      crossPageGapHours: 0,
      thisSenderId: 'pap',
      targetHandle: 'boll-co',
      memberships: {
        bySenderHandle: new Map([['mad', ['marketing']]]),
        byTargetHandle: new Map(),
      },
      eligibleSenders: pages(['pap', 'mad']),
      lastDeliveryBySender: new Map([['pap', delivery(hoursAgo(10), 'pap')]]),
    })
    expect(v).toMatchObject({ held: true, kind: 'ring-complete', senderCount: 1 })
  })
})

describe('crossSpacingDetail', () => {
  it('is null for a clear verdict and a sentence for each hold', () => {
    expect(crossSpacingDetail({ held: false })).toBeNull()
    const gap = crossSpacingDetail({
      held: true,
      kind: 'inter-page-gap',
      otherHandle: 'bollywoodchronicle',
      hoursAgo: 3.2,
      resumesAt: new Date('2026-08-20T09:00:00Z'),
    })
    expect(gap).toContain('@bollywoodchronicle')
    const ring = crossSpacingDetail({
      held: true,
      kind: 'ring-complete',
      senderCount: 5,
      resumesAt: new Date('2026-08-24T12:00:00Z'),
    })
    expect(ring).toContain('all 5')
  })
})

/**
 * THE SHIPPED DEFAULTS, pinned as source facts.
 *
 * Both numbers are Tabish's, both were given twice, and both are the kind of value a
 * later "safety improvement" restores without noticing whose call it was. A source read
 * rather than an import because `settings.ts` reaches `@/lib/db` at module scope — and a
 * grep that matches nothing must fail loudly, so each assertion names what it expects.
 */
describe('the shipped spacing defaults', () => {
  const src = readFileSync(join(process.cwd(), 'src/lib/settings.ts'), 'utf8')

  it('crossPageGapHours ships at 0 — no inter-page gap (Tabish, 2026-08-20, stated twice)', () => {
    expect(
      /crossPageGapHours:\s*0\b/.test(src),
      'the inter-page gap has been restored to a non-zero default. It was REMOVED on ' +
        'explicit instruction ("7 day constraint only no other limitation") after MEASURING ' +
        'it hold 23 of 23 drafts while the 7-day rule held nobody. Restoring it is Tabish\'s ' +
        'call to make, not a safety improvement to apply.',
    ).toBe(true)
  })

  it('the 7-day window still comes from defaultCooldownDays, not a literal', () => {
    expect(src).toContain('defaultCooldownDays: env.DEFAULT_COOLDOWN_DAYS')
  })
})
