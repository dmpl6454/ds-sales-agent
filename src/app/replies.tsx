'use client'

import { useState, useTransition } from 'react'
import { markReplyHandled } from './actions'
import type { ReplyCard } from './view-model'
import { dmInboxUrl } from '@/lib/urls'

/**
 * Someone answered. The only event on this page that represents revenue.
 *
 * Two things this had to fix.
 *
 * The preview used to render `OutreachAttempt.error` — a column for send failures —
 * because no field for reply content existed. A message that failed and was later
 * marked replied would have shown its own error string as the recipient's words.
 * It now reads `replyText`, and when that is empty it says so rather than inventing
 * a quote.
 *
 * And a reply could never be cleared. It halts every sender to that channel, which
 * is right, but nothing could release the halt: the card and its to-do sat on the
 * dashboard permanently, the channel showed "on hold" forever, and the only exit was
 * editing the database. A notification with no dismissal stops being read — which
 * defeats the whole point of the one event that matters most.
 *
 * SINCE 2026-08-07 the halt also releases ITSELF after a day (Tabish's decision — see
 * src/outreach/replyHalt.ts), so this card only shows replies inside that window and
 * "I have replied" is an early release, not the only exit.
 */
export function RepliesPanel({ replies }: { replies: ReplyCard[] }) {
  if (replies.length === 0) return null

  return (
    <section className="replies">
      {replies.map((r) => (
        <ReplyItem key={r.attemptId} reply={r} />
      ))}
    </section>
  )
}

function ReplyItem({ reply }: { reply: ReplyCard }) {
  const [pending, start] = useTransition()
  const [error, setError] = useState<string | null>(null)

  const handled = () => {
    setError(null)
    start(async () => {
      const r = await markReplyHandled(reply.attemptId)
      if (!r.ok) setError(r.message)
    })
  }

  return (
    <div className="reply">
      <div className="reply-top">
        <strong>{reply.targetName} replied</strong>
        <span className="when">{reply.whenLabel}</span>
      </div>

      {reply.preview ? (
        <p className="preview">“{reply.preview}”</p>
      ) : (
        // Never fabricate a quote. A reply recorded by hand may genuinely have no
        // text, and an empty quotation mark reads as though they said nothing.
        <p className="preview dim">Reply recorded — open the inbox to read it.</p>
      )}

      <div className="reply-foot">
        <span>to {reply.senderName}</span>
        <div className="reply-actions">
          <a className="btn" href={dmInboxUrl()} target="_blank" rel="noreferrer">
            Open inbox
          </a>
          <button onClick={handled} disabled={pending} title="Messaging resumes by itself after a day — this resumes it now">
            {pending ? 'Saving…' : 'I have replied'}
          </button>
        </div>
      </div>

      {error ? <p className="cardnote note-warn">⚠ {error}</p> : null}
    </div>
  )
}
