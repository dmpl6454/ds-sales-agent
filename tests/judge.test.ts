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
/* The REAL renderer: `@/detection/ocr` is mocked only for `readFrameText`. */
const { framePromptFor } = await import('@/detection/ocr')
type FrameText = import('@/detection/ocr').FrameText

/**
 * What `readFrameText` really returns for a given parsed frame — the prompt from the same
 * renderer with the same nonce — so the strip is exercised on the format production hands
 * it, not on a fake. The fake (`<<frame>>…`) is exactly how the string strip passed its
 * tests for two months while doing nothing in production.
 */
function realFrame(shortcode: string, text: FrameText) {
  const prompt = framePromptFor(text, shortcode)
  return { prompt, evidence: { kind: 'read' as const, hadText: prompt !== null }, text }
}

/**
 * `publisher` is required since 2026-08-21 — a channel's own watermark is not evidence about
 * it. @viralbhayani here so the strip is a no-op for these fixtures; `tests/own-marks.test.ts`
 * drives the stripping itself, including the @filmygyan anniversary frame that forced it.
 */
const publisher = { handle: 'viralbhayani', displayName: 'Viral Bhayani' }
const ordinaryTarget = { shortcode: 'DbtNU9UzWYU', caption: 'a bus in Thane', optedOut: false, detectorKey: 'semantic', publisher }

/** A frame that read cleanly and carries the founding case's decisive token. */
function frameRead() {
  return realFrame('DbtNU9UzWYU', {
    overlay: ["THANE's First Double Decker Bus"],
    smaller: ['SWITCH'],
    misread: [],
    dropped: 0,
    engine: 'vision' as const,
  })
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
  const momPost = { shortcode: 'DmomTest01', caption: 'A wild new campaign from a fast-food giant', optedOut: false, detectorKey: 'mom', publisher: { handle: 'madovermarketing_mom', displayName: 'Mad Over Marketing (M.O.M)' } }

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
    // The REAL rendered block now (judge re-renders after the own-mark strip), so assert its
    // fence and its decisive token rather than the word 'frame' the old fake carried.
    expect(classifyCaption.mock.calls[1]?.[2]).toContain('[BEGIN FRAME-TEXT-')
    expect(classifyCaption.mock.calls[1]?.[2]).toContain('SWITCH')
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

describe('judgeWithFrame — the publisher\'s own watermark is stripped from the STRUCTURED text', () => {
  const fg = { handle: 'filmygyan', displayName: 'F I L M Y G Y A N' }
  const anniversary = {
    shortcode: 'DcRTPMDTTjX',
    caption: 'Celebrating a decade of Filmygyan with all the glam and glory!',
    optedOut: false,
    detectorKey: 'semantic',
    publisher: fg,
  }
  const text = (overlay: string[], smaller: string[] = [], misread: string[] = [], dropped = 0): FrameText => ({
    overlay,
    smaller,
    misread,
    dropped,
    engine: 'rapidocr',
  })

  /**
   * A frame whose only text is the channel's own logo carries NO evidence, and no call is
   * spent on it. The string strip never recognised this shape, so `frame:only-own-marks` was
   * unreachable — and the evidence must say "read, no text", or the table records
   * `frame:read-agreed` about a call that was never made.
   */
  it('(i) a watermark-only frame spends no call and is recorded as own marks, never as agreement', async () => {
    readFrameText.mockResolvedValue(realFrame(anniversary.shortcode, text([], ['FILMYGYAN'])))

    const result = await judgeWithFrame(anniversary, 'ORGANIC')

    expect(classifyCaption).not.toHaveBeenCalled()
    expect(result.verdict).toBe('ORGANIC')
    expect(result.signals).toContain('frame:no-text')
    expect(result.signals).toContain('frame:only-own-marks')
    expect(result.signals).not.toContain('frame:read-agreed')
    expect(result.frameCallMade).toBe(false)
  })

  /** The founding case of the 21 August fix, on the format production actually renders. */
  it('(ii) the anniversary frame reaches the model WITHOUT its watermark and with its fence intact', async () => {
    readFrameText.mockResolvedValue(
      realFrame(anniversary.shortcode, text(['AglamorouscelebrationasFilmygyan', 'marks10amazingyearsintheindustry!'], ['FILMYGYAN'])),
    )
    classifyCaption.mockResolvedValue({ verdict: 'ORGANIC', confidence: 90, reason: 'own anniversary', brands: [] })

    const result = await judgeWithFrame(anniversary, 'ORGANIC')

    expect(classifyCaption).toHaveBeenCalledTimes(1)
    const sent = classifyCaption.mock.calls[0]?.[2] as string
    expect(sent).toContain('marks10amazingyearsintheindustry')
    expect(sent).toContain('[BEGIN FRAME-TEXT-')
    expect(sent).toContain('[END FRAME-TEXT-')
    expect(sent).not.toMatch(/SMALLER TEXT IN THE FRAME: FILMYGYAN/)
    expect(sent).not.toMatch(/\bFILMYGYAN\b/)
    // What we READ is still stored whole — evidence and record are different facts.
    expect(result.frameText).toContain('FILMYGYAN')
    expect(result.frameCallMade).toBe(true)
  })

  /**
   * A RUN-TOGETHER COLLABORATION CARD IS EVIDENCE, NOT A WATERMARK (review, 2026-10-09).
   * OCR emits `FILMYGYANxACER` as one word, and the caption rule's affix branch read it as the
   * publisher's logo — so a frame whose only text was the collab card made no call and was
   * filed `frame:only-own-marks`, which nothing ever retries. That is a genuine placement
   * missed permanently; the frame must reach the model.
   */
  it('(i-b) a frame whose only text is a run-together collab card is SENT, never filed as own marks', async () => {
    readFrameText.mockResolvedValue(realFrame(anniversary.shortcode, text([], ['FILMYGYANxACER'])))
    classifyCaption.mockResolvedValue({ verdict: 'CAMPAIGN', confidence: 90, reason: 'acer collab', brands: [] })

    const result = await judgeWithFrame(anniversary, 'ORGANIC')

    expect(classifyCaption).toHaveBeenCalledTimes(1)
    expect(classifyCaption.mock.calls[0]?.[2] as string).toContain('FILMYGYANxACER')
    expect(result.signals).not.toContain('frame:only-own-marks')
    expect(result.frameCallMade).toBe(true)
  })

  /** A code-shaped brand (`VH1`, the channel) under @viralbhayani is not the publisher's code. */
  it('(i-c) a code-shaped brand is sent, not read as the publisher’s series code', async () => {
    readFrameText.mockResolvedValue(realFrame('DvhTest001', text(['VH1'])))
    classifyCaption.mockResolvedValue({ verdict: 'CAMPAIGN', confidence: 90, reason: 'channel promo', brands: [] })

    const result = await judgeWithFrame({ ...ordinaryTarget, shortcode: 'DvhTest001' }, 'ORGANIC')

    expect(classifyCaption).toHaveBeenCalledTimes(1)
    expect(result.signals).not.toContain('frame:only-own-marks')
  })

  /** The string strip deleted the BEGIN fence on exactly this shape. */
  it('(iii) a watermark first in the first group leaves the BEGIN fence and its neighbour', async () => {
    readFrameText.mockResolvedValue(realFrame(anniversary.shortcode, text(['FILMYGYAN', 'NIKE AIR'], ['JUST DO IT'])))
    classifyCaption.mockResolvedValue({ verdict: 'ORGANIC', confidence: 90, reason: 'x', brands: [] })

    await judgeWithFrame(anniversary, 'ORGANIC')

    const sent = classifyCaption.mock.calls[0]?.[2] as string
    expect(sent.startsWith('[BEGIN FRAME-TEXT-')).toBe(true)
    expect(sent).toContain('NIKE AIR')
    expect(sent).toContain('JUST DO IT')
  })

  /**
   * A frame with none of the publisher's marks is sent BYTE-IDENTICAL to what `readFrameText`
   * rendered — so every frame call that was right before this change is unchanged by it.
   */
  it('(iv) the Thane frame under @viralbhayani is sent byte-identical', async () => {
    const frame = frameRead()
    readFrameText.mockResolvedValue(frame)
    classifyCaption.mockResolvedValue({ verdict: 'CAMPAIGN', confidence: 88, reason: 'bus as product', brands: [] })

    await judgeWithFrame(ordinaryTarget, 'ORGANIC')

    expect(classifyCaption.mock.calls[0]?.[2]).toBe(frame.prompt)
  })

  /**
   * Text that survived the strip but is too weak to render is NOT "only own marks" — folding it
   * in would conflate the weak-evidence rule with the own-mark rule in the stored signal.
   */
  it('(v) a surviving misread item is not labelled as own marks', async () => {
    readFrameText.mockResolvedValue(realFrame(anniversary.shortcode, text(['FILMYGYAN'], [], ['acerpu'])))

    const result = await judgeWithFrame(anniversary, 'ORGANIC')

    expect(classifyCaption).not.toHaveBeenCalled()
    expect(result.signals).not.toContain('frame:only-own-marks')
    expect(result.signals).toContain('frame:only-weak-text-left')
  })

  /** This file is now the one writer of engine provenance: every result that read anything. */
  it('(vi) every post-read return carries the engine, and the unreadable count when there is one', async () => {
    // stripped to nothing — no call
    readFrameText.mockResolvedValue(realFrame(anniversary.shortcode, text([], ['FILMYGYAN'], [], 2)))
    let result = await judgeWithFrame(anniversary, 'ORGANIC')
    expect(result.signals).toContain('frame:engine-rapidocr')
    expect(result.signals).toContain('frame:dropped-2-unreadable')

    // call failed
    readFrameText.mockResolvedValue(frameRead())
    classifyCaption.mockResolvedValue(null)
    result = await judgeWithFrame(ordinaryTarget, 'ORGANIC')
    expect(result.signals).toEqual(expect.arrayContaining(['frame:call-failed', 'frame:engine-vision']))

    // judged
    classifyCaption.mockResolvedValue({ verdict: 'ORGANIC', confidence: 90, reason: 'x', brands: [] })
    result = await judgeWithFrame(ordinaryTarget, 'ORGANIC')
    expect(result.signals).toEqual(expect.arrayContaining(['frame:read-agreed', 'frame:engine-vision']))

    // nothing read — no engine to name
    readFrameText.mockResolvedValue({ prompt: null, evidence: { kind: 'no-frame' as const }, text: null })
    result = await judgeWithFrame(ordinaryTarget, 'ORGANIC')
    expect(result.signals.some((sig) => sig.startsWith('frame:engine-'))).toBe(false)
  })

  /** The marker the detector's own frame stage used to write, carried on by judge. */
  it('marks a semantic caption CAMPAIGN as not needing the footage', async () => {
    const result = await judgeWithFrame(ordinaryTarget, 'CAMPAIGN')
    expect(result.signals).toContain('frame:not-needed-caption-decided')
    expect(readFrameText).not.toHaveBeenCalled()
  })
})

describe('judgeWithFrame — the inputs the caller already built are used, not re-derived', () => {
  const momPost = {
    shortcode: 'DmomTest02',
    caption: 'Mad Over Marketing M.O.M turns ten this week',
    optedOut: false,
    detectorKey: 'mom',
    publisher: { handle: 'madovermarketing_mom', displayName: 'Mad Over Marketing (M.O.M)' },
    publisherAsContext: true,
  }

  /**
   * The detector's caption call and judge's frame call must carry the SAME publisher block,
   * or `applyFrameSignal` blames the footage for a publisher-driven difference. A caller that
   * judged the caption with a block hands it in, and that block wins over a second derivation.
   */
  it('uses publisherText verbatim in BOTH calls, even where a derived block would differ', async () => {
    classifyCaption.mockResolvedValue({ verdict: 'ORGANIC', confidence: 90, reason: 'x', brands: [] })
    readFrameText.mockResolvedValue(frameRead())

    await judgeWithFrame({ ...momPost, publisherText: 'X' }, 'ORGANIC')

    expect(classifyCaption).toHaveBeenCalledTimes(2)
    expect(classifyCaption.mock.calls[0]?.[4]).toBe('X')
    expect(classifyCaption.mock.calls[1]?.[4]).toBe('X')
  })

  it('a null publisherText is used too — null is an answer, not an absence', async () => {
    classifyCaption.mockResolvedValue({ verdict: 'ORGANIC', confidence: 90, reason: 'x', brands: [] })
    readFrameText.mockResolvedValue(frameRead())

    await judgeWithFrame({ ...momPost, publisherText: null }, 'ORGANIC')

    expect(classifyCaption.mock.calls[0]?.[4]).toBeNull()
    expect(classifyCaption.mock.calls[1]?.[4]).toBeNull()
  })

  it('derives the block when the caller supplies none (the backfills)', async () => {
    classifyCaption.mockResolvedValue({ verdict: 'ORGANIC', confidence: 90, reason: 'x', brands: [] })
    readFrameText.mockResolvedValue(frameRead())

    await judgeWithFrame(momPost, 'ORGANIC')

    const derived = classifyCaption.mock.calls[0]?.[4] as string
    expect(derived).toContain('@madovermarketing_mom ("Mad Over Marketing (M.O.M)")')
    expect(classifyCaption.mock.calls[1]?.[4]).toBe(derived)
  })

  /**
   * The accuracy harness passes `costSubject: null` so its spend is not booked on `/cost` as
   * detection spend on the labelled channel. Production passes nothing and books the shortcode.
   */
  it('books both calls under the shortcode by default, under nothing when costSubject is null', async () => {
    classifyCaption.mockResolvedValue({ verdict: 'ORGANIC', confidence: 90, reason: 'x', brands: [] })
    readFrameText.mockResolvedValue(frameRead())

    await judgeWithFrame(momPost, 'ORGANIC')
    expect(classifyCaption.mock.calls.map((c) => c[1])).toEqual(['DmomTest02', 'DmomTest02'])

    classifyCaption.mockClear()
    await judgeWithFrame({ ...momPost, costSubject: null }, 'ORGANIC')
    expect(classifyCaption.mock.calls.map((c) => c[1])).toEqual([undefined, undefined])
  })
})
