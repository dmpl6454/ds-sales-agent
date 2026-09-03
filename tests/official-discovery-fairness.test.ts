import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * A CANDIDATE THAT ANSWERED AND WAS NOT THE BRAND MUST NOT BE LOOKED UP AGAIN NEXT PASS.
 *
 * ── THE FOURTH LIVELOCK, MEASURED FROM THE LIVE AGENT LOG ─────────────────
 *
 * `lookupCooldown.ts` records the signature so a fourth occurrence is recognised in seconds:
 * *identical summary numbers on consecutive passes of a bounded queue.* Official-page
 * discovery was showing it, one branch over from the fix meant to end it. MEASURED
 * 2026-08-24 over 61 passes since 23 Aug: **855 lookups spent, 3 prospects created**, with
 * `coolingOff=60 looked=15 created=0 needsHuman=15` byte-identical across four consecutive
 * passes and the needsHuman line itself byte-identical across eight —
 * `"prime video" → @prime_video | @primevideoindia | @primevideo.official`, all three
 * unverified, re-resolved every thirty minutes.
 *
 * The cooldown covered the wrong half: `unreachable` remembers a candidate that DID NOT
 * ANSWER, while one that answers and fails `isOfficialMatch` was cleared, `known` is
 * per-pass, and this pass never persists a candidate to `BrandLookup`. The name queue is
 * sorted by how many paid posts assert each name, so the most-named brand sat at the front
 * permanently and the 1,025 names behind it were never reached.
 *
 * ── WHY prisma IS STUBBED HERE AND IS A REAL FILE IN THE BADGE-DOOR TEST ───
 *
 * `tests/badge-door-fairness.test.ts` needs a real SQLite file because ITS queue is
 * assembled by three Prisma queries, so a stub would let the test agree with itself about
 * the filter under test. This queue is assembled in memory by `harvestBrandNames` and the
 * fairness decision is the in-process memory inside the loop, so the database is only a
 * source of posts. Stubbing it is honest for this property and keeps the two-pass drive
 * cheap. `enrichHandle` is mocked because it makes a real HTTP call to Instagram — the
 * defect this file guards was found in a log, and the suite once phoned Instagram for a
 * whole month because that mock was missing in the sibling test.
 */

const enrich = vi.fn()

/** Every candidate answers, is real, and is NOT the brand — the rejection path exactly. */
const ANSWERS_BUT_WRONG = { reachable: true as const, fullName: 'Somebody Else', isVerified: false, followers: 12, status: 200 }

const POSTS = [
  {
    id: 'c1',
    shortcode: 'AAA',
    caption: 'watch it now',
    taggedAccounts: '[]',
    rawPayload: null,
    // Named on more posts than the others would be; whatever the order, the SAME name must
    // not consume the budget twice.
    brands: JSON.stringify(['Prime Video']),
    frameText: null,
    postedAt: new Date('2026-09-01T10:00:00Z'),
    target: { handle: 'naughtyworld' },
  },
  {
    id: 'c2',
    shortcode: 'BBB',
    caption: 'new drop',
    taggedAccounts: '[]',
    rawPayload: null,
    brands: JSON.stringify(['Kit Kat']),
    frameText: null,
    postedAt: new Date('2026-09-01T09:00:00Z'),
    target: { handle: 'naughtyworld' },
  },
]

vi.mock('@/lib/db', () => ({
  prisma: {
    detectedCampaign: { findMany: vi.fn(async () => POSTS) },
    targetAccount: { findMany: vi.fn(async () => []) },
    senderAccount: { findMany: vi.fn(async () => []) },
    brandLookup: { findMany: vi.fn(async () => []) },
  },
}))
vi.mock('@/detection/enrichHandle', () => ({ enrichHandle: (h: string) => enrich(h) }))
vi.mock('@/detection/brandCandidates', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  excludedHandles: vi.fn(async () => new Set<string>()),
}))
/** Nothing here should ever reach creation, and a mock makes that assertable. */
const create = vi.fn(async () => 'created' as const)
vi.mock('@/outreach/brandTarget', () => ({ createBrandTarget: (...a: unknown[]) => create(...(a as [])) }))
/** The pass sleeps 6s between lookups for politeness; the test must not. */
vi.mock('@/detection/officialDiscovery', async (orig) => orig())

const { discoverOfficialPages, resetOfficialDiscoveryMemory } = await import('@/detection/officialDiscovery')

describe('official-page discovery does not re-resolve a rejected candidate', () => {
  beforeEach(() => {
    resetOfficialDiscoveryMemory()
    enrich.mockReset()
    enrich.mockResolvedValue(ANSWERS_BUT_WRONG)
    create.mockClear()
    vi.useFakeTimers()
  })

  it('spends its budget on NEW candidates on the second pass, not the same rejected ones', async () => {
    const first = discoverOfficialPages({ maxLookups: 2, dryRun: true })
    await vi.runAllTimersAsync()
    const a = await first

    const askedFirst = enrich.mock.calls.map((c) => c[0])
    expect(a.looked).toBe(2)
    expect(a.created).toBe(0)
    expect(a.needsHuman).toHaveLength(2)
    expect(create).not.toHaveBeenCalled()

    enrich.mockClear()
    const second = discoverOfficialPages({ maxLookups: 2, dryRun: true })
    await vi.runAllTimersAsync()
    const b = await second

    const askedSecond = enrich.mock.calls.map((c) => c[0])

    // THE PROPERTY: nothing rejected on pass one is asked again on pass two.
    const repeated = askedSecond.filter((h) => askedFirst.includes(h))
    expect(repeated, `pass two re-resolved ${JSON.stringify(repeated)} — this is the livelock`).toEqual([])

    // And the skipped ones are REPORTED rather than silently dropped: a bounded pass that
    // hides what it held back reads as "covered everything" when it did not.
    expect(b.coolingOff).toBeGreaterThanOrEqual(askedFirst.length)
  })

  it('reports the rejections it made, so a person can still see and accept one', async () => {
    const p = discoverOfficialPages({ maxLookups: 1, dryRun: true })
    await vi.runAllTimersAsync()
    const r = await p
    expect(r.needsHuman).toHaveLength(1)
    expect(r.needsHuman[0]).toMatch(/verified=false/)
  })

  it('forgets on a reset, because the memory is in-process and a restart costs one pass', async () => {
    const p1 = discoverOfficialPages({ maxLookups: 1, dryRun: true })
    await vi.runAllTimersAsync()
    await p1
    const askedBefore = enrich.mock.calls.map((c) => c[0])

    resetOfficialDiscoveryMemory()
    enrich.mockClear()
    const p2 = discoverOfficialPages({ maxLookups: 1, dryRun: true })
    await vi.runAllTimersAsync()
    await p2

    // Deliberately the SAME candidate: a rejection is a verdict about the profile as it reads
    // today, so forgetting it is the safe direction — a page that gets verified tomorrow must
    // be reachable again. Persisting it would make `known` refuse that handle forever.
    expect(enrich.mock.calls.map((c) => c[0])).toEqual(askedBefore)
  })
})
