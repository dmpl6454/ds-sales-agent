'use client'

import { useState } from 'react'
import Link from 'next/link'
import { sendNow, skipAttempt, editAttemptBody, markSent } from '../actions'
/**
 * TYPE-ONLY, and that is load-bearing. This is a `'use client'` module, so a VALUE import
 * reaching `gate.ts` pulls `profile.ts` -> `better-sqlite3` -> `fs` into the browser bundle.
 *
 * That is not theoretical: the first version of this file imported `remedyFor` from
 * `./remedy`, and the import trace `waiting.tsx [Client] -> remedy.ts -> gate.ts ->
 * profile.ts -> better-sqlite3` failed to resolve `fs`, which broke the client chunk build and
 * returned HTTP 500 on EVERY route — including ones that import none of it. `pnpm typecheck`
 * passed throughout. It is the `lib/session-cookie.ts` lesson in a second place: a module
 * reachable from a restricted runtime must not import server-only code, and only running it
 * tells you.
 *
 * So the remedy is resolved on the SERVER and arrives as data, which also matches this
 * codebase's own rule that a page renders sentences the view model produces.
 */
import type { SendVerdict, WaitingMessage } from '../view-model/messages-page'

/**
 * Messages written and waiting for a decision.
 *
 * Every one shows its full body. The single most useful thing this page can do is let
 * someone READ the message that is about to go to a real person — two live defects
 * reached the database once that eighteen passing assertions missed, and one glance at a
 * rendered message caught both.
 */
export function WaitingList({
  waiting,
  total,
  autopilotOn,
}: {
  waiting: WaitingMessage[]
  /**
   * How many are waiting altogether. The list is capped — each rendered draft costs a real
   * gate call — so `waiting.length` is a page size, not a queue size, and a heading built
   * from it would under-report as the queue grew. That is the "counted from 1 of 5
   * channels" failure in a different place.
   */
  total: number
  autopilotOn: boolean
}) {
  if (waiting.length === 0) {
    return (
      <section className="group">
        <h2>Nothing waiting</h2>
        <p className="group-blurb">
          No message is drafted. That is the normal state most of the time — the spacing rules exist so the answer is
          usually “not yet”.
        </p>
      </section>
    )
  }

  return (
    <section className="group">
      <h2>Waiting for you ({total})</h2>
      {total > waiting.length ? (
        <p className="group-blurb">
          Showing the {waiting.length} that have waited longest. Each one is checked against the real send rules as the
          page loads, so the list is capped rather than letting the page slow down as the queue grows.
        </p>
      ) : null}
      <div className="group-rows">
        {waiting.map((m) => (
          <WaitingCard key={m.id} m={m} autopilotOn={autopilotOn} />
        ))}
      </div>
    </section>
  )
}

/**
 * The two questions a waiting draft has to answer, in the order they are asked.
 *
 *   send  would "Send from @x" work if I pressed it now
 *   auto  will this ever go out on its own
 *
 * Both verdicts come from `recheckBeforeSend`. `auto` is only computed when `send` permits —
 * see the docblock on `SendVerdict` — so `auto === null` means NOT ASKED, and it must never
 * render as a yes. Falling through to a reassuring default is the shape of bug that made
 * `ensureConversationChecked` fail-open, so the null case renders nothing at all.
 *
 * ONE SWITCH, 2026-08-08: the two verdicts still differ, but now only by the cohort ladder
 * and by overrides being dropped when nobody is present — the per-account arming switch that
 * used to be the usual reason for "ready by hand, not on its own" is gone. So the third
 * branch below is reached far more often, which is exactly why it must not overstate itself:
 * "Clear to send" is a claim that the DISPATCHER will attempt this draft, and it is only
 * true while nothing outside `gate.ts` can hold a message the gate permitted. An
 * `autoSendEnabled` hold in `deliverWaiting` made it false for a day; see the docblock at
 * that call site for why that hold went rather than gaining a sentence here.
 */
function Refusal({ send, auto, autopilotOn }: { send: SendVerdict; auto: SendVerdict | null; autopilotOn: boolean }) {
  if (!send.ok) {
    return (
      <p className="reason bad">
        <strong>This cannot be sent yet.</strong> {send.detail ?? 'The send checks refused it.'}{' '}
        <Remedy remedy={send.remedy} />
      </p>
    )
  }

  if (auto && !auto.ok) {
    return (
      <p className="reason">
        <strong>Ready to send by hand.</strong> It will not go out on its own —{' '}
        {auto.detail ?? 'The unattended checks refused it.'} <Remedy remedy={auto.remedy} />
      </p>
    )
  }

  /*
    Both GUARDS permit. Whether anything will actually happen is a separate question, and
    this branch used to answer it wrongly.

    FOUND BY READING THE RENDERED PAGE, 2026-08-12. With autopilot off, every clear draft
    said "the paced dispatcher will pick this up in turn" — a promise about a dispatcher
    that was never going to run. The docblock above states the exact condition this claim
    depends on ("only true while nothing outside `gate.ts` can hold a message the gate
    permitted") and the autopilot switch is precisely such a thing: `gate.ts` deliberately
    does not check it, because the DISPATCHER does.

    Same shape as the `autoSendEnabled` hold that made this sentence false for a day, one
    door along. The fix is not to move the switch into the gate — one decision, one
    enforcer — it is for the sentence to stop claiming more than it knows.
  */
  if (!autopilotOn) {
    return (
      <p className="reason">
        <strong>Ready, and waiting for you.</strong> Every check passes, but autopilot is off — so nothing
        picks this up on its own. Send it with the button above whenever you like.
      </p>
    )
  }

  return (
    <p className="reason good">
      <strong>Clear to send.</strong> Every check passes; the paced dispatcher will pick this up in turn.
    </p>
  )
}

/**
 * Where to fix it, when there is somewhere.
 *
 * `href: null` is a real answer, not a gap — a daily cap clears by waiting — so it renders as
 * quiet prose rather than as a dead link. An unrecognised reason renders nothing at all: better
 * silence than pointing someone at a page that cannot help.
 */
function Remedy({ remedy }: { remedy: SendVerdict['remedy'] }) {
  if (!remedy) return null
  if (!remedy.href) return <span className="muted">{remedy.label}</span>
  return <Link href={remedy.href}>{remedy.label}</Link>
}


function WaitingCard({ m, autopilotOn }: { m: WaitingMessage; autopilotOn: boolean }) {
  const [body, setBody] = useState(m.body)
  const [editing, setEditing] = useState(false)
  // A separate flag per action. One shared flag rendered Save as "Saving…" the moment
  // the editor opened, before any save had been attempted.
  const [busySend, setBusySend] = useState(false)
  const [busySave, setBusySave] = useState(false)
  const [busyDiscard, setBusyDiscard] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  return (
    <article className={`message ${m.inFlight ? 'message-inflight' : ''}`}>
      <header className="message-head">
        <div>
          <strong>
            @{m.senderHandle} → @{m.targetHandle}
          </strong>
          <span className="muted">
            {' '}
            {m.targetKind === 'BRAND' ? 'brand' : 'channel'} · message {m.touchNumber} · {m.chars} characters
          </span>
        </div>
        {m.inFlight && <span className="chip chip-live">sending now</span>}
      </header>

      {/*
        A previous failure, said out loud. `not-in-thread` is called out separately
        because it is the one failure where the recipient may ALREADY have the message —
        sending again would be a duplicate, not a retry.
      */}
      {m.attempts > 0 && (
        <p className={m.failureCode === 'not-in-thread' ? 'account-message bad' : 'account-message'}>
          {m.failureCode === 'not-in-thread'
            ? `Tried ${m.attempts}× — the last attempt reached Instagram but the message never appeared in the thread. It may already have been delivered. Check the conversation before sending again.`
            : `Tried ${m.attempts}× without success. ${m.error ?? ''}`}
          {/*
            NO remedy link here, deliberately, and it took writing one to see why.
            This line is HISTORY — what went wrong the last time a browser was driven — and the
            block below is the CURRENT verdict. On the live draft they are different things: the
            last attempt failed on a dead session, while what refuses it now is that the channel
            replied. Attaching `m.send.remedy` here would offer the fix for today's blocker as
            though it were the fix for yesterday's failure. Same family as the persona gate
            passing on a fact that had nothing to do with the message being sent.
          */}
        </p>
      )}

      {/*
        WHY THIS MESSAGE CANNOT GO OUT — above the body, because it changes how the body is
        read. Measured 2026-08-06: all four waiting drafts would have been refused, and this
        card offered a Send button and said nothing at all.

        The sentence is the GATE'S OWN. Only the link is ours. See `remedy.ts`.
      */}
      {!m.inFlight && <Refusal send={m.send} auto={m.auto} autopilotOn={autopilotOn} />}

      {/*
        WHOSE TURN IT IS. The sentence comes from `whoseTurn` in the view model — the same
        function the planner asks — so this can never name an account the planner will not use.

        It is shown on EVERY draft, not only the ones out of turn, because the thing that went
        unnoticed for weeks was rotation not happening at all. A line that appears only when
        something is wrong cannot tell you that the mechanism is working.
      */}
      <p className={m.rotation.isTurn ? 'reason' : 'reason bad'}>{m.rotation.sentence}</p>

      {editing ? (
        <>
          <textarea value={body} rows={16} onChange={(e) => setBody(e.target.value)} />
          <div className="account-actions">
            <button
              disabled={busySave}
              onClick={async () => {
                setBusySave(true)
                const r = await editAttemptBody(m.id, body)
                setMessage(r.message)
                setBusySave(false)
                if (r.ok) setEditing(false)
              }}
            >
              {busySave ? 'Saving…' : 'Save'}
            </button>
            <button className="link-quiet" onClick={() => setEditing(false)}>
              cancel
            </button>
          </div>
        </>
      ) : (
        /*
          ── THE BODY COLLAPSES; THE REFUSAL DOES NOT (2026-08-17) ─────────────────
          MEASURED on the rendered page with a full queue: 20 draft cards each printing a
          ~570-character body took `/` to **196 numerals, 3,458 words and 12,253px**. My own
          earlier measurement said 35 numerals and 1,349px — taken while the queue was EMPTY,
          which understated it fivefold. Density here is proportional to queue depth.

          The simplification brief's hard constraint is that each draft keeps its refusal
          sentence on the COLLAPSED row, and it does: the recipient, the sender, the rotation
          sentence, the refusal from `recheckBeforeSend` and every button stay exactly where
          they were. Only the message text — the part that is the same standard template on
          every card now — moves behind one click.

          `<details>` rather than React state on purpose: it works before hydration, it is
          keyboard-operable for nothing, and a body a person opened stays open while the page
          revalidates around it.
        */
        <details className="message-reveal">
          <summary>Read the message ({m.body.length} characters)</summary>
          <pre className="message-body">{m.body}</pre>
        </details>
      )}

      {/* Outside the editor, so a success message is not unmounted by the save. */}
      {message && <p className="account-message">{message}</p>}

      {!editing && !m.inFlight && (
        <div className="account-actions">
          <button
            disabled={busySend}
            onClick={async () => {
              setBusySend(true)
              const r = await sendNow(m.id)
              setMessage(r.message)
              setBusySend(false)
            }}
          >
            {busySend ? 'Sending — a Chrome window will open…' : `Send from @${m.senderHandle}`}
          </button>
          {/*
            The button stays ENABLED even when the gate says no, and that is a decision.

            What is rendered above is a snapshot; `sendNow` re-asks the same function at the
            moment of the click and is the authority. Disabling on the snapshot would mean a
            page thirty seconds old could refuse a send that is now perfectly fine — an
            account connected in another tab, a reply just marked handled. Showing the reason
            costs nothing and is honest; hiding the control on stale data is not.

            It also matters that a refused click is cheap: the gate runs before the READY ->
            SENDING claim and before any reservation, so nothing is unwound and no browser is
            driven.
          */}
          <button onClick={() => setEditing(true)}>Edit</button>
          <button
            className="link-quiet"
            onClick={async () => {
              const r = await markSent(m.id)
              setMessage(r.message)
            }}
          >
            I sent this by hand
          </button>
          <button
            className="link-quiet"
            disabled={busyDiscard}
            onClick={async () => {
              setBusyDiscard(true)
              const r = await skipAttempt(m.id, 'discarded from the messages page')
              setMessage(r.message)
              setBusyDiscard(false)
            }}
          >
            {busyDiscard ? 'Discarding…' : 'discard'}
          </button>
        </div>
      )}
    </article>
  )
}
