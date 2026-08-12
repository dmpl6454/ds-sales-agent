import { redirect } from 'next/navigation'
import { buildTodayView } from './view-model'
import { buildMessagesPage } from './view-model/messages-page'
import { buildConversationsPage } from './view-model/conversations-page'
import { SyncButton } from './sync-button'
import { AutopilotPanel } from './autopilot'
import { WaitingList } from './messages/waiting'
import { DispatcherPanel } from './messages/dispatcher'
import { UncertainList } from './messages/uncertain'
import { RepliesPanel } from './replies'
import { OnDemandPanel } from './on-demand'
import { currentUser } from '@/lib/session'
import { Nav } from './nav'

export const dynamic = 'force-dynamic'

/**
 * **Autopilot** — the landing page, because AUTOPILOT IS THE PRODUCT. Tabish's words:
 * "the manual sending is just a simple feature, the main selling point is autopilot."
 *
 * One job: IS IT SENDING, AND IF NOT, EXACTLY WHAT IS STOPPING IT. Everything on this
 * page is either the answer to that question or the control that changes it. Manual
 * send is not a separate place — it is the same queue with a button on it.
 *
 * This replaces **Today** (a neutral status page whose numbers now live on /analytics)
 * and absorbs **Messages** and the reply half of **Conversations**, because a waiting
 * reply, an uncertain send and a held draft are all "what is stopping it".
 *
 * ── THE ALARM HOLDS THE DOT AND THE SENTENCE, NOTHING ELSE ─────────────────
 * A container that changes colour must contain only things the colour is about; the
 * neutral facts sit under it in neutral type. (The old header put "Last check read 168
 * posts" and Sign out inside an amber box.)
 */
export default async function AutopilotPage() {
  const user = await currentUser()
  if (!user) redirect('/sign-in')

  const [v, m, c] = await Promise.all([buildTodayView(), buildMessagesPage(), buildConversationsPage()])

  return (
    <>
      <Nav current="/" email={user.email} />
      <div className="page">
        <header className="page-head">
          <h1>Autopilot</h1>
          <p className="page-sub">{v.nowLabel} IST</p>
        </header>

        {/* THE ALARM, and only the alarm. */}
        <div className={`status status-${v.health}`}>
          <span className="dot" aria-hidden />
          <span className="headline">{v.headline}</span>
        </div>

        {/* The facts, outside it, in neutral type. */}
        <p className="page-meta">
          {v.lastCheckLabel} · {v.nextSlotLabel} <SyncButton />
        </p>

        {/* The switch, the scheduler behind it, and per-account readiness. */}
        <AutopilotPanel state={v.autopilot} />

        {/* A send Instagram accepted that never appeared — the one thing a person must settle. */}
        <UncertainList uncertain={m.uncertain} />

        {/* A reply halts every account writing to that recipient until someone takes over. */}
        {c.replies.length > 0 && (
          <section className="group">
            <h2>They replied — outreach to them is on hold</h2>
            <p className="group-blurb">
              A reply stops <strong>every</strong> account writing to that recipient. Press “I have replied” once you
              have taken over; the reply itself is kept.
            </p>
            <RepliesPanel replies={c.replies} />
          </section>
        )}

        {/* The pace, and what the last tick did. */}
        <DispatcherPanel dispatch={m.dispatch} pause={m.pause} />

        {/* Today's per-recipient allowance — the same count the send guard checks. */}
        {m.todayByRecipient.length > 0 && (
          <section className="group">
            <h2>Today’s allowance</h2>
            <ul className="plain-list">
              {m.todayByRecipient.map((r) => (
                <li key={r.handle}>
                  @{r.handle} <span className="muted">{r.used} of today’s allowance claimed</span>
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* The queue: each draft, why it cannot go out right now, and the button that sends it. */}
        <WaitingList waiting={m.waiting} />

        {/* Manual send: the same queue, one draft earlier. It writes a draft that appears above. */}
        <OnDemandPanel accounts={m.onDemandSenders} channels={m.onDemandRecipients} />
      </div>
    </>
  )
}
