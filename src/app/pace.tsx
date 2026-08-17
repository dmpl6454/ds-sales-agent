import { ACTIVE_FROM_HOUR, ACTIVE_TO_HOUR, FLEET_MAX_PER_HOUR } from '@/outreach/pacing'

/**
 * THE PACE — drawn, because the numbers alone do not answer the question people ask.
 *
 * "Autopilot is on and nothing has gone out" is the ORDINARY state for most of an hour,
 * and the reason is a conjunction of four rules that are individually boring: active
 * hours, the minimum gap, the fleet allowance, and one send per tick. Listed as figures
 * they read as trivia. Drawn as a band with `now` on it, the answer is immediate — you
 * are outside the window, or you are inside it and the allowance is spent.
 *
 * ── EVERY NUMBER IS IMPORTED FROM `pacing.ts` ───────────────────────────────
 *
 * Not retyped, not passed in as props with defaults. A page that states a limit by a
 * different rule than the one enforcing it reads as headroom, and this codebase has the
 * receipts: the dashboard measured `MAX_TOTAL_SENDS` against delivered messages while the
 * planner measured it against in-flight ones, so with the ceiling at 6 the planner saw 6/6
 * and refused to prepare anything for two days while the page showed 3/6 and no blocker
 * at all.
 *
 * The active-hours guard in particular used to exist BY ACCIDENT — delivery only ran at
 * four daytime slots, so "we never DM at 4 a.m." was a property of the slot list rather
 * than a rule. Drawing it is part of how it stays written down.
 */
export function PaceBand({
  istHour,
  istMinute,
  sentThisHour,
  lastTick,
}: {
  istHour: number
  istMinute: number
  /** Fleet sends already claimed this hour, from the reservation table the guard reads. */
  sentThisHour: number
  /** What the dispatcher did last, in its own words. Null when it has never run. */
  lastTick: string | null
}) {
  const span = ACTIVE_TO_HOUR - ACTIVE_FROM_HOUR
  const nowHours = istHour + istMinute / 60
  const inside = nowHours >= ACTIVE_FROM_HOUR && nowHours < ACTIVE_TO_HOUR

  /* Clamped so a 03:40 "now" does not draw the marker off the left edge and imply 10:00. */
  const pos = Math.min(100, Math.max(0, ((nowHours - ACTIVE_FROM_HOUR) / span) * 100))
  const clock = `${String(istHour).padStart(2, '0')}:${String(istMinute).padStart(2, '0')}`

  const label = inside
    ? `Inside sending hours. It is ${clock} IST; the window runs ${ACTIVE_FROM_HOUR}:00 to ${ACTIVE_TO_HOUR}:00 IST. ${sentThisHour} of ${FLEET_MAX_PER_HOUR} fleet sends used this hour.`
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
        The allowance drawn as pips rather than "2/3". A fraction has to be read; three
        boxes with two filled is understood without reading. It is also the number the
        guard actually claims against — `DailyReservation` with `scope: 'fleet'` — not a
        count this page worked out for itself.
      */}
      <div className="pace-allowance">
        <span className="eyebrow">This hour</span>
        <span className="pips" aria-hidden="true">
          {Array.from({ length: FLEET_MAX_PER_HOUR }, (_, i) => (
            <span key={i} className={i < sentThisHour ? 'pip pip-on' : 'pip'} />
          ))}
        </span>
        <span className="muted">
          {sentThisHour} of {FLEET_MAX_PER_HOUR} fleet sends used
        </span>
      </div>

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
