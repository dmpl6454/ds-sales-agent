'use client'

import { useState } from 'react'
import { requeueParkedAttempt, skipAttempt } from '../actions'
import type { MessagesPageView } from '../view-model/messages-page'

/**
 * Drafts the retry cap parked: they failed the same way several times, nothing was
 * delivered (every failure code here is in the provably-undelivered class — the
 * may-have-arrived case has its own list above), and nothing automatic will touch them
 * again.
 *
 * Parking is only safe because of this list. MEASURED the morning the cap shipped: one
 * recipient whose profile opened a dialog instead of a message box was retried once a
 * minute, each retry driving a real Chrome profile at Instagram, and the whole queue
 * waited behind it. The cap stops the loop; this card is what stops the stopped draft
 * from being forgotten.
 *
 * Two controls, because the two situations are different: the CAUSE was fixed (a code
 * change, Instagram recovered) → back in the queue, tries again from the start; or the
 * recipient simply cannot be messaged → discard, and consider retiring them on /targets.
 */
export function ParkedList({ parked }: { parked: MessagesPageView["parked"] }) {
  if (parked.length === 0) return null

  return (
    <section className="group">
      <h2>Gave up after repeated failures ({parked.length})</h2>
      <p className="group-blurb">
        These failed the same way several times, so they stopped being retried — nothing was delivered. Fix
        what stopped them and put them back in the queue, or discard them and retire the recipient if they
        simply cannot be messaged.
      </p>
      <div className="group-rows">
        {parked.map((m) => (
          <ParkedCard key={m.id} m={m} />
        ))}
      </div>
    </section>
  )
}

function ParkedCard({ m }: { m: MessagesPageView["parked"][number] }) {
  const [busy, setBusy] = useState<'requeue' | 'discard' | null>(null)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [done, setDone] = useState(false)

  const act = async (which: 'requeue' | 'discard') => {
    setBusy(which)
    setMsg(null)
    try {
      const r =
        which === 'requeue'
          ? await requeueParkedAttempt(m.id)
          : await skipAttempt(m.id, 'discarded from the parked list')
      setMsg({ ok: r.ok, text: r.message })
      if (r.ok) setDone(true)
    } finally {
      setBusy(null)
    }
  }

  if (done && msg) return <div className="message"><p className="muted">{msg.text}</p></div>

  return (
    <div className="message group-broken">
      <div className="message-head">
        <strong>
          @{m.senderHandle} → @{m.targetHandle}
        </strong>
        <span className="muted">
          failed {m.attempts} time{m.attempts === 1 ? '' : 's'}
          {m.failureCode ? ` — ${m.failureCode}` : ''}
        </span>
      </div>
      {m.error ? <p className="muted">{m.error}</p> : null}
      <div className="message-actions">
        <button className="btn-primary" disabled={busy !== null} onClick={() => act('requeue')}>
          {busy === 'requeue' ? 'Re-queuing…' : 'Try again'}
        </button>
        <button className="btn-quiet" disabled={busy !== null} onClick={() => act('discard')}>
          {busy === 'discard' ? 'Discarding…' : 'Discard'}
        </button>
      </div>
      {msg && !done ? <p className="muted">{msg.text}</p> : null}
    </div>
  )
}
