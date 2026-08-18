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
  perHour,
  minGapMinutes,
  lastTick,
}: {
  istHour: number
  istMinute: number
  /** Fleet sends already delivered this IST hour, counted the way the guard counts. */
  sentThisHour: number
  /** The hourly allowance the dispatcher enforces. `Infinity` when there is none. */
  perHour: number
  /** Minutes the dispatcher insists on between two fleet sends. */
  minGapMinutes: number
  /** What the dispatcher did last, in its own words. Null when it has never run. */
  lastTick: string | null
}) {
  const span = ACTIVE_TO_HOUR - ACTIVE_FROM_HOUR
  const nowHours = istHour + istMinute / 60
  const inside = nowHours >= ACTIVE_FROM_HOUR && nowHours < ACTIVE_TO_HOUR
  const capped = Number.isFinite(perHour)
  /* Pips only while they are both meaningful and readable — see MAX_PIPS. */
  const pips = capped && perHour <= MAX_PIPS ? perHour : 0

  /* Clamped so a 03:40 "now" does not draw the marker off the left edge and imply 10:00. */
  const pos = Math.min(100, Math.max(0, ((nowHours - ACTIVE_FROM_HOUR) / span) * 100))
  const clock = `${String(istHour).padStart(2, '0')}:${String(istMinute).padStart(2, '0')}`

  /**
   * What paces the fleet when there is no hourly allowance: the minimum gap, which is a
   * REFUSAL like the allowance was, not a suggestion. Stated as the ceiling it implies so
   * the sentence answers the question the allowance used to — "how much can go out".
   */
  const gapCeiling = minGapMinutes > 0 ? Math.floor((span * 60) / minGapMinutes) : null
  const usedPhrase = capped
    ? `${sentThisHour} of ${perHour} fleet sends used this hour`
    : `${sentThisHour} sent this hour — no hourly limit; one message every ${minGapMinutes} minutes at most`

  const label = inside
    ? `Inside sending hours. It is ${clock} IST; the window runs ${ACTIVE_FROM_HOUR}:00 to ${ACTIVE_TO_HOUR}:00 IST. ${usedPhrase}.`
    : `Outside sending hours. It is ${clock} IST; the window runs ${ACTIVE_FROM_HOUR}:00 to ${ACTIVE_TO_HOUR}:00 IST, so nothing will go out until it opens.`

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
        <span>{ACTIVE_FROM_HOUR}:00</span>
        <span className={inside ? 'note-good' : 'note-warn'}>
          {inside ? `now ${clock}` : `${clock} — outside`}
        </span>
        <span>{ACTIVE_TO_HOUR}:00</span>
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

      {!capped && gapCeiling !== null && (
        <p className="cardnote">
          At that spacing the window allows about {gapCeiling} messages a day across every account.
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
