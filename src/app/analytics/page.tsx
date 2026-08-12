import { redirect } from 'next/navigation'
import { currentUser } from '@/lib/session'
import { buildTodayView } from '../view-model'
import { buildConversationsPage } from '../view-model/conversations-page'
import { CoverageNote } from '../coverage'
import { SentList } from '../messages/sent'
import { Nav } from '../nav'

export const dynamic = 'force-dynamic'

/**
 * `/analytics` — is it working. The numbers that used to open the old Today page, the
 * activity feed, and the delivered history that lived on Conversations. Nothing here is
 * a control: this page reports, Autopilot acts.
 */
export default async function AnalyticsPage() {
  const user = await currentUser()
  if (!user) redirect('/sign-in')

  const [v, c] = await Promise.all([buildTodayView(), buildConversationsPage()])
  const replyRate = v.week.sent > 0 ? Math.round((v.week.replies / v.week.sent) * 100) : null

  return (
    <>
      <Nav current="/analytics" email={user.email} />
      <div className="page">
        <header className="page-head">
          <h1>Analytics</h1>
          <p className="page-sub">Last 7 days, and the whole history underneath.</p>
        </header>

        <section className="metrics">
          <div className="metric">
            <div className="n">{v.week.detected}</div>
            <div className="l">paid campaigns spotted</div>
          </div>
          <div className="metric">
            <div className="n">{v.week.sent}</div>
            <div className="l">messages sent</div>
          </div>
          <div className="metric">
            <div className="n">{v.week.replies}</div>
            <div className="l">replies</div>
          </div>
          <div className="metric">
            {/* Null, not 0%: "nothing sent" and "nobody replied" are different facts. */}
            <div className="n">{replyRate === null ? '—' : `${replyRate}%`}</div>
            <div className="l">reply rate</div>
          </div>
          <div className="metric-note">last 7 days</div>
        </section>

        {/* The qualifier travels with the number it qualifies, always. */}
        <CoverageNote detection={v.detection} channelCount={v.channelCount} showLink />

        <section className="group">
          <h2>Open conversations ({c.open.length})</h2>
          {c.coverage.open > 0 && (
            <ul className="summary-row">
              <li>
                <strong>{c.coverage.open}</strong>
                <span>open threads</span>
              </li>
              <li className={c.coverage.neverChecked > 0 ? 'bad' : undefined}>
                <strong>{c.coverage.neverChecked}</strong>
                <span>never read</span>
              </li>
              <li>
                <strong>{c.coverage.stale}</strong>
                <span>not read in the last day</span>
              </li>
              <li>
                <strong>{c.coverage.oldestHours === null ? '—' : `${c.coverage.oldestHours}h`}</strong>
                <span>since the oldest read</span>
              </li>
            </ul>
          )}
          {c.open.length === 0 ? (
            <p className="none">No open conversations.</p>
          ) : (
            <ul className="plain-list">
              {c.open.map((o) => (
                <li key={`${o.senderHandle}-${o.targetHandle}`}>
                  <a href={o.profileUrl} target="_blank" rel="noreferrer">
                    {o.targetName}
                  </a>{' '}
                  <span className="muted">
                    @{o.targetHandle} · from @{o.senderHandle} · {o.sentCount} sent · last sent {o.lastSentLabel} ·{' '}
                  </span>
                  {/* "Never read" and "read a while ago" are different facts; only the exception gets a pill. */}
                  {o.lastReadLabel === null ? (
                    <span className="pill warn">never read</span>
                  ) : (
                    <span className="muted">read {o.lastReadLabel}</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>

        {c.handled.length > 0 && (
          <section className="group">
            <h2>Replies handled</h2>
            <ul className="plain-list">
              {c.handled.map((h, i) => (
                <li key={`${h.targetHandle}-${i}`}>
                  {h.targetName}{' '}
                  <span className="muted">
                    @{h.targetHandle} · replied {h.whenLabel}
                  </span>
                  {h.preview ? <span className="muted"> — “{h.preview}”</span> : null}
                </li>
              ))}
            </ul>
          </section>
        )}

        <section className="group">
          <h2>What happened</h2>
          {v.activity.length === 0 ? (
            <p className="none">Nothing sent yet.</p>
          ) : (
            <div className="feed">
              {v.activity.map((day) => (
                <div key={day.dayLabel} className="feed-day">
                  <div className="feed-daylabel">{day.dayLabel}</div>
                  {day.events.map((e, i) => (
                    <div key={i} className={`feed-row ${e.kind}`}>
                      <span className="feed-time">{e.timeLabel}</span>
                      <span className="feed-text">{e.sentence}</span>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}
        </section>

        <SentList recent={c.recent} />
      </div>
    </>
  )
}
