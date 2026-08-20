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
      <figcaption>
        <h3>The pace</h3>
        <p className="page-sub">
          Why &ldquo;on&rdquo; does not mean &ldquo;now&rdquo;. <a href="/rules">The rules behind it</a>.
        </p>
      </figcaption>

      <div className="paceband" role="img" aria-label={label}>
        <span className="pace-track" />
        {inside && <span className="pace-elapsed" style={{ width: `${pos}%` }} />}
        {inside && <span className="pace-now" style={{ left: `${pos}%` }} />}
      </div>
      <div className="pace-scale" aria-hidden="true">
        <span>{fromHour}:00</span>
        <span className={inside ? 'note-good' : 'note-warn'}>
          {inside ? `now ${clock}` : `${clock} — outside`}
        </span>
        <span>{allDay ? '24:00' : `${toHour}:00`}</span>
      </div>

      {/*
        The allowance drawn as pips rather than "2/3", WHEN THERE IS ONE. A fraction has to
        be read; three boxes with two filled is understood without reading.

        With no hourly allowance (2026-08-18) there is nothing to fill, so the row states
        what actually paces instead — the minimum gap and the ceiling it implies. Drawing
        an empty or unbounded row would be a picture of a rule that is not in force.
      */}
      <div className="pace-allowance">
        <span className="eyebrow">This hour</span>
        {pips > 0 && (
          <span className="pips" aria-hidden="true">
            {Array.from({ length: pips }, (_, i) => (
              <span key={i} className={i < sentThisHour ? 'pip pip-on' : 'pip'} />
            ))}
          </span>
        )}
        <span className="muted">{usedPhrase}</span>
      </div>

      {/*
        TODAY'S TOTAL — the figure the operator actually asks for, and the reason this row
        exists rather than living only in the aria-label.

        Deliberately beside "This hour" and not a `stat` tile: it is the same measurement at a
        different boundary, from the same call, and putting it anywhere else on the page would
        make two elements answer one question — which is the duplication this dashboard was
        halved to remove. No pips: there is no daily allowance to fill (`fleetMaxPerDay` is
        unset by Tabish's decision), and drawing a bounded row would be a picture of a rule
        that is not in force — the exact `Infinity` mistake that took `/` to HTTP 500.
      */}
      <div className="pace-allowance">
        <span className="eyebrow">Today</span>
        <span className="muted">{todayPhrase}</span>
      </div>

      {!capped && (
        <p className="cardnote">
          One message a minute whenever there is a draft clear to send &mdash; any time of day. A send itself takes
          about a minute and the reply sweep pauses sending while it reads, so the real rate settles around 25&ndash;35
          an hour, not 60.
        </p>
      )}

      {/*
        ── THE THREE CONSTANTS MOVED TO /rules (2026-08-17) ──────────────────────
        `DISPATCH_INTERVAL_MINUTES`, `FLEET_MIN_GAP_MINUTES` and `MAX_SENDS_PER_TICK` were
        drawn here as three stats — six numerals, no control — and `/rules` already states
        all three from the same imports, as rules, with the reason attached. They were a
        DUPLICATE, and duplication is a failure of the same kind as silence: a reader who
        sees a fact twice learns to skip it, so the copy on the busiest page was costing the
        copy that explains itself.

        MOVED, not deleted — the distinction the simplification brief insists on. The link in
        the caption above is the click, and what stays here is the part that is not a
        constant: WHERE NOW SITS in the window, how much of this hour's allowance is gone,
        and what the last tick actually did.
      */}

      {/*
        WHAT THE LAST TICK DID, always. "Nothing happened" with no explanation is the
        failure this entire panel exists to prevent, and a dispatcher that holds silently
        would reintroduce it four times an hour.
      */}
      <p className="blurb">
        {lastTick === null
          ? 'The dispatcher has not run yet on this machine.'
          : `The last tick: ${lastTick}`}
      </p>
    </figure>
  )
}
