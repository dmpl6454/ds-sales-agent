import { describe, it, expect } from 'vitest'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { evaluatePair, SKIP_REASONS } from '@/outreach/governor'
import { evaluateResend, RESEND_BLOCKS } from '@/outreach/gate'
import { ATTEMPT_STATUSES } from '@/lib/constants'
import {
  RULE_CORPUS,
  DIMENSIONS,
  FIELDS,
  OVERRIDE_LISTS,
  ABSOLUTE_STOPS_OFFERED_AS_OVERRIDES,
  attendedBaseline,
  attendedFollowUpBaseline,
  attendedReplyBaseline,
  baselineFacts,
  followUpBaseline,
  caseId,
  generateSlices,
  toGovernorInput,
  toResendInput,
  type RuleCase,
  type RuleFacts,
} from './helpers/rules-corpus'

/**
 * ── THE RULE GOLDEN: EVERY VERDICT TODAY'S TWO EVALUATORS GIVE, PINNED BY INPUT ─────────
 *
 * Stage 0 of the outreach redesign (2026-10-15). Stage 2 collapses `evaluatePair` (may a draft
 * be WRITTEN) and `evaluateResend` (may an existing draft be SENT) into one pure evaluator with
 * two adapters. The only acceptable proof that nothing changed is that every input the old
 * functions could meet still produces the same `{ ok, reason, detail }` — and "every input"
 * cannot be read off the eleven hand-picked cases in `tests/stopInventory.test.ts`, which were
 * chosen one per stop and never visit the ORDER two true stops are reported in.
 *
 * So `tests/helpers/rules-corpus.ts` generates a few thousand fact combinations — the three
 * baselines, every single deviation from a clean first touch, every PAIR of deviations, a
 * seeded sparse-random slice, the follow-up singles and pairs, and the attended on-demand
 * singles and override pairs — and `tests/fixtures/rules-golden.json` holds what both
 * functions answer for each one today.
 *
 * THIS FILE GOES RED THE MOMENT ANY VERDICT, REASON OR DETAIL STRING CHANGES FOR ANY INPUT.
 * That is its whole purpose. A sentence reworded on a refusal fails it; a stop reordered fails
 * it; a stop removed fails it; a new stop that fires for an existing input fails it. Regenerate
 * only DELIBERATELY — `REGENERATE_RULES_GOLDEN=1 pnpm exec vitest run tests/rules-golden.test.ts`
 * — and READ THE DIFF of the fixture before committing it: every changed line is a verdict that
 * moved, and the diff is the review. Ids are sparse hashes (only the fields that differ from
 * the baseline), so adding a dimension adds lines to the fixture and changes none.
 *
 * What would fail it, concretely — each of these was applied to a scratch copy of the
 * evaluator and run against the fixture before being written here:
 *   - moving `TARGET_NOT_VERIFIED` below `SENDER_NOT_ACTIVE` in the governor (every case with
 *     both set reports a different reason);
 *   - changing one character of the `MATERIAL_EXHAUSTED` sentence;
 *   - adding `PAIR_DAILY_CAP` to `OVERRIDABLE_BLOCKS` (the attended cases that pass
 *     `pair-daily-cap` as an override, alone or beside `target-replied`, flip from the cap to a
 *     later stop or to ok);
 *   - dropping override support (the attended baseline flips from ok to `target-replied`);
 *   - turning `NOT_WAITING` into a deny-list of the five statuses the old corpus tried (the
 *     `REPLIED` and `BOGUS` cases flip from `not-waiting` to a later stop);
 *   - a new evaluator that answers `unreadable` parks differently from the pure functions today.
 *
 * The regeneration path writes the file AND still asserts, so a regeneration run can never
 * pass vacuously: it compares what it just wrote against what it just computed.
 */

const GOLDEN_PATH = join(__dirname, 'fixtures', 'rules-golden.json')

type Verdict = { ok: true; touchNumber?: number } | { ok: false; reason: string; detail?: string }
type GoldenEntry = { governor: Verdict; gate: Verdict }
type Golden = Record<string, GoldenEntry>

function governorVerdict(c: RuleFacts): Verdict {
  const d = evaluatePair(toGovernorInput(c))
  /* `touchNumber` is part of the decision — the composer writes the body against it — so it
     is pinned beside `ok`, though the task's minimum was `{ ok, reason, detail }`. */
  return d.eligible ? { ok: true, touchNumber: d.touchNumber } : { ok: false, reason: d.reason, ...(d.detail !== undefined ? { detail: d.detail } : {}) }
}

function gateVerdict(c: RuleFacts): Verdict {
  const r = evaluateResend(toResendInput(c))
  return r.ok ? { ok: true } : { ok: false, reason: r.reason, ...(r.detail !== undefined ? { detail: r.detail } : {}) }
}

function computeGolden(): Golden {
  const out: Golden = {}
  for (const c of RULE_CORPUS) out[c.id] = { governor: governorVerdict(c), gate: gateVerdict(c) }
  return out
}

/** One case per line, ids sorted: a diff of the fixture reads as a list of verdicts that moved. */
function serialise(g: Golden): string {
  const ids = Object.keys(g).sort()
  const lines = ids.map((id) => `  ${JSON.stringify(id)}: ${JSON.stringify(g[id])}`)
  return `{\n${lines.join(',\n')}\n}\n`
}

const REGENERATE = process.env.REGENERATE_RULES_GOLDEN === '1'

/**
 * The floors the random slice must clear. Measured on the first run of the hashed generator:
 * the rarest value appeared 9 times and the slice reached 18 governor and 17 gate reasons.
 * The floors sit below that with margin, and far above what the degenerate LCG produced —
 * ZERO for half the values, ONE governor reason in 500 cases — which is what they exist to
 * refuse. A generator change that trips one is a generator that has stopped covering.
 */
const RANDOM_MIN_PER_VALUE = 6
const RANDOM_MIN_DISTINCT_REASONS = 12

describe('the rule corpus', () => {
  it('is a few thousand cases, with a unique id per case', () => {
    /* Wide enough for every pair of deviations plus the three extra slices, small enough that
       a fixture diff is still something a person reads. Measured at 3,889 on 2026-10-15. */
    expect(RULE_CORPUS.length).toBeGreaterThanOrEqual(3000)
    expect(RULE_CORPUS.length).toBeLessThanOrEqual(5000)
    expect(new Set(RULE_CORPUS.map((c) => c.id)).size).toBe(RULE_CORPUS.length)
  })

  it('is deterministic across generations — the same facts hash to the same id', async () => {
    const { generateCorpus } = await import('./helpers/rules-corpus')
    const again = generateCorpus()
    expect(again.map((c) => c.id)).toEqual(RULE_CORPUS.map((c) => c.id))
  })

  it('hashes only the deviations, so the baseline is {} and a new dimension cannot re-key old cases', () => {
    /* The sparse form is what makes "the diff is the review" survive a new dimension: the
       first version hashed every field and a new one re-keyed the whole fixture. */
    const base = baselineFacts()
    expect(caseId(base)).toBe(caseId({ ...base }))
    const oneAway = { ...base, optedOut: true as const }
    expect(caseId(oneAway)).not.toBe(caseId(base))
    /* Every corpus case is reachable by id from its own facts alone. */
    for (const c of RULE_CORPUS) {
      const { id, ...facts } = c
      expect(caseId(facts as RuleFacts)).toBe(id)
    }
  })

  it('tries every attempt status there is, and one that is not', () => {
    /* `NOT_WAITING` is an allow-list. A refactor to a deny-list of the statuses somebody
       remembered would pass REPLIED — a resend into a live conversation — and anything
       unknown. Both are in the dimension, and the first is total over the real union. */
    for (const s of ATTEMPT_STATUSES) expect(DIMENSIONS.attemptStatus).toContain(s)
    expect((DIMENSIONS.attemptStatus as readonly string[]).includes('BOGUS')).toBe(true)
  })

  it('draws the random slice across every value of every dimension', () => {
    /* The old LCG's low bits gave every two-valued field ONE value in all 500 cases. */
    const { random } = generateSlices()
    const short: string[] = []
    for (const f of FIELDS) {
      for (const v of DIMENSIONS[f]) {
        const n = random.filter((c) => c[f] === v).length
        if (n < RANDOM_MIN_PER_VALUE) short.push(`${f}=${String(v)} appears ${n} time(s)`)
      }
    }
    expect(short, `random-slice values under the floor of ${RANDOM_MIN_PER_VALUE}`).toEqual([])

    const governorReasons = new Set<string>()
    const gateReasons = new Set<string>()
    for (const c of random) {
      const g = governorVerdict(c)
      if (!g.ok) governorReasons.add(g.reason)
      const r = gateVerdict(c)
      if (!r.ok) gateReasons.add(r.reason)
    }
    expect(governorReasons.size).toBeGreaterThanOrEqual(RANDOM_MIN_DISTINCT_REASONS)
    expect(gateReasons.size).toBeGreaterThanOrEqual(RANDOM_MIN_DISTINCT_REASONS)
  })

  it('reaches every governor stop and every gate stop at least once', () => {
    const golden = computeGolden()
    const governorReasons = new Set<string>()
    const gateReasons = new Set<string>()
    for (const e of Object.values(golden)) {
      if (!e.governor.ok) governorReasons.add(e.governor.reason)
      if (!e.gate.ok) gateReasons.add(e.gate.reason)
    }
    /* A stop no case reaches is a stop the golden cannot protect. Both lists are TOTAL over
       the exported constants, so a stop added later must gain a corpus value that reaches it. */
    expect(Object.values(SKIP_REASONS).filter((r) => !governorReasons.has(r))).toEqual([])
    expect(Object.values(RESEND_BLOCKS).filter((r) => !gateReasons.has(r))).toEqual([])
  })

  /**
   * THE OVERRIDE PATH, IN BOTH DIRECTIONS. An override matters only when a person is present,
   * a reply is recent and the reply halt is the stop acknowledged — three fields together, which
   * no single or pair from the clean baseline ever sets. Without this slice a Stage 2 evaluator
   * could drop override support entirely (breaking the on-demand dialog), widen the whitelist,
   * or apply the acknowledgement at a different stop, and every other case would still agree.
   */
  it('crosses the reply halt on an acknowledgement, and only the reply halt', () => {
    const attended = attendedReplyBaseline()
    expect(gateVerdict(attended)).toEqual({ ok: true })
    /* The same facts with nobody present: the override is dropped and the halt holds. */
    const unattended = { ...attended, unattended: true as const }
    expect(gateVerdict(unattended)).toMatchObject({ ok: false, reason: RESEND_BLOCKS.TARGET_REPLIED })
    /* All the starting points are corpus cases, so the golden pins them too. */
    const ids = new Set(RULE_CORPUS.map((c) => c.id))
    for (const b of [attended, unattended, attendedBaseline(), attendedFollowUpBaseline(), followUpBaseline(), baselineFacts()]) {
      expect(ids.has(caseId(b))).toBe(true)
    }

    /* And at least one corpus case gets PAST the reply halt to a LATER stop on the strength of
       the acknowledgement — the override did something, and what it did was bounded. */
    const past = RULE_CORPUS.filter((c) => {
      const list = OVERRIDE_LISTS[c.overrides] ?? []
      if (c.unattended || c.targetRepliedAt !== 'recent' || !list.includes(RESEND_BLOCKS.TARGET_REPLIED)) return false
      const v = gateVerdict(c)
      return !v.ok && v.reason !== RESEND_BLOCKS.TARGET_REPLIED
    })
    expect(past.length).toBeGreaterThan(10)

    /* Every absolute stop offered as an override is still reported, by name, to a present
       person who passed exactly that name and met no reply halt in front of it. "Each one
       does nothing", one case per stop. */
    const missing = ABSOLUTE_STOPS_OFFERED_AS_OVERRIDES.filter(({ value, stop }) => {
      return !RULE_CORPUS.some((c) => {
        if (c.unattended || c.overrides !== value) return false
        const v = gateVerdict(c)
        return !v.ok && v.reason === stop
      })
    })
    expect(missing.map((m) => m.stop)).toEqual([])
  })
})

describe('rules-golden.json pins every verdict of evaluatePair and evaluateResend', () => {
  it('matches, case by case, in both modes', () => {
    const actual = computeGolden()

    if (REGENERATE) {
      writeFileSync(GOLDEN_PATH, serialise(actual))
    }

    expect(existsSync(GOLDEN_PATH), 'no golden on disk — run once with REGENERATE_RULES_GOLDEN=1').toBe(true)
    const golden = JSON.parse(readFileSync(GOLDEN_PATH, 'utf8')) as Golden

    const mismatches: string[] = []
    for (const c of RULE_CORPUS as readonly RuleCase[]) {
      const want = golden[c.id]
      const got = actual[c.id]!
      if (want === undefined) {
        mismatches.push(`${c.id}: not in the golden (a new corpus case — regenerate deliberately)`)
        continue
      }
      for (const mode of ['governor', 'gate'] as const) {
        if (JSON.stringify(want[mode]) !== JSON.stringify(got[mode])) {
          mismatches.push(
            `${c.id} [${mode}]\n    golden: ${JSON.stringify(want[mode])}\n    now:    ${JSON.stringify(got[mode])}\n    facts:  ${JSON.stringify(c)}`,
          )
        }
      }
    }
    const stale = Object.keys(golden).filter((id) => actual[id] === undefined)
    for (const id of stale) mismatches.push(`${id}: in the golden but no longer in the corpus`)

    expect(
      mismatches,
      `${mismatches.length} verdict(s) differ from tests/fixtures/rules-golden.json — the first few:\n${mismatches.slice(0, 12).join('\n')}`,
    ).toEqual([])
    expect(Object.keys(golden).length).toBe(RULE_CORPUS.length)
  })
})
