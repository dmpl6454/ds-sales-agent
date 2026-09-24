import { redirect } from 'next/navigation'
import { currentUser } from '@/lib/session'
import { buildPaidPostsView } from '../view-model'
import { Nav } from '../nav'
import { PageHead } from '../page-head'
import { BrandsPanelView } from '../brands'
import { CoverageNote } from '../coverage'
import { DismissButton } from './dismiss'
import { AccuracyTrendPanel } from './accuracy'
import { ChannelFilter } from './channel-filter'
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
export default async function PaidPostsPage({
  searchParams,
}: {
  searchParams: Promise<{ channel?: string; page?: string; q?: string }>
}) {
  const user = await currentUser()
  if (!user) redirect('/sign-in')

  /**
   * THE WHOLE VIEW STATE IS IN THE URL — `?channel=` and `?page=`.
   *
   * Both are strings anyone can type, and neither is trusted: `buildPaidPostsView` validates
   * the channel against the visible set (an unknown one falls back to no filter rather than
   * an empty table) and clamps the page into range (`?page=999` shows the LAST page, never
   * nothing). Parsed defensively here too, because `Number.parseInt('abc')` is NaN and NaN
   * survives every `<` comparison it meets — the shape that once let a missing confidence
   * sail through a floor check as a confident verdict.
   */
  const { channel, page, q } = await searchParams
  const wantedPage = Number.parseInt(page ?? '1', 10)

  const [v, accuracy] = await Promise.all([
    buildPaidPostsView({
      channel: channel ?? null,
      page: Number.isFinite(wantedPage) ? wantedPage : 1,
      query: q ?? null,
    }),
    buildAccuracyTrend(),
  ])

  /** Both controls must survive each other: paging keeps the channel, the channel resets the page. */
  const hrefForPage = (n: number) =>
    `/paid-posts?${v.channelFilter ? `channel=${encodeURIComponent(v.channelFilter)}&` : ''}` +
    `${v.searchQuery ? `q=${encodeURIComponent(v.searchQuery)}&` : ''}page=${n}#posts`
  const judged = v.byVerdict.filter((r) => r.verdict !== 'UNCLASSIFIED').reduce((n, r) => n + r.count, 0)
  const unjudged = v.byVerdict.find((r) => r.verdict === 'UNCLASSIFIED')?.count ?? 0

  /**
   * The donut's three slices, as percentages of the whole corpus in the window.
   *
   * Computed here rather than in the view model because they are a fact about this ONE
   * drawing — a conic-gradient needs cumulative stops, which is a property of the chart
   * and not of the data. The counts themselves come from `byVerdict`, so the ring and the
   * key beside it can never disagree.
   */
  const paidCount = v.byVerdict.find((r) => r.verdict === 'CAMPAIGN')?.count ?? 0
  const ordinaryCount = v.byVerdict.find((r) => r.verdict === 'ORGANIC')?.count ?? 0
  const verdictTotal = judged + unjudged
  const paidShare = verdictTotal > 0 ? (paidCount / verdictTotal) * 100 : 0
  const ordinaryShare = verdictTotal > 0 ? (ordinaryCount / verdictTotal) * 100 : 0

  /** The widest channel bar is the busiest channel, so every other bar is read against it. */
  const channelMax = Math.max(0, ...v.perChannel.map((c) => c.postsLogged))

  return (
    <>
      <Nav current="/paid-posts" email={user.email} />
      <div className="page">
        <PageHead
          title="Paid posts"
          /* NOT "ever": `totalDetected` is scoped to `inWindow` — posted since the 1 August
             cutoff, and excluding our own pages. Saying "ever" about a windowed, filtered
             figure is the same defect as a bounded list read as a complete record. */
          sub={`${v.weekDetected} spotted in the last 7 days · ${v.totalDetected} since 1 August`}
        />


        {/*
          -- THE TWO FIGURES, THEN ONE SENTENCE -----------------------------------
          The design's shape, and everything this page used to stack above the table is
          still here -- it is in the fold under the tiles.

          WHAT WENT INTO THE FOLD AND WHY. The "What we have judged" heading and its
          "N of M posts have a verdict" sentence were a SECOND copy of the donut's own
          legend ("not judged - N") half a page below; the funnel's three-clause
          explanation of why 356 posts yield 77 companies is an argument a person reads
          once and then knows; and the frame accounting is four sentences about how the
          corpus was read. None of it is a fact about today, which is what the top of a
          page is for.

          WHAT DID NOT GO IN: the two OCR ALARMS. `framesNoEngine` and `framesFailed`
          mean the footage is not being read, which is a fault with a remedy, and a fault
          behind a disclosure is a fault nobody sees. They render below, in the open, and
          only when they are non-zero.
        */}
        <div className="verdict-tiles">
          {/*
            PAID FIRST, whatever order the grouped query returns. The tiles are not a
            ranking and must not read as one -- this page is about paid posts, and putting
            the ordinary count on the left makes the larger number the headline of a page
            whose subject is the smaller one.
          */}
          {(['CAMPAIGN', 'ORGANIC'] as const)
            .map((verdict) => v.byVerdict.find((r) => r.verdict === verdict))
            .filter((r) => r !== undefined)
            .map((r) => (
              <div className="card card-tint" key={r.verdict}>
                <div className={r.verdict === 'CAMPAIGN' ? 'verdict-n verdict-n-paid' : 'verdict-n'}>{r.count}</div>
                <div className="verdict-l">{verdictLabel(r.verdict)}</div>
              </div>
            ))}
        </div>

        {/*
          THE FUNNEL -- the answer to "356 paid posts, why only 75 messages?", asked
          2026-08-19. Three live counts in one sentence; the REASONS behind them are the
          first thing in the fold, because the chain (a post only names a company when
          Instagram asserts one, many posts name nobody, many name the same company twice)
          is an explanation rather than a number.
        */}
        <p className="funnel-line">
          <strong>From paid posts to messages:</strong> {v.funnel.paidPosts} paid posts have yielded{' '}
          {v.funnel.prospectsLive + v.funnel.retired} companies
          {/*
            THE SECOND CLAUSE ONLY WHEN THE TWO NUMBERS DIFFER. With nothing retired,
            "yielded 477 companies. Of the 477 live companies" prints one figure twice in
            nine words, and a reader who meets the same number twice reads it as two
            different facts and looks for the difference. The moment a company IS retired
            the distinction is real, and the sentence says it.
          */}
          {v.funnel.retired > 0 ? <>. Of the {v.funnel.prospectsLive} live companies,</> : <>, of which</>}{' '}
          <strong>{v.funnel.queued} have a message queued</strong> and {v.funnel.contacted} have already been
          contacted.
        </p>


        {/*
          THE TWO OCR FAULTS, IN THE OPEN. Each is a DIFFERENT problem with a different
          fix, so they render as separate sentences rather than a merged "N not read" --
          the same rule the coverage caveat follows: two problems with two fixes are two
          sentences. Neither is folded: a reader who has to open a disclosure to discover
          that nothing is reading the footage is a reader who never discovers it.
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

        {/*
          THE QUEUE AND THE SETTLED LIST ARE BOTH GONE (2026-08-17).

          There were three lists here — "Worth a look", "Answers you have given", and the
          posts table — and a reader who sees the same post on two of them learns to skip
          both. Tabish: *"no more indecisiveness … no in between or borderline or worth a
          look or manual."*

          One table now. Every post the system calls paid, plus the ones a person has
          crossed off so the cross can be undone, with the control on the row itself.
        */}
        {/* `id` so the pager lands the reader back on the table, not the top of the page. */}
        <section id="posts">
          <h2>The posts</h2>

          {/*
            The filter first, because it decides what the count below it is counting. It
            renders even when the current filter finds nothing — otherwise the only way back
            from an empty channel would be editing the URL.
          */}
          <ChannelFilter options={v.channelOptions} current={v.channelFilter} query={v.searchQuery} />

          {/*
            THE TOTAL IS THE FILTER'S OWN, and it says which filter it belongs to. "0 paid
            posts" and "0 paid posts from @pinkvilla" are different facts, and a page that
            reports the second as the first is the "a metric that covers part of the data must
            say which part" failure with the scope chosen by the reader instead of by us.
          */}
          {v.posts.length === 0 ? (
            <p className="group-blurb">
              {v.searchQuery
                ? `Nothing matching "${v.searchQuery}"${v.channelFilter ? ` from @${v.channelFilter}` : ''} in this window. Clear the box to see the rest.`
                : v.channelFilter
                  ? `No paid post from @${v.channelFilter} in this window. Pick "Every channel" to see the rest.`
                  : 'Nothing judged paid yet.'}
            </p>
          ) : (
            <>
              {/*
                THE TABLE SCROLLS, NOT THE PAGE. Caught by `pnpm ig:layout` at 800px:
                six columns of post, channel, brands and verdict came to 1069px against an
                800px viewport, so the whole document scrolled sideways and the rail went
                with it. Wide content gets its own `overflow-x` container — a body that
                scrolls horizontally moves every other element on the page as collateral.
              */}
              {/*
                ONE BORDERED SURFACE OF HAIRLINE ROWS, which is the design's shape and what a
                <table> could not be. The tracks are a grid shared by the header and every
                row, so a long brand name can never shift one row's columns out of line with
                the next. The panel carries its own `overflow-x` and a min width: six columns
                of post, channel, brand and verdict came to 1069px against an 800px viewport
                once and the whole DOCUMENT scrolled sideways, taking the rail with it.
                Wide content scrolls inside its own container; the page body never does.
              */}
              <div className="rows prows">
                <div className="qhead">
                  {/* "Posted", not "Date" -- the column carries the hour, and the hour is
                      the half that decides whether a verdict looks plausible. */}
                  <span>Posted</span>
                  <span>Channel</span>
                  <span>Brand</span>
                  <span>Verdict</span>
                  {/*
                    Who this post earns a message TO (Tabish, 2026-08-21) -- the verified
                    prospect(s) the system linked to it, via the post's own @mentions and
                    tags or via discovery from an untagged post. The SAME linkage the
                    allowance rule counts, so this column can never disagree with the
                    enforcer about who a paid post unlocks.
                  */}
                  <span>We message</span>
                  {/*
                    AND WHETHER A MESSAGE ACTUALLY WENT OUT FOR IT (Tabish, 2026-08-31:
                    *"nowhere does a person know why that particular message was sent to
                    that person, for which paid post specifically"*).

                    "We message" is who this post EARNS a message to; this is who was
                    written to BECAUSE of it, which is the other half of the same
                    question read from the post's side. Both arms are stored facts and
                    the attribution is a partition, so the column can be added up.
                  */}
                  <span>Message sent</span>
                  {/*
                    THE ACTIONS, at the far edge -- the same place the design puts `open`
                    on a delivered row. The design draws six columns and no controls; the
                    link and the cross are the two things this page cannot lose, because
                    the cross is the ONLY labelling control in the system and a label with
                    no undo is ground truth nobody can correct (21 posts were bulk-labelled
                    `paid=false` in August and were reachable from no screen at all).
                  */}
                  {/* No label: the design's header is six columns, and "open" and the
                      cross are self-describing. An empty span keeps the track. */}
                  <span className="qright" />
                </div>
                {v.posts.map((p) => (
                  <div className="qrow" key={p.shortcode}>
                    {/*
                      Date AND hour. A bare date could not separate a post published in
                      the commercial window from one at 3am, and that distinction is
                      measured rather than assumed: over 14 days @viralbhayani published
                      84 posts before 09:00 IST and not one was paid.

                      `lateness` renders only when detection was far behind publication --
                      on the measured data that means the watch had a GAP, and a post that
                      scrolls out of the 48-post window during one can never be re-scraped.
                      Silent on the common path, because a number on every row is furniture.
                    */}
                    <span className="dim" title={p.postedExact}>
                      {p.postedLabel}
                      {/*
                        Muted, not dressed as an alarm. This is information about ONE
                        post; whether the watch itself is healthy is `assessWatch`'s job
                        and has its own card. A per-row warning colour for something that
                        is not the operator's to act on is how a page teaches people to
                        ignore its colours.
                      */}
                      {p.lateness ? <>{' '}<span className="prow-late">{p.lateness}</span></> : null}
                    </span>
                    <span className="qhandle">@{p.channelHandle}</span>
                    {/*
                      CLIPPED, ON ONE LINE, WITH THE FULL LIST ON THE TITLE. This span had no
                      class at all, so a brand name (or several, comma-joined) longer than the
                      column's own width had nowhere to go but overflow: visible -- it rendered
                      on top of the Verdict cell beside it rather than under it, which is the
                      "paid" text seen overlapping "@pantaloonsfashion". Same fix as the
                      Channel column's `.qhandle` and the Recipients column two cells over.
                    */}
                    <span
                      className="prow-brand"
                      title={p.brands.length > 1 ? p.brands.join(', ') : undefined}
                    >
                      {p.brands.length > 0 ? p.brands.join(', ') : <span className="dim">&mdash;</span>}
                    </span>
                    <span className={`prow-verdict ${p.verdict === 'CAMPAIGN' ? 'prow-paid' : 'dim'}`}>
                      {rowVerdictLabel(p.verdict)}
                      {/*
                        What the model SAW. The caption called this post ordinary and the
                        FOOTAGE disagreed -- which since 2026-08-17 is enough to call it
                        paid, so saying what was read is no longer a nicety.
                      */}
                      {p.frameEvidence ? <span className="dim"> &mdash; from the footage: {p.frameEvidence}</span> : null}
                    </span>
                    <span
                      className="prow-recipients"
                      /*
                        ONE LINE, CLIPPED, WITH THE WHOLE LIST ON THE TITLE. A post can name
                        several companies and wrapped they make the row two or three lines
                        tall, which turns a table of rows into a table of paragraphs. The
                        title is the complete list, so nothing is hidden — only folded onto
                        one line, the way the design draws it.
                      */
                      title={p.recipients.length > 1 ? p.recipients.map((r) => `@${r.handle}`).join(', ') : undefined}
                    >
                      {/* Retired prospects are not listed at all (2026-08-25, Tabish) --
                          filtered in the view model, so nothing here has to decode a
                          state the reader cannot act on. */}
                      {p.recipients.map((r, i) => (
                        <span key={r.handle}>
                          {i > 0 ? ', ' : ''}@{r.handle}
                        </span>
                      ))}
                      {/*
                        NO DISPOSITION LINE (2026-08-25, Tabish): *"I don't want '1 name with
                        no verified account yet', 'nobody named', etc type of nonsensical
                        stuff to be written here ... we need definite targets."* The column is
                        the recipients and nothing else; an em-dash when there are none, so
                        the cell is never blank enough to read as a rendering fault.
                      */}
                      {p.recipients.length === 0 ? <span className="dim">&mdash;</span> : null}
                    </span>
                    <span className="dim">
                      {/*
                        Each line is one real delivered message: the page that sent it, the
                        company, and when. A post that earned a message to somebody the
                        rotation has not reached yet correctly shows an em-dash here while
                        still naming them in "We message" -- those are different facts and
                        the two columns side by side are what make the difference legible.

                        The `title` carries the BASIS in words, because "claimed against
                        this post" and "this post is where we found them" are not the same
                        statement and a reader should be able to tell which one they are
                        looking at without the table growing a fourth column.
                      */}
                      {p.messagesSent.map((m, i) => (
                        <span
                          className="prow-sent"
                          key={`${m.senderHandle}-${m.targetHandle}-${i}`}
                          title={
                            m.basis === 'claimed'
                              ? 'This message was claimed against this paid post — it named the company and nothing had gone out about it yet.'
                              : 'This company was discovered from this paid post, and this was the first message to them.'
                          }
                        >
                          @{m.senderHandle} &rarr; @{m.targetHandle}{' '}
                          {/*
                            A FOLLOW-UP, NAMED (2026-09-01). A first message and a second one
                            to the same company are different facts about this post: the first
                            is an introduction, the second exists BECAUSE this post did and
                            says so in its own words. Rendered only from touch 2 up -- a label
                            on every line is furniture.
                          */}
                          {m.followUp ? <span>&middot; follow-up </span> : null}
                          <span>{m.whenLabel}</span>
                        </span>
                      ))}
                      {/*
                        THE SYNDICATION NOTE (2026-09-04). A row that names a recipient and
                        shows an em-dash here is ambiguous in the one way that matters:
                        "never messaged" and "messaged under the syndicated copy of this
                        campaign" look identical. MEASURED: 61 of 111 such rows over 7 days
                        were the second. The note names the post that carries the message and
                        links to it. The message is NOT listed again here: the column is a
                        partition and must stay one, or it stops adding up.
                      */}
                      {p.messagesSent.length === 0 && p.messagedUnder ? (
                        <span>
                          {/* A bare shortcode read as gibberish to the person the column is for (2026-09-10). */}
                          messaged under{' '}
                          <a href={p.messagedUnder.url} target="_blank" rel="noreferrer" title={`Instagram post ${p.messagedUnder.shortcode}`}>
                            another copy of this post
                          </a>
                        </span>
                      ) : null}
                      {p.messagesSent.length === 0 && !p.messagedUnder ? <span>&mdash;</span> : null}
                    </span>
                    <span className="qright prow-actions">
                      <a href={p.url} target="_blank" rel="noreferrer">
                        open
                      </a>
                      {/* The only labelling control in the system. See dismiss.tsx. */}
                      <DismissButton shortcode={p.shortcode} dismissed={p.dismissed} />
                    </span>
                  </div>
                ))}
              </div>
              {/*
                "A BACK BUTTON TO GO FURTHER BACK" — plain links, matching the history pager
                on /analytics rather than inventing a second idea of paging. The page is
                `force-dynamic`, so a round trip costs what a re-render would have cost, and
                a position in the record stays linkable.

                Newest and Oldest are offered explicitly: at 50 a page and 564 paid posts,
                "the first one we ever judged" is a real question and stepping to it one page
                at a time is not an answer.
              */}
              {/*
                THE TOTAL IS THE FILTER'S OWN, and it says which filter it belongs to. "0 paid
                posts" and "0 paid posts from @pinkvilla" are different facts, and a page that
                reports the second as the first is the "a metric that covers part of the data
                must say which part" failure with the scope chosen by the reader instead of by
                us. It sits UNDER the table with the pager, because that is what it is about —
                above it, it was a line of small print between the design's filter row and the
                rows it describes.
              */}
              {/*
                ONE ROW: the count on the left, the pager on the right. They used to be two
                stacked lines — the count as its own paragraph, the pager in a `<nav>` below
                it with a hand-set `marginTop` — which is the same fact ("where am I in this
                list") split across two places a reader's eye has to visit separately.
                `.posts-pageline` is a single flex row so the two halves share one baseline;
                it wraps on narrow viewports (the pager drops under the count) rather than
                letting `.seg`'s links get crushed against the text.
              */}
              {v.postsPaging.total > 0 || v.postsPaging.pageCount > 1 ? (
                <div className="posts-pageline">
                  {v.postsPaging.total > 0 ? (
                    <p className="cardnote lede posts-pageline-count">
                      {/*
                        `{' '}` before the middot is load-bearing: JSX drops the newline between
                        an expression and the next line's text, and this line rendered
                        "117· newest first" on the served page. Same class as "themunder" and
                        "that wayand are marked" — never rely on an implicit space beside an
                        expression here.

                        The PAGE NUMBER is not repeated here: the pager beside it says
                        "page 1 of 3" in its own words, and a reader who meets the same fact
                        twice in one row reads it as two different facts.
                      */}
                      Showing {v.postsPaging.from}&ndash;{v.postsPaging.to} of {v.postsPaging.total}
                      {v.channelFilter ? <> from @{v.channelFilter}</> : null}
                      {v.searchQuery ? <> matching &ldquo;{v.searchQuery}&rdquo;</> : null}{' '}
                      &middot; newest first
                    </p>
                  ) : null}
                  {v.postsPaging.pageCount > 1 ? (
                    <nav className="seg posts-pageline-pager" aria-label="Paid post pages">
                      {v.postsPaging.page > 1 ? (
                        <>
                          <a href={hrefForPage(1)}>&laquo; Newest</a>
                          <a href={hrefForPage(v.postsPaging.page - 1)}>&lsaquo; Newer</a>
                        </>
                      ) : null}
                      <span className="muted" style={{ padding: '0 8px' }}>
                        page {v.postsPaging.page} of {v.postsPaging.pageCount}
                      </span>
                      {v.postsPaging.page < v.postsPaging.pageCount ? (
                        <>
                          <a href={hrefForPage(v.postsPaging.page + 1)}>Older &rsaquo;</a>
                          <a href={hrefForPage(v.postsPaging.pageCount)}>Oldest &raquo;</a>
                        </>
                      ) : null}
                    </nav>
                  ) : null}
                </div>
              ) : null}
            </>
          )}
        </section>

        {/*
          THE BREAKDOWN AND THE CHANNELS, SIDE BY SIDE: the donut says how the corpus splits,
          the bars say where it came from. Read together they answer "is one channel carrying
          the whole paid count?", which neither shape answers alone.
        */}
        <div className="grid-2">
          <section>
            <h2>Detection breakdown</h2>
            <div className="card card-tint donut-card">
              {/*
                A conic-gradient rather than an SVG arc: three contiguous slices of one whole,
                which is exactly what `conic-gradient` describes and what an arc path makes you
                compute. The hole carries the total, so the chart states its own denominator —
                a ring of proportions with no N is the shape that lets 2 of 3 read as 67%.
              */}
              <div
                className="donut"
                role="img"
                aria-label={`${judged + unjudged} posts: ${paidCount} paid, ${ordinaryCount} ordinary, ${unjudged} not judged`}
                style={{
                  ['--paid-end' as string]: `${paidShare}%`,
                  ['--ordinary-end' as string]: `${paidShare + ordinaryShare}%`,
                }}
              >
                <div className="donut-hole">
                  <span className="donut-n">{judged + unjudged}</span>
                  <span className="donut-l">posts</span>
                </div>
              </div>
              <div className="donut-key">
                <span>
                  <span className="chart-swatch" style={{ background: 'var(--accent)' }} />
                  paid — {paidCount}
                </span>
                <span>
                  <span className="chart-swatch" style={{ background: 'var(--border-strong)' }} />
                  ordinary — {ordinaryCount}
                </span>
                <span>
                  <span className="chart-swatch" style={{ background: 'var(--text-dim)', opacity: 0.55 }} />
                  not judged — {unjudged}
                </span>
              </div>
            </div>
          </section>

          <section>
            <h2>By channel</h2>
            <div className="card card-tint chan-card">
              {v.perChannel.map((c) => (
                <div key={c.handle}>
                  <div className="chan-top">
                    <span>
                      {c.name} <span className="dim">@{c.handle}</span>
                    </span>
                    <span className="n">{c.postsLogged}</span>
                  </div>
                  <div className="chan-track">
                    <span style={{ width: `${channelMax > 0 ? (c.postsLogged / channelMax) * 100 : 0}%` }} />
                  </div>
                  {/*
                    ONE NOTE LINE, which is what the design draws — the two it carries are
                    joined rather than stacked, because a second line under every bar makes
                    the block twice as tall for a clause.

                    The second clause is WHETHER THE JUDGING HAS EVER BEEN CHECKED, per
                    channel, and it is not droppable: the 98% this project quotes belongs to
                    @madovermarketing_mom and is measured on the one channel where the
                    classifier never runs. @bollywoodchronicle has 0 labels across 937 posts,
                    and without this a reader has no way to know that.
                  */}
                  <div
                    className="chan-note"
                    /*
                      THE WHOLE REASON, ON THE TITLE. `readiness().reason` is two sentences —
                      the fault and what to do about it — and set under a 9px bar it wrapped
                      to three lines and made one channel's block twice the height of the
                      other's. The note shows the FAULT; the remedy is on hover, and the
                      same reason is spelled out in full in the coverage note inside the fold
                      at the foot of the page. Nothing is lost by shortening a caption whose
                      full text is two places away.
                    */
                    title={c.unclassified && c.unclassifiedReason ? c.unclassifiedReason : undefined}
                  >
                    {c.unclassified
                      ? `not classified${c.unclassifiedReason ? `: ${firstSentence(c.unclassifiedReason)}` : ''}`
                      : `${c.campaignsThisWeek} paid this week`}
                    {c.accuracyNote ? ` · ${c.accuracyNote}` : ''}
                  </div>
                </div>
              ))}
              {v.perChannel.length === 0 ? <p className="empty">No channel is being watched.</p> : null}
            </div>
          </section>
        </div>

        {/*
          Brands sit below the verdicts because a brand is what judging PRODUCED: a paid post
          names its buyer, and that buyer is a company demonstrably spending on placement.
        */}
        <BrandsPanelView brands={v.brands} />

        <details className="fold">
          <summary>How these numbers were arrived at</summary>
          {/*
            The coverage caveat travels with any figure it qualifies. See the note on Today --
            "a metric that covers part of the data must say which part". It is one click from
            the figures rather than above them, because it qualifies EVERY number in this
            fold as well as the two tiles.
          */}
          <CoverageNote detection={v.detection} channelCount={v.perChannel.length} showLink={false} />

          {/*
            Every figure is scoped to the detection window, and the window is NAMED.
            This block used to count the whole corpus, so it reported ~370 posts as "not
            judged" -- all of it pre-cutoff history the classifier is deliberately never
            asked to read. On a screen where "not judged" means a job to do, that was a
            permanent backlog nobody could clear. Inside the window the number is real.
          */}
          <p className="prose">
            {unjudged === 0 ? (
              <>
                All {judged} posts since {v.since.toLocaleDateString('en-GB', { day: 'numeric', month: 'long' })} have a
                verdict.
              </>
            ) : (
              <>
                {judged} of {judged + unjudged} posts since{' '}
                {v.since.toLocaleDateString('en-GB', { day: 'numeric', month: 'long' })} have a verdict. The other{' '}
                {unjudged} are <strong>not judged</strong>, which has never meant organic &mdash; a post nobody
                classified and a post classified as ordinary are different facts.
              </>
            )}
          </p>

          <p className="prose">
            A post only names a company when Instagram itself asserts one (caption @mentions and tags), many posts
            name nobody, and many name the same company twice. {v.funnel.retired} were retired as people or our own
            pages. The rest of the live companies are held by the person guard or spacing. A message is written
            within 15 minutes of a company being identified.
          </p>

          {/*
            Said once, quietly, rather than counted as outstanding work: the older corpus
            is what the free hashtag filter learns each channel's normal vocabulary from,
            so it is kept on purpose and is not a task.
          */}
          {v.storedBeforeCutoff > 0 && (
            <p className="prose">
              {v.storedBeforeCutoff}{' '}
              older posts are also stored. They are not judged by design &mdash; they are what the
              classifier learns each channel&rsquo;s normal vocabulary from.
            </p>
          )}

          {/*
            The footage reports SEPARATELY from caption verdicts: a flagged frame asked a
            person to look, it did not decide anything, and folding it into "paid" would
            count a judgement nobody made.
          */}
          <p className="prose">
            {v.framesRead}{' '}
            posts had the text in their video read as well as their caption &mdash; a paid placement can
            sit in the footage under an ordinary caption.
            {/* {' '} throughout: the served HTML dropped the spaces around the <strong> --
                "that wayand are marked" reached the live page (Tabish's screenshot,
                2026-09-01). Same class as "themunder"; never rely on an implicit space
                beside an element or expression here. */}
            {v.frameFlagged > 0 ? (
              <>
                {' '}
                <strong>{v.frameFlagged} were flagged that way</strong>
                {' '}
                and are marked &ldquo;from the footage&rdquo; below.
              </>
            ) : null}
          </p>

          {v.framesNotSaved > 0 ? (
            <p className="prose">
              {v.framesNotSaved}{' '}posts have no frame at all. Frames are saved when a post is first seen, and the
              link they come from expires &mdash; older posts never had one and cannot get one now.
            </p>
          ) : null}
        </details>

        {/*
          HOW WELL THE JUDGING IS DOING, from the runs the harness already stored.
          `accuracyHistory` has held every run since 2026-08-13 and NOTHING rendered it — a
          measurement taken 30 times and never once shown, which is the same shape as the 166
          cover frames saved in a day and never read. It is still rendered; it is now one
          click down, because it answers a question about the WHOLE table rather than about
          anything on today's screen, and the design ends this page on the brands.
        */}
        <details className="fold">
          <summary>How accurate the judging is</summary>
          <AccuracyTrendPanel trend={accuracy} />
        </details>
      </div>
    </>
  )
}

/**
 * The first sentence of a reason, for a caption slot one line tall.
 *
 * PURE and deliberately dumb: it splits on a full stop followed by a space, so a reason
 * that is already one sentence comes back unchanged and one that is two comes back as its
 * first. It is never the only place the text appears — the caller puts the whole string on
 * the element's `title`, and the coverage note carries it in full — so a bad split costs a
 * clipped caption rather than a fact.
 */
function firstSentence(text: string): string {
  const cut = text.indexOf('. ')
  return cut === -1 ? text : text.slice(0, cut + 1)
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

/**
 * The same verdict, worded for ONE post rather than for a tile counting many.
 *
 * `verdictLabel` reads right on the summary tile ("226 ordinary posts") and wrong on a
 * table row, which is about a single post: "ordinary posts" repeated once per row read
 * like a typo, plural where the sentence has no plural in it. "not judged" carries over
 * unchanged — it already reads correctly at either count.
 */
function rowVerdictLabel(verdict: string): string {
  return verdict === 'ORGANIC' ? 'ordinary' : verdictLabel(verdict)
}
