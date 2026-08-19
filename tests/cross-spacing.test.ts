/**
 * The ring spacing rule (2026-08-19, Tabish): a recipient may hear from every one of our
 * pages; the 7-day rest applies only once ALL of them have written — plus a short
 * inter-page gap so the ring cannot walk through one inbox in an afternoon.
 *
 * The rule this replaces (any other page in 7 days → hold) halted the entire fleet the
 * day after the 1-minute pace shipped: MEASURED 33/33 waiting drafts held, first clear
 * five days out, while 76 recipients had heard from exactly ONE page.
 */
import { describe, expect, it } from 'vitest'
import { crossSpacingVerdict, crossSpacingDetail } from '@/outreach/crossSpacing'

const now = new Date('2026-08-19T12:00:00Z')
const daysAgo = (d: number) => new Date(now.getTime() - d * 24 * 3600 * 1000)
const hoursAgo = (h: number) => new Date(now.getTime() - h * 3600 * 1000)
const base = { now, windowDays: 7, crossPageGapHours: 24, thisSenderId: 's1' }
const delivery = (sentAt: Date, handle = 'other') => ({ sentAt, handle })

describe('crossSpacingVerdict', () => {
  it('clear when nobody has written to the recipient', () => {
    expect(
      crossSpacingVerdict({ ...base, eligibleSenderIds: ['s1', 's2'], lastDeliveryBySender: new Map() }),
    ).toEqual({ held: false })
  })

  it('clear when ONE other page wrote outside the inter-page gap — the rule Tabish reversed', () => {
    const v = crossSpacingVerdict({
      ...base,
      eligibleSenderIds: ['s1', 's2', 's3'],
      lastDeliveryBySender: new Map([['s2', delivery(hoursAgo(30))]]),
    })
    expect(v.held).toBe(false)
  })

  it('held (inter-page-gap) when a DIFFERENT page wrote within crossPageGapHours', () => {
    const v = crossSpacingVerdict({
      ...base,
      eligibleSenderIds: ['s1', 's2'],
      lastDeliveryBySender: new Map([['s2', delivery(hoursAgo(3), 'bollywoodchronicle')]]),
    })
    expect(v).toMatchObject({ held: true, kind: 'inter-page-gap', otherHandle: 'bollywoodchronicle' })
  })

  it("own delivery within the gap does NOT hold — self-repetition is the pair rules' job", () => {
    const v = crossSpacingVerdict({
      ...base,
      eligibleSenderIds: ['s1', 's2'],
      lastDeliveryBySender: new Map([['s1', delivery(hoursAgo(3))]]),
    })
    expect(v.held).toBe(false)
  })

  it('held (ring-complete) when EVERY eligible sender delivered within the window', () => {
    const v = crossSpacingVerdict({
      ...base,
      eligibleSenderIds: ['s1', 's2', 's3'],
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
      eligibleSenderIds: ['s1', 's2', 's3'],
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
      eligibleSenderIds: ['s1', 's2', 's3'],
      lastDeliveryBySender: new Map([
        ['s1', delivery(daysAgo(1))],
        ['s2', delivery(daysAgo(2))],
      ]),
    })
    expect(v.held).toBe(false)
  })

  it('empty eligible set never holds (a vacuous "all" must not fire)', () => {
    const v = crossSpacingVerdict({ ...base, eligibleSenderIds: [], lastDeliveryBySender: new Map() })
    expect(v.held).toBe(false)
  })

  it('crossPageGapHours: 0 disables the inter-page gap entirely', () => {
    const v = crossSpacingVerdict({
      ...base,
      crossPageGapHours: 0,
      eligibleSenderIds: ['s1', 's2'],
      lastDeliveryBySender: new Map([['s2', delivery(hoursAgo(0.02))]]),
    })
    expect(v.held).toBe(false)
  })

  it('the inter-page gap reads the NEWEST other-page delivery, not an older one', () => {
    const v = crossSpacingVerdict({
      ...base,
      eligibleSenderIds: ['s1', 's2', 's3'],
      lastDeliveryBySender: new Map([
        ['s2', delivery(hoursAgo(40), 'older')],
        ['s3', delivery(hoursAgo(2), 'newer')],
      ]),
    })
    expect(v).toMatchObject({ held: true, kind: 'inter-page-gap', otherHandle: 'newer' })
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
