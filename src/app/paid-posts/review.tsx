'use client'

import { useState, useTransition } from 'react'
import { labelPost } from '../actions'

/**
 * The review queue: posts nobody has settled, with the two buttons that settle one.
 *
 * ── WHY THIS IS ITS OWN SECTION AND NOT A COLUMN IN THE TABLE ───────────────
 *
 * The posts table shows the newest 100 of everything judged paid or borderline. A post
 * needing an answer would sit inside that list, indistinguishable from the 90 that need
 * nothing, and scroll off it within a couple of days — the only screen it appears on.
 * Work to do and a record of what happened are different things and belong in different
 * places.
 *
 * It is deliberately small and oldest-first. This is the only source of labels for
 * placements that live in the FOOTAGE rather than the caption, so an answer here is worth
 * more than it looks: `ig:accuracy` cannot measure that class by construction, and every
 * answer is a row in the harness that would measure it.
 */

export interface ReviewRow {
  shortcode: string
  url: string
  dayLabel: string
  channelHandle: string
  caption: string
  /** Why the classifier hesitated, in its own words. */
  reason: string | null
  /** What the video's own text said, when that is why this is here. */
  frameEvidence: string | null
}

export function ReviewQueue({ rows }: { rows: ReviewRow[] }) {
  if (rows.length === 0) {
    return (
      <section className="group">
        <h2>Worth a look</h2>
        <p className="group-blurb">Nothing is waiting on you.</p>
      </section>
    )
  }

  return (
    <section className="group">
      <h2>Worth a look</h2>
      <p className="group-blurb">
        {rows.length} post{rows.length === 1 ? '' : 's'} nobody has settled. Open it, decide whether the publisher was
        paid, and say so &mdash; your answer replaces the verdict and is the only record of what a paid post looks like
        when the caption does not say.
      </p>
      <ul className="plain-list">
        {rows.map((r) => (
          <ReviewItem key={r.shortcode} row={r} />
        ))}
      </ul>
    </section>
  )
}

function ReviewItem({ row }: { row: ReviewRow }) {
  const [pending, startTransition] = useTransition()
  const [done, setDone] = useState<string | null>(null)

  /**
   * One busy flag per ITEM, and the answer replaces the row rather than leaving it in
   * place. A control must never report the state of something that has not started, and a
   * confirmation rendered inside a block the success path removes is never seen — both
   * mistakes have already been made on this dashboard.
   */
  const answer = (wasPaid: boolean) =>
    startTransition(async () => {
      const res = await labelPost(row.shortcode, wasPaid)
      setDone(res.message)
    })

  if (done) return <li className="muted">{done}</li>

  return (
    <li>
      <p>
        <span className="muted">{row.dayLabel}</span> @{row.channelHandle} &mdash;{' '}
        <a href={row.url} target="_blank" rel="noreferrer">
          open on Instagram
        </a>
      </p>
      <p className="muted">{row.caption.slice(0, 180)}</p>
      {/*
        The footage evidence is the whole reason a post like the Thane bus is here: its
        caption reads as ordinary local news, and the frame carries a brand name. Showing
        it is what makes this a question a person can answer in one look rather than a nag.
      */}
      {row.frameEvidence ? (
        <p>
          <strong>From the footage:</strong> {row.frameEvidence}
        </p>
      ) : null}
      {row.reason ? <p className="muted">The classifier said: {row.reason}</p> : null}
      <p>
        <button type="button" onClick={() => answer(true)} disabled={pending}>
          {pending ? 'Saving…' : 'This was paid'}
        </button>{' '}
        <button type="button" onClick={() => answer(false)} disabled={pending}>
          {pending ? 'Saving…' : 'Ordinary post'}
        </button>
      </p>
    </li>
  )
}
