import { redirect } from 'next/navigation'
import { currentUser } from '@/lib/session'
import { buildProspectsPage } from '../view-model/prospects-page'
import { buildRestTally } from '../view-model/rest-tally'
import { buildChannelsView } from '../view-model'
import { Nav } from '../nav'
import { PageHead } from '../page-head'
import { AddTargetsForm } from '../prospects/add-targets-form'
import { ProspectList } from '../prospects/list'
import { RestTile } from '../rest-band'
import { ChannelsPanel } from '../channels'
import { listCategories } from '@/outreach/categories'
import { DETECT_INTERVAL_MINUTES } from '@/detection/cadence'

export const dynamic = 'force-dynamic'

/**
 * `/targets` — who we write to, and whose posts we read. The simple-sender redesign
 * folded `/channels` and `/prospects` together: a channel is a target we also watch,
 * not a different kind of thing.
 *
 * The LIST is the master view — a row per target with its rotation group, watch toggle
 * and route count. The CARDS below answer the narrower question "is reading their feed
 * working", which is about the watch and never about outreach: detection never stops a
 * message being prepared. Rationale prose (watch cost, rotation) is on /rules.
 */
export default async function TargetsPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string; q?: string }>
}) {
  const user = await currentUser()
  if (!user) redirect('/sign-in')
  /* Both are strings anyone can type; the builder clamps the page and bounds the term. */
  const { page, q } = await searchParams
  const pageNumber = Number.parseInt(page ?? '1', 10)

  const [v, ch, rest, fleets] = await Promise.all([
    buildProspectsPage({ page: Number.isFinite(pageNumber) ? pageNumber : 1, query: q ?? null }),
    buildChannelsView(),
    buildRestTally(),
    /* Read on the SERVER: `ChannelsPanel` is a client component, and a query reachable from
       the browser bundle is the waiting.tsx -> gate.ts -> better-sqlite3 trap. */
    listCategories(),
  ])
  const hrefForPage = (n: number) => `/targets?${v.query ? `q=${encodeURIComponent(v.query)}&` : ''}page=${n}#prospects`

  return (
    <>
      <Nav current="/targets" email={user.email} />
      <div className="page">
        <PageHead
          title="Targets"
          sub={`${v.paging.total} we message · ${v.watched} whose posts we read`}
        />

        {/*
          HOW MANY OF THIS LIST WE CANNOT WRITE TO TODAY, and why (2026-08-24, Tabish: "a user
          does not know how many targets are on hold from total"). It sits directly under the
          count in the subtitle, because "471 in the list" and "469 of them resting" are the two
          halves of one fact, and reading the first without the second is what made the list look
          like capacity it does not have.
        */}
        <RestTile tally={rest} />

        {/*
          A TREND, not the last sample — a channel failing every slot for two days must not
          read like one unlucky fetch.
        */}
        {ch.degradedRuns > 0 ? (
          <p className="reason">
            <strong>
              {ch.degradedRuns} check{ch.degradedRuns === 1 ? '' : 's'} in the last two days could not read every
              channel.
            </strong>{' '}
            Posts from the channels that did respond were still recorded, and outreach is unaffected. The failing
            channel shows on its card below.
          </p>
        ) : null}

        {/*
          The "Rotation groups" section and the per-row group input are GONE (2026-08-07,
          Tabish: confusing). That was a fair call about a confusing control, and the note
          left in its place — *"behaviour is unchanged — the table has always been empty, and
          a target in no category is considered pair-by-pair, which is what happens today"* —
          was TRUE THEN and stopped being true twice: on 2026-08-08 when pair rows became live
          routes, and on 2026-08-12 when brand discovery created 59 recipients. Considered
          pair-by-pair had come to mean every account writing to every recipient.

          Since 2026-08-13 a recipient in no group is rotated through the FLEET, so there is
          nothing an operator must set up and no empty table to explain. Each row below names
          the one account that writes next.
        */}
        {/*
          ── THE READING ORDER IS THE MOCKUP'S, AND IT IS THE RIGHT ONE ──────────

          Add, then the pages we WATCH, then the companies we MESSAGE. The watched pages come
          first because they are where every company below them came from: a reader who meets
          477 companies with no explanation of their provenance has to go looking for it, and
          the answer is the two-row list directly above.

          It is also the safer order to read. The watch list is the one place a wrong row is
          expensive — a mistyped handle there mints real prospects who get real DMs — and it is
          two rows against four hundred, so burying it under the long list is how it goes
          unchecked.
        */}
        <AddTargetsForm />

        {/*
          WHAT WATCHING COSTS, PER DAY.

          `requestsPerSlot` was computed by the view model and rendered nowhere, while
          CLAUDE.md claimed this page showed it. Per-slot is also the wrong unit: detection
          moved to its own 15-minute clock on 2026-08-07, so a slot figure understates the
          real load 24×. The risk this number exists to make visible is a 429 that blinds
          detection entirely, and that is a function of requests per day.
        */}
        {/*
          `{' '}` after the number is load-bearing and was MEASURED, not guessed. Without it
          the served HTML reads `768<!-- -->requests a day` — the space between the expression
          and the word vanishes, even though the source has one and they sit on the SAME line.
          What decides it is that the text node CONTINUES onto the next line: a single-line
          text node keeps its edges (`costs about ` survives), a multi-line one loses its
          leading space. CLAUDE.md records this trap as "an expression and the NEXT line's
          text"; this instance is narrower and easier to miss, and the same paragraph already
          used `{' '}` correctly two words later. Read the rendered bytes, not the JSX.
        */}
        <p className="page-meta">
          Reading {v.watched} feed{v.watched === 1 ? '' : 's'} costs about {v.requestsPerDay.toLocaleString()}{' '}
          requests a day against Instagram&rsquo;s anonymous endpoint ({v.requestsPerSlot} per check, every{' '}
          {DETECT_INTERVAL_MINUTES} minutes). Nothing here is logged in; the only risk is being rate-limited, and a
          rate limit stops detection finding anything at all.
        </p>
        {/*
          `sendersAble` is resolved HERE, on the server, and passed down. `list.tsx` is
          `'use client'`, and the count needs `profileStatus` (a credential-directory read) and
          Prisma — importing either from a client module pulls `better-sqlite3` into the browser
          bundle and returns HTTP 500 on every route, with typecheck passing throughout.
        */}
        {/*
          SEARCH AND PAGE (2026-09-04): ~900 companies is not a list a person scrolls; it is a
          list a person searches. A GET form with state in the URL — same shape as /paid-posts —
          so a position survives a refresh and can be pasted. No hidden page: a new question
          starts at the first page.
        */}
        <form method="get" action="/targets" className="channel-filter" id="prospects">
          <input
            id="prospect-search"
            name="q"
            type="search"
            defaultValue={v.query ?? ''}
            placeholder="Find a company — handle or name"
            style={{ flex: '1 1 16rem', maxWidth: '26rem' }}
          />{' '}
          <button type="submit" className="muted">
            Show
          </button>
          {v.query ? (
            <span className="muted">
              {' '}
              {v.paging.total} matching &ldquo;{v.query}&rdquo; &middot; <a href="/targets#prospects">clear</a>
            </span>
          ) : null}
        </form>
        {/*
          NO HEADING OF MY OWN ON `ProspectList`. It already emits the mockup's two
          sections — "Pages we watch (N)" and "Companies we message (N)" — verbatim, and
          wrapping it in a section of the same name would render each heading twice.

          ── `ChannelsPanel` MOVED BELOW IT, FOLDED (2026-09-21) ─────────────────────

          It used to sit HERE, open, with its own "Channels we watch" heading — so the page
          read Add → Channels we watch (2, with Remove buttons) → Pages we watch (2, the
          identical two handles, no buttons) → Companies we message. Two headings for one
          fact is the duplication this file's own comment warns against one line up; it
          just was not looking at this pair when it said so.

          The mockup has ONE watch list. `ProspectList`'s "Pages we watch" is line-for-line
          it — the reading a person gets by default now matches. `ChannelsPanel` is the only
          place a WATCH page can be individually removed (retiring one with history asks a
          confirmation `AddTargetsForm` has no field for), so it is folded rather than
          deleted: every control survives, one click away, the way the Autopilot page already
          folds its template editors below the mockup's own content instead of before it.
        */}
        <ProspectList
          prospects={v.prospects}
          sendersAble={v.sendersAble}
          messagedTotal={v.paging.total}
          /* `ch` is already loaded above for the folded `ChannelsPanel` — the watch
             row's own "N posts read this week · M paid this week" reuses it rather
             than asking the same counts twice. */
          channels={ch.channels}
        />
        <details className="fold">
          <summary>Add a channel one at a time, or remove one</summary>
          <ChannelsPanel channels={ch.channels} fleets={fleets.map((f) => ({ slug: f.slug, name: f.name }))} />
        </details>
        {v.paging.pageCount > 1 ? (
          <p className="muted">
            Showing {v.paging.from}&ndash;{v.paging.to} of {v.paging.total} &middot; page {v.paging.page} of{' '}
            {v.paging.pageCount}{' '}
            {v.paging.page > 1 ? (
              <>
                &middot; <a href={hrefForPage(1)}>&laquo; First</a> <a href={hrefForPage(v.paging.page - 1)}>&lsaquo; Previous</a>{' '}
              </>
            ) : null}
            {v.paging.page < v.paging.pageCount ? (
              <>
                &middot; <a href={hrefForPage(v.paging.page + 1)}>Next &rsaquo;</a> <a href={hrefForPage(v.paging.pageCount)}>Last &raquo;</a>
              </>
            ) : null}
          </p>
        ) : null}
      </div>
    </>
  )
}
