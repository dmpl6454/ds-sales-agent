import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { classifyCaption, MIN_JUDGEABLE_CAPTION } from '@/detection/detectors/semantic'

/**
 * ── THE CAPTION FLOOR MUST NOT VETO A CALL THAT CARRIES FOOTAGE ───────────────────────
 *
 * MEASURED against the live corpus, 2026-08-17: **83 of 83 posts carrying
 * `frame:call-failed` had a caption under 15 characters, and all 83 carried frame text.**
 * Not one was a failed call. `judgeWithFrame` passes the frame prompt to `classifyCaption`,
 * and the caption-length floor returned null before any request was made — so no `ModelCall`
 * row was written either, which is why the cost table showed 1,912 successes and one
 * failure while 83 posts sat unjudged.
 *
 * The population is exactly the one the footage feature exists for: a one-word caption on a
 * reel whose video carries the evidence. What was sitting there unread included `BALMAIN`
 * and `EUGENIX HAIRSCIENCES`, and `x300Ultra` — a Vivo handset, on the channel whose only
 * two disclosure-confirmed paid posts are both Vivo.
 *
 * These tests intercept `fetch`, so no request is made and no key is needed. What is being
 * asserted is WHETHER THE MODEL IS ASKED, which is the whole defect — a test that mocked
 * `classifyCaption` itself could not see it.
 */

const SHORT = 'Nayanthara' // 10 chars, under the floor
const LONG = 'Thanekars have double reasons to celebrate, the first double decker bus'
const FRAME = 'LARGE TEXT ACROSS THE FRAME: THANE\'s First Double Decker Bus'

let calls: number

function answerOnce() {
  return {
    ok: true,
    status: 200,
    async json() {
      return {
        choices: [{ message: { content: JSON.stringify({ verdict: 'ORGANIC', confidence: 90, reason: 'test' }) } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, prompt_cache_hit_tokens: 0 },
      }
    },
    async text() { return '' },
  }
}

beforeEach(() => {
  calls = 0
  process.env.DEEPSEEK_API_KEY = 'test-key-not-used'
  vi.stubGlobal('fetch', async () => { calls++; return answerOnce() as any })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('classifyCaption — when is the model actually asked', () => {
  it('a SHORT caption with NO footage is still never sent to the model', async () => {
    const verdict = await classifyCaption(SHORT, 'shortcode', null, null)
    expect(calls).toBe(0)
    expect(verdict).toBeNull()
  })

  it('an empty frame block does not count as evidence', async () => {
    await classifyCaption(SHORT, 'shortcode', '', null)
    await classifyCaption(SHORT, 'shortcode', '   \n ', null)
    expect(calls).toBe(0)
  })

  /**
   * THE FIX. Before this, the call was vetoed and the caller recorded the null as
   * `frame:call-failed` — a name asserting the opposite of what happened.
   */
  it('a SHORT caption WITH footage is judged, because the footage is the evidence', async () => {
    const verdict = await classifyCaption(SHORT, 'shortcode', FRAME, null)
    expect(calls).toBe(1)
    expect(verdict).not.toBeNull()
  })

  it('a long caption is judged with or without footage', async () => {
    await classifyCaption(LONG, 'shortcode', null, null)
    expect(calls).toBe(1)
    await classifyCaption(LONG, 'shortcode', FRAME, null)
    expect(calls).toBe(2)
  })

  /**
   * TAGS MUST NOT LIFT THE FLOOR, and this is the direction that would corrupt the one
   * number saying whether reading video earns its keep.
   *
   * A post is judged twice — caption alone, then with frame text — and `applyFrameSignal`
   * attributes any difference to THE FOOTAGE. Tags belong to the post and reach BOTH calls.
   * If tags lifted the floor, a short-caption post with tags and no frame would be judged on
   * the second call and skipped on the first, and the disagreement would be recorded as
   * `frame:disagreed-higher` — the footage credited for something it never saw.
   */
  it('tags alone do NOT lift the floor', async () => {
    await classifyCaption(SHORT, 'shortcode', null, 'TAGGED ACCOUNTS: @balmain')
    expect(calls).toBe(0)
  })

  it('the floor itself is unchanged at 15', () => {
    expect(MIN_JUDGEABLE_CAPTION).toBe(15)
  })

  /**
   * MUTATION TEST. Reverting the guard to the caption-only form makes the third test above
   * fail, which is asserted here directly so the fix cannot be "simplified" back: a caption
   * one character under the floor, with footage, must still reach the model.
   */
  it('a caption ONE character under the floor still reaches the model when there is footage', async () => {
    const justUnder = 'x'.repeat(MIN_JUDGEABLE_CAPTION - 1)
    expect(justUnder.trim().length).toBeLessThan(MIN_JUDGEABLE_CAPTION)

    await classifyCaption(justUnder, 'shortcode', FRAME, null)
    expect(calls).toBe(1)
  })

  it('no API key still refuses, whatever evidence is present', async () => {
    delete process.env.DEEPSEEK_API_KEY
    const verdict = await classifyCaption(SHORT, 'shortcode', FRAME, null)
    expect(calls).toBe(0)
    expect(verdict).toBeNull()
  })
})
