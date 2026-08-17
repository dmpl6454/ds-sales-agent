import type { AccuracyTrend } from '../view-model/accuracy-trend'

/**
 * HOW WELL THE JUDGING IS DOING, AND HOW MUCH THAT ANSWER IS WORTH.
 *
 * Every choice here is about not over-claiming:
 *
 *   a RANGE, never a point   the classifier is not deterministic — 2 of 89 posts flip
 *                            between identical runs, and one flip is 4.5% of recall
 *   a DATE, always           a percentage with no date reads as current forever
 *   "unmeasured", not 0%     a channel with no labels has no figure, and a zero would read
 *                            as total failure rather than as nothing to compare against
 *   the boundary, marked     `pred` changed on 2026-08-17, so older runs are not comparable
 */
export function AccuracyTrendPanel({ trend }: { trend: AccuracyTrend | null }) {
  if (!trend || trend.lastRunAt === null) {
    return (
      <section className="group">
        <h2>How well the judging is doing</h2>
        <p className="group-blurb">
          The accuracy harness has not run yet. It runs daily at 09:00 IST; until then there is
          no figure, which is different from a bad one.
        </p>
      </section>
    )
  }

  const when = new Date(trend.lastRunAt)
  const hoursAgo = Math.round((Date.now() - when.getTime()) / 3_600_000)
  const freshness =
    hoursAgo < 1 ? 'less than an hour ago' : hoursAgo < 48 ? `${hoursAgo} hours ago` : `${Math.round(hoursAgo / 24)} days ago`

  return (
    <section className="group">
      <h2>How well the judging is doing</h2>
      <p className="group-blurb">
        Measured {freshness}, over {trend.repeats} run{trend.repeats === 1 ? '' : 's'} of the same
        posts.{' '}
        {trend.repeats === 1
          ? 'One run is a single sample — the classifier is not deterministic, so treat this as approximate.'
          : 'The span is the difference between those runs on identical input, which is why it is shown as a range rather than a number.'}
      </p>

      <div className="group-rows">
        {trend.channels.map((c) => (
          <div className="account-row" key={c.handle}>
            <div className="account-head">
              <span className="account-handle">@{c.handle}</span>
              <span className="muted">
                {c.labels === 0
                  ? 'no known right answers here'
                  : `${c.labels} post${c.labels === 1 ? '' : 's'} with a known right answer`}
              </span>
            </div>

            {c.recall === null ? (
              /*
                NOT a zero. A channel with no positives to find has nothing to score, and the
                whole point of this panel is that absence of a figure is not a bad figure —
                the mistake this project has produced five times in other places.
              */
              <p className="muted">Not measurable here — nothing on this channel has a known paid post to find.</p>
            ) : (
              <p className="muted">
                Caught{' '}
                <strong>
                  {c.recall.lo === c.recall.hi ? `${c.recall.hi}%` : `${c.recall.lo}–${c.recall.hi}%`}
                </strong>{' '}
                of the paid posts it should have
                {c.precision
                  ? `, and ${c.precision.lo === c.precision.hi ? `${c.precision.hi}%` : `${c.precision.lo}–${c.precision.hi}%`} of what it flagged was really paid`
                  : ''}
                .
              </p>
            )}
          </div>
        ))}
      </div>

      {/*
        THE CAVEAT THAT MATTERS MOST, and it is deliberately last rather than buried in a
        tooltip. Most labels are #Collaboration disclosures, which are CAPTION-derived — so
        this mostly measures caption classification. A post whose right answer came from its
        caption is no evidence at all about a post whose caption says nothing, which is the
        entire class the footage feature exists to catch.
      */}
      <p className="cardnote">
        This measures judging from CAPTIONS. A paid post that only shows in the video is not
        represented here, so this is not a coverage figure.
        {!trend.comparable
          ? ' Some runs shown pre-date the 17 August change to what counts as a positive prediction, and are not comparable with the newer ones.'
          : ''}
      </p>
    </section>
  )
}
