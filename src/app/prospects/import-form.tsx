'use client'

import { useState } from 'react'
import { importProspectList } from '../actions'
import type { ImportOutcome } from '@/outreach/importProspects'

/**
 * Paste a list, see exactly what will happen, then commit.
 *
 * ── TWO CLICKS, AND THE FIRST ONE WRITES NOTHING ──────────────────────────
 *
 * The preview is not a formatting check: it parses, names every rejected line by number,
 * and asks Instagram whether each handle exists. So "42 will be added" means forty-two
 * accounts that are actually there, and the eight that are not are listed by name before
 * anything is created rather than discovered weeks later as routes that never send.
 *
 * Dry run by default is the same rule `ig:classify` and `ig:brands` follow, for the same
 * reason: this is the only bulk write on the dashboard, and the wrong sheet must cost
 * nothing.
 */
export function ImportForm() {
  const [text, setText] = useState('')
  const [preview, setPreview] = useState<ImportOutcome | null>(null)
  const [busy, setBusy] = useState<'preview' | 'commit' | null>(null)
  const [done, setDone] = useState<string | null>(null)

  const run = async (commit: boolean) => {
    setBusy(commit ? 'commit' : 'preview')
    setDone(null)
    try {
      const outcome = await importProspectList(text, commit)
      setPreview(outcome)
      if (commit) {
        /**
         * ONE SWITCH, 2026-08-08, and this correction is safety-relevant rather than cosmetic.
         *
         * It read "Every route is switched off … turn on what you want, when you want it." That
         * was true while pairs were created disabled and a human flipped a chip. It is FALSE now
         * — `importProspects` creates every allowed route `enabled: true` — so the old sentence
         * told an operator that importing a list was inert at exactly the moment it stopped
         * being inert. Overstating safety is the one direction this must never fail in.
         *
         * What IS still true is the second half, and it is the half that bounds the cost: they
         * are unwatched (`watchEnabled: false`), so no feed is read for them.
         */
        setDone(
          `${outcome.created} prospect(s) added. The fleet will write to them while Autopilot is on — ` +
            `their posts are not being read, which you can turn on per prospect below.`,
        )
        setText('')
      }
    } finally {
      setBusy(null)
    }
  }

  const willAdd = preview?.rows.filter((r) => r.status === 'created' || r.status === 'unconfirmed').length ?? 0

  return (
    <section className="group">
      <h2>Add prospects</h2>
      <p className="group-blurb">
        Paste a list — one handle per line, or a spreadsheet with a <code>handle</code> column. A{' '}
        <code>category</code> column puts them straight into a rotation group. Nothing is written until you press
        Import, and every handle is checked against Instagram first.
      </p>

      <textarea
        value={text}
        rows={8}
        placeholder={'handle,name,category\n@examplechannel,Example Channel,Bollywood\n@another_one,Another,Bollywood'}
        onChange={(e) => {
          setText(e.target.value)
          setPreview(null)
          setDone(null)
        }}
        disabled={busy !== null}
      />

      <div className="account-actions">
        <button type="button" onClick={() => run(false)} disabled={busy !== null || text.trim() === ''}>
          {busy === 'preview' ? 'Checking…' : 'Check the list'}
        </button>
        {preview && willAdd > 0 && (
          <button type="button" onClick={() => run(true)} disabled={busy !== null}>
            {busy === 'commit' ? 'Adding…' : `Import ${willAdd}`}
          </button>
        )}
      </div>

      {done && <p className="account-message">{done}</p>}

      {preview && !done && (
        <div className="message">
          <p>
            <strong>{willAdd}</strong> will be added
            {preview.rows.filter((r) => r.status === 'already-known').length > 0 && (
              <> · {preview.rows.filter((r) => r.status === 'already-known').length} already in the list</>
            )}
            {preview.rows.filter((r) => r.status === 'does-not-exist').length > 0 && (
              <> · {preview.rows.filter((r) => r.status === 'does-not-exist').length} do not exist on Instagram</>
            )}
          </p>

          {/*
            Rejected rows are shown WITH THEIR LINE NUMBER and never repaired. "Never guess
            a handle" has a measurement behind it — @royalcanin, invented from the display
            name "RoyalCanin", returns HTTP 404 — and a typo in a spreadsheet deserves the
            same treatment as a guess.
          */}
          {preview.parsed.rejected.length > 0 && (
            <>
              <p className="account-message bad">
                {preview.parsed.rejected.length} row(s) could not be read and were left out:
              </p>
              <ul className="plain-list">
                {preview.parsed.rejected.map((r) => (
                  <li key={r.line}>
                    line {r.line}: {r.reason}
                  </li>
                ))}
              </ul>
            </>
          )}

          {preview.rows.filter((r) => r.status === 'does-not-exist').length > 0 && (
            <ul className="plain-list">
              {preview.rows
                .filter((r) => r.status === 'does-not-exist')
                .map((r) => (
                  <li key={r.handle}>@{r.handle} — no such account, so it will not be added</li>
                ))}
            </ul>
          )}

          {preview.parsed.duplicates.length > 0 && (
            <p className="muted">
              Listed more than once, kept once: {preview.parsed.duplicates.map((d) => `@${d}`).join(', ')}
            </p>
          )}

          {/* No silent caps. A truncated import reporting success is how someone believes
              80 were added when 50 were, and finds out by wondering why a channel is quiet. */}
          {preview.parsed.overLimit > 0 && (
            <p className="account-message bad">
              {preview.parsed.overLimit} more row(s) are beyond what one import takes. Add these first, then paste the
              rest — each handle is checked against Instagram, so imports are deliberately small.
            </p>
          )}

          {preview.rows.some((r) => r.detail?.includes('OUR sending accounts')) && (
            <p className="muted">
              One of these is also an account you send FROM. That is allowed — it is how the send path is rehearsed
              safely — but it will never message itself.
            </p>
          )}
        </div>
      )}
    </section>
  )
}
