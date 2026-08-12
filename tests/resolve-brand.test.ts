import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * `decideBrand` is mocked so these tests exercise the INTEGRATION rule set — which
 * verdicts the model is even allowed to touch — without a network call or an API key.
 * `interpretDecision`, the pure decision→verdict half, is covered in
 * `tests/decide-brand.test.ts`; what is tested here is the ORDERING around it.
 */
vi.mock('@/detection/decideBrand', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/detection/decideBrand')>()
  return { ...real, decideBrand: vi.fn() }
})
/** Stubbed too: it is a live anonymous fetch, and these tests must make no request. */
vi.mock('@/detection/enrichHandle', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/detection/enrichHandle')>()
  return { ...real, enrichHandle: vi.fn() }
})
/**
 * The cooldown tests below exercise the REAL `resolveBrand`, which reads and writes the
 * `BrandLookup` cache. `.env`'s `DATABASE_URL` points at the LIVE server Postgres through an
 * SSH tunnel, so the client is stubbed rather than pointed anywhere: these tests must not
 * read production rows and must certainly not write them.
 */
vi.mock('@/lib/db', () => ({
  prisma: {
    brandLookup: {
      findUnique: vi.fn(async () => null),
      upsert: vi.fn(async () => ({})),
    },
  },
}))

import { prisma } from '@/lib/db'
import { decideBrand } from '@/detection/decideBrand'
import { enrichHandle } from '@/detection/enrichHandle'
import {
  applyModelToUnresolved,
  classifyProfile,
  interpretLookupFailure,
  mentionsIn,
  modelHasRun,
  RATE_LIMIT_COOLDOWN_MS,
  rateLimitCooldownActive,
  resetBrandResolverLimit,
  resolveBrand,
  setBrandResolverClock,
  type BrandVerdict,
} from '@/detection/resolveBrand'

/**
 * Brand resolution, tested in both directions.
 *
 * This logic previously lived inside an `await fetch()` and so had no tests at all — which
 * is exactly why two wrong verdicts reached the live database on 2026-08-03:
 * `@bharat_reshma` ("Fashion Designer", 938k followers) was created as a BRAND prospect,
 * and `@mind_shifters` ("Advertising/Marketing") was created as a prospect despite
 * `tests/detectors.test.ts` already asserting that same handle must be dropped as "the
 * agency" in the hook-line path. The rule existed in one half of the system only.
 *
 * Values below are REAL payload shapes observed against Instagram's profile endpoint.
 */

const base = { isBusinessAccount: false, isProfessionalAccount: false, fullName: null, followers: null }

describe('classifyProfile — who is actually a buyer', () => {
  it('a business account with a commercial category is a BRAND', () => {
    // @royalcanin.india, measured.
    const v = classifyProfile({
      ...base,
      handle: 'royalcanin.india',
      category: 'Grocery & Convenience Stores',
      isBusinessAccount: true,
      fullName: 'Royal Canin India',
      followers: 53157,
    })
    expect(v.kind).toBe('BRAND')
    if (v.kind === 'BRAND') {
      expect(v.displayName).toBe('Royal Canin India')
      expect(v.followers).toBe(53157)
    }
  })

  it('@amazondotin is a BRAND', () => {
    const v = classifyProfile({
      ...base,
      handle: 'amazondotin',
      category: 'Personal Goods & General Merchandise Stores',
      isBusinessAccount: true,
      followers: 9285773,
    })
    expect(v.kind).toBe('BRAND')
  })

  it('a person-role category is PERSON even with 21M followers and a pro account', () => {
    // @elvish_yadav — the case that proves is_business_account alone is not enough.
    const v = classifyProfile({
      ...base,
      handle: 'elvish_yadav',
      category: 'Artist',
      isProfessionalAccount: true,
      followers: 21_000_000,
    })
    expect(v.kind).toBe('PERSON')
  })

  it('REJECTS a creative profession as a brand — the @bharat_reshma miss', () => {
    // Filed BRAND in production because the list covered "Artist" but not "Fashion
    // Designer". A media-buying pitch to a designer is a wasted message: they appeared
    // in the placement, they did not buy it.
    const v = classifyProfile({
      ...base,
      handle: 'bharat_reshma',
      category: 'Fashion Designer',
      isBusinessAccount: true,
      followers: 938788,
    })
    expect(v.kind).toBe('PERSON')
  })

  it('REJECTS an advertising agency — the @mind_shifters miss', () => {
    // Digital Sukoon sells placement, so an agency is the other side of the table.
    const v = classifyProfile({
      ...base,
      handle: 'mind_shifters',
      category: 'Advertising/Marketing',
      isBusinessAccount: true,
      followers: 12475,
    })
    expect(v.kind).toBe('PERSON')
  })

  it('checks category BEFORE account type, or both misses come back', () => {
    // Both of the above are is_business_account: true. A business-first check files them
    // as buyers, so the ORDER is the fix, not the list.
    for (const category of ['Fashion Designer', 'Advertising/Marketing', 'Photographer', 'Public Relations']) {
      expect(
        classifyProfile({ ...base, handle: 'x', category, isBusinessAccount: true, isProfessionalAccount: true })
          .kind,
      ).toBe('PERSON')
    }
  })

  it('is case-insensitive about categories', () => {
    expect(classifyProfile({ ...base, handle: 'x', category: 'ARTIST', isBusinessAccount: true }).kind).toBe(
      'PERSON',
    )
    expect(classifyProfile({ ...base, handle: 'x', category: 'fashion designer' }).kind).toBe('PERSON')
  })

  it('no category and not a business is UNRESOLVED — never PERSON', () => {
    /**
     * The single most important assertion in this file. @farhadsamji, @iamzahero,
     * @jas_manchester and @thisisdsp were all filed PERSON on `category: null` alone,
     * which permanently discards any brand that left the field blank, with nothing on
     * screen to say so. Absence of data must never harden into a negative verdict.
     */
    const v = classifyProfile({ ...base, handle: 'farhadsamji', category: null })
    expect(v.kind).toBe('UNRESOLVED')
    expect(v.kind).not.toBe('PERSON')
  })

  it('falls back to the handle when full_name is empty', () => {
    const v = classifyProfile({ ...base, handle: 'somebrand', category: 'Retail', isBusinessAccount: true, fullName: '   ' })
    expect(v.kind === 'BRAND' && v.displayName).toBe('somebrand')
  })

  it('a professional account with a category is a BRAND even if not is_business_account', () => {
    // @kalkifashion, measured: business=false, category "Clothing (Brand)".
    const v = classifyProfile({
      ...base,
      handle: 'kalkifashion',
      category: 'Clothing (Brand)',
      isProfessionalAccount: true,
      followers: 1582847,
    })
    expect(v.kind).toBe('BRAND')
  })
})

describe('interpretLookupFailure — a failure is not automatically a throttle', () => {
  const SCHEMA_BUG =
    '{"message":"Asset asset://laser.provider/ig_business_category_subvertical has been deleted. You cannot use this schema","status":"fail"}'

  it('Instagram’s deleted-schema 400 is UNRESOLVED and does NOT halt the run', () => {
    /**
     * The bug this whole function exists for. Measured 2026-08-03: a control handle
     * returned 200 between every one of eight lookups, so nothing was throttling — yet
     * one of these 400s set `rateLimited` and halted the whole run. Three consecutive
     * brand-discovery runs made ZERO progress and reported "rate-limited" each time.
     */
    const out = interpretLookupFailure({ handle: 'netflix_in', status: 400, body: SCHEMA_BUG })
    expect(out.haltRun).toBe(false)
    expect(out.verdict.kind).toBe('UNRESOLVED')
  })

  it('and it is UNRESOLVED rather than UNKNOWN, so it does not retry forever', () => {
    // Meta's bug is permanent until they fix it. UNKNOWN means "we never looked" and gets
    // retried on every run, so the queue would never drain.
    const out = interpretLookupFailure({ handle: 'tseries.official', status: 400, body: SCHEMA_BUG })
    expect(out.verdict.kind).not.toBe('UNKNOWN')
  })

  it('a REAL throttle (429) still halts the run', () => {
    // The direction that must keep working: continuing to ask after being told to stop is
    // what turns rate limiting into an IP block.
    const out = interpretLookupFailure({ handle: 'x', status: 429, body: '' })
    expect(out.haltRun).toBe(true)
    expect(out.verdict.kind).toBe('UNKNOWN')
  })

  it('401 and 403 also halt', () => {
    expect(interpretLookupFailure({ handle: 'x', status: 401, body: '' }).haltRun).toBe(true)
    expect(interpretLookupFailure({ handle: 'x', status: 403, body: '' }).haltRun).toBe(true)
  })

  it('an unexplained failure retries that ONE handle without halting', () => {
    const out = interpretLookupFailure({ handle: 'x', status: 500, body: 'oops' })
    expect(out.haltRun).toBe(false)
    expect(out.verdict.kind).toBe('UNKNOWN')
  })

  it('never returns PERSON or BRAND from a failure', () => {
    // A failed lookup tells us nothing about what the account IS.
    for (const status of [400, 401, 403, 429, 500, 503]) {
      const k = interpretLookupFailure({ handle: 'x', status, body: '' }).verdict.kind
      expect(['UNKNOWN', 'UNRESOLVED']).toContain(k)
    }
  })
})

describe('the model decides only the endpoint blind spot', () => {
  /**
   * WHY THE ORDERING IS THE THING UNDER TEST. This decides whether a handle becomes a
   * PROSPECT, and a prospect can receive a cold DM from a revenue account. So:
   *
   *   the ENDPOINT wins whenever it answered   — the model fills a blind spot, not a gap
   *                                              in Instagram's own facts
   *   UNKNOWN passes through untouched         — "we never got to look" is RETRIED, and a
   *                                              guess would replace a retry with a
   *                                              permanent cached answer
   *   a failed call decides NOTHING            — the fifth time this codebase has had to
   *                                              assert that absence of data is not a
   *                                              negative verdict
   */
  const enrichment = {
    handle: 'x',
    reachable: true,
    accountType: 2,
    isVerified: true,
    followers: 1_000_000,
    fullName: 'Adidas',
    reason: null,
  }

  beforeEach(() => {
    vi.mocked(decideBrand).mockReset()
    vi.mocked(enrichHandle).mockReset()
    vi.mocked(enrichHandle).mockResolvedValue(enrichment)
  })

  it('an endpoint UNRESOLVED + confident company → BRAND, marked decidedBy model', async () => {
    // The founding case. Meta's deleted-schema bug makes @adidas unreadable, so the
    // endpoint cannot answer and the dashboard showed "could not read this account".
    vi.mocked(decideBrand).mockResolvedValue({ kind: 'company', confidence: 97, reason: 'sportswear brand' })
    const out = await applyModelToUnresolved(
      { kind: 'UNRESOLVED', handle: 'adidas', reason: 'no category and not a business account' },
      { caption: 'seen with @adidas at the launch' },
    )
    expect(out.verdict).toMatchObject({ kind: 'BRAND', handle: 'adidas' })
    expect(out.decidedBy).toBe('model')
  })

  it('a model failure changes NOTHING — absence never hardens into a verdict', async () => {
    vi.mocked(decideBrand).mockResolvedValue(null)
    const out = await applyModelToUnresolved(
      { kind: 'UNRESOLVED', handle: 'somelocalshop', reason: 'no category and not a business account' },
      {},
    )
    expect(out.verdict).toMatchObject({ kind: 'UNRESOLVED' })
    expect(out.decidedBy).toBeNull()
  })

  it('an endpoint BRAND is returned untouched — the endpoint wins when it answered', async () => {
    const v = {
      kind: 'BRAND' as const,
      handle: 'royalcanin.india',
      displayName: 'Royal Canin',
      category: 'Pet Store',
      followers: 1,
    }
    const out = await applyModelToUnresolved(v, {})
    expect(out.verdict).toBe(v)
    expect(vi.mocked(decideBrand)).not.toHaveBeenCalled()
  })

  it('UNKNOWN is NEVER guessed at — it is retried by the endpoint, not decided by a model', async () => {
    /**
     * The distinct safety rule, and the one an operator would never notice being broken:
     * both UNKNOWN and UNRESOLVED read as "we do not know" on screen. UNKNOWN means the
     * lookup NEVER HAPPENED — rate-limited or a network error — so `resolveBrand` retries
     * it on a later pass. Letting the model answer it would substitute a guess made with
     * NO profile facts at all for a lookup that is about to succeed, and cache the guess
     * permanently. Asked with a company answer waiting, so a pass-through is the only
     * thing that can produce this result.
     */
    vi.mocked(decideBrand).mockResolvedValue({ kind: 'company', confidence: 99, reason: 'would have said company' })
    const v: BrandVerdict = { kind: 'UNKNOWN', handle: 'adidas', reason: 'HTTP 429' }
    const out = await applyModelToUnresolved(v, { caption: 'seen with @adidas at the launch' })
    expect(out.verdict).toBe(v)
    expect(out.decidedBy).toBeNull()
    expect(vi.mocked(decideBrand)).not.toHaveBeenCalled()
    expect(vi.mocked(enrichHandle)).not.toHaveBeenCalled()
  })

  it('every verdict the endpoint produced passes through, with no call made', async () => {
    // PERSON and MISSING are answers too. Only the blind spot is the model's to fill.
    const answered: BrandVerdict[] = [
      { kind: 'PERSON', handle: 'elvish_yadav', category: 'Artist' },
      { kind: 'MISSING', handle: 'nope_nope_12345' },
      { kind: 'UNKNOWN', handle: 'x', reason: 'HTTP 500' },
    ]
    for (const v of answered) {
      const out = await applyModelToUnresolved(v, { caption: 'a caption' })
      expect(out.verdict).toBe(v)
      expect(out.decidedBy).toBeNull()
    }
    expect(vi.mocked(decideBrand)).not.toHaveBeenCalled()
  })

  it('sub-threshold confidence and `unsure` stay UNRESOLVED and are never marked DECIDED', async () => {
    /**
     * `interpretDecision` turns both into UNRESOLVED. What is asserted is that neither is
     * marked `'model'` — nothing downstream may read a guess as a settled answer, and the
     * dashboard's "what the model decided" panel filters on exactly that string.
     *
     * It IS marked `'model-declined'`, which is the distinction added when the cached
     * fall-through shipped: the model ran and answered, so it must not be asked the same
     * question about the same evidence on every pass forever. That is a claim about whether
     * to spend another call, never a claim about what the account is — the verdict below is
     * still UNRESOLVED and still never messaged.
     */
    for (const decision of [
      { kind: 'company' as const, confidence: 80, reason: 'probably' },
      { kind: 'unsure' as const, confidence: 99, reason: 'obscure handle' },
    ]) {
      vi.mocked(decideBrand).mockResolvedValue(decision)
      const out = await applyModelToUnresolved(
        { kind: 'UNRESOLVED', handle: 'somelocalshop', reason: 'no category and not a business account' },
        {},
      )
      expect(out.verdict.kind).toBe('UNRESOLVED')
      expect(out.decidedBy).not.toBe('model')
      expect(out.decidedBy).toBe('model-declined')
    }
  })

  it('a confident `person` becomes PERSON, decided by the model', async () => {
    // The direction that protects a real human: @adityathackeray is a politician tagged in
    // a film-promotion caption and is byte-identical to a brand on every readable field.
    vi.mocked(decideBrand).mockResolvedValue({ kind: 'person', confidence: 96, reason: 'Indian politician' })
    const out = await applyModelToUnresolved(
      { kind: 'UNRESOLVED', handle: 'adityathackeray', reason: 'HTTP 400: Instagram category-schema bug' },
      {},
    )
    expect(out.verdict.kind).toBe('PERSON')
    expect(out.decidedBy).toBe('model')
  })

  it('whenever it says the model decided, the decision is there to be recorded', async () => {
    /**
     * The invariant the cache write depends on: `decidedBy === 'model'` must imply a
     * non-null `decision`, because the confidence and reason are written to columns the
     * dashboard reads. Asserted rather than assumed with a `!`.
     */
    vi.mocked(decideBrand).mockResolvedValue({ kind: 'company', confidence: 95, reason: 'retailer' })
    const out = await applyModelToUnresolved(
      { kind: 'UNRESOLVED', handle: 'crocsindia', reason: 'HTTP 400: Instagram category-schema bug' },
      {},
    )
    expect(out.decidedBy).toBe('model')
    expect(out.decision).not.toBeNull()
    expect(out.decision?.confidence).toBe(95)
  })

  it('the caption is passed to the model — it is the evidence the endpoint never had', async () => {
    vi.mocked(decideBrand).mockResolvedValue(null)
    await applyModelToUnresolved(
      { kind: 'UNRESOLVED', handle: 'adidas', reason: 'no category and not a business account' },
      { caption: 'wearing @adidas on set' },
    )
    expect(vi.mocked(decideBrand).mock.calls[0]?.[0]).toMatchObject({
      handle: 'adidas',
      captionContext: 'wearing @adidas on set',
    })
  })

  it('facts are kept even when nothing was decided, so the row is not an opaque dead end', async () => {
    vi.mocked(decideBrand).mockResolvedValue(null)
    const out = await applyModelToUnresolved(
      { kind: 'UNRESOLVED', handle: 'x', reason: 'no category and not a business account' },
      {},
    )
    expect(out.enrichment).toMatchObject({ reachable: true })
  })
})

describe('the rate-limit back-off is TIME-BOUNDED, not permanent', () => {
  /**
   * ── THE BUG THIS BLOCK EXISTS FOR ─────────────────────────────────────────
   *
   * The halt was a module-level BOOLEAN with a reset function that had ZERO callers.
   * MEASURED on the live server 2026-08-11: one genuine 429 on @stevemaddenindia at 14:15
   * set it, and for the next two hours every 15-minute detection pass reported
   * `looked=1 created=0 haltedEarly=true` while the endpoint was demonstrably healthy (a
   * control probe returned HTTP 400 for @stevemaddenindia and @adidas — Meta's schema bug,
   * correctly UNRESOLVED — and HTTP 200 for @royalcanin.india). The brand-decision model had
   * never once run in production; all 30 UNRESOLVED rows still had `decidedBy = null`,
   * including @adidas, the handle the feature was built for.
   *
   * The short-circuit returned BEFORE any request, so each pass looked exactly like a fresh
   * throttle. Silent and self-perpetuating.
   *
   * `resumes after the cooldown expires` is the assertion that fails against a boolean. It is
   * the whole point of the file; the others fence in what must NOT change around it.
   *
   * The clock is INJECTED rather than slept through — a 30-minute test is not a test.
   */
  const fetchMock = vi.fn()
  const realFetch = globalThis.fetch
  let t = Date.parse('2026-08-11T14:15:00Z')

  /** A 429: a REAL throttle, the one case that must still stop us asking. */
  const throttled = () => ({ status: 429, ok: false, text: async () => '', json: async () => ({}) })
  /** Meta's deleted-schema 400: per-handle and permanent. Must NOT trigger the back-off. */
  const schemaBug = () => ({
    status: 400,
    ok: false,
    text: async () =>
      '{"message":"Asset asset://laser.provider/ig_business_category_subvertical has been deleted. You cannot use this schema","status":"fail"}',
    json: async () => ({}),
  })
  /** A healthy business profile — proof a lookup actually reached the endpoint. */
  const healthy = () => ({
    status: 200,
    ok: true,
    text: async () => '',
    json: async () => ({
      data: { user: { business_category_name: 'Retail', is_business_account: true, full_name: 'Fine Co' } },
    }),
  })

  beforeEach(() => {
    t = Date.parse('2026-08-11T14:15:00Z')
    setBrandResolverClock(() => t)
    resetBrandResolverLimit()
    fetchMock.mockReset()
    globalThis.fetch = fetchMock as unknown as typeof fetch
    // A null decision keeps the model out of it: what is under test is the back-off, not
    // what an UNRESOLVED handle gets decided as.
    vi.mocked(decideBrand).mockResolvedValue(null)
    vi.mocked(enrichHandle).mockResolvedValue({
      handle: 'x',
      reachable: true,
      accountType: 2,
      isVerified: false,
      followers: 1,
      fullName: null,
      reason: null,
    })
  })

  afterEach(() => {
    globalThis.fetch = realFetch
    setBrandResolverClock()
    resetBrandResolverLimit()
  })

  it('a real 429 sets the cooldown, and the very next lookup short-circuits', async () => {
    fetchMock.mockResolvedValueOnce(throttled())
    const first = await resolveBrand('stevemaddenindia')
    expect(first.kind).toBe('UNKNOWN')
    expect(fetchMock).toHaveBeenCalledTimes(1)

    // Immediately afterwards, with the clock unmoved: no request is made at all.
    const second = await resolveBrand('adidas')
    expect(second.kind).toBe('UNKNOWN')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('the short-circuit reason names WHEN it expires — "earlier this run" is what hid this', async () => {
    /**
     * The old wording was `rate-limited earlier this run`: true forever once set, and silent
     * about whether it would ever stop being true. That sentence is why two hours of doing
     * nothing went unnoticed. A reason carrying an expiry is one an operator can act on.
     */
    fetchMock.mockResolvedValueOnce(throttled())
    await resolveBrand('stevemaddenindia')
    const held = await resolveBrand('adidas')
    expect(held.kind === 'UNKNOWN' && held.reason).toMatch(/not asking again until 2026-08-11T14:45:00/)
    expect(held.kind === 'UNKNOWN' && held.reason).not.toMatch(/earlier this run/)
  })

  it('RESUMES once the cooldown expires — the assertion a boolean cannot pass', async () => {
    /**
     * THE REGRESSION TEST FOR THE PRODUCTION BUG. Against the old boolean the second lookup
     * short-circuits no matter how far the clock advances, so this fails — which is exactly
     * what makes it worth having.
     */
    fetchMock.mockResolvedValueOnce(throttled())
    await resolveBrand('stevemaddenindia')
    expect(fetchMock).toHaveBeenCalledTimes(1)

    t += RATE_LIMIT_COOLDOWN_MS + 1_000
    fetchMock.mockResolvedValueOnce(healthy())
    const after = await resolveBrand('royalcanin.india')

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(after.kind).toBe('BRAND')
  })

  it('still holds one second BEFORE expiry — the boundary, not just the happy side of it', async () => {
    fetchMock.mockResolvedValueOnce(throttled())
    await resolveBrand('stevemaddenindia')

    t += RATE_LIMIT_COOLDOWN_MS - 1_000
    const held = await resolveBrand('adidas')
    expect(held.kind).toBe('UNKNOWN')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('the deleted-schema 400 does NOT set the cooldown — it is per-handle', async () => {
    /**
     * The direction that emptied three consecutive brand-discovery runs in 2026-08-03 when a
     * per-item failure escalated to a run-wide stop. `interpretLookupFailure` returns
     * `haltRun: false` for it, and this asserts the back-off honours that: the very next
     * handle must still reach the endpoint. Otherwise the fix above re-creates the older bug
     * with a 30-minute timer on it.
     */
    fetchMock.mockResolvedValueOnce(schemaBug())
    const first = await resolveBrand('adidas')
    expect(first.kind).toBe('UNRESOLVED')

    fetchMock.mockResolvedValueOnce(healthy())
    const second = await resolveBrand('royalcanin.india')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(second.kind).toBe('BRAND')
  })

  it('an ordinary 500 does not set the cooldown either', async () => {
    fetchMock.mockResolvedValueOnce({ status: 500, ok: false, text: async () => 'oops', json: async () => ({}) })
    expect((await resolveBrand('x')).kind).toBe('UNKNOWN')

    fetchMock.mockResolvedValueOnce(healthy())
    expect((await resolveBrand('royalcanin.india')).kind).toBe('BRAND')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('resetBrandResolverLimit() clears an ACTIVE cooldown — the caller ig:brands now has', async () => {
    fetchMock.mockResolvedValueOnce(throttled())
    await resolveBrand('stevemaddenindia')
    expect((await resolveBrand('adidas')).kind).toBe('UNKNOWN')
    expect(fetchMock).toHaveBeenCalledTimes(1)

    // A person typed the command. The clock has NOT moved, so only the reset can explain a
    // request being made.
    resetBrandResolverLimit()
    fetchMock.mockResolvedValueOnce(healthy())
    expect((await resolveBrand('royalcanin.india')).kind).toBe('BRAND')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('401 and 403 back off too — the whole haltRun set, not just 429', async () => {
    for (const status of [401, 403]) {
      resetBrandResolverLimit()
      fetchMock.mockReset()
      fetchMock.mockResolvedValueOnce({ status, ok: false, text: async () => '', json: async () => ({}) })
      await resolveBrand('stevemaddenindia')
      expect((await resolveBrand('adidas')).kind).toBe('UNKNOWN')
      expect(fetchMock).toHaveBeenCalledTimes(1)
    }
  })

  it('the cooldown is a real back-off, not a token one', () => {
    // Two whole 15-minute detection passes are skipped. Asserted so shrinking it to
    // something cosmetic is a deliberate, visible act rather than a quiet edit.
    expect(RATE_LIMIT_COOLDOWN_MS).toBeGreaterThanOrEqual(15 * 60 * 1000)
    expect(RATE_LIMIT_COOLDOWN_MS).toBe(30 * 60 * 1000)
  })
})

describe('rateLimitCooldownActive — the comparison, in both directions', () => {
  const until = 1_000_000

  it('null is never active: not backing off is the ordinary state', () => {
    expect(rateLimitCooldownActive(null, until + 5)).toBe(false)
    expect(rateLimitCooldownActive(null, 0)).toBe(false)
  })

  it('active strictly before the expiry, and over the instant it lapses', () => {
    expect(rateLimitCooldownActive(until, until - 1)).toBe(true)
    // Inclusive at the boundary would hold a lookup for one extra millisecond; harmless, but
    // asserted so "expired" has exactly one meaning wherever it is read.
    expect(rateLimitCooldownActive(until, until)).toBe(false)
    expect(rateLimitCooldownActive(until, until + 1)).toBe(false)
  })
})

describe('a CACHED UNRESOLVED the model has never seen is offered to it', () => {
  /**
   * ── THE BUG THIS BLOCK EXISTS FOR ─────────────────────────────────────────
   *
   * `applyModelToUnresolved` sat AFTER the fetch, and the cache-hit path returned before
   * reaching it. So the model was only ever offered a handle whose endpoint lookup had just
   * run — and every handle in the existing backlog was cached days BEFORE the model existed.
   *
   * MEASURED on the live Postgres 2026-08-11: 30 `BrandLookup` rows with `kind = 'UNRESOLVED'`,
   * every one with `modelReason IS NULL` and `checkedAt` on 2026-08-06 — @adidas, @kfcindia,
   * @nutella, @lux, @titaneyeplus, @rungtasteel, @uspoloassnindia, @bonkerscorner among them.
   * The feature's founding case was in that list and was structurally unreachable: nothing in
   * normal operation could ever ask about it, because asking required a fresh lookup and a
   * fresh lookup never happened for a cached handle.
   *
   * ── AND WHY IT MUST NOT SIMPLY FALL THROUGH UNCONDITIONALLY ───────────────
   *
   * `autoResolve.ts` documented the opposite conclusion, and its reasoning was CORRECT about
   * the danger: re-asking the same model the same question about the same evidence every 15
   * minutes would burn the whole per-pass bound on handles that can never move, starving the
   * genuinely new mentions. `modelReason` alone cannot separate "declined" from "never asked",
   * because a FAILED call writes null too.
   *
   * So the fall-through is gated on `decidedBy`, which records that the model RAN
   * independently of whether it DECIDED. Both directions are asserted here.
   */
  const fetchMock = vi.fn()
  const realFetch = globalThis.fetch

  const cachedRow = (over: Record<string, unknown> = {}) => ({
    handle: 'adidas',
    kind: 'UNRESOLVED',
    category: null,
    displayName: null,
    followers: null,
    enrichment: null,
    reachable: null,
    decidedBy: null,
    modelConfidence: null,
    modelReason: null,
    ...over,
  })

  beforeEach(() => {
    setBrandResolverClock()
    resetBrandResolverLimit()
    fetchMock.mockReset()
    globalThis.fetch = fetchMock as unknown as typeof fetch
    vi.mocked(decideBrand).mockReset()
    vi.mocked(enrichHandle).mockReset()
    vi.mocked(enrichHandle).mockResolvedValue({
      handle: 'adidas',
      reachable: true,
      accountType: 2,
      isVerified: true,
      followers: 30_000_000,
      fullName: 'adidas',
      reason: null,
    })
    vi.mocked(prisma.brandLookup.findUnique).mockReset()
    vi.mocked(prisma.brandLookup.upsert).mockReset()
    vi.mocked(prisma.brandLookup.upsert).mockResolvedValue({} as never)
  })

  afterEach(() => {
    globalThis.fetch = realFetch
    resetBrandResolverLimit()
  })

  it('THE BUG: a cached UNRESOLVED with modelReason null becomes a BRAND, decided by the model', async () => {
    /**
     * The founding case, end to end through the real `resolveBrand`. @adidas is cached
     * UNRESOLVED from before the model existed; this is the assertion that fails against the
     * early return, because the model was never consulted at all.
     */
    vi.mocked(prisma.brandLookup.findUnique).mockResolvedValue(cachedRow() as never)
    vi.mocked(decideBrand).mockResolvedValue({ kind: 'company', confidence: 98, reason: 'global sportswear brand' })

    const out = await resolveBrand('adidas', { caption: 'wearing @adidas on set' })

    expect(out.kind).toBe('BRAND')
    expect(vi.mocked(decideBrand)).toHaveBeenCalledTimes(1)
    // The endpoint is NOT re-asked: we already know what it says, and it is the expensive half.
    expect(fetchMock).not.toHaveBeenCalled()

    const written = vi.mocked(prisma.brandLookup.upsert).mock.calls[0]?.[0] as unknown as {
      update: Record<string, unknown>
    }
    expect(written.update).toMatchObject({
      kind: 'BRAND',
      decidedBy: 'model',
      modelConfidence: 98,
      modelReason: 'global sportswear brand',
    })
  })

  it('the caption travels with it — the evidence the endpoint never had', async () => {
    vi.mocked(prisma.brandLookup.findUnique).mockResolvedValue(cachedRow() as never)
    vi.mocked(decideBrand).mockResolvedValue({ kind: 'company', confidence: 97, reason: 'sportswear' })

    await resolveBrand('adidas', { caption: 'wearing @adidas at the launch' })

    expect(vi.mocked(decideBrand).mock.calls[0]?.[0]).toMatchObject({
      handle: 'adidas',
      captionContext: 'wearing @adidas at the launch',
    })
  })

  it('a cached UNRESOLVED the model ALREADY DECLINED is NOT re-offered', async () => {
    /**
     * The anti-starvation direction, and the reason `autoResolve.ts` argued against this
     * change. Without it, every declined handle is re-asked on every pass forever.
     */
    vi.mocked(prisma.brandLookup.findUnique).mockResolvedValue(
      cachedRow({ decidedBy: 'model-declined', modelReason: 'not confident (unsure 99%)' }) as never,
    )

    const out = await resolveBrand('adidas', { caption: 'a caption' })

    expect(out.kind).toBe('UNRESOLVED')
    expect(vi.mocked(decideBrand)).not.toHaveBeenCalled()
    expect(vi.mocked(enrichHandle)).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
    // Nothing is rewritten: there is no new fact, so the row must not be touched.
    expect(vi.mocked(prisma.brandLookup.upsert)).not.toHaveBeenCalled()
  })

  it('a row the model DECIDED is not re-offered either', async () => {
    // `decidedBy: 'model'` on an UNRESOLVED row is the sub-floor case that stayed UNRESOLVED.
    vi.mocked(prisma.brandLookup.findUnique).mockResolvedValue(
      cachedRow({ decidedBy: 'model', modelReason: 'obscure local shop', modelConfidence: 40 }) as never,
    )

    expect((await resolveBrand('adidas')).kind).toBe('UNRESOLVED')
    expect(vi.mocked(decideBrand)).not.toHaveBeenCalled()
  })

  it('DECLINING is recorded, so one failed call cannot mean forever-retry OR forever-silence', async () => {
    /**
     * The write that makes the gate above truthful. A failed call and a declined call both
     * leave `modelReason` null, so `decidedBy` is what separates them from "never asked" —
     * and it must be written on the decline path or the next pass re-asks.
     */
    vi.mocked(prisma.brandLookup.findUnique).mockResolvedValue(cachedRow() as never)
    vi.mocked(decideBrand).mockResolvedValue({ kind: 'unsure', confidence: 99, reason: 'cannot tell' })

    const out = await resolveBrand('adidas', { caption: 'a caption' })

    expect(out.kind).toBe('UNRESOLVED')
    const written = vi.mocked(prisma.brandLookup.upsert).mock.calls[0]?.[0] as unknown as {
      update: Record<string, unknown>
    }
    expect(written.update).toMatchObject({ kind: 'UNRESOLVED', decidedBy: 'model-declined' })
    // NOT 'model': the dashboard's "what the model decided" panel filters on exactly that
    // string, and a declined handle rendering there with a null reason would be a lie.
    expect(written.update.decidedBy).not.toBe('model')
  })

  it('a FAILED call is not recorded as declined — it must stay retryable', async () => {
    /**
     * The distinction that keeps "absence of data never hardens into a verdict" true. A
     * network blip or a missing API key must not permanently silence a real prospect, so the
     * marker is written only when the model actually answered.
     */
    vi.mocked(prisma.brandLookup.findUnique).mockResolvedValue(cachedRow() as never)
    vi.mocked(decideBrand).mockResolvedValue(null)

    expect((await resolveBrand('adidas')).kind).toBe('UNRESOLVED')

    const written = vi.mocked(prisma.brandLookup.upsert).mock.calls[0]?.[0] as unknown as {
      update: Record<string, unknown>
    }
    expect(written.update.decidedBy).toBeNull()
  })

  it.each([
    ['BRAND', { kind: 'BRAND', displayName: 'Royal Canin', category: 'Pet Store', followers: 53157 }, 'BRAND'],
    ['PERSON', { kind: 'PERSON', category: 'Artist' }, 'PERSON'],
    ['MISSING', { kind: 'MISSING' }, 'MISSING'],
  ])('a cached %s is returned untouched, with no model call — the endpoint wins', async (_l, row, expected) => {
    /**
     * The regression this must not cause. Instagram's own category data is a FACT; the model's
     * world knowledge is a judgement, and a judgement does not overrule a fact.
     */
    vi.mocked(prisma.brandLookup.findUnique).mockResolvedValue(cachedRow(row) as never)

    expect((await resolveBrand('adidas')).kind).toBe(expected)
    expect(vi.mocked(decideBrand)).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(vi.mocked(prisma.brandLookup.upsert)).not.toHaveBeenCalled()
  })

  it('a cached UNRESOLVED still keeps the endpoint reason it was cached with when nothing decides', async () => {
    vi.mocked(prisma.brandLookup.findUnique).mockResolvedValue(cachedRow() as never)
    vi.mocked(decideBrand).mockResolvedValue(null)

    const out = await resolveBrand('adidas')
    expect(out.kind === 'UNRESOLVED' && out.reason).toMatch(/cached/)
  })

  it('the fall-through RESPECTS an active rate-limit cooldown', async () => {
    /**
     * The path must not sneak requests out during a back-off. `enrichHandle` is an anonymous
     * Instagram request, so a cached-UNRESOLVED fall-through firing during a cooldown would
     * be exactly the "continuing to ask after being told to stop" that earns an IP block —
     * arriving through a door the cooldown was not written to guard.
     */
    let t = Date.parse('2026-08-11T14:15:00Z')
    setBrandResolverClock(() => t)

    // A real 429 on a DIFFERENT, uncached handle arms the cooldown.
    vi.mocked(prisma.brandLookup.findUnique).mockResolvedValueOnce(null as never)
    fetchMock.mockResolvedValueOnce({ status: 429, ok: false, text: async () => '', json: async () => ({}) })
    await resolveBrand('stevemaddenindia')
    vi.mocked(decideBrand).mockReset()
    vi.mocked(enrichHandle).mockClear()

    // Now the cached UNRESOLVED arrives while we are backing off.
    vi.mocked(prisma.brandLookup.findUnique).mockResolvedValue(cachedRow() as never)
    vi.mocked(decideBrand).mockResolvedValue({ kind: 'company', confidence: 99, reason: 'would have said company' })

    const held = await resolveBrand('adidas', { caption: 'wearing @adidas' })

    expect(held.kind).toBe('UNRESOLVED')
    expect(vi.mocked(decideBrand)).not.toHaveBeenCalled()
    expect(vi.mocked(enrichHandle)).not.toHaveBeenCalled()

    // ...and it resumes once the cooldown lapses, or the guard is just the old permanent halt.
    t += RATE_LIMIT_COOLDOWN_MS + 1_000
    const after = await resolveBrand('adidas', { caption: 'wearing @adidas' })
    expect(after.kind).toBe('BRAND')
    expect(vi.mocked(decideBrand)).toHaveBeenCalledTimes(1)
  })
})

describe('modelHasRun — the gate, in both directions', () => {
  /**
   * PURE, so the rule that decides whether a scarce model call is made is testable without a
   * database. The asymmetry is the point: `null` means "never asked" and is the ONLY value
   * that permits a call.
   */
  it('a row the model has never seen permits a call', () => {
    expect(modelHasRun({ decidedBy: null })).toBe(false)
    // Historic rows from before the feature existed, and endpoint-settled ones.
    expect(modelHasRun({ decidedBy: 'endpoint' })).toBe(false)
    expect(modelHasRun({ decidedBy: 'human' })).toBe(false)
  })

  it('a row the model has already answered does NOT', () => {
    expect(modelHasRun({ decidedBy: 'model' })).toBe(true)
    expect(modelHasRun({ decidedBy: 'model-declined' })).toBe(true)
  })
})

describe('mentionsIn', () => {
  it('extracts and normalises handles from a caption', () => {
    expect(mentionsIn('shot with @RoyalCanin.India and @tilara_india!')).toEqual([
      'royalcanin.india',
      'tilara_india',
    ])
  })

  it('deduplicates', () => {
    expect(mentionsIn('@theleela @TheLeela @theleela')).toEqual(['theleela'])
  })

  it('drops Instagram furniture, which is never a prospect', () => {
    expect(mentionsIn('@instagram @explore @reels @realbrand')).toEqual(['realbrand'])
  })

  it('strips a trailing full stop from sentence-final mentions', () => {
    expect(mentionsIn('thanks @somebrand.')).toEqual(['somebrand'])
  })

  it('returns nothing for a caption with no mentions', () => {
    expect(mentionsIn('#Collaboration lovely shoot today')).toEqual([])
  })
})
