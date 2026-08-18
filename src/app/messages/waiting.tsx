import type { MessagesPageView } from '../view-model/messages-page'

/**
 * THE QUEUE, AS A SUMMARY (2026-08-18, Tabish's instruction).
 *
 * *"we do not need to see every draft as now we need only a single template message"* —
 * every waiting draft carries the identical standard template, so a wall of twenty cards
 * showing twenty copies of one body earned nothing. What a reader actually needs from the
 * queue is three facts: how deep it is, which accounts it is spread across, and why it is
 * not moving right now. The first two are here; the third is the pace band beside it,
 * which carries the dispatcher's own hold reason from the enforcer itself.
 *
 * The per-draft view (body, per-draft gate verdict, edit/send/discard buttons) was
 * deliberately removed, not collapsed. Manual sending survives in "Send a message now"
 * below, which writes and sends one message with every rule named.
 */
export function WaitingList({ queue, total }: { queue: MessagesPageView['queueBySender']; total: number }) {
  return (
    <section>
      <h2>The queue ({total})</h2>
      {total === 0 ? (
        <p className="cardnote">
          Nothing is waiting. New drafts are written automatically when there is someone new to write to.
        </p>
      ) : (
        <>
          <p className="cardnote">
            {total} message{total === 1 ? '' : 's'} written and waiting — every one is the standard template. They go
            out one at a time while Autopilot is on.
          </p>
          <table className="table">
            <thead>
              <tr>
                <th>From account</th>
                <th>Waiting</th>
              </tr>
            </thead>
            <tbody>
              {queue.map((row) => (
                <tr key={row.handle}>
                  <td>@{row.handle}</td>
                  <td>{row.count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </section>
  )
}
