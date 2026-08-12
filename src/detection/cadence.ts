/**
 * How often detection runs — and why it is NOT the sending schedule.
 *
 * ── THE DECOUPLING, AND WHOSE DECISION IT IS ───────────────────────────────
 *
 * Tabish, 2026-08-07: *"the schedule is for sending messages, not for detecting paid
 * posts, paid posts must be detected as fast as possible for the channels as target."*
 *
 * Detection used to be stage 1 of `runSlot`, so it inherited the send cadence —
 * 11:00 / 15:00 / 17:00 / 20:00 IST. Those four times are a decision about DM volume and
 * recipient experience, and detection has nothing to do with either: it is an anonymous
 * HTTP read of a public feed with no session attached (decision 4), so the only cost is
 * IP rate limiting. Reading a feed cannot spam anybody.
 *
 * Inheriting that cadence had a measurable cost. MEASURED on the live corpus (404 posts
 * over 7 days from @viralbhayani, 57.7/day):
 *
 *   11:00 -> 15:00    4h gap
 *   15:00 -> 17:00    2h gap
 *   17:00 -> 20:00    3h gap
 *   20:00 -> 11:00   15h gap   <-- posts sat undetected all night, ~20 of them
 *
 * A paid post spotted 15 hours late is 15 hours of a competitor's head start on the same
 * prospect, and the hook line it feeds is age-bounded (`HOOK_MAX_AGE_HOURS`), so a slow
 * read can retire material before anything is written about it.
 *
 * ── WHY 15 MINUTES, AND WHY NOT FASTER ─────────────────────────────────────
 *
 * The cost is requests to an anonymous, undocumented endpoint. MEASURED: 5 watched
 * channels x ~4 pages = ~18-20 requests per pass, with a 700ms delay between pages and
 * three consecutive full runs recorded at 48/48 HTTP 200 (median 1090ms).
 *
 *   every 15 min, 96 passes/day  ~1,900 requests/day
 *   every  5 min, 288 passes/day ~5,700 requests/day
 *
 * 15 minutes cuts worst-case detection latency from 15 hours to 15 minutes — a 60x
 * improvement — for ~1,900 requests a day against an endpoint whose only failure mode is
 * a 429 we already detect and back off from. Going to 5 minutes would triple the request
 * rate to shave 10 further minutes off an already-solved problem, against an endpoint
 * nobody has permission to hammer. That is the wrong side of the trade: the risk here is
 * an IP block that blinds detection completely, and the whole point of this change is to
 * see MORE, not to gamble the ability to see anything.
 *
 * If a 429 ever appears in the logs, this number is the first thing to raise.
 *
 * ── WHAT DID NOT CHANGE ────────────────────────────────────────────────────
 *
 * Sending. The four slots still run, still plan drafts, still check replies at 11:00 and
 * 20:00, and the paced dispatcher still sends at most one message every 15 minutes inside
 * 10:00-21:00 IST. Detection running more often cannot make a message go out sooner or
 * more often — every send gate is untouched. And `runSlot` still calls `runDetection`
 * first, because a slot must never plan against a stale corpus.
 */

/** Minutes between detection passes. See the docblock for why this number. */
export const DETECT_INTERVAL_MINUTES = 15

/**
 * How far back each pass looks.
 *
 * Was 36 hours, sized to survive a missed slot when a slot was 15 hours away. At a
 * 15-minute cadence that is enormous over-reach: every pass would page back through a day
 * and a half of posts it already has, on every channel, forever.
 *
 * 6 hours keeps a generous margin — it survives 24 consecutive missed passes, or the
 * machine being asleep for a quarter of a day — while letting `fetchFeed` stop paging as
 * soon as it reaches posts older than the window. Storage is idempotent on `shortcode`, so
 * overlap is free correctness rather than duplication.
 *
 * A LONGER window is the safe direction (it re-reads posts we already have); a shorter one
 * risks missing a burst. Do not reduce this below the interval times a comfortable margin.
 */
export const DETECT_LOOKBACK_HOURS = 6

/**
 * The lookback for a CATCH-UP pass — after a restart, or a slot that was slept through.
 *
 * Keeps the old 36-hour reach for exactly the case it was chosen for: the process was off
 * or suspended and nobody knows for how long. Used by `catchUpIfMissed` and the slots,
 * never by the fast cadence.
 */
export const DETECT_CATCHUP_LOOKBACK_HOURS = 36
