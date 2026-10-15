import type { GovernorInput } from '@/outreach/governor'
import type { ResendInput } from '@/outreach/gate'
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
 * `unreadable` never reaches either function in production (`splitParks` drops it); a
 * `pairSentTodayCount` of 1 with `touchesSoFar` 0 cannot happen (a delivery is a touch); the
 * gate's `isFollowUp` is set to disagree with its own derivation in some cases. They pin
 * TODAY's behaviour for those inputs too: a refactor that collapses the two functions into
 * one evaluator must answer every input identically, reachable or not, or say why it changed.
 *
 * ── HOW IT IS GENERATED ────────────────────────────────────────────────────
 *
 *   (a) every single-field deviation from the baseline clean first touch,
 *   (b) every PAIR of deviations (one value from each of two different fields),
 *   (c) `RANDOM_CASES` seeded pseudo-random full combinations from a tiny LCG — never
 *       `Math.random`, because a corpus that differs between runs cannot have a golden,
 *   (d) the same singles and pairs from a FOLLOW-UP baseline (`touchesSoFar` 1), restricted to
 *       the fields a follow-up's stops read — the five follow-up stops are ordered among
 *       themselves and against the ring rule and the pair cap, and (a)–(c) reach each of them
 *       only a handful of times because so many earlier stops fire first.
 *
 * Each case carries a stable id: a hash of its own sorted JSON. Reordering the generator or
 * adding a dimension therefore changes nothing about existing ids — new cases simply appear
 * as missing from the golden, which the test reports by name.
 */

export const NOW = new Date('2026-10-15T06:30:00.000Z')
/** A reply written two days before NOW — inside any seven-day window. */
export const REPLIED_AT = new Date('2026-10-13T09:15:00.000Z')
/** A `profile-gone` park three days before NOW — inside PROFILE_GONE_RECHECK_DAYS. */
export const PROFILE_GONE_AT = new Date('2026-10-12T04:00:00.000Z')

/** The dimensions, each with its BASELINE value first. Order is load-bearing for ids only in that it is fixed. */
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
  attemptStatus: ['READY', 'QUEUED', 'SENT', 'SKIPPED', 'SENDING', 'FAILED'],
  unattended: [true, false],
  overrides: ['none', 'target-replied', 'sender-not-active'],
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

export const RANDOM_CASES = 500
const LCG_SEED = 0x2f6e2b1

const FIELDS = Object.keys(DIMENSIONS) as (keyof Dimensions)[]

export function baselineFacts(): RuleFacts {
  const out: Record<string, unknown> = {}
  for (const f of FIELDS) out[f] = DIMENSIONS[f][0]
  return out as RuleFacts
}

/** Canonical JSON: keys sorted, so two cases with the same facts always hash alike. */
export function canonicalJson(facts: RuleFacts): string {
  const sorted: Record<string, unknown> = {}
  for (const key of [...FIELDS].sort()) sorted[key] = facts[key]
  return JSON.stringify(sorted)
}

/** FNV-1a over the canonical JSON, twice with different offsets — 16 hex chars. */
export function caseId(facts: RuleFacts): string {
  const s = canonicalJson(facts)
  const fnv = (offset: number): string => {
    let h = offset >>> 0
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i)
      h = Math.imul(h, 0x01000193) >>> 0
    }
    return h.toString(16).padStart(8, '0')
  }
  return fnv(0x811c9dc5) + fnv(0x050c5d1f)
}

function withId(facts: RuleFacts): RuleCase {
  return { id: caseId(facts), ...facts }
}

/** A tiny LCG (Numerical Recipes constants) so the random slice is the same on every run. */
function lcg(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state
  }
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
    ...(c.overrides === 'none' ? {} : { overrides: [c.overrides] }),
  }
}

export function generateCorpus(): RuleCase[] {
  const base = baselineFacts()
  const seen = new Set<string>()
  const out: RuleCase[] = []
  const push = (facts: RuleFacts) => {
    const c = withId(facts)
    if (seen.has(c.id)) return
    seen.add(c.id)
    out.push(c)
  }

  // (a) every single-field deviation
  for (const f of FIELDS) {
    for (const v of DIMENSIONS[f].slice(1)) push({ ...base, [f]: v })
  }

  // (b) every pair of deviations
  for (let i = 0; i < FIELDS.length; i++) {
    for (let j = i + 1; j < FIELDS.length; j++) {
      const fi = FIELDS[i]!
      const fj = FIELDS[j]!
      for (const vi of DIMENSIONS[fi].slice(1)) {
        for (const vj of DIMENSIONS[fj].slice(1)) push({ ...base, [fi]: vi, [fj]: vj })
      }
    }
  }

  // (c) seeded pseudo-random full combinations, every dimension drawn uniformly
  const next = lcg(LCG_SEED)
  for (let n = 0; n < RANDOM_CASES; n++) {
    const facts: Record<string, unknown> = {}
    for (const f of FIELDS) {
      const values = DIMENSIONS[f]
      facts[f] = values[next() % values.length]
    }
    push(facts as RuleFacts)
  }

  // (d) singles and pairs from the follow-up baseline, over the follow-up-relevant fields
  const followUpBase: RuleFacts = { ...base, touchesSoFar: 1 }
  for (const f of FOLLOW_UP_FIELDS) {
    for (const v of DIMENSIONS[f]) {
      if (v === followUpBase[f]) continue
      push({ ...followUpBase, [f]: v })
    }
  }
  for (let i = 0; i < FOLLOW_UP_FIELDS.length; i++) {
    for (let j = i + 1; j < FOLLOW_UP_FIELDS.length; j++) {
      const fi = FOLLOW_UP_FIELDS[i]!
      const fj = FOLLOW_UP_FIELDS[j]!
      for (const vi of DIMENSIONS[fi]) {
        if (vi === followUpBase[fi]) continue
        for (const vj of DIMENSIONS[fj]) {
          if (vj === followUpBase[fj]) continue
          push({ ...followUpBase, [fi]: vi, [fj]: vj })
        }
      }
    }
  }

  return out
}
