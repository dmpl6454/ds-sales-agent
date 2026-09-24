import type { ReplyCard } from './view-model'

/**
 * WHO REPLIED — folded away until somebody wants it.
 *
 * ── WHAT CHANGED, AND WHY (2026-08-25, Tabish) ────────────────────────────
 *
 * *"remove the text being displayed in autopilot page for replies sent by people we have
 * messaged, just a collapsible and dynamic place where anyone who accesses the autopilot page
 * can expand to view channels who have apparently replied and a redirect link (with also the
 * sender mentioned who had sent the message) to that thread."*
 *
 * Right on both counts. At 75 stored replies the page was rendering 75 quotations — some of
 * them several paragraphs — above the queue, so the one screen that answers *"is it sending?"*
 * opened with a wall of somebody else's prose. And the text was never the actionable part: a
 * person who wants to answer a reply needs THE THREAD, and the thread needs the page it was
 * sent from, because Instagram DMs are per account PAIR and only that sender's profile can
 * open it.
 *
 * So each row is now: who replied · when · which of our pages · a link straight to that
 * conversation. MEASURED before building it — **all 75 reply rows carry a `threadUrl`**, so
 * the link is real on every row rather than a mostly-empty column.
 *
 * ── `<details>`, NOT A useState TOGGLE ────────────────────────────────────
 *
 * The whole file stays a SERVER component. A client toggle would drag the reply data into the
 * browser bundle, and this page has already been taken down once by exactly that shape
 * (`waiting.tsx` → `gate.ts` → `better-sqlite3`, HTTP 500 on every route). `<details>` is the
 * browser's own disclosure widget: it needs no JavaScript, it is keyboard accessible and
 * screen-reader announced for free, and the state survives a re-render — which matters here
 * because the page refreshes itself every 30-45 seconds.
 *
 * The COUNT is on the summary line, always visible. A collapsible whose closed state hides
 * whether there is anything inside is a control nobody opens.
 */
/** How many reply cards are drawn before the rest go behind the table. */
const SHOWN = 4

export function RepliesPanel({ replies }: { replies: ReplyCard[] }) {
  if (replies.length === 0) return null
  const shown = replies.slice(0, SHOWN)
  const rest = replies.slice(SHOWN)

  return (
    <>
      {/*
        ── THE DESIGN'S CARDS, BOUNDED ────────────────────────────────────────

        The design draws a card per reply: who, when, what they said. That is the right shape
        at the size it depicts, and the WRONG shape at the size this system reaches — at 75
        stored replies the page opened with 75 quotations, several of them paragraphs, above
        the queue, which is why they were folded into a table in the first place (2026-08-25).

        Both readings are honoured by bounding it: the newest four are cards, and everything
        behind them is one line and a table. A reader meets the design's card, and the page
        cannot become a wall of somebody else's prose as the corpus grows.

        THE "I HAVE REPLIED" BUTTON IS NOT DRAWN, and that is not an omission. It was removed
        on Tabish's instruction — "no need for clicking 'I have replied' … fleet resumes on its
        own after 7 days anyways" — and `markReplyHandled` was deleted with it. Re-adding the
        button would mean re-adding an early-release control nobody asked for; what replaces
        it on each card is the date the halt frees by itself, which is the fact it was hiding.
      */}
      <div className="grid-2">
        {shown.map((r) => (
          <div className="reply" key={r.attemptId}>
            <div className="reply-top">
              <span className="reply-who">@{r.targetHandle}</span>
              <span className="mono dim">{r.whenLabel}</span>
            </div>
            {r.preview ? (
              <p className="reply-text">&ldquo;{r.preview}&rdquo;</p>
            ) : (
              /* A reply the sweep recorded from an inbox row carries no text. Say so rather
                 than rendering empty quotation marks, which read as an empty message. */
              <p className="reply-text muted">They replied &mdash; the text was not captured.</p>
            )}
            <p className="reply-foot">
              from @{r.senderHandle} &middot; {r.freesLabel}
              {/* The separator travels WITH the link. Split across a wrap it left the card's
                  last line ending in a bare middot, which reads as a sentence that lost its
                  end rather than as a list that continued. */}
              {r.threadUrl ? (
                <span className="nowrap">
                  {' '}
                  &middot;{' '}
                  <a href={r.threadUrl} target="_blank" rel="noreferrer">
                    open the thread
                  </a>
                </span>
              ) : null}
            </p>
          </div>
        ))}
      </div>

      {rest.length > 0 ? (
        <details className="replies-fold">
          <summary>
            {rest.length} more {rest.length === 1 ? 'reply' : 'replies'}
          </summary>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Who replied</th>
                  <th>When</th>
                  <th>Our page</th>
                  <th>Frees up</th>
                  <th>Thread</th>
                </tr>
              </thead>
              <tbody>
                {rest.map((r) => (
                  <tr key={r.attemptId}>
                    <td>
                      {r.targetName} <span className="muted">@{r.targetHandle}</span>
                    </td>
                    <td className="muted">{r.whenLabel}</td>
                    {/* The HANDLE, not the display name: an Instagram thread can only be opened
                        from the profile that holds it, so this is the page to be signed in as. */}
                    <td className="muted">@{r.senderHandle}</td>
                    <td className="muted">{r.freesLabel}</td>
                    <td>
                      {r.threadUrl ? (
                        <a href={r.threadUrl} target="_blank" rel="noreferrer">
                          open the thread
                        </a>
                      ) : (
                        <span className="muted">no thread recorded</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      ) : null}
    </>
  )
}
