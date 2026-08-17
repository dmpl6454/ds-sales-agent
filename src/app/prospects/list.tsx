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
        NOTHING IS JUDGING THEIR POSTS. Bad, not muted: a watched channel on a detector that
        classifies nothing stores posts forever and finds zero paid campaigns, which reads on
        every other screen as "they do no paid work". The sentence comes from the detector's
        own `readiness()`, so a channel whose classifier has no API key and one with no
        classifier at all are two different problems with two different fixes.
      */}
      {p.unjudgedNote !== null && <p className="account-message bad">{p.unjudgedNote}</p>}

      {/*
        OUR OWN PAGE. Stated on the row rather than in a rationale page, because the decision
        it belongs to — leaving reading off — is made here.
      */}
      {p.groundTruthNote !== null && <p className="account-message">{p.groundTruthNote}</p>}

      {/*
        ── WILL ANYTHING HAPPEN HERE — A FACT, NOT A CHIP WALL ────────────────

        This was a collapsible chip per sender×recipient route: twenty today, 3,900 at 65×60.
        The chips went with the per-route action (one switch, 2026-08-08) — routes are decided
        by one rule and created automatically now, so there was nothing left to click.

        The SENTENCE stays, because answering "will anything be sent to this person" is what
        the chips were really for, and removing a control must never remove an explanation.

        WHAT IT SAYS CHANGED ON 2026-08-13, AND THE OLD WORDING WAS THE PROBLEM. It read
        "Messaged automatically by rotation while Autopilot is on (N accounts able to send)".
        Every word was true except the load-bearing one: rotation was NOT happening —
        `whoseTurn` returned null for every recipient, so all N accounts wrote to them, not one
        in turn. MEASURED: 7 recipients holding a draft from all three fleet accounts. The row
        described the design while the system did the opposite, and a count of accounts *able*
        to send reads as capacity rather than as what will actually be written.

        It now names the ONE account, from the same function the planner asks. `sendersAble`
        stays beside it as the fleet-wide fact it always was — ability, so it reads zero when
        the fleet is signed out even while Autopilot is on.

        Retired is stated first and absolutely, and it is the only branch here: `optedOut` is
        the one promise this UI makes that has to survive every other feature.
      */}
      {/*
        `nextSenderWillWrite` decides whether the fleet-capacity figure belongs here at all.

        MEASURED 2026-08-13: 8 of the 70 BRAND rows are people — film directors, an actor —
        and the planner refuses every one of them (`checkRecipientIsNotAPerson`). This row
        told a reader "Next message comes from @bollywoodchronicle" about all eight. Those
        rows were deliberately left for a person to JUDGE, and this page was the one place
        someone would see they are people; it was saying the opposite. The sentence is now
        the planner's own refusal, and "N accounts can send" is dropped with it — a capacity
        figure beside a refusal re-reads as a promise.
      */}
      <p className="muted">
        {p.retired
          ? 'Retired — never contacted.'
          : p.nextSenderWillWrite
            ? `${p.nextSenderSentence} ${sendersAble} account${sendersAble === 1 ? '' : 's'} in the fleet can send right now.`
            : p.nextSenderSentence}
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
