import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { REJUDGE_PER_PASS } from '@/detection/rejudge'

const ROOT = resolve(__dirname, '..')
const SRC = readFileSync(join(ROOT, 'src/detection/rejudge.ts'), 'utf8')

/**
 * ── A RE-JUDGE PASS MUST NEVER RECORD A LOCAL ABSENCE AS A FACT ABOUT A POST ──────────
 *
 * FOUND BY RUNNING IT, before this test existed. Frames live on the host that detected the
 * post — the Mac holds a few hundred, the server holds the rest — and this pass writes to a
 * database BOTH hosts share. Run from the Mac, `readFrameText` truthfully reported "no frame
 * saved" about posts whose frames sit on the server, and the first version wrote that down:
 * **4 posts moved from `frame:call-failed` to `frame:not-saved`**, which retired them from
 * the retry queue permanently on the evidence of a laptop's disk.
 *
 * It is the `profileStatus` trap exactly — a guard mixing shared-database facts with
 * per-host filesystem state answers differently depending on where it ran — and it is worth
 * a test rather than a comment because the failing direction is invisible on the host that
 * happens to have the files. On the server every one of these assertions passes vacuously.
 */
describe('re-judging never writes what it did not read', () => {
  it('writes only after confirming the frame was actually read', () => {
    // The guard, and the `continue` that makes it binding rather than advisory.
    expect(SRC).toMatch(/const readTheFrame =/)

    /**
     * Asserted as "no write between the guard and its `continue`" rather than as a
     * character-count window. The window version broke the moment the skip gained its
     * second counter (2026-08-17) — a test failing because correct code moved is a test
     * asserting the layout instead of the property.
     */
    const guard = SRC.indexOf('if (!readTheFrame)')
    expect(guard).toBeGreaterThan(-1)
    const block = SRC.slice(guard, SRC.indexOf('continue', guard))
    expect(block).not.toMatch(/prisma\./)
    expect(block.length).toBeGreaterThan(0)
  })

  /**
   * The signal rewrite must sit AFTER the guard. A version that computed the new signals
   * first and then skipped would pass the assertion above and still be one edit away from
   * writing them, because the dangerous line would already exist above the `continue`.
   */
  it('computes the replacement signal only after the guard', () => {
    const guard = SRC.indexOf('if (!readTheFrame)')
    // The rewrite is a PURE helper since 16 Oct 2026 (it parses the JSON array instead of
    // substituting into the string); what must sit after the guard is its CALL on this row.
    const rewrite = SRC.indexOf('rewriteFrameSignals(p.signals')
    expect(guard).toBeGreaterThan(-1)
    expect(rewrite).toBeGreaterThan(guard)
  })

  /**
   * `frame:not-saved` and `frame:no-ocr-engine` are statements about THIS MACHINE. Neither
   * may ever be written by this pass — the host that lacks the frame has nothing to say
   * about the post, and the host that has it will answer properly.
   */
  it('never writes a machine-local outcome as a stored signal', () => {
    const body = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    expect(body).not.toMatch(/'frame:not-saved'/)
    expect(body).not.toMatch(/'frame:no-ocr-engine'/)

    /**
     * Since 16 Oct 2026 the pass READS the not-saved mark — it is how a post whose frame arrived
     * later is found — and REMOVES it once the frame is read. Both are allowed; writing it is not.
     * So every use of the constant must be one of exactly three shapes: the import, a `contains:`
     * in a query, or the set of marks the rewrite strips. The behaviour is driven for real in
     * tests/frame-recovery.test.ts ("a post with no frame here is skipped and nothing is written").
     */
    const uses = [...body.matchAll(/FRAME_NOT_SAVED_SIGNAL/g)].map((m) => body.slice(Math.max(0, m.index! - 100), m.index! + 25))
    expect(uses.length).toBeGreaterThanOrEqual(3)
    for (const u of uses) {
      expect(
        /import \{ FRAME_NOT_SAVED_SIGNAL \}/.test(u) || /contains: FRAME_NOT_SAVED_SIGNAL/.test(u) || /RETRYABLE_FRAME_MARKS = new Set\(\[[^\]]*FRAME_NOT_SAVED_SIGNAL/.test(u),
        `an unexpected use of the not-saved mark: …${u}…`,
      ).toBe(true)
    }
  })

  /** A skip is COUNTED and reported, or "examined 10, changed 0" reads as "nothing to do". */
  it('reports how many rows it left alone for want of a frame', () => {
    expect(SRC).toMatch(/skippedNoEvidence/)
  })
})

describe('the pass cannot run away or overwrite a person', () => {
  it('is bounded per pass, and the bound is a named constant', () => {
    expect(REJUDGE_PER_PASS).toBeGreaterThan(0)
    expect(REJUDGE_PER_PASS).toBeLessThanOrEqual(25)

    /**
     * The bound became overridable on 2026-08-17 so `pnpm ig:rejudge` can drain a backlog
     * deliberately, exactly as `ig:brands --run` is a different act from the bounded
     * automatic resolve pass. What must stay true is that the DEFAULT is the named
     * constant — a caller that passes nothing, which is the pipeline, is still bounded.
     */
    expect(SRC).toMatch(/take: limit/)
    expect(SRC).toMatch(/opts\.limit \?\? REJUDGE_PER_PASS/)
  })

  /**
   * The pipeline must never pass a limit or a dry run. A detection pass that drained the
   * whole backlog would be a burst against the same endpoint detection depends on, and one
   * that ran dry would look like it was working while writing nothing.
   */
  it('the pipeline calls it with no options, so it gets the bound and does write', () => {
    const pipeline = readFileSync(new URL('../src/detection/pipeline.ts', import.meta.url), 'utf8')
    expect(pipeline).toMatch(/rejudgeUnusedEvidence\(\)/)
    expect(pipeline).not.toMatch(/rejudgeUnusedEvidence\(\{/)
  })

  /**
   * A human answer is the highest authority in this system and the ONLY ground truth that
   * can ever measure recall on a placement living in the footage. `judgeWithFrame` refuses
   * one before any other branch; this scopes it out of the query as well. Belt and braces,
   * on the one thing that must never be overwritten by a model.
   */
  it('excludes human-answered posts in the query as well as in the judge', () => {
    expect(SRC).toMatch(/humanLabel: null/)
    // Computed from the row, not a constant `false` — a constant is no second guard at all.
    expect(SRC).toMatch(/humanLabelled: p\.humanLabel !== null/)
  })

  /**
   * ONE JUDGING PATH. This repo has had a single rule drift across callers five times, and
   * `tests/one-judging-path.test.ts` exists because `scripts/ocr.ts` kept a private copy.
   * A re-judge that called `classifyCaption` directly would bypass `applyFrameSignal`'s
   * permission table and could mint a CAMPAIGN from footage, which is forbidden.
   */
  it('judges through judgeWithFrame and never calls the classifier itself', () => {
    expect(SRC).toMatch(/judgeWithFrame\(/)
    expect(SRC).not.toMatch(/classifyCaption\(/)
  })

  /** It must not be able to take a detection pass down: a lost post cannot be re-scraped. */
  it('is caught separately from detection in the pipeline', () => {
    const pipeline = readFileSync(join(ROOT, 'src/detection/pipeline.ts'), 'utf8')
    expect(pipeline).toMatch(/rejudgeUnusedEvidence\(\)\.catch\(/)
  })
})
