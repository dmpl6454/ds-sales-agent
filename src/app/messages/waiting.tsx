import type { MessagesPageView } from '../view-model/messages-page'

/**
 * THE QUEUE: "UP NEXT" FIRST, THEN THE PER-SENDER COUNTS.
 *
 * Tabish, 2026-08-19: *"Always the queue must be visible as an 'Up next' in the UI such
 * that users can see who is sending next in our round format"* — and, from the same
 * instruction, blockers must be visible when they occur.
 *
 * The order shown is the dispatcher's own pick order (oldest draft first), read by the
 * same query — never a re-derivation, so this panel can never name a different "next"
 * than the one that actually sends. The head row carries the live gate verdict from
 * `recheckBeforeSend`, the same call the dispatcher makes: when the front of the queue
 * is held, the reason is the enforcer's own sentence, on the row it is about.
 *
 * The per-draft card wall stays gone (2026-08-18): every draft is the same standard
 * template, so beyond WHO sends to WHOM next there is nothing per-row to show.
 */
export function WaitingList({
  queue,
  upNext,
  total,
}: {
  queue: MessagesPageView['queueBySender']
  upNext: MessagesPageView['upNext']
  total: number
}) {
  return (
    <section>
      <h2>Up next ({total} waiting)</h2>
      {total === 0 ? (
        <p className="cardnote">
          Nothing is waiting. New drafts are written automatically when there is someone new to write to.
        </p>
      ) : (
        <>
          <table className="table">
            <thead>
              <tr>
                <th>#</th>
                <th>From account</th>
                <th>To</th>
                <th>Turn comes</th>
              </tr>
            </thead>
            <tbody>
              {upNext.map((row) => (
                <tr key={`${row.senderHandle}-${row.targetHandle}`}>
                  <td>{row.position}</td>
                  <td>@{row.senderHandle}</td>
                  <td>@{row.targetHandle}</td>
                  <td>
                    {row.etaMinutes <= 0 ? 'next tick' : `in ~${row.etaMinutes} min`}
                    {row.note ? (
                      <span className={row.held ? ' note-warn' : ' note-good'}> — {row.note}</span>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="cardnote">
            {total > upNext.length ? <>{total - upNext.length} more wait behind these. </> : null}
            Times assume Autopilot is on, inside sending hours (10:00&ndash;21:00 IST), one message per
            gap. Each recipient&rsquo;s account was chosen by the rotation; oldest draft goes first.
          </p>

          <h3>Waiting per account</h3>
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
