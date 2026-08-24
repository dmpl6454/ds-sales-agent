import { redirect } from 'next/navigation'
import { currentUser } from '@/lib/session'
import { buildProspectsPage } from '../view-model/prospects-page'
import { buildRestTally } from '../view-model/rest-tally'
import { buildChannelsView } from '../view-model'
import { Nav } from '../nav'
import { PageHead } from '../page-head'
import { ImportForm } from '../prospects/import-form'
import { ProspectList } from '../prospects/list'
import { RestBand } from '../rest-band'
import { ChannelsPanel } from '../channels'
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
export default async function TargetsPage() {
  const user = await currentUser()
  if (!user) redirect('/sign-in')

  const [v, ch, rest] = await Promise.all([buildProspectsPage(), buildChannelsView(), buildRestTally()])

  return (
    <>
      <Nav current="/targets" email={user.email} />
      <div className="page">
        <PageHead
          title="Targets"
          sub={`${v.prospects.length} in the list · ${v.watched} whose posts we read`}
        />

        {/*
          HOW MANY OF THIS LIST WE CANNOT WRITE TO TODAY, and why (2026-08-24, Tabish: "a user
          does not know how many targets are on hold from total"). It sits directly under the
          count in the subtitle, because "471 in the list" and "469 of them resting" are the two
          halves of one fact, and reading the first without the second is what made the list look
          like capacity it does not have.
        */}
        <RestBand tally={rest} />

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
        <ImportForm />

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
        <ProspectList prospects={v.prospects} sendersAble={v.sendersAble} />

        <section>
          <h2>Reading their feeds</h2>
          <p className="page-meta">
            {ch.lastCheckLabel} · {ch.nextSlotLabel}
          </p>
          <ChannelsPanel channels={ch.channels} />
        </section>
      </div>
    </>
  )
}
