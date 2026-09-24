'use client'

import { useEffect, useState } from 'react'

/**
 * The boot screen, shown while a route segment streams.
 *
 * ── THE NUMBER, AND WHY IT IS SAFE TO SHOW ONE ──────────────────────────────
 *
 * The mockup drives its ring from a `setInterval` that counts up to 100 and then reveals
 * the dashboard. Reproduced literally that is a lie: on a slow render the counter reaches
 * 100 and then just sits there claiming to be done while the page is still loading; on a
 * fast render it holds a ready dashboard back behind an animation that has not finished.
 * An earlier pass here deleted the number altogether for exactly that reason.
 *
 * The number is what the requested design shows, though, and the two failure modes above
 * both come from ONE choice — driving the count with a fixed target of 100. Aim it at a
 * ceiling BELOW 100 instead (96) and ease it there asymptotically (each tick closes part
 * of the REMAINING distance, never all of it): the figure keeps climbing for as long as
 * this component is mounted, it can never reach — let alone rest at — a number that reads
 * as "finished", and it is replaced by the real page the instant the server component's
 * data lands, whatever it happens to read at that moment. Nothing it displays is ever
 * false: it never claims 100%, and every value below that is a true statement about how
 * long the wait has run, not a fabricated fraction of work completed.
 *
 * This is why the file is a CLIENT component now — `useState`/`useEffect` need one — while
 * remaining exactly as safe as the indeterminate version: the animation still stops the
 * moment there is something to read, because Next unmounts `loading.tsx` on data arrival
 * regardless of what this component is doing internally.
 */
const CEILING = 96
const START_TICK = 0.6
const CLOSE_RATE = 0.045
const TICK_MS = 90

export default function Loading() {
  const [pct, setPct] = useState(0)

  useEffect(() => {
    const id = setInterval(() => {
      // `Math.min` clamps the STATE, not just the display: the flat `START_TICK` term
      // does not shrink as `p` nears the ceiling, so without it the internal value
      // overshoots to ~96.2 and sits there — harmless once rounded and clamped for
      // display, but not the honest "approaches 96 and never passes it" the ceiling
      // is supposed to guarantee.
      setPct((p) => Math.min(CEILING, p + (CEILING - p) * CLOSE_RATE + START_TICK))
    }, TICK_MS)
    return () => clearInterval(id)
  }, [])

  const shown = Math.min(CEILING, Math.round(pct))

  return (
    <div className="boot" role="status" aria-live="polite">
      <div className="boot-inner">
        <div className="boot-ring" aria-hidden="true">
          <span />
          <span />
          <span />
          <span className="boot-word">{shown}%</span>
        </div>

        <div className="boot-name">
          <strong>AI Sales Agent</strong>
          <span>by Digital Sukoon</span>
        </div>

        <div className="boot-bar" aria-hidden="true">
          <span style={{ width: `${shown}%` }} />
        </div>

        {/* The only thing a screen reader gets. The visible number is a pace, not a
            fraction of real work, so announcing it as a percentage complete would tell
            a screen-reader user something the sighted version does not claim either. */}
        <span className="sr-only">Loading</span>
      </div>
    </div>
  )
}
