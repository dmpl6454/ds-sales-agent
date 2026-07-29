'use client'

import { useState, useTransition } from 'react'
import { markSent, skipAttempt } from './actions'

/**
 * The manual-mode action surface — the whole point of Phase 1.
 *
 * Flow: copy the body, open the thread, paste, send, then tap "Mark sent". The
 * order matters: "Mark sent" starts the cooldown, so it must follow the real
 * send rather than replace it.
 */

export interface ReadyAttempt {
  id: string
  senderHandle: string
  senderDisplay: string
  targetHandle: string
  targetDisplay: string
  touchNumber: number
  variantLabel: string
  hookLine: string | null
  body: string
  campaignPermalink: string | null
  queuedAt: string
}

export function ReadyTray({ attempts }: { attempts: ReadyAttempt[] }) {
  if (attempts.length === 0) {
    return (
      <div className="card">
        <div className="empty">
          Nothing waiting. Messages appear here when the governor clears a pair — cooldown elapsed, target under its
          daily cap, no reply received.
        </div>
      </div>
    )
  }
  return (
    <div className="grid" style={{ gap: 12 }}>
      {attempts.map((a) => (
        <AttemptCard key={a.id} attempt={a} />
      ))}
    </div>
  )
}

function AttemptCard({ attempt: a }: { attempt: ReadyAttempt }) {
  const [pending, start] = useTransition()
  const [copied, setCopied] = useState(false)
  const [open, setOpen] = useState(true)

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(a.body)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      setCopied(false)
    }
  }

  return (
    <div className="card">
      <div className="btnrow" style={{ justifyContent: 'space-between', marginBottom: 10 }}>
        <div>
          <b>@{a.senderHandle}</b> <span className="dim">→</span> <b>@{a.targetHandle}</b>{' '}
          <span className="pill info">touch {a.touchNumber}</span>{' '}
          <span className="pill">{a.variantLabel}</span>
        </div>
        <button onClick={() => setOpen((v) => !v)}>{open ? 'Hide' : 'Show'} message</button>
      </div>

      {a.campaignPermalink ? (
        <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
          Hook from{' '}
          <a href={a.campaignPermalink} target="_blank" rel="noreferrer">
            the detected campaign ↗
          </a>
          {a.hookLine ? <> — “{a.hookLine}”</> : null}
        </div>
      ) : (
        <div className="dim" style={{ fontSize: 12, marginBottom: 8 }}>
          No campaign in the hook window — sending with a generic opener.
        </div>
      )}

      {open ? <pre className="msg">{a.body}</pre> : null}

      <div className="btnrow" style={{ marginTop: 12 }}>
        <button onClick={copy}>{copied ? '✓ Copied' : 'Copy message'}</button>
        <a className="btn" href={`https://ig.me/m/${a.targetHandle}`} target="_blank" rel="noreferrer">
          Open DM thread ↗
        </a>
        <button
          className="primary"
          disabled={pending}
          onClick={() => start(() => markSent(a.id))}
          title="Only after the DM has actually gone out — this starts the cooldown"
        >
          {pending ? 'Saving…' : 'Mark sent'}
        </button>
        <button
          disabled={pending}
          onClick={() => start(() => skipAttempt(a.id, 'skipped by operator'))}
          title="Discard without sending. Does not start the cooldown."
        >
          Skip
        </button>
      </div>
    </div>
  )
}
