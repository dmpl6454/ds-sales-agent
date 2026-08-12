'use client'

import { useState, useTransition } from 'react'
import { prepareOnDemandSend, sendNow, skipAttempt, type SendNowResult } from './actions'
import type { OnDemandPreview } from '@/outreach/onDemand'
/**
 * Its OWN minimal shapes rather than `AccountCard`/`ChannelCard`.
 *
 * This panel reads five fields. Typing it against the full cards tied it to `/`'s view model,
 * and step C moved it to `/messages` — where assembling a whole `AccountCard` (routes, persona,
 * per-account weekly counts) just to fill a dropdown would mean the Messages page paying for
 * data it never renders. `AccountCard` and `ChannelCard` still satisfy these structurally, so
 * nothing else had to change.
 */
export interface OnDemandSender {
  handle: string
  name: string
  /** Raw status: CHALLENGED accounts are not offered at all. */
  status: string
}

export interface OnDemandRecipient {
  handle: string
  name: string
  /** Retired recipients are not offered — `optedOut` is the one promise that must always hold. */
  retired: boolean
}

/**
 * Message a chosen account, now, because you decided to.
 *
 * The rest of the dashboard is the agent's judgement: it watches, it waits out the
 * seven-day spacing, and most of the time the right answer is "not yet". This panel
 * is the other case — you know something the agent does not, and it should not be
 * the thing standing in your way.
 *
 * It is not a bypass. Every rule is still evaluated; the difference is that the
 * spacing rules become a sentence you have to read rather than a refusal you cannot
 * see past. Four things are still refused outright and no dialog is offered for them
 * (Instagram has flagged the account, the channel is retired, the account is not
 * connected, or the day's volume is spent) — see OVERRIDABLE_BLOCKS in gate.ts.
 *
 * Two steps on purpose. Preparing writes a draft and shows it; sending is a separate
 * click on a different button, after the warnings have been rendered. A single button
 * that both composed and delivered would make "let me see what it would say" and "send
 * it" the same act, and this is the one screen where that must never be true.
 */
export function OnDemandPanel({ accounts, channels }: { accounts: OnDemandSender[]; channels: OnDemandRecipient[] }) {
  const sendable = accounts.filter((a) => a.status !== 'CHALLENGED')
  const reachable = channels.filter((c) => !c.retired)

  const [sender, setSender] = useState(sendable[0]?.handle ?? '')
  const [target, setTarget] = useState('')
  const [preview, setPreview] = useState<OnDemandPreview | null>(null)
  const [result, setResult] = useState<SendNowResult | null>(null)
  const [acked, setAcked] = useState(false)
  const [preparing, startPreparing] = useTransition()
  // Separate from `preparing` deliberately: one shared busy flag made the Send button
  // render as "Sending…" while only the draft was being written.
  const [sending, setSending] = useState(false)

  const reset = () => {
    setPreview(null)
    setResult(null)
    setAcked(false)
  }

  const prepare = () => {
    if (!sender || !target) return
    reset()
    startPreparing(async () => {
      setPreview(await prepareOnDemandSend(sender, target))
    })
  }

  const send = async () => {
    if (!preview?.ok || !preview.attemptId) return
    setSending(true)
    setResult(null)
    try {
      // Only the codes actually shown to this operator are passed. The gate
      // intersects them with its whitelist again, so this is convenience, not trust.
      const r = await sendNow(preview.attemptId, preview.warnings.map((w) => w.reason))
      setResult(r)
      if (r.ok) setPreview(null)
    } finally {
      setSending(false)
    }
  }

  const discard = async () => {
    if (!preview?.attemptId) return
    setSending(true)
    try {
      await skipAttempt(preview.attemptId, 'on-demand draft discarded')
      reset()
    } finally {
      setSending(false)
    }
  }

  const senderName = accounts.find((a) => a.handle === sender)?.name ?? sender
  const targetName = channels.find((c) => c.handle === target)?.name ?? target

  return (
    <section className="ondemand">
      <h2>
        Send a message now
        <span className="h2-note">pick an account and a channel — overrides the usual spacing, with a warning</span>
      </h2>

      <div className="ondemand-row">
        <label>
          <span>From</span>
          <select value={sender} onChange={(e) => { setSender(e.target.value); reset() }} disabled={preparing || sending}>
            {sendable.map((a) => (
              <option key={a.handle} value={a.handle}>
                {a.name} (@{a.handle})
              </option>
            ))}
          </select>
        </label>

        <label>
          <span>To</span>
          <select value={target} onChange={(e) => { setTarget(e.target.value); reset() }} disabled={preparing || sending}>
            <option value="">Choose a channel…</option>
            {reachable.map((c) => (
              <option key={c.handle} value={c.handle}>
                {c.name} (@{c.handle})
              </option>
            ))}
          </select>
        </label>

        <button onClick={prepare} disabled={!sender || !target || preparing || sending}>
          {preparing ? 'Writing…' : 'Write the message'}
        </button>
      </div>

      {/* Refused. No dialog, no override — these are not judgement calls. */}
      {preview && !preview.ok ? (
        <div className="ondemand-blocked">
          <strong>Cannot send from @{sender} to @{target}.</strong>
          <ul>
            {preview.blocks.map((b, i) => (
              <li key={i}>{b.text}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {preview?.ok ? (
        <div className="ondemand-confirm">
          <div className="ondemand-head">
            To <strong>{targetName}</strong> as <strong>{senderName}</strong>
          </div>

          <pre className="msg">{preview.body}</pre>

          {preview.warnings.length > 0 ? (
            <div className="ondemand-warn">
              <strong>
                This is outside the normal rules
                {preview.warnings.length > 1 ? ` — ${preview.warnings.length} reasons` : ''}:
              </strong>
              <ul>
                {preview.warnings.map((w, i) => (
                  <li key={i}>{w.text}</li>
                ))}
              </ul>
              <label className="ondemand-ack">
                <input type="checkbox" checked={acked} onChange={(e) => setAcked(e.target.checked)} />
                <span>I have read the above and want to send it anyway.</span>
              </label>
            </div>
          ) : (
            <p className="cardnote">Nothing unusual about this one — it is within the normal rules.</p>
          )}

          <div className="row">
            <button
              className="btn primary"
              onClick={send}
              // The acknowledgement is required only when there is something to
              // acknowledge, so an ordinary send is not made tedious by a feature
              // that exists for the extraordinary one.
              disabled={sending || (preview.warnings.length > 0 && !acked)}
            >
              {sending ? 'Sending…' : `Send it to @${target}`}
            </button>
            <button onClick={discard} disabled={sending}>
              Discard
            </button>
          </div>

          <p className="cardnote">
            A Chrome window will open and drive @{sender}&rsquo;s own logged-in profile for about a minute. Leave it
            alone while it runs.
          </p>
        </div>
      ) : null}

      {result ? (
        <p
          className={`cardnote ${result.ok ? 'note-ok' : result.challenged ? 'note-bad' : 'note-warn'}`}

        >
          {result.ok ? '✓ ' : '⚠ '}
          {result.message}
          {result.challenged ? ' Do not retry — open the account by hand first.' : ''}
        </p>
      ) : null}
    </section>
  )
}
