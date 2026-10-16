/**
 * officialReach.ts — HOW FAR BACK THE OFFICIAL READ REACHES, AND WHETHER IT GOT THERE (16 Oct 2026).
 *
 * A leaf: PURE functions and the bounds they use, imported by the detection pass (pipeline.ts) and
 * by `pnpm ig:backfill`'s dry run (backfill.ts). The dry run must not import the pass — the pass
 * holds every writer (persist, frames, the classifier, the Setting stamps) — so the rule the two
 * share lives here, where neither has to reach into the other for it.
 *
 * ── THE GAP, MEASURED ON THE BOX 16 OCT 2026 ─────────────────────────────────────────────────
 *
 * The anonymous feed was walled for a day and more with NEITHER door serving (the official
 * fallback was not deployed yet). The first official pass then stored 234 new posts, 39 of them
 * paid — and read only the last 6 hours, because the routine pass reads back to
 * `max(now - DETECT_LOOKBACK_HOURS, newestStored - 60)`, and every later pass stops at the newest
 * post stored. So every post published during the blind stretch more than 6 hours before that
 * first official pass was never read, and the 11:00 IST slot's 36-hour catch-up stops at the newest
 * stored post too. The anonymous feed could never have recovered them (a 48-post window — a post
 * that scrolls out is gone for good). Business Discovery pages back through a channel's WHOLE
 * history, so these posts are recoverable — and the 7-day material allowance means a paid post
 * missed is a message a recipient is owed and never gets.
 *
 * Two answers, both on the OFFICIAL door only:
 *
 *   1. THE GAP RULE, automatic. A channel whose newest stored post (any row) is older than the
 *      pass's own floor has a real gap — nothing stored inside the lookback. Its official read
 *      reaches back to `max(newestStored - 60, now - DETECT_CATCHUP_LOOKBACK_HOURS)` with a larger
 *      page bound, so the post that ends the gap is read on the first pass the door serves it.
 *      A channel with something stored inside the lookback, or nothing stored at all, is not
 *      touched: a brand-new channel must not cost 36 hours of reading on every pass.
 *   2. `pnpm ig:backfill --hours N`, by hand. Once the gap has been read past, it is in the
 *      MIDDLE — the newest stored post is fresh, so rule 1 can no longer see it. The command reads
 *      every channel back N hours through the official read, ignoring the newest stored post.
 *
 * ── WHY THE ANONYMOUS DOOR IS NEVER DEEPENED ─────────────────────────────────────────────────
 *
 * Its throttle is what volume earned (anonGate.ts, 7 Sept 2026: one page per channel roughly
 * halved the load). Its window is 48 posts deep whatever is asked, so asking for 36 hours there
 * buys at most a few more pages against an endpoint that refuses on volume. Every field this
 * module produces is OFFICIAL-ONLY (feedSource.ts `officialSinceUnix`, `officialMaxPosts`,
 * `officialMaxPages`); the anonymous door keeps `sinceUnix` / `completeSinceUnix` exactly as before.
 */
import { GRAPH_PAGE_LIMIT } from './graphFeed'
import { DETECT_CATCHUP_LOOKBACK_HOURS, DETECT_LOOKBACK_HOURS } from './cadence'

/**
 * The channels a detection pass reads — ONE definition, so `runDetection` and the backfill's dry
 * run cannot disagree about which channels "every channel" is. Kept here (a leaf) because the dry
 * run may not import the pass.
 */
export const WATCHED_CHANNEL_WHERE = { kind: 'CHANNEL', watchEnabled: true } as const

/**
 * THE GAP RULE'S PAGE BOUND: 6 pages of 25 = 150 posts, against the routine 48.
 *
 * The routine official read is bounded by `maxPosts: 48` — two pages — which cannot hold 36 hours
 * of the busiest channel: @viralbhayani posts 49–75 a day (measured, CLAUDE.md), so up to ~113 in
 * 36 hours. 150 covers that with room, and costs at most 6 calls for that one channel (12 if every
 * page needs its one transport retry, graphFeed.ts `GRAPH_TRANSPORT_RETRIES`). The pass's
 * call cap (`GRAPH_MAX_CALLS_PER_PASS`, 60) still bounds the PASS: a channel it costs is counted
 * and logged as before, and a channel it cuts short mid-read is logged by name with the command
 * that finishes the job (`officialShortfall` below), never dropped in silence.
 */
export const GRAPH_GAP_MAX_PAGES = 6
export const GRAPH_GAP_MAX_POSTS = GRAPH_GAP_MAX_PAGES * GRAPH_PAGE_LIMIT

/**
 * THE BACKFILL'S CALL CAP, PER RUN: 200 calls.
 *
 * Meta documents roughly 200 calls an hour per user for this API, and the backfill spends from the
 * SAME budget as the worker's passes — which is why `--run` refuses while the worker runs on the
 * box, and why one run is capped at that hour's worth.
 *
 * WHAT A RUN COSTS, FROM THE BOX'S OWN NUMBERS (review, 16 Oct 2026 — the first estimate here was
 * ~2.5x low). The first official pass stored ~234 posts from a ~6-hour read (≈39 posts an hour
 * across the watched channels); CLAUDE.md measured 877 posts stored in 24 hours on 26 Aug (≈37 an
 * hour). At 25 posts a page that is ≈1.5 calls an hour of history, plus at most one boundary page
 * per channel: **48 hours ≈ 85–90 calls; a full week ≈ 260–280 — MORE THAN ONE RUN'S CAP.** So a
 * week is read in more than one run, and a bare re-run does not make progress: a fresh process
 * always reads in handle order and the backfill floor ignores what is stored (the gap is in the
 * middle, and Business Discovery cannot start a read part-way down a feed), so it would spend the
 * same calls on the same head and cut the same tail. A channel the cap cuts short is NAMED in the
 * report, which prints the exact `--channel` line that reads just those (backfill.ts).
 *
 * THE PAUSE IS PER PROCESS. A rate-limit answer pauses the official read for 30 minutes
 * (graphFeed.ts) — in the process that got it. The worker started again after a run begins
 * unpaused and re-learns a still-active limit by spending ONE call, then pauses itself; nothing is
 * lost, because Business Discovery pages back and the posts are read on a later pass. That one
 * call, and the hour a large dry run shares with the worker, is the honest cost; the cap is a
 * bound on the run, not on the hour.
 */
export const GRAPH_BACKFILL_CALL_CAP = 200

/**
 * THE BACKFILL'S PAGE BOUND PER CHANNEL: 24 pages of 25 = 600 posts — a week of the busiest
 * channel (75 a day × 7 = 525) with room. A quieter channel stops long before it, at the first
 * page older than the floor. A channel that reaches it is named in the report as cut short.
 */
export const GRAPH_BACKFILL_MAX_PAGES = 24
export const GRAPH_BACKFILL_MAX_POSTS = GRAPH_BACKFILL_MAX_PAGES * GRAPH_PAGE_LIMIT

/** The longest backfill: the 7-day material window. A paid post older than that funds no message. */
export const BACKFILL_MAX_HOURS = 168

/**
 * Roughly how long `--run` takes per post it stores, for the dry run's estimate: MEASURED 8 Sept 2026,
 * a 307-post backlog judged in 36 minutes (≈7 s a post — RapidOCR on the cover frame plus the
 * classifier's caption and footage calls, on a 1-vCPU box). The worker is stopped for that long, so
 * detection, drafting and the four slots pause with it — a person must know before choosing N.
 */
export const BACKFILL_SECONDS_PER_POST = 7

/** Is this a backfill length the command and the pass accept: a whole number of hours, 1..168. */
export function isValidBackfillHours(hours: unknown): hours is number {
  return typeof hours === 'number' && Number.isInteger(hours) && hours >= 1 && hours <= BACKFILL_MAX_HOURS
}

/** The official-only fields feedSource.ts reads in place of `sinceUnix` / `maxPosts` / `maxPages`. */
export interface OfficialReach {
  officialSinceUnix: number
  officialMaxPosts: number
  officialMaxPages: number
}

/**
 * PURE. How far back THIS channel's official read reaches, or null for today's read (the routine
 * `sinceUnix`, `maxPosts: 48`, the official default of 6 pages).
 *
 * `sinceUnix` is the routine floor the pass already computed for both doors —
 * `max(floorUnix, newestStored - 60)` — and the answer is never SHALLOWER than it: both rules only
 * ever deepen the official read. That matters for a pass with a long lookback (`ig:detect
 * --lookback 48`, where the 36-hour catch-up floor would otherwise be shallower than the pass's own)
 * and for a backfill shorter than the lookback.
 */
export function officialReachFor(input: {
  sinceUnix: number
  floorUnix: number
  /** The channel's newest stored `postedAt`, any row; undefined when nothing is stored. */
  newestStoredUnix: number | undefined
  nowUnix: number
  /** Set only by `pnpm ig:backfill --run`. */
  backfillHours?: number
}): OfficialReach | null {
  const { sinceUnix, floorUnix, newestStoredUnix, nowUnix, backfillHours } = input
  let reach: OfficialReach | null = null
  const gapStart = gapStartUnix(newestStoredUnix, floorUnix)
  if (gapStart !== null) {
    const catchUpFloor = nowUnix - DETECT_CATCHUP_LOOKBACK_HOURS * 3600
    reach = {
      // Clamped at the catch-up: a gap older than that is not read back to its start here — the
      // pass NAMES what is left (`unreadStretch` below), because once this read stores the newest
      // posts the gap is in the middle and this rule can never see it again.
      officialSinceUnix: Math.min(sinceUnix, Math.max(gapStart, catchUpFloor)),
      officialMaxPosts: GRAPH_GAP_MAX_POSTS,
      officialMaxPages: GRAPH_GAP_MAX_PAGES,
    }
  }
  if (backfillHours !== undefined) {
    reach = {
      // Ignores the newest stored post: the gap a backfill exists for is in the MIDDLE.
      officialSinceUnix: Math.min(nowUnix - backfillHours * 3600, reach?.officialSinceUnix ?? sinceUnix),
      officialMaxPosts: GRAPH_BACKFILL_MAX_POSTS,
      officialMaxPages: GRAPH_BACKFILL_MAX_PAGES,
    }
  }
  return reach
}

/**
 * PURE. Where a REAL gap starts — the newest stored post, less the minute of overlap every floor
 * here carries — or null when there is none: something IS stored and none of it is inside the
 * lookback. Nothing stored at all is a new channel, not a gap, and keeps the routine floor. ONE
 * definition, shared by the gap rule above and by the check that names a gap a read left unread.
 */
export function gapStartUnix(newestStoredUnix: number | undefined, floorUnix: number): number | null {
  return newestStoredUnix !== undefined && newestStoredUnix < floorUnix ? newestStoredUnix - 60 : null
}

/** The oldest `postedAt` in a read, in unix seconds, or null when it read nothing. By value, not position. */
function oldestPostUnix(posts: ReadonlyArray<{ postedAt: Date }>): number | null {
  return posts.reduce<number | null>((min, p) => {
    const s = Math.floor(p.postedAt.getTime() / 1000)
    return min === null || s < min ? s : min
  }, null)
}

/**
 * PURE. Did a read leave part of what this channel is missing unread? Non-null when the channel
 * has MORE posts (`moreAvailable`) and the read stopped before `wantedSinceUnix` — the oldest post
 * it reached is still newer than it (or it reached none). A read that got past `wantedSinceUnix`,
 * or read the channel's whole history, left nothing.
 *
 * This is the question the gap rule's 36-hour clamp and the anonymous door's 48-post window both
 * raise, and `officialShortfall` cannot answer it: that one asks whether a read reached the floor it
 * was GIVEN, and a clamped floor is reached by construction while the start of the gap is not. The
 * read goes newest first, so what is left is always the OLDEST part — and the posts just stored make
 * the channel's newest post fresh, so no later pass's gap rule can see it. Hence the pass names it,
 * with the command that reads it (pipeline.ts). Precise on purpose: a dormant channel's first page
 * is all older than its newest stored post, so it reaches past the gap's start and is not named every
 * fifteen minutes.
 */
export function unreadStretch(
  read: { posts: ReadonlyArray<{ postedAt: Date }>; moreAvailable: boolean },
  wantedSinceUnix: number,
): { oldestUnix: number | null } | null {
  if (!read.moreAvailable) return null
  const oldestUnix = oldestPostUnix(read.posts)
  if (oldestUnix !== null && oldestUnix <= wantedSinceUnix) return null
  return { oldestUnix }
}

/** Whether a deepened official read got as far back as it was asked, and if not, what stopped it. */
export type OfficialShortfall =
  | { reached: true }
  | {
      reached: false
      /** `call-cap`: the pass's (or run's) call budget ran out mid-read. `channel-bound`: this channel's page/post bound. */
      short: 'call-cap' | 'channel-bound'
      /** The oldest post the read did reach, or null when it read none. */
      oldestUnix: number | null
    }

/**
 * PURE. Did a deepened official read reach `reach.officialSinceUnix`?
 *
 * Reached when the oldest post read is at or before the floor (Business Discovery reads newest
 * first, so everything between the floor and now was read), or when nothing more exists (the
 * channel's whole history is shorter than the window). Otherwise it was cut short — and since the
 * read goes newest first, it is the OLDEST part of the stretch that stays unread, which the next
 * pass cannot see: the posts just stored make the channel's newest post fresh. That is why the
 * shortfall is reported by name rather than left for the gap rule to pick up.
 */
export function officialShortfall(
  read: { posts: ReadonlyArray<{ postedAt: Date }>; pagesFetched: number; moreAvailable: boolean },
  reach: OfficialReach,
  budgetRemaining: number | null,
): OfficialShortfall {
  const oldestUnix = oldestPostUnix(read.posts)
  if (!read.moreAvailable) return { reached: true }
  if (oldestUnix !== null && oldestUnix <= reach.officialSinceUnix) return { reached: true }
  const atBound = read.posts.length >= reach.officialMaxPosts || read.pagesFetched >= reach.officialMaxPages
  const short: 'call-cap' | 'channel-bound' = !atBound && budgetRemaining !== null && budgetRemaining <= 0 ? 'call-cap' : 'channel-bound'
  return { reached: false, short, oldestUnix }
}

/** Whole hours from `sinceUnix` to now, capped at the backfill's maximum — the `--hours` a remedy names. */
export function hoursBackTo(sinceUnix: number, nowUnix: number): number {
  return Math.min(BACKFILL_MAX_HOURS, Math.max(1, Math.ceil((nowUnix - sinceUnix) / 3600)))
}

/**
 * PURE. The OFFICIAL floor a `pnpm ig:backfill --run` pass gives a channel — the floor the pass
 * computes (pipeline.ts: the routine `max(now - 6h, newest - 60)`, then `officialReachFor` with the
 * backfill) — so the DRY RUN counts exactly the window the run stores (review, 16 Oct 2026). Usually
 * `now - N h`; deeper when the routine read or a real gap already reaches further.
 * `tests/official-reach.test.ts` pins it against the pass's own answer, channel by channel.
 */
export function backfillFloorFor(input: { newestStoredUnix: number | undefined; nowUnix: number; hours: number }): number {
  const floorUnix = input.nowUnix - DETECT_LOOKBACK_HOURS * 3600
  const sinceUnix = Math.max(floorUnix, (input.newestStoredUnix ?? 0) - 60)
  const reach = officialReachFor({ sinceUnix, floorUnix, newestStoredUnix: input.newestStoredUnix, nowUnix: input.nowUnix, backfillHours: input.hours })
  // Never null with `backfillHours` set; the fallback is only for the type.
  return reach?.officialSinceUnix ?? input.nowUnix - input.hours * 3600
}
