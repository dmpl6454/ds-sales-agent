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

/**
 * Only `classifyCaption` is mocked — it is the network call. `modelVerdictToStored` is the
 * REAL pure mapping, because it is part of what these tests are about: the model's word for
 * "genuinely ambiguous" becoming a paid post is the behaviour under test, and a mock of it
 * would assert the mock.
 */
vi.mock('@/detection/detectors/semantic', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/detection/detectors/semantic')>()
  return { ...actual, classifyCaption }
})
vi.mock('@/detection/ocr', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/detection/ocr')>()
  return { ...actual, readFrameText }
})

const { judgeWithFrame } = await import('@/detection/judge')

const ordinaryTarget = { shortcode: 'DbtNU9UzWYU', caption: 'a bus in Thane', optedOut: false, detectorKey: 'semantic' }

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
    const result = await judgeWithFrame({ ...ordinaryTarget, detectorKey: 'passthrough' }, 'ORGANIC')

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
  it('raises a caption ORGANIC to CAMPAIGN when the footage says commercial', async () => {
    readFrameText.mockResolvedValue(frameRead())
    classifyCaption.mockResolvedValue({ verdict: 'CAMPAIGN', confidence: 88, reason: 'Title presents the bus as a product' })

    const result = await judgeWithFrame(ordinaryTarget, 'ORGANIC')

    // CAMPAIGN since 2026-08-17: there is no third state, and a paid post filed as
    // ordinary is the one error this project refuses. The cross on /paid-posts is the
    // corrective, and it shipped in the same change.
    expect(result.verdict).toBe('CAMPAIGN')
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

  /**
   * The footage may never CLEAR a post, and that survives the binary change unchanged —
   * only the verdict it cannot clear is different. Frame text reading "ordinary" about a
   * post the caption called paid is one weak input disagreeing with a measured one, and
   * acting on it would silently lower recall.
   */
  it('cannot CLEAR a post: a CAMPAIGN stays CAMPAIGN even when the footage reads ordinary', async () => {
    readFrameText.mockResolvedValue(frameRead())
    classifyCaption.mockResolvedValue({ verdict: 'ORGANIC', confidence: 95, reason: 'nothing commercial' })

    const result = await judgeWithFrame(ordinaryTarget, 'CAMPAIGN')

    expect(result.verdict).toBe('CAMPAIGN')
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

  /**
   * The confidence floor no longer downgrades. MEASURED before it was removed: **0 rows in
   * the entire corpus** ever carried `downgraded:confidence-below-70`, so the band had never
   * fired once — and with REVIEW gone the only two places it could land are the verdict
   * itself or ORGANIC, and ORGANIC is a silent loss of recall.
   */
  it('keeps a low-confidence CAMPAIGN from the frame as CAMPAIGN', async () => {
    readFrameText.mockResolvedValue(frameRead())
    classifyCaption.mockResolvedValue({ verdict: 'CAMPAIGN', confidence: 55, reason: 'possibly a promo' })

    const result = await judgeWithFrame(ordinaryTarget, 'ORGANIC')

    expect(result.verdict).toBe('CAMPAIGN')
  })
})

describe('judgeWithFrame — the M.O.M second look (2026-08-17, Tabish\'s decision)', () => {
  const momPost = { shortcode: 'DmomTest01', caption: 'A wild new campaign from a fast-food giant', optedOut: false, detectorKey: 'mom' }

  /**
   * The direction the feature exists for: MEASURED 2026-08-17, 61 in-window M.O.M posts
   * were rule-negative and NOTHING else had ever read them — an undisclosed paid post on
   * that channel was missed with certainty. A rule-negative now reaches the model.
   */
  it('re-judges a rule-negative and escalates when the model says CAMPAIGN', async () => {
    classifyCaption.mockResolvedValue({ verdict: 'CAMPAIGN', confidence: 92, reason: 'campaign-slogan hashtag plus announcement', brands: ['@somebrand'] })

    const result = await judgeWithFrame(momPost, 'ORGANIC')

    expect(result.verdict).toBe('CAMPAIGN')
    expect(result.secondLook).toEqual({ confidence: 92, reason: 'campaign-slogan hashtag plus announcement', brands: ['@somebrand'] })
    expect(result.signals).toContain('second-look:judged')
    // The caption call settled it — no frame is read for a CAMPAIGN, same as everywhere.
    expect(readFrameText).not.toHaveBeenCalled()
    expect(classifyCaption).toHaveBeenCalledTimes(1)
    // Caption first, ALONE: the second-look call carries no frame prompt.
    expect(classifyCaption.mock.calls[0]?.[2]).toBeNull()
  })

  /**
   * THE LABEL DIRECTION, which must never move: a rule POSITIVE is #Collaboration in the
   * caption — the publisher's own disclosure, label-grade. The second look exists for
   * negatives only; spending a model call to second-guess a disclosure would let a model
   * outrank a fact.
   */
  it('NEVER touches a rule-positive — the disclosure is a fact, not an opinion', async () => {
    const result = await judgeWithFrame(momPost, 'CAMPAIGN')

    expect(result.reason).toBe('caption-decisive')
    expect(result.verdict).toBe('CAMPAIGN')
    expect(result.secondLook).toBeNull()
    expect(classifyCaption).not.toHaveBeenCalled()
  })

  it('continues into the frame path when the model agrees the post is ordinary', async () => {
    classifyCaption.mockResolvedValue({ verdict: 'ORGANIC', confidence: 90, reason: 'editorial commentary', brands: [] })
    readFrameText.mockResolvedValue(frameRead())

    const result = await judgeWithFrame(momPost, 'ORGANIC')

    // Two calls: the second look (no frame prompt), then the frame call (with it).
    expect(classifyCaption).toHaveBeenCalledTimes(2)
    expect(classifyCaption.mock.calls[0]?.[2]).toBeNull()
    expect(classifyCaption.mock.calls[1]?.[2]).toContain('frame')
    expect(result.signals).toContain('second-look:judged')
  })

  /**
   * A failed call is never a verdict — the lesson `frame:call-failed` taught at a cost
   * of 83 posts. The rule's ORGANIC stands, and the signal keeps the post selectable by
   * the backfill instead of filing it as judged.
   */
  it('a failed second-look call decides nothing and is named in the signals', async () => {
    classifyCaption.mockResolvedValue(null)
    readFrameText.mockResolvedValue({ prompt: null, evidence: { kind: 'no-frame' as const }, text: null })

    const result = await judgeWithFrame(momPost, 'ORGANIC')

    expect(result.verdict).toBe('ORGANIC')
    expect(result.secondLook).toBeNull()
    expect(result.signals).toContain('second-look:call-failed')
  })

  it('a SEMANTIC channel gets no second look — its caption verdict is already the model\'s', async () => {
    readFrameText.mockResolvedValue({ prompt: null, evidence: { kind: 'no-frame' as const }, text: null })

    const result = await judgeWithFrame(ordinaryTarget, 'ORGANIC')

    expect(result.secondLook).toBeNull()
    // Only the frame path may call the model here, and with no frame there is no call.
    expect(classifyCaption).not.toHaveBeenCalled()
  })
})
