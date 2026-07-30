'use client'

import { useState, useTransition } from 'react'
import { markSent, skipAttempt } from './actions'
import type { AwaitingCard } from './view-model'

/**
 * Messages the agent has written, ready for a human to send.
 *
 * This is the permanent design, not a transitional state. Research on 2026-07-30
 * established that automating the click saves about ninety seconds a day and
 * destroys the device-identity continuity that keeps these accounts safe — so the
 * agent does everything up to the click, and stops.
 *
 * `pnpm send` is the same flow from the terminal, with the message copied to the
 * clipboard and the recipient's profile opened for you.
 */
export function AwaitingList({ items }: { items: AwaitingCard[] }) {
  return (
    <section>
      <h2>
        Waiting for you to send
        <span className="h2-note">
          {items.length} message{items.length === 1 ? '' : 's'} — written and checked; you press send
        </span>
      </h2>
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

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(item.body)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      setCopied(false)
    }
  }

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
        <button onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
        <a className="btn" href={`https://ig.me/m/${item.targetHandle}`} target="_blank" rel="noreferrer">
          Open Instagram
        </a>
        <button
          className="primary"
          disabled={pending}
          onClick={() => start(() => markSent(item.id))}
          title="Only after you have actually sent it — this starts the waiting period before the next message"
        >
          {pending ? 'Saving…' : 'I sent it'}
        </button>
        <button disabled={pending} onClick={() => start(() => skipAttempt(item.id, 'skipped'))}>
          Skip
        </button>
      </div>
    </div>
  )
}
