'use client'

import { useState, useTransition } from 'react'
import { markSent, skipAttempt, sendNow, type SendNowResult } from './actions'
import type { AwaitingCard } from './view-model'
import { profileUrl } from '@/lib/urls'

/**
 * Messages the agent has written, with a button that sends them.
 *
 * "Send now" drives the sending account's own logged-in Chrome profile: feed →
 * target's profile → Message → paste → verify → Enter → confirm it appeared in the
 * thread. A Chrome window is visible for the ~40 seconds it takes, on purpose.
 *
 * The manual path is kept, not as the default but because it is the fallback that
 * makes failure safe: if the browser send fails halfway, or you finish it on your
 * phone, the record has to be able to catch up or the agent prepares a duplicate.
 */
export function AwaitingList({ items }: { items: AwaitingCard[] }) {
  const needLogin = items.filter((i) => !i.canSendAutomatically)

  return (
    <section>
      <h2>
        Ready to send
        <span className="h2-note">
          {items.length} message{items.length === 1 ? '' : 's'} — written from scratch, safety-checked
        </span>
      </h2>

      {needLogin.length > 0 ? (
        <p className="cardnote" style={{ borderTop: 'none', marginBottom: 12 }}>
          {needLogin.length === 1 ? 'One account is' : `${needLogin.length} accounts are`} not connected yet:{' '}
          {[...new Set(needLogin.map((i) => i.senderHandle))].map((h, idx, arr) => (
            <span key={h}>
              <strong>@{h}</strong>
              {idx < arr.length - 1 ? ', ' : ''}
            </span>
          ))}
          . Press <strong>Connect</strong> on {needLogin.length === 1 ? 'it' : 'them'} under Your accounts. Nothing
          stores your password — you type it into Chrome&rsquo;s own form.
        </p>
      ) : null}

      <div className="cards">
        {items.map((a) => (
          <AwaitingItem key={a.id} item={a} />
        ))}
      </div>
    </section>
  )
}

function AwaitingItem({ item }: { item: AwaitingCard }) {
  const [pending, start] = useTransition()
  const [copied, setCopied] = useState(false)
  const [open, setOpen] = useState(false)
  const [result, setResult] = useState<SendNowResult | null>(null)
  const [sending, setSending] = useState(false)

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(item.body)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      setCopied(false)
    }
  }

  /**
   * Not wrapped in useTransition: this takes ~40 seconds and needs its own
   * explicit in-progress state, so the button can be disabled for the whole
   * duration rather than for a React tick.
   */
  const send = async () => {
    setSending(true)
    setResult(null)
    try {
      setResult(await sendNow(item.id))
    } catch (err) {
      setResult({ ok: false, message: err instanceof Error ? err.message : String(err) })
    } finally {
      setSending(false)
    }
  }

  const busy = sending || pending || item.inFlight

  return (
    <div className="card">
      <div className="card-top">
        <span>
          To <strong>{item.targetName}</strong>
        </span>
        <span className="followers">as {item.senderName}</span>
      </div>

      <button className="link-btn" onClick={() => setOpen((v) => !v)}>
        {open ? 'Hide message' : 'Read message'}
      </button>
      {open ? <pre className="msg">{item.body}</pre> : null}

      <div className="row">
        <button
          className="primary"
          disabled={busy || !item.canSendAutomatically}
          onClick={send}
          title={
            item.canSendAutomatically
              ? `Opens @${item.senderHandle}'s own Chrome profile and sends this to @${item.targetHandle}. Takes about 40 seconds; a browser window will appear.`
              : `Press Connect on @${item.senderHandle} under Your accounts first.`
          }
        >
          {item.inFlight
            ? 'Sending…'
            : sending
              ? 'Sending — watch the browser…'
              : `Send from @${item.senderHandle}`}
        </button>
        <button disabled={busy} onClick={() => start(() => skipAttempt(item.id, 'skipped'))}>
          Discard
        </button>
      </div>

      {result ? (
        <p
          className="cardnote"
          style={{ color: result.ok ? 'var(--good)' : result.challenged ? 'var(--bad)' : 'var(--warn)' }}
        >
          {result.ok ? '✓ ' : result.challenged ? '■ ' : '⚠ '}
          {result.message}
        </p>
      ) : null}

      <details className="cardnote">
        <summary style={{ cursor: 'pointer', color: 'var(--muted)' }}>Send it by hand instead</summary>
        <div className="row" style={{ marginTop: 10 }}>
          <button onClick={copy}>{copied ? 'Copied' : 'Copy message'}</button>
          <a className="btn" href={profileUrl(item.targetHandle)} target="_blank" rel="noreferrer">
            Open @{item.targetHandle}
          </a>
          <button
            disabled={busy}
            onClick={() => start(() => markSent(item.id))}
            title="Records that you sent it yourself. Press only after actually sending — spacing, caps and follow-ups are all derived from this."
          >
            I sent it myself
          </button>
        </div>
      </details>
    </div>
  )
}
