import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * ── THE STANDARD MESSAGE IS THE WHOLE MESSAGE (2026-08-18, Tabish) ─────────
 *
 * *"we need only a single template message to be sent, no signature name whatsoever …
 * and no there must be no space after hi, it is all continuous."*
 *
 * `composeForPair` with `singleTemplate` ON returns the template VERBATIM: no greeting,
 * no intro, no signature block, no hook line — `renderMessage` is never called on this
 * path. Two properties of that are mechanical rather than editorial, and both fail in the
 * quiet direction:
 *
 *  1. **The template must keep a line of at least 40 characters.** A single-line body
 *     takes `proseLines`' single-line branch — nothing is dropped by position — and
 *     `distinctiveSlice` needs a survivor of `MIN_NEEDLE_CHARS` or it returns null, and
 *     null refuses every send in the system. The hazard is shortening the copy, which is
 *     exactly the direction "make it shorter" pushes. Asserted against the REAL exported
 *     constant, not a fixture, because a fixture is what drifts from the copy somebody
 *     actually edits.
 *
 *  2. **Every message is now byte-identical**, which puts weight on guards that were
 *     written when bodies differed. `bodyAppearedSince` is an occurrence DELTA and
 *     survives that; `assessRead` did not, and is fixed in `tests/readThread.test.ts`.
 */

const campaignFindFirst = vi.fn()
const campaignFindUnique = vi.fn()
const variantFindMany = vi.fn()
const attemptFindMany = vi.fn()
const settingRows = vi.fn<() => Array<{ key: string; value: string }>>(() => [])

vi.mock('@/lib/db', () => ({
  prisma: {
    detectedCampaign: {
      findFirst: (...a: unknown[]) => campaignFindFirst(...a),
      findUnique: (...a: unknown[]) => campaignFindUnique(...a),
      count: () => Promise.resolve(0),
    },
    messageVariant: { findMany: (...a: unknown[]) => variantFindMany(...a) },
    outreachAttempt: { findMany: (...a: unknown[]) => attemptFindMany(...a) },
    setting: { findMany: () => Promise.resolve(settingRows()) },
  },
}))

const { composeForPair, SINGLE_TEMPLATE_MIDDLE } = await import('@/outreach/compose')
const { distinctiveSlice, proseLines, bodyAppearedSince, MIN_NEEDLE_CHARS } = await import('@/outreach/matching')

const PERSONA = {
  personaName: 'Kapil Jain',
  personaRole: 'Co-founder',
  personaBrand: 'Bollywood Chronicle',
  personaPhone: '+91 60000 189766',
  personaEmail: 'kapil@digitalsukoon.com',
}

function pairFor(args: { senderId?: string; persona?: typeof PERSONA; handle?: string; displayName?: string; kind?: string } = {}) {
  const { senderId = 'send_1', persona = PERSONA, handle = 'crocsindia', displayName = 'Crocs India', kind = 'BRAND' } = args
  return {
    id: `pair_${senderId}_${handle}`,
    senderId,
    targetId: `targ_${handle}`,
    bespokeBody: null,
    sender: persona,
    target: { handle, displayName, contactFirstName: null, kind, discoveredFromCampaignId: null },
  } as Parameters<typeof composeForPair>[0]['pair']
}

const compose = (p: ReturnType<typeof pairFor>, senderHandle = 'bollywoodchronicle') =>
  composeForPair({ pair: p, senderHandle, touchNumber: 1 })

beforeEach(() => {
  campaignFindFirst.mockReset().mockResolvedValue(null)
  campaignFindUnique.mockReset().mockResolvedValue(null)
  attemptFindMany.mockReset().mockResolvedValue([])
  variantFindMany.mockReset().mockResolvedValue([{ id: 'var_1', body: 'unused when the template is on' }])
  // No Setting rows: every runtime setting takes its default, and singleTemplate
  // defaults TRUE — this file describes the shipping configuration.
  settingRows.mockReset().mockReturnValue([])
})

describe('the standard message is sent verbatim', () => {
  it('composes to EXACTLY the template bytes — nothing prepended, nothing appended', async () => {
    const out = await compose(pairFor())
    expect(out.body).toBe(SINGLE_TEMPLATE_MIDDLE)
    expect(out.hookLine).toBeNull()
    expect(out.usedBespoke).toBe(false)
    // The variant is still CLAIMED — the per-pair exclusion keeps advancing.
    expect(out.variantId).toBeTruthy()
  })

  /** "No custom message" now means NOTHING varies — not even the recipient's name. */
  it('is byte-identical across recipients', async () => {
    const a = await compose(pairFor({ handle: 'crocsindia', displayName: 'Crocs India' }))
    const b = await compose(pairFor({ handle: 'amazondotin', displayName: 'Amazon India' }))
    const c = await compose(pairFor({ handle: 'agoracitycentre', displayName: 'agoracitycentre', kind: 'CHANNEL' }))
    expect(a.body).toBe(b.body)
    expect(b.body).toBe(c.body)
    expect(a.body).toBe(SINGLE_TEMPLATE_MIDDLE)
  })

  it('is byte-identical across senders — no page name, no signature, no persona at all', async () => {
    const otherPersona = { ...PERSONA, personaName: 'Someone Else', personaBrand: 'Mad About Marketing' }
    const a = await compose(pairFor({ senderId: 'send_1', persona: PERSONA }), 'bollywoodchronicle')
    const b = await compose(pairFor({ senderId: 'send_2', persona: otherPersona }), 'madaboutmarketingg')
    expect(a.body).toBe(b.body)
  })

  /**
   * The exact bytes Tabish supplied, pinned: "Hi," with NO space after the comma
   * ("it is all continuous"), the U+2019 apostrophes, one single line.
   */
  it('keeps the template\'s own first characters — "Hi," with no space after the comma', () => {
    expect(SINGLE_TEMPLATE_MIDDLE.startsWith('Hi,We’re')).toBe(true)
    expect(SINGLE_TEMPLATE_MIDDLE).toContain('Let’s connect')
    expect(SINGLE_TEMPLATE_MIDDLE).not.toContain('\n')
  })
})

describe('the mechanical floor that keeps sending alive', () => {
  /**
   * A single line has no envelope structure to strip, so `proseLines` keeps it whole —
   * nothing is dropped by position. That branch is what makes a one-line template
   * sendable at all.
   */
  it('the single-line branch of proseLines keeps the whole line', () => {
    expect(proseLines(SINGLE_TEMPLATE_MIDDLE)).toEqual([SINGLE_TEMPLATE_MIDDLE])
  })

  it('yields a needle the send guards can search for', () => {
    const needle = distinctiveSlice(SINGLE_TEMPLATE_MIDDLE)
    expect(needle, 'no needle — every send in the system would be refused').not.toBeNull()
    expect(needle!.length).toBeGreaterThanOrEqual(MIN_NEEDLE_CHARS)
    expect(SINGLE_TEMPLATE_MIDDLE).toContain(needle!)
  })

  /** ...and the composed body carries that same needle, being the same bytes. */
  it('the composed body yields the same needle', async () => {
    const out = await compose(pairFor())
    expect(distinctiveSlice(out.body)).toBe(distinctiveSlice(SINGLE_TEMPLATE_MIDDLE))
  })

  /**
   * The post-send confirmation, with two BYTE-IDENTICAL messages in one thread — the exact
   * situation the standard template creates on a second touch, and the one people assume
   * breaks it. It does not: the guard compares occurrence COUNTS across the read before and
   * the read after, and a count going 1→2 is a delta a thread cannot fake.
   */
  it('confirms a second identical message by delta, in both directions', () => {
    const body = SINGLE_TEMPLATE_MIDDLE
    const threadBefore = body
    const threadAfter = `${body}\n${body}`
    expect(bodyAppearedSince(threadBefore, threadAfter, body), 'the message DID appear').toBe(true)
    expect(bodyAppearedSince(threadBefore, threadBefore, body), 'the message did NOT appear').toBe(false)
  })
})
