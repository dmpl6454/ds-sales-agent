import { describe, expect, it } from 'vitest'
import {
  assessWatch,
  watchHealthSentence,
  BUSIEST_CHANNEL_POSTS_PER_DAY,
  FEED_DEPTH_POSTS,
  HOURS_UNTIL_LOSS,
} from '@/detection/watchHealth'

/**
 * The watch alarm, both directions.
 *
 * The direction that usually goes untested is the one that matters here: a HEALTHY watch
 * must render nothing at all. This project's own history says a warning that appears when
 * it should not stops being read — and this alarm exists because a true sentence was
 * already ignored once, so a false one would finish the job.
 */

const NOW = new Date('2026-08-08T06:00:00Z')
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000)
const hoursAgo = (h: number) => minutesAgo(h * 60)

describe('assessWatch', () => {
  it('says nothing at all while the watch is beating', () => {
    const health = assessWatch({ lastBeatAt: minutesAgo(1), fresh: true, now: NOW })

    expect(health.severity).toBe('ok')
    expect(health.estimatedPostsMissed).toBe(0)
    expect(health.estimatedPostsLost).toBe(0)
    // The load-bearing assertion: a healthy watch produces NO sentence to render.
    expect(watchHealthSentence(health)).toBeNull()
  })

  it('is at-risk but loses nothing while the missed posts are still in the feed window', () => {
    const health = assessWatch({ lastBeatAt: hoursAgo(4), fresh: false, now: NOW })

    expect(health.severity).toBe('at-risk')
    expect(health.estimatedPostsLost).toBe(0)
    expect(health.estimatedPostsMissed).toBeGreaterThan(0)
    expect(health.hoursUntilLossBegins).toBeGreaterThan(0)
  })

  /**
   * The real event, replayed. 2026-08-08: down ~20 h, and a restart recovered 108 posts
   * with 9 CAMPAIGN among them. Just past the ~18 h boundary, so a small amount was
   * genuinely unrecoverable — which is the distinction the whole module exists to draw.
   */
  it('reports permanent loss past the feed window, as measured on 2026-08-08', () => {
    const health = assessWatch({ lastBeatAt: hoursAgo(20), fresh: false, now: NOW })

    expect(health.severity).toBe('losing-posts')
    expect(health.estimatedPostsLost).toBeGreaterThan(0)
    expect(health.estimatedPostsMissed).toBeGreaterThan(health.estimatedPostsLost)
    expect(health.hoursUntilLossBegins).toBeNull()
  })

  it('puts the loss boundary where the measured numbers put it, not at a round number', () => {
    // Chosen against the constants so a change to either is caught here rather than
    // silently shifting when the alarm escalates.
    expect(HOURS_UNTIL_LOSS).toBeCloseTo((FEED_DEPTH_POSTS / BUSIEST_CHANNEL_POSTS_PER_DAY) * 24, 5)

    const justInside = assessWatch({ lastBeatAt: hoursAgo(HOURS_UNTIL_LOSS - 0.5), fresh: false, now: NOW })
    const justOutside = assessWatch({ lastBeatAt: hoursAgo(HOURS_UNTIL_LOSS + 0.5), fresh: false, now: NOW })

    expect(justInside.severity).toBe('at-risk')
    expect(justOutside.severity).toBe('losing-posts')
  })

  /**
   * "Never run" is a different fact from "stopped", and it must not be reported with a
   * fabricated estimate. Absence of data hardening into a number is the bug this codebase
   * has produced four times; zero here means NOT COUNTED, and the sentence says so rather
   * than printing "0 posts missed", which would read as good news.
   */
  it('does not invent an estimate when no watch has ever run', () => {
    const health = assessWatch({ lastBeatAt: null, fresh: false, now: NOW })

    expect(health.severity).toBe('losing-posts')
    expect(health.downMinutes).toBeNull()
    expect(health.estimatedPostsMissed).toBe(0)

    const sentence = watchHealthSentence(health)
    expect(sentence).toContain('never run')
    // It must NOT claim a count it cannot know.
    expect(sentence).not.toMatch(/about 0 posts/)
  })

  it('never reports negative time when a beat is somehow in the future', () => {
    const health = assessWatch({ lastBeatAt: new Date(NOW.getTime() + 60_000), fresh: false, now: NOW })

    expect(health.downMinutes).toBe(0)
    expect(health.estimatedPostsMissed).toBe(0)
    expect(health.estimatedPostsLost).toBe(0)
  })
})

describe('watchHealthSentence', () => {
  /**
   * The alarm was ignored once BECAUSE it read as a sending problem. Detection is
   * anonymous and unrelated to autopilot, so the copy must say so in the state where a
   * reader is most likely to dismiss it — autopilot deliberately off.
   */
  it('says this is not about sending, because that is why it was ignored before', () => {
    const sentence = watchHealthSentence(assessWatch({ lastBeatAt: hoursAgo(4), fresh: false, now: NOW }))
    expect(sentence).toMatch(/not about sending/i)
  })

  it('names the cost in posts rather than only in elapsed time', () => {
    const atRisk = watchHealthSentence(assessWatch({ lastBeatAt: hoursAgo(4), fresh: false, now: NOW }))
    expect(atRisk).toMatch(/\d+ posts/)

    const losing = watchHealthSentence(assessWatch({ lastBeatAt: hoursAgo(30), fresh: false, now: NOW }))
    expect(losing).toMatch(/cannot be recovered/i)
  })

  it('distinguishes recoverable from permanent, so acting now is worth something', () => {
    const atRisk = watchHealthSentence(assessWatch({ lastBeatAt: hoursAgo(4), fresh: false, now: NOW }))
    const losing = watchHealthSentence(assessWatch({ lastBeatAt: hoursAgo(30), fresh: false, now: NOW }))

    expect(atRisk).toMatch(/still recoverable/i)
    expect(losing).not.toMatch(/still recoverable/i)
    expect(atRisk).not.toEqual(losing)
  })
})
