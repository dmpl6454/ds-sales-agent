import type { SentMessage } from '../view-model/messages-page'

/**
 * What actually went out.
 *
 * `sentBy` is STORED verbatim and always will be: months later that string is the only record
 * of HOW a message went — `autopilot:` with nobody present, `operator:` on a click,
 * `override(...)` when a person crossed a rule, `cli:` from a terminal.
 *
 * It used to be RENDERED verbatim too, and reading the page settled that: the column showed
 * `override(target-replied):tabishmukaddam1` on a screen whose stated audience is a CEO. Step F
 * turns it into a sentence, and the one thing that sentence must never do is make an override
 * read as though the system decided it was fine — so a crossed rule is named, in words, in warn
 * colour. See `describeSentBy`.
 */
export function SentList({ recent }: { recent: SentMessage[] }) {
  if (recent.length === 0) {
    return (
      <section className="group">
        <h2>Nothing delivered yet</h2>
        <p className="group-blurb">No message has reached a recipient from this system.</p>
      </section>
    )
  }

  return (
    <>
      {/*
        ── THERE IS NO REPLY BLOCK HERE ANY MORE ────────────────────────────

        This component used to render its own "Someone replied (n)" section above the table,
        with the reply text and its own release button. That was right when it lived on
        `/messages` and nothing else on that page mentioned replies.

        Step D moved it to `/conversations`, where `RepliesPanel` already renders exactly that —
        so the page showed the same reply twice, ten lines apart, each with a button that does
        the same thing. Found by reading the rendered page, not by reading the diff.

        Two controls for one act is worse than none: an operator who presses the first and sees
        the second still sitting there concludes it did not work.
      */}
      <section className="group">
        <h2>Delivered ({recent.length})</h2>
        <table className="sent-table">
          <thead>
            <tr>
              <th>When</th>
              <th>From</th>
              <th>To</th>
              <th>How</th>
              <th>Thread</th>
            </tr>
          </thead>
          <tbody>
            {recent.map((r) => (
              <tr key={r.id} className={r.replied ? 'row-replied' : undefined}>
                <td>{r.sentAt ? r.sentAt.toLocaleString('en-GB', { timeZone: 'Asia/Kolkata' }) : '—'}</td>
                <td>@{r.senderHandle}</td>
                <td>
                  {/*
                    `{' '}` is load-bearing. Without it JSX drops the space between the
                    expression and the next line's element, and this rendered
                    "@bollywoodchroniclereplied" on the live page. Already in CLAUDE.md's
                    gotcha list from a different screen; found here by reading the text
                    content rather than looking at the layout.
                  */}
                  @{r.targetHandle}{' '}
                  {r.replied && <span className="chip chip-soft">replied</span>}
                </td>
                <td className="how">{describeSentBy(r.sentBy)}</td>
                <td>
                  {r.threadUrl ? (
                    <a href={r.threadUrl} target="_blank" rel="noreferrer">
                      open
                    </a>
                  ) : (
                    <span className="muted">not recorded</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </>
  )
}

/**
 * `sentBy` as a sentence. Presentation only — the stored string is untouched.
 *
 * The forms, all of them produced by code in this repo:
 *
 *   autopilot:<handle>            nobody was present
 *   operator:<email|handle>       a person pressed Send
 *   override(<codes>):<who>       a person crossed one or more rules, deliberately
 *   cli:<name>                    typed in a terminal
 *   auto / auto:<handle>          an older form of the autopilot marker
 *
 * An UNRECOGNISED value is returned as-is rather than guessed at. This is an audit column; a
 * prettifier that silently swallowed a form it did not know would hide exactly the send someone
 * is looking for.
 */
function describeSentBy(raw: string | null): React.ReactNode {
  if (!raw) return <span className="muted">not recorded</span>

  const override = raw.match(/^override\(([^)]*)\):(.*)$/)
  if (override) {
    const codes = override[1]!.split(',').map((c) => c.trim()).filter(Boolean)
    return (
      <span className="how-override" title={raw}>
        a person, crossing {codes.length === 1 ? 'one rule' : `${codes.length} rules`}: {codes.join(', ')}
      </span>
    )
  }

  if (raw === 'auto' || raw.startsWith('auto:') || raw.startsWith('autopilot:')) {
    return <span title={raw}>by itself, nobody present</span>
  }
  if (raw.startsWith('operator:')) {
    return <span title={raw}>a person pressed Send</span>
  }
  if (raw.startsWith('cli:')) {
    return <span title={raw}>from a terminal</span>
  }
  // Never guessed at. See the docblock.
  return <span className="mono" title={raw}>{raw}</span>
}
