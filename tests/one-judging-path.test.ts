import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * THERE IS ONE PLACE A POST IS JUDGED, AND THIS TEST IS WHAT KEEPS IT THAT WAY.
 *
 * This codebase has now had the same failure four times: a rule with several callers,
 * fixed in one of them, silently diverging in the rest.
 *
 *   - `gate.ts`        — deliverWaiting re-checked eight conditions, sendNow three. The
 *                        five missing included `optedOut` and "they replied", so a retired
 *                        channel's Send button still delivered.
 *   - `readThread.ts`  — the CLI kept a full private copy of readMessages/jitter while the
 *                        docblock claimed "one implementation, two callers". A fix would
 *                        have landed in the scheduled check and NOT in the command a
 *                        person runs to verify it by hand.
 *   - the Connect buttons — one never polled, so a real login went unrecorded and the page
 *                        called a signed-in account "expired".
 *   - **the frame check** — MEASURED 2026-08-08: `pipeline.ts` saved 166 cover frames in a
 *                        day and read none of them, because only `scripts/ocr.ts` knew how.
 *                        The entire reason the OCR work exists was not running.
 *
 * Every one was invisible on reading and obvious on running. A comment saying "one
 * implementation, N callers" has already proved insufficient — it was literally present
 * and untrue in the readThread case. So the constraint is asserted instead.
 */

const SRC = join(process.cwd(), 'src')
const read = (p: string) => readFileSync(join(SRC, p), 'utf8')

/** Every file that decides whether a post is paid, and must therefore share the path. */
const JUDGING_CALLERS = [
  'detection/pipeline.ts',
  'scripts/classify.ts',
  'scripts/ocr.ts',
] as const

describe('one judging path', () => {
  it.each(JUDGING_CALLERS)('%s goes through the shared judge, not its own frame logic', (file) => {
    const source = read(file)

    /**
     * `applyFrameSignal` is the permission table. A caller reaching for it DIRECTLY is
     * re-implementing the caption-then-frame sequence around it, which is exactly how
     * the three callers diverged. `judge.ts` is the only file allowed to hold that
     * sequence; everyone else asks it.
     */
    expect(
      source.includes('judgeWithFrame'),
      `${file} must call judgeWithFrame — a caller with its own frame handling is the ` +
        `fourth diverging copy this test exists to prevent`,
    ).toBe(true)
  })

  it('judge.ts is the only file that composes the caption verdict with the frame verdict', () => {
    /**
     * `applyFrameSignal` takes (captionOnly, withFrame, evidence). Anything passing it two
     * DIFFERENT verdicts is deciding how the footage relates to the caption — the job
     * `judge.ts` owns. Files may still import the table for tests or for the pure
     * permission check; what they must not do is own the sequence.
     */
    const judge = read('detection/judge.ts')
    expect(judge).toContain('applyFrameSignal')

    for (const file of JUDGING_CALLERS) {
      const source = read(file)
      const composes = /applyFrameSignal\(\s*captionOnly\s*,\s*withFrame/.test(source)
      expect(composes, `${file} composes caption+frame itself; that belongs in judge.ts`).toBe(false)
    }
  })

  /**
   * The frame call is gated on `optedOut` in ONE place. MEASURED: 64% of OCR runs were
   * against our own retired pages — channels we watch for ground truth and will never
   * message. Saving their frames is right; spending a classifier call on them is not.
   */
  it('gates the frame call on optedOut inside the shared judge', () => {
    const judge = read('detection/judge.ts')
    expect(judge).toMatch(/optedOut/)
    expect(judge).toMatch(/reason:\s*'opted-out'|'opted-out'/)
  })

  /**
   * The permission table must stay a table. If `judge.ts` ever writes a verdict without
   * asking it, the "footage may only escalate" guarantee becomes a comment again.
   */
  it('never lets the judge assign a verdict the permission table did not produce', () => {
    const judge = read('detection/judge.ts')
    // Every non-base return carrying a verdict derives it from `outcome` (applyFrameSignal's
    // result) or from `captionOnly` — never from the model's answer directly.
    expect(judge).not.toMatch(/verdict:\s*withFrame\b/)
    expect(judge).not.toMatch(/verdict:\s*withFrameCall\./)
  })
})
