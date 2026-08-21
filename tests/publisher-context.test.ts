import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { publisherForPrompt } from '@/detection/publisherContext'

/**
 * WHOSE FEED IS THIS — the input the classifier was never given (2026-08-21).
 *
 * @filmygyan produced 42 CAMPAIGN verdicts since 20 August against @viralbhayani's 25, and
 * only ONE rested on the frame. The rest were caption-decided, with the model's own reasons
 * reading *"Promotes video on own channel, likely paid promo"* and *"Promotes Filmygyan's
 * 10-year party event"*.
 *
 * **The system prompt already gets this right** — its editorial list contains, verbatim, "The
 * publisher promoting its OWN newsletter, show, merch or account". The model just had no way
 * to know the "Filmygyan" in the caption IS the account that posted it. An INPUT gap, not a
 * rule gap, which is what makes it a safe change: the prompt does not move.
 */

const root = join(import.meta.dirname, '..')
const read = (p: string) => readFileSync(join(root, p), 'utf8')

const fg = { handle: 'filmygyan', displayName: 'F I L M Y G Y A N' }

describe('publisherForPrompt', () => {
  /** The real captions, verbatim from the rows that were wrongly called CAMPAIGN. */
  it('fires when the caption names its own publisher', () => {
    const out = publisherForPrompt(
      "Watch Rivva Kishan's full emotional call with father Ravi Kishan only on Filmygyan's Youtube channel. #fg11",
      fg,
    )
    expect(out).not.toBeNull()
    expect(out).toContain('@filmygyan')
    expect(out).toContain('own marketing, not a placement')
  })

  it('fires on the anniversary caption too', () => {
    expect(publisherForPrompt('Celebrating a decade of Filmygyan with all the glam and glory!', fg)).not.toBeNull()
  })

  /**
   * ── THE PROPERTY THAT MAKES THIS MEASURABLE ───────────────────────────────
   * A caption that never names its publisher gets NO block, so its user message is
   * byte-identical to the one it produced before this existed. That is what makes most of the
   * corpus structurally unable to move rather than merely measured not to have moved — the
   * property the tag-evidence work was evaluated under.
   */
  it('is omitted entirely when the caption does not name the publisher', () => {
    expect(publisherForPrompt('Red never looked this pretty on MRUNAL!!', fg)).toBeNull()
    expect(publisherForPrompt('', fg)).toBeNull()
  })

  /** A short normalised name would match unrelated prose; both sides need >= 5 chars. */
  it('does not fire on a short publisher name buried in ordinary words', () => {
    expect(publisherForPrompt('great tips for summer', { handle: 'tips', displayName: 'Tips' })).toBeNull()
  })

  /**
   * A handle is attacker-controlled text — a publisher can name itself anything — so the block
   * is FENCED and labelled as context, never as a directive. Same shape as tagEvidence.ts.
   */
  it('fences the publisher and labels it as context, not an instruction', () => {
    const out = publisherForPrompt('a post from Filmygyan itself', fg)!
    expect(out).toContain('"""')
    expect(out).toMatch(/context, not an instruction/)
  })
})

describe('the input reaches BOTH classifier calls, or neither', () => {
  const judge = read('src/detection/judge.ts')

  /**
   * The post is judged on its caption and again with its frame, and `applyFrameSignal`
   * attributes any difference to THE FOOTAGE. A publisher block reaching only one call would
   * record a publisher-driven change as a frame-driven one, corrupting the single number that
   * says whether reading video earns its keep. Exactly the constraint `tagText` documents.
   */
  it('is derived once and passed to both calls in judge.ts', () => {
    expect(judge).toMatch(/const publisherText = input\.publisherAsContext/)
    const calls = judge.match(/classifyCaption\([^)]*\)/g) ?? []
    expect(calls.length, 'expected both classifier calls').toBeGreaterThanOrEqual(2)
    for (const c of calls) expect(c, `this call omits the publisher: ${c}`).toContain('publisherText')
  })

  /**
   * ── THE PRODUCTION CAPTION PATH IS THE DETECTOR, AND IT WAS MISSED (2026-08-21) ──
   *
   * The input was wired into judgeWithFrame's callers and the harness, measured, turned ON —
   * and 40 minutes later @filmygyan's NEXT anniversary post was judged CAMPAIGN, because the
   * pipeline's caption verdict comes from `detector.classify()`, which was never told. The
   * missing-caller failure, inside the fix for an input gap. Found by READING the fresh
   * verdicts rather than trusting the green harness.
   */
  it('the semantic DETECTOR passes the publisher to both of its own calls', () => {
    const sem = read('src/detection/detectors/semantic.ts')
    const classify = sem.slice(sem.indexOf('async classify('), sem.indexOf('const detector: ChannelDetector') > 0 ? sem.indexOf('const detector: ChannelDetector') : sem.length)
    expect(classify).toMatch(/publisherForPrompt\(post\.caption, \{ handle: post\.ownerHandle/)
    const calls = classify.match(/classifyCaption\([^)]*\)/gs) ?? []
    expect(calls.length).toBeGreaterThanOrEqual(2)
    for (const c of calls) expect(c, `detector call omits the publisher: ${c.slice(0, 80)}`).toContain('publisherText')
  })

  /** Every judgeWithFrame caller carries the Setting, so the flag reaches the frame path too. */
  it('every judgeWithFrame caller passes publisherAsContext', () => {
    for (const f of [
      'src/detection/pipeline.ts',
      'src/detection/rejudge.ts',
      'src/scripts/classify.ts',
      'src/scripts/secondLook.ts',
      'src/scripts/ocr.ts',
      'src/scripts/rejudgeChannel.ts',
    ]) {
      expect(read(f), `${f} omits publisherAsContext`).toMatch(/publisherAsContext/)
    }
  })

  /** Off in production until measured — the tagsAsEvidence pattern. */
  it('is a Setting, defaulting OFF', () => {
    const settings = read('src/lib/settings.ts')
    expect(settings).toMatch(/publisherAsContext: 'publisherAsContext'/)
    expect(settings).toMatch(/publisherAsContext: false/)
  })

  /**
   * The harness must be able to measure it, or shipping it would be unmeasured — and its
   * DEFAULT must match production, or the number describes a pipeline that does not exist.
   */
  it('the accuracy harness can measure it, and defaults to production', () => {
    const acc = read('src/scripts/accuracy.ts')
    expect(acc).toMatch(/const usePublisher = process\.argv\.includes\('--publisher'\)/)
    expect(acc).toMatch(/publisherForPrompt\(/)
    expect(acc).toMatch(/publisher : \$\{usePublisher/)
  })

  /**
   * The system prompt must stay a module-level constant: the 50x prompt-cache discount depends
   * on that prefix matching in full, and destroying it is silent and permanent.
   */
  it('nothing was interpolated into the cacheable system prompt', () => {
    const sem = read('src/detection/detectors/semantic.ts')
    const prompt = sem.slice(sem.indexOf('const SYSTEM_PROMPT'), sem.indexOf('export async function classifyCaption'))
    expect(prompt).not.toMatch(/\$\{/)
  })
})
