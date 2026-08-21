import Link from 'next/link'
import { redirect } from 'next/navigation'
import { currentUser } from '@/lib/session'
import { buildTodayView } from '../view-model'
import { buildConversationsPage } from '../view-model/conversations-page'
import { buildAnalyticsCharts } from '../view-model/charts'
import { CoverageNote } from '../coverage'
import { SentList } from '../messages/sent'
import { buildSentHistory } from '../view-model/sent-history'
import { ExportPanel } from './export-panel'
import { prisma } from '@/lib/db'
import { fleetUsage } from '@/outreach/reservations'
import { DELIVERED_STATUSES } from '@/lib/constants'
import { Nav } from '../nav'
import { PageHead } from '../page-head'
import { AutoRefresh } from '../auto-refresh'
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

/**
 * A `?from=` sender filter is a URL anyone can type, and it reaches a Prisma `where`.
 * Shape-checked here rather than trusted: the same reasoning as `assertSafeHandle` on the
 * add path, and as `OVERRIDABLE_BLOCKS` being a closed whitelist rather than caller strings.
 * An unparseable value becomes "no filter", never an error page.
 */
function senderHandleLooksReal(v: string): boolean {
  return /^[a-z0-9._]{1,40}$/i.test(v)
}

const VERDICT_SERIES: Series[] = [
  { key: 'paid', label: 'Paid', color: 'var(--ac)' },
  { key: 'ordinary', label: 'Ordinary', color: 'var(--idle)' },
  { key: 'borderline', label: 'Worth a look', color: 'var(--warn)' },
  { key: 'unjudged', label: 'Not judged', color: 'var(--ln-2)', outline: true },
]

export default async function AnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string; sent?: string; from?: string }>
}) {
  const user = await currentUser()
  if (!user) redirect('/sign-in')

  const { range, sent, from } = await searchParams
  const picked = RANGES.find((r) => r.key === range) ?? RANGES[1]

  /**
   * THE HISTORY'S POSITION LIVES IN THE URL (2026-08-21, Tabish: "an ability to go even
   * beyond"). `sent` is the page, `from` an optional sender filter. Both are strings anyone
   * can type, so both are parsed defensively and `buildSentHistory` clamps the page into
   * range — an out-of-range `?sent=999` must show the last page, never an empty table.
   */
  const sentPage = Number.parseInt(sent ?? '1', 10)
  const senderFilter = from && senderHandleLooksReal(from) ? from : null

  const [v, c, charts, usage, history, senderRows, sentBySender, repliedBySender] = await Promise.all([
    buildTodayView(),
    buildConversationsPage(),
    buildAnalyticsCharts(picked.days),
    /**
     * TODAY'S TOTAL, from the function the PACING GUARD reads (2026-08-20).
     *
     * Every figure in the grid below is a rolling SEVEN DAYS, and "messages sent" under a
     * heading like this one reads as an answer to "how many went out today" — so on a day
     * with 59 sends the page showed a larger number that was not that, and the real one
     * appeared nowhere in the product. Two different questions, one of which nobody could
     * ask the dashboard.
     *
     * `fleetUsage` rather than a count written here: this page must not report the day by a
     * different rule than the dispatcher, and the IST boundary is the part that is easy to
     * get wrong (the Linode is not on IST). Two cheap counts, inside the existing Promise.all.
     */
    fleetUsage(),
    /* The whole delivered history, a page at a time — see view-model/sent-history.ts. */
    buildSentHistory({ page: Number.isFinite(sentPage) ? sentPage : 1, senderHandle: senderFilter }),
    prisma.senderAccount.findMany({ orderBy: { handle: 'asc' }, select: { id: true, handle: true } }),
    /**
     * PER-ACCOUNT SENT AND REPLIED (2026-08-19, Tabish: "clearly see the amount of messages
     * sent to which channels, how many have replied"). Two group-bys, lifetime: which of our
     * pages has done how much, and how much came back. Per-RECIPIENT detail is the recent
     * list below and the CSV export; this is the per-SENDER view that had no home.
     */
    prisma.outreachAttempt.groupBy({
      by: ['senderId'],
      where: { status: { in: [...DELIVERED_STATUSES] } },
      _count: { _all: true },
    }),
    prisma.outreachAttempt.groupBy({
      by: ['senderId'],
      where: { repliedAt: { not: null } },
      _count: { _all: true },
    }),
  ])
  const senderHandles = senderRows.map((s) => s.handle)

  const sentById = new Map(sentBySender.map((r) => [r.senderId, r._count._all]))
  const repliedById = new Map(repliedBySender.map((r) => [r.senderId, r._count._all]))
  const perAccount = senderRows
    .map((s) => ({ handle: s.handle, sent: sentById.get(s.id) ?? 0, replied: repliedById.get(s.id) ?? 0 }))
    .filter((r) => r.sent > 0)
    .sort((a, b) => b.sent - a.sent)

  /* Null, not 0%: "nothing sent" and "nobody replied" are different facts. */
  const replyRate = v.week.sent > 0 ? Math.round((v.week.replies / v.week.sent) * 100) : null

  return (
    <>
      <Nav current="/analytics" email={user.email} />
      {/* Sends land every minute; keep the counts fresh without a manual reload. */}
      <AutoRefresh seconds={45} />
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
          {/*
            EVERY STAT ABOVE IS SEVEN DAYS, AND TODAY IS STATED SEPARATELY.

            One sentence rather than a fifth tile: `.grid-4` is a hard `repeat(4, 1fr)` that
            cannot collapse, so a fifth column would scroll the page sideways at 800px — the
            defect `pnpm ig:layout` caught on `.grid-2` and the history table. It is also the
            cheaper answer to numeral bloat: this page was halved once by removing figures.

            `{' '}` between every expression and the following text, because a text node that
            CONTINUES onto the next line loses the space — five instances of that have reached
            a live dashboard here ("768requests", "16 companys", "watch2 channels").
          */}
          <p className="blurb">
            Last 7 days. Since midnight IST, <strong>{usage.today}</strong>{' '}
            {usage.today === 1 ? 'message has' : 'messages have'} gone out
            {/* Only when it is a SUBSET: "1 message has gone out, 1 of them in this hour" is
                what reading the rendered line looks like otherwise — clumsy at 1, and simply
                redundant whenever the hour and the day are the same number. */}
            {usage.thisHour > 0 && usage.thisHour < usage.today ? (
              <>, {usage.thisHour} of them in this hour</>
            ) : null}
            .
          </p>

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

        {perAccount.length > 0 && (
          <section>
            <h2>Messages sent, by account</h2>
            <p className="blurb">
              Lifetime, per sending page: how many have gone out and how many came back. Per-recipient detail is
              the recent list below and the CSV export.
            </p>
            <table className="table">
              <thead>
                <tr>
                  <th>From account</th>
                  <th>Sent</th>
                  <th>Replied</th>
                </tr>
              </thead>
              <tbody>
                {perAccount.map((r) => (
                  <tr key={r.handle}>
                    <td>@{r.handle}</td>
                    <td>{r.sent}</td>
                    <td>{r.replied > 0 ? <span className="note-good">{r.replied}</span> : 0}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}

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
                      {/*
                        THE DAY'S REAL TOTAL, BESIDE ITS HEADING (2026-08-21).

                        The feed reads `take: 40` across 14 days. On a night the fleet
                        delivered 280 messages the oldest visible row was 07:51 — the
                        40th-newest — and it read as the first send of the day. Every number
                        on the page was right; the truncation was the thing that lied,
                        because nothing said the list was a window. A capped list must
                        announce its cap where the cap is visible.
                      */}
                      {day.total > day.shown ? (
                        <span className="muted" style={{ marginLeft: 'auto' }}>
                          newest {day.shown} shown of <strong>{day.total}</strong> sent
                        </span>
                      ) : null}
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

        {/* `id` so the pager's `#history` lands the reader back on the table, not the page top. */}
        <section id="history">
          <SentList
            recent={history.rows}
            paging={{
              page: history.page,
              pageCount: history.pageCount,
              total: history.total,
              from: history.from,
              to: history.to,
              /* The range selector must survive paging, and vice versa. */
              hrefForPage: (n) =>
                `/analytics?range=${picked.key}${history.senderHandle ? `&from=${history.senderHandle}` : ''}&sent=${n}#history`,
            }}
          />
        </section>
      </div>
    </>
  )
}
