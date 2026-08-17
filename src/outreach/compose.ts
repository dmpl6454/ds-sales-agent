import { prisma } from '@/lib/db'
import { DELIVERED_STATUSES, IN_FLIGHT_STATUSES } from '@/lib/constants'
import { newMaterialFloor } from '@/lib/cutoff'
import { readStringArray } from '@/lib/json'
import { log } from '@/lib/logger'
import { getSettings } from '@/lib/settings'
import { generateMessageBody } from './generate'
import { brandFirstTouch, publisherDisplayName, describeRecency } from './brandPitch'
import { greetableName, renderMessage } from './render'

/**
 * Choosing WHAT to say to one pair — the single implementation.
 *
 * Two callers need this and they are not allowed to disagree: `plan.ts` (the scheduled
 * planner) and `onDemand.ts` ("send a message now"). They HAD disagreed, in three ways,
 * all introduced in one session by changing the planner and not the second caller:
 *
 *   variant pool     plan.ts scoped the LRU by `targetKind`; onDemand.ts did not, so it
 *                    could hand a MEDIA-BUYING body to a publisher and a
 *                    publisher-partnership body to a brand. Nothing reports that — the
 *                    message is simply addressed to the wrong kind of reader, and it is
 *                    only ever discovered by reading a sent DM.
 *   campaign floor   plan.ts used `newMaterialFloor()` (the LATER of the hook window and
 *                    the 1 August cutoff); onDemand.ts used `hoursAgo(hookMaxAgeHours)`
 *                    alone. Measured: at HOOK_MAX_AGE_HOURS=72 the hook window reaches
 *                    SIX AND A HALF HOURS further back than the cutoff, so on-demand
 *                    offered pre-cutoff campaigns the planner refuses.
 *   brand first touch  plan.ts opens a brand's first message by naming the placement we
 *                    actually saw; onDemand.ts had no equivalent and fell through to a
 *                    generic variant.
 *
 * This is CLAUDE.md's "one gate, two callers, never re-inline it" — the same shape as the
 * `deliverWaiting` / `sendNow` drift that produced `gate.ts`, committed one session after
 * that lesson was written down. The fix is not to correct the three, it is to remove the
 * place a fourth can appear.
 *
 * Kept separate from `gate.ts` and `governor.ts` on purpose: those decide WHETHER to
 * write, this decides WHAT to write. Mixing them would put a database read inside a pure
 * safety function.
 */

/** The parts of a pair this module needs. Structural, so both callers' rows satisfy it. */
export interface ComposablePair {
  id: string
  senderId: string
  targetId: string
  bespokeBody: string | null
  sender: Parameters<typeof renderMessage>[0]['persona']
  target: {
    handle: string
    displayName: string
    contactFirstName: string | null
    kind: string
    discoveredFromCampaignId: string | null
  }
}

export interface Composed {
  body: string
  hookLine: string | null
  variantId: string
  campaignId: string | null
  /** True when the first-touch body was used rather than a rotating variant. */
  usedBespoke: boolean
  /** True when a MODEL wrote this body and the quality gate passed it (Phase 8). */
  generated: boolean
}

/**
 * Campaigns this pair has already written about.
 *
 * SKIPPED and FAILED are excluded deliberately. "Used" must mean *the recipient has seen
 * it* — a draft that was discarded or never delivered referenced nothing. Counting those
 * burned a campaign every time a draft was regenerated, so four discards exhausted the
 * pool and the pair fell through to `no-new-material` with four good campaigns sitting
 * there unused.
 */
export async function usedCampaignIds(pairId: string): Promise<string[]> {
  const rows = await prisma.outreachAttempt.findMany({
    where: { pairId, campaignId: { not: null }, status: { in: [...IN_FLIGHT_STATUSES] } },
    select: { campaignId: true },
  })
  return rows.map((r) => r.campaignId).filter((id): id is string => id !== null)
}

/**
 * How many campaigns are left that this pair has not used — the governor's new-material
 * input, and the count that must agree with `pickHook` below.
 *
 * The count and the lookup are two halves of one question ("is there new material?" and
 * "which piece of it?"). This codebase has been bitten twice by exactly these two queries
 * drifting, so they now share a floor, a status filter and a file.
 */
export async function unusedCampaignCount(args: {
  targetId: string
  pairId: string
  now?: Date
}): Promise<number> {
  const { targetId, pairId, now = new Date() } = args
  return prisma.detectedCampaign.count({
    where: {
      targetId,
      verdict: 'CAMPAIGN',
      postedAt: { gte: newMaterialFloor(now) },
      id: { notIn: await usedCampaignIds(pairId) },
    },
  })
}

/** The freshest campaign this pair has not written about yet, or null. */
async function pickHook(args: { targetId: string; pairId: string; now: Date }) {
  return prisma.detectedCampaign.findFirst({
    where: {
      targetId: args.targetId,
      verdict: 'CAMPAIGN',
      postedAt: { gte: newMaterialFloor(args.now) },
      id: { notIn: await usedCampaignIds(args.pairId) },
    },
    orderBy: [{ postedAt: 'desc' }, { detectedAt: 'desc' }],
  })
}

/**
 * The FIRST message to a brand, built from the campaign it was discovered in.
 *
 * Never fabricates a placement: with no known campaign, `brandFirstTouch` degrades to a
 * general observation. A missing hook costs specificity; it never invents a claim about
 * someone else's marketing.
 */
async function buildBrandFirstTouch(target: ComposablePair['target']): Promise<string> {
  if (!target.discoveredFromCampaignId) {
    return brandFirstTouch({
      brandName: greetableName(target.displayName),
      handle: target.handle,
      publisherName: null,
      postedAt: null,
      now: new Date(),
    })
  }
  const campaign = await prisma.detectedCampaign.findUnique({
    where: { id: target.discoveredFromCampaignId },
    select: { postedAt: true, target: { select: { handle: true } } },
  })
  return brandFirstTouch({
    // greetableName, not displayName: "Milano Ice Cream, Bangalore" must not appear
    // mid-sentence any more than it may appear in the greeting.
    brandName: greetableName(target.displayName),
    // The handle goes WITH the name so `brandFirstTouch` can check one against the other
    // itself. 21 of 68 live BRAND rows store their handle as the display name.
    handle: target.handle,
    publisherName: publisherDisplayName(campaign?.target.handle),
    postedAt: campaign?.postedAt ?? null,
    now: new Date(),
  })
}

/** Thrown when the sender has no variants in the pool this target needs. */
export class NoVariantsError extends Error {
  constructor(readonly senderHandle: string, readonly targetKind: string) {
    super(`sender @${senderHandle} has no enabled ${targetKind} message variants — run: pnpm db:seed`)
    this.name = 'NoVariantsError'
  }
}

/**
 * Thrown when every variant in the pool has already been used ON THIS PAIR.
 *
 * A separate error from `NoVariantsError` because the two have opposite fixes: that one
 * means the seed never ran, this one means this conversation has said everything the pool
 * can say. Collapsing them would send someone to `pnpm db:seed` for a pair that has simply
 * run out of things to say.
 *
 * Refusing is the conservative direction and it is very nearly unreachable: the CHANNEL
 * pool is 12 and the BRAND pool 6, while `maxUnansweredTouches` is 3 and the deepest pair
 * in the live database holds 4 in-flight attempts. Reaching this needs a long, engaged,
 * human-supervised conversation — which is exactly when a person should choose the next
 * message rather than the LRU wrapping around to one already sent.
 */
export class VariantsExhaustedError extends Error {
  constructor(
    readonly senderHandle: string,
    readonly targetHandle: string,
    readonly poolSize: number,
  ) {
    super(
      `@${senderHandle} has used all ${poolSize} of its message variants on @${targetHandle} — ` +
        `a follow-up would repeat one of them word for word`,
    )
    this.name = 'VariantsExhaustedError'
  }
}

/**
 * Variants this PAIR has already been sent, so a follow-up cannot repeat one.
 *
 * Mirrors `usedCampaignIds` exactly, including the status filter, and for the same reason:
 * "used" must mean *this conversation has already carried it*. SKIPPED and FAILED are
 * excluded so regenerating a draft does not burn a variant — the bug that comment records
 * for campaigns, where four discards exhausted the pool and the pair fell through to
 * `no-new-material` with good campaigns sitting unused.
 */
async function usedVariantIds(pairId: string): Promise<string[]> {
  const rows = await prisma.outreachAttempt.findMany({
    where: { pairId, status: { in: [...IN_FLIGHT_STATUSES] } },
    select: { variantId: true },
  })
  return rows.map((r) => r.variantId)
}

export async function composeForPair(args: {
  pair: ComposablePair
  senderHandle: string
  touchNumber: number
  now?: Date
}): Promise<Composed> {
  const { pair, senderHandle, touchNumber, now = new Date() } = args
  const settings = await getSettings()

  const hook = await pickHook({ targetId: pair.targetId, pairId: pair.id, now })

  /**
   * Least-recently-used variant, SCOPED TO THE POOL THIS TARGET BELONGS TO, and never one
   * this pair has already been sent.
   *
   * `targetKind` is load-bearing rather than tidy. Variants are keyed on `senderId`, so
   * without it the channel pool and the brand pool are ONE pool.
   *
   * ── WHY THE PER-PAIR EXCLUSION, ADDED 2026-08-05 ────────────────────────
   *
   * The LRU is scoped to the SENDER, so it says nothing about which bodies a particular
   * RECIPIENT has already read. Nothing looked at the pair. MEASURED against the live
   * database: **8 of 11 pairs had already been handed the same variant more than once**,
   * one of them five times. A sender's pool of 12 is shared across its 7-9 pairs, so the
   * ring wraps after 12 messages to ANY target and comes back round to a body this pair
   * already has.
   *
   * That is decision 3 — *every message written from scratch per recipient*, follow-ups
   * using "a fresh variant plus a campaign not referenced before" — stated in CLAUDE.md and
   * enforced for the campaign half only. Meta's written spam policy penalises REPETITION,
   * which makes the missing half the one that matters: a fresh hook line stapled to a body
   * the recipient has already read is the repetition the rule exists to prevent.
   *
   * It also weaponised a shared needle. Two messages built from one variant carry the same
   * `distinctiveSlice`, and the post-send thread confirmation used to be satisfied by ANY
   * occurrence — including the earlier bubble. `bodyAppearedSince` now fixes that guard
   * independently, and both halves ship together on purpose: the guard must not depend on
   * variant selection being right, and selection must not depend on the guard catching it.
   */
  const pool = await prisma.messageVariant.findMany({
    where: { senderId: pair.senderId, enabled: true, targetKind: pair.target.kind },
    orderBy: [{ lastUsedAt: { sort: 'asc', nulls: 'first' } }, { timesUsed: 'asc' }],
  })
  if (pool.length === 0) throw new NoVariantsError(senderHandle, pair.target.kind)

  const alreadySent = new Set(await usedVariantIds(pair.id))
  const variant = pool.find((v) => !alreadySent.has(v.id))
  if (!variant) throw new VariantsExhaustedError(senderHandle, pair.target.handle, pool.length)

  /**
   * ── STEP 10: THE SINGLE TEMPLATE, behind a flag, OFF BY DEFAULT ───────────
   *
   * Tabish asked for "no super custom messages". One template, one variable line — the
   * paid post we actually saw — replacing the bespoke bodies and both variant pools.
   * Turning it on partially reverses decision 3 (Meta penalises repetition; merge-field
   * templates do not count as variation), which is why the flag defaults off and the
   * decision is his to record. See the `singleTemplate` note in `lib/settings.ts`.
   *
   * The VARIANT IS STILL CLAIMED, exactly as Phase 8 does for generated bodies: the
   * per-pair exclusion keeps advancing, so `VariantsExhaustedError` still bounds how many
   * times one recipient can be written to, and the send guards keep a distinct needle
   * per touch (the hook line is the only part that varies, and the new-material rule
   * already guarantees a fresh campaign per touch).
   *
   * For a BRAND the variable line names the placement we discovered them in, built by
   * the same rules `brandPitch.ts` uses — a real publisher name or nothing, recency
   * banded, never a guess. For a CHANNEL it is the ordinary hook line. No observation
   * means the line is OMITTED, never invented.
   */
  if (settings.singleTemplate) {
    /**
     * NO HOOK LINE AND NO OBSERVATION LINE (2026-08-17). *"The custom part must only be the
     * target name being mentioned."* Both of those are extra custom sentences about the
     * recipient, so both are gone: `hook: null` rather than passing `hook` through.
     *
     * This also retires a claim that was never true. The old comment here said the variable
     * line "keeps the send guards working … a body byte-identical across touches would break
     * `distinctiveSlice` / `bodyAppearedSince`". MEASURED: the hook line matches
     * `ENVELOPE_PATTERNS`, so `proseLines` strips it and it could never have been the needle;
     * and `bodyAppearedSince` is an occurrence-count DELTA, which an identical body satisfies
     * correctly. The guards depend on the template having two prose paragraphs, nothing more.
     */
    const { body } = renderMessage({
      persona: pair.sender,
      target: pair.target,
      variantBody: SINGLE_TEMPLATE_MIDDLE,
      hook: null,
    })
    return {
      body,
      hookLine: null,
      variantId: variant.id,
      /**
       * The campaign is still RECORDED even though the body never mentions it. It is what
       * `unusedCampaignCount` and the new-material rule are derived from, and dropping it
       * here would quietly let one recipient be written to about nothing new.
       */
      campaignId: hook?.id ?? null,
      usedBespoke: false,
      generated: false,
    }
  }

  /**
   * The FIRST message is bespoke; a follow-up must say something new.
   *
   * For a BRAND the first touch is generated from the campaign it was discovered in. For
   * a CHANNEL it comes from `pair.bespokeBody`, hand-written in prisma/bespoke.ts. Either
   * way a follow-up uses a fresh variant plus a campaign not referenced before: reusing
   * the bespoke body would be the exact repetition this guards against.
   */
  const brandFirst = touchNumber === 1 && pair.target.kind === 'BRAND' ? await buildBrandFirstTouch(pair.target) : null
  const usedBespoke =
    brandFirst !== null || (touchNumber === 1 && Boolean(pair.bespokeBody && pair.bespokeBody.trim().length > 0))

  /**
   * ── PHASE 8: a model may write the FOLLOW-UP body ─────────────────────────
   *
   * Off unless `generateMessages` is on, and then only for a body that would otherwise be a
   * pooled variant. A FIRST touch is never generated: the bespoke channel bodies are
   * hand-written per recipient and `brandPitch` names a placement we actually observed, and
   * both are better than anything a model can produce from a handle and a display name.
   *
   * FAILURE FALLS BACK, ALWAYS. No key, a network error, or a body the quality gate refuses
   * all leave `generated` null and this takes `variant.body` — the exact behaviour of the day
   * before Phase 8. There is deliberately no path where a refused body is sent anyway.
   *
   * The variant is still CLAIMED even when generation succeeds, so `variantId` stays populated
   * and the per-pair exclusion keeps advancing. Otherwise a run of generated follow-ups would
   * leave the pool untouched, and the first fallback after them would hand out a body whose
   * needle is already spoken for.
   */
  let generatedBody: string | null = null
  if (settings.generateMessages && !usedBespoke) {
    const priorBodies = (
      await prisma.outreachAttempt.findMany({
        where: { pairId: pair.id, status: { in: [...DELIVERED_STATUSES] } },
        select: { renderedBody: true },
      })
    ).map((a) => a.renderedBody)

    const result = await generateMessageBody({
      persona: pair.sender,
      target: pair.target,
      targetKind: pair.target.kind,
      /**
       * Only something we actually observed, never a guess. Null means the model is told to
       * reference nothing, which `generate.ts` states explicitly.
       *
       * For a BRAND the hook is always null — `pickHook` queries campaigns by the RECIPIENT's
       * targetId and brands are never scraped — so without the second clause every brand
       * message was generated with no grounding at all, and the model filled the gap by
       * inventing one. We DO know why a brand is a prospect: `discoveredFromCampaignId` is the
       * paid post we found it in, which is exactly what `brandPitch` uses for a first touch.
       */
      observation: await observationFor(pair.target, hook),
      priorBodies,
    })
    if (result.generated && result.verdict?.ok) generatedBody = result.generated
    else if (result.failure) {
      log.warn('generated body not used — falling back to a hand-written variant', {
        target: pair.target.handle,
        reason: result.failure,
      })
    }
  }

  const { body, hookLine } = renderMessage({
    persona: pair.sender,
    target: pair.target,
    variantBody: brandFirst ?? (usedBespoke ? pair.bespokeBody! : (generatedBody ?? variant.body)),
    // A bespoke draft already references the recipient's actual work, so bolting a
    // generated hook line on top would read as two openings stapled together. A GENERATED
    // body has the observation woven into its prose for the same reason.
    hook: usedBespoke || generatedBody !== null ? null : hook,
  })

  return {
    body,
    hookLine,
    variantId: variant.id,
    campaignId: hook?.id ?? null,
    usedBespoke,
    generated: generatedBody !== null,
  }
}

/**
 * The one fact about a detected campaign the model is allowed to reference, in plain words.
 *
 * Deliberately vague about time and specific about nothing else. `buildHookLine` bands
 * recency ("last week", "recently") rather than dating it, because a precise date reads as
 * surveillance and is embarrassing when the timestamp is off by a day — the same reasoning
 * applies to anything handed to a model, which will happily make it more specific than the
 * evidence supports.
 */
/**
 * The ONE place that decides what a model may reference about a recipient.
 *
 * Exported and shared with `pnpm ig:generate`, because the first version left the CLI with its
 * own copy — so the command whose entire job is showing a person what the planner would produce
 * showed them something else. That is "one gate, two callers, never re-inline it", and it
 * appeared here within an hour of the same mistake being fixed in `thread.ts`.
 */
export async function observationFor(
  target: ComposablePair['target'],
  hook: { brands: string; postedAt: Date } | null,
): Promise<string | null> {
  return hook ? describeHook(hook) : await describeDiscovery(target)
}

/**
 * Why a BRAND is a prospect at all, in words the model may repeat: we saw them buy a placement
 * on a publisher we watch. A fact about one recipient, which is what decision 3 asks for and
 * what no template can supply.
 *
 * Degrades to null rather than to a generality — no known campaign means the model is told to
 * reference nothing, exactly as `brandFirstTouch` drops its specific claim rather than
 * inventing one.
 */
/**
 * THE STANDARD MESSAGE (2026-08-17, Tabish's copy).
 *
 * *"No custom message is required whatsoever. Same standard template message to be sent to
 * them … The custom part must only be the target name being mentioned."*
 *
 * `renderMessage` supplies the greeting — which now runs INTO the first line rather than
 * sitting above a blank one — plus the closing line and the signature. Only two things vary
 * across every message this system sends: the recipient's name and the sending page's name.
 *
 * ── THE CONSTRAINT THAT SHAPES THIS COPY, AND IT IS NOT EDITORIAL ─────────
 *
 * `proseLines` drops the FIRST line by POSITION — which, now the greeting and the
 * introduction are merged, is the opener — and strips the closing line and the signature.
 * `distinctiveSlice` then needs a SURVIVING LINE OF AT LEAST 40 CHARACTERS
 * (`MIN_NEEDLE_CHARS`) to build the needle both send guards search for. If none survives it
 * returns null, and null means every send is refused.
 *
 * MEASURED, and the result corrects the obvious guess. It is about paragraph LENGTH, not
 * paragraph COUNT:
 *
 *     three paragraphs (this copy)   prose=3   needle ok
 *     one LONG paragraph             prose=1   needle ok
 *     one SHORT paragraph            prose=1   NULL — every send refused
 *     two SHORT paragraphs           prose=2   NULL — every send refused
 *
 * So the rule to preserve when editing this copy is: **at least one paragraph must stay
 * comfortably over 40 characters.** Anyone shortening it toward a couple of terse lines —
 * which is exactly the direction "make it shorter" pushes — takes the fleet down, and it
 * presents as a sending outage rather than a copy change. `tests/single-template.test.ts`
 * asserts it against this exact constant rather than a fixture that could drift from it.
 *
 * Every figure is in `APPROVED_FIGURES` in qualityGate.ts (30 crore / 300M) — no new number
 * was invented for this, by design. Tabish's draft was longer and he invited it to be
 * shorter ("can be wayyy shorter"), so it is.
 */
export const SINGLE_TEMPLATE_MIDDLE = `We're a Bollywood and paparazzi network doing over 30 crore (300M) views a day, and we work with film studios and entertainment brands on year-round visibility rather than one-off campaigns.

I'd like to explore an annual collaboration covering your releases, trailers, music launches and celebrity moments across our owned pages.

Could we find 20 minutes for me to walk you through a plan?`

/**
 * The single template's variable line for a BRAND: the placement we discovered them in,
 * addressed to them. Built by the same rules as `brandFirstTouch` — a hand-mapped
 * publisher name or nothing, recency banded, never a guess — and returns null when we
 * have nothing verifiable, so the template simply omits the line.
 */
export async function brandObservationLine(target: ComposablePair['target'], now: Date): Promise<string | null> {
  if (!target.discoveredFromCampaignId) return null
  const campaign = await prisma.detectedCampaign.findUnique({
    where: { id: target.discoveredFromCampaignId },
    select: { postedAt: true, target: { select: { handle: true } } },
  })
  const publisher = publisherDisplayName(campaign?.target.handle)
  if (!publisher) return null
  const when = describeRecency(campaign?.postedAt ?? null, now)
  return `I saw your placement with ${publisher}${when ? ` ${when}` : ''}.`
}

export async function describeDiscovery(target: ComposablePair['target']): Promise<string | null> {
  if (!target.discoveredFromCampaignId) return null
  const campaign = await prisma.detectedCampaign.findUnique({
    where: { id: target.discoveredFromCampaignId },
    select: { target: { select: { handle: true } } },
  })
  const publisher = publisherDisplayName(campaign?.target.handle)
  if (!publisher) return null
  return `we saw them run a paid placement with the publisher ${publisher}, which is how we know they buy media on entertainment pages`
}

export function describeHook(hook: { brands: string; postedAt: Date }): string | null {
  const brands = readStringArray(hook.brands)
    .map((b) => b.replace(/^@/, ''))
    .filter((b) => b.length > 1)
  if (brands.length === 0) return null
  return `they recently ran a branded collaboration with ${brands.slice(0, 2).join(' and ')}`
}
