import { redirect } from 'next/navigation'
import { buildTodayView } from './view-model'
import { buildMessagesPage } from './view-model/messages-page'
import { buildConversationsPage } from './view-model/conversations-page'
import { buildWatchChart } from './view-model/charts'
import { rankBlockers, blockersSummary } from './view-model/blockers'
import { SyncButton } from './sync-button'
import { AutopilotPanel } from './autopilot'
import { BlockerList } from './blockers'
import { PaceBand } from './pace'
import { WaitingList } from './messages/waiting'
import { UncertainList } from './messages/uncertain'
import { ParkedList } from './messages/parked'
import { RepliesPanel } from './replies'
import { OnDemandPanel } from './on-demand'
import { TemplateForm } from './template-form'
import { getSettings } from '@/lib/settings'
import { SINGLE_TEMPLATE_MIDDLE } from '@/outreach/compose'
import { currentUser } from '@/lib/session'
import { Nav } from './nav'
import { PageHead } from './page-head'
import { istHourOfDay, istTimeKey } from '@/lib/time'

export const dynamic = 'force-dynamic'

/**
 * **Autopilot** — the landing page, because AUTOPILOT IS THE PRODUCT. Tabish's words:
 * "the manual sending is just a simple feature, the main selling point is autopilot."
 *
 * One job: IS IT SENDING, AND IF NOT, EXACTLY WHAT IS STOPPING IT. Everything on this
 * page is either the answer to that question or the control that changes it. Manual
 * send is not a separate place — it is the same queue with a button on it.
 *
 * ── THE READING ORDER IS THE DESIGN ─────────────────────────────────────────
 *
 *   the alarm        one dot, one sentence, nothing else in the coloured box
 *   the switch       the single control, with the environment floor beside it
 *   what is stopping it   ranked by what CANNOT BE RECOVERED, not by loudness
 *   the pace         why "on" does not mean "now"
 *   replies · uncertain   the two things only a person can settle
 *   the queue        every draft, with the guard's own refusal on it
 *
 * The ranked list is the piece that was missing before. The page used to show the same
 * four facts in the order the components happened to be written in, so a 21-hour watch
 * outage losing posts permanently sat BELOW three drafts that were merely waiting — and
 * the drafts were bigger, because they carry bodies and buttons. Loudness was inverse to
 * urgency.
 *
 * ── THE ALARM HOLDS THE DOT AND THE SENTENCE, NOTHING ELSE ─────────────────
 * A container that changes colour must contain only things the colour is about; the
 * neutral facts sit under it in neutral type. (The old header put "Last check read 168
 * posts" and Sign out inside an amber box.) `tests/shell.test.ts` asserts this.
 */
export default async function AutopilotPage() {
  const user = await currentUser()
  if (!user) redirect('/sign-in')

  const [v, m, c, watch, settings] = await Promise.all([
    buildTodayView(),
    buildMessagesPage(),
    buildConversationsPage(),
    buildWatchChart(),
    getSettings(),
  ])

  /**
   * Per-draft refusal summaries went with the per-draft cards (2026-08-18): every draft
   * is the same standard template now, and the fleet-level reason nothing is moving comes
   * from the dispatcher's own hold reason on the pace band — the enforcer's words, not a
   * per-row re-derivation.
   */
  const topRefusal = null

  const blockers = rankBlockers({
    watch,
    /*
      The breaker halts the WHOLE fleet, so it belongs in the ranked list rather than in a
      panel below three drafts it is the reason for. Its sentence comes from `assessBreaker`
      — the same pure function the dispatcher asks before it drives a browser.
    */
    breaker: m.dispatch.breaker.tripped ? { reason: m.dispatch.breaker.detail } : null,
    pausedBy: m.pause,
    repliesWaiting: c.replies.length,
    uncertain: m.uncertain.length,
    draftsWaiting: m.waitingTotal,
    topRefusal,
  })

  const now = new Date()
  const istMinute = Number(istTimeKey(now).slice(3, 5))

  /* The dispatcher's last tick, in its own words. Null means it has genuinely never run. */
  const lastTick = m.dispatch.state
    ? `${m.dispatch.state.sent} sent` +
      (m.dispatch.state.held ? `, ${m.dispatch.state.held} held` : '') +
      (m.dispatch.state.holdReasons?.length ? ` — ${m.dispatch.state.holdReasons.join('; ')}` : '')
    : null

  return (
    <>
      <Nav current="/" email={user.email} />
      <div className="page">
        <PageHead title="Autopilot" sub={`${v.nowLabel} IST`} />

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

        {/* The answer to the page's question, ranked by what cannot be undone. */}
        <BlockerList blockers={blockers} summary={blockersSummary(blockers, v.autopilot.on)} />

        <section className="grid-2">
          <PaceBand
            istHour={istHourOfDay(now)}
            istMinute={istMinute}
            sentThisHour={m.dispatch.usage.thisHour}
            /* The limits the DISPATCHER enforces — Setting rows where they exist. */
            perHour={m.dispatch.limits.perHour}
            minGapMinutes={m.dispatch.limits.minGapMinutes}
            lastTick={lastTick}
          />

          <div className="stack">
            {/* A reply halts every account writing to that recipient until someone takes over. */}
            {/*
              THE EXPLANATION MOVED TO /rules (2026-08-17), THE REPLIES DID NOT.

              Two sentences used to sit here saying a reply halts every account, resumes after
              a day, and that "I have replied" releases it sooner. `/rules` already states both
              of those from the modules that enforce them — so this was the second copy, on the
              page a person looks at most, which is how a reader learns to skip both.

              What stays is the reply itself and the control that releases it. The heading now
              carries the one-clause version, because a reader who has never seen this before
              still needs to know the halt is fleet-wide, and a link cannot say that in situ.
            */}
            {c.replies.length > 0 && (
              <section>
                <h2>They replied — every account to them is paused</h2>
                <RepliesPanel replies={c.replies} />
                <p className="cardnote">
                  <a href="/rules">How the pause works</a>
                </p>
              </section>
            )}

            {/* A send Instagram accepted that never appeared — the one thing a person must settle. */}
            <UncertainList uncertain={m.uncertain} />
            <ParkedList parked={m.parked} />

            {/*
              NEW COMPANIES — a count, no cap. The per-day new-company cap was removed on
              2026-08-18 (Tabish: "Remove all caps"); what bounds the queue now is its
              depth, and what bounds deliveries is the 5-minute gap and the per-pair rule.
            */}
            <section>
              <h2>New companies today</h2>
              <p className="cardnote">
                <strong>{m.newCompanies.delivered}</strong> contacted today
                {m.newCompanies.waiting > 0 ? <> · {m.newCompanies.waiting} written and waiting to go out</> : null}
                {m.newCompanies.neverContacted > 0 ? (
                  <>
                    {' '}
                    · {m.newCompanies.neverContacted} company{m.newCompanies.neverContacted === 1 ? '' : 's'} still to
                    reach
                  </>
                ) : null}
              </p>
            </section>
          </div>
        </section>

        {/* The queue: who sends next, in the dispatcher's own order, then counts per account. */}
        <WaitingList queue={m.queueBySender} upNext={m.upNext} total={m.waitingTotal} />

        {/* THE standard message, editable here since /settings went (2026-08-18). */}
        <section>
          <h2>The message every recipient gets</h2>
          <TemplateForm
            initialBody={settings.singleTemplateBody ?? SINGLE_TEMPLATE_MIDDLE}
            edited={settings.singleTemplateBody !== null}
          />
        </section>

        {/* Manual send: the same queue, one draft earlier. It writes a draft that appears above. */}
        <OnDemandPanel accounts={m.onDemandSenders} channels={m.onDemandRecipients} />
      </div>
    </>
  )
}
