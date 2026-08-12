'use client'

import { useState } from 'react'
import { setTargetWatch } from '../actions'
import type { ProspectRow } from '../view-model/prospects-page'

/**
 * Everyone we might write to, and the ONE decision a person still makes about each: do we
 * read their posts.
 *
 * NOT a chip per route, and since 2026-08-08 not a route count either. At 65 senders and 60
 * targets a chip per route is 3,900 controls, which was never a layout problem — it is the
 * wrong control, because nobody decides 3,900 routes one at a time.
 *
 * ── AND THEN THE COUNT WENT TOO (one switch) ───────────────────────────────
 *
 * "0 of 63 routes on" was the honest answer to *will anything happen here* while a route was
 * switchable. It is not any more: every allowed route now exists by rule and nothing on a page
 * turns one off, so the figure measured something nobody could act on — and a number that
 * cannot be changed is furniture on a page a CEO reads.
 *
 * What answers the question instead is ABILITY: how many accounts can actually send, plus
 * whether this recipient is retired. Both are facts about the world rather than settings, which
 * is the whole point of the one-switch change.
 */
export function ProspectList({ prospects, sendersAble }: { prospects: ProspectRow[]; sendersAble: number }) {
  if (prospects.length === 0) {
    return (
      <section className="group">
        <h2>No prospects yet</h2>
        <p className="group-blurb">
          Paste a list above to add some. Nothing is sent to anyone while Autopilot is off.
        </p>
      </section>
    )
  }

  const channels = prospects.filter((p) => p.kind === 'CHANNEL')
  const brands = prospects.filter((p) => p.kind === 'BRAND')

  return (
    <>
      <Group title="Channels" rows={channels} sendersAble={sendersAble} />
      {brands.length > 0 && <Group title="Brands found in paid posts" rows={brands} sendersAble={sendersAble} />}
    </>
  )
}

function Group({ title, rows, sendersAble }: { title: string; rows: ProspectRow[]; sendersAble: number }) {
  if (rows.length === 0) return null
  return (
    <section className="group">
      <h2>
        {title} ({rows.length})
      </h2>
      <div className="group-rows">
        {rows.map((p) => (
          <Row key={p.handle} p={p} sendersAble={sendersAble} />
        ))}
      </div>
    </section>
  )
}

function Row({ p, sendersAble }: { p: ProspectRow; sendersAble: number }) {
  const [busy, setBusy] = useState<'watch' | null>(null)
  const [msg, setMsg] = useState<string | null>(null)

  const flipWatch = async () => {
    setBusy('watch')
    setMsg(null)
    try {
      const r = await setTargetWatch(p.handle, !p.watchEnabled)
      setMsg(r.message)
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className={`message ${p.retired ? 'group-broken' : ''}`}>
      <div className="message-head">
        <div>
          <strong>@{p.handle}</strong>{' '}
          <span className="muted">
            {p.displayName !== p.handle ? p.displayName : ''}
            {p.delivered > 0
              ? `${p.displayName !== p.handle ? ' · ' : ''}${p.delivered} message${p.delivered === 1 ? '' : 's'} delivered`
              : ''}
          </span>
        </div>
        {p.replied && <span className="chip chip-live">they replied</span>}
        {p.retired && <span className="chip">retired</span>}
      </div>

      {/*
        The reply halt, said in full rather than as a chip alone. It stops every account
        from writing to this person, which is a bigger fact than a badge implies.
      */}
      {p.replied && (
        <p className="account-message">They replied — messaging pauses for a day, then resumes on its own.</p>
      )}

      {/*
        ── WILL ANYTHING HAPPEN HERE — A FACT, NOT A CHIP WALL ────────────────

        This was a collapsible chip per sender×recipient route: twenty today, 3,900 at 65×60.
        The chips went with the per-route action (one switch, 2026-08-08) — routes are decided
        by one rule and created automatically now, so there was nothing left to click.

        The SENTENCE stays, because answering "will anything be sent to this person" is what
        the chips were really for, and removing a control must never remove an explanation. It
        answers from ability: `sendersAble` counts accounts that can actually send, so it reads
        honestly — zero — when the fleet is signed out. "while Autopilot is on" is the qualifier
        a row must never drop, because this page must not promise sending that the one switch is
        currently refusing.

        Retired is stated first and absolutely, and it is the only branch here: `optedOut` is
        the one promise this UI makes that has to survive every other feature.
      */}
      <p className="muted">
        {p.retired
          ? 'Retired — never contacted.'
          : `Messaged automatically by rotation while Autopilot is on (${sendersAble} account${sendersAble === 1 ? '' : 's'} able to send).`}
      </p>

      <div className="account-actions">
        {/*
          The "rotation group" text input that sat here was removed 2026-08-07 — a
          free-text field configuring a mechanism that has never been set up (the
          Category table is empty) read as something the operator ought to understand.
          `setTargetCategory` and the rotation code are untouched.
        */}
        <button className="link-quiet" type="button" onClick={flipWatch} disabled={busy !== null}>
          {busy === 'watch'
            ? 'Saving…'
            : p.watchEnabled
              ? 'stop reading their posts'
              : 'read their posts every check'}
        </button>
      </div>

      {msg && <p className="account-message">{msg}</p>}
      {p.importNote && <p className="muted">{p.importNote}</p>}
    </div>
  )
}
