import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * THE PIPELINE'S JUDGING, COMPOSED FROM THE REAL PIECES (2026-10-09).
 *
 * The real input builder the pipeline uses (`modelInputsFor`), the real detector, the real
 * `judgeWithFrame`, and the real frame renderer and own-mark strip — wired exactly as
 * `pipeline.ts` wires them. Only three things are faked: the network (a DeepSeek stand-in), the
 * Setting, and `readFrameText`'s disk read, which returns what the REAL renderer produces.
 *
 * The fake model escalates on a frame block that still contains the publisher's own logo, so
 * these tests fail the moment the watermark reaches the model by ANY route — the detector's old
 * private frame stage, the string strip that never matched the rendered block, or a second
 * construction of the inputs. All three were live at the same time, and each piece's own unit
 * tests were green throughout; only the composition shows it.
 */

const readFrameText = vi.hoisted(() => vi.fn())
vi.mock('@/detection/ocr', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/detection/ocr')>()
  return { ...actual, readFrameText }
})
vi.mock('@/lib/modelCall', () => ({ recordModelCall: async () => undefined }))
vi.mock('@/lib/settings', () => ({
  getSettings: async () => ({ tagsAsEvidence: false, publisherAsContext: true }),
}))

const { modelInputsFor } = await import('@/detection/pipeline')
const { semanticDetector, setChannelVocabulary } = await import('@/detection/detectors/semantic')
const { judgeWithFrame } = await import('@/detection/judge')
const { framePromptFor } = await import('@/detection/ocr')
type FrameText = import('@/detection/ocr').FrameText

const userMessages: string[] = []

/**
 * A DeepSeek stand-in. With no frame block it answers ORGANIC — the caption alone is ordinary,
 * which is what the real classifier said about the anniversary post. With a frame block it
 * escalates iff the block carries the publisher's logo as a standalone word, or `acerpure`:
 * the same mistake the real model made, so the test measures whether the logo GOT THERE.
 */
function fakeModel(_url: string, init: { body: string }) {
  const body = JSON.parse(init.body) as { messages: { role: string; content: string }[] }
  const user = body.messages.find((m) => m.role === 'user')!.content
  userMessages.push(user)
  const frame = user.match(/\[BEGIN FRAME-TEXT[\s\S]*?\[END FRAME-TEXT[^\]]*\]/)?.[0] ?? null
  const verdict = frame && (/\bFILMYGYAN\b/.test(frame) || /acerpure/.test(frame)) ? 'CAMPAIGN' : 'ORGANIC'
  return {
    ok: true,
    status: 200,
    async json() {
      return {
        choices: [{ message: { content: JSON.stringify({ verdict, confidence: 90, reason: 'fake', brands: [] }) } }],
        usage: { prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 10, completion_tokens: 5 },
      }
    },
    async text() {
      return ''
    },
  }
}

const target = { handle: 'filmygyan', displayName: 'F I L M Y G Y A N' }

function feedPost(shortcode: string, caption: string) {
  return {
    shortcode,
    permalink: `https://www.instagram.com/p/${shortcode}/`,
    ownerHandle: target.handle,
    caption,
    likeCount: null,
    commentCount: null,
    postedAt: new Date('2026-08-21T10:00:00Z'),
    gridIndex: 0,
    isPaidPartnership: false,
    sponsorHandles: [],
    collabHandles: [],
    taggedAccounts: [],
    mediaType: 'clips',
    thumbnailUrl: null,
    videoUrl: null,
    videoDurationSeconds: null,
  }
}

function frameOf(shortcode: string, text: FrameText) {
  const prompt = framePromptFor(text, shortcode)
  return { prompt, evidence: { kind: 'read' as const, hadText: prompt !== null }, text }
}

/** Exactly the pipeline's sequence: build once, classify, judge with the same inputs. */
async function judgeAsThePipelineDoes(post: ReturnType<typeof feedPost>) {
  const inputs = await modelInputsFor(post, target, true)
  const cls = await semanticDetector.classify(post, inputs)
  return judgeWithFrame(
    {
      shortcode: post.shortcode,
      caption: post.caption,
      optedOut: false,
      publisher: target,
      publisherAsContext: true,
      detectorKey: semanticDetector.key,
      tagText: inputs.tagText,
      publisherText: inputs.publisherText,
    },
    cls.verdict,
  )
}

beforeEach(() => {
  userMessages.length = 0
  readFrameText.mockReset()
  setChannelVocabulary(null)
  process.env.DEEPSEEK_API_KEY = 'test-key-not-used'
  vi.stubGlobal('fetch', fakeModel as never)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('detection, composed — the publisher\'s own watermark is never evidence', () => {
  /**
   * The founding case of the 21 August fix: the caption is the channel's own anniversary, and
   * the only thing "in shot" is the channel's own logo. Before this change it was stored as
   * CAMPAIGN — escalated by the detector's private frame stage, which never stripped anything.
   */
  it('the anniversary post stays ORGANIC: one OCR read, two calls, one publisher block', async () => {
    const post = feedPost('DcRTPMDTTjX', 'Celebrating a decade of Filmygyan with all the glam and glory!')
    readFrameText.mockResolvedValue(
      frameOf(post.shortcode, {
        overlay: ['AglamorouscelebrationasFilmygyan', 'marks10amazingyearsintheindustry!'],
        smaller: ['FILMYGYAN'],
        misread: [],
        dropped: 0,
        engine: 'rapidocr',
      }),
    )

    const judged = await judgeAsThePipelineDoes(post)

    expect(judged.verdict).toBe('ORGANIC')
    expect(readFrameText).toHaveBeenCalledTimes(1)
    expect(userMessages).toHaveLength(2)
    // The caption call and the frame call carry the SAME publisher block, display name and all.
    const block = (m: string) => m.match(/WHOSE ACCOUNT POSTED THIS[\s\S]*?not a placement someone paid them for\./)?.[0]
    expect(block(userMessages[0]!)).toBeDefined()
    expect(block(userMessages[0]!)).toBe(block(userMessages[1]!))
    expect(block(userMessages[0]!)).toContain('@filmygyan ("F I L M Y G Y A N")')
    // And the frame call saw the title card, but not the logo.
    expect(userMessages[1]).toContain('marks10amazingyearsintheindustry')
    expect(userMessages[1]).not.toMatch(/\bFILMYGYAN\b/)
  })

  /**
   * THE CONTROL, and it carries as much weight as the founding case: a real acerpure placement
   * on the same channel, beside the same logo, must still escalate. A fix that stopped this
   * would trade recall, which this project never does.
   */
  it('a real placement beside the logo still escalates to CAMPAIGN, and says why', async () => {
    const post = feedPost('DcRB5e1Cy_M', 'Pose toh Akshay Kumar sir, full video on Filmygyan')
    readFrameText.mockResolvedValue(
      frameOf(post.shortcode, {
        overlay: ['acerpu', 'Pose toh AkshayKumar sir'],
        smaller: ['acerpure', 'BaDolby', '120Hz', 'FILMYGYAN'],
        misread: [],
        dropped: 0,
        engine: 'rapidocr',
      }),
    )

    const judged = await judgeAsThePipelineDoes(post)

    expect(judged.verdict).toBe('CAMPAIGN')
    expect(judged.changedByFrame).toBe(true)
    expect(judged.signals).toEqual(expect.arrayContaining(['frame:escalated-to-campaign', 'frame:engine-rapidocr']))
    expect(userMessages[1]).toContain('acerpure')
    expect(userMessages[1]).not.toMatch(/\bFILMYGYAN\b/)
  })

  /** A logo-only frame costs no frame call at all, and is recorded as what it is. */
  it('a frame that is only the logo spends no frame call', async () => {
    const post = feedPost('DcOnlyLogo1', 'Celebrating a decade of Filmygyan with all the glam and glory!')
    readFrameText.mockResolvedValue(
      frameOf(post.shortcode, { overlay: [], smaller: ['FILMYGYAN'], misread: [], dropped: 0, engine: 'rapidocr' }),
    )

    const judged = await judgeAsThePipelineDoes(post)

    expect(judged.verdict).toBe('ORGANIC')
    expect(userMessages).toHaveLength(1)
    expect(judged.signals).toContain('frame:only-own-marks')
  })
})
