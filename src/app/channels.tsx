'use client'

import { useState } from 'react'
import { addTarget, removeTarget } from './actions'
import type { ChannelCard } from './view-model'

/**
 * The channels being watched, and adding or removing them.
 *
 * Removal is not deletion when a channel has been contacted. The record of what was
 * sent to whom is what the spacing rule, the unanswered-touch cap and the
 * new-material rule are computed from — throwing it away would let the system write
 * to someone it has already written to, which is the single worst outcome here. So a
 * contacted channel is retired: marked never-contact and kept. A channel that was
 * never messaged has no such history and is simply deleted.
 */
export function ChannelsPanel({ channels }: { channels: ChannelCard[] }) {
  const [adding, setAdding] = useState(false)
  const watched = channels.filter((c) => !c.retired)
  const retired = channels.filter((c) => c.retired)

  return (
    <section>
      <h2>
        Channels we watch
        <span className="h2-note">
          {watched.length} channel{watched.length === 1 ? '' : 's'} checked four times a day
        </span>
      </h2>

      <div className="cards">
        {watched.map((c) => (
          <ChannelBlock key={c.handle} channel={c} />
        ))}
      </div>

      {retired.length > 0 ? (
        <div className="retired-list">
          {retired.map((c) => (
            <div key={c.handle} className="retired-row">
              <span className="dot" aria-hidden />
              <span className="acc-name">{c.name}</span>
              <span className="acc-handle">@{c.handle}</span>
              <span className="acc-note">retired — never contacted again, history kept</span>
            </div>
          ))}
        </div>
      ) : null}

      {adding ? (
        <AddChannelForm onDone={() => setAdding(false)} />
      ) : (
        <div className="row">
          <button onClick={() => setAdding(true)}>Add a channel</button>
        </div>
      )}
    </section>
  )
}

function ChannelBlock({ channel: c }: { channel: ChannelCard }) {
  const [busy, setBusy] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  const remove = async () => {
    setBusy(true)
    try {
      const r = await removeTarget(c.handle)
      setMsg(r.message)
      setConfirm(false)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="card">
      <div className="card-top">
        <a href={`https://instagram.com/${c.handle}`} target="_blank" rel="noreferrer">
          {c.name}
        </a>
        <span className="followers">{c.followers}</span>
      </div>
      <dl>
        <div>
          <dt>Posts read this week</dt>
          <dd>{c.postsThisWeek}</dd>
        </div>
        <div>
          <dt>Paid campaigns found</dt>
          <dd>{c.unclassified ? <span className="dim">not classified</span> : c.campaignsThisWeek}</dd>
        </div>
        <div>
          <dt>Last contacted</dt>
          <dd>{c.lastContactedLabel}</dd>
        </div>
      </dl>

      {c.unclassified ? (
        <p className="cardnote">
          This channel never labels its paid posts, so we record every post but do not guess which are paid. Showing a
          zero here would read as “they do no paid work”, which is untrue.
        </p>
      ) : null}
      {c.halted && !c.retired ? <div className="halt">On hold — they replied</div> : null}

      {confirm ? (
        <div className="connect-strip warn">
          {c.everContacted
            ? `We have already messaged @${c.handle}. Removing marks it never-contact and keeps that record, so nobody there is written to twice.`
            : `@${c.handle} has never been messaged, so it will be deleted outright.`}
          <button className="link-btn" onClick={remove} disabled={busy}>
            {busy ? 'Removing…' : c.everContacted ? 'Yes, stop messaging' : 'Yes, delete'}
          </button>
          <button className="link-btn" onClick={() => setConfirm(false)}>
            Keep it
          </button>
        </div>
      ) : (
        <button className="link-btn" onClick={() => setConfirm(true)}>
          Remove this channel
        </button>
      )}

      {msg ? <p className="cardnote">{msg}</p> : null}
    </div>
  )
}

function AddChannelForm({ onDone }: { onDone: () => void }) {
  const [handle, setHandle] = useState('')
  const [name, setName] = useState('')
  const [greeting, setGreeting] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  const submit = async () => {
    setBusy(true)
    setMsg(null)
    try {
      const r = await addTarget(handle, name, greeting)
      setMsg({ ok: r.ok, text: r.message })
      if (r.ok) {
        setHandle('')
        setName('')
        setGreeting('')
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="addform">
      <div className="addform-row">
        <label>
          <span>Instagram handle</span>
          <input
            value={handle}
            onChange={(e) => setHandle(e.target.value)}
            placeholder="madovermarketing_mom"
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        <label>
          <span>Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Mad Over Marketing" autoComplete="off" />
        </label>
        <label>
          <span>Greeting</span>
          <input
            value={greeting}
            onChange={(e) => setGreeting(e.target.value)}
            placeholder="Mad Over Marketing"
            autoComplete="off"
          />
        </label>
        <button className="primary" onClick={submit} disabled={busy || handle.trim().length === 0}>
          {busy ? 'Adding…' : 'Add'}
        </button>
        <button onClick={onDone} disabled={busy}>
          Cancel
        </button>
      </div>
      <p className="cardnote">
        Greeting is what they literally read first — “Hi <em>Mad Over Marketing</em>,”. New channels start with every
        account switched off; turn them on per account above. Posts are recorded but not classified as paid or not,
        because a guess on an unfamiliar channel would be worse than no answer.
      </p>
      {msg ? (
        <p className="cardnote" style={{ color: msg.ok ? 'var(--good)' : 'var(--warn)' }}>
          {msg.ok ? '✓ ' : '⚠ '}
          {msg.text}
        </p>
      ) : null}
    </div>
  )
}
