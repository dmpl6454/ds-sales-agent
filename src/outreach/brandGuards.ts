import type { RenderPersona } from './render'
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
  PERSONA_NOT_DISTINCT: 'persona-not-distinct',
  RECIPIENT_IS_A_PERSON: 'recipient-is-a-person',
} as const

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

/* ─────────────────────────────── the persona gate ─────────────────────────────── */

/**
 * Refuses a brand pitch from an account whose persona is not its own.
 *
 * THIS IS DECISION 3b, ENFORCED RATHER THAN DOCUMENTED.
 *
 * Every `SenderAccount` currently carries the identical block — *Kapil Jain, Co-founder,
 * Bollywood Society* — including `@madaboutmarketingg` and `@bollywoodchronicle`. So a DM
 * from Mad About Marketing introduces itself as the co-founder of a different company, and
 * three different pages emit a byte-identical four-line contact block.
 *
 * Why brands specifically, and not channels:
 *
 *   - A brand's social team reads pitches for a living and checks who is writing. A
 *     signature that does not match the sending account is the tell.
 *   - The contact block is the most trivially fingerprinted part of any message. Three
 *     pages sharing one is exactly the cross-account repetition decision 3 exists to
 *     prevent — the bespoke BODIES do not fix it, because the persona is not the body.
 *   - Channel outreach has already run this way and is not made worse by brand work. This
 *     gate is about not extending the problem to a new, more scrutinising audience.
 *
 * `validatePersona` checks SHAPE, not truthfulness, so it passes happily on four identical
 * blocks. This checks distinctness, which is the actual property that was missing.
 *
 * **Do not satisfy this gate by generating personas.** Who fronts each brand is a business
 * identity question and it is Tabish's to answer. A plausible invented name in a real DM
 * to a real company is worse than a blocked send.
 */
export interface PersonaGateInput {
  /** The persona the message will actually carry. */
  persona: RenderPersona
  /** Every OTHER sender's persona. Distinctness is a property of the set, not of one row. */
  otherPersonas: readonly RenderPersona[]
  /** 'BRAND' | 'CHANNEL'. Both are gated once `gateChannels` is on — see below. */
  targetKind: string
  /**
   * Does this gate cover CHANNEL sends too?
   *
   * ── DECISION 6, TAKEN BY TABISH 2026-08-04 ────────────────────────────
   *
   * It used to cover brands only, on the reasoning that a brand's social team reads
   * pitches for a living while a publisher is a softer audience — and that halting
   * channel outreach was a bigger change than this guard was entitled to make alone.
   *
   * At 65 accounts that reasoning inverts. 63 pages emitting one byte-identical
   * four-line contact block is not a soft-audience problem, it is the cross-account
   * fingerprint decision 3 exists to prevent, at 63x the scale. Rotation makes it
   * worse in the specific way that matters: the whole point is that a recipient hears
   * from a different page each time, and an identical signature underneath every one
   * of them announces that the pages are one operation. That is legible to a
   * recipient, not just to Meta.
   *
   * THE CONSEQUENCE TABISH ACCEPTED: with every account still carrying *Kapil Jain,
   * Co-founder, Bollywood Society*, this stops ALL outreach — channels included —
   * until each account has a persona of its own. It is currently the strongest brake
   * in the system, and that is deliberate rather than incidental.
   *
   * A FLAG, not a hardcode, because turning it on halts live outreach and whoever is
   * mid-edit on 63 personas needs to be able to finish. Default ON: the safe direction
   * is the one that refuses.
   *
   * **Never satisfy this gate by generating personas.** Who fronts each page is a
   * business identity question and it is Tabish's to answer; a plausible invented
   * person in a real DM to a real company is worse than a blocked send.
   */
  gateChannels?: boolean
}

/**
 * The identity a recipient actually sees: who is writing, from which page, and how to
 * reach them.
 *
 * Deliberately EXCLUDES nothing that appears in the message — and, symmetrically,
 * INCLUDES nothing that does not. Two senders differing only in a field the recipient
 * never sees are not distinct in any way that matters, which is why `personaName` and
 * `personaRole` left this list on 2026-08-07, the day they stopped rendering: keeping
 * them would let two accounts pass as "distinct" while their rendered signatures were
 * byte-identical.
 *
 * ── AND ON 2026-08-17 THEY CAME BACK, BECAUSE THE MESSAGE CHANGED ─────────
 *
 * Tabish's standard message opens *"I'm Kapil Jain, Co-founder of <page>."* and signs off
 * with the name and role above the contact block, so both fields render again and the
 * contract above puts them back here. The rule is the contract, not the list.
 *
 * Note this does NOT weaken the gate, and the direction is worth stating because it looks
 * like it might. All four accounts share the name, so adding a shared component to a
 * concatenation cannot make two different fingerprints equal — the PAGE NAME is still what
 * separates them, exactly as before.
 *
 * The standing warning is unchanged and is now sharper: all four still carry the identical
 * `+91 60000 189766` and `kapil@digitalsukoon.com`, which is 2 of the 4 signature lines,
 * and the gate cannot see it because it compares the whole block. At four accounts that is
 * cosmetic; at 65 it is one phone number under 63 pages. **Raise it before volume rises.**
 */
function personaFingerprint(p: RenderPersona): string {
  return [p.personaName, p.personaRole, p.personaBrand, p.personaPhone, p.personaEmail]
    .map((s) => s.trim().toLowerCase())
    .join('|')
}

export function checkPersonaDistinct(input: PersonaGateInput): BrandGuardResult {
  const gateChannels = input.gateChannels ?? true
  if (input.targetKind !== 'BRAND' && !gateChannels) return { ok: true }

  const mine = personaFingerprint(input.persona)
  const clash = input.otherPersonas.some((other) => personaFingerprint(other) === mine)

  if (clash) {
    const audience = input.targetKind === 'BRAND' ? 'a brand pitch' : 'a message'
    return {
      ok: false,
      reason: BRAND_BLOCKS.PERSONA_NOT_DISTINCT,
      detail:
        `this account signs off exactly like another sending account (${input.persona.personaBrand} · ` +
        `${input.persona.personaPhone} · ${input.persona.personaEmail}) — ${audience} must sign off as ` +
        `the page that is actually sending it. Give this account its own signature first.`,
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
}): BrandGuardResult {
  if (input.targetKind !== 'BRAND') return { ok: true }
  if (!isPersonRoleCategory(input.brandCategory)) return { ok: true }
  return {
    ok: false,
    reason: BRAND_BLOCKS.RECIPIENT_IS_A_PERSON,
    detail:
      `Instagram lists @${input.handle} as "${input.brandCategory}", which is a profession rather than a ` +
      `company. A media-buying pitch to a person is the wrong message, so nothing is written to them.`,
  }
}
