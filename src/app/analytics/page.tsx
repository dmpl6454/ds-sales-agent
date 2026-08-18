import Link from 'next/link'
import { redirect } from 'next/navigation'
import { currentUser } from '@/lib/session'
import { buildTodayView } from '../view-model'
import { buildConversationsPage } from '../view-model/conversations-page'
import { buildAnalyticsCharts } from '../view-model/charts'
import { CoverageNote } from '../coverage'
import { SentList } from '../messages/sent'
import { ExportPanel } from './export-panel'
import { prisma } from '@/lib/db'
import { Nav } from '../nav'
import { PageHead } from '../page-head'
import { StackedBars, RunStrip, Funnel, WatchWindow, type Series } from '../charts'

export const dynamic = 'force-dynamic'

/**
 * `/analytics` — is it working.
 *
 * Nothing here is a control: this page REPORTS, Autopilot acts. That split is the reason
 * the page can be read quickly — there is no decision to make on it, so nothing has to
 * carry the argument for its own value.
 *
 * ── THE VERDICT SERIES IS THE ONE TO GET RIGHT ──────────────────────────────
 *
 * Four series, and the fourth is `not judged` — drawn as a dashed outline rather than a
 * fill, because it is an ABSENCE and not a quantity of anything. Giving it a solid colour
 * would put it in the same visual class as the three verdicts it is explicitly not one of,
 * and this system has already recorded 76 never-read posts as ORGANIC once: a positive
 * claim that a publisher was not paid, about posts nothing had looked at.
 */

const RANGES = [
  { key: '7d', label: '7 days', days: 7 },
  { key: '30d', label: '30 days', days: 30 },
  { key: '90d', label: '90 days', days: 90 },
] as const

const VERDICT_SERIES: Series[] = [
  { key: 'paid', label: 'Paid', color: 'var(--ac)' },
  { key: 'ordinary', label: 'Ordinary', color: 'var(--idle)' },
  { key: 'borderline', label: 'Worth a look', color: 'var(--warn)' },
  { key: 'unjudged', label: 'Not judged', color: 'var(--ln-2)', outline: true },
]

export default async function AnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string }>
}) {
  const user = await currentUser()
  if (!user) redirect('/sign-in')

  const { range } = await searchParams
  const picked = RANGES.find((r) => r.key === range) ?? RANGES[1]

  const [v, c, charts, senderRows] = await Promise.all([
    buildTodayView(),
    buildConversationsPage(),
    buildAnalyticsCharts(picked.days),
    prisma.senderAccount.findMany({ orderBy: { handle: 'asc' }, select: { handle: true } }),
  ])
  const senderHandles = senderRows.map((s) => s.handle)

  /* Null, not 0%: "nothing sent" and "nobody replied" are different facts. */
  const replyRate = v.week.sent > 0 ? Math.round((v.week.replies / v.week.sent) * 100) : null

  return (
    <>
      <Nav current="/analytics" email={user.email} />
      <div className="page">
        <PageHead title="Analytics" sub="Last 7 days, and the whole history underneath." />

        <section>
          <div className="grid-4">
            <div className="stat">
              <span className="stat-n">{v.week.detected}</span>
              <span className="stat-l">paid campaigns spotted</span>
            </div>
            <div className="stat">
              <span className="stat-n">{v.week.sent}</span>
              <span className="stat-l">messages sent</span>
            </div>
            <div className="stat">
              <span className="stat-n">{v.week.replies}</span>
              <span className="stat-l">replies</span>
            </div>
            <div className="stat">
              <span className="stat-n">{replyRate === null ? '—' : `${replyRate}%`}</span>
              <span className="stat-l">reply rate</span>
            </div>
          </div>
          <p className="blurb">Last 7 days.</p>

          {/* The qualifier travels with the number it qualifies, always. */}
          <CoverageNote detection={v.detection} channelCount={v.channelCount} showLink />

          {/*
            THE REPLY RATE IS AN UPPER BOUND AND MUST SAY SO. It is computed over messages
            we have sent, but a reply is only known about if somebody read the thread — and
            reply checking is capped. A thread never read reports "no reply", which is
            indistinguishable from silence and quietly flatters this number.
          */}
          {c.coverage.open > 0 && c.coverage.neverChecked > 0 ? (
            <p className="reason reason-warn">
              <strong>Read as an upper bound.</strong> {c.coverage.neverChecked} of{' '}
              {c.coverage.open} open conversations have never been read, so a reply in one of
              them would not be counted here yet.
            </p>
          ) : null}
        </section>

        <section>
          <div className="sec-head">
            <h2>What detection found</h2>
            {/*
              Plain links, not a client control. The page is `force-dynamic` anyway, so a
              round trip costs what a re-render would have cost, and this way the range
              survives a refresh and can be linked to.
            */}
            <nav className="seg" aria-label="Range">
              {RANGES.map((r) => (
                <Link
                  key={r.key}
                  href={`/analytics?range=${r.key}`}
                  aria-current={r.key === picked.key ? 'page' : undefined}
                  className={r.key === picked.key ? 'seg-on' : undefined}
                >
                  {r.label}
                </Link>
              ))}
            </nav>
          </div>

          {charts.verdicts.any ? (
            <StackedBars
              series={VERDICT_SERIES}
              buckets={charts.verdicts.buckets}
              caption="Posts per day, by what we decided"
              description={`${picked.label} · "not judged" is drawn as an outline because it is not a verdict`}
              labelEvery={picked.days > 30 ? 7 : 3}
            />
          ) : (
            <p className="empty">
              No posts have been stored in this window yet, so there is nothing to plot.
            </p>
          )}
        </section>

        <section className="grid-2">
          <Funnel
            steps={charts.funnel.steps}
            caption="Written → replied"
            description={`${picked.label} · what was lost at each step`}
          />
          <WatchWindow {...charts.watch} />
        </section>

        <section>
          <RunStrip
            runs={charts.runs}
            caption="Every detection run"
            description="One cell per run, oldest first. A single sample cannot show a trend, which is why this is a strip."
          />
        </section>

        <section className="grid-2">
          <div>
            <h2>Open conversations ({c.open.length})</h2>
            {c.coverage.open > 0 && (
              <div className="grid-4" style={{ margin: '12px 0' }}>
                <div className="stat">
                  <span className="stat-n">{c.coverage.open}</span>
                  <span className="stat-l">open threads</span>
                </div>
                <div className={c.coverage.neverChecked > 0 ? 'stat stat-bad' : 'stat'}>
                  <span className="stat-n">{c.coverage.neverChecked}</span>
                  <span className="stat-l">never read</span>
                </div>
                <div className="stat">
                  <span className="stat-n">{c.coverage.stale}</span>
                  <span className="stat-l">not read in a day</span>
                </div>
                <div className="stat">
                  <span className="stat-n">
                    {c.coverage.oldestHours === null ? '—' : `${c.coverage.oldestHours}h`}
                  </span>
                  <span className="stat-l">since the oldest read</span>
                </div>
              </div>
            )}
            {c.open.length === 0 ? (
              <p className="empty">No conversations are open.</p>
            ) : (
              <div className="rows">
                {c.open.map((o) => (
                  <div className="rowitem" key={`${o.senderHandle}-${o.targetHandle}`}>
                    <div style={{ minWidth: 0 }}>
                      <p style={{ margin: 0 }}>
                        <a href={o.profileUrl} target="_blank" rel="noreferrer">
                          {o.targetName}
                        </a>
                      </p>
                      <p className="blurb" style={{ margin: '1px 0 0' }}>
                        @{o.targetHandle} · from @{o.senderHandle} · {o.sentCount} sent · last sent{' '}
                        {o.lastSentLabel}
                      </p>
                    </div>
                    {/* "Never read" and "read a while ago" are different facts; only the
                        exception gets a pill. */}
                    <span style={{ marginLeft: 'auto' }}>
                      {o.lastReadLabel === null ? (
                        <span className="pill pill-warn">never read</span>
                      ) : (
                        <span className="muted">read {o.lastReadLabel}</span>
                      )}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div>
            <h2>What happened</h2>
            {v.activity.length === 0 ? (
              <p className="empty">Nothing has been sent yet.</p>
            ) : (
              <div className="rows">
                {v.activity.map((day) => (
                  <div key={day.dayLabel}>
                    <div className="rowitem" style={{ paddingBottom: 4 }}>
                      <span className="eyebrow">{day.dayLabel}</span>
                    </div>
                    {day.events.map((e, i) => (
                      <div className="rowitem" key={i} style={{ paddingTop: 4, paddingBottom: 4, borderTop: 0 }}>
                        <span className="mono dim" style={{ width: 52, flex: '0 0 auto' }}>
                          {e.timeLabel}
                        </span>
                        <span className={e.kind === 'reply' ? 'note-good' : 'muted'}>{e.sentence}</span>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>

        {c.handled.length > 0 && (
          <section>
            <h2>Replies handled</h2>
            <p className="blurb">
              Handling a reply stops it counting against the halt. It does not erase it.
            </p>
            <div className="rows">
              {c.handled.map((h, i) => (
                <div className="rowitem" key={`${h.targetHandle}-${i}`}>
                  <div>
                    <p style={{ margin: 0 }}>{h.targetName}</p>
                    <p className="blurb" style={{ margin: '1px 0 0' }}>
                      @{h.targetHandle} · replied {h.whenLabel}
                      {h.preview ? ` — “${h.preview}”` : ''}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

        <ExportPanel senders={senderHandles} />

        <section>
          <SentList recent={c.recent} />
        </section>
      </div>
    </>
  )
}
