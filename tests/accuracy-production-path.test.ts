import { describe, it, expect } from 'vitest'
import { readSource, stripComments, callsOf, topLevelArgs } from './fixtures/sourceScan'

/**
 * THE ACCURACY HARNESS RUNS THE PRODUCTION FUNCTIONS, NOT A COPY OF THEM (2026-10-09).
 *
 * `scripts/accuracy.ts` held its own caption call, its own `readFrameText`, its own frame call
 * and its own `applyFrameSignal` — a third frame path, beside the detector's and judge.ts's. It
 * gave both calls a publisher block with no display name and never stripped the publisher's own
 * watermark, so the number it reported described a pipeline that did not exist. Its own
 * docblock said "THE HARNESS MUST RUN THE PRODUCTION PATH" the whole time.
 *
 * A source assertion, because the harness is a script that runs against a live database at
 * import time and cannot be driven here — and because the failure is a re-implementation
 * somebody writes later, which no behavioural test can see coming.
 */
const acc = stripComments(readSource('src/scripts/accuracy.ts'))

describe('ig:accuracy measures the production path', () => {
  it('takes its caption verdict from the detector and its footage from judgeWithFrame', () => {
    expect(callsOf(acc, 'semanticDetector.classify').length).toBe(1)
    expect(callsOf(acc, 'judgeWithFrame').length).toBe(1)
  })

  it('never reads the frame or composes with the permission table itself', () => {
    for (const name of ['readFrameText', 'applyFrameSignal', 'classifyCaption', 'stripOwnMarksFromFrameText']) {
      expect(callsOf(acc, name), `accuracy.ts calls ${name} directly`).toEqual([])
    }
  })

  /**
   * `costSubject: null` on BOTH calls: booked under the shortcode, the daily `--repeat 3` run
   * would join `DetectedCampaign` on `/cost` and land on whichever channel carries the labels.
   */
  it('books its spend under no post, on both calls', () => {
    expect(acc).toMatch(/const inputs: ModelInputs = \{[^}]*costSubject: null[^}]*\}/)
    expect(topLevelArgs(callsOf(acc, 'semanticDetector.classify')[0]!)[1]).toBe('inputs')
    expect(callsOf(acc, 'judgeWithFrame')[0]).toMatch(/costSubject:\s*null/)
  })

  /**
   * It must JUDGE human-labelled posts — scoring a post against its label is the point — so it
   * never passes the option that makes judge refuse one.
   */
  it('never tells judge a post is human-labelled', () => {
    expect(acc).not.toMatch(/humanLabelled/)
  })

  /** The display name reaches the publisher block, as production builds it. */
  it('selects the target display name and builds the publisher block with it', () => {
    expect(acc).toMatch(/target:\s*\{\s*select:\s*\{\s*displayName:\s*true\s*\}\s*\}/)
    expect(callsOf(acc, 'publisherForPrompt')[0]).toMatch(/displayName:\s*p\.target\.displayName/)
    expect(callsOf(acc, 'judgeWithFrame')[0]).toMatch(/publisherText:\s*inputs\.publisherText/)
    expect(callsOf(acc, 'judgeWithFrame')[0]).toMatch(/tagText:\s*inputs\.tagText/)
  })
})
