import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { publisherForPrompt } from '@/detection/publisherContext'
import { walkSources, readSource, stripComments, callsOf, topLevelArgs } from './fixtures/sourceScan'

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
    // A caller's own block wins; only in its absence is one derived from the Setting.
    expect(judge).toMatch(/const publisherText =\s*input\.publisherText !== undefined\s*\?\s*input\.publisherText\s*:\s*input\.publisherAsContext/)
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
   *
   * ── AND THEN THE DETECTOR BUILT ITS OWN, WITHOUT THE DISPLAY NAME (2026-10-09) ──
   *
   * Its fix gave the detector a SECOND construction of the block — `displayName: null` — while
   * judge built one with it, so the caption call and the frame call about one post carried
   * different publisher blocks. The detector now builds nothing: it is handed the caller's
   * block and makes exactly one call with it.
   */
  it('the semantic DETECTOR makes ONE caption call, with the block it was handed', () => {
    const sem = stripComments(read('src/detection/detectors/semantic.ts'))
    const classify = sem.slice(sem.indexOf('async classify('))
    const calls = callsOf(classify, 'classifyCaption')
    expect(calls.length).toBe(1)
    expect(topLevelArgs(calls[0]!)[4]).toBe('inputs.publisherText')
    expect(topLevelArgs(calls[0]!)[3]).toBe('inputs.tagText')
    for (const name of ['publisherForPrompt', 'tagsForPost', 'readFrameText', 'applyFrameSignal']) {
      expect(callsOf(classify, name), `the detector builds or reads ${name} itself again`).toEqual([])
    }
  })

  /**
   * The pipeline builds the inputs ONCE and hands the SAME object to the detector and the same
   * fields to judge. Two constructions are two chances to drift; this is how the drift above
   * happened.
   */
  it('pipeline.ts hands the same inputs to the detector and to judgeWithFrame', () => {
    const pipe = stripComments(read('src/detection/pipeline.ts'))
    expect(callsOf(pipe, 'modelInputsFor').length).toBe(1)
    expect(callsOf(pipe, '.classify')).toEqual(['post, inputs'])
    const judged = callsOf(pipe, 'judgeWithFrame')
    expect(judged.length).toBe(1)
    expect(judged[0]).toMatch(/tagText:\s*inputs\.tagText/)
    expect(judged[0]).toMatch(/publisherText:\s*inputs\.publisherText/)
    // The builder is the only place the pipeline makes a publisher block, and it carries the name.
    expect(callsOf(pipe, 'publisherForPrompt')).toEqual(['post.caption, { handle: target.handle, displayName: target.displayName }'])
  })

  /** The backfills that make their own caption call pass ONE block to both of their calls. */
  it.each(['src/scripts/classify.ts', 'src/scripts/rejudgeChannel.ts'])(
    '%s passes its publisher block to both the caption call and judgeWithFrame',
    (file) => {
      const src = stripComments(read(file))
      const caption = callsOf(src, 'classifyCaption')
      expect(caption.length).toBe(1)
      expect(topLevelArgs(caption[0]!)[4]).toBe('publisherText')
      const judged = callsOf(src, 'judgeWithFrame')
      expect(judged.length).toBe(1)
      expect(judged[0]).toMatch(/\bpublisherText\b/)
    },
  )

  /**
   * NO publisher block anywhere is built without the display name. `publisherForPrompt` fires
   * on the handle OR the display name, so a `displayName: null` block silently omits the input
   * for a caption that names the page by its name ("RVCJ Media" on @rvcjinsta) — and differs
   * from the block another call about the same post was given.
   */
  it('no publisherForPrompt call in the tree passes displayName: null', () => {
    let seen = 0
    for (const f of [...walkSources('src'), ...walkSources('scripts')]) {
      for (const args of callsOf(stripComments(readSource(f)), 'publisherForPrompt')) {
        seen++
        expect(args, `${f}: publisherForPrompt(${args})`).not.toMatch(/displayName:\s*null/)
      }
    }
    expect(seen, 'no call found — the grep is broken').toBeGreaterThan(3)
  })

  /** Every judgeWithFrame caller carries the Setting, so the flag reaches the frame path too. */
  it('every judgeWithFrame caller passes publisherAsContext', () => {
    const callers = walkSources('src').filter((f) => callsOf(stripComments(readSource(f)), 'judgeWithFrame').length > 0)
    expect(callers).toEqual(expect.arrayContaining(['src/detection/pipeline.ts', 'src/detection/rejudge.ts', 'src/scripts/accuracy.ts']))
    for (const f of callers) {
      for (const args of callsOf(stripComments(readSource(f)), 'judgeWithFrame')) {
        expect(args, `${f} omits publisherAsContext`).toMatch(/publisherAsContext/)
      }
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
