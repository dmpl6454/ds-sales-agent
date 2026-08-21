import { redirect } from 'next/navigation'
import { currentUser } from '@/lib/session'
import { buildPaidPostsView } from '../view-model'
import { Nav } from '../nav'
import { PageHead } from '../page-head'
import { BrandsPanelView } from '../brands'
import { CoverageNote } from '../coverage'
import { DismissButton } from './dismiss'
import { AccuracyTrendPanel } from './accuracy'
import { buildAccuracyTrend } from '../view-model/accuracy-trend'

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

  const [v, accuracy] = await Promise.all([buildPaidPostsView(), buildAccuracyTrend()])
  const judged = v.byVerdict.filter((r) => r.verdict !== 'UNCLASSIFIED').reduce((n, r) => n + r.count, 0)
  const unjudged = v.byVerdict.find((r) => r.verdict === 'UNCLASSIFIED')?.count ?? 0

  return (
    <>
      <Nav current="/paid-posts" email={user.email} />
      <div className="page">
        <PageHead
          title="Paid posts"
          sub={`${v.weekDetected} spotted in the last 7 days · ${v.totalDetected} ever`}
        />

        {/*
          The coverage caveat travels with any figure it qualifies. See the note on Today —
          "a metric that covers part of the data must say which part".
        */}
        <CoverageNote detection={v.detection} channelCount={v.perChannel.length} showLink={false} />

        <section>
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
          {/*
            TWO BOXES ONLY — paid and ordinary (2026-08-19, Tabish: "remove the 1 not
            judged and other boxes from UI, only paid and ordinary must be displayed").
            A post is paid or it is ordinary; the rare not-judged remainder (a failed
            call, retryable) is the one quiet sentence above, never a box that reads
            like a category of post.
          */}
          <ul className="statgrid">
            {v.byVerdict
              .filter((r) => r.verdict === 'CAMPAIGN' || r.verdict === 'ORGANIC')
              .map((r) => (
                <li key={r.verdict}>
                  <strong>{r.count}</strong>
                  <span>{verdictLabel(r.verdict)}</span>
                </li>
              ))}
          </ul>

          {/*
            THE FUNNEL — the answer to "356 paid posts, why only 75 messages?", asked
            2026-08-19. Live counts, one sentence each, because the honest answer is a
            chain: prospect handles come ONLY from companies Instagram itself names on a
            post, many posts name nobody or repeat the same company, and people are
            refused by the person guard.
          */}
          <p className="cardnote">
            <strong>From paid posts to messages:</strong> {v.funnel.paidPosts} paid posts have yielded{' '}
            {v.funnel.prospectsLive + v.funnel.retired} companies — a post only names a company when
            Instagram itself asserts one (caption @mentions and tags), many posts name nobody, and many
            name the same company twice. {v.funnel.retired} were retired as people or our own pages.
            Of the {v.funnel.prospectsLive} live companies, <strong>{v.funnel.queued} have a message queued</strong>,{' '}
            {v.funnel.contacted} have already been contacted, and the rest are held by the person guard
            or spacing. A message is written within 15 minutes of a company being identified.
          </p>
          {/*
            Said once, quietly, rather than counted as outstanding work: the older corpus
            is what the free hashtag filter learns each channel's normal vocabulary from,
            so it is kept on purpose and is not a task.
          */}
          {v.storedBeforeCutoff > 0 && (
            <p className="muted">
              {v.storedBeforeCutoff}{' '}
              older posts are also stored. They are not judged by design — they are what the
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
            {v.framesRead}{' '}
            posts had the text in their video read as well as their caption &mdash; a paid placement can
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

        {/*
          THE QUEUE AND THE SETTLED LIST ARE BOTH GONE (2026-08-17).

          There were three lists here — "Worth a look", "Answers you have given", and the
          posts table — and a reader who sees the same post on two of them learns to skip
          both. Tabish: *"no more indecisiveness … no in between or borderline or worth a
          look or manual."*

          One table now. Every post the system calls paid, plus the ones a person has
          crossed off so the cross can be undone, with the control on the row itself.
        */}
        <section>
          <h2>The posts</h2>
          {v.posts.length === 0 ? (
            <p className="group-blurb">Nothing judged paid yet.</p>
          ) : (
            <>
              {/*
                THE TABLE SCROLLS, NOT THE PAGE. Caught by `pnpm ig:layout` at 800px:
                six columns of post, channel, brands and verdict came to 1069px against an
                800px viewport, so the whole document scrolled sideways and the rail went
                with it. Wide content gets its own `overflow-x` container — a body that
                scrolls horizontally moves every other element on the page as collateral.
              */}
              <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    {/* "Posted", not "Date" — the column now carries the hour, and the
                        hour is the half that decides whether a verdict looks plausible. */}
                    <th>Posted</th>
                    <th>Channel</th>
                    <th>Brand</th>
                    <th>Post</th>
                    <th>Verdict</th>
                    {/*
                      Who this post earns a message TO (Tabish, 2026-08-21) — the verified
                      prospect(s) the system linked to it, via the post's own @mentions and
                      tags or via discovery from an untagged post. The SAME linkage the
                      allowance rule counts, so this column can never disagree with the
                      enforcer about who a paid post unlocks.
                    */}
                    <th>We message</th>
                    {/* The only labelling control in the system. See dismiss.tsx. */}
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {v.posts.map((p) => (
                    <tr key={p.shortcode}>
                      {/*
                        Date AND hour. A bare date could not separate a post published in
                        the commercial window from one at 3am, and that distinction is
                        measured rather than assumed: over 14 days @viralbhayani published
                        84 posts before 09:00 IST and not one was paid.

                        `lateness` renders only when detection was far behind publication —
                        on the measured data that means the watch had a GAP, and a post that
                        scrolls out of the 48-post window during one can never be re-scraped.
                        Silent on the common path, because a number on every row is furniture.
                      */}
                      <td className="muted" title={p.postedExact}>
                        {p.postedLabel}
                        {/*
                          Muted, not dressed as an alarm. This is information about ONE
                          post; whether the watch itself is healthy is `assessWatch`'s job
                          and has its own card. A per-row warning colour for something that
                          is not the operator's to act on is how a page teaches people to
                          ignore its colours.
                        */}
                        {p.lateness ? <div>{p.lateness}</div> : null}
                      </td>
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
                          What the model SAW. The caption called this post ordinary and the
                          FOOTAGE disagreed — which since 2026-08-17 is enough to call it
                          paid, so saying what was read is no longer a nicety.
                        */}
                        {p.frameEvidence ? <span className="muted"> — from the footage: {p.frameEvidence}</span> : null}
                      </td>
                      <td>
                        {p.recipients.map((r, i) => (
                          <span key={r.handle}>
                            {i > 0 ? ', ' : ''}@{r.handle}
                            {/* A retired prospect is named, not hidden: "we found them
                                and chose not to write" and "we found nobody" are
                                different facts. */}
                            {r.retired ? <span className="muted"> (retired)</span> : null}
                          </span>
                        ))}
                        {/*
                          The rest of the post's candidates, BY STATE — never collapsed
                          into "nobody verified" (Tabish, 2026-08-21: that read as false
                          on posts with visible tags, and he was right — most of those
                          candidates were "badge check pending" or "unverified, refused",
                          which are different facts with different remedies).
                        */}
                        {p.candidateNote ? (
                          <span className="muted">
                            {p.recipients.length > 0 ? ' · ' : ''}
                            {p.candidateNote}
                          </span>
                        ) : null}
                        {p.recipients.length === 0 && !p.candidateNote ? (
                          /* Genuinely nobody: the post asserted no account at all and no
                             name resolved — a fully anonymous paid post yields NO
                             prospect by design (existence is not identity). */
                          <span className="muted">nobody named</span>
                        ) : null}
                      </td>
                      <td>
                        <DismissButton shortcode={p.shortcode} dismissed={p.dismissed} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
              {v.postsTotal > v.posts.length ? (
                <p className="muted">
                  Showing the newest {v.posts.length} of {v.postsTotal}.
                </p>
              ) : null}
            </>
          )}
        </section>

        <section>
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
                {/*
                  WHETHER THE JUDGING HAS EVER BEEN CHECKED, per channel. The 98% this
                  project quotes belongs to @madovermarketing_mom and is measured on the one
                  channel where the classifier never runs. @bollywoodchronicle has 0 labels
                  across 937 posts, and without this line a reader has no way to know that.
                */}
                <div className="muted">{c.accuracyNote}</div>
              </li>
            ))}
          </ul>
        </section>

        {/*
          HOW WELL THE JUDGING IS DOING, from the runs the harness already stored.
          `accuracyHistory` has held every run since 2026-08-13 and NOTHING rendered it — a
          measurement taken 30 times and never once shown, which is the same shape as the 166
          cover frames saved in a day and never read.

          Below the verdicts and above the brands, because it is a statement about the table
          directly above it: those verdicts are what this is measuring the quality of.
        */}
        <AccuracyTrendPanel trend={accuracy} />

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
 * `REVIEW` used to be here and read *"borderline — worth a look"*. It is gone with the
 * third state (Tabish, 2026-08-17).
 *
 * `UNCLASSIFIED` stays and is NOT a third verdict wearing a different hat. It means NOT
 * JUDGED — a failed call, no API key, a caption too short to be a pitch — and it has never
 * meant ordinary. Rendering it as "ordinary" would be absence of data hardening into a
 * negative verdict, on the one page whose job is telling the truth about the numbers.
 */
function verdictLabel(verdict: string): string {
  switch (verdict) {
    case 'CAMPAIGN':
      return 'paid'
    case 'ORGANIC':
      return 'ordinary posts'
    case 'UNCLASSIFIED':
      return 'not judged'
    default:
      return verdict.toLowerCase()
  }
}
