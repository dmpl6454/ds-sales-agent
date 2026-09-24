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
function HeldList({
  heldUpNext,
  heldWaiting,
  resting,
}: {
  heldUpNext: MessagesPageView['heldUpNext']
  heldWaiting: number
  /**
   * The FLEET-WIDE resting figure, which is a different population from the rows below and
   * that is the whole reason it is in the heading. These rows are drafts that exist and are
   * held; `resting` counts companies the planner refused to write for at all, so they have no
   * draft and appear in no list. A heading saying only "2 held" over a system holding back 86
   * companies is the defect this page has produced twice — a bounded list read as the whole
   * record. Null when the tally could not be read, and then the heading says only what it knows.
   */
  resting: { resting: number; total: number } | null
}) {
  if (heldUpNext.length === 0) return null
  /**
   * The one sentence every held row shares, or null when they genuinely differ. Verbatim
   * from the gate either way — this decides WHERE it is rendered, never what it says.
   */
  const reasons = new Set(heldUpNext.map((r) => r.why))
  const oneReason = reasons.size === 1 ? heldUpNext[0]!.why : null
  return (
    <>
      <h3 className="held-head">
        {resting
          ? `Resting — ${resting.resting}/${resting.total} companies on cooldown or cap (${heldWaiting} held here)`
          : `Resting (${heldWaiting} held)`}
      </h3>
      {/*
        ONE BORDERED SURFACE OF HAIRLINE ROWS, which is what the design draws and what a
        bare <table> could not be: with no container the last column ran out to the page
        edge, so four columns of one row read as four unrelated things. The tracks are a
        grid shared by the header and every row, and the "why" track is `minmax(0, 1fr)`
        so the enforcer's own sentence WRAPS inside its column instead of widening the row.

        AND WHEN EVERY ROW WAITS ON THE SAME RULE, THE SENTENCE IS SAID ONCE, below the
        panel. The material rule holds most of this queue most of the time, so the "why"
        column was routinely the same twenty-five words repeated down the page — and a fact
        met twice teaches a reader to skip both. Nothing is summarised or re-derived: it is
        still the enforcer's own sentence, verbatim, and the moment two rows genuinely
        differ the column comes back and each row carries its own.
      */}
      <div className={`rows qrows ${oneReason ? 'qrows-held-3' : 'qrows-held'}`}>
        <div className="qhead">
          <span>From account</span>
          <span>To</span>
          {oneReason ? null : <span>Why it waits</span>}
          <span className="qright">Frees up</span>
        </div>
        {heldUpNext.map((row) => (
          <div className="qrow" key={`${row.senderHandle}-${row.targetHandle}`}>
            <span className="qhandle">@{row.senderHandle}</span>
            <span className="qhandle">@{row.targetHandle}</span>
            {oneReason ? null : <span className="qwhy">{row.why}</span>}
            <span className="qright dim">{whenIst(row.resumesAt)} IST</span>
          </div>
        ))}
      </div>
      {oneReason ? (
        <p className="cardnote lede">
          {heldUpNext.length === 1 ? 'It waits' : 'All of them wait'} on one rule: {oneReason}
        </p>
      ) : null}
      {heldWaiting > heldUpNext.length ? (
        <p className="cardnote">
          {heldWaiting - heldUpNext.length} more are resting behind these, on the same two rules.
        </p>
      ) : null}
    </>
  )
}

export function WaitingList({
  upNext,
  heldWaiting,
  heldUpNext,
  total,
  autopilotOn,
  resting,
}: {
  upNext: MessagesPageView['upNext']
  heldWaiting: number
  heldUpNext: MessagesPageView['heldUpNext']
  total: number
  /** Fleet-wide resting companies, for the heading above the held rows — see `HeldList`. */
  resting: { resting: number; total: number } | null
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
          <HeldList heldUpNext={heldUpNext} heldWaiting={heldWaiting} resting={resting} />
        </>
      ) : (
        <>
          <div className="rows qrows qrows-next">
            <div className="qhead">
              <span>#</span>
              <span>From account</span>
              <span>To</span>
              <span>Turn comes</span>
            </div>
            {upNext.map((row) => (
              <div className="qrow" key={`${row.senderHandle}-${row.targetHandle}`}>
                <span className="qpos">{row.position}</span>
                <span className="qhandle">@{row.senderHandle}</span>
                <span className="qhandle">@{row.targetHandle}</span>
                <span className="dim">
                  {row.etaMinutes === null
                    ? 'when Autopilot is on'
                    : row.etaMinutes <= 0
                      ? 'next tick'
                      : `in ~${row.etaMinutes} min`}
                  {row.note ? (
                    <span className={row.held ? ' note-warn' : ' note-good'}> &mdash; {row.note}</span>
                  ) : null}
                </span>
              </div>
            ))}
          </div>
          <p className="cardnote lede">
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

          {/*
            "Waiting per account" is GONE (the design has no such table). It counted the same
            drafts the two tables above already list by name, so a reader met every waiting
            draft three times — and duplication is a failure of the same kind as silence: a
            fact seen three times teaches a reader to skip all three.
          */}
          <HeldList heldUpNext={heldUpNext} heldWaiting={heldWaiting} resting={resting} />
        </>
      )}
    </section>
  )
}
