import { describe, it, expect } from 'vitest'
import { evaluatePair, SKIP_REASONS } from '@/outreach/governor'
import { evaluateResend, RESEND_BLOCKS, OVERRIDABLE_BLOCKS } from '@/outreach/gate'
import { crossSpacingVerdict } from '@/outreach/crossSpacing'
import { BRAND_BLOCKS, checkNewBrandTouchCap, checkRecipientIsNotAPerson } from '@/outreach/brandGuards'
import { decideDispatch, assessBreaker, FLEET_MIN_GAP_MINUTES } from '@/outreach/pacing'
import { FAILURE_CODES } from '@/lib/constants'
import { asSentence, remedyFor, withoutShellCommand } from '@/app/messages/remedy'
import { describeOnDemand, CROSSABLE_RULES } from '@/outreach/onDemand'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { templateForSettings } from '@/outreach/fleetTemplate'
import { followUpForSettings } from '@/outreach/followUpTemplate'

/** A WRITTEN follow-up message, built by the REAL rule. See tests/follow-up-template.test.ts. */
const FOLLOW_UP_WRITTEN = followUpForSettings(
  { followUpBody: `Hi,Following up on {{post}} — we can put the same campaign in front of a much larger audience. Let's talk tomorrow.`, followUpBodies: new Map() },
  [],
  [],
)
/** The state the feature ships in: nobody has written a second message yet. */
const FOLLOW_UP_UNWRITTEN = followUpForSettings({ followUpBody: null, followUpBodies: new Map() }, [], [])


/**
 * The DEFAULT fleet's template, built by the REAL rule rather than written as a literal —
 * a hand-written verdict object goes stale GREEN the day the rule changes shape, which is
 * this suite's own recorded lesson from the `too-soon` fixture.
 */
const DEFAULT_FLEET_TEMPLATE = templateForSettings(
  { singleTemplateBody: null, fleetTemplateBodies: new Map() },
  [],
  [],
)


const ROOT_DIR = resolve(__dirname, '..')

/**
 * ── THE STOP INVENTORY — the safety net for the dashboard redesign ─────────
 *
 * Every refusal in this system is a SENTENCE ON A SCREEN. There are 7 governor stops, 8
 * gate stops, 2 brand guards, 7 pacing reasons and 10 failure codes, and each one exists
 * because *"nothing happened" with no explanation* is the failure this project keeps
 * rediscovering. Three of those explanations were added or fixed on 2026-08-05 alone, and one
 * of them had never reached a screen at all despite a docblock claiming it did.
 *
 * (Counts shrank on 2026-08-18: "Remove all caps" — the cooldown, unanswered-touch limit,
 * cross-sender recipient spacing, target/sender daily caps and both persona stops went, and
 * the pair daily cap arrived. The INVENTORY discipline is unchanged.)
 *
 * So before the UI is rearranged, this asserts two things about every stop:
 *
 *   1. IT IS REACHABLE. Some input produces it. "A guard nobody can trigger is not a guard"
 *      is this codebase's signature failure — `handleExists` could only answer "exists",
 *      `repliedAt` was read in six places and written in none, a nested lock could only be
 *      granted. A stop no input can produce cannot be tested and cannot be trusted.
 *
 *   2. IT EXPLAINS ITSELF IN ENGLISH. Every refusal carries a `detail` a person can read,
 *      with no raw code, no identifier, and enough words to be a sentence. A redesign that
 *      renders `detail` therefore cannot go silent — and one that drops it fails here.
 *
 * What this does NOT do: judge whether the copy is GOOD. CLAUDE.md records a persona warning
 * that was accurate and still had to be rewritten because Tabish asked what it meant. This is
 * a floor, not an editor.
 */

/** A stop's prose must read like a sentence, not like a log line. */
function assertReadable(label: string, detail: string | undefined, code: string) {
  expect(detail, `${label}: no detail at all — this refusal would render as silence`).toBeTruthy()
  const d = detail!
  expect(d.length, `${label}: detail is too short to be an explanation`).toBeGreaterThan(15)
  // The machine-readable code must not leak into the human sentence.
  expect(d, `${label}: the raw code "${code}" leaked into the operator-facing text`).not.toContain(code)
  // Nor an identifier: camelCase or snake_case with an underscore reads as a variable name.
  expect(d, `${label}: an identifier leaked into the operator-facing text`).not.toMatch(/[a-z]_[a-z]|\b[a-z]+[A-Z][a-z]+\b/)
  expect(d.trim(), `${label}: detail is only whitespace`).not.toBe('')
}

// ── the governor: may we CREATE a message ───────────────────────────────────

const NOW = new Date('2026-08-20T12:00:00Z')

/**
 * A real ring-complete hold, built by the predicate itself — a hand-written verdict
 * literal would go stale GREEN the day the rule changed shape (this file's own lesson,
 * learned when the too-soon fixture pinned a number the gap rule owned).
 */
const RING_HOLD = crossSpacingVerdict({
  now: NOW,
  windowDays: 7,
  crossPageGapHours: 24,
  thisSenderId: 's1',
  eligibleSenderIds: ['s1', 's2'],
  lastDeliveryBySender: new Map([
    ['s1', { sentAt: new Date(NOW.getTime() - 3 * 86_400_000), handle: 'bollywoodchronicle' }],
    ['s2', { sentAt: new Date(NOW.getTime() - 2 * 86_400_000), handle: 'bollywoodsocietyy' }],
  ]),
})

function governorInput(over: Record<string, unknown> = {}) {
  return {
    now: NOW,
    sender: { status: 'ACTIVE' },
    target: { optedOut: false, isVerified: true },
    touchesSoFar: 0,
    targetRepliedAt: null,
    hasPendingAttempt: false,
    parkedFailureCode: null,
    material: { held: false as const, allowance: 1, delivered: 0 },
    unusedCampaignCount: 5,
    describableCampaignCount: 5,
    pairSentTodayCount: 0,
    maxPerPairPerDay: 5,
    crossSpacing: { held: false },
    totalSentEver: 0,
    maxTotalSends: null,
    fleetTemplate: DEFAULT_FLEET_TEMPLATE,
    followUpTemplate: FOLLOW_UP_WRITTEN,
    repeatsADeliveredBody: false,
    ...over,
  } as Parameters<typeof evaluatePair>[0]
}

/** One input per stop, each chosen to trigger exactly that stop. */
const GOVERNOR_CASES: Array<[string, Record<string, unknown>]> = [
  [SKIP_REASONS.LIFETIME_CAP, { totalSentEver: 1, maxTotalSends: 1 }],
  // PAIR_DISABLED is GONE (one switch, 2026-08-08). Routes are not chosen any more — they
  // exist — so there is no per-route "off" for the governor to report. Retirement is
  // `target.optedOut`, which is the next case and is checked independently of any pair row.
  [SKIP_REASONS.TARGET_OPTED_OUT, { target: { optedOut: true, isVerified: true } }],
  [SKIP_REASONS.TARGET_NOT_VERIFIED, { target: { optedOut: false, isVerified: false } }],
  [SKIP_REASONS.IDENTICAL_TO_A_SENT_MESSAGE, { repeatsADeliveredBody: true }],
  /* And the same refusal one door earlier, so no draft is written that can never be sent. */
  [
    SKIP_REASONS.NO_FLEET_TEMPLATE,
    {
      fleetTemplate: templateForSettings(
        { singleTemplateBody: null, fleetTemplateBodies: new Map() },
        ['marketing'],
        ['marketing'],
      ),
    },
  ],
  /**
   * The CROSS-FLEET refusal, which reaches the governor through the same field and is a
   * different problem: the copy exists, these two just belong to different fleets. Told
   * apart on 2026-08-31 after the planner reported 245 of these as a missing template.
   * The sets are deliberately disjoint here — sender marketing, recipient default.
   */
  [
    SKIP_REASONS.DIFFERENT_CATEGORY,
    {
      fleetTemplate: templateForSettings(
        { singleTemplateBody: null, fleetTemplateBodies: new Map([['marketing', 'x'.repeat(60)]]) },
        ['marketing'],
        [],
      ),
    },
  ],
  [SKIP_REASONS.SENDER_NOT_ACTIVE, { sender: { status: 'CHALLENGED' } }],
  [SKIP_REASONS.TARGET_REPLIED, { targetRepliedAt: new Date('2026-08-19T12:00:00Z') }],
  [SKIP_REASONS.PENDING_ATTEMPT, { hasPendingAttempt: true }],
  /**
   * ── THE DUPLICATE GUARD (2026-08-21) ──────────────────────────────────────
   * A parked FAILED attempt was invisible to both the pending count and the touch count, so
   * the pair looked untouched and the planner drafted a fresh FIRST touch. MEASURED:
   * @indiagatefoods received the identical message twice, and @sohamrockstrent collected six
   * parked drafts at three attempts each. Two reasons, because "they may already have it" and
   * "it kept failing" have different remedies.
   */
  /**
   * ONE MESSAGE PER DETECTED PAID POST (2026-08-21). 133 recipients had heard from more than
   * one of our pages, many from all five, off a single paid post — because the existing
   * new-material rule is scoped to the PAIR and each sender's own first touch is exempt from
   * it. This one asks about the RECIPIENT.
   */
  [SKIP_REASONS.MATERIAL_EXHAUSTED, { material: { held: true, allowance: 1, delivered: 1, campaigns: 1 } }],
  [SKIP_REASONS.UNCERTAIN_DELIVERY, { parkedFailureCode: 'not-in-thread' }],
  [SKIP_REASONS.PARKED_FAILURE, { parkedFailureCode: 'no-composer' }],
  [SKIP_REASONS.NO_NEW_MATERIAL, { touchesSoFar: 1, unusedCampaignCount: 0 }],
  /**
   * ── UNCLAIMED POSTS EXIST AND NONE CAN BE DESCRIBED (2026-09-01) ──────────
   * The date-only fallback is deleted — a follow-up must say what the post was about, so a
   * recipient whose unclaimed posts all fail `followUpSubject` waits exactly as one with no
   * posts does. Note `unusedCampaignCount > 0`: this stop is the OTHER half of the material
   * rule, reachable only past NO_NEW_MATERIAL.
   */
  [SKIP_REASONS.NO_DESCRIBABLE_POST, { touchesSoFar: 1, unusedCampaignCount: 3, describableCampaignCount: 0 }],
  /**
   * ── A SECOND MESSAGE WITH NOTHING DIFFERENT TO SAY (2026-09-01) ───────────
   *
   * Reachable only on a FOLLOW-UP (`touchesSoFar > 0`) whose fleet has no follow-up copy —
   * which is the state the feature ships in, so this case is the shipping behaviour rather
   * than an edge. It is checked LAST in the governor on purpose: reported earlier it would
   * relabel every held follow-up in the fleet, including the ones waiting on a paid post or
   * on the ring, which is the `DIFFERENT_CATEGORY` mistake of 2026-08-31 exactly.
   */
  [SKIP_REASONS.NO_FOLLOW_UP_TEMPLATE, { touchesSoFar: 1, followUpTemplate: FOLLOW_UP_UNWRITTEN }],
  // Five per day from one account to one recipient (2026-08-18).
  [SKIP_REASONS.PAIR_DAILY_CAP, { pairSentTodayCount: 5, maxPerPairPerDay: 5 }],
  /**
   * The RING RULE (2026-08-19): the stop stays REACHABLE only when every eligible page
   * has written inside the window — built by the real predicate so this case cannot go
   * stale green.
   */
  [SKIP_REASONS.TARGET_RECENTLY_CONTACTED, { crossSpacing: RING_HOLD }],
]

describe('every governor stop is reachable and explains itself', () => {
  it('covers every value in SKIP_REASONS — nothing has been added without a case here', () => {
    const covered = new Set(GOVERNOR_CASES.map(([r]) => r))
    const all = Object.values(SKIP_REASONS)
    expect([...all].filter((r) => !covered.has(r)), 'a stop exists with no case in this file').toEqual([])
    expect(covered.size).toBe(all.length)
  })

  it.each(GOVERNOR_CASES)('produces %s, with a readable reason', (reason, over) => {
    const d = evaluatePair(governorInput(over))
    expect(d.eligible, `${reason}: this input did not trigger the stop it was written for`).toBe(false)
    if (!d.eligible) {
      expect(d.reason).toBe(reason)
      // A few governor stops are self-explanatory from the reason alone and carry no detail;
      // where a detail EXISTS it must be readable, and the reason must be a usable slug.
      expect(reason, `${reason} is not a readable slug`).toMatch(/^[a-z][a-z0-9-]+$/)
      if (d.detail !== undefined) assertReadable(`governor:${reason}`, d.detail, reason)
    }
  })

  /** And the permitting direction, so none of the above is vacuous. */
  it('permits a clean first touch', () => {
    expect(evaluatePair(governorInput()).eligible).toBe(true)
  })
})

// ── the gate: may an EXISTING draft still be sent ──────────────────────────

function gateInput(over: Record<string, unknown> = {}) {
  return {
    attemptStatus: 'READY',
    unattended: true,
    senderStatus: 'ACTIVE',
    senderHasSession: true,
    parkedFailureCode: null,
    material: { held: false as const, allowance: 1, delivered: 0 },
    targetOptedOut: false,
    targetIsWatchOnly: false,
    fleetTemplate: DEFAULT_FLEET_TEMPLATE,
    repeatsADeliveredBody: false,
    /* Empty on both sides = the DEFAULT category, i.e. the permitted case. `as` on the object
       below meant these were simply MISSING at runtime rather than type-checked in, so every
       case after the new stop threw inside `effectiveCategories` — a fixture that omits a
       required field is exactly how a guard ships half-wired (CLAUDE.md's `!== null` note). */
    senderCategories: [],
    targetCategories: [],
    targetIsVerified: true,
    targetRepliedAt: null,
    pairSentTodayCount: 0,
    maxPerPairPerDay: 5,
    crossSpacing: { held: false },
    isFollowUp: false,
    followUpCitesOnlyADate: false,
    followUpTemplate: FOLLOW_UP_WRITTEN,
    ...over,
  } as Parameters<typeof evaluateResend>[0]
}

const GATE_CASES: Array<[string, Record<string, unknown>]> = [
  [RESEND_BLOCKS.NOT_WAITING, { attemptStatus: 'SENT' }],
  [RESEND_BLOCKS.SENDER_NOT_ACTIVE, { senderStatus: 'CHALLENGED' }],
  [RESEND_BLOCKS.COHORT_NOT_CLEARED, { senderCohortCleared: false, senderCohortDetail: 'group 1 has been sending for 3 of 14 days' }],
  [RESEND_BLOCKS.TARGET_OPTED_OUT, { targetOptedOut: true }],
  [RESEND_BLOCKS.TARGET_IS_WATCH_ONLY, { targetIsWatchOnly: true }],
  /* Two fleets (2026-08-25). Empty on both sides is the DEFAULT category and permitted, so the
     trigger is an explicit membership on one side only. */
  [RESEND_BLOCKS.DIFFERENT_CATEGORY, { senderCategories: ['marketing'] }],
  /**
   * INSTAGRAM SILENTLY DROPS A BYTE-IDENTICAL REPEAT (2026-08-26). Measured: touch 1 fails
   * 5% of the time, touch 2 fails 83%, and six of six parked threads read back showed the
   * second message simply absent. The composer clears, Instagram raises no error, nothing
   * arrives — and the park is PERMANENT on the pair, so each one burns a route.
   */
  [RESEND_BLOCKS.IDENTICAL_TO_A_SENT_MESSAGE, { repeatsADeliveredBody: true }],
  /* A separate standard message per fleet (2026-08-26). Reachable when BOTH ends are in a
     second fleet — so the category rule permits the route — and that fleet's copy is unwritten,
     which is the state Tabish asked for ("keep it empty for now"). Built by the REAL rule. */
  [
    RESEND_BLOCKS.FLEET_TEMPLATE_NOT_SET,
    {
      senderCategories: ['marketing'],
      targetCategories: ['marketing'],
      fleetTemplate: templateForSettings(
        { singleTemplateBody: null, fleetTemplateBodies: new Map() },
        ['marketing'],
        ['marketing'],
      ),
    },
  ],
  // Verified only (2026-08-20). NULL is refused too — see the second case.
  [RESEND_BLOCKS.TARGET_NOT_VERIFIED, { targetIsVerified: false }],
  [RESEND_BLOCKS.TARGET_REPLIED, { targetRepliedAt: new Date('2026-08-19T12:00:00Z') }],
  /**
   * ── THE DUPLICATE GUARD (2026-08-21) ──────────────────────────────────────
   * A parked FAILED attempt was invisible to both the pending count and the touch count, so
   * the pair looked untouched and the planner drafted a fresh FIRST touch. MEASURED:
   * @indiagatefoods received the identical message twice, and @sohamrockstrent collected six
   * parked drafts at three attempts each. Two reasons, because "they may already have it" and
   * "it kept failing" have different remedies.
   */
  /**
   * ONE MESSAGE PER DETECTED PAID POST (2026-08-21). 133 recipients had heard from more than
   * one of our pages, many from all five, off a single paid post — because the existing
   * new-material rule is scoped to the PAIR and each sender's own first touch is exempt from
   * it. This one asks about the RECIPIENT.
   */
  [RESEND_BLOCKS.MATERIAL_EXHAUSTED, { material: { held: true, allowance: 1, delivered: 1, campaigns: 1 } }],
  [RESEND_BLOCKS.UNCERTAIN_DELIVERY, { parkedFailureCode: 'not-in-thread' }],
  [RESEND_BLOCKS.PARKED_FAILURE, { parkedFailureCode: 'no-composer' }],
  [RESEND_BLOCKS.NO_SESSION, { senderHasSession: false }],
  // Five per day from one account to one recipient (2026-08-18).
  [RESEND_BLOCKS.PAIR_DAILY_CAP, { pairSentTodayCount: 5, maxPerPairPerDay: 5 }],
  // The ring rule (2026-08-19): reachable only when every page has written in-window.
  [RESEND_BLOCKS.TARGET_RECENTLY_CONTACTED, { crossSpacing: RING_HOLD }],
  /**
   * ── A FOLLOW-UP DRAFT WITH NO FOLLOW-UP MESSAGE (2026-09-01) ─────────────
   *
   * The gate's end of the governor's twin above. Reachable only on a draft whose stored
   * `touchNumber > 1` — a first touch never sees it, which is what makes an unwritten
   * follow-up leave first-touch sending byte-for-byte as it was.
   */
  [RESEND_BLOCKS.FOLLOW_UP_TEMPLATE_NOT_SET, { isFollowUp: true, followUpTemplate: FOLLOW_UP_UNWRITTEN }],
  /**
   * A pre-rule draft whose stored bytes cite only a date ("your placement on 31 Aug") —
   * 25 were waiting when the subject became required (2026-09-01). Recognised from the
   * BYTES, never recomposed, because an operator may have edited the draft.
   */
  [RESEND_BLOCKS.FOLLOW_UP_CITES_ONLY_A_DATE, { isFollowUp: true, followUpCitesOnlyADate: true }],
]

describe('every gate stop is reachable and explains itself', () => {
  it('covers every value in RESEND_BLOCKS', () => {
    const covered = new Set(GATE_CASES.map(([r]) => r))
    const all = Object.values(RESEND_BLOCKS)
    expect([...all].filter((r) => !covered.has(r)), 'a gate stop exists with no case here').toEqual([])
  })

  it.each(GATE_CASES)('produces %s, with a readable reason', (reason, over) => {
    const r = evaluateResend(gateInput(over))
    expect(r.ok, `${reason}: this input did not trigger the stop it was written for`).toBe(false)
    if (!r.ok) {
      expect(r.reason).toBe(reason)
      assertReadable(`gate:${reason}`, r.detail, reason)
    }
  })

  it('permits a clean unattended send', () => {
    expect(evaluateResend(gateInput()).ok).toBe(true)
  })

  /**
   * The closed whitelist, asserted as a SET rather than described in prose.
   *
   * A redesign that adds an "override" affordance to a new screen must not be able to widen
   * what a human may cross. Every absolute stop is absolute because of a specific argument
   * recorded in `gate.ts`; this is the machine-checkable version of that argument.
   */
  it('lets a person cross exactly the timing stops, and nothing else', () => {
    expect([...OVERRIDABLE_BLOCKS].sort()).toEqual([RESEND_BLOCKS.TARGET_REPLIED].sort())
  })

  /**
   * AND THE OVERRIDE IS INERT ON THE NEW STOP, driven rather than asserted from the set
   * above. `OVERRIDABLE_BLOCKS` being a closed whitelist is the mechanism; this is the
   * behaviour, and it is what a future "let me send it anyway" button would actually hit.
   * The copy a company receives is not a timing question, so no acknowledgement crosses it.
   */
  /**
   * AND NOT OVERRIDABLE. A repeat is not a timing question — Instagram drops it whoever
   * pressed the button — so no acknowledgement crosses it.
   */
  it('refuses to let anyone override a repeat of a message they already have', () => {
    const r = evaluateResend(
      gateInput({ repeatsADeliveredBody: true, unattended: false, overrides: [RESEND_BLOCKS.IDENTICAL_TO_A_SENT_MESSAGE] }),
    )
    expect(r.ok, 'an override sent a message Instagram will silently drop').toBe(false)
    if (!r.ok) expect(r.reason).toBe(RESEND_BLOCKS.IDENTICAL_TO_A_SENT_MESSAGE)
  })

  it('refuses to let anyone override a missing follow-up message', () => {
    const r = evaluateResend(
      gateInput({
        isFollowUp: true,
        followUpTemplate: FOLLOW_UP_UNWRITTEN,
        unattended: false,
        overrides: [RESEND_BLOCKS.FOLLOW_UP_TEMPLATE_NOT_SET],
      }),
    )
    expect(r.ok, 'an override sent a second message with no second message written').toBe(false)
    if (!r.ok) expect(r.reason).toBe(RESEND_BLOCKS.FOLLOW_UP_TEMPLATE_NOT_SET)
  })

  it('refuses to let anyone override a fleet with no standard message', () => {
    const held = {
      senderCategories: ['marketing'],
      targetCategories: ['marketing'],
      fleetTemplate: templateForSettings(
        { singleTemplateBody: null, fleetTemplateBodies: new Map() },
        ['marketing'],
        ['marketing'],
      ),
      unattended: false,
      overrides: [RESEND_BLOCKS.FLEET_TEMPLATE_NOT_SET],
    }
    const r = evaluateResend(gateInput(held))
    expect(r.ok, 'an override crossed a stop about WHAT the message says').toBe(false)
    if (!r.ok) expect(r.reason).toBe(RESEND_BLOCKS.FLEET_TEMPLATE_NOT_SET)
  })

  /**
   * ── AND EVERY GATE STOP MUST HAVE SOMEWHERE TO SEND THE OPERATOR ──────────
   *
   * The rest of this file proves a refusal can EXPLAIN itself. That is a floor, and on
   * 2026-08-06 it turned out not to be enough: all four waiting drafts would have been
   * refused, every explanation existed inside `gate.ts` — and none of them reached a screen.
   * The card rendered a Send button and said nothing.
   *
   * So the reason now renders on the draft, and `REMEDIES` says where to fix it. This asserts
   * the map is TOTAL over `RESEND_BLOCKS`, which makes adding a stop force the question "and
   * what does a person do about this?" rather than leaving it to be noticed later.
   *
   * `href: null` is a legitimate answer — the pair allowance clears by waiting — so what is
   * checked is that a DECISION EXISTS, not that a link does.
   */
  it('every gate stop has a rendering path and a decided remedy', () => {
    const missing = Object.values(RESEND_BLOCKS).filter((code) => remedyFor(code) === null)
    expect(missing, 'a gate stop can refuse a draft with nothing on screen about what to do').toEqual([])

    for (const code of Object.values(RESEND_BLOCKS)) {
      const r = remedyFor(code)!
      expect(r.label.length, `${code}: the remedy label is too short to be an instruction`).toBeGreaterThan(10)
      // The operator-facing label must not leak the machine code, exactly as `detail` must not.
      expect(r.label, `${code}: the raw code leaked into the remedy label`).not.toContain(code)
    }
  })

  /** The pair cap clears by waiting, so its remedy is deliberately a sentence with no link. */
  it('the pair daily cap has a decided no-link remedy', () => {
    const r = remedyFor(RESEND_BLOCKS.PAIR_DAILY_CAP)!
    expect(r.href).toBeNull()
    expect(r.label).toBe('The allowance resets at midnight IST.')
  })

  /** Not vacuous: an unknown code must come back with no remedy rather than a wrong one. */
  it('an unrecognised reason gets no link rather than a misleading one', () => {
    expect(remedyFor('something-nobody-has-written-yet')).toBeNull()
    expect(remedyFor(null)).toBeNull()
  })

  /**
   * ── AND THE WHOLE SENTENCE, AS AN OPERATOR WOULD READ IT ──────────────────
   *
   * Only ONE of these is reachable from the live database at a time, so the others
   * can only be read here. That matters: the first version rendered
   *
   *     This cannot be sent yet. account is not connected Sign this account in
   *
   * — lowercase mid-sentence, no separator before the link — and every assertion in this file
   * was green. It was found by opening the page. This is the version of that reading which
   * covers the cases a browser cannot show today.
   */
  it.each(GATE_CASES)('%s reads as a finished sentence on the card', (reason, over) => {
    const r = evaluateResend(gateInput(over))
    expect(r.ok).toBe(false)
    if (r.ok) return

    const sentence = asSentence(r.detail)!
    expect(sentence, `${reason}: nothing to render`).toBeTruthy()
    expect(sentence[0], `${reason}: starts lower-case, so it reads as a fragment`).toBe(sentence[0]!.toUpperCase())
    expect(sentence, `${reason}: does not end in a full stop, so it runs into the remedy link`).toMatch(/[.!?]$/)
    expect(sentence, `${reason}: the machine code leaked into what a person reads`).not.toContain(reason)

    // And what the card actually renders, assembled the way the component assembles it.
    const rendered = `This cannot be sent yet. ${sentence} ${remedyFor(reason)!.label}`
    expect(rendered).not.toMatch(/\.\s*[a-z]/) // no lower-case start after any full stop
    expect(rendered).not.toMatch(/\s{2,}/) // no double spaces where a separator was forgotten
  })

  /**
   * ── AND NO SHELL COMMAND REACHES THE SCREEN ───────────────────────────────
   *
   * The live value of `OutreachAttempt.error` on 2026-08-06 ended `Run: pnpm ig:login
   * tabishmukaddam1`, and it was rendering on the draft card. "Never put a shell command on the
   * page" is a rule with a history here — the deleted "Needs you" list read `Send the next one:
   * pnpm send` — and the dashboard has a Connect button for exactly this.
   *
   * Both directions, because the danger is a stripper that eats the evidence: what must survive
   * is everything the operator needs to know about what happened.
   */
  it('strips a trailing shell instruction and keeps the evidence', () => {
    expect(withoutShellCommand('Chrome profile for @x is not logged in. Run: pnpm ig:login x')).toBe(
      'Chrome profile for @x is not logged in.',
    )
    expect(withoutShellCommand('Something failed. Run `pnpm ig:login x`')).toBe('Something failed.')
    expect(withoutShellCommand('Something failed. run pnpm send')).toBe('Something failed.')
  })

  it('leaves an error with no command completely alone', () => {
    const real = 'the message cleared the composer but never appeared in the thread'
    expect(withoutShellCommand(real)).toBe(real)
    expect(withoutShellCommand('Instagram showed a checkpoint')).toBe('Instagram showed a checkpoint')
    // "run" as an ordinary word must not trigger it.
    expect(withoutShellCommand('the slot could not run')).toBe('the slot could not run')
    expect(withoutShellCommand(null)).toBeNull()
  })

  it('formatting changes punctuation and never words', () => {
    expect(asSentence('account is not connected')).toBe('Account is not connected.')
    // Already terminated: not double-punctuated.
    expect(asSentence('Already done.')).toBe('Already done.')
    // Nothing to say is null, never an empty sentence rendered as a stray full stop.
    expect(asSentence(null)).toBeNull()
    expect(asSentence('   ')).toBeNull()
    // The words survive intact.
    const long = 'they replied at 2026-07-31T08:22:58.857Z — outreach to this channel is halted'
    expect(asSentence(long)!.slice(1)).toBe(long.slice(1) + '.')
  })

  it('keeps every absolute stop out of the whitelist', () => {
    const absolute = [
      RESEND_BLOCKS.SENDER_NOT_ACTIVE,
      RESEND_BLOCKS.TARGET_OPTED_OUT,
      RESEND_BLOCKS.NO_SESSION,
      // The last bound on volume: crossing it has no bound at all.
      RESEND_BLOCKS.PAIR_DAILY_CAP,
      /**
       * Crossing this would put a second of our pages in an inbox the first one reached
       * hours ago — the cross-account fingerprint the fleet design exists to avoid, and
       * a fact about the RECIPIENT rather than about timing.
       */
      RESEND_BLOCKS.TARGET_RECENTLY_CONTACTED,
      RESEND_BLOCKS.COHORT_NOT_CLEARED,
      RESEND_BLOCKS.NOT_WAITING,
      // WHO the recipient is, not WHEN — a watched competitor is never a prospect.
      RESEND_BLOCKS.TARGET_IS_WATCH_ONLY,
      /* WHICH FLEET the recipient belongs to. A recipient that genuinely belongs to both is
         put in both categories; that is the supported answer, not an override. */
      RESEND_BLOCKS.DIFFERENT_CATEGORY,
      /* WHAT THE MESSAGE SAYS. There are no bytes to send, so there is nothing to cross —
         the remedy is a textarea, exactly as for the standard message above. */
      RESEND_BLOCKS.FOLLOW_UP_TEMPLATE_NOT_SET,
    ]
    for (const code of absolute) {
      expect(OVERRIDABLE_BLOCKS, `${code} must never be crossable`).not.toContain(code)
    }
  })
})

// ── the brand-only guards ──────────────────────────────────────────────────

describe('the brand guards explain themselves', () => {
  it('the new-brand daily cap', () => {
    const r = checkNewBrandTouchCap({
      isFirstTouch: true,
      waitingFirstTouches: 2,
      maxWaitingNewBrandDrafts: 2,
      firstTouchesDeliveredToday: 0,
      maxNewBrandTouchesPerDay: 2,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason).toBe(BRAND_BLOCKS.NEW_BRAND_DAILY_CAP)
      assertReadable('brand:cap', r.detail, r.reason)
    }
  })

  /**
   * The category rule: a "brand" whose Instagram category names a PROFESSION is a person,
   * and a media-buying pitch to a person is the wrong message. (The persona gate that used
   * to sit beside this went on 2026-08-18 — nothing persona-shaped renders any more.)
   */
  it('the recipient-is-a-person guard', () => {
    const r = checkRecipientIsNotAPerson({
      targetKind: 'BRAND',
      brandCategory: 'Film Director',
      handle: 'somedirector',
      campaignTalent: false,
    })
    expect(r.ok, 'the person guard did not fire on a Film Director category').toBe(false)
    if (!r.ok) {
      expect(r.reason).toBe(BRAND_BLOCKS.RECIPIENT_IS_A_PERSON)
      assertReadable('brand:person', r.detail, r.reason)
    }
  })

  it('permits a company category', () => {
    expect(
      checkRecipientIsNotAPerson({
        targetKind: 'BRAND',
        brandCategory: 'Grocery & Convenience Stores',
        handle: 'royalcanin.india',
        campaignTalent: false,
      }).ok,
    ).toBe(true)
  })
})

// ── the dispatcher's own reasons ───────────────────────────────────────────

describe('every dispatcher hold explains itself', () => {
  const base = {
    autopilotEnabled: true,
    istHour: 14,
    waitingCount: 3,
    minutesSinceLastSend: 60,
    breaker: { tripped: false } as ReturnType<typeof assessBreaker>,
  }

  const CASES: Array<[string, Record<string, unknown>]> = [
    ['autopilot-off', { autopilotEnabled: false }],
    /**
     * Production is 24/7 since 2026-08-19 (Tabish removed the window), so the stop is
     * reached by passing an explicit window rather than by relying on the constants — the
     * branch still exists and must still explain itself if the window is ever restored.
     */
    ['outside-active-hours', { istHour: 3, activeFromHour: 10, activeToHour: 21 }],
    ['nothing-waiting', { waitingCount: 0 }],
    /**
     * DERIVED FROM THE CONSTANT, not the literal `1` it used to be. That literal produced
     * `too-soon` only while the gap was larger than one minute, and it stopped doing so
     * the moment Tabish asked for one-minute sending (2026-08-19) — so this case silently
     * stopped exercising the stop it names. A fixture that pins a number the rule owns
     * goes stale the first time the rule changes.
     */
    ['too-soon', { minutesSinceLastSend: FLEET_MIN_GAP_MINUTES - 1 }],
  ]

  it.each(CASES)('produces %s, with a readable reason', (reason, over) => {
    const v = decideDispatch({ ...base, ...over } as Parameters<typeof decideDispatch>[0])
    expect(v.action, `${reason}: this input did not hold`).toBe('hold')
    if (v.action === 'hold') {
      expect(v.reason).toBe(reason)
      assertReadable(`dispatch:${reason}`, v.detail, reason)
    }
  })

  it('permits a send when everything is clear', () => {
    expect(decideDispatch(base as Parameters<typeof decideDispatch>[0]).action).toBe('send')
  })

  /** Both breaker signals, and the release. */
  it('the breaker explains both of its signals', () => {
    const challenged = assessBreaker({
      challengedInWindow: 1,
      notInThreadInWindow: 0,
      deliveredInWindow: 10,
      manualPause: null,
    })
    expect(challenged.tripped).toBe(true)
    if (challenged.tripped) assertReadable('breaker:challenged', challenged.detail, challenged.reason)

    const rate = assessBreaker({
      challengedInWindow: 0,
      notInThreadInWindow: 5,
      deliveredInWindow: 10,
      manualPause: null,
    })
    expect(rate.tripped).toBe(true)
    if (rate.tripped) assertReadable('breaker:rate', rate.detail, rate.reason)
  })

  it('the breaker is releasable — it does not trip on a healthy fleet', () => {
    const ok = assessBreaker({
      challengedInWindow: 0,
      notInThreadInWindow: 0,
      deliveredInWindow: 10,
      manualPause: null,
    })
    expect(ok.tripped).toBe(false)
  })
})

// ── failure codes ─────────────────────────────────────────────────────────

describe('every failure code is documented for a person', () => {
  /**
   * `failureCode` is what a later retry policy reads, and `not-in-thread` is categorically
   * different from the rest — it is the only one where the recipient may actually HAVE the
   * message. A redesign must keep that distinction visible, so the set is pinned here.
   */
  it('is a closed set, and not-in-thread is in it', () => {
    expect(FAILURE_CODES).toContain('not-in-thread')
    // 'unreadable' (2026-09-02): a pre-send READ that could not vouch for the thread — no send
    // attempted — so it must not wear a send-failure code or retire the pair. 10 → 11.
    expect(FAILURE_CODES).toContain('unreadable')
    expect(FAILURE_CODES.length).toBe(11)
    for (const c of FAILURE_CODES) expect(c).toMatch(/^[a-z][a-z0-9-]+$/)
  })

  /**
   * DELIBERATE WIDENING, 2026-08-06 (simple-sender plan §3.5): `logged-out` and
   * `two-factor` split out of `navigation`. That one code meant four different things —
   * 2FA wanted, session expired, wrong account, could-not-reach-Instagram — of which only
   * the last is retryable, so a dead session was retried every fifteen minutes forever
   * while the dashboard said "connected". The two human-fixable failures now carry their
   * own codes, and `logged-out` is also recorded on the account through
   * `markSessionInvalid`, which the gate folds into the existing `no-session` stop.
   */
  it('a dead session and a 2FA prompt are distinguishable from a network blip', () => {
    expect(FAILURE_CODES).toContain('logged-out')
    expect(FAILURE_CODES).toContain('two-factor')
    expect(FAILURE_CODES).toContain('navigation')
  })
})

// ── the rules a person MAY cross ───────────────────────────────────────────

/**
 * ── THE OTHER HALF OF THE INVENTORY, WHICH DID NOT HAVE ONE ───────────────────────────
 *
 * Everything above pins the stops that REFUSE. The rules a person may CROSS had no such
 * net, and it showed: `/rules` described them in one hand-written sentence which still
 * named **"the route being off"** — `PAIR_DISABLED`, deleted on 2026-08-08 with the
 * per-route chip. The page that exists to say what the system will and will not do was
 * offering a reader a rule that does not exist.
 *
 * `CROSSABLE_RULES` is now the declared set and `/rules` renders labels TOTAL over it, so a
 * missing sentence is a compile error. That covers "a key with no label". It does NOT cover
 * the direction that actually broke — a warning `describeOnDemand` emits under a code that
 * is not in the set at all, which would be silently absent from the page. So this drives
 * every warning to fire and asserts each reason is a declared one.
 *
 * (2026-08-18: COOLDOWN_ACTIVE and UNANSWERED_TOUCH_LIMIT left the set with the caps they
 * described — four rules remain crossable.)
 *
 * Mutation-tested: adding a warning with a fresh literal reason fails here, and removing an
 * entry from `CROSSABLE_RULES` fails here too.
 */
describe('every rule a person may cross is declared, and the page can name it', () => {
  const DECLARED = new Set<string>(Object.values(CROSSABLE_RULES))

  /** Facts chosen so that EVERY warning fires at once. */
  const allWarnings = describeOnDemand({
    now: NOW,
    senderStatus: 'ACTIVE',
    senderHasSession: true,
    targetOptedOut: false,
    pairSentTodayCount: 0,
    maxPerPairPerDay: 5,
    isSelfSend: false,
    followUpTemplateSet: true,
    touchesSoFar: 3,
    targetRepliedAt: new Date(NOW.getTime() - 3_600_000),
    pendingAttemptCount: 1,
    unusedCampaignCount: 0,
    totalInFlight: 6,
    maxTotalSends: 6,
  }).warnings

  it('the declared set is exactly the four surviving rules', () => {
    expect([...DECLARED].sort()).toEqual(
      ['target-replied', 'no-new-material', 'pending-attempt-exists', 'lifetime-send-cap-reached'].sort(),
    )
  })

  it('produces every declared rule, so none of them is unreachable', () => {
    const seen = new Set(allWarnings.map((w) => w.reason))
    for (const code of DECLARED) {
      expect(seen, `${code} is declared crossable and no input produces it`).toContain(code)
    }
  })

  it('produces nothing that is NOT declared — an undeclared warning is missing from /rules', () => {
    for (const w of allWarnings) {
      expect(DECLARED, `warning "${w.reason}" is emitted but not in CROSSABLE_RULES`).toContain(w.reason)
    }
  })

  it('every one of them still explains itself in English', () => {
    for (const w of allWarnings) assertReadable(`crossable:${w.reason}`, w.text, w.reason)
  })

  /**
   * The deleted control, named. A grep rather than a set check, because the failure was
   * PROSE on a page: someone re-adding the sentence would not touch `CROSSABLE_RULES`.
   *
   * COMMENTS ARE STRIPPED FIRST, and that is the point rather than a convenience. The first
   * version of this test grepped the whole file and FAILED — on the comment written directly
   * above the fix, which quotes the deleted wording in order to explain why it went. A grep
   * that cannot tell rendered text from an explanation of rendered text is measuring the
   * wrong bytes, and the safe-looking response (reword the comment) would leave the next
   * person unable to write down the history at all.
   */
  it('no rendered text on /rules names the per-route switch, deleted on 2026-08-08', () => {
    const page = readFileSync(join(ROOT_DIR, 'src/app/rules/page.tsx'), 'utf8')
    const rendered = page.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    expect(rendered).not.toMatch(/route being off|route is switched off|pair-disabled/i)
    // and the strip must not have eaten everything, which would pass vacuously
    expect(rendered).toContain('CROSSABLE_LABELS')
  })
})
