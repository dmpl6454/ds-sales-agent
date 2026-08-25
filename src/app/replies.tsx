import type { ReplyCard } from './view-model'

/**
 * Someone answered. The only event on this page that represents revenue.
 *
 * ── IT IS A NOTICE, NOT A CONTROL (2026-08-25, Tabish) ──────────────────────
 *
 * This card used to carry two buttons — "I have replied" (an early release of the halt)
 * and "Open inbox". Both are GONE on his instruction: *"There is no need for clicking 'I
 * have replied' or 'Open Inbox'. Remove this entirely, fleet resumes on its own after 7
 * days anyways."* He is right about the mechanism — `replyHaltActive` releases on its own
 * `replyResumeHours` after the reply was WRITTEN — and the measurement agreed with him:
 * across all 71 replies this system has ever recorded, the button had been pressed ZERO
 * times.
 *
 * TWO THINGS HAD TO CHANGE WITH THE BUTTONS, or removing them would have been a
 * regression rather than a simplification:
 *
 *   1. The list feeding this is now WINDOWED by the halt (`conversations-page.ts`). It was
 *      filtered on `replyHandledAt: null` alone, which was survivable only while a button
 *      existed to set that column. With the button gone, an unwindowed list is a
 *      notification with no dismissal — the exact failure the original version of this
 *      file was written to fix, reintroduced from the other end.
 *   2. The card STATES WHEN IT FREES UP. With nothing to press, "when does this release"
 *      is the only question left, and `whenLabel` cannot answer it: that is the
 *      OBSERVATION clock (`repliedAt`, when the sweep found it) while the countdown runs
 *      on `replyPostedAt` (when they wrote). Measured on live rows, those differ by up to
 *      24 hours, so an age alone is not a release date.
 *
 * The preview reads `replyText` and nothing else. It used to read `OutreachAttempt.error`
 * — a column for send failures — because no field for reply content existed, so a message
 * that failed and was later marked replied would have displayed its own error string as
 * the recipient's words. When there is no text it SAYS so rather than inventing a quote:
 * 28 of the 71 live replies were recorded from an inbox row that carried a state
 * ("2 new messages") rather than words.
 */
export function RepliesPanel({ replies }: { replies: ReplyCard[] }) {
  if (replies.length === 0) return null

  return (
    <section className="replies">
      {replies.map((r) => (
        <div className="reply" key={r.attemptId}>
          <div className="reply-top">
            <strong>{r.targetName} replied</strong>
            <span className="when">{r.whenLabel}</span>
          </div>

          {r.preview ? (
            <p className="preview">“{r.preview}”</p>
          ) : (
            // Never fabricate a quote. A reply recorded from an inbox row that showed a
            // STATE rather than words genuinely has no text, and an empty quotation mark
            // reads as though they said nothing.
            <p className="preview dim">Reply recorded — no text was captured.</p>
          )}

          <div className="reply-foot">
            <span>to {r.senderName}</span>
            <span className="when">{r.freesLabel}</span>
          </div>
        </div>
      ))}
    </section>
  )
}
