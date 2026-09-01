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
/**
 * Paging, when this list is showing a slice of the whole history rather than a recent window.
 *
 * OPTIONAL, so the callers that legitimately want "the newest few" keep working unchanged —
 * but when it is present the heading states the TRUE total, which is the fix: this component
 * rendered `Delivered ({recent.length})`, labelling the size of its own window as the total.
 */
export interface SentPaging {
  page: number
  pageCount: number
  total: number
  from: number
  to: number
  /** Builds the href for a page — the caller owns the URL shape and its other params. */
  hrefForPage: (page: number) => string
}

export function SentList({ recent, paging }: { recent: SentMessage[]; paging?: SentPaging }) {
  if (recent.length === 0 && !paging) {
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
        {/*
          THE HEADING STATES THE TRUE TOTAL (2026-08-21).

          It read `Delivered ({recent.length})` — the size of its own `take: 50` window,
          labelled as the total. At ~280 sends a day that is a number that is simply wrong,
          and it is the third face in three days of a bounded list read as a complete record.
          With paging present the heading says which slice of what, and never invents a total.
        */}
        <h2>Delivered ({paging ? paging.total : recent.length})</h2>
        {paging && paging.total > 0 && (
          <p className="group-blurb">
            Showing {paging.from}&ndash;{paging.to} of {paging.total} &middot; newest first &middot; page{' '}
            {paging.page} of {paging.pageCount}
          </p>
        )}
        {paging && paging.total === 0 && (
          <p className="group-blurb">No message has reached a recipient from this system yet.</p>
        )}
        {/*
          `.table-wrap` — the convention this file never used. A table cannot shrink below
          its content, so without it the widest row pushes the whole PAGE sideways, which
          `pnpm ig:layout` refuses (measured at 800px: 846 against 800). The rule is that
          wide content scrolls inside its own box; the page never does.
        */}
        <div className="table-wrap">
        <table className="sent-table">
          <thead>
            <tr>
              <th>When</th>
              <th>From</th>
              <th>To</th>
              <th>How</th>
              {/*
                WHY THIS MESSAGE EXISTS (Tabish, 2026-08-31: *"nowhere does a person …
                know why that particular message was sent to that person, for which paid
                post specifically"*).

                "How" says who pressed send; this says what earned it. They sit next to
                each other because together they are the whole account of one message —
                and the link goes to the post itself, so the claim can be checked against
                Instagram rather than believed.
              */}
              <th>Why</th>
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
                  {/*
                    FIRST MESSAGE OR FOLLOW-UP (2026-09-01). Both rows used to read the same,
                    and they are different facts: a follow-up is a second message to a company
                    that already heard from this page, permitted only by a paid post nobody had
                    written about — which the "Why" column beside it names. Without the chip a
                    reader cannot tell the two apart, and the feature would ship invisible.

                    Only from touch 2 up: a chip on every row would be furniture.
                  */}
                  {r.touchNumber > 1 && <span className="chip chip-soft">follow-up</span>}{' '}
                  {r.replied && <span className="chip chip-soft">replied</span>}
                </td>
                <td className="how">{describeSentBy(r.sentBy)}</td>
                <td className="how">
                  {r.provenance ? (
                    /* `title` carries which of the two facts this is — a claim against the
                       post, or the post that found them. Never guessed: an em-dash when no
                       stored column answers (messageProvenance.ts). */
                    <a href={r.provenance.url} target="_blank" rel="noreferrer" title={r.provenance.why}>
                      {r.provenance.label}
                    </a>
                  ) : (
                    <span className="muted">&mdash;</span>
                  )}
                </td>
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
        </div>

        {/*
          "AN ABILITY TO GO EVEN BEYOND" — plain links, not a client control.
          The page is `force-dynamic`, so a round trip costs what a re-render would have cost,
          and this way a position in the history survives a refresh and can be linked to or
          bookmarked — the same reasoning as the range selector on /analytics.

          First and Last are offered explicitly: with 280+ rows and growing, "the oldest
          message we ever sent" is a real question and stepping to it one page at a time is
          not an answer.
        */}
        {paging && paging.pageCount > 1 && (
          <nav className="seg" aria-label="History pages" style={{ marginTop: 10 }}>
            {paging.page > 1 ? (
              <>
                <a href={paging.hrefForPage(1)}>&laquo; Newest</a>
                <a href={paging.hrefForPage(paging.page - 1)}>&lsaquo; Newer</a>
              </>
            ) : null}
            <span className="muted" style={{ padding: '0 8px' }}>
              page {paging.page} of {paging.pageCount}
            </span>
            {paging.page < paging.pageCount ? (
              <>
                <a href={paging.hrefForPage(paging.page + 1)}>Older &rsaquo;</a>
                <a href={paging.hrefForPage(paging.pageCount)}>Oldest &raquo;</a>
              </>
            ) : null}
          </nav>
        )}
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
