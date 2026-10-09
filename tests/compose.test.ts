import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * ── defect (d): one composer, two callers ──────────────────────────────────
 *
 * `plan.ts` and `onDemand.ts` each had their own copy of "what do we say to this pair",
 * and the copies drifted in three ways within a single session:
 *
 *   variant pool     onDemand queried `{ senderId, enabled }` with no `targetKind`, so a
 *                    MEDIA-BUYING body was reachable for a publisher and a
 *                    publisher-partnership body for a brand. Nothing reports that; the
 *                    message is simply addressed to the wrong kind of reader.
 *   campaign floor   onDemand used `hoursAgo(hookMaxAgeHours)` where the planner used
 *                    `newMaterialFloor()` — the LATER of that window and the 1 August
 *                    cutoff. Measured: the hook window reaches six and a half hours
 *                    further back, so on-demand offered campaigns the planner refuses.
 *   brand first touch  onDemand had none, so a brand's first message lost the placement
 *                    reference that is the entire point of `discoveredFromCampaignId`.
 *
 * These assert the properties, not the implementation, so re-inlining a copy that got
 * any of them wrong would fail here.
 */

const campaignFindFirst = vi.fn()
const campaignFindUnique = vi.fn()
const variantFindMany = vi.fn()
const attemptFindMany = vi.fn()
const campaignCount = vi.fn()
const campaignFindMany = vi.fn()

/**
 * `outreachAttempt.findMany` has TWO callers here — `usedCampaignIds` and `usedVariantIds`
 * — and they differ only by the column they select. One shared mock returning one shape
 * would make the variant query read `undefined` and silently pass every exclusion test, so
 * the mock discriminates on `select` exactly as the real query does.
 */
const usedCampaignRows = vi.fn<() => Array<{ campaignId: string | null }>>(() => [])
const usedVariantRows = vi.fn<() => Array<{ variantId: string }>>(() => [])

/**
 * `getSettings()` reads the Setting table. Returning no rows means every runtime setting takes
 * its default — and `generateMessages` defaults FALSE, so these tests describe compose with
 * Phase 8 OFF, which is the shipping configuration.
 */
const settingRows = vi.fn<() => Array<{ key: string; value: string }>>(() => [])

vi.mock('@/lib/db', () => ({
  prisma: {
    detectedCampaign: {
      findFirst: (...a: unknown[]) => campaignFindFirst(...a),
      findUnique: (...a: unknown[]) => campaignFindUnique(...a),
      count: (...a: unknown[]) => campaignCount(...a),
      /* The naming linkage reads rows now (campaignsNamingHandleRows), 2026-08-22. */
      findMany: (...a: unknown[]) => campaignFindMany(...a),
    },
    messageVariant: { findMany: (...a: unknown[]) => variantFindMany(...a) },
    outreachAttempt: { findMany: (...a: unknown[]) => attemptFindMany(...a) },
    setting: { findMany: () => Promise.resolve(settingRows()) },
  },
}))

const { composeForPair, unusedCampaignCount, NoVariantsError, VariantsExhaustedError, SINGLE_TEMPLATE_MIDDLE } =
  await import('@/outreach/compose')
const { newMaterialFloor } = await import('@/lib/cutoff')
import { templateForSettings, isStandardMessageBody } from '@/outreach/fleetTemplate'
import { followUpForSettings } from '@/outreach/followUpTemplate'

/**
 * The DEFAULT fleet's template, built by the REAL rule rather than written as a literal —
 * a hand-written verdict object goes stale GREEN the day the rule changes shape.
 */
const DEFAULT_FLEET_TEMPLATE = templateForSettings(
  { singleTemplateBody: null, fleetTemplateBodies: new Map() },
  [],
  [],
)

/** A written follow-up message, built by the REAL rule — see tests/follow-up-template.test.ts. */
const FOLLOW_UP_WRITTEN = followUpForSettings(
  { followUpBody: `Hi,Following up on {{post}} — we can put the same campaign in front of a much larger audience. Let's talk tomorrow.`, followUpBodies: new Map() },
  [],
  [],
)



/** A variant body long enough that `distinctiveSlice` can find a needle in the render. */
const variantBody = (n: number) => `Variant number ${n}: a long enough distinct body to be a usable needle.`
const poolOf = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `var_${i + 1}`, body: variantBody(i + 1) }))

const PERSONA = {
  personaName: 'Kapil Jain',
  personaRole: 'Co-founder',
  personaBrand: 'Bollywood Society',
  personaPhone: '+91 60000 189766',
  personaEmail: 'kapil@digitalsukoon.com',
}

function pair(overrides: Record<string, unknown> = {}) {
  return {
    id: 'pair_1',
    senderId: 'send_1',
    targetId: 'targ_1',
    bespokeBody: null,
    sender: PERSONA,
    target: {
      handle: 'madovermarketing_mom',
      displayName: 'Mad Over Marketing',
      contactFirstName: 'Mad Over Marketing',
      kind: 'CHANNEL',
      discoveredFromCampaignId: null,
    },
    ...overrides,
  } as Parameters<typeof composeForPair>[0]['pair']
}

beforeEach(() => {
  campaignFindFirst.mockReset().mockResolvedValue(null)
  campaignFindUnique.mockReset().mockResolvedValue(null)
  campaignCount.mockReset().mockResolvedValue(0)
  /* The naming-linkage reader. Reset like the rest, or calls[0] belongs to an earlier test
     — which is exactly how the first version of these assertions failed. */
  campaignFindMany.mockReset().mockReturnValue([])
  usedCampaignRows.mockReset().mockReturnValue([])
  usedVariantRows.mockReset().mockReturnValue([])
  attemptFindMany.mockReset().mockImplementation((args: { select?: Record<string, boolean> }) =>
    Promise.resolve(args?.select?.variantId ? usedVariantRows() : usedCampaignRows()),
  )
  variantFindMany.mockReset().mockResolvedValue(poolOf(3))
  /**
   * ── singleTemplate IS THE DEFAULT SINCE 2026-08-17, AND THESE TESTS TURN IT OFF ──
   *
   * Tabish asked for one standard message, so `singleTemplate` now defaults TRUE and
   * `composeForPair` returns that template before it reaches the bespoke body, the brand
   * first touch or the variant COPY. The paths below still exist and are still reachable by
   * one Setting row, so they are still tested — but they have to say which configuration
   * they describe rather than inheriting it from a default that has now moved twice.
   *
   * The default path has its own file: `tests/single-template.test.ts`.
   */
  settingRows.mockReset().mockReturnValue([{ key: 'singleTemplate', value: 'false' }])
})

describe('the standard template is what composing returns by default', () => {
  /**
   * Guards the guard. Every other test in this file turns the template OFF, so without this
   * one the whole file would describe a configuration production does not run — the
   * "a harness whose default disagrees with production measures a pipeline that does not
   * exist" mistake, one layer down.
   */
  it('returns the template VERBATIM, with no hook line and no bespoke body', async () => {
    settingRows.mockReturnValue([])
    const r = await composeForPair({ fleetTemplate: DEFAULT_FLEET_TEMPLATE, followUpTemplate: FOLLOW_UP_WRITTEN,
      pair: pair({ bespokeBody: 'A hand-written first touch that must NOT be used.' }),
      senderHandle: 'bollywoodsocietyy',
      touchNumber: 1,
      targetHasEverReplied: false,
    })
    /**
     * 2026-08-18, Tabish: the template IS the whole message. No greeting, no intro, no
     * signature — `renderMessage` is not called at all on this path, so the body is
     * byte-identical to the exported constant.
     */
    expect(r.body).toBe(SINGLE_TEMPLATE_MIDDLE)
    expect(r.body).not.toContain('hand-written first touch')
    expect(r.hookLine).toBeNull()
    expect(r.usedBespoke).toBe(false)
    // The variant is still CLAIMED, so the per-pair exclusion keeps advancing.
    expect(r.variantId).toBeTruthy()
  })

  /**
   * ── AN EXHAUSTED POOL DOES NOT REFUSE HERE (2026-09-10) ──────────────────────────
   *
   * Under the single template the variant is a ledger entry, never the body, so the pool has
   * nothing left to protect once every entry has been claimed for this pair. MEASURED before
   * this case existed: three pages had each delivered six times to @amazonmgmstudiosin, eight
   * paid posts still funded a message, and the planner threw for the elected page every pass —
   * a recipient with material that no page could write to, because the turn only passes on a
   * delivery. The claim now WRAPS to the least-recently-used entry (the pool's own order); the
   * variants path keeps refusing, and its test below runs with the flag OFF for that reason.
   */
  it('wraps the claim instead of refusing when every variant has been used on this pair', async () => {
    settingRows.mockReturnValue([])
    variantFindMany.mockResolvedValue(poolOf(2))
    usedVariantRows.mockReturnValue([{ variantId: 'var_1' }, { variantId: 'var_2' }])
    const r = await composeForPair({
      fleetTemplate: DEFAULT_FLEET_TEMPLATE,
      followUpTemplate: FOLLOW_UP_WRITTEN,
      pair: pair(),
      senderHandle: 'bollywoodsocietyy',
      touchNumber: 1,
      targetHasEverReplied: false,
    })
    expect(r.body).toBe(SINGLE_TEMPLATE_MIDDLE)
    // The pool is ordered least-recently-used first, so the wrap lands on its head.
    expect(r.variantId).toBe('var_1')
  })

  /**
   * ── THE WRITER AND THE PROBE SHARE BYTES (H5, 2026-10-09) ─────────────────────
   *
   * The gate and the planner's sweep recognise our INTRODUCTION by its stored bytes
   * (`isStandardMessageBody`). That only works while the composer writes the fleet's copy
   * verbatim — a composer that prepended or appended anything would make every stale
   * introduction invisible to both, silently. Driven with the shipped copy and with an
   * override, because the probe must recognise both.
   */
  it('a first touch is recognised as our introduction by the same predicate the gate asks', async () => {
    settingRows.mockReturnValue([])
    const shipped = { singleTemplateBody: null, fleetTemplateBodies: new Map<string, string>() }
    const r = await composeForPair({
      fleetTemplate: templateForSettings(shipped, [], []),
      followUpTemplate: FOLLOW_UP_WRITTEN,
      pair: pair(),
      senderHandle: 'bollywoodsocietyy',
      touchNumber: 1,
      targetHasEverReplied: false,
    })
    expect(isStandardMessageBody(r.body, shipped)).toBe(true)

    const override = {
      singleTemplateBody: '  Hi,An override of the standard message, long enough to be a sendable template.  ',
      fleetTemplateBodies: new Map<string, string>(),
    }
    const o = await composeForPair({
      fleetTemplate: templateForSettings(override, [], []),
      followUpTemplate: FOLLOW_UP_WRITTEN,
      pair: pair(),
      senderHandle: 'bollywoodsocietyy',
      touchNumber: 1,
      targetHasEverReplied: false,
    })
    expect(isStandardMessageBody(o.body, override)).toBe(true)
  })
})

describe('the variant pool is scoped to the target kind', () => {
  it('asks only for CHANNEL variants when the target is a channel', async () => {
    await composeForPair({ fleetTemplate: DEFAULT_FLEET_TEMPLATE, followUpTemplate: FOLLOW_UP_WRITTEN, pair: pair(), senderHandle: 'bollywoodsocietyy', touchNumber: 2, targetHasEverReplied: false })
    const where = (variantFindMany.mock.calls[0]![0] as { where: Record<string, unknown> }).where
    expect(where.targetKind).toBe('CHANNEL')
    expect(where.senderId).toBe('send_1')
    expect(where.enabled).toBe(true)
  })

  it('asks only for BRAND variants when the target is a brand', async () => {
    await composeForPair({ fleetTemplate: DEFAULT_FLEET_TEMPLATE, followUpTemplate: FOLLOW_UP_WRITTEN,
      pair: pair({ target: { ...pair().target, kind: 'BRAND', displayName: 'Royal Canin India' } }),
      senderHandle: 'bollywoodsocietyy',
      touchNumber: 2,
      targetHasEverReplied: false,
    })
    const where = (variantFindMany.mock.calls[0]![0] as { where: Record<string, unknown> }).where
    expect(where.targetKind).toBe('BRAND')
  })

  it('refuses rather than reaching into the other pool when its own is empty', async () => {
    variantFindMany.mockResolvedValue([])
    await expect(
      composeForPair({ fleetTemplate: DEFAULT_FLEET_TEMPLATE, followUpTemplate: FOLLOW_UP_WRITTEN, pair: pair(), senderHandle: 'tabishmukaddam1', touchNumber: 1, targetHasEverReplied: false }),
    ).rejects.toBeInstanceOf(NoVariantsError)
  })
})

/**
 * ── a variant is never sent to the same recipient twice ────────────────────
 *
 * The LRU is scoped to the SENDER, so it said nothing about which bodies a given RECIPIENT
 * had already read. MEASURED against the live database 2026-08-05: 8 of 11 pairs had
 * already been handed the same variant more than once, one of them five times. A sender's
 * pool of 12 is shared across its 7-9 pairs, so the ring wraps and comes back round.
 *
 * Two separate things were wrong and each is asserted here:
 *
 *   decision 3   "follow-ups use a fresh variant plus a campaign not referenced before" was
 *                enforced for the campaign half only. Meta penalises REPETITION, so the
 *                unenforced half is the one that matters.
 *   the guard     two messages from one variant share a `distinctiveSlice`, and the post-send
 *                thread confirmation was satisfied by ANY occurrence — including the earlier
 *                bubble. Fixed independently in `bodyAppearedSince`; asserted in
 *                tests/matching.test.ts. Both halves ship together on purpose.
 */
describe('a variant is never reused on the same pair', () => {
  it('skips the LRU-first variant when this pair has already been sent it', async () => {
    usedVariantRows.mockReturnValue([{ variantId: 'var_1' }])
    const out = await composeForPair({ fleetTemplate: DEFAULT_FLEET_TEMPLATE, followUpTemplate: FOLLOW_UP_WRITTEN, pair: pair(), senderHandle: 'x', touchNumber: 2, targetHasEverReplied: false })
    expect(out.variantId).toBe('var_2')
    expect(out.body).toContain('Variant number 2')
    expect(out.body).not.toContain('Variant number 1')
  })

  /** The permitting direction: with nothing used, the LRU order is honoured unchanged. */
  it('still takes the LRU-first variant when this pair has been sent none of them', async () => {
    usedVariantRows.mockReturnValue([])
    const out = await composeForPair({ fleetTemplate: DEFAULT_FLEET_TEMPLATE, followUpTemplate: FOLLOW_UP_WRITTEN, pair: pair(), senderHandle: 'x', touchNumber: 2, targetHasEverReplied: false })
    expect(out.variantId).toBe('var_1')
  })

  it('walks past every used variant, not just the first', async () => {
    usedVariantRows.mockReturnValue([{ variantId: 'var_1' }, { variantId: 'var_2' }])
    const out = await composeForPair({ fleetTemplate: DEFAULT_FLEET_TEMPLATE, followUpTemplate: FOLLOW_UP_WRITTEN, pair: pair(), senderHandle: 'x', touchNumber: 2, targetHasEverReplied: false })
    expect(out.variantId).toBe('var_3')
  })

  /**
   * The exact live shape: the same variant handed to one pair five times. Asserted as
   * five DISTINCT variants over five composes rather than by re-deriving the ordering,
   * so the assertion cannot agree with a wrong implementation by copying its arithmetic.
   */
  it('gives five consecutive follow-ups five different bodies', async () => {
    variantFindMany.mockResolvedValue(poolOf(6))
    const used: Array<{ variantId: string }> = []
    usedVariantRows.mockImplementation(() => used)

    const ids: string[] = []
    for (let touch = 2; touch <= 6; touch++) {
      const out = await composeForPair({ fleetTemplate: DEFAULT_FLEET_TEMPLATE, followUpTemplate: FOLLOW_UP_WRITTEN, pair: pair(), senderHandle: 'x', touchNumber: touch, targetHasEverReplied: false })
      ids.push(out.variantId)
      used.push({ variantId: out.variantId })
    }
    expect(new Set(ids).size).toBe(5)
    expect(ids).toEqual(['var_1', 'var_2', 'var_3', 'var_4', 'var_5'])
  })

  /** Exhaustion REFUSES; it never wraps around to a body this recipient has read. */
  it('refuses once the pair has used every variant in the pool', async () => {
    variantFindMany.mockResolvedValue(poolOf(2))
    usedVariantRows.mockReturnValue([{ variantId: 'var_1' }, { variantId: 'var_2' }])
    await expect(
      composeForPair({ fleetTemplate: DEFAULT_FLEET_TEMPLATE, followUpTemplate: FOLLOW_UP_WRITTEN, pair: pair(), senderHandle: 'bollywoodsocietyy', touchNumber: 3, targetHasEverReplied: false }),
    ).rejects.toBeInstanceOf(VariantsExhaustedError)
  })

  /**
   * Exhaustion and an empty pool are DIFFERENT errors with opposite fixes — one means the
   * seed never ran, the other means this conversation has said everything it can.
   */
  it('does not report exhaustion as a missing pool', async () => {
    variantFindMany.mockResolvedValue(poolOf(1))
    usedVariantRows.mockReturnValue([{ variantId: 'var_1' }])
    await expect(
      composeForPair({ fleetTemplate: DEFAULT_FLEET_TEMPLATE, followUpTemplate: FOLLOW_UP_WRITTEN, pair: pair(), senderHandle: 'x', touchNumber: 2, targetHasEverReplied: false }),
    ).rejects.not.toBeInstanceOf(NoVariantsError)
  })

  /**
   * "Used" must mean the recipient may have SEEN it. A discarded or failed draft carried
   * nothing, so its variant stays available — otherwise regenerating a draft burns the
   * pool, which is the bug already recorded for campaigns.
   */
  it('counts only in-flight attempts as having used a variant', async () => {
    await composeForPair({ fleetTemplate: DEFAULT_FLEET_TEMPLATE, followUpTemplate: FOLLOW_UP_WRITTEN, pair: pair(), senderHandle: 'x', touchNumber: 2, targetHasEverReplied: false })
    const variantCall = attemptFindMany.mock.calls.find(
      (c) => (c[0] as { select?: Record<string, boolean> })?.select?.variantId,
    )
    const where = (variantCall![0] as { where: { status: { in: string[] } } }).where
    expect(where.status.in).toContain('SENT')
    expect(where.status.in).toContain('REPLIED')
    expect(where.status.in).toContain('READY')
    expect(where.status.in).not.toContain('SKIPPED')
    expect(where.status.in).not.toContain('FAILED')
  })

  /** Scoped to the PAIR. Another pair's history must not shrink this pair's pool. */
  it('asks about this pair only', async () => {
    await composeForPair({ fleetTemplate: DEFAULT_FLEET_TEMPLATE, followUpTemplate: FOLLOW_UP_WRITTEN, pair: pair(), senderHandle: 'x', touchNumber: 2, targetHasEverReplied: false })
    const variantCall = attemptFindMany.mock.calls.find(
      (c) => (c[0] as { select?: Record<string, boolean> })?.select?.variantId,
    )
    const where = (variantCall![0] as { where: { pairId: string } }).where
    expect(where.pairId).toBe('pair_1')
  })

  /**
   * A FIRST touch uses the bespoke body, so the variant it reserves is not what the
   * recipient reads. It must still be excluded next time: `variantId` is recorded on the
   * attempt either way, and treating it as unused would hand out a body whose needle is
   * already spoken for.
   */
  it('still reserves a variant on a bespoke first touch', async () => {
    const out = await composeForPair({ fleetTemplate: DEFAULT_FLEET_TEMPLATE, followUpTemplate: FOLLOW_UP_WRITTEN,
      pair: pair({ bespokeBody: 'A hand-written first message for this specific publisher.' }),
      senderHandle: 'x',
      touchNumber: 1,
      targetHasEverReplied: false,
    })
    expect(out.usedBespoke).toBe(true)
    expect(out.variantId).toBe('var_1')
  })
})

describe('the campaign floor is newMaterialFloor, not the hook window alone', () => {
  const NOW = new Date('2026-08-04T12:00:00Z')

  /**
   * ── THESE NOW ASSERT THE NAMING LINKAGE, NOT `targetId` (2026-08-22) ──────
   *
   * Both queries used to be `{ targetId: <the recipient>, … }`, and `DetectedCampaign.targetId`
   * is the CHANNEL THAT POSTED — so both returned nothing for every prospect and
   * `NO_NEW_MATERIAL` refused every follow-up to every prospect permanently. MEASURED:
   * @amazonmgmstudios, 17 paid posts naming it, 5 messages, capped forever.
   *
   * The pair of them now asks `campaignsNamingHandleRows`, so what these tests pin is the
   * property that survived the change: ONE floor, ONE definition of "used", and the count
   * and the lookup agreeing — which is the drift this describe block was written for.
   */
  const namingRow = (id: string, postedAt: string, handle = 'acme') => ({
    id,
    postedAt: new Date(postedAt),
    /* The caption must NAME the recipient, or the shared linkage correctly drops the row —
       which is how the first version of these fixtures failed: they named @acme while the
       pair's target was @madovermarketing_mom. The filter working is the point. */
    caption: `a promo naming @${handle}`,
    taggedAccounts: '[]',
    brands: '[]',
  })

  it('uses newMaterialFloor for the hook lookup', async () => {
    campaignFindMany.mockReturnValue([namingRow('camp_a', '2026-08-20T00:00:00Z', 'madovermarketing_mom')])
    await composeForPair({ fleetTemplate: DEFAULT_FLEET_TEMPLATE, followUpTemplate: FOLLOW_UP_WRITTEN, pair: pair(), senderHandle: 'x', touchNumber: 2, targetHasEverReplied: false, now: NOW })
    const where = (campaignFindMany.mock.calls[0]![0] as { where: { postedAt: { gte: Date } } }).where
    expect(where.postedAt.gte.getTime()).toBe(newMaterialFloor(NOW).getTime())
  })

  it('uses the SAME floor for the count that gates it', async () => {
    campaignFindMany.mockReturnValue([namingRow('camp_a', '2026-08-20T00:00:00Z')])
    await unusedCampaignCount({ target: { handle: 'acme', displayName: 'Acme' }, targetId: 'targ_acme', pairId: 'pair_1', now: NOW })
    const where = (campaignFindMany.mock.calls[0]![0] as { where: { postedAt: { gte: Date } } }).where
    expect(where.postedAt.gte.getTime()).toBe(newMaterialFloor(NOW).getTime())
  })

  /**
   * The two answer halves of one question — "is there new material?" and "which piece of
   * it?" — and this codebase has been bitten twice by them drifting. Asserted against each
   * other rather than against a literal, so neither can move alone.
   */
  it('the count and the lookup agree on the floor and on what counts as used', async () => {
    usedCampaignRows.mockReturnValue([{ campaignId: 'camp_used' }])
    campaignFindMany.mockReturnValue([
      namingRow('camp_used', '2026-08-21T00:00:00Z', 'madovermarketing_mom'),
      namingRow('camp_free', '2026-08-20T00:00:00Z', 'madovermarketing_mom'),
    ])

    await composeForPair({ fleetTemplate: DEFAULT_FLEET_TEMPLATE, followUpTemplate: FOLLOW_UP_WRITTEN, pair: pair(), senderHandle: 'x', touchNumber: 2, targetHasEverReplied: false, now: NOW })
    const lookupWhere = (campaignFindMany.mock.calls[0]![0] as { where: Record<string, unknown> }).where
    /* The USED campaign is excluded in JS, so the hook must be the free one — this is the
       assertion that would have caught the old shape returning nothing at all. */
    /* The `include` arrived on 2026-09-01: the follow-up body names the post by the page
       that published it, and `DetectedCampaign.targetId` is that page. Asserted on the id
       rather than the whole argument object, so a later select change is not a false
       failure — what this test is about is WHICH campaign, not how it is fetched. */
    expect(
      (campaignFindUnique.mock.calls[0]![0] as { where: { id: string } }).where.id,
      'the used campaign was not excluded, so the hook is the wrong post',
    ).toBe('camp_free')

    campaignFindMany.mockClear()
    const n = await unusedCampaignCount({ target: { handle: 'madovermarketing_mom', displayName: 'Mad Over Marketing' }, targetId: 'targ_madovermarketing_mom', pairId: 'pair_1', now: NOW })
    const countWhere = (campaignFindMany.mock.calls[0]![0] as { where: Record<string, unknown> }).where
    expect(countWhere.postedAt).toEqual(lookupWhere.postedAt)
    expect(countWhere.verdict).toEqual(lookupWhere.verdict)
    expect(n, 'one of the two naming campaigns is already used').toBe(1)
  })

  /** "Used" means the recipient may have seen it — a discarded draft referenced nothing. */
  it('counts only in-flight attempts as having used a campaign', async () => {
    await unusedCampaignCount({ target: { handle: 'acme', displayName: 'Acme' }, targetId: 'targ_acme', pairId: 'pair_1', now: NOW })
    const where = (attemptFindMany.mock.calls[0]![0] as { where: { status: { in: string[] } } }).where
    expect(where.status.in).toContain('SENT')
    expect(where.status.in).toContain('READY')
    expect(where.status.in).not.toContain('SKIPPED')
    expect(where.status.in).not.toContain('FAILED')
  })

  /**
   * THE REGRESSION ITSELF, in the direction that failed. A recipient with naming campaigns
   * must report material; the old `targetId` shape reported zero for every prospect, which
   * is what capped every pair at one message ever.
   */
  it('a prospect NAMED by a paid post has new material — the whole defect', async () => {
    usedCampaignRows.mockReturnValue([])
    campaignFindMany.mockReturnValue([
      namingRow('c1', '2026-08-21T00:00:00Z'),
      namingRow('c2', '2026-08-20T00:00:00Z'),
      namingRow('c3', '2026-08-19T00:00:00Z'),
    ])
    const n = await unusedCampaignCount({ target: { handle: 'acme', displayName: 'Acme' }, targetId: 'targ_acme', pairId: 'pair_1', now: NOW })
    expect(n).toBe(3)
  })

  it('and a recipient no paid post names still reports none, so the guard still guards', async () => {
    usedCampaignRows.mockReturnValue([])
    campaignFindMany.mockReturnValue([])
    const n = await unusedCampaignCount({ target: { handle: 'nobody', displayName: 'Nobody' }, targetId: 'targ_nobody', pairId: 'pair_1', now: NOW })
    expect(n).toBe(0)
  })
})

describe('the brand first touch names the real placement', () => {
  const brandPair = pair({
    bespokeBody: null,
    target: {
      handle: 'royalcanin.india',
      displayName: 'Royal Canin India',
      contactFirstName: null,
      kind: 'BRAND',
      discoveredFromCampaignId: 'camp_disc',
    },
  })

  it('uses it on touch 1 and names the publisher', async () => {
    campaignFindUnique.mockResolvedValue({
      postedAt: new Date('2026-08-01T00:00:00Z'),
      target: { handle: 'madovermarketing_mom' },
    })
    const out = await composeForPair({ fleetTemplate: DEFAULT_FLEET_TEMPLATE, followUpTemplate: FOLLOW_UP_WRITTEN, pair: brandPair, senderHandle: 'x', touchNumber: 1, targetHasEverReplied: false })
    expect(out.usedBespoke).toBe(true)
    expect(out.body).toContain('Mad Over Marketing')
    expect(out.body).toContain('Royal Canin India')
    // Addressed as a team, never as a person — we do not know who runs the account.
    expect(out.body).toContain('Hi Royal Canin India team,')
  })

  /** The other direction: a FOLLOW-UP must not reuse the first-touch body. */
  it('does NOT use it on touch 2', async () => {
    const out = await composeForPair({ fleetTemplate: DEFAULT_FLEET_TEMPLATE, followUpTemplate: FOLLOW_UP_WRITTEN, pair: brandPair, senderHandle: 'x', touchNumber: 2, targetHasEverReplied: false })
    expect(out.usedBespoke).toBe(false)
    expect(out.body).toContain('Variant number 1')
  })

  /** Degrades honestly: no known publisher means no invented placement. */
  it('invents nothing when the campaign is unknown', async () => {
    const out = await composeForPair({ fleetTemplate: DEFAULT_FLEET_TEMPLATE, followUpTemplate: FOLLOW_UP_WRITTEN,
      pair: pair({
        target: { ...brandPair.target, discoveredFromCampaignId: null },
      }),
      senderHandle: 'x',
      touchNumber: 1,
      targetHasEverReplied: false,
    })
    expect(out.body).not.toContain('placement with')
    expect(out.body).toContain('entertainment publishers')
  })
})

describe('bespoke is the FIRST touch only', () => {
  const withBespoke = pair({ bespokeBody: 'A hand-written first message for this specific publisher.' })

  it('uses the bespoke body on touch 1, with no hook line stapled on top', async () => {
    campaignFindFirst.mockResolvedValue({ id: 'c1', brands: '["RoyalCanin"]', postedAt: new Date(), verdict: 'CAMPAIGN' })
    const out = await composeForPair({ fleetTemplate: DEFAULT_FLEET_TEMPLATE, followUpTemplate: FOLLOW_UP_WRITTEN, pair: withBespoke, senderHandle: 'x', touchNumber: 1, targetHasEverReplied: false })
    expect(out.usedBespoke).toBe(true)
    expect(out.body).toContain('A hand-written first message')
    expect(out.hookLine).toBeNull()
  })

  it('uses a variant plus a fresh campaign on touch 2', async () => {
    /* The hook is found through the shared naming linkage now: findMany selects the rows
       that NAME this recipient, then findUnique loads the freshest. */
    campaignFindMany.mockReturnValue([
      { id: 'c1', postedAt: new Date(), caption: 'a promo naming @madovermarketing_mom', taggedAccounts: '[]', brands: '["RoyalCanin"]' },
    ])
    campaignFindUnique.mockResolvedValue({ id: 'c1', brands: '["RoyalCanin"]', postedAt: new Date(), verdict: 'CAMPAIGN' })
    const out = await composeForPair({ fleetTemplate: DEFAULT_FLEET_TEMPLATE, followUpTemplate: FOLLOW_UP_WRITTEN, pair: withBespoke, senderHandle: 'x', touchNumber: 2, targetHasEverReplied: false })
    expect(out.usedBespoke).toBe(false)
    expect(out.body).not.toContain('A hand-written first message')
    expect(out.campaignId).toBe('c1')
    expect(out.hookLine).toContain('Royal Canin')
  })
})
