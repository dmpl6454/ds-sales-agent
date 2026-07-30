import { buildCeoView } from './view-model'
import { SyncButton } from './sync-button'
import { AwaitingList } from './awaiting'

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
              href={`https://ig.me/m/${r.targetHandle}`}
              target="_blank"
              rel="noreferrer"
            >
              <div className="reply-top">
                <strong>{r.targetName} replied</strong>
                <span className="when">{r.whenLabel}</span>
              </div>
              {r.preview ? <p className="preview">“{r.preview}”</p> : null}
              <div className="reply-foot">
                to {r.senderName} · open the conversation →
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

      <section>
        <h2>Channels we watch</h2>
        <div className="cards">
          {v.channels.map((c) => (
            <div key={c.handle} className="card">
              <div className="card-top">
                <a href={`https://instagram.com/${c.handle}`} target="_blank" rel="noreferrer">
                  {c.name}
                </a>
                <span className="followers">{c.followers}</span>
              </div>
              <dl>
                <div>
                  <dt>Posts read this week</dt>
                  <dd>{c.postsThisWeek}</dd>
                </div>
                <div>
                  <dt>Paid campaigns found</dt>
                  <dd>
                    {c.unclassified ? (
                      <span className="dim">not classified</span>
                    ) : (
                      c.campaignsThisWeek
                    )}
                  </dd>
                </div>
                <div>
                  <dt>Last contacted</dt>
                  <dd>{c.lastContactedLabel}</dd>
                </div>
              </dl>
              {c.unclassified ? (
                <p className="cardnote">
                  This channel never labels its paid posts, so we record every post but do not guess which are
                  paid. Showing a zero here would read as “they do no paid work”, which is untrue.
                </p>
              ) : null}
              {c.halted ? <div className="halt">On hold — they replied</div> : null}
            </div>
          ))}
        </div>
      </section>

      <section>
        <h2>Our accounts</h2>
        <div className="accounts">
          {v.accounts.map((a) => (
            <div key={a.handle} className="account">
              <span className={`dot ${a.state}`} aria-hidden />
              <span className="acc-name">{a.name}</span>
              <span className="acc-handle">@{a.handle}</span>
              <span className="acc-note">{a.note}</span>
              <span className="acc-count">{a.sentThisWeek} sent this week</span>
            </div>
          ))}
        </div>
      </section>

      <footer className="foot">{v.nowLabel} IST</footer>
    </>
  )
}
