'use client'

import { useState, useTransition } from 'react'
import { labelPost } from '../actions'

/**
 * "THIS WAS ORDINARY" — the ONE labelling control in the system.
 *
 * ── WHAT IT REPLACED ──────────────────────────────────────────────────────
 *
 * A separate "Worth a look" queue with two buttons, *This was paid* and *Ordinary post*,
 * plus a third verdict (`REVIEW`) that existed so a post could sit between them. Tabish,
 * 2026-08-17: *"no more indecisiveness, either a post is paid or unpaid/ordinary, no in
 * between or borderline or worth a look or manual … replaced with a simple 'This was
 * ordinary' cross button next to each paid post detected."*
 *
 * So there is no queue and no second button. Every post the system calls paid is on one
 * list, and the only thing a person can say about one is that it is not.
 *
 * ── WHY A CROSS AND NOT A CONFIRM ─────────────────────────────────────────
 *
 * The asymmetry is the whole design. A false alarm is visible — it sits on a list a person
 * reads — and costs one click. A MISS is invisible and unappealable: nothing shows a post
 * that was never flagged, so no button could ever be pressed about it. Making "paid" the
 * default and "ordinary" the correction puts the click where the error is visible.
 *
 * It is also what makes the footage safe to trust. `applyFrameSignal` now mints a CAMPAIGN
 * from video text, which the permission table forbade until today; the reason that is a
 * trade rather than a loosening is that this control shipped with it.
 *
 * ── WHAT ONE CLICK ACTUALLY DOES ──────────────────────────────────────────
 *
 * `labelPost(shortcode, false)` — still the ONE writer of `humanLabel`. It sets the verdict
 * to ORGANIC and stamps `verdictSource: 'human'`, which five consumers pick up for free
 * because they all query `verdict: 'CAMPAIGN'`; and it retires any company discovered ONLY
 * from this post that has never been written to, which they do not.
 *
 * ── NO FIVE-SECOND UNDO WINDOW, DELIBERATELY ──────────────────────────────
 *
 * The old review queue deferred its write for five seconds so a misclick could be taken
 * back. That was right for an IRREVERSIBLE two-way choice feeding a recall measurement.
 * This is a one-way correction on a list that keeps the row: a post marked ordinary is
 * still on `/paid-posts`, still shows what it says, and pressing the control again is how
 * it comes back. An undo timer for something already undoable is machinery for its own sake.
 */
export function DismissButton({ shortcode, dismissed }: { shortcode: string; dismissed: boolean }) {
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  const set = (paid: boolean) => {
    setError(null)
    startTransition(async () => {
      const r = await labelPost(shortcode, paid)
      if (!r.ok) setError(r.message)
    })
  }

  if (dismissed) {
    return (
      <button
        className="link-btn"
        onClick={() => set(true)}
        disabled={pending}
        title="Put this back on the paid list"
      >
        {pending ? '…' : 'marked ordinary — undo'}
      </button>
    )
  }

  return (
    <>
      <button
        className="link-btn"
        onClick={() => set(false)}
        disabled={pending}
        aria-label="This was an ordinary post, not paid"
        title="This was an ordinary post, not paid"
      >
        {pending ? '…' : '✕ not paid'}
      </button>
      {error ? <span className="note-warn"> {error}</span> : null}
    </>
  )
}
