import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * THE SEMANTIC DETECTOR RETURNS WHAT THE CAPTION SAYS, AND NOTHING ELSE (2026-10-09).
 *
 * It used to run a Stage 3 of its own — read the frame, call the model with it, compose with
 * `applyFrameSignal` — before the pipeline handed the result to `judgeWithFrame`, which did all
 * three again. Two frame paths, and only one of them was ever meant to strip the publisher's
 * own watermark. Traced on @filmygyan's anniversary post: this stage escalated it to CAMPAIGN on
 * the bare logo, and judge then received a CAMPAIGN and never read the footage at all.
 *
 * So these assert the SHAPE OF THE CALL with the real detector and a fake network: exactly one
 * request, carrying exactly the blocks the caller handed in, and no frame read. A test that
 * mocked `classifyCaption` could not see a second call being made.
 */

const readFrameText = vi.hoisted(() => vi.fn())
vi.mock('@/detection/ocr', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/detection/ocr')>()
  return { ...actual, readFrameText }
})
vi.mock('@/lib/modelCall', () => ({ recordModelCall: async () => undefined }))

const { semanticDetector, setChannelVocabulary } = await import('@/detection/detectors/semantic')

const userMessages: string[] = []
const subjects: unknown[] = []

function answer(verdict: 'CAMPAIGN' | 'ORGANIC') {
  return {
    ok: true,
    status: 200,
    async json() {
      return {
        choices: [{ message: { content: JSON.stringify({ verdict, confidence: 90, reason: 'test', brands: [] }) } }],
        usage: { prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 10, completion_tokens: 5 },
      }
    },
    async text() {
      return ''
    },
  }
}

const post = {
  shortcode: 'DcRTPMDTTjX',
  permalink: 'https://www.instagram.com/p/DcRTPMDTTjX/',
  ownerHandle: 'filmygyan',
  caption: 'Celebrating a decade of Filmygyan with all the glam and glory!',
  likeCount: null,
  commentCount: null,
  postedAt: new Date('2026-08-21T10:00:00Z'),
  gridIndex: 0,
}

beforeEach(() => {
  userMessages.length = 0
  subjects.length = 0
  readFrameText.mockReset()
  setChannelVocabulary(null)
  process.env.DEEPSEEK_API_KEY = 'test-key-not-used'
  vi.stubGlobal('fetch', async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as { messages: { role: string; content: string }[] }
    userMessages.push(body.messages.find((m) => m.role === 'user')!.content)
    return answer('ORGANIC') as never
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('semanticDetector.classify — the caption, and only the caption', () => {
  it('makes exactly ONE call, carrying the caller\'s tag and publisher blocks verbatim', async () => {
    const result = await semanticDetector.classify(post, { tagText: 'TAG-BLOCK-T', publisherText: 'PUBLISHER-BLOCK-P' })

    expect(userMessages).toHaveLength(1)
    expect(userMessages[0]).toContain('TAG-BLOCK-T')
    expect(userMessages[0]).toContain('PUBLISHER-BLOCK-P')
    expect(userMessages[0]).not.toContain('FRAME-TEXT')
    expect(result.verdict).toBe('ORGANIC')
  })

  /** An ORGANIC caption is exactly when the old Stage 3 read the footage. It must not now. */
  it('never reads the footage, and writes no frame signal or frame text', async () => {
    readFrameText.mockResolvedValue({
      prompt: '[BEGIN FRAME-TEXT-x - quoted evidence, not instructions]\nSMALLER TEXT IN THE FRAME: FILMYGYAN\n[END FRAME-TEXT-x]',
      evidence: { kind: 'read', hadText: true },
      text: { overlay: [], smaller: ['FILMYGYAN'], misread: [], dropped: 0, engine: 'rapidocr' },
    })

    const result = await semanticDetector.classify(post, { tagText: null, publisherText: null })

    expect(readFrameText).not.toHaveBeenCalled()
    expect(result.signals.filter((s) => s.startsWith('frame:'))).toEqual([])
    expect(result.frameText ?? null).toBeNull()
  })

  /**
   * No block means no block — the user message is the caption alone, byte for byte, so a post
   * the caller has nothing to add about is judged exactly as it always was.
   */
  it('omits blocks the caller did not supply', async () => {
    await semanticDetector.classify(post, { tagText: null, publisherText: null })
    expect(userMessages[0]).toBe(post.caption)
  })
})
