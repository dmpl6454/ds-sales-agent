import { redirect } from 'next/navigation'
import { buildTodayView } from './view-model'
import { buildMessagesPage } from './view-model/messages-page'
import { buildRestTally } from './view-model/rest-tally'
import { buildConversationsPage } from './view-model/conversations-page'
import { buildWatchChart } from './view-model/charts'
import { rankBlockers, blockersSummary } from './view-model/blockers'
import { SyncButton } from './sync-button'
import { AutoRefresh } from './auto-refresh'
import { AutopilotPanel } from './autopilot'
import { BlockerList } from './blockers'
import { PaceBand } from './pace'
import { WaitingList } from './messages/waiting'
import { RestBand } from './rest-band'
import { ParkedList } from './messages/parked'
import { RepliesPanel } from './replies'
import { OnDemandPanel } from './on-demand'
import { TemplateForm } from './template-form'
import { FleetTemplateForm } from './fleet-template-form'
import { buildFleetTemplates } from './view-model/fleet-templates'
import { FollowUpForm } from './follow-up-form'
import { DEFAULT_CATEGORY_SLUG } from '@/outreach/senderCategories'

import { getSettings } from '@/lib/settings'
import { SINGLE_TEMPLATE_MIDDLE } from '@/outreach/compose'
import { currentUser } from '@/lib/session'
import { Nav } from './nav'
import { PageHead } from './page-head'
import { istHourOfDay, istTimeKey } from '@/lib/time'

/**
 * What to call the default fleet on screen, and ONLY when a second one exists — with one
 * fleet a name distinguishing it from the others is furniture, which is the same reason the
 * add-account dropdown appears only when there is a choice to make.
 */
const DEFAULT_FLEET_NAME = 'Bollywood'

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
 *   replies         the one thing only a person can settle
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

  const [v, m, c, watch, settings, rest] = await Promise.all([
    buildTodayView(),
    buildMessagesPage(),
    buildConversationsPage(),
    buildWatchChart(),
    getSettings(),
    /*
      WHO IS RESTING, and out of how many (2026-08-24, Tabish). Loaded HERE in the existing
      Promise.all rather than inside the queue component, so its ~700ms of enforcer work runs
      concurrently with the four builders already in flight and adds no wall-clock this page
      was not already spending. It is also why it must not be a client component: reaching the
      enforcers from the browser bundle is the `waiting.tsx -> gate.ts -> better-sqlite3` trap
      that returned HTTP 500 on every route.
    */
    buildRestTally(),
  ])

  /**
   * Sequential rather than in the block above only because it READS `settings` — the saved
   * copy per fleet lives there and re-reading the Setting table to avoid one await would
   * cost more than it saves. Two grouped queries; see fleet-templates.ts for why it is not
   * one per fleet.
   */
  const fleetTemplates = await buildFleetTemplates(settings)

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
    /**
     * DISTINCT RECIPIENTS, not reply rows — the headline this feeds says "N recipients replied
     * and are on hold", and the halt is per RECIPIENT (a reply stops every one of our pages
     * writing to them). MEASURED 2026-08-24: 65 unhandled replies across 51 distinct
     * recipients, so the old `c.replies.length` overstated the number of held recipients by
     * 30% — a screen reporting one rule by a different rule, which is the most repeated defect
     * in this project's history. Several recipients have replied more than once, and
     * @keshavamband four times.
     */
    repliesWaiting: new Set(c.replies.map((r) => r.targetHandle)).size,
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
      {/* One message a minute means the page is stale before it is read; see auto-refresh.tsx. */}
      <AutoRefresh seconds={30} />
      <div className="page">
        <PageHead title="Autopilot" aside={`${v.nowLabel} IST · ${v.nextSlotLabel}`} />

        {/*
          THE ALARM, THE SENTENCE, AND THE ONE CONTROL THE DESIGN PUTS HERE.

          `SyncButton` is inside the card because the design draws it there and because it is
          the one control that acts on what the card is ABOUT — "the watch last read 84 posts"
          invites exactly one question, and this answers it.

          WHAT MUST NOT COME BACK IN, and `tests/shell.test.ts` fails the build over both: the
          last-check FIGURE and `SignOutButton`. This card's border and dot turn amber and red,
          `status-attention` is the ordinary state whenever a draft is waiting, and for two days
          it rendered an alarm containing a routine figure and a sign-out link — good news
          inside a red box, which is how a reader learns to ignore the box. A quiet control is
          not furniture; a figure and a nav link are.
        */}
        <div className={`status status-${v.health}`}>
          <span className="dot" aria-hidden />
          <span className="headline">{v.headline}</span>
          <SyncButton />
        </div>

        {/*
          The facts, OUTSIDE the alarm, in neutral type.

          The check-now button moved INTO the hero with the design; this row is the figure it
          acts on, which stays out of the amber box. The next slot moved up to the heading row
          beside the clock, so it is not repeated here either.
        */}
        <p className="page-meta">{v.lastCheckLabel}</p>

        {/*
          THE SWITCH AND THE PACE, SIDE BY SIDE — the mockup's shape, and it earns the pairing:
          the switch says whether unattended sending is permitted at all, the pace says why "on"
          does not mean "now". Read apart, the first invites "so why has nothing gone out?" and
          the second is the answer. They were a full-width card and a half-width card two
          sections apart, so the question and its answer were never in one glance.
        */}
        <section className="grid-2">
          <AutopilotPanel state={v.autopilot} />

          <PaceBand
            istHour={istHourOfDay(now)}
            istMinute={istMinute}
            sentThisHour={m.dispatch.usage.thisHour}
            /* Both halves of the SAME `fleetUsage()` call; the daily one reached no screen
               until 2026-08-20 — see the prop's docblock in pace.tsx. */
            sentToday={m.sentToday}
            /* The limits the DISPATCHER enforces — Setting rows where they exist. */
            perHour={m.dispatch.limits.perHour}
            minGapMinutes={m.dispatch.limits.minGapMinutes}
            lastTick={lastTick}
          />
        </section>

        {/* The answer to the page's question, ranked by what cannot be undone. */}
        <BlockerList blockers={blockers} summary={blockersSummary(blockers, v.autopilot.on)} />

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
            <h2>They replied &mdash; paused</h2>
            <RepliesPanel replies={c.replies} />
            {/*
              THE HEADING IS THE DESIGN'S ("They replied — paused") AND THE CLAUSE IT DROPPED
              LANDED HERE, not nowhere. "Paused" alone does not say the halt covers EVERY page
              writing to that recipient, and that is the part a reader meeting this for the
              first time would otherwise have to guess at — a link cannot say it in situ.
            */}
            <p className="cardnote lede">
              Every account writing to them is paused, not just the one they answered.{' '}
              <a href="/rules">How the pause works</a>
            </p>
          </section>
        )}

        {/*
          Failures the retry cap gave up on. The "Check the conversation" section that used
          to sit above this is GONE (2026-08-24, Tabish) along with the list of sends that
          cleared the composer and never appeared: it was asking a person to open eighteen
          Instagram conversations, three of them for drafts that had not failed once.
          `ParkedList` renders nothing at all when there is nothing to show.
        */}
        <ParkedList parked={m.parked} />

        {/*
          NEW COMPANIES — a count, no cap. The per-day new-company cap was removed on
          2026-08-18 (Tabish: "Remove all caps"); what bounds the queue now is its
          depth, and what bounds deliveries is the 5-minute gap and the per-pair rule.

          A tile rather than a heading and a sentence: it is one figure with its parts named,
          which is the shape the mockup gives it, and an `<h2>` over a single line of prose
          was announcing a section that had no content of its own.
        */}
        <div className="card card-tint" style={{ marginBottom: 20 }}>
          <div className="eyebrow">New companies today</div>
          <p className="stat-sentence">
            <strong>{m.newCompanies.delivered}</strong> contacted
            {m.newCompanies.waiting > 0 ? <> · {m.newCompanies.waiting} waiting to go out</> : null}
            {m.newCompanies.neverContacted > 0 ? (
              <>
                {' '}
                · {m.newCompanies.neverContacted}{' '}
                {m.newCompanies.neverContacted === 1 ? 'company' : 'companies'} still to reach
              </>
            ) : null}
          </p>
        </div>

        {/*
          ── THE QUEUE: UP NEXT, THEN WHAT IS RESTING ────────────────────────
          The design's shape, and the ordering is the argument for it. The full rest tally used
          to sit ABOVE this as a heading, a paragraph and a table — the largest block on the
          page, in front of the thing the page is about. The figure that block existed to carry
          (469 of 473 companies resting, against a ten-deep queue) is now the RESTING HEADING
          inside the list, where a reader meets it beside the rows it explains, and the
          per-reason breakdown is one click below rather than unfolded in the way.
        */}
        <WaitingList
          upNext={m.upNext}
          heldWaiting={m.heldWaiting}
          heldUpNext={m.heldUpNext}
          total={m.waitingTotal}
          autopilotOn={m.autopilotOn}
          resting={rest.total > 0 ? { resting: rest.resting, total: rest.total } : null}
        />

        {/*
          THE BREAKDOWN, FOLDED. It answers "why are they resting", which is the second
          question, and it is a table of five rows of rules — the kind of thing a person opens
          once and then stops needing. Folded it keeps every figure and stops the page opening
          with an explanation of a queue the reader has not seen yet.
        */}
        {rest.total > 0 && rest.resting > 0 ? (
          <details className="fold">
            {/*
              The count is NOT repeated here: the heading one line above already reads
              "Resting — N/M companies on cooldown or cap", and a fold restating N directly
              under it is the duplication this page keeps producing — a fact met twice
              teaches a reader to skip both. This summary says what is INSIDE it instead.
            */}
            <summary>Why they are resting, rule by rule</summary>
            <RestBand tally={rest} />
          </details>
        ) : null}

        {/*
          ── WHAT HAS ACTUALLY GONE OUT, ON THE PAGE THAT ANSWERS "IS IT SENDING" ────
          (2026-08-21, Tabish: "it should reflect in analytics and autopilot page accurately
          all the message thread with an ability to go even beyond.")

          This page had the queue, the pace and the switch — everything about what is ABOUT to
          happen — and no figure at all for what already had. Both counts are real counts
          (`usage.today` from the pacing guard, `deliveredTotal` its own query), never the
          length of a capped list: that mistake has now been made three times in three days.

          Deliberately the newest EIGHT and a link, not a table. The complete record is one
          click away and paginated; duplicating it here would be the third copy of the same
          list in the product, and duplication is a failure of the same kind as silence.
        */}
        <section>
          <div className="sec-head">
            <h2>Delivered</h2>
            <a href="/analytics#history">Every message &rsaquo;</a>
          </div>
          <p className="cardnote">
            <strong>{m.sentToday}</strong> today, since midnight IST &middot; <strong>{m.deliveredTotal}</strong>{' '}
            all time
            {m.sentThisWeek !== m.deliveredTotal ? <> &middot; {m.sentThisWeek} in the last 7 days</> : null}
          </p>
          {m.recent.length === 0 ? (
            <p className="empty">No message has reached a recipient yet.</p>
          ) : (
            <div className="rows">
              {m.recent.slice(0, 8).map((r) => (
                <div className="rowitem" key={r.id}>
                  {/* Wide enough for "18 Sept, 10:21" in the mono face and told not to
                      wrap: at 96px it broke across two lines, which doubled the height of
                      every row in the list and turned a compact history into a ledger. */}
                  <span className="mono dim" style={{ width: 118, flex: '0 0 auto', whiteSpace: 'nowrap' }}>
                    {r.sentAt
                      ? r.sentAt.toLocaleString('en-GB', {
                          timeZone: 'Asia/Kolkata',
                          day: 'numeric',
                          month: 'short',
                          hour: '2-digit',
                          minute: '2-digit',
                          hour12: false,
                        })
                      : '—'}
                  </span>
                  <span style={{ minWidth: 0 }}>
                    @{r.senderHandle} &rarr; @{r.targetHandle}{' '}
                    {r.replied ? <span className="chip chip-soft">replied</span> : null}
                  </span>
                  {r.threadUrl ? (
                    <a style={{ marginLeft: 'auto' }} href={r.threadUrl} target="_blank" rel="noreferrer">
                      open
                    </a>
                  ) : null}
                </div>
              ))}
            </div>
          )}
        </section>

        {/*
          ── THE TWO EDITORS AND THE MANUAL SEND, FOLDED ────────────────────
          None of these is in the design, and all three are real controls, so they are folded
          rather than deleted. What decides it is how often each is used: the page answers "is
          it sending" many times a day, and the copy is written once and then edited almost
          never — so three tall panels of textareas and a send form sat permanently between a
          reader and the answer. Folded, every control is one click away and nothing is lost;
          each keeps its own confirmation and its own refusal.
        */}
        <details className="fold">
          <summary>{fleetTemplates.length > 0 ? 'The message each fleet sends' : 'The message every recipient gets'}</summary>
          <TemplateForm
            initialBody={settings.singleTemplateBody ?? SINGLE_TEMPLATE_MIDDLE}
            edited={settings.singleTemplateBody !== null}
          />
          {/**
            * One box per SECOND fleet, rendered only when one exists — a single fleet needs no
            * heading distinguishing it from the others, the same reason the add-account
            * dropdown appears only when there is a choice to make.
            *
            * An empty box here is a live refusal rather than a blank waiting to be filled, and
            * it says so with the number of companies it is holding. See fleet-template-form.tsx.
            */}
          {fleetTemplates.map((f) => (
            <FleetTemplateForm
              key={f.slug}
              slug={f.slug}
              name={f.name}
              initialBody={f.body}
              waitingCompanies={f.waitingCompanies}
              senderCount={f.senderCount}
            />
          ))}
        </details>

        {/**
          * ── THE SECOND MESSAGE (2026-09-01, Tabish) ─────────────────────────
          *
          * Its own section rather than a fourth box under the heading above, because the
          * heading above is about what a company hears FIRST and this is about what it hears
          * NEXT — and because an empty box here means something different again: no page
          * writes to anybody twice, while first touches carry on untouched.
          *
          * The count on each box is the planner's own `no-follow-up-message-written` bucket,
          * split by fleet, so it is the number of companies a saved textarea would actually
          * release rather than an estimate.
          */}
        <details className="fold">
          <summary>The second message</summary>
          <FollowUpForm
            slug={null}
            name={fleetTemplates.length > 0 ? DEFAULT_FLEET_NAME : ''}
            initialBody={settings.followUpBody ?? ''}
            waitingPairs={rest.noFollowUpByFleet[DEFAULT_CATEGORY_SLUG] ?? 0}
          />
          {fleetTemplates.map((f) => (
            <FollowUpForm
              key={f.slug}
              slug={f.slug}
              name={f.name}
              initialBody={settings.followUpBodies.get(f.slug) ?? ''}
              waitingPairs={rest.noFollowUpByFleet[f.slug] ?? 0}
            />
          ))}
        </details>

        {/* Manual send: the same queue, one draft earlier. It writes a draft that appears above. */}
        <details className="fold">
          <summary>Send a message now</summary>
          <OnDemandPanel accounts={m.onDemandSenders} channels={m.onDemandRecipients} />
        </details>
      </div>
    </>
  )
}
