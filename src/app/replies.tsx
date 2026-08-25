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
export function RepliesPanel({ replies }: { replies: ReplyCard[] }) {
  if (replies.length === 0) return null

  return (
    <details className="replies-fold">
      <summary>
        {replies.length === 1 ? '1 recipient has replied' : `${replies.length} recipients have replied`}
        <span className="muted"> — every account writing to them is paused</span>
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
            {replies.map((r) => (
              <tr key={r.attemptId}>
                <td>
                  {r.targetName}
                  {/* `{' '}` is load-bearing — JSX drops the space between an expression and
                      the next line's text, which put "@handlereplied" on a live page once. */}
                  {' '}
                  <span className="muted">@{r.targetHandle}</span>
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
                    /* Never a dead link dressed as a live one. Measured: 0 of 75 rows, but a
                       reply recorded by hand can genuinely have no thread URL. */
                    <span className="muted">no thread recorded</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  )
}
