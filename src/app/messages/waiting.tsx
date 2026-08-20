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
const whenIst = (d: Date) =>
  d.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })

/**
 * The RESTING half of the queue, each row with the enforcer's own sentence and when it
 * frees up. Added 2026-08-19 after "the number changes but the list below it remains the
 * same" became "the count says 33 and the list is empty": a held draft that appears
 * nowhere reads as a stuck system, and the honest answer was one table away.
 */
function HeldList({ heldUpNext, heldWaiting }: { heldUpNext: MessagesPageView['heldUpNext']; heldWaiting: number }) {
  if (heldUpNext.length === 0) return null
  return (
    <>
      <h3>Resting ({heldWaiting} held)</h3>
      {/* .table-wrap: the "why" column carries whole sentences, and a wide table must
          scroll inside its own container — the page body must never scroll sideways. */}
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>From account</th>
              <th>To</th>
              <th>Why it waits</th>
              <th>Frees up</th>
            </tr>
          </thead>
          <tbody>
            {heldUpNext.map((row) => (
              <tr key={`${row.senderHandle}-${row.targetHandle}`}>
                <td>@{row.senderHandle}</td>
                <td>@{row.targetHandle}</td>
                <td>{row.why}</td>
                <td>{whenIst(row.resumesAt)} IST</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {heldWaiting > heldUpNext.length ? (
        <p className="cardnote">
          {heldWaiting - heldUpNext.length} more are resting behind these, on the same two rules.
        </p>
      ) : null}
    </>
  )
}

export function WaitingList({
  queue,
  upNext,
  heldWaiting,
  heldUpNext,
  total,
  autopilotOn,
}: {
  queue: MessagesPageView['queueBySender']
  upNext: MessagesPageView['upNext']
  heldWaiting: number
  heldUpNext: MessagesPageView['heldUpNext']
  total: number
  /**
   * With this false the dispatcher holds every tick on `autopilot-off` and NOTHING in this
   * list is going anywhere. The panel used to render ETAs and "clear to send on the next
   * tick" regardless, so a deliberately-paused fleet read as a stuck one — the queue looked
   * frozen on every refresh while the page insisted it was draining.
   */
  autopilotOn: boolean
}) {
  const sendable = total - heldWaiting
  const firstFree = heldUpNext[0]
  return (
    <section>
      <h2>Up next ({total} waiting)</h2>
      {total === 0 ? (
        <p className="cardnote">
          Nothing is waiting. New drafts are written automatically when there is someone new to write to.
        </p>
      ) : upNext.length === 0 ? (
        <>
          <p className="cardnote">
            Nothing is sendable right now{firstFree ? <> until {whenIst(firstFree.resumesAt)} IST</> : null} &mdash; all{' '}
            {total} waiting {total === 1 ? 'draft is' : 'drafts are'} resting (spacing or a reply). Not a fault:{' '}
            {autopilotOn
              ? 'Autopilot is on and the dispatcher checks every minute, so each draft below sends itself when its window clears.'
              : 'each draft below is waiting for its window to clear AND for Autopilot to be switched back on.'}
          </p>
          <HeldList heldUpNext={heldUpNext} heldWaiting={heldWaiting} />
        </>
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
                    {row.etaMinutes === null
                      ? 'when Autopilot is on'
                      : row.etaMinutes <= 0
                        ? 'next tick'
                        : `in ~${row.etaMinutes} min`}
                    {row.note ? (
                      <span className={row.held ? ' note-warn' : ' note-good'}> — {row.note}</span>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="cardnote">
            {autopilotOn ? (
              <>
                These are the drafts that will actually go, oldest first &mdash; one every minute, any time of day.{' '}
              </>
            ) : (
              <>
                <strong>Autopilot is off, so none of these are going out.</strong> They are cleared to send and will
                start moving, oldest first, the moment you switch it on &mdash; or you can send any of them by hand.{' '}
              </>
            )}
            {sendable > upNext.length ? <>{sendable - upNext.length} more are clear behind them. </> : null}
            {heldWaiting > 0 ? (
              <>
                {heldWaiting} other {heldWaiting === 1 ? 'draft is' : 'drafts are'} resting and listed below.
              </>
            ) : null}
          </p>

          <HeldList heldUpNext={heldUpNext} heldWaiting={heldWaiting} />

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
