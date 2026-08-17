import { env } from './env'

/**
 * All scheduling and all "did this already happen today?" logic is in IST,
 * because the slots (11:00 / 15:00 / 17:00 / 20:00) are Mumbai business hours
 * and the guard "max 1 DM per target per day" must mean an Indian calendar day.
 *
 * Deliberately no date library: Intl handles the timezone arithmetic correctly
 * and adding a dependency for six functions is not worth it.
 */

export const TIMEZONE = env.TZ

/** "YYYY-MM-DD" for the given instant in IST. The day key the governor uses. */
export function istDateKey(at: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at)
  return parts // en-CA already yields YYYY-MM-DD
}

/** "HH:MM" in IST, 24-hour. */
export function istTimeKey(at: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: TIMEZONE,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(at)
}

/**
 * Hour of the day in IST, 0-23.
 *
 * The dispatcher's active-hours window and its per-hour fleet allowance both need this,
 * and both are safety-relevant: getting it from `new Date().getHours()` would read the
 * machine's local zone, so a laptop that travelled would silently shift when the fleet
 * is allowed to send. Every other date boundary here is IST; this is no different.
 */
export function istHourOfDay(at: Date = new Date()): number {
  return Number(istTimeKey(at).slice(0, 2))
}

/**
 * When a post went up — "12 Aug (16:42)", the date then the IST hour in brackets.
 *
 * ── WHY THE HOUR IS WORTH A COLUMN ──────────────────────────────────────────
 *
 * `/paid-posts` showed a bare date, so a post published in the commercial window looked
 * exactly like one at 3am. That distinction is real and MEASURED: over 14 days
 * @viralbhayani published 84 posts before 09:00 IST and not one of them was paid.
 * Commercial posting starts around 09:00 and peaks 16:00-20:00, so the hour is a large
 * part of judging whether a verdict is plausible — which is the whole job of the person
 * reading the review queue.
 *
 * IST, like every other date boundary in this system. A UTC hour here would put an
 * evening post on the previous day for the person reading it, which is worse than showing
 * no hour at all.
 *
 * Deliberately NOT "Today"/"Yesterday": that vocabulary already exists for the activity
 * feed, and a second implementation of it is how "yesterday" in one place becomes
 * "1 day ago" in another. A table spanning several days wants the date stated plainly.
 */
export function istPostedLabel(at: Date): string {
  const date = new Intl.DateTimeFormat('en-GB', {
    timeZone: TIMEZONE,
    day: 'numeric',
    month: 'short',
  }).format(at)
  return `${date} (${istTimeKey(at)})`
}

/**
 * How long after publication we FOUND a post, in minutes — or null when that cannot be
 * stated honestly.
 *
 * Detection runs every 15 minutes, and the measured reality on the posts this dashboard
 * shows is p50 8.2 min / p90 16.8 min. The outliers are not near the median: every post
 * over an hour late was over TWELVE hours late, because lateness here does not come from a
 * slow pass, it comes from the watch having a GAP — the 20-hour outage on 8 August is the
 * documented case, and a post that scrolls out of the 48-post feed window during one can
 * never be re-scraped. So this is a witness to downtime, not a performance metric.
 *
 * NULL FOR A NEGATIVE AGE, and that is not defensive padding. MEASURED on the live
 * database 2026-08-13: **14 rows have `detectedAt` BEFORE `postedAt`**, which is
 * physically impossible and is the residue of the timezone bug that stored 6,291
 * timestamps 5.5 hours ahead. For those rows the two timestamps cannot both be trusted,
 * so the honest answer is "we cannot say" — rendering a confident number computed from a
 * value we know is wrong is how a bad measurement outlives the bug that caused it.
 */
export function detectionLatenessMinutes(postedAt: Date, detectedAt: Date): number | null {
  const mins = Math.round((detectedAt.getTime() - postedAt.getTime()) / 60_000)
  return mins < 0 ? null : mins
}

/**
 * Four detect intervals. Anything later than this was NOT found by the routine cadence,
 * which is the only thing the number is meant to say.
 *
 * The bound is insensitive by construction rather than by tuning: on the rows this page
 * renders, the same eight posts are flagged at any threshold between one hour and twelve.
 */
export const LATE_DETECTION_MINUTES = 60

/**
 * "found 15h later" — rendered ONLY past the bound, so the common case stays silent.
 *
 * A number that appears on every row is furniture and stops being read; a number that
 * appears on eight rows out of a hundred is a finding.
 */
export function latenessLabel(postedAt: Date, detectedAt: Date): string | null {
  const mins = detectionLatenessMinutes(postedAt, detectedAt)
  if (mins === null || mins <= LATE_DETECTION_MINUTES) return null
  if (mins < 1440) return `found ${Math.round(mins / 60)}h later`
  const days = Math.floor(mins / 1440)
  return days === 1 ? 'found a day later' : `found ${days} days later`
}

/** Human-readable IST stamp for logs and the dashboard. */
export function istStamp(at: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: TIMEZONE,
    dateStyle: 'medium',
    timeStyle: 'short',
    hour12: false,
  }).format(at)
}

/**
 * Start of the current IST day, as a UTC Date suitable for a Prisma `gte` filter.
 *
 * Built by measuring the zone's actual offset at that instant rather than
 * hardcoding +05:30, so it stays correct if this is ever pointed at a zone
 * that observes DST.
 */
export function istDayStart(at: Date = new Date()): Date {
  const key = istDateKey(at)
  const [y, m, d] = key.split('-').map(Number)
  // Provisional guess at midnight IST expressed in UTC, then corrected by the
  // real offset the zone reports for that moment.
  const guess = Date.UTC(y!, m! - 1, d!, 0, 0, 0)
  const offsetMs = tzOffsetMs(new Date(guess))
  return new Date(guess - offsetMs)
}

/** Offset of TIMEZONE from UTC at a given instant, in ms (IST = +19_800_000). */
function tzOffsetMs(at: Date): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: TIMEZONE,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
  const parts = Object.fromEntries(dtf.formatToParts(at).map((p) => [p.type, p.value]))
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour) === 24 ? 0 : Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  )
  return asUtc - at.getTime()
}

/**
 * "5 days ago" — how long ago something happened, for a person.
 *
 * Lives here, and there is exactly one of it. Step D of the dashboard redesign started by
 * copying this into a second view model, which is how "yesterday" in one place becomes
 * "1 day ago" in another and an operator concludes they are looking at two different events.
 * The same reason `distinctiveSlice`, `checkPersonaDistinct` and `readThread` are each single
 * implementations with several callers.
 *
 * `null` is "never", not "just now": absence of a timestamp must never render as a recent one.
 */
export function relativeLabel(at: Date | null, now: Date = new Date()): string {
  if (!at) return 'never'
  const mins = Math.floor((now.getTime() - at.getTime()) / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} min ago`
  if (mins < 1440) return `${Math.floor(mins / 60)}h ago`
  const days = Math.floor(mins / 1440)
  return days === 1 ? 'yesterday' : `${days} days ago`
}

export function hoursAgo(hours: number, from: Date = new Date()): Date {
  return new Date(from.getTime() - hours * 3_600_000)
}

export function daysAgo(days: number, from: Date = new Date()): Date {
  return new Date(from.getTime() - days * 86_400_000)
}

/** Whole days between two instants, floored. Used for cooldown comparisons. */
export function daysBetween(earlier: Date, later: Date = new Date()): number {
  return Math.floor((later.getTime() - earlier.getTime()) / 86_400_000)
}

/** Convert "11:00" into the cron expression for that IST time, daily. */
export function slotToCron(slot: string): string {
  const [hh, mm] = slot.split(':')
  return `${Number(mm)} ${Number(hh)} * * *`
}

/** Random integer in [min, max] — used for human-like send jitter. */
export function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
