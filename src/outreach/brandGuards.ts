import type { RenderPersona } from './render'

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
  /** How many brands have been contacted for the first time today (IST). */
  newBrandTouchesToday: number
  /** The cap. */
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
} as const

export type BrandGuardResult = { ok: true } | { ok: false; reason: string; detail: string }

export function checkNewBrandTouchCap(input: BrandTouchInput): BrandGuardResult {
  if (!input.isFirstTouch) return { ok: true }

  if (input.newBrandTouchesToday >= input.maxNewBrandTouchesPerDay) {
    return {
      ok: false,
      reason: BRAND_BLOCKS.NEW_BRAND_DAILY_CAP,
      detail: `${input.newBrandTouchesToday} new brand(s) already contacted today (cap ${input.maxNewBrandTouchesPerDay}) — the rest of the queue waits for tomorrow`,
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
 * The identity a recipient actually sees: which page is writing, and how to reach it.
 *
 * Deliberately EXCLUDES nothing that appears in the message — and, symmetrically,
 * INCLUDES nothing that does not. Two senders differing only in a field the recipient
 * never sees are not distinct in any way that matters, which is why `personaName` and
 * `personaRole` left this list on 2026-08-07, the day they stopped rendering: keeping
 * them would let two accounts pass as "distinct" while their rendered signatures were
 * byte-identical.
 */
function personaFingerprint(p: RenderPersona): string {
  return [p.personaBrand, p.personaPhone, p.personaEmail].map((s) => s.trim().toLowerCase()).join('|')
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
