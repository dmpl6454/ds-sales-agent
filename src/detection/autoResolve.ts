import { prisma } from '@/lib/db'
import { log } from '@/lib/logger'
import { detectionCutoff } from '@/lib/cutoff'
import { mentionsIn, taggedHandlesIn, modelHasRun, resolveBrand } from './resolveBrand'
import { brandCandidatesFor, excludedHandles } from './brandCandidates'
import { createBrandTarget } from '@/outreach/brandTarget'
import { admitsAsTalent } from '@/outreach/targetAudit'
import { getSettings } from '@/lib/settings'

/**
 * AFTER A DETECTION PASS: turn the @mentions of recent CAMPAIGN captions into prospects,
 * with no human step (the one-switch decision, 2026-08-08).
 *
 * ── WHY THIS RUNS ON THE PIPELINE AND NOT BEHIND A FLAG ───────────────────
 *
 * Tabish: *"How can adidas not be recognized as anything? I do not want this option to
 * select manually, correct it."* and *"The channels which are undecided must also be
 * decided on their own."* The resolver (`decideBrand`) and its wiring
 * (`applyModelToUnresolved`) were built first; without a caller on the automatic path they
 * would only ever run when somebody typed `pnpm ig:brands --run`.
 *
 * That is a failure this codebase has already paid for. MEASURED 2026-08-08: 166 cover
 * frames were saved in one day and NONE were read, because the only frame-aware code lived
 * behind `scripts/ocr.ts --reclassify`. **A feature that works only when someone runs a
 * command is not running.** `tests/auto-resolve.test.ts` asserts the pipeline calls this,
 * for the same reason `tests/one-judging-path.test.ts` exists.
 *
 * ── BOUNDED, AND WHY THE BOUND IS SMALL ───────────────────────────────────
 *
 * `resolveBrand` sleeps nothing itself, but `resolveBrandsInCaption` spaces lookups 6s
 * apart and the endpoint is scarce and undocumented. Detection runs every 15 minutes, so a
 * bound of 10 NEW lookups a pass is ~960 a day at the outside — and in practice far fewer,
 * because a handle answered once is cached forever and skipped here without a request. The
 * bound counts LOOKUPS ATTEMPTED, not brands created: a pass that resolves ten people has
 * spent exactly as much of the endpoint as one that resolves ten brands.
 *
 * ── A REAL THROTTLE STOPS THE PASS. ONE BROKEN HANDLE DOES NOT ────────────
 *
 * `interpretLookupFailure` already owns that distinction, and it exists because the
 * opposite reading emptied three consecutive brand-discovery runs against a healthy
 * endpoint. A 429/401/403 sets `resolveBrand`'s internal halt, after which every remaining
 * lookup returns UNKNOWN without a request — so continuing the loop would be a silent
 * no-op that reports nothing. UNKNOWN therefore returns early with what was decided so
 * far. Instagram's permanent category-schema 400 is UNRESOLVED, not UNKNOWN, so it does
 * NOT stop the pass — which is the whole point of the split.
 */

/**
 * HOW LONG A HANDLE WHOSE MODEL CALL FAILED WAITS BEFORE BEING OFFERED AGAIN.
 *
 * This is the anti-starvation bound, and it exists because reopening UNRESOLVED (below) makes
 * a real loop possible for the first time. A FAILED model call records nothing — `decidedBy`
 * stays null, deliberately, so a network blip or a missing API key can never permanently
 * silence a real prospect. "Retryable" with no back-off means every fifteen minutes forever:
 * with no `DEEPSEEK_API_KEY` configured, ten such handles fill `MAX_LOOKUPS_PER_PASS` on every
 * pass and the genuinely new mentions behind them are never reached.
 *
 * SIX HOURS: about 24 detection passes skipped, so a handle costs the bound four times a day
 * instead of ninety-six, and short enough that a real outage (a key rotated, DeepSeek down for
 * an hour) costs at most one window rather than a human noticing. Not a knob for throughput —
 * a prospect found six hours later is worth exactly what one found now is.
 */
export const MODEL_RETRY_AFTER_MS = 6 * 60 * 60 * 1000

/**
 * WHAT "SETTLED" MEANS, AND WHY UNRESOLVED IS NO LONGER UNCONDITIONAL.
 *
 * A handle is settled when `BrandLookup` holds an answer no further work can improve:
 *
 *   BRAND / PERSON / MISSING   an answer. Never re-asked.
 *   UNKNOWN                    we never looked. Retried — that is what UNKNOWN is for.
 *   UNRESOLVED                 we looked and the endpoint's data is not there.
 *
 * UNRESOLVED is the interesting one, and this docblock previously argued it was settled
 * UNCONDITIONALLY. **The reasoning was right about the danger and wrong about the fix, and
 * the live database showed which.**
 *
 * The danger, quoted from the old version and still true: a row the model DECLINED and a row
 * the model NEVER SAW are indistinguishable by `modelReason`, because a failed call writes
 * null there too — so re-listing either one would ask `resolveBrand` a question it answers
 * from cache, forever, every fifteen minutes, starving the genuinely new mentions.
 *
 * What that missed is that the premise was a BUG rather than a law. `resolveBrand` returned a
 * cached UNRESOLVED before `applyModelToUnresolved` could see it, so the model was only ever
 * offered handles whose endpoint lookup had just run — and MEASURED 2026-08-11, all 30
 * UNRESOLVED rows were cached on 2026-08-06, days BEFORE the model existed. Every one had
 * `modelReason IS NULL` and none could ever be offered: @adidas, the founding case of the
 * whole feature, among them. Treating that as "settled" made the gap permanent.
 *
 * `7f99c94` fixed that in `resolveBrand`, which now falls through to the model for a cached
 * UNRESOLVED it has never seen. **AND THIS FUNCTION COULD NOT REACH IT.** The old one-liner
 * returned true for any cached UNRESOLVED, so the cron `continue`d before `resolveBrand` was
 * ever called and the fall-through ran ONLY from `pnpm ig:brands`. That is the shape this
 * codebase has paid for twice — 166 cover frames saved in a day and none read, because the
 * only frame-aware code sat behind a CLI flag. **A feature that works only when someone runs
 * a command is not running.**
 *
 * So the gate asks about the MODEL's involvement rather than about `kind` alone:
 *
 *   BRAND / PERSON / MISSING              a real endpoint answer. Settled.
 *   UNRESOLVED + `modelHasRun`            asked and answered ('model' or 'model-declined').
 *                                         Settled. Re-asking the same question about the
 *                                         same evidence buys nothing.
 *   UNRESOLVED + model never ran + tried
 *     within MODEL_RETRY_AFTER_MS         NOT settled, but HELD — see below. Reported as
 *                                         `awaitingRetry`, never silently skipped.
 *   UNRESOLVED + model never ran, older   NOT settled. Offered, which is the whole fix.
 *   UNKNOWN                               we never looked. Retried by the endpoint.
 *
 * `modelHasRun` is IMPORTED, not restated. It is the one-chance rule and `resolveBrand`
 * enforces it too; a second copy of that predicate is how `gate.ts`, `readThread.ts`, the two
 * Connect buttons and `judgeWithFrame` each drifted.
 *
 * ── THE BACK-OFF IS `checkedAt`, AND WHY THAT COLUMN RATHER THAN A NEW ONE ─
 *
 * `persistResolution` bumps `checkedAt` on EVERY write, a failed model call included — that
 * call writes `decidedBy: null` (retryable) plus whatever `enrichHandle` gathered, so the
 * timestamp is already a durable record of "we tried this handle and got nowhere". No new
 * column, no migration, and — the part that matters — no second copy of state that a server
 * restart could disagree with. An in-process attempt counter would reset on every deploy,
 * which is precisely how the rate-limit latch's meaning changed underneath it when a
 * long-lived caller appeared.
 *
 * It reads slightly loose in the SAFE direction: a pre-model row's `checkedAt` is its
 * ENDPOINT lookup, not a model attempt, so a row written in the last six hours by the endpoint
 * waits one window before the model sees it. Costs at most six hours on a brand-new
 * UNRESOLVED and cannot hide one, because the endpoint half is what just ran. The live rows
 * are days old and are offered on the first pass.
 */
function classifyCached(
  cached: { kind: string; decidedBy: string | null; checkedAt: Date } | null,
  now: number,
): 'settled' | 'awaiting-retry' | 'backing-off' | 'ask' {
  if (cached == null) return 'ask'
  if (cached.kind === 'UNKNOWN') {
    /**
     * UNKNOWN is still RETRIED — that is what UNKNOWN is for, and nothing here makes it
     * permanent. It is merely not retried on the very next pass after its own lookup was
     * refused: `UNKNOWN_RETRY_AFTER_MS` is the per-handle half of the livelock fix, and
     * without it the handle that just 429'd is eligible again fifteen minutes later and
     * competes for the head of the queue every pass forever.
     */
    const since = now - cached.checkedAt.getTime()
    return since < UNKNOWN_RETRY_AFTER_MS ? 'backing-off' : 'ask'
  }
  if (cached.kind !== 'UNRESOLVED') return 'settled'
  if (modelHasRun(cached)) return 'settled'
  const since = now - cached.checkedAt.getTime()
  return since < MODEL_RETRY_AFTER_MS ? 'awaiting-retry' : 'ask'
}

/**
 * THE ORDER LOOKUPS ARE ATTEMPTED IN, AND IT IS THE HEART OF THE LIVELOCK FIX. PURE.
 *
 * Oldest attempt first; a handle never looked at goes before every handle that has been.
 * `checkedAt` is bumped by `persistResolution` on EVERY write, a 429 included — so a handle
 * that just caused a halt carries the NEWEST timestamp and sorts to the BACK. The queue
 * rotates instead of re-offering the same head, which is precisely what
 * `looked=1 haltedEarly=true` on every pass for hours was.
 *
 * WHY `checkedAt` RATHER THAN A NEW COLUMN OR A COUNTER. It already records the last attempt,
 * it is already written on failure, and it is durable — an in-process attempt counter resets
 * on every deploy, which is exactly how the rate-limit latch's meaning changed underneath it
 * when a long-lived caller appeared. A migration on the live Postgres for state that is
 * already there would be the worse trade.
 *
 * The tie-break is the HANDLE, not the caption position. Ordering must be TOTAL or the sort is
 * not deterministic across passes, and a nondeterministic order is a livelock that reappears
 * intermittently instead of reliably — far harder to see than the one this replaces.
 *
 * Ordering is deliberately NOT the whole fix and must not be read as one: on its own it drains
 * the backlog and then hands the head back to the unlucky handle once it is the only one left.
 * `UNKNOWN_RETRY_AFTER_MS` is the other half. Both were simulated before either was written.
 */
export function orderForLookup<T extends { handle: string; checkedAt: Date | null; source?: 'mention' | 'tag' }>(
  candidates: readonly T[],
): T[] {
  /**
   * A CAPTION MENTION OUTRANKS A MEDIA TAG, ahead of everything else.
   *
   * The bound is a LOOKUP budget (10 a pass), so a weaker candidate taking a slot is a
   * stronger one not taken. The paying brand @mentions the post; a tag is Instagram saying
   * an account appears in the media, which is true of the celebrity as often as the
   * advertiser — MEASURED, @bollywoodchronicle tags someone in 46.3% of its ORGANIC posts
   * against 20.0% of its CAMPAIGN posts, so on that channel the correlation INVERTS.
   *
   * Tags still earn their place: 47% of paid posts carry no caption mention at all, so
   * without them nearly half of what detection finds produces no prospect. They just go
   * second. `source` is optional so the existing pure tests, which pass neither, are
   * unaffected — and a candidate with no source sorts as a mention, which is the direction
   * that spends the budget on the stronger evidence.
   */
  const rank = (c: T) => (c.source === 'tag' ? 1 : 0)

  return [...candidates].sort((a, b) => {
    const R = rank(a) - rank(b)
    if (R !== 0) return R
    const A = a.checkedAt?.getTime() ?? null
    const B = b.checkedAt?.getTime() ?? null
    if (A === null && B === null) return a.handle.localeCompare(b.handle)
    // Never looked at goes first: it is the only candidate that has cost the endpoint nothing.
    if (A === null) return -1
    if (B === null) return 1
    if (A !== B) return A - B
    return a.handle.localeCompare(b.handle)
  })
}

export const MAX_LOOKUPS_PER_PASS = 10

/**
 * HOW LONG A HANDLE WAITS AFTER ITS OWN LOOKUP CAME BACK UNKNOWN.
 *
 * ── THE LIVELOCK THIS CLOSES, MEASURED ON THE LIVE SERVER 2026-08-11 ──────
 *
 * Every 15-minute pass produced the identical three lines for hours:
 *
 *   brand auto-resolve  looked=1 created=0 needsAHuman=0 awaitingRetry=0 haltedEarly=true
 *   brand lookup rate-limited — backing off  handle=iconicbyonevision status=429
 *   brand auto-resolve stopped early — lookup endpoint unavailable  handle=iconicbyonevision
 *
 * `MAX_LOOKUPS_PER_PASS` is 10 and `looked` was 1, forever. THREE INDIVIDUALLY-CORRECT RULES
 * COMPOSED INTO A TRAP: UNKNOWN is deliberately not settled (it means "we never got to look",
 * so it must be retried); the walk was newest-post-first and then caption order, which is
 * POSITIONAL and therefore identical on every pass; and a 429 correctly halts the pass. So
 * one unlucky handle at the head of a fixed order monopolised the entire budget, and no other
 * handle was ever reached.
 *
 * Control probes settled what it was NOT: @iconicbyonevision returned HTTP 200 from both the
 * server and a laptop, and six spaced probes (5s apart, that handle three times) returned 200
 * every time. **A healthy endpoint with sporadic 429 bursts against the datacenter IP, landing
 * on whichever handle happens to go first.** Not a blocked IP, not a bad handle — which is
 * exactly why "whichever handle goes first" had to stop being the same handle.
 *
 * ── WHY BOTH HALVES SHIPPED TOGETHER, AND WHY ORDERING IS NOT ENOUGH ──────
 *
 * SIMULATED before either was written, because the two fixes hide each other:
 *
 *   ordering alone       pass 1 [bad] · pass 2 [h1,h2,h3,h4,bad] · pass 3 [bad] · 4 [bad] …
 *                        The backlog drains, then `bad` is the only handle left unresolved,
 *                        returns to the head and halts every pass again. Better, not fixed.
 *   this back-off alone  breaks the loop, and makes the ORDERING CHANGE INVISIBLE — both
 *                        orders then resolve the same handles, so a mutation test asserting
 *                        the ordering would pass with the old ordering restored.
 *
 * That second line is the trap. The ordering test therefore drives a scenario the cooldown
 * cannot reach: a recently-failed handle that is PAST this window (so it is legitimately
 * eligible) sitting in front of never-looked-at mentions. Old order resolves NOTHING; new
 * order resolves all three and takes the halt LAST, after the budget was spent productively.
 *
 * THIRTY MINUTES matches `RATE_LIMIT_COOLDOWN_MS` in resolveBrand.ts deliberately — that is
 * the process-wide back-off after a real throttle, and a handle whose own lookup was the one
 * refused should not be offered again before the fleet-wide cooldown it caused has expired.
 * Two whole detection passes skipped. Short enough that a sporadic burst costs one handle half
 * an hour rather than a day, and long enough that we are not re-probing an endpoint that just
 * refused us. NOT a knob for throughput: a prospect found half an hour later is worth exactly
 * what one found now is.
 *
 * It is a BACK-OFF, NEVER A VERDICT. `kind` stays UNKNOWN, `decidedBy` stays null, nothing is
 * marked, and the handle returns to the queue the moment the window lapses — absence of an
 * answer must never harden into "not a brand", which is this codebase's most-repeated failure.
 */
export const UNKNOWN_RETRY_AFTER_MS = 30 * 60 * 1000

export interface AutoResolveSummary {
  /** Lookups attempted — the number that spent the scarce endpoint. */
  looked: number
  /** New BRAND targets created. */
  decided: number
  /** Read, and still not answerable: UNRESOLVED. Visible, never a negative verdict. */
  skippedUnsure: number
  /** True when a real throttle ended the pass early. */
  haltedEarly: boolean
  /**
   * Candidates that were ELIGIBLE and never reached, because the pass halted or spent its
   * bound before getting to them.
   *
   * The number that would have made the livelock obvious in one line instead of hiding for
   * hours. `looked=1 haltedEarly=true` is indistinguishable from "there was one handle and it
   * failed"; `looked=1 unreached=37 haltedEarly=true` says a queue is backing up behind a
   * halt and names how much. A halt with nothing behind it is an ordinary quiet pass.
   */
  unreached: number
  /**
   * Handles held back by `UNKNOWN_RETRY_AFTER_MS` — their own last lookup came back UNKNOWN
   * within the window.
   *
   * Separate from `awaitingRetry` (the MODEL's window) because the two have different
   * remedies: this one means the lookup endpoint refused us and we are backing off politely,
   * that one means the brand-decision model got nowhere and `DEEPSEEK_API_KEY` is worth
   * checking. Collapsing them into one number would send an operator to the wrong place.
   */
  backingOff: number
  /**
   * Handles the model has never ruled on that were HELD this pass, because it was tried
   * within `MODEL_RETRY_AFTER_MS` and got nowhere.
   *
   * Reported rather than logged and forgotten, and this is the number that matters when
   * something is wrong: a rising `awaitingRetry` with `decided` at zero is the signature of
   * a model that is failing every call — a missing API key, a rotated credential, DeepSeek
   * down — which is otherwise indistinguishable from a quiet day with nothing to resolve.
   * `deferred` on the reply check exists for the same reason.
   */
  awaitingRetry: number
}

export async function autoResolveBrands(
  opts: { maxLookups?: number } = {},
): Promise<AutoResolveSummary> {
  const maxLookups = opts.maxLookups ?? MAX_LOOKUPS_PER_PASS
  const settings = await getSettings()

  /**
   * Newest first, and scoped to the detection window. A mention in a post from before the
   * cutoff is history Tabish deliberately excluded (2026-08-03), and the freshest paid post
   * is where a live campaign's buyer is.
   */
  const posts = await prisma.detectedCampaign.findMany({
    where: { verdict: 'CAMPAIGN', postedAt: { gte: detectionCutoff() } },
    orderBy: { postedAt: 'desc' },
    select: { id: true, caption: true, shortcode: true, taggedAccounts: true, rawPayload: true },
  })

  const out: AutoResolveSummary = {
    looked: 0,
    decided: 0,
    skippedUnsure: 0,
    haltedEarly: false,
    unreached: 0,
    backingOff: 0,
    awaitingRetry: 0,
  }

  /**
   * ONE clock reading for the whole pass. A per-handle `Date.now()` would let the retry window
   * fall either side of the boundary within a single pass depending on how long the 6s-spaced
   * lookups ahead of it took — a timing-dependent verdict, which is the jitter mistake
   * `readThread.ts` already paid for once.
   */
  const now = Date.now()

  /**
   * One handle is asked about ONCE per pass even when it appears in several captions. Scoped
   * to the pass and not persisted, deliberately: within a pass it prevents spending the
   * bound twice on the same handle, and across passes the `BrandLookup` cache is the memory
   * — a persistent set here would be a second, divergent copy of that answer.
   */
  const seen = new Set<string>()

  /**
   * ── PHASE 1: COLLECT EVERY CANDIDATE, THEN DECIDE THE ORDER ───────────────
   *
   * Splitting collection from lookup is what makes the anti-starvation ordering possible at
   * all. The old loop looked a handle up the moment it was found, so the attempt order WAS the
   * caption order — positional, identical on every pass, and therefore a fixed head that one
   * unlucky handle held for hours.
   *
   * This phase spends no endpoint budget: it reads captions and the `BrandLookup` cache, both
   * of which are ours. The cheap disposition checks stay HERE rather than after the sort, so a
   * settled or backing-off handle never occupies a slot in the ordered queue — the bound is
   * spent only on handles that are genuinely going to be asked about.
   */
  interface Candidate {
    handle: string
    checkedAt: Date | null
    caption: string | null
    postId: string
    shortcode: string
    /**
     * WHERE this handle came from, and it decides the order.
     *
     * `mention` — the caption names them. The paying brand @mentions the post; this is the
     *   evidence the whole discovery path was built on.
     * `tag`     — Instagram says they are tagged in the media or co-authored it. A FACT
     *   about the post, and the source that closes the 47% of paid posts carrying no caption
     *   mention at all. Weaker: @bollywoodchronicle tags the celebrity in 46.3% of its
     *   ORGANIC posts against 20.0% of its CAMPAIGN posts, so the correlation inverts there.
     *
     * The bound is a LOOKUP budget, so a weaker candidate taking a slot is a stronger one
     * not taken — which is why this is ordered and not merged.
     */
    source: 'mention' | 'tag'
  }
  const candidates: Candidate[] = []

  /**
   * Handles that must never cost a lookup: our own fleet pages, and every publisher we
   * WATCH. Built by `excludedHandles`, shared with `pnpm ig:brands`, so the unattended pass
   * and the command a person runs cannot disagree about who is excluded.
   */
  const neverAProspect = await excludedHandles()

  for (const post of posts) {
    /**
     * ONE DEFINITION OF "WHAT DOES THIS POST OFFER", shared with `pnpm ig:brands`. The two
     * assembled it separately until 2026-08-17, and the CLI's copy read captions only — so
     * the tag source reached neither path in production. See `brandCandidates.ts`.
     */
    for (const { handle, source } of brandCandidatesFor(post, neverAProspect)) {
      if (seen.has(handle)) continue
      seen.add(handle)

      // Cached answer, or an existing target row: either way there is nothing to look up.
      // Checked BEFORE the bound is spent, so a pass full of known handles still reaches
      // the new ones behind them — which is what makes the back-offs anti-starvation rather
      // than merely politeness.
      const cached = await prisma.brandLookup.findUnique({ where: { handle } })
      const disposition = classifyCached(cached, now)
      if (disposition === 'settled') continue
      if (disposition === 'awaiting-retry') {
        out.awaitingRetry++
        continue
      }
      if (disposition === 'backing-off') {
        out.backingOff++
        continue
      }
      if (await prisma.targetAccount.findUnique({ where: { handle } })) continue

      candidates.push({
        handle,
        // A candidate with no cached row has never been looked at and sorts first.
        checkedAt: cached?.checkedAt ?? null,
        caption: post.caption,
        postId: post.id,
        shortcode: post.shortcode,
        source,
      })
    }
  }

  /**
   * ── PHASE 2: ASK, OLDEST ATTEMPT FIRST ────────────────────────────────────
   *
   * A handle that just caused a halt carries the newest `checkedAt` and is therefore LAST, so
   * the pass spends its budget on everything else before it reaches the one that will stop it.
   */
  const queue = orderForLookup(candidates)

  for (const [index, candidate] of queue.entries()) {
    if (out.looked >= maxLookups) {
      // Everything from here on was eligible and is simply not being asked about this pass.
      out.unreached = queue.length - index
      break
    }

    const { handle } = candidate
    out.looked++
    const verdict = await resolveBrand(handle, { caption: candidate.caption })

    if (verdict.kind === 'BRAND') {
      const outcome = await createBrandTarget(
        verdict,
        { id: candidate.postId, shortcode: candidate.shortcode },
        'brand.auto-decided',
        'auto-resolve',
        { isVerified: verdict.isVerified ?? undefined, followerCount: verdict.followers },
      )
      if (outcome === 'created') out.decided++
      continue
    }

    /**
     * A PERSON tagged on a CAMPAIGN post becomes a target when they pass the talent bar
     * (Tabish, 2026-08-19: "send messages to celebrities as well if they are part of the
     * paid campaign"). Every candidate here IS Instagram-asserted campaign evidence — that
     * is what `brandCandidatesFor` walks — so the only question left is legitimacy:
     * verified, or ≥ celebrityMinFollowers. A cached PERSON flows through this branch on
     * every pass too, so historic verdicts get the bar without a separate backfill.
     * Below the bar behaves exactly as before: the person is left alone.
     */
    if (verdict.kind === 'PERSON') {
      const talent = admitsAsTalent(
        { isVerified: verdict.isVerified ?? null, followerCount: verdict.followers ?? null },
        settings.celebrityMinFollowers,
      )
      if (talent) {
        const outcome = await createBrandTarget(
          {
            kind: 'BRAND',
            handle: verdict.handle,
            displayName: verdict.displayName ?? verdict.handle,
            category: verdict.category,
            followers: verdict.followers ?? null,
          },
          { id: candidate.postId, shortcode: candidate.shortcode },
          'brand.auto-decided',
          'auto-resolve:talent',
          { campaignTalent: true, isVerified: verdict.isVerified ?? null, followerCount: verdict.followers ?? null },
        )
        if (outcome === 'created') out.decided++
      }
      continue
    }

    if (verdict.kind === 'UNRESOLVED') {
      out.skippedUnsure++
      continue
    }

    if (verdict.kind === 'UNKNOWN') {
      /**
       * A REAL THROTTLE STILL HALTS THE PASS, AND THAT IS NOT WEAKENED HERE.
       *
       * `resolveBrand`'s internal cooldown has been set by a 429/401/403, or the network
       * failed. Either way every remaining lookup would come back UNKNOWN without a request
       * being made, so continuing would be a silent no-op — and continuing to ask after being
       * told to stop is what turns throttling into an IP ban. Requirement, and CLAUDE.md is
       * explicit: account and IP safety outrank throughput.
       *
       * The livelock fix is entirely in WHICH handle got here and in what is reported, never
       * in carrying on past it. What changed is that this handle is now the LAST one asked
       * rather than permanently the first, so a halt costs the pass nothing it had not already
       * collected — and `unreached` says how many eligible handles are waiting behind it.
       *
       * Nothing is marked. UNKNOWN is cached by `resolveBrand` precisely so a later pass
       * retries it; absence of an answer must never harden into "not a brand".
       */
      out.haltedEarly = true
      out.unreached = queue.length - index - 1
      log.warn('brand auto-resolve stopped early — lookup endpoint unavailable', {
        handle,
        reason: verdict.reason,
        looked: out.looked,
        // The number whose absence hid this for hours: a halt with a queue behind it is a
        // backlog, a halt with nothing behind it is an ordinary quiet pass.
        unreached: out.unreached,
        note:
          out.unreached > 0
            ? 'these were eligible and will be offered ahead of this handle next pass — it now sorts last'
            : 'nothing else was waiting',
      })
      return out
    }

    // PERSON and MISSING are answers, cached by resolveBrand, and not prospects.
  }

  /**
   * SAY IT OUT LOUD. `awaitingRetry` travels to the caller either way, but a number that
   * quietly rises while `decided` sits at zero is the failure this project keeps finding late
   * — so the pass that is holding handles back also says so where an operator is looking.
   *
   * `warn`, not `step`: `step` is the narration of ordinary work and scrolls past unread,
   * which is how a stale rate-limit latch went unnoticed for two hours in the pm2 logs. The
   * window is in the line so nobody has to know the constant to read it.
   */
  if (out.awaitingRetry > 0) {
    log.warn('brand auto-resolve held handles awaiting a model retry', {
      awaitingRetry: out.awaitingRetry,
      retryAfterHours: Math.round(MODEL_RETRY_AFTER_MS / 3_600_000),
      looked: out.looked,
      decided: out.decided,
      note: 'the model has never ruled on these and its last call got nowhere — check DEEPSEEK_API_KEY if this is not falling',
    })
  }

  /**
   * AND THE OTHER BACK-OFF SAYS SO TOO, for the same reason and with a DIFFERENT remedy.
   *
   * `backingOff` counts handles whose own lookup came back UNKNOWN inside
   * `UNKNOWN_RETRY_AFTER_MS`. A pass that looked at nothing because every candidate is waiting
   * out the endpoint is the exact state that reported `looked=1 haltedEarly=true` four times an
   * hour for hours and told nobody anything. `looked` at zero with this number high is the
   * signature of a throttling endpoint, and it must not read as a quiet day.
   *
   * Kept separate from `awaitingRetry` in the message as well as the summary: that one points
   * at DEEPSEEK_API_KEY, this one points at the Instagram endpoint and the datacenter IP. One
   * merged number would send an operator to the wrong place, which is the coverage-caveat
   * lesson — two problems with two fixes are two sentences.
   */
  if (out.backingOff > 0) {
    log.warn('brand auto-resolve backed off handles the lookup endpoint refused', {
      backingOff: out.backingOff,
      retryAfterMinutes: Math.round(UNKNOWN_RETRY_AFTER_MS / 60_000),
      looked: out.looked,
      decided: out.decided,
      note: 'their last lookup came back UNKNOWN (429/network) — still retried, just not first in line',
    })
  }

  return out
}
