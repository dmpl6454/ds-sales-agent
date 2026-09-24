import { ACTIVE_FROM_HOUR, ACTIVE_TO_HOUR } from '@/outreach/pacing'

/**
 * How many pips are worth drawing. Beyond this the row stops being readable at a glance,
 * which is the only reason pips exist, so it falls back to the figure.
 */
const MAX_PIPS = 12

/**
 * THE PACE — drawn, because the numbers alone do not answer the question people ask.
 *
 * "Autopilot is on and nothing has gone out" is the ORDINARY state for most of an hour,
 * and the reason is a conjunction of four rules that are individually boring: active
 * hours, the minimum gap, the fleet allowance, and one send per tick. Listed as figures
 * they read as trivia. Drawn as a band with `now` on it, the answer is immediate — you
 * are outside the window, or you are inside it and the allowance is spent.
 *
 * ── THE LIMITS COME FROM THE DISPATCHER, NOT FROM THE CONSTANTS ─────────────
 *
 * `perHour` and `minGapMinutes` are passed in from `dispatchStatus().limits` — the values
 * the dispatcher ACTUALLY enforces, which are the `Setting` rows when they exist and the
 * constants otherwise. This file used to import `FLEET_MAX_PER_HOUR` directly, on the
 * reasoning that importing beats retyping. True, and still one source short: a Setting row
 * overriding the constant would have made the page state a limit nobody was enforcing —
 * the `MAX_TOTAL_SENDS` failure (planner saw 6/6 and drafted nothing for two days while
 * the page showed 3/6) with the roles reversed.
 *
 * FOUND THE HARD WAY 2026-08-18: when the hourly allowance became `Infinity`, the pips
 * below were `Array.from({ length: Infinity })` — a `RangeError` that took `/` to HTTP 500
 * on every request. A drawing keyed on a limit must handle the limit not existing.
 *
 * The active-hours span is still imported: it is a schedule, not an allowance, and there
 * is no Setting row for it.
 *
 * The active-hours guard in particular used to exist BY ACCIDENT — delivery only ran at
 * four daytime slots, so "we never DM at 4 a.m." was a property of the slot list rather
 * than a rule. Drawing it is part of how it stays written down.
 */
export function PaceBand({
  istHour,
  istMinute,
  sentThisHour,
  sentToday,
  perHour,
  minGapMinutes,
  lastTick,
}: {
  istHour: number
  istMinute: number
  /** Fleet sends already delivered this IST hour, counted the way the guard counts. */
  sentThisHour: number
  /**
   * Fleet sends delivered since IST midnight — the SAME `fleetUsage()` count, uncapped.
   *
   * On screen since 2026-08-20, because it was the one figure an operator asks for and no
   * page carried it. `usage.today` had been computed on every tick and thrown away: the
   * hourly half was drawn here, the daily half reached no screen at all, and `/analytics`
   * answered a different question (a rolling 7 days) under a heading that reads like an
   * answer to this one. Tabish counted 59 sends by hand and could not find them anywhere.
   */
  sentToday: number
  /** The hourly allowance the dispatcher enforces. `Infinity` when there is none. */
  perHour: number
  /** Minutes the dispatcher insists on between two fleet sends. */
  minGapMinutes: number
  /** What the dispatcher did last, in its own words. Null when it has never run. */
  lastTick: string | null
}) {
  /**
   * NO TIME WINDOW SINCE 2026-08-19 (Tabish). `ACTIVE_FROM_HOUR === ACTIVE_TO_HOUR` is a
   * zero-width window, which `withinActiveHours` reads as "always on". So the band spans a
   * full 24 hours, `now` always sits inside it, and a span of 0 never reaches the division
   * below — which would otherwise be NaN and draw nothing.
   */
  const allDay = ACTIVE_FROM_HOUR === ACTIVE_TO_HOUR
  const fromHour = allDay ? 0 : ACTIVE_FROM_HOUR
  const toHour = allDay ? 24 : ACTIVE_TO_HOUR
  const span = toHour - fromHour
  const nowHours = istHour + istMinute / 60
  const inside = allDay || (nowHours >= fromHour && nowHours < toHour)
  const capped = Number.isFinite(perHour)
  /* Pips only while they are both meaningful and readable — see MAX_PIPS. */
  const pips = capped && perHour <= MAX_PIPS ? perHour : 0

  /* Clamped so a 03:40 "now" does not draw the marker off the left edge. */
  const pos = Math.min(100, Math.max(0, ((nowHours - fromHour) / span) * 100))
  const clock = `${String(istHour).padStart(2, '0')}:${String(istMinute).padStart(2, '0')}`

  /**
   * What paces the fleet when there is no hourly allowance: the minimum gap. Stated
   * honestly rather than as a theoretical maximum — a send itself takes ~1 minute and the
   * reply sweep pauses sending while it reads, so the real rate is well under one a minute.
   */
  const usedPhrase = capped
    ? `${sentThisHour} of ${perHour} fleet sends used this hour`
    : `${sentThisHour} sent this hour — no hourly limit; one message every ${minGapMinutes} minute${minGapMinutes === 1 ? '' : 's'} at most`

  /**
   * "Since midnight IST" is stated rather than implied. The boundary is the only thing that
   * makes the number checkable against Instagram by hand, and this codebase has already
   * shipped a day boundary on the host's clock once — the Linode is not on IST, so a
   * machine-local midnight is 5.5 hours out and would make the figure quietly wrong on the
   * one host that runs the schedule.
   *
   * "sent since midnight IST" rather than "sent today, since midnight IST": the eyebrow
   * beside it already reads "Today", and rendering the component and READING it is what
   * caught the word appearing twice in one nine-word line — no test could, because both
   * readings pass every assertion. It still stands alone in the band's aria-label, where
   * the boundary carries the meaning by itself.
   */
  const todayPhrase = `${sentToday} ${sentToday === 1 ? 'message' : 'messages'} sent since midnight IST`

  const label = allDay
    ? `Sends any time of day — no window. It is ${clock} IST. ${usedPhrase}. ${todayPhrase}.`
    : inside
      ? `Inside sending hours. It is ${clock} IST; the window runs ${fromHour}:00 to ${toHour}:00 IST. ${usedPhrase}. ${todayPhrase}.`
      : `Outside sending hours. It is ${clock} IST; the window runs ${fromHour}:00 to ${toHour}:00 IST, so nothing will go out until it opens. ${todayPhrase}.`

  return (
    <figure className="chartbox pacebox">
      <figcaption className="row-between">
        <h3>The pace</h3>
        {/*
          THE HOUR AS ONE FIGURE, on the caption's own line — the design's shape.

          It replaced a row of pips. Pips are the better drawing of a small allowance and they
          need one: with `fleetMaxPerHour` unset (Tabish, 2026-08-18) there is nothing to fill,
          so the row rendered a label and a sentence and no picture at all. A bare count is
          honest at any setting, and the denominator appears only when a real one exists —
          drawing "/∞" or a bounded row for an unbounded rule is the `Infinity` mistake that
          took this page to HTTP 500.
        */}
        <span className="pace-figure">
          {sentThisHour}
          {pips > 0 ? <span className="pace-figure-of">/{pips}</span> : null}
        </span>
      </figcaption>

      <div className="paceband" role="img" aria-label={label}>
        <span className="pace-track" />
        {inside && <span className="pace-elapsed" style={{ width: `${pos}%` }} />}
        {inside && <span className="pace-now" style={{ left: `${pos}%` }} />}
      </div>
      <div className="pace-scale" aria-hidden="true">
        <span>{String(fromHour).padStart(2, '0')}:00</span>
        <span className={inside ? 'note-good' : 'note-warn'}>
          now {clock}
        </span>
        <span>{allDay ? '24:00' : `${String(toHour).padStart(2, '0')}:00`}</span>
      </div>

      {/*
        ── ONE LINE UNDER THE BAR, AND IT IS THE TWO FACTS THAT MOVE ──────────

        The day's total and what the last tick did, in the design's single row. What was here
        before: a "This hour" row, a "Today" row, a paragraph deriving the hourly rate from the
        gap, and a sentence about the last tick — four blocks for two numbers, on the card whose
        whole job is answering "so why has nothing gone out in the last minute?".

        The arithmetic paragraph went to /rules, which already states the gap and the interval
        from the modules that enforce them. The last tick STAYS: "nothing happened" with no
        explanation is the failure this panel exists to prevent, and a dispatcher that holds
        silently would reintroduce it four times an hour.
      */}
      <p className="blurb">
        {todayPhrase}
        {' · '}
        {lastTick === null ? 'the dispatcher has not run yet on this machine' : `last tick: ${lastTick}`}
      </p>
    </figure>
  )
}
