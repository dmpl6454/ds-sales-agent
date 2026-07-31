import { buildCeoView } from './view-model'
import { SyncButton } from './sync-button'
import { AwaitingList } from './awaiting'
import { AutopilotPanel } from './autopilot'
import { AccountsPanel } from './accounts'
import { ChannelsPanel } from './channels'
import { dmInboxUrl } from '@/lib/urls'

export const dynamic = 'force-dynamic'

/**
 * The whole dashboard. One page.
 *
 * Ordering is deliberate and reads top to bottom as: is it working → did anyone
 * answer → how much happened → what happened → who is involved.
 *
 * Replies sit above the metrics because a reply is the only event in this system
 * that represents revenue. Everything that used to be on screen and a CEO would
 * not ask about — confidence scores, signal arrays, variant labels, grid indices,
 * detector keys, parse diagnostics — is gone from the UI and still fully
 * available through `pnpm db:studio`.
 */
export default async function Dashboard() {
  const v = await buildCeoView()

  return (
    <>
      <header className={`status status-${v.health}`}>
        <div className="status-main">
          <span className="dot" aria-hidden />
          <span className="headline">{v.headline}</span>
        </div>
        <div className="status-meta">
          <span>{v.lastCheckLabel}</span>
          <span className="dim">·</span>
          <span>{v.nextSlotLabel}</span>
          <SyncButton />
        </div>
      </header>

      {v.todos.length > 0 ? (
        <section className="todos">
          <h2>Needs you</h2>
          <ul>
            {v.todos.map((t, i) => (
              <li key={i}>{t}</li>
            ))}
          </ul>
        </section>
      ) : null}

      {v.replies.length > 0 ? (
        <section className="replies">
          {v.replies.map((r, i) => (
            <a
              key={i}
              className="reply"
              href={dmInboxUrl()}
              target="_blank"
              rel="noreferrer"
            >
              <div className="reply-top">
                <strong>{r.targetName} replied</strong>
                <span className="when">{r.whenLabel}</span>
              </div>
              {r.preview ? <p className="preview">“{r.preview}”</p> : null}
              <div className="reply-foot">
                to {r.senderName} · open the Instagram inbox →
              </div>
            </a>
          ))}
        </section>
      ) : null}

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
        <div className="metric-note">last 7 days</div>
      </section>

      {v.awaiting.length > 0 ? <AwaitingList items={v.awaiting} /> : null}

      <section>
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

      <ChannelsPanel channels={v.channels} />

      <AccountsPanel accounts={v.accounts} />

      <AutopilotPanel state={v.autopilot} accounts={v.accounts} />

      <footer className="foot">{v.nowLabel} IST</footer>
    </>
  )
}
