import { describe, it, expect } from 'vitest'
import { evaluatePair, SKIP_REASONS } from '@/outreach/governor'
import { evaluateResend, RESEND_BLOCKS, OVERRIDABLE_BLOCKS } from '@/outreach/gate'
import { BRAND_BLOCKS, checkNewBrandTouchCap, checkPersonaDistinct } from '@/outreach/brandGuards'
import { decideDispatch, assessBreaker } from '@/outreach/pacing'
import { FAILURE_CODES } from '@/lib/constants'
import { asSentence, remedyFor, withoutShellCommand } from '@/app/messages/remedy'
import { describeOnDemand, CROSSABLE_RULES } from '@/outreach/onDemand'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT_DIR = resolve(__dirname, '..')

/**
 * ── THE STOP INVENTORY — the safety net for the dashboard redesign ─────────
 *
 * Every refusal in this system is a SENTENCE ON A SCREEN. There are 11 governor stops, 10
 * gate stops, 2 brand guards, 7 pacing reasons and 8 failure codes, and each one exists
 * because *"nothing happened" with no explanation* is the failure this project keeps
 * rediscovering. Three of those explanations were added or fixed on 2026-08-05 alone, and one
 * of them had never reached a screen at all despite a docblock claiming it did.
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

function governorInput(over: Record<string, unknown> = {}) {
  return {
    now: NOW,
    pair: { cooldownDays: 7, maxUnansweredTouches: 3 },
    sender: { status: 'ACTIVE', dailyCap: 5 },
    target: { optedOut: false },
    lastSentAt: null,
    touchesSoFar: 0,
    targetRepliedAt: null,
    hasPendingAttempt: false,
    unusedCampaignCount: 5,
    targetSentTodayCount: 0,
    senderSentTodayCount: 0,
    maxPerTargetPerDay: 2,
    totalSentEver: 0,
    maxTotalSends: null,
    ...over,
  } as Parameters<typeof evaluatePair>[0]
}

/** One input per stop, each chosen to trigger exactly that stop. */
const GOVERNOR_CASES: Array<[string, Record<string, unknown>]> = [
  [SKIP_REASONS.LIFETIME_CAP, { totalSentEver: 1, maxTotalSends: 1 }],
  // PAIR_DISABLED is GONE (one switch, 2026-08-08). Routes are not chosen any more — they
  // exist — so there is no per-route "off" for the governor to report. Retirement is
  // `target.optedOut`, which is the next case and is checked independently of any pair row.
  [SKIP_REASONS.TARGET_OPTED_OUT, { target: { optedOut: true } }],
  [SKIP_REASONS.SENDER_NOT_ACTIVE, { sender: { status: 'CHALLENGED', dailyCap: 5 } }],
  [SKIP_REASONS.TARGET_REPLIED, { targetRepliedAt: new Date('2026-08-19T12:00:00Z') }],
  [SKIP_REASONS.PENDING_ATTEMPT, { hasPendingAttempt: true }],
  [SKIP_REASONS.UNANSWERED_LIMIT, { touchesSoFar: 3 }],
  [SKIP_REASONS.COOLDOWN_ACTIVE, { touchesSoFar: 1, lastSentAt: new Date('2026-08-19T12:00:00Z') }],
  // The 2026-08-17 duplicate incident: a DIFFERENT page delivered to this recipient half
  // an hour ago, so this pair — fresh, touchesSoFar 0 — must still wait out the window.
  [SKIP_REASONS.TARGET_RECENTLY_CONTACTED, { targetLastDeliveredAt: new Date(NOW.getTime() - 30 * 60_000) }],
  [SKIP_REASONS.NO_NEW_MATERIAL, { touchesSoFar: 1, lastSentAt: new Date('2026-08-01T12:00:00Z'), unusedCampaignCount: 0 }],
  [SKIP_REASONS.TARGET_DAILY_CAP, { targetSentTodayCount: 2, maxPerTargetPerDay: 2 }],
  [SKIP_REASONS.SENDER_DAILY_CAP, { senderSentTodayCount: 5 }],
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
    senderDailyCap: 5,
    targetOptedOut: false,
    targetIsWatchOnly: false,
    targetRepliedAt: null,
    targetSentTodayCount: 0,
    senderSentTodayCount: 0,
    maxPerTargetPerDay: 2,
    personaSharedWithAnotherSender: false,
    draftPersonaStale: false,
    ...over,
  } as Parameters<typeof evaluateResend>[0]
}

const GATE_CASES: Array<[string, Record<string, unknown>]> = [
  [RESEND_BLOCKS.NOT_WAITING, { attemptStatus: 'SENT' }],
  [RESEND_BLOCKS.SENDER_NOT_ACTIVE, { senderStatus: 'CHALLENGED' }],
  [RESEND_BLOCKS.COHORT_NOT_CLEARED, { senderCohortCleared: false, senderCohortDetail: 'group 1 has been sending for 3 of 14 days' }],
  [RESEND_BLOCKS.TARGET_OPTED_OUT, { targetOptedOut: true }],
  [RESEND_BLOCKS.TARGET_IS_WATCH_ONLY, { targetIsWatchOnly: true }],
  [RESEND_BLOCKS.TARGET_REPLIED, { targetRepliedAt: new Date('2026-08-19T12:00:00Z') }],
  [RESEND_BLOCKS.NO_SESSION, { senderHasSession: false }],
  [RESEND_BLOCKS.PERSONA_NOT_DISTINCT, { personaSharedWithAnotherSender: true }],
  [RESEND_BLOCKS.PERSONA_CHANGED_SINCE_DRAFT, { draftPersonaStale: true }],
  [RESEND_BLOCKS.HOOK_STALE_SINCE_DRAFT, { draftHookStale: true }],
  [RESEND_BLOCKS.TARGET_RECENTLY_CONTACTED, { targetRecentContact: { fromHandle: 'bollywoodchronicle', hoursAgo: 0.5 } }],
  [RESEND_BLOCKS.TARGET_DAILY_CAP, { targetSentTodayCount: 2 }],
  [RESEND_BLOCKS.SENDER_DAILY_CAP, { senderSentTodayCount: 5 }],
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
   * `href: null` is a legitimate answer — a daily cap clears by waiting — so what is checked
   * is that a DECISION EXISTS, not that a link does.
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

  /** Not vacuous: an unknown code must come back with no remedy rather than a wrong one. */
  it('an unrecognised reason gets no link rather than a misleading one', () => {
    expect(remedyFor('something-nobody-has-written-yet')).toBeNull()
    expect(remedyFor(null)).toBeNull()
  })

  /**
   * ── AND THE WHOLE SENTENCE, AS AN OPERATOR WOULD READ IT ──────────────────
   *
   * Only ONE of these ten is reachable from the live database at a time, so the other
   * nine can only be read here. That matters: the first version rendered
   *
   *     This cannot be sent yet. account is not connected Sign this account in
   *
   * — lowercase mid-sentence, no separator before the link — and every assertion in this file
   * was green. It was found by opening the page. This is the version of that reading which
   * covers the eleven cases a browser cannot show today.
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
      RESEND_BLOCKS.TARGET_DAILY_CAP,
      RESEND_BLOCKS.SENDER_DAILY_CAP,
      RESEND_BLOCKS.PERSONA_NOT_DISTINCT,
      RESEND_BLOCKS.COHORT_NOT_CLEARED,
      RESEND_BLOCKS.PERSONA_CHANGED_SINCE_DRAFT,
      // Same family: the message is wrong for its recipient, not merely early.
      RESEND_BLOCKS.HOOK_STALE_SINCE_DRAFT,
      RESEND_BLOCKS.NOT_WAITING,
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

  it('the persona gate', () => {
    const persona = {
      personaName: 'Kapil Jain',
      personaRole: 'Co-founder',
      personaBrand: 'Bollywood Society',
      personaPhone: '+91 60000 189766',
      personaEmail: 'kapil@digitalsukoon.com',
    }
    const r = checkPersonaDistinct({
      persona,
      otherPersonas: [persona],
      targetKind: 'CHANNEL',
      gateChannels: true,
    })
    expect(r.ok, 'the persona gate did not fire on two identical personas').toBe(false)
    if (!r.ok) {
      expect(r.reason).toBe(BRAND_BLOCKS.PERSONA_NOT_DISTINCT)
      assertReadable('brand:persona', r.detail, r.reason)
    }
  })

  it('permits a distinct persona', () => {
    const mine = {
      personaName: 'A Name',
      personaRole: 'Founder',
      personaBrand: 'Brand One',
      personaPhone: '+91 90000 00001',
      personaEmail: 'a@example.com',
    }
    const other = { ...mine, personaName: 'Another Name', personaEmail: 'b@example.com' }
    expect(checkPersonaDistinct({ persona: mine, otherPersonas: [other], targetKind: 'BRAND', gateChannels: true }).ok).toBe(true)
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
    ['outside-active-hours', { istHour: 3 }],
    ['nothing-waiting', { waitingCount: 0 }],
    ['too-soon', { minutesSinceLastSend: 1 }],
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
    expect(FAILURE_CODES.length).toBe(10)
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
    senderPersonaProblems: [],
    targetOptedOut: false,
    targetSentTodayCount: 0,
    senderSentTodayCount: 0,
    senderDailyCap: 5,
    maxPerTargetPerDay: 2,
    isSelfSend: false,
    cooldownDays: 7,
    lastSentAt: new Date(NOW.getTime() - 86_400_000), // yesterday: inside the 7-day spacing
    touchesSoFar: 3,
    maxUnansweredTouches: 3,
    targetRepliedAt: new Date(NOW.getTime() - 3_600_000),
    pendingAttemptCount: 1,
    unusedCampaignCount: 0,
    totalInFlight: 6,
    maxTotalSends: 6,
  }).warnings

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
