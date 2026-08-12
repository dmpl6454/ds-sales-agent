'use client'

import { useState } from 'react'
import { dispatchNow, pauseDispatch, resumeDispatch } from '../actions'
import type { MessagesPageView } from '../view-model/messages-page'

/**
 * What the paced dispatcher is doing, and why nothing has gone out.
 *
 * ── WHY THIS PANEL IS NOT OPTIONAL ────────────────────────────────────────
 *
 * Delivery no longer happens inside a slot. A tick fires every fifteen minutes and sends
 * at most one message, so "autopilot is on and nothing has been sent" is now the ORDINARY
 * state for most of any given hour, and it has a specific reason every time: waiting for
 * the gap, outside the sending window, the hour's pace used, the breaker tripped.
 *
 * "A toggle that promises behaviour must show whether anything is behind it" is why the
 * scheduler heartbeat is on screen in red when it is stale. The dispatcher needs the same
 * treatment more, not less: it is the only unattended path to a delivered message, and
 * without this the failure mode is silence with no explanation anywhere — the exact thing
 * the delivery step was built to prevent, reintroduced four times an hour.
 */
export function DispatcherPanel({ dispatch, pause }: Pick<MessagesPageView, 'dispatch' | 'pause'>) {
  const [busy, setBusy] = useState<'send' | 'pause' | 'resume' | null>(null)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [reason, setReason] = useState('')

  const run = async (which: 'send' | 'pause' | 'resume') => {
    setBusy(which)
    setMsg(null)
    try {
      const r =
        which === 'send'
          ? await dispatchNow()
          : which === 'pause'
            ? await pauseDispatch(reason)
            : await resumeDispatch()
      setMsg({ ok: r.ok, text: r.message })
      if (which === 'pause') setReason('')
    } finally {
      setBusy(null)
    }
  }

  const { breaker, usage, limits, state, waiting } = dispatch
  const cap = (n: number) => (Number.isFinite(n) ? String(n) : 'no limit')

  return (
    <section className="group">
      <h2>Sending pace</h2>
      <p className="group-blurb">
        Messages go out one at a time, a few minutes apart, between 10am and 9pm. Spreading them out is the point —
        fourteen messages arriving in one hour from fourteen different pages is what gets accounts reported, even
        though each page has only sent one.
      </p>

      {/*
        The halt, first and unmissable. It has a way out in every case, and the way out is
        never "press resume": a checkpoint releases by clearing that account's halt, and a
        run of uncertain sends releases by resolving them. A release control that can
        dismiss a safety signal is how a safety signal stops being one.
      */}
      {breaker.tripped && (
        <div className="message group-broken">
          <div className="message-head">
            <strong>Sending is halted.</strong>
          </div>
          <p className="account-message bad">{breaker.detail}</p>
          {breaker.reason === 'challenged' && (
            <p className="muted">
              Open that account on the Accounts page, check it by hand, then clear its halt. Clearing it releases the
              other accounts too.
            </p>
          )}
          {breaker.reason === 'not-in-thread-rate' && (
            <p className="muted">
              Settle the messages above that need a conversation checked. Once none are outstanding, sending resumes on
              its own.
            </p>
          )}
          {breaker.reason === 'manual' && (
            <div className="account-actions">
              <button type="button" onClick={() => run('resume')} disabled={busy !== null}>
                {busy === 'resume' ? 'Releasing…' : 'Release the pause'}
              </button>
            </div>
          )}
        </div>
      )}

      <div className="message">
        <div className="message-head">
          <div>
            <strong>{waiting}</strong> <span className="muted">waiting</span>
            {' · '}
            <strong>
              {usage.thisHour}/{cap(limits.perHour)}
            </strong>{' '}
            <span className="muted">this hour</span>
            {' · '}
            <strong>{usage.today}</strong>{' '}
            <span className="muted">
              today{Number.isFinite(limits.perDay) ? ` of ${limits.perDay}` : ''}
            </span>
            {' · '}
            <span className="muted">at least {limits.minGapMinutes} min apart</span>
          </div>
        </div>

        {/*
          The last tick, in the operator's own timezone. Without it, "nothing sent" and
          "nothing even tried" look identical on screen — and they are the difference
          between a working system waiting for the gap and a dead one. This is the same
          argument as showing the scheduler heartbeat, and it applies with more force,
          because this is now the only unattended path to a delivered message.
        */}
        <p className="muted">
          {state
            ? `Last checked ${state.atIst} — ${state.detail}`
            : 'No delivery check has run yet. It runs every 15 minutes while the app is open.'}
        </p>

        {/*
          WHICH messages were held, and why — beyond the first reason already in the line
          above. Until 2026-08-05 this said "0 message(s) sent" with a count and no reason
          whenever the fleet was clear to send and every individual message was then held.
          That explained why the FLEET did not send and not why a MESSAGE did not, which is
          the question someone actually has when nothing has moved.
        */}
        {state?.holdReasons && state.holdReasons.length > 1 && (
          <ul className="plain-list muted">
            {state.holdReasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        )}

        {msg && <p className="account-message">{msg.text}</p>}

        <div className="account-actions">
          <button type="button" onClick={() => run('send')} disabled={busy !== null}>
            {busy === 'send' ? 'Checking…' : 'Send the next one now'}
          </button>

          {!breaker.tripped && (
            <>
              <input
                type="text"
                placeholder="why are you pausing? (optional)"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                disabled={busy !== null}
              />
              <button className="link-quiet" type="button" onClick={() => run('pause')} disabled={busy !== null}>
                {busy === 'pause' ? 'Pausing…' : 'pause sending'}
              </button>
            </>
          )}
        </div>

        {/*
          "Send the next one now" changes WHEN, never WHETHER. Said out loud because a
          button sitting beside a list of limits reads like a way past them.
        */}
        <p className="muted">
          “Send the next one now” only skips the wait. Every other rule still applies, including the halt above.
        </p>
      </div>

      {pause && !breaker.tripped && (
        <p className="muted">A pause was recorded by {pause.by} but is no longer in force.</p>
      )}

      {/*
        Reply coverage used to be rendered here, and it was in the wrong place: beside the
        fleet's hourly allowance it read as another pacing number, when it actually answers
        "how much of our picture of these conversations is current". It lives on
        `/conversations` since step D, with the threads it describes.
      */}
    </section>
  )
}
