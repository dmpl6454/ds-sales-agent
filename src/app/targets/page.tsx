import { redirect } from 'next/navigation'
import { currentUser } from '@/lib/session'
import { buildProspectsPage } from '../view-model/prospects-page'
import { buildChannelsView } from '../view-model'
import { Nav } from '../nav'
import { PageHead } from '../page-head'
import { ImportForm } from '../prospects/import-form'
import { ProspectList } from '../prospects/list'
import { ChannelsPanel } from '../channels'

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

  const [v, ch] = await Promise.all([buildProspectsPage(), buildChannelsView()])

  return (
    <>
      <Nav current="/targets" email={user.email} />
      <div className="page">
        <PageHead
          title="Targets"
          sub={`${v.prospects.length} in the list · ${v.watched} whose posts we read`}
        />

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
          Tabish: confusing). The Category machinery in `src/outreach/categories.ts` is
          intact and behaviour is unchanged — the table has always been empty, and a
          target in no category is considered pair-by-pair, which is what happens today.
        */}
        <ImportForm />
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
