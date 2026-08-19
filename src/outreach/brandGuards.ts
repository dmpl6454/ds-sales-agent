import { isPersonRoleCategory } from '@/detection/resolveBrand'

/**
 * The two guards that exist ONLY for brand outreach.
 *
 * Pure — no DB, no clock, no env — like `governor.ts` and `gate.ts`, so every rule is
 * testable in both directions. That matters more than usual here: brand outreach is the
 * first thing this system does that grows its own target list. Today the list is two
 * channels; after discovery it grows with every paid post, forever.
 *
 * These are ADDITIONAL to every existing guard, never a replacement. A brand target still
 * passes through the governor (cooldown, new material, unanswered touches, daily caps,
 * lifetime ceiling, opt-out, replies) and still passes through `gate.ts` before delivery.
 */

/* ────────────────────────── new-brand-touches-per-day ────────────────────────── */

/**
 * A cap on how many brands we may contact for the FIRST time in one day.
 *
 * Distinct from `SenderAccount.dailyCap`, and the distinction is the whole reason it
 * exists: `dailyCap` protects the ACCOUNT (Instagram's per-sender spam heuristics), this
 * protects the PATTERN. Ten first-touches to strangers in one afternoon and ten messages
 * spread across ten days are the same volume and look nothing alike — the first is
 * indistinguishable from a scraped list being worked through, which is precisely what
 * Meta's spam policy describes.
 *
 * Only FIRST touches count. A follow-up to a brand we already opened is a continuing
 * conversation, already spaced by `cooldownDays` and bounded by `maxUnansweredTouches`,
 * and counting it here would make a legitimate second message compete with a new prospect
 * for the same slot.
 */
export interface BrandTouchInput {
  /**
   * ── TWO COUNTERS, BOTH NAMED, BECAUSE ONE OF THEM NEVER BOUND ──────────────────────
   *
   * This was a single `newBrandTouchesToday`, counted over DELIVERED messages. Nothing has
   * ever been delivered by this system, so it was permanently 0 and the only thing binding
   * was a counter reset every run — "2 a day" enforced as "2 a run", ~8 at four slots and
   * ~192 once drafting moved onto the 15-minute clock.
   *
   * See `brandTouchCounts.ts` for why they are kept apart: one bounds the QUEUE, the other
   * bounds what strangers actually receive, and today they read 6 and 0.
   */
  /**
   * First-touch brand drafts WAITING right now — a DEPTH, not a daily rate.
   *
   * Changed 2026-08-17 (Tabish: *"cap should not exist for drafts should it, what if we
   * discover several targets?"*). A draft reaches nobody, so bounding how many are WRITTEN
   * per day guards nothing a recipient can see — and because both counters were compared
   * against one number with this one checked first, the DELIVERY cap could never be reached.
   * Discarding a draft also spent the day's allowance on a message no one received.
   */
  waitingFirstTouches: number
  /** How deep the first-touch queue may get. Its own number now — see above. */
  maxWaitingNewBrandDrafts: number
  /** First touches to brands DELIVERED today (IST) — bounds what recipients see. */
  firstTouchesDeliveredToday: number
  /** The DELIVERY cap. The rule the rationale was written about. */
  maxNewBrandTouchesPerDay: number
  /**
   * Is THIS a first touch? Only first touches are capped — a follow-up is a continuing
   * conversation, already governed by cooldown and the unanswered-touch limit.
   */
  isFirstTouch: boolean
}

export const BRAND_BLOCKS = {
  NEW_BRAND_DAILY_CAP: 'new-brand-daily-cap',
  RECIPIENT_IS_A_PERSON: 'recipient-is-a-person',
} as const

/*
 * THE PERSONA GATE IS GONE (2026-08-18). The standard message is sent verbatim with no
 * signature block ("no signature name whatsoever" — Tabish), so persona distinctness
 * stopped being a property of anything a recipient sees. `checkPersonaDistinct` and
 * `personaFingerprint` were deleted with it; the persona columns survive in the schema
 * but render nowhere and gate nothing.
 */

export type BrandGuardResult = { ok: true } | { ok: false; reason: string; detail: string }

export function checkNewBrandTouchCap(input: BrandTouchInput): BrandGuardResult {
  if (!input.isFirstTouch) return { ok: true }

  /**
   * EITHER counter reaching the cap refuses, and the refusal names WHICH — not a combined
   * number. "2 written and 0 delivered" and "0 written and 2 delivered" are different
   * situations with different remedies, and a merged figure would describe neither.
   *
   * The queue depth is checked first because it is the one that binds in practice: a
   * delivery needs a draft, so the queue fills before the inbox does. They no longer share a
   * number, which is what makes the delivery cap reachable at all.
   */
  if (input.waitingFirstTouches >= input.maxWaitingNewBrandDrafts) {
    return {
      ok: false,
      reason: BRAND_BLOCKS.NEW_BRAND_DAILY_CAP,
      detail:
        `${input.waitingFirstTouches} first message(s) to new brands are already waiting ` +
        `(room for ${input.maxWaitingNewBrandDrafts}) — send or discard some and the rest will be written`,
    }
  }

  if (input.firstTouchesDeliveredToday >= input.maxNewBrandTouchesPerDay) {
    return {
      ok: false,
      reason: BRAND_BLOCKS.NEW_BRAND_DAILY_CAP,
      detail:
        `${input.firstTouchesDeliveredToday} new brand(s) have already been contacted today ` +
        `(cap ${input.maxNewBrandTouchesPerDay}) — the rest of the queue waits for tomorrow`,
    }
  }
  return { ok: true }
}

/**
 * IS THIS "BRAND" ACTUALLY A PERSON? A third brand-only guard, added 2026-08-13.
 *
 * ── WHY A GUARD AND NOT JUST A CLASSIFIER FIX ─────────────────────────────
 *
 * `classifyProfile` compared Instagram's category against an EXACT-match set containing
 * `'director'` and `'producer'`, while the endpoint returns `"Film Director"` and
 * `"Film Producer"`. `isPersonRoleCategory` fixes that going forward — and fixing a
 * classifier does not reclassify rows already written. MEASURED on the live database:
 * **8 BRAND targets carry an unmistakable person-role category** (5 × Film Director,
 * 2 × Creators & Celebrities, 1 × Film Producer), including a working film director and a
 * well-known actor, and every one of them is a live recipient with a pair row.
 *
 * The plan for this fix said to *"report rather than auto-delete — a wrong retirement costs
 * a real prospect"*, and that is right about the DATA. It is not enough on its own: a
 * report nobody runs is not protection, which is the lesson of the 166 cover frames saved
 * and never read. So the rows are left exactly as they are for a person to judge, and the
 * PLANNER refuses to write to them meanwhile.
 *
 * ── NOT OVERRIDABLE, AND IT SITS BESIDE THE PERSONA GATE FOR THE SAME REASON ──
 *
 * It lives here rather than in `gate.ts`, so it is unreachable from the on-demand dialog's
 * override list. Every stop a human may cross is about TIMING — too soon, nothing new to
 * say, they already replied. This one is about the message being wrong for its recipient,
 * and "I know something the agent does not" is a good argument about timing and no argument
 * at all about sending a media-buying pitch to a private individual. If the category is
 * wrong, fix the category.
 */
export function checkRecipientIsNotAPerson(input: {
  targetKind: string
  /** `TargetAccount.brandCategory` — what Instagram said this account is. */
  brandCategory: string | null
  handle: string
  /**
   * TRUE only for a person DELIBERATELY admitted (Tabish, 2026-08-19: message
   * celebrities who are part of the paid campaign) — Instagram itself asserted them on a
   * CAMPAIGN post AND they passed the verified-or-size bar (`admitsAsTalent`). The guard
   * still refuses ACCIDENTAL people: a vanity category on an ordinary BRAND row is
   * exactly what it was built for, and that half is unchanged.
   */
  campaignTalent: boolean
}): BrandGuardResult {
  if (input.targetKind !== 'BRAND') return { ok: true }
  if (input.campaignTalent) return { ok: true }
  if (!isPersonRoleCategory(input.brandCategory)) return { ok: true }
  return {
    ok: false,
    reason: BRAND_BLOCKS.RECIPIENT_IS_A_PERSON,
    detail:
      `Instagram lists @${input.handle} as "${input.brandCategory}", which is a profession rather than a ` +
      `company. A media-buying pitch to a person is the wrong message, so nothing is written to them.`,
  }
}
