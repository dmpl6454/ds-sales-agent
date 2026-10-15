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
 * ── IDS ARE SPARSE AND THE RANDOM FIELD LIST IS FROZEN, SO ADDING A DIMENSION CHANGES
 *    NO EXISTING ID ────────────────────────────────────────────────────────────
 *
 * Each case carries a stable id: a hash of the fields whose value DIFFERS from the baseline,
 * keys sorted. A new dimension appended with its baseline value first therefore leaves every
 * existing SINGLES, PAIRS, FOLLOW-UP and ATTENDED case untouched, and the fixture diff after
 * adding one shows only the NEW cases. (The first version hashed every field, so a new
 * dimension re-keyed all 2,309 cases and the diff was a whole-file replacement — defeating
 * "the diff is the review".)
 *
 * THE RANDOM SLICE NEEDED A SECOND HALF, and the first version of this paragraph was FALSE
 * about it (the review's finding, 2026-10-15): `randomSlice` looped over `FIELDS`, the LIVE key
 * list, so a new dimension drew its own deviation in every existing random case and changed its
 * facts, hence its id. MEASURED by appending a two-valued probe dimension: 155 of the
 * 781 distinct random cases re-keyed (20%); prepending one, 174. The fields
 * the random slice draws from are therefore a frozen literal, `RANDOM_FIELDS` (see its docblock),
 * the generator takes its dimensions table as a parameter, and `tests/rules-golden.test.ts`
 * generates the corpus over today's table plus a probe dimension and asserts every id survives.
 *
 * What DOES change ids, and must be done knowingly: changing a dimension's BASELINE value
 * (every case's sparse form moves), changing a dimension's LENGTH, `RANDOM_SEED`,
 * `RANDOM_CASES` or `RANDOM_DEVIATION_RATE` (the random slice redraws), ADDING A NAME TO
 * `RANDOM_FIELDS` (every random case draws for it — the ~20% above), and re-spelling a
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
/**
 * A dimensions table the generator can run over: today's, or today's with dimensions APPENDED
 * (or prepended — key order never reaches an id) — the shape a future field has, and the shape
 * the golden test's probe takes to prove that adding one re-keys nothing. A table that drops or
 * re-values one of today's dimensions is not a superset and the type refuses it.
 */
export type DimensionTable = Dimensions & Readonly<Record<string, readonly unknown[]>>
export type FactsOf<D extends DimensionTable> = { [K in keyof D]: D[K][number] }
export type RuleFacts = FactsOf<Dimensions>
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

/**
 * ── THE FIELDS THE RANDOM SLICE DRAWS FROM — FROZEN ───────────────────────────
 *
 * A LITERAL of the thirty names the slice was first generated over, NEVER `Object.keys(DIMENSIONS)`.
 * The slice used to iterate the live key list, so a dimension added later drew its own deviation
 * (p = `RANDOM_DEVIATION_RATE`) in every existing random case and re-keyed about a fifth of them —
 * measured in the module docblock — while the sparse-id promise said it could not. A name added to
 * DIMENSIONS stays at its BASELINE in every existing random case now (it is still covered by the
 * singles and pairs slices, which only ADD cases); if it needs random coverage too, that is a NEW
 * entry in `RANDOM_BLOCKS` with its own seed, APPENDED — never an edit to this list, which re-keys
 * the slice exactly as the old loop did. `tests/rules-golden.test.ts` appends a probe dimension
 * and asserts every id survives; iterating `fieldsOf(dims)` here instead of a block's frozen list
 * is what turns that test red (applied by hand once, 2026-10-15, and restored).
 */
export const RANDOM_FIELDS = [
  'senderStatus',
  'optedOut',
  'isVerified',
  'touchesSoFar',
  'targetHasEverReplied',
  'targetRepliedAt',
  'unusedCampaignCount',
  'describableCampaignCount',
  'pairSentTodayCount',
  'maxPerPairPerDay',
  'crossSpacing',
  'material',
  'hasPendingAttempt',
  'parkedFailureCode',
  'targetProfileGoneAt',
  'lifetime',
  'fleetTemplate',
  'followUpTemplate',
  'repeatsADeliveredBody',
  'attemptStatus',
  'unattended',
  'overrides',
  'senderCohortCleared',
  'senderHasSession',
  'targetIsWatchOnly',
  'senderCategories',
  'targetCategories',
  'isFollowUp',
  'introducesUsToSomeoneWhoKnowsUs',
  'followUpCitesOnlyADate',
] as const satisfies readonly (keyof Dimensions)[]

/**
 * The random slice is the concatenation of these blocks, each a frozen (seed, field list, case
 * count). Today there is one. A dimension that wants random coverage gets a block of its own
 * appended here — a different seed, so its cases are NEW ids and no existing one moves. The
 * golden test asserts every dimension in `DIMENSIONS` is in SOME block, so a new dimension
 * forces that decision rather than silently going without deep-interaction coverage.
 */
export const RANDOM_BLOCKS: readonly { seed: string; fields: readonly (keyof Dimensions)[]; cases: number }[] = [
  { seed: RANDOM_SEED, fields: RANDOM_FIELDS, cases: RANDOM_CASES },
]

export const FIELDS = Object.keys(DIMENSIONS) as (keyof Dimensions)[]

/** The keys of any dimensions table, in declaration order. */
export function fieldsOf(dims: DimensionTable): string[] {
  return Object.keys(dims)
}

/** A case's facts with no type narrowing — the shape the generator works in internally. */
type Facts = Record<string, unknown>

export function baselineFacts<D extends DimensionTable = Dimensions>(dims?: D): FactsOf<D> {
  const table: DimensionTable = dims ?? DIMENSIONS
  const out: Facts = {}
  for (const f of fieldsOf(table)) out[f] = table[f]![0]
  return out as FactsOf<D>
}

/**
 * SPARSE canonical JSON: only the fields that differ from the baseline, keys sorted. The
 * baseline itself is `{}`. See the module docblock for what this makes stable.
 */
export function canonicalJson(facts: Facts, dims: DimensionTable = DIMENSIONS): string {
  const sparse: Facts = {}
  for (const key of fieldsOf(dims).sort()) {
    if (facts[key] !== dims[key]![0]) sparse[key] = facts[key]
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
export function caseId(facts: Facts, dims: DimensionTable = DIMENSIONS): string {
  const s = canonicalJson(facts, dims)
  return fnv1a(s, 0x811c9dc5).toString(16).padStart(8, '0') + fnv1a(s, 0x050c5d1f).toString(16).padStart(8, '0')
}

function withId(facts: Facts, dims: DimensionTable): Facts & { id: string } {
  return { id: caseId(facts, dims), ...facts }
}

/**
 * A unit-interval draw for (seed, case index, field) that depends on nothing else: FNV-1a over
 * the three names, then murmur3's `fmix32` so the LOW bits are as well mixed as the high ones —
 * the property the old LCG lacked. Dividing by 2^32 uses every bit of the hash, so a field
 * with k values is reduced by MULTIPLYING, never by `% k`.
 */
function unitDraw(seed: string, caseIndex: number, field: string): number {
  let h = fnv1a(`${seed}:${caseIndex}:${field}`, 0x811c9dc5)
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
export function followUpBaseline<D extends DimensionTable = Dimensions>(dims?: D): FactsOf<D> {
  return { ...baselineFacts(dims), touchesSoFar: 1 }
}

/** A present person and nothing else — the on-demand dialog's plain Send. */
export function attendedBaseline<D extends DimensionTable = Dimensions>(dims?: D): FactsOf<D> {
  return { ...baselineFacts(dims), unattended: false }
}

/** A present person, a recent reply, and the reply halt acknowledged — the dialog's crossed Send. */
export function attendedReplyBaseline<D extends DimensionTable = Dimensions>(dims?: D): FactsOf<D> {
  return { ...attendedBaseline(dims), overrides: 'target-replied', targetRepliedAt: 'recent' }
}

/** A present person sending a SECOND message — the follow-up stops, attended. */
export function attendedFollowUpBaseline<D extends DimensionTable = Dimensions>(dims?: D): FactsOf<D> {
  return { ...attendedBaseline(dims), touchesSoFar: 1 }
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

export interface RuleSlices<D extends DimensionTable = Dimensions> {
  baselines: FactsOf<D>[]
  singles: FactsOf<D>[]
  pairs: FactsOf<D>[]
  random: FactsOf<D>[]
  followUp: FactsOf<D>[]
  attended: FactsOf<D>[]
}

/** Every single-field deviation from `base`, over `fields`. */
function singlesFrom(base: Facts, fields: readonly string[], dims: DimensionTable): Facts[] {
  const out: Facts[] = []
  for (const f of fields) {
    for (const v of dims[f]!) {
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
function pairsFrom(base: Facts, left: readonly string[], right: readonly string[], dims: DimensionTable): Facts[] {
  const out: Facts[] = []
  const same = left === right
  for (let i = 0; i < left.length; i++) {
    for (let j = same ? i + 1 : 0; j < right.length; j++) {
      const fi = left[i]!
      const fj = right[j]!
      if (fi === fj) continue
      for (const vi of dims[fi]!) {
        if (vi === base[fi]) continue
        for (const vj of dims[fj]!) {
          if (vj === base[fj]) continue
          out.push({ ...base, [fi]: vi, [fj]: vj })
        }
      }
    }
  }
  return out
}

/**
 * Slice (c): sparse random deviations from the clean baseline, block by block. See the module
 * docblock, and `RANDOM_FIELDS` for why a block's field list is frozen rather than `fieldsOf(dims)`.
 */
export function randomSlice<D extends DimensionTable = Dimensions>(dims?: D): FactsOf<D>[] {
  const table: DimensionTable = dims ?? DIMENSIONS
  const base: Facts = baselineFacts(table)
  const out: Facts[] = []
  for (const block of RANDOM_BLOCKS) {
    for (let n = 0; n < block.cases; n++) {
      const facts: Facts = { ...base }
      for (const f of block.fields) {
        const u = unitDraw(block.seed, n, f)
        if (u >= RANDOM_DEVIATION_RATE) continue
        const values = table[f]!
        /* Rescale the sub-threshold draw to [0, 1) and pick a NON-baseline value uniformly. */
        const pick = 1 + Math.floor((u / RANDOM_DEVIATION_RATE) * (values.length - 1))
        facts[f] = values[Math.min(pick, values.length - 1)]
      }
      out.push(facts)
    }
  }
  return out as FactsOf<D>[]
}

/**
 * The slices, BEFORE deduplication — so a test can measure each one on its own. Over today's
 * dimensions by default; over a superset of them when a test hands one in.
 */
export function generateSlices<D extends DimensionTable = Dimensions>(dims?: D): RuleSlices<D> {
  const table: DimensionTable = dims ?? DIMENSIONS
  const fields = fieldsOf(table)
  const base: Facts = baselineFacts(table)
  const followUpBase: Facts = followUpBaseline(table)
  const attendedBase: Facts = attendedBaseline(table)
  const attendedReplyBase: Facts = attendedReplyBaseline(table)
  const attendedFollowUpBase: Facts = attendedFollowUpBaseline(table)
  const slices = {
    baselines: [base, followUpBase, attendedBase, attendedReplyBase, attendedFollowUpBase],
    singles: singlesFrom(base, fields, table),
    pairs: pairsFrom(base, fields, fields, table),
    random: randomSlice(table),
    followUp: [
      ...singlesFrom(followUpBase, FOLLOW_UP_FIELDS, table),
      ...pairsFrom(followUpBase, FOLLOW_UP_FIELDS, FOLLOW_UP_FIELDS, table),
    ],
    attended: [
      ...singlesFrom(attendedReplyBase, fields, table),
      ...pairsFrom(attendedReplyBase, ['overrides'], fields, table),
      ...pairsFrom(attendedBase, ['overrides'], fields, table),
      ...singlesFrom(attendedFollowUpBase, FOLLOW_UP_FIELDS, table),
      ...pairsFrom(attendedFollowUpBase, ['overrides'], FOLLOW_UP_FIELDS, table),
    ],
  }
  return slices as RuleSlices<D>
}

export function generateCorpus<D extends DimensionTable = Dimensions>(dims?: D): (FactsOf<D> & { id: string })[] {
  const table: DimensionTable = dims ?? DIMENSIONS
  const seen = new Set<string>()
  const out: (Facts & { id: string })[] = []
  const push = (facts: Facts) => {
    const c = withId(facts, table)
    if (seen.has(c.id)) return
    seen.add(c.id)
    out.push(c)
  }
  const slices: RuleSlices<DimensionTable> = generateSlices(table)
  for (const facts of slices.baselines) push(facts)
  for (const facts of slices.singles) push(facts)
  for (const facts of slices.pairs) push(facts)
  for (const facts of slices.random) push(facts)
  for (const facts of slices.followUp) push(facts)
  for (const facts of slices.attended) push(facts)
  return out as (FactsOf<D> & { id: string })[]
}
