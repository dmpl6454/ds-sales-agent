import { redirect } from 'next/navigation'
import { currentUser } from '@/lib/session'
import { buildPaidPostsView } from '../view-model'
import { Nav } from '../nav'
import { BrandsPanelView } from '../brands'
import { CoverageNote } from '../coverage'
import { ReviewQueue } from './review'

export const dynamic = 'force-dynamic'

/**
 * `/paid-posts` — what detection found, and what it cost.
 *
 * New in step C, assembled from three things that had no proper home:
 *
 *   the verdict breakdown  which was one number on `/` with a caveat under it
 *   the model spend        which was in `pnpm ig:audit` and on no screen at all
 *   the brands panel       which was on `/`, below the channels it came from
 *
 * ── UNCLASSIFIED MEANS NOT JUDGED. IT HAS NEVER MEANT ORGANIC ───────────────
 *
 * That distinction is the whole reason this page shows a breakdown rather than a total.
 * @viralbhayani never discloses paid work, so a count of judged campaigns says nothing about
 * how much paid work they do — roughly half their ~62 posts a day is commercial. A single
 * figure here would read as coverage, and every measurement in CLAUDE.md says it is not.
 *
 * `verdictSource` exists for the same reason one level down: a `#Collaboration` hashtag is a
 * FACT and a model's verdict is an OPINION, and they must never be added together silently.
 *
 * ── AND FAILED CALLS ARE COUNTED ────────────────────────────────────────────
 *
 * `ModelCall` records failures deliberately, because *a rising failure rate is exactly what a
 * cost table would hide by leaving it out*. A failed call is never recorded as a verdict — it
 * yields UNCLASSIFIED with `verdictSource: 'none'`, never a fabricated ORGANIC — so the two
 * numbers below answer different questions and both need to be visible.
 */
export default async function PaidPostsPage() {
  const user = await currentUser()
  if (!user) redirect('/sign-in')

  const v = await buildPaidPostsView()
  const judged = v.byVerdict.filter((r) => r.verdict !== 'UNCLASSIFIED').reduce((n, r) => n + r.count, 0)
  const unjudged = v.byVerdict.find((r) => r.verdict === 'UNCLASSIFIED')?.count ?? 0

  return (
    <>
      <Nav current="/paid-posts" email={user.email} />
      <div className="page">
        <header className="page-head">
          <h1>Paid posts</h1>
          <p className="page-sub">
            {v.weekDetected} spotted in the last 7 days · {v.totalDetected} ever
          </p>
        </header>

        {/*
          The coverage caveat travels with any figure it qualifies. See the note on Today —
          "a metric that covers part of the data must say which part".
        */}
        <CoverageNote detection={v.detection} channelCount={v.perChannel.length} showLink={false} />

        <section className="group">
          <h2>What we have judged</h2>
          {/*
            Every figure is scoped to the detection window, and the window is NAMED.
            This block used to count the whole corpus, so it reported ~370 posts as "not
            judged" — all of it pre-cutoff history the classifier is deliberately never
            asked to read. On a screen where "not judged" means a job to do, that was a
            permanent backlog nobody could clear. Inside the window the number is real.
          */}
          <p className="group-blurb">
            {unjudged === 0 ? (
              <>
                All {judged} posts since {v.since.toLocaleDateString('en-GB', { day: 'numeric', month: 'long' })} have a
                verdict.
              </>
            ) : (
              <>
                {judged} of {judged + unjudged} posts since{' '}
                {v.since.toLocaleDateString('en-GB', { day: 'numeric', month: 'long' })} have a verdict. The other{' '}
                {unjudged} are <strong>not judged</strong>, which has never meant organic — a post nobody classified
                and a post classified as ordinary are different facts.
              </>
            )}
          </p>
          <ul className="summary-row">
            {v.byVerdict.map((r) => (
              <li key={r.verdict}>
                <strong>{r.count}</strong>
                <span>{verdictLabel(r.verdict)}</span>
              </li>
            ))}
          </ul>
          {/*
            Said once, quietly, rather than counted as outstanding work: the older corpus
            is what the free hashtag filter learns each channel's normal vocabulary from,
            so it is kept on purpose and is not a task.
          */}
          {v.storedBeforeCutoff > 0 && (
            <p className="muted">
              {v.storedBeforeCutoff} older posts are also stored. They are not judged by design — they are what the
              classifier learns each channel&rsquo;s normal vocabulary from.
            </p>
          )}
          {/*
            The footage reports SEPARATELY from caption verdicts: a flagged frame asked a
            person to look, it did not decide anything, and folding it into "paid" would
            count a judgement nobody made.

            AND IT REPORTS ITS FAILURES. This used to be one number — "N posts had the text
            in their video read" — under a comment claiming there was no "not configured"
            state to explain. That was true while OCR was macOS-only and free; it stopped
            being true the day detection moved to a server, where the engine can be missing
            or can error. A single low count cannot distinguish a clean corpus from a
            broken reader, and the second is an outage wearing the costume of a quiet day.
          */}
          <p className="muted">
            {v.framesRead} posts had the text in their video read as well as their caption &mdash; a paid placement can
            sit in the footage under an ordinary caption
            {v.frameFlagged > 0 ? (
              <>
                . <strong>{v.frameFlagged} were flagged that way</strong> and are marked &ldquo;from the
                footage&rdquo; below.
              </>
            ) : (
              '.'
            )}
          </p>

          {/*
            Each of these is a DIFFERENT problem with a different fix, so they render as
            separate sentences rather than a merged "N not read" — the same rule the
            coverage caveat follows: two problems with two fixes are two sentences.
          */}
          {v.framesNoEngine > 0 ? (
            <p className="reason bad">
              <strong>Nothing is reading the footage.</strong> {v.framesNoEngine} posts have a frame saved that no OCR
              engine on this machine could open, so their video has not been looked at. The frames are kept and can be
              read later once an engine is available.
            </p>
          ) : null}
          {v.framesFailed > 0 ? (
            <p className="reason warn">
              {v.framesFailed} frames were saved but the reader errored on them. They are not &ldquo;clean&rdquo; &mdash;
              they are unread, and they can be retried.
            </p>
          ) : null}
          {v.framesNotSaved > 0 ? (
            <p className="muted">
              {v.framesNotSaved} posts have no frame at all. Frames are saved when a post is first seen, and the link
              they come from expires &mdash; older posts never had one and cannot get one now.
            </p>
          ) : null}
        </section>

        <ReviewQueue rows={v.review} />

        <section className="group">
          <h2>The posts</h2>
          {v.posts.length === 0 ? (
            <p className="group-blurb">Nothing judged paid yet.</p>
          ) : (
            <>
              <table className="sent-table">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Channel</th>
                    <th>Brand</th>
                    <th>Post</th>
                    <th>Verdict</th>
                  </tr>
                </thead>
                <tbody>
                  {v.posts.map((p) => (
                    <tr key={p.shortcode}>
                      <td className="muted">{p.dayLabel}</td>
                      <td>@{p.channelHandle}</td>
                      <td>{p.brands.length > 0 ? p.brands.join(', ') : <span className="muted">—</span>}</td>
                      <td>
                        <a href={p.url} target="_blank" rel="noreferrer">
                          open on Instagram
                        </a>
                      </td>
                      <td>
                        {verdictLabel(p.verdict)}
                        {/*
                          What the model SAW, because "worth a look" without saying at what
                          is a nag. The caption called this post ordinary; the frame did not.
                        */}
                        {p.frameEvidence ? <span className="muted"> — from the footage: {p.frameEvidence}</span> : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {v.postsTotal > v.posts.length ? (
                <p className="muted">
                  Showing the newest {v.posts.length} of {v.postsTotal}.
                </p>
              ) : null}
            </>
          )}
        </section>

        <section className="group">
          <h2>By channel</h2>
          <ul className="plain-list">
            {v.perChannel.map((c) => (
              <li key={c.handle}>
                {c.name} <span className="muted">@{c.handle}</span> —{' '}
                <span className="muted">{c.postsLogged} posts stored, </span>
                {c.unclassified ? (
                  <span className="muted">
                    not classified{c.unclassifiedReason ? `: ${c.unclassifiedReason}` : ''}
                  </span>
                ) : (
                  <span className="muted">{c.campaignsThisWeek} paid this week</span>
                )}
              </li>
            ))}
          </ul>
        </section>

        {/*
          Brands sit below the verdicts because a brand is what judging PRODUCED: a paid post
          names its buyer, and that buyer is a company demonstrably spending on placement.
        */}
        <BrandsPanelView brands={v.brands} />
      </div>
    </>
  )
}

/**
 * Plain words for the stored verdict strings.
 *
 * `REVIEW` in particular must not render as its own name: it means the classifier was not
 * confident, which is a third answer and not a synonym for either of the other two.
 */
function verdictLabel(verdict: string): string {
  switch (verdict) {
    case 'CAMPAIGN':
      return 'paid'
    case 'ORGANIC':
      return 'ordinary posts'
    case 'REVIEW':
      return 'borderline — worth a look'
    case 'UNCLASSIFIED':
      return 'not judged'
    default:
      return verdict.toLowerCase()
  }
}
