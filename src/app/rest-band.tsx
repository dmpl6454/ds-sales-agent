import type { RestTally } from './view-model/rest-tally'
import { istPostedLabel, istTimeKey } from '@/lib/time'

/**
 * HOW MANY COMPANIES ARE RESTING, OUT OF HOW MANY — the figure that did not exist.
 *
 * Tabish, 2026-08-24: *"currently a user does not know how many targets are on hold from total
 * (which would keep on increasing and changing)."*
 *
 * MEASURED the day it shipped: **469 of 473**. Every count on the Autopilot page was about
 * DRAFTS — 10 waiting, 6 held — and a company the planner refused to write for has no draft, so
 * the population that explains a ten-deep queue was invisible on the page whose whole job is
 * *"is it sending, and if not, exactly what is stopping it"*.
 *
 * ── WHY THE HEADLINE IS NOT AN ALARM ──────────────────────────────────────
 *
 * 469 of 473 sounds like an outage and is the rules working. A recipient who has heard from us
 * once and is waiting for their next paid post is Tabish's own rule doing exactly what he asked
 * for, and 460 of the 469 clear with nobody doing anything. So this renders in NEUTRAL type,
 * never in the amber `status` box: *"a container that changes colour must contain only things
 * the colour is about"* is a rule this file's history earned, and dressing the steady state as
 * a fault is how an operator learns to ignore the box that matters.
 *
 * What DOES deserve pointing at is the one row that needs a person, so that number is stated
 * separately rather than left to be spotted in a list.
 *
 * ── AND IT SAYS WHEN IT WAS MEASURED ──────────────────────────────────────
 *
 * The figure moves continuously — a delivery re-anchors a 7-day window, a reply arms a fresh
 * halt, a paid post releases a company mid-afternoon. It is computed at render, so the honest
 * caption is the time it was read, and the page re-renders every 30-45 s on its own.
 */
export function RestBand({ tally, showBreakdown = true }: { tally: RestTally; showBreakdown?: boolean }) {
  const { total, resting, clear, queued, retired, watched, byReason, needingAPerson } = tally

  /* Nothing to explain when nothing is resting — and that IS reachable: it is what an empty
     hold list looks like on a day the fleet has room everywhere. Say so plainly rather than
     rendering a section with five zeroes in it. */
  if (total === 0) return null

  /*
    NOTHING RESTING is a real state and it is good news, so it gets one line and no table.
    Reading the rendered branches caught the alternative: the shared copy below says "every one
    of them clears by itself", which is a sentence about a population that does not exist.
  */
  if (resting === 0) {
    return (
      <section>
        <h2>Who is resting</h2>
        <p className="group-blurb">
          Nothing is resting — all <strong>{total}</strong> companies are clear to write to. The queue below is what
          has actually been drafted.
        </p>
      </section>
    )
  }

  /**
   * 100% MEANS ALL OF THEM, and nothing else may round up to it.
   *
   * 472 of 473 is 99.79%, which `Math.round` renders as "100%" beside a sentence saying one
   * company is clear — a figure contradicting the words next to it. Capped at 99 unless every
   * single one is resting.
   */
  const share = resting === total ? 100 : Math.min(99, Math.round((resting / total) * 100))
  const selfClearing = resting - needingAPerson

  return (
    <section>
      <h2>Who is resting</h2>
      {/*
        READ THE RENDERED SENTENCE, NOT THE TEMPLATE. The first version branched on `clear === 0`
        into "and none has nothing holding them back" — a double negative that every assertion
        about the numbers passes happily. Both halves are stated positively now.
      */}
      <p className="group-blurb">
        <strong>
          {resting} of {total} companies we write to ({share}%)
        </strong>{' '}
        are resting right now.{' '}
        {queued > 0 ? (
          <>
            {queued} more {queued === 1 ? 'has a message' : 'have messages'} already written and waiting in the queue.{' '}
          </>
        ) : null}
        {clear === 0 ? (
          <>There is not one we could write to at this moment.</>
        ) : (
          <>
            {clear} {clear === 1 ? 'has' : 'have'} nothing holding {clear === 1 ? 'it' : 'them'} back.
          </>
        )}{' '}
        {needingAPerson === 0 ? (
          <>Every one of them clears by itself — this is the rules working, not a fault.</>
        ) : (
          <>
            {selfClearing} clear by themselves; <strong>{needingAPerson} will not clear unless something changes.</strong>
          </>
        )}
      </p>

      {showBreakdown && byReason.length > 0 ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Companies</th>
                <th>Why they are resting</th>
                <th>Soonest one frees up</th>
              </tr>
            </thead>
            <tbody>
              {byReason.map((r) => (
                <tr key={r.reason}>
                  <td>
                    <strong>{r.count}</strong>
                  </td>
                  <td>
                    {r.label}
                    {r.needsAPerson ? <> — <strong>needs a person</strong></> : null}
                  </td>
                  <td className="muted">
                    {r.nextReleaseAt ? istPostedLabel(r.nextReleaseAt) : r.needsAPerson ? 'not on a clock' : 'any minute'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      <p className="cardnote muted">
        Measured {istTimeKey(tally.measuredAt)} IST, and it moves all day: a message re-starts that
        company&apos;s week, a reply starts a fresh seven days, and a new paid post releases one immediately.
        {retired > 0 || watched > 0 ? (
          <>
            {' '}
            Not counted here: {retired} retired {retired === 1 ? 'company' : 'companies'} (retired means never written
            to again) and {watched} watched {watched === 1 ? 'page' : 'pages'} we read but never message — which is why
            this total is smaller than the number in the list above.
          </>
        ) : null}{' '}
        <a href="/rules">How each rule works</a>
      </p>
    </section>
  )
}
