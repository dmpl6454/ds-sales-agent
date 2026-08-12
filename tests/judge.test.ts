import { describe, expect, it, vi, beforeEach } from 'vitest'

/**
 * The ONE judging path, and the guards that must survive every future caller.
 *
 * The bug this file exists to prevent is not hypothetical: MEASURED 2026-08-08, the
 * pipeline saved 166 cover frames that day and read NONE of them, because it classified
 * captions and `scripts/ocr.ts` held the only frame-aware copy. A feature that works only
 * when a person types a command is not running.
 *
 * So the assertions that matter most are about SPENDING and PERMISSION: the model must
 * not be called when it cannot help, and the footage must never be able to decide.
 */

const classifyCaption = vi.hoisted(() => vi.fn())
const readFrameText = vi.hoisted(() => vi.fn())

vi.mock('@/detection/detectors/semantic', () => ({ classifyCaption }))
vi.mock('@/detection/ocr', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/detection/ocr')>()
  return { ...actual, readFrameText }
})

const { judgeWithFrame } = await import('@/detection/judge')

const ordinaryTarget = { shortcode: 'DbtNU9UzWYU', caption: 'a bus in Thane', optedOut: false, frameJudgingSupported: true }

/** A frame that read cleanly and carries the founding case's decisive token. */
function frameRead() {
  return {
    prompt: '<<frame>>THANE\'s First Double Decker Bus | SWITCH<</frame>>',
    evidence: { kind: 'read' as const, hadText: true },
    text: { overlay: ["THANE's First Double Decker Bus"], smaller: ['SWITCH'], misread: [], dropped: 0, engine: 'vision' as const },
  }
}

beforeEach(() => {
  classifyCaption.mockReset()
  readFrameText.mockReset()
})

describe('judgeWithFrame — what it refuses to spend a call on', () => {
  it('does not read or judge a RETIRED target', async () => {
    const result = await judgeWithFrame({ ...ordinaryTarget, optedOut: true }, 'ORGANIC')

    expect(result.reason).toBe('opted-out')
    expect(result.verdict).toBe('ORGANIC')
    // MEASURED: 64% of OCR runs were against our own retired pages.
    expect(readFrameText).not.toHaveBeenCalled()
    expect(classifyCaption).not.toHaveBeenCalled()
  })

  it('does not judge a channel whose detector cannot use frame text', async () => {
    const result = await judgeWithFrame({ ...ordinaryTarget, frameJudgingSupported: false }, 'ORGANIC')

    expect(result.reason).toBe('unsupported')
    expect(classifyCaption).not.toHaveBeenCalled()
  })

  /**
   * `applyFrameSignal` would refuse to move a CAMPAIGN in either direction, so calling
   * the model for one is paying to be told no.
   */
  it('does not spend a call when the caption verdict already settles it', async () => {
    for (const verdict of ['CAMPAIGN', 'UNCLASSIFIED'] as const) {
      const result = await judgeWithFrame(ordinaryTarget, verdict)
      expect(result.reason).toBe('caption-decisive')
      expect(result.verdict).toBe(verdict)
    }
    expect(classifyCaption).not.toHaveBeenCalled()
  })

  /**
   * A person's answer is the ONLY label that can ever measure recall on video-only
   * placements. Re-judging one would overwrite the measurement with the thing being
   * measured. Checked before every other branch.
   */
  it('never re-judges a post a human has answered', async () => {
    const result = await judgeWithFrame(ordinaryTarget, 'ORGANIC', { humanLabelled: true })

    expect(result.reason).toBe('human-labelled')
    expect(readFrameText).not.toHaveBeenCalled()
    expect(classifyCaption).not.toHaveBeenCalled()
  })
})

describe('judgeWithFrame — the footage may escalate and nothing more', () => {
  it('raises a caption ORGANIC to REVIEW when the footage says commercial', async () => {
    readFrameText.mockResolvedValue(frameRead())
    classifyCaption.mockResolvedValue({ verdict: 'CAMPAIGN', confidence: 88, reason: 'Title presents the bus as a product' })

    const result = await judgeWithFrame(ordinaryTarget, 'ORGANIC')

    // REVIEW, never CAMPAIGN: ig:accuracy's labels are caption-derived, so a
    // frame-driven CAMPAIGN is measured by nothing that exists.
    expect(result.verdict).toBe('REVIEW')
    expect(result.changedByFrame).toBe(true)
    expect(result.frameSummary).toContain('SWITCH')
    expect(result.engine).toBe('vision')
  })

  it('leaves an ORGANIC alone when the footage agrees it is editorial', async () => {
    readFrameText.mockResolvedValue(frameRead())
    classifyCaption.mockResolvedValue({ verdict: 'ORGANIC', confidence: 90, reason: 'salon signage behind a celebrity' })

    const result = await judgeWithFrame(ordinaryTarget, 'ORGANIC')

    expect(result.verdict).toBe('ORGANIC')
    expect(result.changedByFrame).toBe(false)
  })

  it('cannot CLEAR a post: a REVIEW stays REVIEW even when the footage reads ordinary', async () => {
    readFrameText.mockResolvedValue(frameRead())
    classifyCaption.mockResolvedValue({ verdict: 'ORGANIC', confidence: 95, reason: 'nothing commercial' })

    const result = await judgeWithFrame(ordinaryTarget, 'REVIEW')

    expect(result.verdict).toBe('REVIEW')
    expect(result.changedByFrame).toBe(false)
  })
})

describe('judgeWithFrame — absence of evidence never becomes a verdict', () => {
  /**
   * The fail-open direction adversarial review caught in the first design: a failed call
   * was treated as the frame AGREEING, so a network blip could assert a verdict nothing
   * had judged.
   */
  it('leaves the caption verdict untouched when the model call fails', async () => {
    readFrameText.mockResolvedValue(frameRead())
    classifyCaption.mockResolvedValue(null)

    const result = await judgeWithFrame(ordinaryTarget, 'ORGANIC')

    expect(result.verdict).toBe('ORGANIC')
    expect(result.changedByFrame).toBe(false)
    expect(result.signals).toContain('frame:call-failed')
  })

  it.each([
    ['no-frame', { prompt: null, evidence: { kind: 'no-frame' as const }, text: null }],
    ['unavailable', { prompt: null, evidence: { kind: 'unavailable' as const }, text: null }],
    ['failed', { prompt: null, evidence: { kind: 'failed' as const }, text: null }],
  ])('records %s as itself and spends no call', async (_label, frame) => {
    readFrameText.mockResolvedValue(frame)

    const result = await judgeWithFrame(ordinaryTarget, 'ORGANIC')

    expect(result.verdict).toBe('ORGANIC')
    expect(classifyCaption).not.toHaveBeenCalled()
    // The signal comes from the permission table, so the four states stay distinguishable
    // all the way to the dashboard rather than collapsing into "no text found".
    expect(result.signals.length).toBeGreaterThan(0)
  })

  it('treats a low-confidence CAMPAIGN from the frame as REVIEW, not CAMPAIGN', async () => {
    readFrameText.mockResolvedValue(frameRead())
    classifyCaption.mockResolvedValue({ verdict: 'CAMPAIGN', confidence: 55, reason: 'possibly a promo' })

    const result = await judgeWithFrame(ordinaryTarget, 'ORGANIC')

    expect(result.verdict).toBe('REVIEW')
  })
})
