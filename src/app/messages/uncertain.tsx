'use client'

import { useState } from 'react'
import { resolveUncertainSend } from '../actions'
import type { UncertainMessage } from '../view-model/messages-page'

/**
 * Messages that may or may not have arrived, and the only way to settle it.
 *
 * ── WHAT HAPPENED, IN PLAIN TERMS ─────────────────────────────────────────
 *
 * Instagram accepted the keystroke — the message box emptied, which is what happens when a
 * message is sent — and then the message was not in the conversation afterwards. Two
 * explanations fit, and they point opposite ways:
 *
 *   the recipient HAS it and the page just did not show us, or
 *   the account is being quietly restricted and the message was dropped.
 *
 * Re-sending is the wrong move under BOTH readings, which is why these no longer go back
 * into the queue on their own. Before Phase 5 they did, and the next delivery tick sent
 * them again — to someone who probably already had it, from an account that may be
 * restricted.
 *
 * ── AND WHY IT IS A PERSON WHO DECIDES ────────────────────────────────────
 *
 * Nothing we can read from here distinguishes the two. Opening the conversation does. So
 * this asks for the one fact only a human can supply, and the two answers do genuinely
 * different things: confirming delivery records it as sent and keeps the recipient's daily
 * allowance spent; confirming nothing arrived hands the allowance back and returns the
 * message to the queue.
 */
export function UncertainList({ uncertain }: { uncertain: UncertainMessage[] }) {
  if (uncertain.length === 0) return null

  return (
    <section className="group">
      <h2>Check the conversation ({uncertain.length})</h2>
      <p className="group-blurb">
        Instagram took these messages and then did not show them in the conversation. They have <strong>not</strong>{' '}
        been re-sent, because the recipient may already have them. Open the conversation, see whether it is there, and
        say which it was — that is the only way to know.
      </p>
      <div className="group-rows">
        {uncertain.map((m) => (
          <UncertainCard key={m.id} m={m} />
        ))}
      </div>
    </section>
  )
}

function UncertainCard({ m }: { m: UncertainMessage }) {
  const [busy, setBusy] = useState<'yes' | 'no' | null>(null)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [done, setDone] = useState(false)

  const resolve = async (verdict: 'delivered' | 'not-delivered') => {
    setBusy(verdict === 'delivered' ? 'yes' : 'no')
    setMsg(null)
    try {
      const r = await resolveUncertainSend(m.id, verdict)
      setMsg({ ok: r.ok, text: r.message })
      if (r.ok) setDone(true)
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="message group-broken">
      <div className="message-head">
        <strong>
          @{m.senderHandle} → @{m.targetHandle}
        </strong>
        <span className="muted">
          {m.attempts} attempt{m.attempts === 1 ? '' : 's'}
        </span>
      </div>

      {/*
        A link, not a shell command. `pnpm ig:thread` does the same job better from a
        terminal, and putting it here would be a developer instruction standing in for
        something the page can simply offer — the mistake the old "Needs you" list made
        three times over.
      */}
      <p>
        <a href={m.profileUrl} target="_blank" rel="noreferrer">
          Open @{m.targetHandle} on Instagram
        </a>{' '}
        <span className="muted">and look for this message in the conversation.</span>
      </p>

      {/*
        The confirmation is rendered OUTSIDE the block the success path hides. A "Saved."
        message inside a section that unmounts on success is never seen — that has already
        happened here once, with the persona editor.
      */}
      {msg && <p className="account-message">{msg.text}</p>}

      {!done && (
        <div className="account-actions">
          <button type="button" onClick={() => resolve('delivered')} disabled={busy !== null}>
            {busy === 'yes' ? 'Recording…' : 'It is there — they got it'}
          </button>
          <button type="button" onClick={() => resolve('not-delivered')} disabled={busy !== null}>
            {busy === 'no' ? 'Re-queueing…' : 'Nothing arrived — send it again'}
          </button>
        </div>
      )}
    </div>
  )
}
