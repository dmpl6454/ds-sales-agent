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
  RANDOM_FIELDS,
  RANDOM_BLOCKS,
  OVERRIDE_LISTS,
  ABSOLUTE_STOPS_OFFERED_AS_OVERRIDES,
  attendedBaseline,
  attendedFollowUpBaseline,
  attendedReplyBaseline,
  baselineFacts,
  followUpBaseline,
  caseId,
  generateCorpus,
  generateSlices,
  toGovernorInput,
  toResendInput,
  type DimensionTable,
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
 * the baseline) AND the random slice draws from a frozen field list (`RANDOM_FIELDS`), so adding
 * a dimension adds lines to the fixture and changes none — the probe test below generates the
 * corpus over today's dimensions plus one more and asserts every id survives (measured by
 * appending a two-valued dimension to `DIMENSIONS` itself: 92 new cases, 0 moved). The first version
 * of this sentence rested on the sparse ids alone and was false for the random slice: that slice
 * iterated the live key list, so a new dimension redrew in every existing random case and about
 * a fifth of them re-keyed (measured in the corpus helper's docblock).
 *
 * What would fail it, concretely — EACH of these was applied to the production code by hand,
 * run against the fixture, seen red and restored before being written here:
 *   - moving `TARGET_NOT_VERIFIED` below `SENDER_NOT_ACTIVE` in the governor (every case with
 *     both set reports a different reason);
 *   - changing one character of the `MATERIAL_EXHAUSTED` sentence;
 *   - dropping override support (114 verdicts move: the attended baseline and every attended
 *     case that crossed the reply halt flip from ok, or a later stop, to `target-replied`);
 *   - turning `NOT_WAITING` into a deny-list of the five statuses the old corpus tried (233
 *     verdicts move: the `REPLIED` and `BOGUS` cases flip from `not-waiting` to a later stop);
 *   - a new evaluator that answers `unreadable` parks differently from the pure functions today.
 *
 * What would NOT fail it, stated so nobody relies on it: WIDENING `OVERRIDABLE_BLOCKS`. The
 * first version of this list claimed that adding `PAIR_DAILY_CAP` would flip the attended cases
 * that pass `pair-daily-cap`; applied by hand it stays green, because the evaluator consults the
 * acknowledged set at exactly ONE stop (gate.ts, the reply halt — `allowed.has(TARGET_REPLIED)`)
 * and nowhere else. A name added to the whitelist is therefore inert inside `evaluateResend`
 * whatever the corpus passes, and only `tests/stopInventory.test.ts` — which pins the constant
 * itself to `[TARGET_REPLIED]` and drives the override being inert on an absolute stop — catches
 * it. What THIS corpus does prove about absolute stops is behavioural: every one offered as an
 * override in the `overrides` dimension is still reported, by name, to a present person who
 * passed exactly that name (the "each one does nothing" test below).
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
       a fixture diff is still something a person reads. Measured at 4,746 on 2026-10-15, once
       the attended slices and the REPLIED/BOGUS statuses were added. */
    expect(RULE_CORPUS.length).toBeGreaterThanOrEqual(3000)
    expect(RULE_CORPUS.length).toBeLessThanOrEqual(5000)
    expect(new Set(RULE_CORPUS.map((c) => c.id)).size).toBe(RULE_CORPUS.length)
  })

  it('is deterministic across generations — the same facts hash to the same id', async () => {
    const { generateCorpus } = await import('./helpers/rules-corpus')
    const again = generateCorpus()
    expect(again.map((c) => c.id)).toEqual(RULE_CORPUS.map((c) => c.id))
  })

  it('hashes only the deviations, so the baseline is {} and every case is reachable from its own facts', () => {
    /* The sparse form is half of what makes "the diff is the review" survive a new dimension:
       the first version hashed every field and a new one re-keyed the whole fixture. */
    const base = baselineFacts()
    expect(caseId(base)).toBe(caseId({ ...base }))
    const oneAway = { ...base, optedOut: true as const }
    expect(caseId(oneAway)).not.toBe(caseId(base))
    for (const c of RULE_CORPUS) {
      const { id, ...facts } = c
      expect(caseId(facts as RuleFacts)).toBe(id)
    }
  })

  /**
   * THE OTHER HALF, PROVEN BY DOING IT: the corpus generated over today's dimensions PLUS a probe
   * dimension still contains every id of today's corpus, whether the probe is appended or
   * prepended, and the probe sits at its baseline in every random case. The random slice must
   * draw from `RANDOM_FIELDS` for this to hold — iterating `fieldsOf(dims)` in `randomSlice`
   * instead re-keys about a fifth of the random slice and turns this red (applied by hand once,
   * 2026-10-15; the failure message names the count). The pairs slice over the probe is what
   * makes the probed corpus LARGER, so a generator that quietly ignored unknown dimensions would
   * fail the size assertion rather than pass this vacuously.
   */
  it('a dimension appended or prepended later re-keys no existing case', () => {
    const todayIds = new Set(RULE_CORPUS.map((c) => c.id))
    const PROBE = ['probe-baseline', 'probe-deviant'] as const
    const check = <D extends DimensionTable>(key: string, probe: D) => {
      const probed = generateCorpus(probe)
      const probedIds = new Set(probed.map((c) => c.id))
      const lost = [...todayIds].filter((id) => !probedIds.has(id))
      expect(lost, `${key}: ${lost.length} of ${todayIds.size} ids re-keyed by a probe dimension`).toEqual([])
      expect(probed.length).toBeGreaterThan(RULE_CORPUS.length)
      expect(probed.some((c) => (c as Record<string, unknown>)[key] === 'probe-deviant')).toBe(true)
      const random = generateSlices(probe).random as Record<string, unknown>[]
      expect(random.every((c) => c[key] === 'probe-baseline'), `${key} drawn in a random case`).toBe(true)
    }
    check('zzProbe', { ...DIMENSIONS, zzProbe: PROBE })
    check('aaProbe', { aaProbe: PROBE, ...DIMENSIONS })
  })

  /**
   * `RANDOM_FIELDS` is the frozen list; a dimension added later must be given a block of its own
   * rather than silently go without random coverage — and must NEVER be added to the existing
   * list, which redraws every random case. What fails this: appending a dimension to `DIMENSIONS`
   * with no block (applied by hand once, 2026-10-15 — this test red, the fixture test reporting 92
   * new cases and 0 moved, the probe test still green), or a block whose first field list is not
   * the frozen literal.
   */
  it('names every dimension in a random block, by a list that is a literal and not the key list', () => {
    const covered = new Set(RANDOM_BLOCKS.flatMap((b) => [...b.fields]))
    expect(FIELDS.filter((f) => !covered.has(f))).toEqual([])
    for (const f of RANDOM_FIELDS) expect(FIELDS).toContain(f)
    expect(new Set(RANDOM_FIELDS).size).toBe(RANDOM_FIELDS.length)
    expect(RANDOM_BLOCKS[0]?.fields).toBe(RANDOM_FIELDS)
  })

  it('tries every attempt status there is, and one that is not', () => {
    /* `NOT_WAITING` is an allow-list. A refactor to a deny-list of the statuses somebody
       remembered would pass REPLIED — a resend into a live conversation — and anything
       unknown. Both are in the dimension, and the first is total over the real union. */
    for (const s of ATTEMPT_STATUSES) expect(DIMENSIONS.attemptStatus).toContain(s)
    expect((DIMENSIONS.attemptStatus as readonly string[]).includes('BOGUS')).toBe(true)
  })

  it('draws the random slice across every value of every dimension it draws from', () => {
    /* The old LCG's low bits gave every two-valued field ONE value in all 500 cases. Over
       `RANDOM_FIELDS`, not `FIELDS`: a dimension outside every block is at baseline in every
       random case by design, and the block-coverage test above is what forces that decision. */
    const { random } = generateSlices()
    const short: string[] = []
    for (const f of RANDOM_FIELDS) {
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
