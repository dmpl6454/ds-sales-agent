import { prisma } from '@/lib/db'
import { DELIVERED_STATUSES, IN_FLIGHT_STATUSES } from '@/lib/constants'
import { newMaterialFloor } from '@/lib/cutoff'
import { campaignsNamingHandleRows } from './materialAllowance'
import { readStringArray } from '@/lib/json'
import { log } from '@/lib/logger'
import { getSettings } from '@/lib/settings'
import { generateMessageBody } from './generate'
import { brandFirstTouch, publisherDisplayName, describeRecency } from './brandPitch'
import { greetableName, renderMessage } from './render'
import type { FleetTemplate } from './fleetTemplate'
import { followUpPostReference, renderFollowUp, type FollowUpTemplate } from './followUpTemplate'

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
 * ── THE CLAIM LEDGER IS PER RECIPIENT (2026-09-01) ────────────────────────────
 *
 * Every campaign ANY of our pages has already claimed against THIS RECIPIENT.
 *
 * ── THE SCREENSHOT THAT PRODUCED THIS ─────────────────────────────────────────
 *
 * Tabish, from the live `/paid-posts`: @dorothy shown messaged FOUR times under ONE
 * @instantbollywood post. Measured, and it is neither a column bug nor a rule breach:
 * @dorothy is named on four SYNDICATED copies of one campaign (@varindertchawla,
 * @viralbhayani, @voompla, @instantbollywood, all 29 Aug 10:22-10:49), so her allowance
 * was 4 and exactly 4 were delivered — the documented syndication multiplier, working.
 *
 * What was wrong is that **all four messages CLAIMED the same newest copy**
 * (`DcnwkuCTxwE`). `usedCampaignIds` is scoped to the PAIR, so a post used by page A is
 * still "fresh" for pages B, C and D; `pickHook` sorts newest-first, so all four picked
 * the same one. The provenance column then truthfully stacked four claims under one post
 * and drew em-dashes under its three siblings — a real defect, in the ledger rather than
 * in the screen.
 *
 * ── WHAT THIS CHANGES, AND WHAT IT DELIBERATELY DOES NOT ──────────────────────
 *
 * A paid post may now fund exactly ONE delivered message to a given recipient, fleet-wide.
 * **VOLUME DOES NOT MOVE BY ONE MESSAGE.** `materialAllowance` is untouched and is still
 * count-vs-count (posts naming them, against messages delivered to them, same window), so
 * @dorothy's four messages stay four — they simply come to cite four different posts, one
 * each. Only WHICH post each message claims changes.
 *
 * ── THE STATUS SET IS `usedCampaignIds`' SET, AND THAT IS LOAD-BEARING ────────
 *
 * `IN_FLIGHT_STATUSES`, deliberately identical: an UNDELIVERED draft's claim must block a
 * second claim on the same post (otherwise two pages draft against one post the same pass
 * and the ledger is back where it started), and a DISCARDED draft must RELEASE it —
 * exactly the semantics that comment records for the pair-scoped read, where counting
 * SKIPPED rows once burned four campaigns per pair and left the pool falsely exhausted.
 *
 * Reads the denormalised `OutreachAttempt.targetId` rather than joining through the pair:
 * the column is NOT NULL, written by every creator, and already the basis of the gate's
 * own per-recipient reads.
 */
export async function claimedCampaignIds(targetId: string): Promise<string[]> {
  const rows = await prisma.outreachAttempt.findMany({
    where: { targetId, campaignId: { not: null }, status: { in: [...IN_FLIGHT_STATUSES] } },
    select: { campaignId: true },
  })
  return rows.map((r) => r.campaignId).filter((id): id is string => id !== null)
}

/**
 * PAID POSTS NAMING THIS RECIPIENT THAT NOBODY HAS CLAIMED — the ONE selector.
 *
 * The count (`unusedCampaignCount` → `NO_NEW_MATERIAL`), the pick (`pickHook`) and the
 * planner's own per-pair figure are three readings of ONE question, and this codebase has
 * been bitten twice by exactly these queries drifting apart. They now share a floor, a
 * status filter, an exclusion set and a function.
 *
 * That is not tidiness here, it is a correctness requirement introduced by the union: if
 * the COUNT excluded only the pair's own claims while the PICK excluded the recipient's
 * too, the governor could report "there is new material" and the composer could then find
 * none — a follow-up permitted with nothing to cite. Both ask this.
 *
 * ── THE PAIR ARM IS A SUBSET TODAY, AND IS KEPT DELIBERATELY ─────────────────
 *
 * MEASURED by mutation, 2026-09-01: deleting `usedCampaignIds` from the union breaks NO
 * test, because every attempt carrying a pair also carries that pair's `targetId` — the
 * recipient read already contains it. It is kept for one reason, and it is not symmetry:
 * `OutreachAttempt.targetId` is a DENORMALISED copy of the pair's target, while `pairId` is
 * the row's own foreign key. "No pair writes about one post twice" is the older and more
 * fundamental of the two rules, and resting it entirely on a denormalised column would make
 * it fail silently the first time that column is wrong. One small indexed read, now issued
 * in PARALLEL where the planner's copy used to be awaited before its `Promise.all`.
 *
 * `tests/claim-ledger.test.ts` drives that exact drift — an attempt whose `targetId` does
 * not match its pair — so the arm is not merely redundant-and-untested.
 */
export async function freshCampaignsFor(args: {
  target: NamedRecipient
  /** `TargetAccount.id` — the RECIPIENT, never the posting channel. See campaignsNamingHandleRows. */
  targetId: string
  pairId: string
  now: Date
}): Promise<Awaited<ReturnType<typeof campaignsNamingHandleRows>>> {
  const [naming, usedByThisPair, claimedForRecipient] = await Promise.all([
    campaignsNamingHandleRows(prisma, args.target, newMaterialFloor(args.now)),
    usedCampaignIds(args.pairId),
    claimedCampaignIds(args.targetId),
  ])
  const spokenFor = new Set([...usedByThisPair, ...claimedForRecipient])
  return naming.filter((c) => !spokenFor.has(c.id))
}

/**
 * How many campaigns are left that this pair has not used — the governor's new-material
 * input, and the count that must agree with `pickHook` below.
 *
 * The count and the lookup are two halves of one question ("is there new material?" and
 * "which piece of it?"). This codebase has been bitten twice by exactly these two queries
 * drifting, so they now share a floor, a status filter and a file.
 */
/**
 * ── `targetId` IS THE POSTING CHANNEL, SO THIS WAS ZERO FOREVER FOR A PROSPECT ──
 *
 * MEASURED 2026-08-22, from Tabish's question about the send cadence: the queue was empty
 * while **40 recipients had allowance room**, and every one of them was refused for every
 * sender. The reason is one column. `DetectedCampaign.targetId` is the CHANNEL THAT POSTED
 * — never the brand named in the post — so counting campaigns "for this recipient" that way
 * returns 0 for every prospect, always. `NO_NEW_MATERIAL` therefore refused every follow-up
 * to every prospect PERMANENTLY: each (sender → prospect) pair could send exactly one
 * message ever, the first touch that is exempt by construction, and never another however
 * many placements that brand bought. @amazonmgmstudios: **17 paid posts naming it, 5
 * messages, capped forever.**
 *
 * This is the SAME defect fixed in `materialAllowance` the day before — where it had made
 * the unlock half of Tabish's rule unreachable and the fleet went quiet — surviving here in
 * the older rule, unfixed, because the two rules were never compared. *"A fail-closed guard
 * with an unsatisfiable precondition is a blindfold wearing a seatbelt."*
 *
 * So both queries now ask `campaignsNamingHandleRows` — the ONE place the linkage lives
 * (caption @mentions, media tags, and a brand string that exactly names the prospect). The
 * guard is unchanged in strength and finally satisfiable: a follow-up still requires a paid
 * post naming this recipient that THIS PAIR has not written about, which is strictly more
 * than the recipient-level allowance asks on its own.
 */
/**
 * The RECIPIENT ROW, not its id — required, so the compiler names every call site.
 *
 * The linkage matches on the handle and the display name, and the callers all already hold
 * the row. Taking an id and looking it up again would have cost a query per pair per pass
 * AND made this untestable without a full Prisma mock, which is how the first version of
 * this fix was caught: `tests/compose.test.ts` stubs the models it needs and rightly had no
 * `targetAccount`.
 */
export interface NamedRecipient {
  handle: string
  displayName?: string | null
}

/**
 * `targetId` is REQUIRED with no default, so the compiler names every call site — the
 * `RenderTarget.kind` pattern. A caller that omitted it would silently fall back to the
 * old pair-only exclusion, which is precisely the defect being closed and would be
 * invisible: the count would simply read one higher and a second page would claim a post
 * the first already had.
 */
export async function unusedCampaignCount(args: {
  target: NamedRecipient
  targetId: string
  pairId: string
  now?: Date
}): Promise<number> {
  const { pairId, targetId, target, now = new Date() } = args
  return (await freshCampaignsFor({ target, targetId, pairId, now })).length
}

/**
 * The freshest paid post naming this recipient that NOBODY has claimed yet, or null.
 *
 * Newest-first is unchanged, and with the ledger now per RECIPIENT it finally means what
 * it reads as: four pages writing about one syndicated campaign take its four copies in
 * order of recency rather than all naming the newest.
 */
async function pickHook(args: { target: NamedRecipient; targetId: string; pairId: string; now: Date }) {
  const fresh = (await freshCampaignsFor(args)).sort((a, b) => b.postedAt.getTime() - a.postedAt.getTime())[0]
  if (!fresh) return null
  /* The PUBLISHING channel comes back with it: the follow-up body names the post it is
     written about ("your placement with @viralbhayani on 30 Aug"), and `DetectedCampaign.
     targetId` is that channel — never the recipient. A second lookup for one handle would
     be a query per draft. */
  return prisma.detectedCampaign.findUnique({
    where: { id: fresh.id },
    include: { target: { select: { handle: true } } },
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

/**
 * Thrown when the fleet this route belongs to has no standard message written yet.
 *
 * DEFENCE IN DEPTH, not the primary stop. `evaluatePair` refuses to draft and
 * `evaluateResend` refuses to send for exactly this reason, both by name and both with a
 * remedy on screen — so reaching here means a caller composed a body without asking either.
 * Throwing beats returning the other fleet's copy: a crash is loud and a wrong pitch to a
 * real company is silent.
 */
export class FleetTemplateNotSetError extends Error {
  constructor(readonly targetHandle: string, readonly detail: string) {
    super(`no standard message for @${targetHandle}'s fleet — ${detail}`)
    this.name = 'FleetTemplateNotSetError'
  }
}

/**
 * Thrown when a FOLLOW-UP is composed for a fleet whose follow-up copy is unwritten.
 *
 * DEFENCE IN DEPTH, exactly like `FleetTemplateNotSetError` above and never the primary
 * stop: `evaluatePair` refuses to draft and `evaluateResend` refuses to send, both by name
 * and both with a remedy on screen. Reaching here means a caller composed a second message
 * without asking either — and throwing beats returning the FIRST-touch template, because a
 * crash is loud and a verbatim repeat Instagram silently drops is not.
 */
export class FollowUpTemplateNotSetError extends Error {
  constructor(readonly targetHandle: string, readonly detail: string) {
    super(`no follow-up message for @${targetHandle}'s fleet — ${detail}`)
    this.name = 'FollowUpTemplateNotSetError'
  }
}

/**
 * Thrown when a follow-up has no unclaimed paid post to name.
 *
 * Unreachable through the planner by construction — `NO_NEW_MATERIAL` refuses a follow-up
 * with `unusedCampaignCount === 0`, and that count and `pickHook` are now two readings of
 * ONE selector (`freshCampaignsFor`), so they cannot disagree about whether material
 * exists. It is here for the window between the two reads, and because a follow-up whose
 * `{{post}}` rendered as nothing would be byte-identical to every other follow-up from
 * this page — the wall this whole feature exists to remove.
 */
export class NoMaterialForFollowUpError extends Error {
  constructor(readonly targetHandle: string) {
    super(`no unclaimed paid post naming @${targetHandle} — a follow-up has nothing to reference`)
    this.name = 'NoMaterialForFollowUpError'
  }
}

export async function composeForPair(args: {
  pair: ComposablePair
  senderHandle: string
  touchNumber: number
  /**
   * WHICH STANDARD MESSAGE THIS ROUTE SENDS — resolved by the caller from the same pure
   * rule the governor and the gate ask, and REQUIRED so the compiler names every call site.
   *
   * Not derived here, for the reason `crossSpacing` and `material` are not either: it needs
   * the category memberships, and a lookup per pair would be an N+1 over senders x targets
   * inside the planner's own loop.
   */
  fleetTemplate: FleetTemplate
  /**
   * WHAT THIS ROUTE SAYS ON A SECOND MESSAGE, or why there is none (2026-09-01).
   *
   * REQUIRED with no default, for the reason `fleetTemplate` is: a default of "fine" would
   * make the stop unreachable from whichever caller forgot it, and the failure would be a
   * verbatim repeat sent to a real company. Resolved by the caller from the same pure rule
   * the governor and the gate ask.
   */
  followUpTemplate: FollowUpTemplate
  now?: Date
}): Promise<Composed> {
  const { pair, senderHandle, touchNumber, fleetTemplate, followUpTemplate, now = new Date() } = args
  const settings = await getSettings()

  const hook = await pickHook({ target: pair.target, targetId: pair.targetId, pairId: pair.id, now })

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
     * THE TEMPLATE IS THE WHOLE MESSAGE, VERBATIM (2026-08-18, Tabish's instruction).
     * No greeting is prepended ("no space after hi, it is all continuous" — the "Hi," is
     * part of the template's own first characters), no persona/signature block is appended
     * ("no signature name whatsoever"), no hook or observation line is added. Every
     * recipient receives exactly the bytes of THEIR FLEET's standard message, resolved by
     * the caller — `renderMessage` is deliberately NOT called, because everything it adds
     * (greeting, intro, closing, signature) is exactly what was removed.
     *
     * Consequences held elsewhere in the same change: the gate's persona-staleness probe
     * is gone (nothing persona-shaped renders, so it was a probe about nothing), and
     * `checkTemplateBody` validates the verbatim text — a single line over 40 characters
     * satisfies `distinctiveSlice` via its single-line branch, which does not drop line 1.
     */
    /**
     * THE ROUTE'S OWN FLEET DECIDES THE COPY (2026-08-26). Never the default fleet's body
     * as a fallback: a second fleet with nothing written REFUSES, so its recipients wait
     * for their own copy rather than receiving somebody else's pitch. See fleetTemplate.ts.
     */
    /**
     * ── A SECOND MESSAGE IS A DIFFERENT MESSAGE (2026-09-01, Tabish) ────────
     *
     * `touchNumber >= 2` takes the FOLLOW-UP copy, never the standard template. That is the
     * whole release: the first touch and every follow-up used to be byte-identical, so
     * every follow-up was a verbatim repeat Instagram accepts and never delivers (measured:
     * 83% of touch-2 sends), and `IDENTICAL_TO_A_SENT_MESSAGE` correctly refused all of
     * them — 1,808 pairs held on 1 September.
     *
     * The follow-up NAMES the paid post it claimed, and that is what makes each one differ
     * from the last as well as from the first. `hook` is that post — the same row recorded
     * on `campaignId` below and rendered by the provenance column — so the bytes a
     * recipient reads and the "Why" a person reads on the dashboard cite the same thing by
     * construction.
     *
     * Both refusals throw rather than fall back, and neither should ever be reached: the
     * governor refuses to write and the gate refuses to send, by name, before this.
     */
    if (touchNumber > 1) {
      if (!followUpTemplate.ok) throw new FollowUpTemplateNotSetError(pair.target.handle, followUpTemplate.detail)
      if (!hook) throw new NoMaterialForFollowUpError(pair.target.handle)
      const body = renderFollowUp(
        followUpTemplate.body,
        followUpPostReference({ channelHandle: hook.target.handle, postedAt: hook.postedAt }),
      )
      return {
        body,
        hookLine: null,
        variantId: variant.id,
        /* The claim, recorded as always — and now also the thing the body says out loud. */
        campaignId: hook.id,
        usedBespoke: false,
        generated: false,
      }
    }

    if (!fleetTemplate.ok) throw new FleetTemplateNotSetError(pair.target.handle, fleetTemplate.detail)
    const body = fleetTemplate.body.trim()
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
 * The shipped DEFAULT-fleet copy, re-exported so every existing importer is unchanged.
 * It LIVES in `fleetTemplate.ts` since 2026-08-26 — see the docblock there for why a
 * second fleet's copy makes this a rule's input rather than the composer's own constant.
 */
export { SINGLE_TEMPLATE_MIDDLE } from './fleetTemplate'

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
