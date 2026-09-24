/**
 * How bad is it that the watch is not running?
 *
 * ── WHY THIS IS A MEASUREMENT AND NOT A BOOLEAN ─────────────────────────────
 *
 * The dashboard already said "Nothing is scheduled" when the heartbeat went stale, and it
 * was still not enough. MEASURED 2026-08-08: the watch had been dead for 20 hours, 108
 * posts arrived in a single burst the moment it restarted, and NINE OF THEM WERE PAID.
 * The sentence on screen was true and nobody acted on it, for two reasons worth naming:
 *
 * 1. **It was filed under sending.** It lived in the autopilot card and ended "whatever
 *    this toggle says" — so with autopilot deliberately OFF, which is the current and
 *    correct state, a reader concludes it does not matter. It does. Detection is
 *    ANONYMOUS and has nothing to do with autopilot: it stops too, and unlike a delayed
 *    message, a missed post is GONE.
 * 2. **It had no cost attached.** "No watch process has checked in since yesterday" reads
 *    as an inconvenience. It is not.
 *
 * ── THE ARITHMETIC THAT MAKES THIS URGENT ───────────────────────────────────
 *
 * The anonymous feed is a WINDOW, not a log. It returns the most recent posts and nothing
 * older, so a post that scrolls out of it can never be re-scraped — there is no endpoint
 * that will hand it back. MEASURED over 8 days, @viralbhayani alone posts 49-75 a day
 * (mean ~64), and a detection pass reads ~48 posts deep per channel.
 *
 * So the corpus survives roughly `FEED_DEPTH / postsPerDay` — about **eighteen hours** —
 * and the 20-hour outage cleared it by about an hour. That is the whole point: this is not
 * a gauge that climbs steadily. It is fine, fine, fine, and then permanently lossy, and
 * the operator gets no second chance to notice.
 *
 * PURE, so both directions are testable — including the one that matters, which is that a
 * HEALTHY watch never renders an alarm. A warning that cries wolf gets ignored precisely
 * when it counts, and this file exists because a true sentence was already ignored once.
 */

/** How many posts a detection pass reads per channel, per its page count. */
export const FEED_DEPTH_POSTS = 48

/**
 * MEASURED across 8 days of stored @viralbhayani posts (49, 66, 66, 74, 66, 72, 59, 75).
 * The busiest watched channel sets the deadline, because the window is per channel and it
 * is the first to overflow — a quiet channel losing nothing does not make this safe.
 */
export const BUSIEST_CHANNEL_POSTS_PER_DAY = 64

/** Hours of downtime before the busiest channel's feed window has fully turned over. */
export const HOURS_UNTIL_LOSS = (FEED_DEPTH_POSTS / BUSIEST_CHANNEL_POSTS_PER_DAY) * 24

export type WatchSeverity =
  /** Beating. Nothing to say. */
  | 'ok'
  /** Not beating, but everything missed is still inside the feed window. Recoverable. */
  | 'at-risk'
  /** Not beating for long enough that posts have scrolled out of reach. Unrecoverable. */
  | 'losing-posts'

export interface WatchHealth {
  severity: WatchSeverity
  /** Null when no watch has ever run — a different fact from "it stopped". */
  downMinutes: number | null
  /**
   * Posts we can expect to have missed, from the measured rate. An ESTIMATE, and labelled
   * as one wherever it renders: the honest alternative is silence, and silence is what
   * produced a 20-hour outage nobody noticed.
   */
  estimatedPostsMissed: number
  /**
   * Of those, how many are beyond recovery — they have scrolled out of the feed window.
   * Zero while `at-risk`, which is exactly the distinction that makes acting NOW worth
   * something rather than being equally late either way.
   */
  estimatedPostsLost: number
  /** Whole hours of grace left before loss begins. Null once it already has. */
  hoursUntilLossBegins: number | null
}

export interface WatchInput {
  /** When the scheduler last checked in. Null when none ever has. */
  lastBeatAt: Date | null
  /** Is that beat fresh by the scheduler's own staleness window? */
  fresh: boolean
  now: Date
}

/**
 * `fresh` is passed in rather than re-derived from `lastBeatAt`. The scheduler owns what
 * counts as stale (`HEARTBEAT_STALE_MS`), and a second definition here would be a rule
 * with two implementations — the drift that has already bitten this codebase in `gate.ts`,
 * `readThread.ts` and the two Connect buttons.
 */
export function assessWatch({ lastBeatAt, fresh, now }: WatchInput): WatchHealth {
  if (fresh) {
    return {
      severity: 'ok',
      downMinutes: lastBeatAt ? minutesBetween(lastBeatAt, now) : null,
      estimatedPostsMissed: 0,
      estimatedPostsLost: 0,
      hoursUntilLossBegins: null,
    }
  }

  /**
   * Never run at all. Treated as `losing-posts` with NO estimate, deliberately: we cannot
   * say how much was missed, and inventing a number from an unknown start would be the
   * "absence of data hardens into a claim" bug this project has produced four times.
   * Zero here means "not counted", and the copy must say so rather than print "0 missed",
   * which would read as good news.
   */
  if (!lastBeatAt) {
    return {
      severity: 'losing-posts',
      downMinutes: null,
      estimatedPostsMissed: 0,
      estimatedPostsLost: 0,
      hoursUntilLossBegins: null,
    }
  }

  const downMinutes = minutesBetween(lastBeatAt, now)
  const downHours = downMinutes / 60
  const estimatedPostsMissed = Math.round((downHours / 24) * BUSIEST_CHANNEL_POSTS_PER_DAY)

  /**
   * Loss starts only once the window has turned over. Before that every missed post is
   * still sitting in the feed and one pass recovers all of it — which is precisely what
   * happened on 2026-08-08, when a restart recovered 108 posts including 9 paid ones.
   */
  const lostHours = Math.max(0, downHours - HOURS_UNTIL_LOSS)
  const estimatedPostsLost = Math.round((lostHours / 24) * BUSIEST_CHANNEL_POSTS_PER_DAY)

  return {
    severity: lostHours > 0 ? 'losing-posts' : 'at-risk',
    downMinutes,
    estimatedPostsMissed,
    estimatedPostsLost,
    hoursUntilLossBegins: lostHours > 0 ? null : Math.floor(HOURS_UNTIL_LOSS - downHours),
  }
}

function minutesBetween(from: Date, to: Date): number {
  return Math.max(0, Math.round((to.getTime() - from.getTime()) / 60_000))
}

/**
 * The sentence an operator reads. Built here rather than in the component because the
 * severity and the words must not be able to disagree — a red box saying something mild
 * is how a warning stops being read.
 */
/**
 * THE SAME FACT IN ONE LINE, for the hero card.
 *
 * `watchHealthSentence` is the whole argument — what was missed, how long the feed window
 * is, how many hours remain — and it belongs where a person reads detail: the blocker list,
 * which already carries this alarm with its own verdict and remedy. Set in 22px bold at the
 * top of the page it was sixty words of prose shouting one thing, and the reader met the
 * same thing again forty pixels below. This says WHICH state, in a clause; nothing is lost,
 * because the blocker under it is the fuller copy and the CLI still prints the long form.
 */
export function watchHealthHeadline(health: WatchHealth): string | null {
  switch (health.severity) {
    case 'ok':
      return null
    case 'at-risk':
      return `Detection has stopped — about ${health.estimatedPostsMissed} post${health.estimatedPostsMissed === 1 ? '' : 's'} missed so far, all still recoverable`
    case 'losing-posts':
      return health.downMinutes === null
        ? 'Detection has never run — no channel has ever been read'
        : `Detection has been stopped long enough to lose posts permanently — about ${health.estimatedPostsLost} already gone`
    default: {
      const exhaustive: never = health.severity
      return exhaustive
    }
  }
}

export function watchHealthSentence(health: WatchHealth): string | null {
  switch (health.severity) {
    case 'ok':
      return null

    case 'at-risk': {
      const hours = health.hoursUntilLossBegins
      return (
        `Detection has stopped. Nothing is reading the channels, and this is not about sending — ` +
        `paid posts are being missed right now. About ${health.estimatedPostsMissed} posts so far, ` +
        `all of them still recoverable: the feed holds roughly ${FEED_DEPTH_POSTS} posts and the busiest ` +
        `channel publishes about ${BUSIEST_CHANNEL_POSTS_PER_DAY} a day, so there are about ` +
        `${hours ?? 0} hours left before they start scrolling out of reach for good. Start the watch.`
      )
    }

    case 'losing-posts': {
      if (health.downMinutes === null) {
        return (
          `Detection has never run. No channel has ever been read, so no paid post can have been ` +
          `found. Start the watch.`
        )
      }
      return (
        `Detection has been stopped long enough to lose posts permanently. About ` +
        `${health.estimatedPostsMissed} posts were missed and roughly ${health.estimatedPostsLost} of them ` +
        `have already scrolled out of the feed, which does not go back — they cannot be recovered by ` +
        `restarting. Start the watch now to save the rest.`
      )
    }

    default: {
      /**
       * Exhaustive. A new severity that silently produced `null` here would render an
       * alarm with no sentence in it — the same fall-through-is-a-permission shape that
       * let an incomplete thread read authorise a send.
       */
      const exhaustive: never = health.severity
      return exhaustive
    }
  }
}
