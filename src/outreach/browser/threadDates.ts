/**
 * WHEN WAS THIS MESSAGE WRITTEN? — parsing the dates Instagram actually shows.
 *
 * Two sources, both OBSERVED on live pages (2026-08-21, probe on @bollywoodchronicle's
 * real inbox and the @indiagatefoods thread) rather than assumed:
 *
 *   1. THREAD DATE SEPARATORS — plain `span[dir=auto]` text nodes interleaved between
 *      message bubbles, in DOM order: `"12:39"` preceded our message, `"18:04"` preceded
 *      their reply. Older separators carry the day ("Yesterday 14:21", "Mon 14:21",
 *      "19 August 2026, 14:21" — locale-shaped, so several spellings are accepted).
 *
 *   2. INBOX ROW AGES — every conversation row ends with a relative age ("41m", "1h",
 *      "2d", "3w"). Coarse, but present on EVERY row, which the separators are not.
 *
 * Both parsers are ANCHORED: the whole trimmed text must be a timestamp, nothing else.
 * A reply that merely CONTAINS a time ("call me at 18:00") is a bubble, and bubbles are
 * never handed to these parsers — but anchoring means even a mis-classified node cannot
 * turn prose into a date.
 *
 * A text neither parser recognises yields NULL — "we could not date it" — and per
 * Tabish's rule (2026-08-21) an undatable reply does not hold the seven-day halt. So an
 * unrecognised format fails toward sending, which is the direction he chose; the parser
 * being generous about formats is what keeps that failure rare.
 */

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
}

const WEEKDAYS: Record<string, number> = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
}

/** "18:04" / "6:04 pm" → hours+minutes, or null. */
function parseClock(text: string): { h: number; m: number } | null {
  const m = /^(\d{1,2}):(\d{2})(?:\s*(am|pm))?$/i.exec(text.trim())
  if (!m) return null
  let h = Number(m[1])
  const min = Number(m[2])
  const ap = m[3]?.toLowerCase()
  if (ap === 'pm' && h < 12) h += 12
  if (ap === 'am' && h === 12) h = 0
  if (h > 23 || min > 59) return null
  return { h, m: min }
}

function at(base: Date, h: number, m: number): Date {
  const d = new Date(base)
  d.setHours(h, m, 0, 0)
  return d
}

/**
 * A thread date-separator → the instant it names, or null.
 *
 * Handled, each anchored over the whole text:
 *   "18:04"                       today at 18:04 (yesterday if that is in the future)
 *   "Yesterday 14:21" / "Yesterday, 14:21"
 *   "Mon 14:21" / "Monday, 14:21"   the most recent such weekday strictly before today
 *   "19 August 2026, 14:21" / "19 Aug 2026 14:21" / "August 19, 2026, 2:21 pm"
 *   "19 August, 14:21"              current year; rolled back one if in the future
 * Bare dates without a clock take midnight, which is the conservative (older) reading.
 */
export function parseThreadTimestamp(text: string, now: Date = new Date()): Date | null {
  const t = text.trim().replace(/\s+/g, ' ')
  if (t.length === 0 || t.length > 40) return null

  // bare clock — today, else yesterday
  const clock = parseClock(t)
  if (clock) {
    const today = at(now, clock.h, clock.m)
    if (today.getTime() <= now.getTime()) return today
    const y = new Date(today)
    y.setDate(y.getDate() - 1)
    return y
  }

  // "Yesterday[,] HH:MM"
  {
    const m = /^yesterday,? (.+)$/i.exec(t)
    if (m) {
      const c = parseClock(m[1]!)
      if (!c) return null
      const d = at(now, c.h, c.m)
      d.setDate(d.getDate() - 1)
      return d
    }
  }

  // "Weekday[,] HH:MM" — the most recent such weekday strictly before today
  {
    const m = /^([a-z]+),? (\d{1,2}:\d{2}(?:\s*(?:am|pm))?)$/i.exec(t)
    if (m) {
      const wd = WEEKDAYS[m[1]!.slice(0, 3).toLowerCase()]
      if (wd !== undefined) {
        const c = parseClock(m[2]!)
        if (!c) return null
        const d = at(now, c.h, c.m)
        let back = (d.getDay() - wd + 7) % 7
        if (back === 0) back = 7 // a weekday NAME means not-today; today renders a bare clock
        d.setDate(d.getDate() - back)
        return d
      }
    }
  }

  // "19 August 2026, 14:21" / "19 Aug[,] 14:21" (no year) / bare "19 August 2026"
  {
    const m = /^(\d{1,2}) ([a-z]+)(?: (\d{4}))?(?:,? (\d{1,2}:\d{2}(?:\s*(?:am|pm))?))?$/i.exec(t)
    if (m) {
      const mon = MONTHS[m[2]!.slice(0, 3).toLowerCase()]
      if (mon !== undefined) {
        const day = Number(m[1])
        if (day < 1 || day > 31) return null
        const c = m[4] ? parseClock(m[4]) : { h: 0, m: 0 }
        if (!c) return null
        const year = m[3] ? Number(m[3]) : now.getFullYear()
        const d = new Date(now)
        d.setFullYear(year, mon, day)
        d.setHours(c.h, c.m, 0, 0)
        if (!m[3] && d.getTime() > now.getTime()) d.setFullYear(year - 1)
        return d
      }
    }
  }

  // "August 19, 2026, 2:21 pm" / "Aug 19[,] 14:21" (no year) / bare "August 19, 2026"
  {
    const m = /^([a-z]+) (\d{1,2})(?:, (\d{4}))?(?:,? (\d{1,2}:\d{2}(?:\s*(?:am|pm))?))?$/i.exec(t)
    if (m) {
      const mon = MONTHS[m[1]!.slice(0, 3).toLowerCase()]
      if (mon !== undefined) {
        const day = Number(m[2])
        if (day < 1 || day > 31) return null
        const c = m[4] ? parseClock(m[4]) : { h: 0, m: 0 }
        if (!c) return null
        const year = m[3] ? Number(m[3]) : now.getFullYear()
        const d = new Date(now)
        d.setFullYear(year, mon, day)
        d.setHours(c.h, c.m, 0, 0)
        if (!m[3] && d.getTime() > now.getTime()) d.setFullYear(year - 1)
        return d
      }
    }
  }

  return null
}

/**
 * ── A PARSED DATE MUST BE ONE THAT COULD BE TRUE (2026-08-22) ─────────────
 *
 * MEASURED, and it cost a live lead: @drongofilms wrote *"Hi Kunal this side, saw your
 * poster 'vibe', we can amplify your content"*, the sweep observed it at 11:14 IST, and
 * `parseThreadTimestamp` dated it **19 May** — three months earlier. Because the halt keys
 * on the reply's own date, and an old date does not hold it (Tabish's rule), the fleet sent
 * that recipient another message NINE MINUTES after they replied. Six of 41 stored replies
 * carried a date earlier than the message they answer.
 *
 * The rule that makes any parser mistake harmless: **a reply cannot predate the message it
 * answers, and cannot postdate the moment we saw it.** Both bounds are DB facts, not
 * guesses. Anything outside that window is not a date; the nearest bound is used instead,
 * which is conservative for the halt — a reply to a recent send lands inside the window and
 * HOLDS, while a reply in a thread we last wrote to a month ago clamps to that old send and
 * correctly does NOT hold, which is exactly the "it might be answering an older
 * conversation" case Tabish's rule is about.
 *
 * PURE, so both recorders (the thread read and the inbox scan) share one answer.
 */
export function plausibleReplyDate(args: {
  /** What the thread separator or inbox age parsed to. Null when nothing parsed. */
  parsed: Date | null
  /** Our newest delivered message to this recipient BEFORE we observed the reply. */
  lastSentAt: Date | null
  /** When we saw the reply. The reply cannot be newer than this. */
  observedAt: Date
}): Date | null {
  const { parsed, lastSentAt, observedAt } = args
  /* No send to answer means no lower bound we can defend — leave it to the parser, and to
     NULL if that found nothing. A reply to a message we never sent is not a case this
     system produces, so this branch is a fallback rather than a path. */
  if (!lastSentAt) return parsed && parsed <= observedAt ? parsed : null
  if (parsed && parsed >= lastSentAt && parsed <= observedAt) return parsed
  /* Outside the window (or unparsed): the earliest it could have been written is the
     moment we last wrote to them. Using the LOWER bound rather than the observation keeps
     Tabish's rule intact — an old thread stays old and does not halt. */
  return lastSentAt
}

/**
 * An inbox row's relative age ("41m", "1h", "2d", "3w") → the instant it names, or null.
 *
 * The age dates the row's NEWEST message. Instagram floors these ("2d" covers [2d, 3d)),
 * so subtracting the stated value reads the message as new as it could be — for the
 * seven-day halt that is the CONSERVATIVE direction: a borderline "7w"-old reply can only
 * be read as newer, never as older, so the halt over-holds rather than over-releases.
 */
export function parseInboxAge(text: string, now: Date = new Date()): Date | null {
  const m = /^(\d+)\s*([smhdw])$/i.exec(text.trim())
  if (!m) return null
  const n = Number(m[1])
  const unit = m[2]!.toLowerCase()
  const ms =
    unit === 's' ? n * 1000 :
    unit === 'm' ? n * 60_000 :
    unit === 'h' ? n * 3_600_000 :
    unit === 'd' ? n * 86_400_000 :
    n * 7 * 86_400_000
  return new Date(now.getTime() - ms)
}
