import type { GovernorInput } from '@/outreach/governor'
import { RESEND_BLOCKS, type ResendInput } from '@/outreach/gate'
import { crossSpacingVerdict, type CrossSpacingVerdict } from '@/outreach/crossSpacing'
import { materialAllowance, type MaterialVerdict } from '@/outreach/materialAllowance'
import { templateForSettings, type FleetTemplate } from '@/outreach/fleetTemplate'
import { followUpForSettings, isFollowUp, type FollowUpTemplate } from '@/outreach/followUpTemplate'

/**
 * A DETERMINISTIC CORPUS OF RULE-FACT CASES, for pinning every verdict `evaluatePair` and
 * `evaluateResend` give today (Stage 0 of the outreach redesign, 2026-10-15).
 *
 * ── WHAT A CASE IS ─────────────────────────────────────────────────────────
 *
 * One flat, JSON-serialisable record of FACT CHOICES — never a built input. `toGovernorInput`
 * and `toResendInput` turn a case into the two real input shapes, building the compound
 * fields (`fleetTemplate`, `followUpTemplate`, `crossSpacing`, `material`) with the REAL
 * helpers the planner and the gate call, so a case cannot drift from what those helpers
 * produce. A hand-written verdict literal goes stale GREEN the day the helper changes shape,
 * which is `tests/stopInventory.test.ts`'s own recorded lesson.
 *
 * The two input shapes share most of their facts and differ in a few (the governor has
 * `touchesSoFar`/`hasPendingAttempt`/`totalSentEver`; the gate has `attemptStatus`/
 * `unattended`/`overrides`/the cohort/`senderHasSession`/the categories/`isFollowUp`/the two
 * stored-bytes facts), so ONE case feeds BOTH functions and the golden records both verdicts.
 *
 * ── IMPOSSIBLE COMBINATIONS ARE INCLUDED ON PURPOSE ─────────────────────────
 *
 * `unreadable` never reaches either function in production (the parks query and `splitParks`
 * both drop it); a `pairSentTodayCount` of 1 with `touchesSoFar` 0 cannot happen (a delivery
 * is a touch); the gate's `isFollowUp` is set to disagree with its own derivation in some
 * cases; `BOGUS` is not an attempt status at all. They pin TODAY's behaviour for those inputs
 * too: a refactor that collapses the two functions into one evaluator must answer every
 * input identically, reachable or not, or say why it changed. `BOGUS` in particular pins
 * that `NOT_WAITING` is an ALLOW-list (`READY`/`QUEUED` may send) and not a deny-list of the
 * statuses somebody remembered — a deny-list would pass an unknown status straight through.
 *
 * ── HOW IT IS GENERATED ────────────────────────────────────────────────────
 *
 *   (baselines) the clean first touch itself, the follow-up baseline and the attended
 *       on-demand baseline — the three starting points below, each pinned as a case.
 *   (a) every single-field deviation from the baseline clean first touch,
 *   (b) every PAIR of deviations (one value from each of two different fields),
 *   (c) `RANDOM_CASES` seeded pseudo-random SPARSE deviations: each field independently
 *       leaves its baseline with probability `RANDOM_DEVIATION_RATE`, so a case carries a
 *       handful of deviations and the three- and four-way interactions that reach the DEEP
 *       stops (the follow-up family, the caps, the ring rule) actually occur. Never
 *       `Math.random`, because a corpus that differs between runs cannot have a golden —
 *       and never a shared LCG stream, see below.
 *   (d) the same singles and pairs from a FOLLOW-UP baseline (`touchesSoFar` 1), restricted
 *       to the fields a follow-up's stops read — the five follow-up stops are ordered among
 *       themselves and against the ring rule and the pair cap, and (a)–(c) reach each of
 *       them only a handful of times because so many earlier stops fire first.
 *   (e) the ATTENDED slices — a present person, as the on-demand dialog sends. From the
 *       attended-with-reply baseline (`unattended: false`, a recent reply, the reply halt
 *       acknowledged): singles over EVERY field, and pairs of `overrides` × every other field.
 *       From the plain attended baseline (`unattended: false`, nothing else): pairs of
 *       `overrides` × every other field. From the attended FOLLOW-UP baseline
 *       (`unattended: false`, `touchesSoFar` 1): singles and `overrides` pairs over the
 *       follow-up fields. The only overridable stop is `TARGET_REPLIED`, and an override only
 *       DOES anything when three fields leave their baselines together — so (a)–(d) never
 *       exercised it: every override they carried was dropped by `unattended: true` or met no
 *       reply to cross. These slices are what prove the gate gets PAST the reply halt on the
 *       acknowledgement, and that every ABSOLUTE stop named in the `overrides` dimension stays
 *       absolute when its own name is passed — alone, from the plain baseline, where no reply
 *       halt sits in front of it; and beside a crossed reply halt, from the reply baseline.
 *
 * ── THE RANDOM SLICE DRAWS EACH FIELD FROM ITS OWN HASH ─────────────────────
 *
 * The first version drew `values[lcg() % values.length]` from one shared LCG stream, and a
 * power-of-two LCG's low bits have a tiny period: every two-valued field got the SAME value
 * in all 500 cases (`optedOut` always true, so the governor said `target-opted-out` 500 times
 * out of 500), four-valued fields took two values, six-valued took three. "Drawn uniformly"
 * was false and 22% of the corpus was filler. Now each (case index, field name) pair is
 * hashed independently — FNV-1a, then murmur3's finaliser to spread the low bits — and the
 * HIGH-precision unit interval decides both whether the field deviates and to which value.
 * `tests/rules-golden.test.ts` asserts the coverage so this cannot come back silently.
 *
 * ── IDS ARE SPARSE, SO ADDING A DIMENSION CHANGES NO EXISTING ID ────────────
 *
 * Each case carries a stable id: a hash of the fields whose value DIFFERS from the baseline,
 * keys sorted. A new dimension appended with its baseline value first therefore leaves every
 * existing id untouched, and the fixture diff after adding one shows only the NEW cases.
 * (The first version hashed every field, so a new dimension re-keyed all 2,309 cases and the
 * diff was a whole-file replacement — defeating "the diff is the review".)
 *
 * What DOES change ids, and must be done knowingly: changing a dimension's BASELINE value
 * (every case's sparse form moves), changing a dimension's LENGTH, `RANDOM_SEED`,
 * `RANDOM_CASES` or `RANDOM_DEVIATION_RATE` (the random slice redraws), and re-spelling a
 * value. Reordering the NON-baseline values of a dimension changes which random case gets
 * which value, and nothing else.
 */

export const NOW = new Date('2026-10-15T06:30:00.000Z')
/** A reply written two days before NOW — inside any seven-day window. */
export const REPLIED_AT = new Date('2026-10-13T09:15:00.000Z')
/** A `profile-gone` park three days before NOW — inside PROFILE_GONE_RECHECK_DAYS. */
export const PROFILE_GONE_AT = new Date('2026-10-12T04:00:00.000Z')

/**
 * The dimensions, each with its BASELINE value first.
 *
 * `attemptStatus` is TOTAL over `ATTEMPT_STATUSES` (asserted in the golden test), plus one
 * value that is not a status at all. `overrides` is a NAME for a list — see `OVERRIDE_LISTS`:
 * the one crossable stop, two absolute stops beside it, the empty list, a string that names
 * no stop, and one entry per absolute stop a present person could reach.
 */
export const DIMENSIONS = {
  senderStatus: ['ACTIVE', 'PAUSED', 'CHALLENGED'],
  optedOut: [false, true],
  isVerified: [true, false, null],
  touchesSoFar: [0, 1, 3],
  targetHasEverReplied: [false, true],
  targetRepliedAt: ['none', 'recent'],
  unusedCampaignCount: [3, 0, 1],
  describableCampaignCount: [3, 0, 1],
  pairSentTodayCount: [0, 1, 5, 6],
  maxPerPairPerDay: [5, 1, 10],
  crossSpacing: ['clear', 'ring-complete', 'inter-page-gap'],
  material: ['clear', 'held-none', 'held-one', 'held-many'],
  hasPendingAttempt: [false, true],
  parkedFailureCode: [null, 'not-in-thread', 'no-composer', 'unreadable'],
  targetProfileGoneAt: ['none', 'recent'],
  lifetime: ['unlimited-0', 'cap1-0', 'cap1-1', 'cap10-5', 'cap10-10', 'unlimited-3'],
  fleetTemplate: ['ok', 'different-fleet', 'not-set', 'ambiguous'],
  followUpTemplate: ['written', 'unwritten'],
  repeatsADeliveredBody: [false, true],
  attemptStatus: ['READY', 'QUEUED', 'SENT', 'SKIPPED', 'SENDING', 'FAILED', 'REPLIED', 'BOGUS'],
  unattended: [true, false],
  overrides: [
    'none',
    'target-replied',
    'sender-not-active',
    'empty',
    'unknown-string',
    'target-replied+pair-daily-cap',
    'target-replied+sender-not-active',
    'pair-daily-cap',
    'follow-up-waits-for-tomorrow',
    'no-session',
    'target-not-verified',
    'material-exhausted',
  ],
  senderCohortCleared: ['undefined', 'true', 'false', 'false-no-detail'],
  senderHasSession: [true, false],
  targetIsWatchOnly: [false, true],
  senderCategories: ['default', 'marketing'],
  targetCategories: ['default', 'marketing'],
  isFollowUp: ['derived', 'true', 'false'],
  introducesUsToSomeoneWhoKnowsUs: [false, true],
  followUpCitesOnlyADate: [false, true],
} as const

type Dimensions = typeof DIMENSIONS
export type RuleFacts = { [K in keyof Dimensions]: Dimensions[K][number] }
export type RuleCase = RuleFacts & { id: string }

/**
 * What each `overrides` value hands the gate. `undefined` omits the key entirely — the shape
 * the dispatcher sends. The stop names are the gate's own constants, never retyped, so a
 * renamed stop here is a compile error rather than a silently inert override.
 */
export const OVERRIDE_LISTS: Record<RuleFacts['overrides'], readonly string[] | undefined> = {
  none: undefined,
  'target-replied': [RESEND_BLOCKS.TARGET_REPLIED],
  'sender-not-active': [RESEND_BLOCKS.SENDER_NOT_ACTIVE],
  empty: [],
  'unknown-string': ['definitely-not-a-stop'],
  'target-replied+pair-daily-cap': [RESEND_BLOCKS.TARGET_REPLIED, RESEND_BLOCKS.PAIR_DAILY_CAP],
  'target-replied+sender-not-active': [RESEND_BLOCKS.TARGET_REPLIED, RESEND_BLOCKS.SENDER_NOT_ACTIVE],
  'pair-daily-cap': [RESEND_BLOCKS.PAIR_DAILY_CAP],
  'follow-up-waits-for-tomorrow': [RESEND_BLOCKS.FOLLOW_UP_SAME_DAY],
  'no-session': [RESEND_BLOCKS.NO_SESSION],
  'target-not-verified': [RESEND_BLOCKS.TARGET_NOT_VERIFIED],
  'material-exhausted': [RESEND_BLOCKS.MATERIAL_EXHAUSTED],
}

/**
 * The absolute stops the `overrides` dimension names ALONE (one list, one stop). The golden
 * test asserts that for each of these some corpus case passes exactly that override and is
 * still refused with exactly that reason — "each one does nothing", proven per stop.
 */
export const ABSOLUTE_STOPS_OFFERED_AS_OVERRIDES: readonly { value: RuleFacts['overrides']; stop: string }[] = [
  { value: 'sender-not-active', stop: RESEND_BLOCKS.SENDER_NOT_ACTIVE },
  { value: 'pair-daily-cap', stop: RESEND_BLOCKS.PAIR_DAILY_CAP },
  { value: 'follow-up-waits-for-tomorrow', stop: RESEND_BLOCKS.FOLLOW_UP_SAME_DAY },
  { value: 'no-session', stop: RESEND_BLOCKS.NO_SESSION },
  { value: 'target-not-verified', stop: RESEND_BLOCKS.TARGET_NOT_VERIFIED },
  { value: 'material-exhausted', stop: RESEND_BLOCKS.MATERIAL_EXHAUSTED },
]

export const RANDOM_CASES = 800
/** Per field, per random case: the chance it leaves its baseline. ~6 deviations a case over 30 fields. */
export const RANDOM_DEVIATION_RATE = 0.22
export const RANDOM_SEED = 'rules-corpus/2026-10-15'

export const FIELDS = Object.keys(DIMENSIONS) as (keyof Dimensions)[]

export function baselineFacts(): RuleFacts {
  const out: Record<string, unknown> = {}
  for (const f of FIELDS) out[f] = DIMENSIONS[f][0]
  return out as RuleFacts
}

/**
 * SPARSE canonical JSON: only the fields that differ from the baseline, keys sorted. The
 * baseline itself is `{}`. See the module docblock for what this makes stable.
 */
export function canonicalJson(facts: RuleFacts): string {
  const sparse: Record<string, unknown> = {}
  for (const key of [...FIELDS].sort()) {
    if (facts[key] !== DIMENSIONS[key][0]) sparse[key] = facts[key]
  }
  return JSON.stringify(sparse)
}

/** FNV-1a over a string, 32-bit. */
function fnv1a(s: string, offset: number): number {
  let h = offset >>> 0
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h
}

/** FNV-1a over the canonical JSON, twice with different offsets — 16 hex chars. */
export function caseId(facts: RuleFacts): string {
  const s = canonicalJson(facts)
  return fnv1a(s, 0x811c9dc5).toString(16).padStart(8, '0') + fnv1a(s, 0x050c5d1f).toString(16).padStart(8, '0')
}

function withId(facts: RuleFacts): RuleCase {
  return { id: caseId(facts), ...facts }
}

/**
 * A unit-interval draw for (case index, field) that depends on nothing else: FNV-1a over the
 * three names, then murmur3's `fmix32` so the LOW bits are as well mixed as the high ones —
 * the property the old LCG lacked. Dividing by 2^32 uses every bit of the hash, so a field
 * with k values is reduced by MULTIPLYING, never by `% k`.
 */
function unitDraw(caseIndex: number, field: string): number {
  let h = fnv1a(`${RANDOM_SEED}:${caseIndex}:${field}`, 0x811c9dc5)
  h ^= h >>> 16
  h = Math.imul(h, 0x85ebca6b) >>> 0
  h ^= h >>> 13
  h = Math.imul(h, 0xc2b2ae35) >>> 0
  h ^= h >>> 16
  return (h >>> 0) / 2 ** 32
}

/** The fields a follow-up's stops read, in both evaluators. */
const FOLLOW_UP_FIELDS = [
  'touchesSoFar',
  'targetHasEverReplied',
  'unusedCampaignCount',
  'describableCampaignCount',
  'pairSentTodayCount',
  'maxPerPairPerDay',
  'crossSpacing',
  'material',
  'followUpTemplate',
  'repeatsADeliveredBody',
  'isFollowUp',
  'introducesUsToSomeoneWhoKnowsUs',
  'followUpCitesOnlyADate',
] as const satisfies readonly (keyof Dimensions)[]

/** The starting points. Exported so the golden test can pin each one by name. */
export function followUpBaseline(): RuleFacts {
  return { ...baselineFacts(), touchesSoFar: 1 }
}

/** A present person and nothing else — the on-demand dialog's plain Send. */
export function attendedBaseline(): RuleFacts {
  return { ...baselineFacts(), unattended: false }
}

/** A present person, a recent reply, and the reply halt acknowledged — the dialog's crossed Send. */
export function attendedReplyBaseline(): RuleFacts {
  return { ...attendedBaseline(), overrides: 'target-replied', targetRepliedAt: 'recent' }
}

/** A present person sending a SECOND message — the follow-up stops, attended. */
export function attendedFollowUpBaseline(): RuleFacts {
  return { ...attendedBaseline(), touchesSoFar: 1 }
}

/** The corpus, generated once per process. */
export const RULE_CORPUS: readonly RuleCase[] = generateCorpus()

// ── the compound facts, built with the REAL helpers ──────────────────────────

/** The DEFAULT fleet's template and the three ways `templateForSettings` refuses. */
const FLEET: Record<RuleFacts['fleetTemplate'], FleetTemplate> = {
  ok: templateForSettings({ singleTemplateBody: null, fleetTemplateBodies: new Map() }, [], []),
  'different-fleet': templateForSettings(
    { singleTemplateBody: null, fleetTemplateBodies: new Map([['marketing', 'x'.repeat(60)]]) },
    ['marketing'],
    [],
  ),
  'not-set': templateForSettings({ singleTemplateBody: null, fleetTemplateBodies: new Map() }, ['marketing'], ['marketing']),
  ambiguous: templateForSettings(
    { singleTemplateBody: null, fleetTemplateBodies: new Map([['marketing', 'x'.repeat(60)]]) },
    ['marketing', 'bollywood'],
    ['marketing', 'bollywood'],
  ),
}

const FOLLOW: Record<RuleFacts['followUpTemplate'], FollowUpTemplate> = {
  written: followUpForSettings(
    {
      followUpBody: `Hi,Following up on {{post}} — we can put the same campaign in front of a much larger audience. Let's talk tomorrow.`,
      followUpBodies: new Map(),
    },
    [],
    [],
  ),
  unwritten: followUpForSettings({ followUpBody: null, followUpBodies: new Map() }, [], []),
}

const TWO_PAGES = [
  { id: 's1', handle: 'bollywoodchronicle' },
  { id: 's2', handle: 'bollywoodsocietyy' },
]
const NO_MEMBERSHIPS = { bySenderHandle: new Map<string, string[]>(), byTargetHandle: new Map<string, string[]>() }

const CROSS: Record<RuleFacts['crossSpacing'], CrossSpacingVerdict> = {
  clear: crossSpacingVerdict({
    now: NOW,
    windowDays: 7,
    crossPageGapHours: 0,
    thisSenderId: 's1',
    eligibleSenders: TWO_PAGES,
    targetHandle: 't',
    memberships: NO_MEMBERSHIPS,
    lastDeliveryBySender: new Map(),
  }),
  /* Both pages wrote inside the window — the seven-day rest. */
  'ring-complete': crossSpacingVerdict({
    now: NOW,
    windowDays: 7,
    crossPageGapHours: 0,
    thisSenderId: 's1',
    eligibleSenders: TWO_PAGES,
    targetHandle: 't',
    memberships: NO_MEMBERSHIPS,
    lastDeliveryBySender: new Map([
      ['s1', { sentAt: new Date(NOW.getTime() - 3 * 86_400_000), handle: 'bollywoodchronicle' }],
      ['s2', { sentAt: new Date(NOW.getTime() - 2 * 86_400_000), handle: 'bollywoodsocietyy' }],
    ]),
  }),
  /* Only the OTHER page wrote, three hours ago, under a 24-hour gap — Tabish's lever at 24. */
  'inter-page-gap': crossSpacingVerdict({
    now: NOW,
    windowDays: 7,
    crossPageGapHours: 24,
    thisSenderId: 's1',
    eligibleSenders: TWO_PAGES,
    targetHandle: 't',
    memberships: NO_MEMBERSHIPS,
    lastDeliveryBySender: new Map([['s2', { sentAt: new Date(NOW.getTime() - 3 * 3_600_000), handle: 'bollywoodsocietyy' }]]),
  }),
}

const MATERIAL: Record<RuleFacts['material'], MaterialVerdict> = {
  clear: materialAllowance({ campaignsInWindow: 3, deliveredInWindow: 0 }),
  /* No paid post at all and one page has written — the `max(1, …)` floor spent. */
  'held-none': materialAllowance({ campaignsInWindow: 0, deliveredInWindow: 1 }),
  'held-one': materialAllowance({ campaignsInWindow: 1, deliveredInWindow: 1 }),
  'held-many': materialAllowance({ campaignsInWindow: 3, deliveredInWindow: 4 }),
}

const LIFETIME: Record<RuleFacts['lifetime'], { totalSentEver: number; maxTotalSends: number | null }> = {
  'unlimited-0': { totalSentEver: 0, maxTotalSends: null },
  'cap1-0': { totalSentEver: 0, maxTotalSends: 1 },
  'cap1-1': { totalSentEver: 1, maxTotalSends: 1 },
  'cap10-5': { totalSentEver: 5, maxTotalSends: 10 },
  'cap10-10': { totalSentEver: 10, maxTotalSends: 10 },
  'unlimited-3': { totalSentEver: 3, maxTotalSends: null },
}

const COHORT_DETAIL = 'group 1 has been sending for 3 of 14 days — 11 more to go'

export function toGovernorInput(c: RuleFacts): GovernorInput {
  return {
    now: NOW,
    sender: { status: c.senderStatus },
    target: { optedOut: c.optedOut, isVerified: c.isVerified },
    touchesSoFar: c.touchesSoFar,
    targetHasEverReplied: c.targetHasEverReplied,
    targetRepliedAt: c.targetRepliedAt === 'recent' ? REPLIED_AT : null,
    unusedCampaignCount: c.unusedCampaignCount,
    pairSentTodayCount: c.pairSentTodayCount,
    maxPerPairPerDay: c.maxPerPairPerDay,
    crossSpacing: CROSS[c.crossSpacing],
    material: MATERIAL[c.material],
    hasPendingAttempt: c.hasPendingAttempt,
    parkedFailureCode: c.parkedFailureCode,
    targetProfileGoneAt: c.targetProfileGoneAt === 'recent' ? PROFILE_GONE_AT : null,
    ...LIFETIME[c.lifetime],
    fleetTemplate: FLEET[c.fleetTemplate],
    followUpTemplate: FOLLOW[c.followUpTemplate],
    describableCampaignCount: c.describableCampaignCount,
    repeatsADeliveredBody: c.repeatsADeliveredBody,
  }
}

export function toResendInput(c: RuleFacts): ResendInput {
  const cohort =
    c.senderCohortCleared === 'undefined'
      ? {}
      : c.senderCohortCleared === 'true'
        ? { senderCohortCleared: true }
        : c.senderCohortCleared === 'false'
          ? { senderCohortCleared: false, senderCohortDetail: COHORT_DETAIL }
          : { senderCohortCleared: false }
  const overrides = OVERRIDE_LISTS[c.overrides]
  return {
    attemptStatus: c.attemptStatus,
    unattended: c.unattended,
    senderStatus: c.senderStatus,
    ...cohort,
    senderHasSession: c.senderHasSession,
    parkedFailureCode: c.parkedFailureCode,
    targetProfileGoneAt: c.targetProfileGoneAt === 'recent' ? PROFILE_GONE_AT : null,
    material: MATERIAL[c.material],
    targetOptedOut: c.optedOut,
    targetIsWatchOnly: c.targetIsWatchOnly,
    senderCategories: c.senderCategories === 'marketing' ? ['marketing'] : [],
    targetCategories: c.targetCategories === 'marketing' ? ['marketing'] : [],
    fleetTemplate: FLEET[c.fleetTemplate],
    /* `derived` is what `recheckBeforeSend` computes; the other two are deliberately
       inconsistent with the facts beside them, and pin the gate's answer to that too. */
    isFollowUp:
      c.isFollowUp === 'derived'
        ? isFollowUp({ touchesSoFar: c.touchesSoFar, targetHasEverReplied: c.targetHasEverReplied })
        : c.isFollowUp === 'true',
    introducesUsToSomeoneWhoKnowsUs: c.introducesUsToSomeoneWhoKnowsUs,
    followUpTemplate: FOLLOW[c.followUpTemplate],
    followUpCitesOnlyADate: c.followUpCitesOnlyADate,
    repeatsADeliveredBody: c.repeatsADeliveredBody,
    targetIsVerified: c.isVerified,
    targetRepliedAt: c.targetRepliedAt === 'recent' ? REPLIED_AT : null,
    pairSentTodayCount: c.pairSentTodayCount,
    maxPerPairPerDay: c.maxPerPairPerDay,
    crossSpacing: CROSS[c.crossSpacing],
    ...(overrides === undefined ? {} : { overrides }),
  }
}

export interface RuleSlices {
  baselines: RuleFacts[]
  singles: RuleFacts[]
  pairs: RuleFacts[]
  random: RuleFacts[]
  followUp: RuleFacts[]
  attended: RuleFacts[]
}

/** Every single-field deviation from `base`, over `fields`. */
function singlesFrom(base: RuleFacts, fields: readonly (keyof Dimensions)[]): RuleFacts[] {
  const out: RuleFacts[] = []
  for (const f of fields) {
    for (const v of DIMENSIONS[f]) {
      if (v === base[f]) continue
      out.push({ ...base, [f]: v })
    }
  }
  return out
}

/**
 * Every pair of deviations from `base`: one value from each of two different fields, the
 * first from `left` and the second from `right`. When the two lists are the SAME list each
 * unordered pair is produced once.
 */
function pairsFrom(
  base: RuleFacts,
  left: readonly (keyof Dimensions)[],
  right: readonly (keyof Dimensions)[],
): RuleFacts[] {
  const out: RuleFacts[] = []
  const same = left === right
  for (let i = 0; i < left.length; i++) {
    for (let j = same ? i + 1 : 0; j < right.length; j++) {
      const fi = left[i]!
      const fj = right[j]!
      if (fi === fj) continue
      for (const vi of DIMENSIONS[fi]) {
        if (vi === base[fi]) continue
        for (const vj of DIMENSIONS[fj]) {
          if (vj === base[fj]) continue
          out.push({ ...base, [fi]: vi, [fj]: vj })
        }
      }
    }
  }
  return out
}

/** Slice (c): sparse random deviations from the clean baseline. See the module docblock. */
export function randomSlice(): RuleFacts[] {
  const base = baselineFacts()
  const out: RuleFacts[] = []
  for (let n = 0; n < RANDOM_CASES; n++) {
    const facts: Record<string, unknown> = { ...base }
    for (const f of FIELDS) {
      const u = unitDraw(n, f)
      if (u >= RANDOM_DEVIATION_RATE) continue
      const values = DIMENSIONS[f]
      /* Rescale the sub-threshold draw to [0, 1) and pick a NON-baseline value uniformly. */
      const pick = 1 + Math.floor((u / RANDOM_DEVIATION_RATE) * (values.length - 1))
      facts[f] = values[Math.min(pick, values.length - 1)]
    }
    out.push(facts as RuleFacts)
  }
  return out
}

/** The five slices, BEFORE deduplication — so a test can measure each one on its own. */
export function generateSlices(): RuleSlices {
  const base = baselineFacts()
  const followUpBase = followUpBaseline()
  const attendedBase = attendedBaseline()
  const attendedReplyBase = attendedReplyBaseline()
  const attendedFollowUpBase = attendedFollowUpBaseline()
  return {
    baselines: [base, followUpBase, attendedBase, attendedReplyBase, attendedFollowUpBase],
    singles: singlesFrom(base, FIELDS),
    pairs: pairsFrom(base, FIELDS, FIELDS),
    random: randomSlice(),
    followUp: [...singlesFrom(followUpBase, FOLLOW_UP_FIELDS), ...pairsFrom(followUpBase, FOLLOW_UP_FIELDS, FOLLOW_UP_FIELDS)],
    attended: [
      ...singlesFrom(attendedReplyBase, FIELDS),
      ...pairsFrom(attendedReplyBase, ['overrides'], FIELDS),
      ...pairsFrom(attendedBase, ['overrides'], FIELDS),
      ...singlesFrom(attendedFollowUpBase, FOLLOW_UP_FIELDS),
      ...pairsFrom(attendedFollowUpBase, ['overrides'], FOLLOW_UP_FIELDS),
    ],
  }
}

export function generateCorpus(): RuleCase[] {
  const seen = new Set<string>()
  const out: RuleCase[] = []
  const push = (facts: RuleFacts) => {
    const c = withId(facts)
    if (seen.has(c.id)) return
    seen.add(c.id)
    out.push(c)
  }
  const slices = generateSlices()
  for (const facts of slices.baselines) push(facts)
  for (const facts of slices.singles) push(facts)
  for (const facts of slices.pairs) push(facts)
  for (const facts of slices.random) push(facts)
  for (const facts of slices.followUp) push(facts)
  for (const facts of slices.attended) push(facts)
  return out
}
