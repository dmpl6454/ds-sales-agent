import { describe, expect, it } from 'vitest'
import { walkSources, readSource, stripComments, callsOf, topLevelArgs } from './fixtures/sourceScan'

/**
 * THERE IS ONE PLACE A POST IS JUDGED, AND THIS TEST IS WHAT KEEPS IT THAT WAY.
 *
 * This codebase has now had the same failure five times: a rule with several callers,
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
 *   - **the frame check AGAIN** (found 2026-10-09) — `semanticDetector.classify` grew its own
 *                        frame stage and `scripts/accuracy.ts` its own copy, neither of which
 *                        stripped the publisher's own watermark. This test NAMED three
 *                        callers, neither file was among them, and it stayed green for two
 *                        months while @filmygyan's logo escalated its posts.
 *
 * So the callers are DISCOVERED now — every .ts/.tsx file under `src/` and `scripts/`, with
 * comments stripped — and the rules are stated about the whole tree. A list is what let the
 * fifth copy in; a walk cannot be forgotten.
 */

const FILES = [...walkSources('src'), ...walkSources('scripts')]
const code = new Map(FILES.map((f) => [f, stripComments(readSource(f))]))

const JUDGE = 'src/detection/judge.ts'
const DETECTOR = 'src/detection/detectors/semantic.ts'

/**
 * Files that ask the model about a post's CAPTION and deliberately never judge its footage,
 * each with the reason. An entry here is a decision someone has to write down, which is the
 * point: a new caller cannot become an exemption by accident.
 */
const EXEMPT: Record<string, string> = {
  'scripts/tmp-fg-rejudge.ts':
    'a write-nothing A/B of the publisher block on CAPTIONS (2026-08-21 evidence); it stores nothing and never reads a frame',
}

/** Every file in the tree that invokes `name(`, with its argument texts. */
function callersOf(name: string): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const [file, src] of code) {
    const calls = callsOf(src, name)
    if (calls.length > 0) out.set(file, calls)
  }
  return out
}

/** Invocations of any function whose name matches `pattern` (definitions excluded). */
function filesCalling(pattern: RegExp): string[] {
  const out: string[] = []
  for (const [file, src] of code) {
    for (const m of src.matchAll(new RegExp(pattern.source, 'g'))) {
      const before = src.slice(Math.max(0, m.index - 30), m.index)
      if (/\b(function|async)\s+$/.test(before)) continue
      out.push(file)
      break
    }
  }
  return out
}

describe('one judging path — discovered, not listed', () => {
  /**
   * The walk itself is the first thing that can break, and a walk that finds nothing makes
   * every rule below pass vacuously. So it must find the files we KNOW judge posts.
   */
  it('discovers the callers it is about (a walk that finds nothing would pass everything)', () => {
    expect(FILES.length).toBeGreaterThan(50)
    const judging = [...callersOf('judgeWithFrame').keys()]
    for (const f of ['src/detection/pipeline.ts', 'src/scripts/accuracy.ts', 'src/scripts/classify.ts', 'src/scripts/rejudgeChannel.ts']) {
      expect(judging, `${f} should be a discovered judgeWithFrame caller`).toContain(f)
    }
    expect(callsOf(code.get(JUDGE)!, 'applyFrameSignal').length, 'judge.ts must compose through the table').toBeGreaterThanOrEqual(2)
    expect(callsOf(code.get(JUDGE)!, 'readFrameText').length, 'judge.ts must read the frame').toBe(1)
  })

  /**
   * `applyFrameSignal` is the permission table and `readFrameText` is the footage. A file
   * reaching for either directly is re-implementing the caption-then-frame sequence — which is
   * exactly how the detector and the harness came to skip the watermark strip. judge.ts is the
   * only file allowed to hold that sequence; everyone else asks it.
   */
  it.each([
    ['applyFrameSignal', /\bapplyFrameSignal\(/],
    ['readFrameText', /\breadFrameText\(/],
    ['the own-mark frame strip', /\bstripOwnMarksFromFrame\w*\(/],
  ])('%s is invoked in judge.ts and nowhere else', (_label, pattern) => {
    const callers = filesCalling(pattern)
    expect(callers, 'the grep found no caller at all — it is broken').toContain(JUDGE)
    expect(callers.filter((f) => f !== JUDGE)).toEqual([])
  })

  /**
   * Frame text reaches the model from judge.ts ONLY. `classifyCaption`'s third argument is the
   * frame block; every other caller must pass the literal `null`, so a second frame path cannot
   * be built out of a caption call either.
   */
  it('every classifyCaption call outside judge.ts passes NO frame text', () => {
    const callers = callersOf('classifyCaption')
    expect(callers.has(DETECTOR), 'the detector\'s caption call was not found — the grep is broken').toBe(true)
    for (const [file, calls] of callers) {
      if (file === JUDGE) continue
      for (const args of calls) {
        expect(topLevelArgs(args)[2], `${file} sends a frame argument: classifyCaption(${args.slice(0, 120)})`).toBe('null')
      }
    }
  })

  /**
   * Anything that asks the model about a post must let judge.ts read its footage — or say, in
   * EXEMPT, why it does not. `.classify(` counts: the detector returns the CAPTION verdict
   * only, so a caller that stores it without judgeWithFrame stores a verdict nothing looked at
   * the footage for (what `pnpm reclassify` did, over human labels).
   */
  it('every file asking the model about a post also calls judgeWithFrame, or is exempt with a reason', () => {
    const askers = new Set([...callersOf('classifyCaption').keys(), ...callersOf('.classify').keys()])
    askers.delete(DETECTOR)
    askers.delete(JUDGE)
    expect(askers.size, 'no caller found — the grep is broken').toBeGreaterThan(0)
    for (const file of askers) {
      if (EXEMPT[file]) continue
      expect(callsOf(code.get(file)!, 'judgeWithFrame').length, `${file} asks the model and never calls judgeWithFrame`).toBeGreaterThan(0)
    }
    // An exemption for a file that no longer asks anything is stale, and stale exemptions rot.
    for (const file of Object.keys(EXEMPT)) expect(askers, `${file} is exempt but asks nothing`).toContain(file)
  })

  /**
   * The frame call is gated on `optedOut` in ONE place. MEASURED: 64% of OCR runs were
   * against our own retired pages — channels we watch for ground truth and will never
   * message. Saving their frames is right; spending a classifier call on them is not.
   */
  it('gates the frame call on optedOut inside the shared judge', () => {
    const judge = code.get(JUDGE)!
    expect(judge).toMatch(/if \(input\.optedOut\) return \{ \.\.\.base, reason: 'opted-out' \}/)
  })

  /**
   * The permission table must stay a table. If `judge.ts` ever writes a verdict without
   * asking it, the "footage may only escalate" guarantee becomes a comment again.
   */
  it('never lets the judge assign a verdict the permission table did not produce', () => {
    const judge = code.get(JUDGE)!
    expect(judge).not.toMatch(/verdict:\s*withFrame\b/)
    expect(judge).not.toMatch(/verdict:\s*withFrameCall\./)
  })
})
