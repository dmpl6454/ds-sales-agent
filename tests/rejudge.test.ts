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
    expect(SRC).toMatch(/if \(!readTheFrame\) \{[\s\S]{0,120}continue/)
  })

  /**
   * The signal rewrite must sit AFTER the guard. A version that computed the new signals
   * first and then skipped would pass the assertion above and still be one edit away from
   * writing them, because the dangerous line would already exist above the `continue`.
   */
  it('computes the replacement signal only after the guard', () => {
    const guard = SRC.indexOf('if (!readTheFrame)')
    const rewrite = SRC.indexOf("replace(/frame:call-failed/g")
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
    expect(SRC).toMatch(/take: REJUDGE_PER_PASS/)
  })

  /**
   * A human answer is the highest authority in this system and the ONLY ground truth that
   * can ever measure recall on a placement living in the footage. `judgeWithFrame` refuses
   * one before any other branch; this scopes it out of the query as well. Belt and braces,
   * on the one thing that must never be overwritten by a model.
   */
  it('excludes human-answered posts in the query as well as in the judge', () => {
    expect(SRC).toMatch(/humanLabel: null/)
    expect(SRC).toMatch(/humanLabelled: false/)
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
