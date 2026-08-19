import { prisma } from '@/lib/db'
import {
  resolveBrandsInCaption,
  resolveBrandsForHandles,
  mentionsIn,
  modelHasRun,
  resetBrandResolverLimit,
  resolveBrand,
} from '@/detection/resolveBrand'
import { brandCandidatesFor, excludedHandles } from '@/detection/brandCandidates'
import { createBrandTarget } from '@/outreach/brandTarget'
import { admitsAsTalent } from '@/outreach/targetAudit'
import { getSettings } from '@/lib/settings'

/**
 *   pnpm ig:brands                    what would be discovered — costs nothing
 *   pnpm ig:brands --run              resolve and create brand targets
 *   pnpm ig:brands --run --limit 5    a bounded first pass
 *   pnpm ig:brands --stuck            the backlog the model has never been offered
 *   pnpm ig:brands --stuck --run      offer it to the model, once
 *   pnpm ig:brands --reset @a @b      throw away a WRONG model verdict, making it re-askable
 *
 * Turns detected paid posts into MESSAGEABLE brand accounts.
 *
 * A paid post names its buyer. `@royalcanin.india` ran a campaign with M.O.M, so they
 * are a company spending money on influencer placement — which is exactly who Digital
 * Sukoon's network is for. This walks every CAMPAIGN caption, resolves its @mentions,
 * and creates a `TargetAccount{kind:'BRAND'}` for each one that is actually a business.
 *
 * THREE RULES IT WILL NOT BREAK
 *
 * 1. **A NEW BRAND IS A LIVE ROUTE NOW, and this used to say the opposite.** Until
 *    2026-08-08 pairs were created DISABLED and a person flipped a chip per route, so
 *    "adding is never sending" was true of this command. The per-route switch is gone
 *    (Tabish's one-switch decision) and nothing reads `OutreachPair.enabled`, so a pair row
 *    IS a route the planner will act on. What stops a discovered brand being messaged
 *    immediately is the ordinary chain — autopilot, the account's own auto-send, a live
 *    session, pacing, the new-brand daily cap — and NOT anything about how the row was
 *    created. Creation still routes through `routeAllowed` (`brandTarget.ts`), which is what
 *    keeps our own pages out of it.
 * 2. **Never guess a handle.** Only real @mentions from the caption are resolved.
 *    A bare name like "RoyalCanin" is not turned into `@royalcanin` — that handle
 *    returns HTTP 404, measured, and messaging the wrong account is worse than
 *    messaging nobody.
 * 3. **Deduplication is free.** `TargetAccount.handle` is unique, so a brand appearing
 *    on both channels resolves to the SAME row and the existing cooldown, reply-halt
 *    and opt-out rules cover it with no new logic.
 *
 * DRY RUN IS THE DEFAULT because this writes prospects into the outreach database and
 * spends a scarce, heavily rate-limited endpoint.
 */

const argv = process.argv.slice(2)
const isRun = argv.includes('--run')
const isStuck = argv.includes('--stuck')
const limArg = argv[argv.indexOf('--limit') + 1]
const limit = argv.includes('--limit') && limArg ? Math.max(1, parseInt(limArg, 10) || 0) : null

/**
 * `--reset @a @b` — the handles whose model verdict is to be thrown away.
 *
 * Every argument after the flag that is not another flag, so `--reset crocs titaneyeplus --run`
 * reads as two handles. Handles are normalised the way `BrandLookup.handle` is stored
 * (lowercased, no leading @) and never guessed at: a handle that is not already a row is
 * REPORTED, not created.
 */
const resetHandles = argv.includes('--reset')
  ? argv
      .slice(argv.indexOf('--reset') + 1)
      .filter((a) => !a.startsWith('--'))
      .map((a) => a.replace(/^@/, '').toLowerCase())
      .filter((a) => a !== '')
  : []
const isReset = argv.includes('--reset')

/**
 * ── THE ONE-OFF BACKFILL: HANDLES CACHED BEFORE THE MODEL EXISTED ─────────
 *
 * MEASURED on the live Postgres 2026-08-11: 30 `BrandLookup` rows with `kind = 'UNRESOLVED'`,
 * every one `checkedAt` on 2026-08-06 and every one with nothing from the model — @adidas,
 * @kfcindia, @nutella, @lux, @titaneyeplus, @rungtasteel, @uspoloassnindia, @bonkerscorner.
 * They were cached DAYS BEFORE `decideBrand` shipped, and `resolveBrand`'s cache-hit path
 * returned before the model could see them, so the founding case of the whole feature was
 * structurally unreachable.
 *
 * `resolveBrand` now offers such a row to the model once, so ordinary operation will drain
 * these AS THEY ARE MENTIONED AGAIN in a fresh caption. This mode exists because that is not
 * the same as draining them: a brand whose campaign has scrolled out of the window may never
 * be mentioned again, and the row would sit stuck forever with nothing on screen saying why.
 *
 * IT NEVER GUESSES A HANDLE. Every handle comes from a row already in `BrandLookup`, which is
 * to say from an @mention a real caption already carried — the same rule as `ig:brands`
 * itself, and the reason a bare name is never turned into a handle.
 *
 * The endpoint is NOT re-asked: we already know what it says, and that is what makes this
 * cheaper than a fresh resolve. What it spends is one anonymous `enrichHandle` request and one
 * DeepSeek call per handle.
 */
async function runStuck(): Promise<void> {
  /**
   * Only UNRESOLVED, and only rows the model has never been offered. The `decidedBy` filter is
   * the whole point: a row the model already declined must not be re-asked the same question
   * about the same evidence, which is what would burn a budget for nothing.
   *
   * ── THE NULL TRAP, FOUND BY RUNNING IT ────────────────────────────────────
   *
   * This was `decidedBy: { notIn: ['model', 'model-declined'] }` and it selected **NOTHING**.
   * In SQL `NULL NOT IN (...)` evaluates to NULL, not true, so every row with a null
   * `decidedBy` was filtered OUT — which is EVERY ONE of the 30 stuck rows, the entire
   * population this command exists to drain. It would have printed "Nothing stuck. Every
   * UNRESOLVED handle has been offered to the model." and exited 0, which is the most
   * expensive possible failure here: a confident all-clear about a backlog nobody had touched.
   *
   * `null` must therefore be named explicitly. Caught by `tests/brands-stuck-backfill.test.ts`
   * asserting the SQL and `modelHasRun` agree for every value either can see — a test written
   * because two expressions of one rule is this repo's most-repeated defect, and it earned its
   * place on the first run.
   */
  const rows = await prisma.brandLookup.findMany({
    where: {
      kind: 'UNRESOLVED',
      OR: [{ decidedBy: null }, { decidedBy: { notIn: ['model', 'model-declined'] } }],
    },
    orderBy: { handle: 'asc' },
    ...(limit ? { take: limit } : {}),
  })
  /**
   * Re-tested with `modelHasRun`, which is the RULE OF RECORD. The query above is an
   * optimisation over it, not a second definition — and the test asserts they cannot disagree.
   */
  const stuck = rows.filter((r) => !modelHasRun(r))

  const total = await prisma.brandLookup.count({ where: { kind: 'UNRESOLVED' } })

  console.log(
    isRun
      ? `\n  OFFERING THE BACKLOG TO THE MODEL — a confident answer creates a LIVE prospect.\n`
      : `\n  Dry run. Nothing asked, nothing created, nothing spent.\n`,
  )
  console.log(`  ${total} UNRESOLVED row(s) in total; ${stuck.length} the model has never seen.`)
  if (limit) console.log(`  Bounded to ${limit} by --limit.`)

  if (stuck.length === 0) {
    console.log(`\n  Nothing stuck. Every UNRESOLVED handle has been offered to the model.\n`)
    return
  }

  /**
   * WHAT IT WOULD COST, BEFORE ANY OF IT IS SPENT. Measured per-call figures for this model
   * and prompt: $0.000045-$0.000138 a message on the generation path, and this prompt is
   * shorter. Printed as a bound rather than a promise, because the honest number is the one
   * after the run — which is why the real token split is reported below.
   */
  console.log(`\n  ${stuck.length} handle(s) would reach the model, at ~$0.00003 each:`)
  for (const r of stuck) {
    console.log(`  @${r.handle.padEnd(30)} ${r.enrichment ?? '(nothing gathered yet)'}`)
  }
  console.log(`\n  Estimated model spend: ~$${(stuck.length * 0.00003).toFixed(5)}`)
  console.log(`  Plus one anonymous Instagram request each (enrichment). The category`)
  console.log(`  endpoint is NOT re-asked — we already know what it says.`)

  if (!isRun) {
    console.log(`\n  Re-run with --stuck --run to offer them to the model.\n`)
    return
  }

  // A person typed the command and is watching, exactly as for the main path.
  resetBrandResolverLimit()

  const before = await modelSpend()
  let becameBrand = 0
  let becamePerson = 0
  let stillUnresolved = 0

  for (const r of stuck) {
    /**
     * The SAME `resolveBrand` the pipeline calls, reached through the same cached-UNRESOLVED
     * fall-through. Not a private copy of the decision — one rule, and this is a second
     * caller of it rather than a second implementation. `ig:classify` and `scripts/ocr.ts`
     * both shipped their own copies of a judging path here and both were wrong.
     *
     * No caption: these rows are cached, and the caption they came from is not recorded on
     * the lookup. The model gets the enrichment facts and its own world knowledge, which is
     * what settles a famous handle like @adidas. Deliberately not reconstructed by guessing
     * which campaign mentioned it.
     */
    const verdict = await resolveBrand(r.handle)

    if (verdict.kind === 'BRAND') {
      becameBrand++
      /**
       * A prospect needs a discovering campaign to pitch from, and these rows do not carry
       * one. Rather than invent a placement — `brandPitch` names a REAL post we saw, and a
       * wrong one is an invented claim about the recipient's own marketing — the target is
       * left uncreated and reported. The lookup row now says BRAND, so the next caption that
       * mentions the handle creates it with a real campaign attached.
       */
      console.log(`  + @${r.handle.padEnd(28)} company — recorded, awaiting a campaign to pitch from`)
      continue
    }
    if (verdict.kind === 'PERSON') {
      becamePerson++
      console.log(`  - @${r.handle.padEnd(28)} not a prospect`)
      continue
    }
    stillUnresolved++
    console.log(`  ? @${r.handle.padEnd(28)} still undecided`)
  }

  const after = await modelSpend()
  console.log(`\n  company ${becameBrand} · not-a-prospect ${becamePerson} · still undecided ${stillUnresolved}`)
  /**
   * NO PROSPECT IS CREATED BY THIS MODE, and saying so is the point. `brandPitch` names a
   * REAL paid post as the reason for writing, and a cached lookup row does not carry the
   * campaign it came from — so creating a target here would either invent a placement or
   * produce a prospect with nothing to pitch. The verdict is recorded; the next caption that
   * mentions the handle creates the target with a real campaign attached.
   */
  if (becameBrand > 0) {
    console.log(`  ${becameBrand} recorded as companies. No prospect was created — see the note in this file:`)
    console.log(`  a pitch names a real paid post, and these rows do not carry one.`)
  }
  console.log(
    `  model calls ${after.calls - before.calls} · cached-in ${after.cachedIn - before.cachedIn} tokens · ` +
      `fresh-in ${after.freshIn - before.freshIn} · out ${after.out - before.out}`,
  )
  console.log(`  actual spend: $${(after.cost - before.cost).toFixed(6)}`)
  if (after.failed > before.failed) {
    console.log(`  ${after.failed - before.failed} call(s) FAILED and decided nothing — those rows stay retryable.`)
  }
  console.log('')
}

/**
 * ── UNDOING A CONFABULATED VERDICT ────────────────────────────────────────
 *
 * MEASURED 2026-08-11, reading the `--stuck` run's real output: two of 23 verdicts answered
 * about a DIFFERENT ACCOUNT than the one asked about —
 *
 *   @crocs        → person 95%  "instylemagazine is a publisher/media page, not a buyer"
 *   @titaneyeplus → person 95%  "Vikas Khanna is a famous Indian chef and author"
 *
 * Crocs is the footwear company and Titan Eye+ the eyewear retailer, so both are real
 * prospects filed as not-a-prospect at a confidence ABOVE the floor. `decideBrand` now
 * catches this shape mechanically (`reasonSubject.ts`) and the prompt forbids it, but
 * neither fix reaches a row already written: `modelHasRun` is true for them, which is
 * exactly what stops `--stuck` re-asking, and PERSON is a cached answer nothing retries.
 *
 * So the rows must be cleared by hand, once. This is that command, and it is deliberately
 * NOT automatic: "re-ask every PERSON verdict" would re-spend on 12 correct ones and, worse,
 * is the shape that turns one bad answer into an unbounded re-classification loop. A person
 * names the handles they have read and decided are wrong.
 *
 * WHAT IT CLEARS, and why each field: `kind` back to UNRESOLVED (the honest "we do not
 * know"), and `decidedBy`/`modelConfidence`/`modelReason` all to null so `modelHasRun`
 * reports FALSE and the row becomes eligible for `--stuck` again. Clearing `kind` alone
 * would leave the row permanently ineligible to be re-asked — the null trap that made the
 * first version of `--stuck` select nothing, arriving from the other direction.
 *
 * `enrichment` is deliberately KEPT: it is a fact gathered from Instagram, not a model
 * opinion, and both these rows had none anyway ("nothing gathered yet") — which is the
 * thin-evidence condition that produced the confabulation in the first place.
 */
async function runReset(): Promise<void> {
  console.log(
    isRun
      ? `\n  RESETTING FOR REAL — these rows become UNRESOLVED and re-askable.\n`
      : `\n  Dry run. Nothing written.\n`,
  )

  if (resetHandles.length === 0) {
    console.log(`  No handles given. Usage: pnpm ig:brands --reset crocs titaneyeplus [--run]\n`)
    process.exitCode = 1
    return
  }

  const rows = await prisma.brandLookup.findMany({ where: { handle: { in: resetHandles } } })
  const missing = resetHandles.filter((h) => !rows.some((r) => r.handle === h))

  console.log(`  ${resetHandles.length} handle(s) named; ${rows.length} found in BrandLookup.\n`)
  for (const r of rows) {
    console.log(`  @${r.handle}`)
    console.log(`     now:  kind=${r.kind} decidedBy=${r.decidedBy ?? 'null'} confidence=${r.modelConfidence ?? 'null'}`)
    console.log(`     said: ${r.modelReason ?? '(nothing recorded)'}`)
    console.log(`     after: kind=UNRESOLVED, model verdict cleared — re-askable by --stuck`)
  }
  /**
   * A named handle with no row is reported and never created. Same rule as the rest of this
   * command: only handles a real caption already carried exist here, and inventing one would
   * be the "never guess a handle" violation that HTTP 404 measured.
   */
  if (missing.length > 0) {
    console.log(`\n  NOT FOUND, nothing to reset (and nothing created): ${missing.map((h) => '@' + h).join(' ')}`)
  }

  if (!isRun) {
    console.log(`\n  Re-run with --run to write it.\n`)
    return
  }
  if (rows.length === 0) {
    console.log(`\n  Nothing to do.\n`)
    return
  }

  const { count } = await prisma.brandLookup.updateMany({
    where: { handle: { in: rows.map((r) => r.handle) } },
    data: { kind: 'UNRESOLVED', decidedBy: null, modelConfidence: null, modelReason: null },
  })

  console.log(`\n  ${count} row(s) reset.`)
  console.log(`  Next: pnpm ig:brands --stuck        to see them queued`)
  console.log(`        pnpm ig:brands --stuck --run  to re-ask the model, now guarded\n`)
}

/**
 * The real token split, read from `ModelCall` — which `decideBrand` already writes on every
 * call, success or failure. Read before and after so the figure is THIS run's, not the
 * lifetime total: a cost line that silently reports every call ever made is worse than none,
 * because it reads as headroom.
 */
async function modelSpend(): Promise<{
  calls: number
  cachedIn: number
  freshIn: number
  out: number
  failed: number
  cost: number
}> {
  const rows = await prisma.modelCall.findMany({ where: { purpose: 'resolve' } })
  return {
    calls: rows.length,
    cachedIn: rows.reduce((n, r) => n + r.cachedInputTokens, 0),
    freshIn: rows.reduce((n, r) => n + r.inputTokens, 0),
    out: rows.reduce((n, r) => n + r.outputTokens, 0),
    failed: rows.filter((r) => !r.ok).length,
    /**
     * `costUsd` as STORED, never re-derived. `lib/modelCall.ts` prices by model in one place
     * precisely because the prices were once a bare expression inside `scripts/classify.ts`
     * and every other caller either recomputed them or reported nothing — and a second copy
     * here would misprice every call the day a second provider is added.
     */
    cost: rows.reduce((n, r) => n + r.costUsd, 0),
  }
}

async function main(): Promise<void> {
  if (isReset) return runReset()
  if (isStuck) return runStuck()

  const campaigns = await prisma.detectedCampaign.findMany({
    where: { verdict: 'CAMPAIGN' },
    include: { target: true },
    orderBy: { postedAt: 'desc' },
    ...(limit ? { take: limit } : {}),
  })

  console.log(
    isRun
      ? `\n  RESOLVING FOR REAL — creates brand targets, and their routes are LIVE.\n`
      : `\n  Dry run. Nothing resolved, nothing created.\n`,
  )
  console.log(`  ${campaigns.length} campaign post(s) to walk\n`)

  if (!isRun) {
    // Show the raw material without touching the network.
    const neverAProspect = await excludedHandles()
    const seen = new Set<string>()
    const bySource = { mention: 0, tag: 0 }
    for (const c of campaigns) {
      const cands = brandCandidatesFor(c, neverAProspect)
      if (cands.length === 0) continue
      for (const m of cands) {
        if (!seen.has(m.handle)) bySource[m.source]++
        seen.add(m.handle)
      }
      console.log(`  @${c.target.handle} · ${c.shortcode}`)
      console.log(`     ${cands.map((m) => (m.source === 'tag' ? `@${m.handle} [tag]` : '@' + m.handle)).join(' ')}`)
    }
    const known = await prisma.brandLookup.findMany({ where: { handle: { in: [...seen] } } })
    const unresolved = [...seen].filter((h) => !known.some((k) => k.handle === h && k.kind !== 'UNKNOWN'))
    /**
     * The two sources are counted separately because they are not equally good evidence and
     * the bound is a LOOKUP budget. A run whose new candidates are nearly all tags is
     * spending the scarce endpoint on accounts Instagram merely says appear in the media —
     * true of the celebrity as often as the advertiser.
     */
    console.log(`\n  ${seen.size} distinct candidate(s): ${bySource.mention} from captions, ${bySource.tag} from media tags.`)
    console.log(`  ${unresolved.length} need a profile lookup.`)
    console.log(`  At ~6s each that is about ${Math.ceil((unresolved.length * 6) / 60)} minute(s).`)
    console.log(`  Re-run with --run to resolve them.\n`)
    return
  }

  /**
   * A PERSON TYPING A COMMAND HAS DECIDED TO TRY, so the back-off starts clear.
   *
   * `resolveBrand` backs off for 30 minutes after a real 429/401/403 (see
   * `RATE_LIMIT_COOLDOWN_MS`). That is the right default for the unattended 15-minute pass,
   * which has no way to know whether anything has changed. This command is the opposite
   * case: someone is present, is watching the output, and can stop it — the same judgement
   * the on-demand send dialog is built around. Note it is only cleared on `--run`; a dry run
   * makes no requests and has nothing to clear.
   *
   * This is also the CALLER that `resetBrandResolverLimit` spent its whole existence without.
   * A reset nobody can trigger is not a reset, and the boolean it used to clear disabled
   * brand discovery for two hours in production precisely because nothing ever called it.
   */
  resetBrandResolverLimit()

  let brands = 0
  let people = 0
  let talent = 0
  const settings = await getSettings()
  let missing = 0
  let unknown = 0
  let unresolved = 0
  let created = 0

  const neverAProspect = await excludedHandles()

  for (const c of campaigns) {
    /**
     * ── TAGS, NOT JUST CAPTION MENTIONS (2026-08-17) ─────────────────────────
     *
     * This loop used to `continue` when the caption carried no @mention, which is **51% of
     * in-window CAMPAIGN posts** — and exactly the half the tag source was added for on
     * 17 August. Because `taggedHandlesIn` had been wired into `autoResolveBrands` alone,
     * and that pass is 429'd on the Linode on its first lookup of every pass, the feature
     * was reachable from NEITHER path in production.
     *
     * `brandCandidatesFor` is now the one definition, shared with that pass, so a mention
     * still outranks a tag and our own pages are excluded before a lookup is spent.
     */
    const candidates = brandCandidatesFor(c, neverAProspect)
    if (candidates.length === 0) continue
    const verdicts = await resolveBrandsForHandles(
      candidates.map((x) => x.handle),
      { caption: c.caption ?? '' },
    )

    for (const v of verdicts) {
      if (v.kind === 'PERSON') {
        /**
         * The talent bar (Tabish, 2026-08-19): a verified or truly-big person tagged on a
         * CAMPAIGN post is a deliberate recipient, created with `campaignTalent` so the
         * person guard admits exactly these rows and no others. Same rule as the
         * automatic pass (autoResolve.ts) — one bar, two callers.
         */
        if (isRun && admitsAsTalent({ isVerified: v.isVerified ?? null, followerCount: v.followers ?? null }, settings.celebrityMinFollowers)) {
          const outcome = await createBrandTarget(
            { kind: 'BRAND', handle: v.handle, displayName: v.displayName ?? v.handle, category: v.category, followers: v.followers ?? null },
            { id: c.id, shortcode: c.shortcode },
            'brand.discovered',
            'cli:brands-talent',
            { campaignTalent: true, isVerified: v.isVerified ?? null, followerCount: v.followers ?? null },
          )
          if (outcome === 'created') {
            talent++
            console.log(`  TALENT ADMITTED  @${v.handle} (${v.category ?? 'person'}, verified=${v.isVerified ?? '?'}, followers=${v.followers ?? '?'})`)
            continue
          }
        }
        people++
        continue
      }
      if (v.kind === 'MISSING') {
        missing++
        continue
      }
      if (v.kind === 'UNKNOWN') {
        unknown++
        continue
      }
      if (v.kind === 'UNRESOLVED') {
        unresolved++
        continue
      }

      brands++

      /**
       * ONE CREATOR, TWO CALLERS. `createBrandTarget` is shared with the automatic
       * post-detection resolver (`src/detection/autoResolve.ts`), so the checks that make a
       * new prospect safe — never one of our own senders, routes through `routeAllowed`,
       * `watchEnabled: false` — cannot differ between the command a person runs and the pass
       * that runs unattended. That divergence is the failure this repo has recorded five
       * times; see the docblock in brandTarget.ts.
       */
      const outcome = await createBrandTarget(
        v,
        { id: c.id, shortcode: c.shortcode, channelHandle: c.target.handle },
        'brand.discovered',
        'ig:brands',
      )
      if (outcome !== 'created') continue

      created++
      console.log(`  + @${v.handle.padEnd(28)} ${v.category ?? '(no category)'}  ${v.followers ?? '?'} followers`)
    }
  }

  console.log(
    `\n  brands ${brands} · people ${people} · talent admitted ${talent} · missing ${missing} · needs-a-human ${unresolved} · not-yet-looked ${unknown}`,
  )
  console.log(`  new brand targets created: ${created} (their routes are live — see the header)`)
  if (unresolved > 0) {
    console.log(`\n  ${unresolved} account(s) have no category and are not marked as a business.`)
    console.log(`  Retrying will not help — the data is not there. A human must decide.`)
  }
  if (unknown > 0) {
    console.log(`\n  ${unknown} lookup(s) were rate-limited before they could be read. Cached as`)
    console.log(`  UNKNOWN and retried next run — NEVER treated as "not a brand".`)
  }
  console.log('')
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
