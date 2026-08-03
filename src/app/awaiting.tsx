'use client'

import { useState, useTransition } from 'react'
import { markSent, skipAttempt, sendNow, editAttemptBody, type SendNowResult } from './actions'
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
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(item.body)
  const [editMsg, setEditMsg] = useState<{ ok: boolean; text: string } | null>(null)

  /**
   * Saving writes the body the send path will use verbatim — the composer read-back
   * compares against exactly this text, so an edit is covered by the existing guard
   * without it needing to know editing exists.
   */
  const save = async () => {
    setEditMsg(null)
    start(async () => {
      const r = await editAttemptBody(item.id, draft)
      setEditMsg({ ok: r.ok, text: r.message })
      if (r.ok) setEditing(false)
    })
  }

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
   * Both of these now return a result and can refuse — discarding a message that is
   * already sending, or confirming one the recipient has already replied to. The
   * refusal has to be visible: a button that silently does nothing reads as a broken
   * button, and the operator's next move is to press it again.
   */
  const discard = () => {
    setResult(null)
    start(async () => {
      const r = await skipAttempt(item.id, 'skipped')
      setResult({ ok: r.ok, message: r.message })
    })
  }

  const confirmSentByHand = () => {
    setResult(null)
    start(async () => {
      const r = await markSent(item.id)
      setResult({ ok: r.ok, message: r.message })
    })
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

  /**
   * Two different "busy", and conflating them broke the editor.
   *
   * `saving` is the edit round-trip. `sendBlocked` additionally includes `editing`,
   * because a half-edited message must not be sendable. One flag served both, so the
   * moment the editor opened, `editing` made it true and the Save button rendered
   * "Saving…" disabled — permanently, before any save had been attempted. A control
   * cannot report the state of an action that has not started.
   */
  const saving = pending
  const sendBlocked = sending || pending || item.inFlight || editing

  return (
    <div className="card">
      <div className="card-top">
        <span>
          To <strong>{item.targetName}</strong>
        </span>
        <span className="followers">as {item.senderName}</span>
      </div>

      <div className="row" style={{ marginTop: 0, gap: 14 }}>
        <button className="link-btn" onClick={() => setOpen((v) => !v)}>
          {open ? 'Hide message' : 'Read message'}
        </button>
        {!editing ? (
          <button
            className="link-btn"
            onClick={() => {
              setDraft(item.body)
              setEditing(true)
              setOpen(false)
              setEditMsg(null)
            }}
          >
            Edit message
          </button>
        ) : null}
      </div>

      {open && !editing ? <pre className="msg">{item.body}</pre> : null}

      {editing ? (
        <div>
          <textarea
            className="msg-edit"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            spellCheck
            rows={16}
          />
          <div className="row">
            <button className="primary" onClick={save} disabled={saving || draft.trim().length === 0}>
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button onClick={() => setEditing(false)} disabled={saving}>
              Cancel
            </button>
            <span className="acc-note">{draft.trim().length} characters</span>
          </div>
        </div>
      ) : null}

      {/* Outside the editor block on purpose: a successful save closes the editor,
          so a confirmation rendered inside it would unmount in the same tick and the
          user would see nothing happen. */}
      {editMsg ? (
        <p className="cardnote" style={{ color: editMsg.ok ? 'var(--good)' : 'var(--warn)' }}>
          {editMsg.ok ? '✓ ' : '⚠ '}
          {editMsg.text}
        </p>
      ) : null}

      <div className="row">
        <button
          className="primary"
          disabled={sendBlocked || !item.canSendAutomatically}
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
        <button disabled={sendBlocked} onClick={discard}>
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
            disabled={sendBlocked}
            onClick={confirmSentByHand}
            title="Records that you sent it yourself. Press only after actually sending — spacing, caps and follow-ups are all derived from this."
          >
            I sent it myself
          </button>
        </div>
      </details>
    </div>
  )
}
