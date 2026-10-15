import { describe, it, expect } from 'vitest'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { evaluatePair, SKIP_REASONS } from '@/outreach/governor'
import { evaluateResend, RESEND_BLOCKS } from '@/outreach/gate'
import { RULE_CORPUS, toGovernorInput, toResendInput, type RuleCase } from './helpers/rules-corpus'

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
 * So `tests/helpers/rules-corpus.ts` generates a few thousand fact combinations — every single
 * deviation from a clean first touch, every PAIR of deviations, and a seeded random slice — and
 * `tests/fixtures/rules-golden.json` holds what both functions answer for each one today.
 *
 * THIS FILE GOES RED THE MOMENT ANY VERDICT, REASON OR DETAIL STRING CHANGES FOR ANY INPUT.
 * That is its whole purpose. A sentence reworded on a refusal fails it; a stop reordered fails
 * it; a stop removed fails it; a new stop that fires for an existing input fails it. Regenerate
 * only DELIBERATELY — `REGENERATE_RULES_GOLDEN=1 pnpm exec vitest run tests/rules-golden.test.ts`
 * — and READ THE DIFF of the fixture before committing it: every changed line is a verdict that
 * moved, and the diff is the review.
 *
 * What would fail it, concretely: moving `TARGET_NOT_VERIFIED` below `SENDER_NOT_ACTIVE` in the
 * governor (every case with both set reports a different reason); changing one character of the
 * `MATERIAL_EXHAUSTED` sentence; making `PAIR_DAILY_CAP` overridable (the override cases flip);
 * a new evaluator that answers `unreadable` parks differently from the pure functions today.
 *
 * The regeneration path writes the file AND still asserts, so a regeneration run can never
 * pass vacuously: it compares what it just wrote against what it just computed.
 */

const GOLDEN_PATH = join(__dirname, 'fixtures', 'rules-golden.json')

type Verdict = { ok: true; touchNumber?: number } | { ok: false; reason: string; detail?: string }
type GoldenEntry = { governor: Verdict; gate: Verdict }
type Golden = Record<string, GoldenEntry>

function governorVerdict(c: RuleCase): Verdict {
  const d = evaluatePair(toGovernorInput(c))
  /* `touchNumber` is part of the decision — the composer writes the body against it — so it
     is pinned beside `ok`, though the task's minimum was `{ ok, reason, detail }`. */
  return d.eligible ? { ok: true, touchNumber: d.touchNumber } : { ok: false, reason: d.reason, ...(d.detail !== undefined ? { detail: d.detail } : {}) }
}

function gateVerdict(c: RuleCase): Verdict {
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

describe('the rule corpus', () => {
  it('is the size the plan asked for, with a unique id per case', () => {
    expect(RULE_CORPUS.length).toBeGreaterThanOrEqual(2000)
    expect(RULE_CORPUS.length).toBeLessThanOrEqual(4000)
    expect(new Set(RULE_CORPUS.map((c) => c.id)).size).toBe(RULE_CORPUS.length)
  })

  it('is deterministic across generations — the same facts hash to the same id', async () => {
    const { generateCorpus } = await import('./helpers/rules-corpus')
    const again = generateCorpus()
    expect(again.map((c) => c.id)).toEqual(RULE_CORPUS.map((c) => c.id))
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
    for (const c of RULE_CORPUS) {
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
