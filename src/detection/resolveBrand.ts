import { prisma } from '@/lib/db'
import { log } from '@/lib/logger'
import type { BrandLookupKind } from '@/lib/constants'
import { decideBrand, interpretDecision, type BrandDecision } from './decideBrand'
import { enrichHandle, describeEnrichment, type HandleEnrichment } from './enrichHandle'

/**
 * Turning a paid post into MESSAGEABLE brand accounts.
 *
 * WHERE THE HANDLES ACTUALLY COME FROM
 *
 * Not from `DetectedCampaign.brands`. That column holds *display* names for message
 * copy — `extractBrands` deliberately converts `@royalcanin.india` into "RoyalCanin"
 * so a hook line reads well, which throws the handle away at exactly the step that
 * needs it. Measured 2026-08-03: across 14 CAMPAIGN posts the brands column held
 * **1 usable handle out of 19 tokens**, while the CAPTIONS of those same posts held
 * **26 real @mentions** — @royalcanin.india, @tilara.india, @netflix_in,
 * @tseries.official, @theleela. So resolution reads the caption, not the column.
 *
 * WHY EVERY MENTION IS NOT A PROSPECT
 *
 * A film-promotion caption tags its cast, its director and often a politician at the
 * launch. @adityathackeray is a politician; @elvish_yadav is an actor; @royalcanin.india
 * is a brand with a media budget. Messaging the first two is both useless and the kind
 * of scattergun contact that gets accounts reported.
 *
 * Instagram's own profile endpoint answers this anonymously:
 *   @royalcanin.india  is_business_account=true   category "Grocery & Convenience Stores"
 *   @elvish_yadav      is_business_account=false  category "Artist"
 *
 * THE ENDPOINT IS NOT RATE-LIMITED. IT IS PARTLY BROKEN, WHICH IS DIFFERENT
 *
 * An earlier measurement — "10 handles at 2.5s spacing, 7 returned HTTP 400" — was read
 * as aggressive rate limiting. **That reading was wrong, and it was re-measured on
 * 2026-08-03.** Interleaving a known-good control handle between eight lookups returned
 * HTTP 200 EVERY time, so nothing was throttling. The 400s are per-handle and permanent,
 * and the response body says so:
 *
 *   {"message":"Asset asset://laser.provider/ig_business_category_subvertical
 *     has been deleted. You cannot use this schema","status":"fail"}
 *
 * That is Instagram serialising a business-category sub-vertical whose schema Meta
 * deleted. It fails for accounts that HAVE such a category — so it breaks on precisely
 * the accounts most likely to be brands. @netflix_in, @tseries.official and
 * @tilara.india are unreachable; a 40-follower private account resolves fine.
 *
 * Consequences worth knowing:
 *
 *  - Real prospects are unreachable through no fault of ours, and they land UNRESOLVED
 *    (visible, awaiting a human) rather than being discarded.
 *  - The 6s spacing stays anyway. It was chosen for politeness against a scarce endpoint
 *    and the diagnosis changing does not make hammering it a good idea.
 *  - A failure is still never "not a brand". But it is also no longer allowed to halt
 *    the whole run — see `interpretLookupFailure`, which is the bug this cost us.
 */

/**
 * Roles that appear in campaign captions but are never the buyer.
 *
 * Instagram's category taxonomy names PROFESSIONS as well as business types, and a
 * profession is a person. Measured 2026-08-03: `@bharat_reshma` (938k followers) came
 * back "Fashion Designer" and was filed BRAND, because the list below covered "Artist"
 * and "Author" but not the dozen other creative professions in the same taxonomy. A
 * media-buying pitch addressed to a designer is a wasted message and a plausible spam
 * report — they did not buy the placement, they appeared in it.
 */
const PERSON_CATEGORIES = new Set([
  'artist',
  'actor',
  'musician/band',
  'public figure',
  'politician',
  'personal blog',
  'digital creator',
  'content creator',
  'entrepreneur',
  'author',
  'athlete',
  'blogger',
  'video creator',
  'gamer',
  'comedian',
  // Creative professions — a job title, not a company. Added after @bharat_reshma.
  'fashion designer',
  'designer',
  'photographer',
  'model',
  'writer',
  'journalist',
  'editor',
  'chef',
  'dancer',
  'musician',
  'singer',
  'producer',
  'director',
  'filmmaker',
  'makeup artist',
  'hair stylist',
  'fashion model',
  'actress',
  'influencer',
  'coach',
  'doctor',
  'lawyer',
  'teacher',
  'personal trainer',
  'fitness trainer',
  'health/beauty',
  'gaming video creator',
  'gaming creator',
  'gamer',
])

/**
 * Categories that identify a COMPETITOR or an intermediary rather than a buyer.
 *
 * Digital Sukoon sells media placement, so an advertising agency is the other side of
 * the table — they place the buy we want to win, and pitching them a 200-page network is
 * both off-target and an admission we do not know who they are.
 *
 * Measured 2026-08-03: `@mind_shifters` ("Advertising/Marketing") was created as a brand
 * target from the @theleela campaign — and `tests/detectors.test.ts` ALREADY asserts that
 * exact handle must be dropped as "the agency", for the same reason, in the hook-line
 * path. The rule existed in one half of the system and not the other.
 *
 * Filed PERSON rather than BRAND because PERSON is this resolver's "not a prospect"
 * verdict; it is never messaged and never resurfaces. The category is recorded, so the
 * audit trail still says what it actually was.
 */
const NOT_A_PROSPECT_CATEGORIES = new Set([
  'advertising/marketing',
  'advertising agency',
  'marketing agency',
  'media agency',
  'public relations',
  'media/news company',
])

/** Handles that are never a prospect: ours, and Instagram furniture. */
const NEVER_A_PROSPECT = new Set(['instagram', 'explore', 'reels'])

export type BrandVerdict =
  | { kind: 'BRAND'; handle: string; displayName: string; category: string | null; followers: number | null }
  | { kind: 'PERSON'; handle: string; category: string | null }
  | { kind: 'MISSING'; handle: string }
  /**
   * We READ the profile and still cannot tell — no category, not a business account.
   * Distinct from UNKNOWN, and the distinction is load-bearing: this one will never
   * resolve by retrying, because the data simply is not there. It needs a human.
   */
  | { kind: 'UNRESOLVED'; handle: string; reason: string }
  /**
   * We never got to look — rate limited or a network error. Retrying WILL help.
   * Never treated as PERSON: absence of an answer is not a negative answer.
   */
  | { kind: 'UNKNOWN'; handle: string; reason: string }

/**
 * Compile-time proof that every verdict this file can produce is declared in
 * `BRAND_LOOKUP_KINDS`, and that the union declares nothing extra.
 *
 * `verdict.kind` is written straight to `BrandLookup.kind`, so the two ARE the same
 * vocabulary — and they silently diverged once already: `UNRESOLVED` existed here and in
 * four live rows while the constants file and the schema comment both listed four values.
 * Nothing caught it because SQLite has no enum and nothing validates the string on write.
 *
 * These two assignments fail to compile if either side gains or loses a member, which is
 * the cheapest possible place to catch it.
 */
const _verdictKindsAreDeclared: BrandLookupKind = null as unknown as BrandVerdict['kind']
const _declaredKindsAreProducible: BrandVerdict['kind'] = null as unknown as BrandLookupKind
void _verdictKindsAreDeclared
void _declaredKindsAreProducible

const ENDPOINT = 'https://www.instagram.com/api/v1/users/web_profile_info/?username='
const HEADERS: Record<string, string> = {
  'x-ig-app-id': '936619743392459',
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  Accept: '*/*',
  Referer: 'https://www.instagram.com/',
}

/**
 * Spacing between profile lookups.
 *
 * Kept at 6s even though the 400s turned out NOT to be throttling (see the header): the
 * endpoint is undocumented and unowned, brand discovery is not time-critical, and a
 * prospect found tomorrow is worth what one found today is. Not a knob to tune down for
 * throughput — there is nothing to gain and an IP-level block to lose.
 */
const LOOKUP_DELAY_MS = 6_000

/**
 * What a profile payload MEANS, as a pure function.
 *
 * Extracted from the fetch so every rule is testable without a network call — the same
 * reason `governor.ts` and `gate.ts` are pure. Both classification bugs found on
 * 2026-08-03 (@bharat_reshma the fashion designer filed BRAND, @mind_shifters the agency
 * created as a prospect) shipped precisely because this logic sat inside an
 * `await fetch()` and therefore had no tests at all.
 */
export function classifyProfile(input: {
  handle: string
  category: string | null
  isBusinessAccount: boolean
  isProfessionalAccount: boolean
  fullName?: string | null
  followers?: number | null
}): BrandVerdict {
  const { handle: h, category, isBusinessAccount, isProfessionalAccount } = input
  const catLower = category?.toLowerCase() ?? ''

  /**
   * A brand is a professional account whose category is NOT a person-role and NOT a
   * competitor.
   *
   * `is_business_account` alone is not enough — @elvish_yadav is a professional account
   * categorised "Artist" with 21M followers and is emphatically not a media buyer. The
   * category separates the buyer from the talent.
   */
  if (PERSON_CATEGORIES.has(catLower) || NOT_A_PROSPECT_CATEGORIES.has(catLower)) {
    /**
     * Checked BEFORE the business test, and the order is the whole point: an agency and a
     * fashion designer are both `is_business_account: true`, so a business-first check
     * files them as buyers. What separates a prospect from a profession or a competitor is
     * the category, never the account type.
     */
    return { kind: 'PERSON', handle: h, category }
  }

  if (isBusinessAccount || (isProfessionalAccount && category !== null)) {
    return {
      kind: 'BRAND',
      handle: h,
      displayName: (input.fullName || h).trim() || h,
      category,
      followers: input.followers ?? null,
    }
  }

  if (category !== null) {
    // A category we do not recognise as a person-role, on a non-professional account.
    return { kind: 'PERSON', handle: h, category }
  }

  /**
   * THE IMPORTANT OUTCOME. A personal account with NO category tells us nothing: it is
   * equally consistent with an individual and with a brand that left the field blank.
   * Calling that PERSON would let missing data harden into a negative verdict,
   * permanently discarding a real prospect with nothing on screen to say so — the exact
   * silent failure this codebase keeps producing. Found 2026-08-03: @farhadsamji,
   * @iamzahero, @jas_manchester and @thisisdsp were all filed PERSON on `category: null`.
   */
  return { kind: 'UNRESOLVED', handle: h, reason: 'no category and not a business account' }
}

/**
 * The model decides ONLY the endpoint's blind spot.
 *
 * WHY THIS EXISTS. Meta deleted the `ig_business_category_subvertical` schema, so
 * `web_profile_info` returns HTTP 400 for accounts that HAVE a business sub-category —
 * precisely the accounts most likely to be brands. @adidas, @crocsindia and
 * @bonkerscorner all landed UNRESOLVED and showed on the dashboard as "could not read
 * this account" with manual buttons beside them. Tabish: "How can adidas not be
 * recognized as anything? I do not want this option to select manually, correct it."
 *
 * THE ORDERING IS LOAD-BEARING, because this decides whether a handle becomes a PROSPECT
 * and a prospect can receive a cold DM from a revenue account:
 *
 *  - Any verdict the endpoint ACTUALLY PRODUCED passes through untouched — BRAND, PERSON,
 *    MISSING and UNKNOWN alike. Instagram's own category data is a fact; a model's world
 *    knowledge is a judgement, and a judgement does not get to overrule a fact.
 *  - **UNKNOWN passes through too, and that is the subtle one.** UNKNOWN means the lookup
 *    NEVER HAPPENED (rate-limited, network error), so `resolveBrand` retries it on a later
 *    pass. Deciding it here would substitute a guess made with NO profile facts for a
 *    lookup that is about to succeed — and cache the guess permanently. Two of these five
 *    verdicts are different kinds of "don't know"; only ONE of them is the blind spot.
 *  - A failed call decides NOTHING. `interpretDecision` returns null and the endpoint's
 *    UNRESOLVED stands. Fifth appearance of "absence of data hardens into a verdict" in
 *    this codebase, and here the verdict would be cached forever against a real prospect.
 *  - Sub-threshold confidence and `unsure` stay UNRESOLVED — never messaged.
 *
 * The return type is a DISCRIMINATED UNION rather than `decidedBy: 'model' | null` beside
 * an independently-nullable `decision`, so `modelConfidence` and `modelReason` cannot be
 * written from a null with a `!`. The invariant "if the model decided, its decision is
 * here" is then the compiler's to enforce instead of the caller's to remember.
 */
export type ModelApplication =
  | { verdict: BrandVerdict; decidedBy: 'model'; decision: BrandDecision; enrichment: HandleEnrichment }
  /**
   * The model RAN and settled nothing — `unsure`, or under the confidence floor.
   *
   * A THIRD state, and it is what makes the cached-UNRESOLVED fall-through safe. `modelReason`
   * cannot carry this: a FAILED call writes null there too, so "declined" and "never asked"
   * would be indistinguishable and every declined handle would be re-asked on every 15-minute
   * pass forever — the starvation `autoResolve.ts` correctly warned about. Recording that the
   * model ran, separately from what it decided, is the whole difference.
   *
   * It is NOT `decidedBy: 'model'`: the dashboard's "what the model decided" panel filters on
   * exactly that string, and a declined handle rendering there with a null reason and null
   * confidence would be a lie in the audit direction.
   */
  | { verdict: BrandVerdict; decidedBy: 'model-declined'; decision: BrandDecision; enrichment: HandleEnrichment }
  | { verdict: BrandVerdict; decidedBy: null; decision: BrandDecision | null; enrichment: HandleEnrichment | null }

/**
 * Has the model already had its one chance at this handle? PURE, and the ONLY gate on the
 * cached-UNRESOLVED fall-through.
 *
 * `null` — never asked — is the only value that permits a call, so a row from before the
 * feature existed (all 30 of them, @adidas included) is offered exactly once, and a row the
 * model has answered either way never is. `'endpoint'` and `'human'` read as "not asked"
 * deliberately: those settled `kind`, not this question, and an endpoint-settled row is
 * never UNRESOLVED anyway.
 */
export function modelHasRun(row: { decidedBy: string | null }): boolean {
  return row.decidedBy === 'model' || row.decidedBy === 'model-declined'
}

export async function applyModelToUnresolved(
  verdict: BrandVerdict,
  context: { caption?: string | null },
): Promise<ModelApplication> {
  if (verdict.kind !== 'UNRESOLVED') return { verdict, decidedBy: null, decision: null, enrichment: null }

  /**
   * Facts first, and they are worth gathering even when nothing is decided: an UNRESOLVED
   * row carrying "1.2M followers · professional account · verified" says Meta's bug is
   * hiding a live account rather than the handle being dead. Deliberately never parsed
   * back into a classification — @tilara.india (a brand) and @adityathackeray (a
   * politician) produce the IDENTICAL string, so any rule over it would message the
   * politician. It goes to the MODEL as evidence, not to a rule as an answer.
   */
  const enr = await enrichHandle(verdict.handle)
  const decision = await decideBrand({
    handle: verdict.handle,
    displayName: enr.fullName,
    followers: enr.followers,
    isVerified: enr.isVerified,
    reachable: enr.reachable,
    enrichment: describeEnrichment(enr),
    // The sentence the handle was mentioned in — the evidence the endpoint never had, and
    // what separates "@x, whose product this is" from "@x, credited for the photo".
    captionContext: context.caption ?? null,
  })
  const decided = interpretDecision({ handle: verdict.handle, decision })

  if (!decided || decided.kind === 'UNRESOLVED') {
    /**
     * The endpoint's own UNRESOLVED stands either way, but WHY it stands is two different
     * facts and they must not be collapsed:
     *
     *   the model ANSWERED and declined  → `model-declined`. It had its chance on this
     *                                      evidence; re-asking buys nothing and would burn
     *                                      the per-pass bound forever.
     *   the call FAILED (`decision` null) → nothing recorded, so it stays retryable. A
     *                                      network blip or a missing API key must never
     *                                      permanently silence a real prospect — the fifth
     *                                      appearance of "absence of data hardens into a
     *                                      verdict" is the one thing this file exists against.
     */
    if (decision) return { verdict, decidedBy: 'model-declined', decision, enrichment: enr }
    return { verdict, decidedBy: null, decision, enrichment: enr }
  }

  // `decision` is provably non-null here: `interpretDecision` returns null for a null
  // decision, so a non-null `decided` cannot have come from one. Narrowed rather than
  // asserted, because `modelConfidence` is a column the dashboard reads.
  if (!decision) return { verdict, decidedBy: null, decision, enrichment: enr }
  return { verdict: decided, decidedBy: 'model', decision, enrichment: enr }
}

/**
 * What a non-OK HTTP response MEANS. Pure, so both branches are testable.
 *
 * `haltRun` is the dangerous half: escalating a per-handle failure to a run-wide stop
 * emptied three consecutive brand-discovery runs while the endpoint was healthy.
 */
export function interpretLookupFailure(input: {
  handle: string
  status: number
  body: string
}): { verdict: BrandVerdict; haltRun: boolean } {
  const { handle: h, status, body } = input

  if (body.includes('has been deleted. You cannot use this schema')) {
    /**
     * Instagram's own bug, permanent until they fix it, and retrying cannot help — so
     * UNRESOLVED ("we looked; the data is not obtainable"), NOT UNKNOWN ("we never
     * looked"). Filing it UNKNOWN would make every future run retry it forever and never
     * drain the queue. Still never PERSON: we do not know what this account is.
     */
    return {
      verdict: { kind: 'UNRESOLVED', handle: h, reason: `HTTP ${status}: Instagram category-schema bug` },
      haltRun: false,
    }
  }

  if (status === 429 || status === 401 || status === 403) {
    // A real throttle or block. Halting IS right: continuing to ask after being told to
    // stop is what turns rate limiting into an IP ban.
    return { verdict: { kind: 'UNKNOWN', handle: h, reason: `HTTP ${status}` }, haltRun: true }
  }

  // Anything else: this ONE lookup failed and will be retried. The run continues.
  return { verdict: { kind: 'UNKNOWN', handle: h, reason: `HTTP ${status}` }, haltRun: false }
}

/**
 * ── AFTER A REAL THROTTLE, STOP ASKING FOR A WHILE. NOT FOREVER ────────────
 *
 * This was a BOOLEAN and it disabled the feature for over two hours in production.
 *
 * MEASURED on the live server 2026-08-11. At 14:15 one handle (@stevemaddenindia) returned
 * a genuine HTTP 429 and the latch set. Every detection pass for the next two hours then
 * reported `brand auto-resolve looked=1 created=0 needsAHuman=0 haltedEarly=true`, there
 * were ZERO `purpose: 'resolve'` rows in `ModelCall` — the brand-decision model had never
 * once run in production — and all 30 UNRESOLVED `BrandLookup` rows still had
 * `decidedBy = null`, @adidas among them: the handle this whole feature was built for. A
 * control probe from both the server and a laptop then returned HTTP 400 for
 * @stevemaddenindia and @adidas (Meta's category-schema bug, correctly UNRESOLVED) and
 * HTTP 200 for @royalcanin.india. **The endpoint was healthy and the latch was stale.**
 *
 * WHY A BOOLEAN WAS EVER DEFENSIBLE, AND WHAT CHANGED UNDERNEATH IT. The only caller used
 * to be `pnpm ig:brands`, a short-lived CLI where "the rest of the run" and "the rest of
 * the process" are the same sentence. On 2026-08-11 `src/detection/autoResolve.ts` shipped
 * on the 15-minute detection cron INSIDE the long-lived server process, and that one word
 * silently became "the rest of the process lifetime" — days. Nothing about the latch
 * changed; its meaning did, because a new caller changed what a "run" is.
 *
 * NOTE THE SHAPE, because it is why nobody saw it. The short-circuit returns BEFORE any
 * request is made, so `autoResolve` reported `looked=1 haltedEarly=true` — indistinguishable
 * from a fresh 429 on every single pass. Silent, self-perpetuating, and wearing the costume
 * of the safe conservative choice: fourth time in this codebase that a halt with no release
 * has been a bug dressed as a safety feature.
 *
 * WHAT IS KEPT. The safety property is not the permanence, it is the BACK-OFF: continuing to
 * ask after being told to stop is what turns rate limiting into an IP ban, and
 * `interpretLookupFailure`'s 429/401/403 → `haltRun: true` is unchanged and correct. Only
 * the DURATION is bounded now.
 */
export const RATE_LIMIT_COOLDOWN_MS = 30 * 60 * 1000

/**
 * When the cooldown expires — `null` when we are not backing off. A TIMESTAMP rather than a
 * boolean is the entire fix: a boolean has no way to become false, which is why the only
 * function that could clear it needed a caller nobody ever wrote.
 *
 * 30 minutes is a real back-off (two whole detection passes skipped, so we are not probing
 * an endpoint that just refused us) and short enough that ONE bad handle cannot disable
 * brand discovery for days. Exported rather than inlined so it is visible on screen, in a
 * test, and in this docblock — not a magic number buried in a comparison.
 */
let rateLimitedUntil: number | null = null

/** True while we are backing off. Pure over its inputs, so a test can drive the clock. */
export function rateLimitCooldownActive(until: number | null, now: number): boolean {
  return until !== null && now < until
}

/**
 * The clock, in one place, so the cooldown is testable without waiting 30 real minutes.
 *
 * `resolveBrand` is reached through `resolveBrandsInCaption` and `autoResolveBrands`,
 * neither of which has any business threading a `now` parameter down to a fetch — so the
 * seam is here rather than in every signature above it. Test-only; production never sets it.
 */
let clock: () => number = () => Date.now()

/** Test seam. Pass nothing to restore the real clock. */
export function setBrandResolverClock(fn?: () => number): void {
  clock = fn ?? (() => Date.now())
}

/** How much longer we are backing off, for a message a human has to act on. */
function cooldownRemaining(now: number): { active: boolean; until: number | null; minutes: number } {
  const active = rateLimitCooldownActive(rateLimitedUntil, now)
  return {
    active,
    until: rateLimitedUntil,
    minutes: active && rateLimitedUntil !== null ? Math.ceil((rateLimitedUntil - now) / 60_000) : 0,
  }
}

/**
 * Clear the back-off deliberately.
 *
 * KEPT, AND NOW IT HAS A CALLER — `pnpm ig:brands`. It had ZERO for the whole life of the
 * boolean, which is the same failure as `repliedAt` being read in six places and written in
 * none: **a reset nobody can trigger is not a reset.** A person typing a command has decided
 * to try, which is exactly the judgement the automatic path cannot make for itself.
 */
export function resetBrandResolverLimit(): void {
  if (rateLimitedUntil !== null) {
    log.info('brand lookup cooldown cleared deliberately', {
      wasUntil: new Date(rateLimitedUntil).toISOString(),
    })
  }
  rateLimitedUntil = null
}

/** Pull every @mention out of a caption, normalised. */
export function mentionsIn(caption: string): string[] {
  return [
    ...new Set(
      (caption.match(/@[A-Za-z0-9_.]{2,}/g) ?? [])
        .map((m) => m.slice(1).replace(/\.$/, '').toLowerCase())
        .filter((h) => h.length >= 2 && !NEVER_A_PROSPECT.has(h)),
    ),
  ]
}

/**
 * Is this handle a business worth pitching?
 *
 * Cached in `BrandLookup` forever once answered: a category does not change, the
 * endpoint is scarce, and re-asking would burn the budget that finds new prospects.
 */
export async function resolveBrand(
  handle: string,
  context: { caption?: string | null } = {},
): Promise<BrandVerdict> {
  const h = handle.replace(/^@/, '').toLowerCase()

  /**
   * ── WHAT THE CACHE DECIDES, AND THE ONE HOLE THAT WAS CLOSED HERE ─────────
   *
   * UNKNOWN is not an answer — the lookup never happened, so it falls through and is retried.
   * BRAND / PERSON / MISSING ARE answers and return immediately: Instagram's own category
   * data is a FACT, the model's world knowledge is a judgement, and a judgement does not get
   * to overrule a fact.
   *
   * UNRESOLVED is the interesting one. It is a real answer FROM THE ENDPOINT ("we looked, the
   * data is not there"), so the endpoint must never be re-asked — but it is precisely the
   * blind spot the model exists to fill, and for the whole life of this feature the early
   * return here meant the model was offered ONLY handles whose lookup had just run.
   *
   * MEASURED on the live Postgres 2026-08-11: 30 UNRESOLVED rows, every one `modelReason
   * IS NULL`, every one `checkedAt` 2026-08-06 — cached DAYS BEFORE the model existed.
   * @adidas, @kfcindia, @nutella, @lux, @titaneyeplus, @rungtasteel, @uspoloassnindia,
   * @bonkerscorner. The founding case of the feature was structurally unreachable: being
   * offered to the model required a fresh lookup, and a cached handle never gets one.
   *
   * So a cached UNRESOLVED the model has NEVER SEEN falls through to it — skipping the
   * endpoint fetch, which we already know the answer to, and gated on `modelHasRun` so a
   * handle the model has already answered is never re-asked. That gate is why this is not
   * the infinite loop `autoResolve.ts` warned about: without it, every declined handle would
   * be re-asked every fifteen minutes forever and starve the genuinely new mentions.
   */
  const cached = await prisma.brandLookup.findUnique({ where: { handle: h } })
  if (cached && cached.kind !== 'UNKNOWN') {
    if (cached.kind === 'BRAND') {
      return {
        kind: 'BRAND',
        handle: h,
        displayName: cached.displayName ?? h,
        category: cached.category,
        followers: cached.followers,
      }
    }
    if (cached.kind === 'PERSON') return { kind: 'PERSON', handle: h, category: cached.category }
    if (cached.kind !== 'UNRESOLVED') return { kind: 'MISSING', handle: h }

    const stored: BrandVerdict = { kind: 'UNRESOLVED', handle: h, reason: 'cached: no category' }
    // Already asked, either way: the cached answer stands and NOTHING is rewritten — there is
    // no new fact, and touching `checkedAt` would misreport when we last learned something.
    if (modelHasRun(cached)) return stored
    /**
     * The back-off is asked HERE TOO, and it is not redundant. `applyModelToUnresolved` calls
     * `enrichHandle`, which is an anonymous Instagram request — so a fall-through firing
     * during a cooldown would be exactly the "continuing to ask after being told to stop"
     * that turns throttling into an IP block, arriving through a door the cooldown was not
     * written to guard. The endpoint fetch is skipped on this path, so the guard below is
     * never reached and this one is the only thing standing there.
     */
    if (rateLimitCooldownActive(rateLimitedUntil, clock())) return stored
    return persistResolution(h, await applyModelToUnresolved(stored, context))
  }

  /**
   * The back-off, and the WORDING is load-bearing. This used to read "rate-limited earlier
   * this run", which is what made two hours of doing nothing invisible: it is true forever
   * once set and says nothing about whether it will ever stop being true. A reason carrying
   * an expiry is a reason an operator can wait out or act on.
   */
  const cooldown = cooldownRemaining(clock())
  if (cooldown.active && cooldown.until !== null) {
    return {
      kind: 'UNKNOWN',
      handle: h,
      reason: `rate-limited; not asking again until ${new Date(cooldown.until).toISOString()} (${cooldown.minutes} min)`,
    }
  }

  /**
   * The cooldown has just expired. Logged on the FIRST lookup after it lapses rather than on
   * a timer, because there is no timer — and an operator must be able to SEE the recovery
   * rather than infer it from lookups quietly starting to work again. A feature silently
   * doing nothing for two hours is the failure this whole docblock is about; a feature
   * silently resuming is the same failure with a happier ending and no evidence.
   */
  if (rateLimitedUntil !== null) {
    log.info('brand lookup cooldown expired — resuming lookups', {
      handle: h,
      wasUntil: new Date(rateLimitedUntil).toISOString(),
    })
    rateLimitedUntil = null
  }

  let verdict: BrandVerdict
  try {
    const res = await fetch(ENDPOINT + encodeURIComponent(h), { headers: HEADERS })

    if (res.status === 404) {
      verdict = { kind: 'MISSING', handle: h }
    } else if (!res.ok) {
      /**
       * A failure is not automatically a throttle, and treating it as one cost this
       * project a full brand-discovery queue.
       *
       * MEASURED 2026-08-03, and it overturns the earlier reading in CLAUDE.md that
       * "7 of 10 lookups returned HTTP 400 even at 2.5s spacing" — that was recorded as
       * rate limiting; it is NOT. Interleaving a control handle between eight lookups
       * returned HTTP 200 EVERY time, so the endpoint was never throttling. Six specific
       * handles returned 400 persistently and the rest returned 200. The body says why:
       *
       *   {"message":"Asset asset://laser.provider/ig_business_category_subvertical
       *     has been deleted. You cannot use this schema","status":"fail"}
       *
       * Instagram's bug, not ours — it fails for accounts that HAVE a business category,
       * i.e. precisely the accounts most likely to be brands. @netflix_in and
       * @tseries.official are unreachable while a 40-follower private account resolves.
       *
       * The old code set `rateLimited` on any non-OK status, halting the WHOLE run. Three
       * consecutive runs made zero progress and reported "rate-limited" each time while
       * the endpoint was healthy. A per-item failure escalated to a run-wide stop has
       * unbounded blast radius from one bad row, and it looks like the safe option.
       */
      const body = await res.text().catch(() => '')
      const outcome = interpretLookupFailure({ handle: h, status: res.status, body })
      verdict = outcome.verdict
      if (outcome.haltRun) {
        rateLimitedUntil = clock() + RATE_LIMIT_COOLDOWN_MS
        /**
         * `warn`, not `step`. `step` is the narration of ordinary work and scrolls past
         * unread; this is the line that explains why brand discovery is about to do nothing
         * for half an hour, and it went unnoticed in the pm2 logs for two hours as a `step`.
         * The expiry is in the line so nobody has to know the constant to read it.
         */
        log.warn('brand lookup rate-limited — backing off', {
          handle: h,
          status: res.status,
          cooldownMinutes: Math.round(RATE_LIMIT_COOLDOWN_MS / 60_000),
          until: new Date(rateLimitedUntil).toISOString(),
        })
      } else {
        log.step('brand lookup failed for this handle — continuing', {
          handle: h,
          status: res.status,
          reason: 'reason' in verdict ? verdict.reason : '',
        })
      }
    } else {
      const user = ((await res.json()) as { data?: { user?: Record<string, unknown> } })?.data?.user
      if (!user) {
        verdict = { kind: 'MISSING', handle: h }
      } else {
        verdict = classifyProfile({
          handle: h,
          category: (user.business_category_name ?? user.category_name ?? null) as string | null,
          isBusinessAccount: user.is_business_account === true,
          isProfessionalAccount: user.is_professional_account === true,
          fullName: (user.full_name as string | null) ?? null,
          followers: ((user.edge_followed_by as { count?: number } | undefined)?.count ?? null) as number | null,
        })
      }
    }
  } catch (err) {
    verdict = { kind: 'UNKNOWN', handle: h, reason: err instanceof Error ? err.message : String(err) }
  }

  /**
   * The model gets the endpoint's blind spot and nothing else — a decision is asked for ONCE
   * per handle, enforced by `modelHasRun` on the cached path rather than by the accident of
   * where this call sits.
   */
  return persistResolution(h, await applyModelToUnresolved(verdict, context))
}

/**
 * THE ONE PLACE A RESOLUTION IS WRITTEN. Both callers — a fresh lookup and a cached
 * UNRESOLVED falling through to the model — end here.
 *
 * Extracted rather than duplicated into the cached branch, and that is a deliberate choice
 * against this codebase's most-repeated failure: `gate.ts`, `readThread.ts`, the two Connect
 * buttons and `judgeWithFrame` were each ONE rule with several callers that drifted, and the
 * cost was found in production every time. A second `upsert` here would be a second copy of
 * "who settled this and what do we record about it" — the rule that decides whether a row
 * becomes a cold-DM-able prospect.
 */
async function persistResolution(h: string, applied: ModelApplication): Promise<BrandVerdict> {
  const verdict = applied.verdict

  // UNKNOWN is cached too, so a later pass can find and retry it — but it is never
  // read back as an answer (see the cache check above).
  // Only BRAND and PERSON carry a category; MISSING and UNKNOWN have no profile to
  // read one from. Narrowing explicitly rather than probing with `in`, which the
  // compiler correctly flagged as always-nullish on the MISSING branch.
  const category = verdict.kind === 'BRAND' || verdict.kind === 'PERSON' ? verdict.category : null
  const displayName = verdict.kind === 'BRAND' ? verdict.displayName : null
  const followers = verdict.kind === 'BRAND' ? verdict.followers : null

  /**
   * WHO SETTLED THIS. An auto-created prospect can be cold-DMed from a revenue account, so
   * months later the row itself must say whether Instagram's category data or a model's
   * judgement put it there — with the confidence and the one-line reason beside it.
   * `null` where nothing settled anything: UNKNOWN (never looked), and an UNRESOLVED whose
   * model call FAILED — which must stay null precisely so it is asked again.
   * `'model-declined'` is not null: the model answered, and re-asking it the same question
   * about the same evidence buys nothing.
   */
  const decidedBy = applied.decidedBy ?? (verdict.kind === 'BRAND' || verdict.kind === 'PERSON' ? 'endpoint' : null)
  const fields = {
    kind: verdict.kind,
    category,
    displayName,
    followers,
    decidedBy,
    /**
     * Recorded ONLY for a real decision. No `!`: the union guarantees a decision whenever
     * `decidedBy` is 'model'. A declined row deliberately carries neither — the dashboard
     * reads these two columns beside the "what the model decided" list, and a confidence of
     * 40% with the reason "not confident" on a row that decided nothing reads as a verdict.
     */
    modelConfidence: applied.decidedBy === 'model' ? applied.decision.confidence : null,
    modelReason: applied.decidedBy === 'model' ? applied.decision.reason : null,
    // Facts are kept whenever they were gathered, decided or not — an UNRESOLVED row that
    // says "1.2M followers · verified" is a live account hidden by Meta's bug, not a dead
    // handle, and that is the difference an operator needs.
    ...(applied.enrichment
      ? { enrichment: describeEnrichment(applied.enrichment), reachable: applied.enrichment.reachable }
      : {}),
  }

  await prisma.brandLookup.upsert({
    where: { handle: h },
    update: { ...fields, checkedAt: new Date() },
    create: { handle: h, ...fields },
  })

  return verdict
}

/** Resolve a caption's mentions, slowly, stopping the moment Instagram objects. */
export async function resolveBrandsInCaption(caption: string): Promise<BrandVerdict[]> {
  const out: BrandVerdict[] = []
  for (const handle of mentionsIn(caption)) {
    const cached = await prisma.brandLookup.findUnique({ where: { handle } })
    const wasCached = cached !== null && cached.kind !== 'UNKNOWN'
    // The caption travels with the handle: it is the one piece of evidence the profile
    // endpoint never had, and the difference between "@x, whose product this is" and
    // "@x, credited for the photo".
    out.push(await resolveBrand(handle, { caption }))
    // Read AFTER the lookup: it is what that lookup just set. No point sleeping 6s between
    // handles we are no longer going to ask about, and no point continuing the loop at all.
    const backingOff = rateLimitCooldownActive(rateLimitedUntil, clock())
    if (!wasCached && !backingOff) await new Promise((r) => setTimeout(r, LOOKUP_DELAY_MS))
    if (backingOff) break
  }
  return out
}
