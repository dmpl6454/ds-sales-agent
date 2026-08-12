import { describe, expect, it } from 'vitest'
import { pickThumbnail, MIN_THUMB_WIDTH } from '@/detection/feed'

/**
 * Which frame we keep, and why we keep one at all.
 *
 * ── THE FINDING BEHIND THIS FILE (2026-08-07) ─────────────────────────────
 *
 * Tabish flagged `DbtNU9UzWYU` as paid; the classifier said ORGANIC and its reason was
 * defensible — *"news of a new bus, no promotion or brand brief"* — because the classifier
 * reads the CAPTION and the evidence was in the FOOTAGE. Fetching the reel's cover frame
 * showed a **SWITCH** (Ashok Leyland EV) double-decker centre-frame plus a supplied-looking
 * title card, none of which the caption mentions.
 *
 * So the corpus now records the cover frame's URL. MEASURED against the live endpoint:
 * 11 candidate sizes on 12/12 posts, 480px ≈ 35 KB, HTTP 200. Nothing classifies on it yet
 * — these are CDN URLs that EXPIRE, and a corpus recorded without them cannot be
 * re-examined later, which is the whole reason to capture now rather than when it is used.
 */
describe('pickThumbnail', () => {
  const real = [
    { url: 'u150', width: 150, height: 266 },
    { url: 'u240', width: 240, height: 426 },
    { url: 'u480', width: 480, height: 853 },
    { url: 'u640', width: 640, height: 1137 },
    { url: 'u1080', width: 1080, height: 1920 },
  ]

  it('takes the smallest frame that is still legible, not the largest', () => {
    // 1080px is offered and deliberately not chosen: 480px reads a bumper badge for a
    // third of the bytes, and ~60 posts a day makes that difference matter.
    expect(pickThumbnail(real)?.url).toBe('u480')
  })

  it('ignores candidate order — the endpoint is not required to sort', () => {
    const shuffled = [real[4]!, real[0]!, real[2]!, real[3]!, real[1]!]
    expect(pickThumbnail(shuffled)?.url).toBe('u480')
  })

  /**
   * A too-small frame is still evidence. Returning null here would discard the only
   * cover frame that post will ever have — the same "absence of data is not a verdict"
   * discipline as everywhere else in this pipeline.
   */
  it('falls back to the LARGEST when everything is below the floor', () => {
    expect(pickThumbnail([real[0]!, real[1]!])?.url).toBe('u240')
  })

  it('returns null when there is genuinely nothing — a text post', () => {
    expect(pickThumbnail([])).toBeNull()
  })

  /** A malformed candidate must not take the whole page's parse down with it. */
  it('skips malformed candidates rather than throwing', () => {
    expect(
      pickThumbnail([null, undefined, {}, { url: 'no-width' }, { width: 600 }, real[2]!])?.url,
    ).toBe('u480')
  })

  it('the floor is exported so it is one place to change', () => {
    expect(MIN_THUMB_WIDTH).toBe(480)
  })

  it('treats the floor as inclusive', () => {
    expect(pickThumbnail([{ url: 'exact', width: MIN_THUMB_WIDTH, height: 800 }])?.url).toBe('exact')
  })
})
