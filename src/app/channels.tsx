'use client'

import { useState } from 'react'
import { addTarget, removeTarget } from './actions'
import { DETECT_INTERVAL_MINUTES } from '@/detection/cadence'
import type { ChannelCard } from './view-model'

/**
 * The channels being watched, and adding or removing them.
 *
 * Removal is not deletion when a channel has been contacted. The record of what was
 * sent to whom is what the spacing rule, the unanswered-touch cap and the
 * new-material rule are computed from — throwing it away would let the system write
 * to someone it has already written to, which is the single worst outcome here. So a
 * contacted channel is retired: marked never-contact and kept. A channel that was
 * never messaged has no such history and is simply deleted.
 */
export function ChannelsPanel({ channels }: { channels: ChannelCard[] }) {
  const [adding, setAdding] = useState(false)
  const watched = channels.filter((c) => !c.retired)
  const retired = channels.filter((c) => c.retired)

  return (
    <section>
      <h2>
        Channels we watch{' '}
        {/*
          ── "four times a day" WAS THREE WEEKS OUT OF DATE ────────────────────
          Detection got its OWN clock on 2026-08-07 — every DETECT_INTERVAL_MINUTES, not the
          four IST send slots. The number is imported from the module that schedules it, the
          way `/rules` imports every value it states, so this line cannot drift again.

          The leading `{' '}` is not decoration: JSX drops the space between an expression and
          text on the next line, and this rendered as "watch2 channels" on the live page.
        */}
        <span className="h2-note">
          {watched.length} channel{watched.length === 1 ? '' : 's'} read every {DETECT_INTERVAL_MINUTES} minutes
        </span>
      </h2>

      <div className="cards">
        {watched.map((c) => (
          <ChannelBlock key={c.handle} channel={c} />
        ))}
      </div>

      {retired.length > 0 ? (
        <div className="retired-list">
          {retired.map((c) => (
            <div key={c.handle} className="retired-row">
              <span className="dot" aria-hidden />
              <span className="acc-name">{c.name}</span>
              <span className="acc-handle">@{c.handle}</span>
              <span className="acc-note">retired — never contacted again, history kept</span>
            </div>
          ))}
        </div>
      ) : null}

      {adding ? (
        <AddChannelForm onDone={() => setAdding(false)} />
      ) : (
        <div className="row">
          <button onClick={() => setAdding(true)}>Add a channel</button>
        </div>
      )}
    </section>
  )
}

function ChannelBlock({ channel: c }: { channel: ChannelCard }) {
  const [busy, setBusy] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  const remove = async () => {
    setBusy(true)
    try {
      const r = await removeTarget(c.handle)
      setMsg(r.message)
      setConfirm(false)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="card">
      <div className="card-top">
        <a href={`https://instagram.com/${c.handle}`} target="_blank" rel="noreferrer">
          {c.name}
        </a>
        <span className="followers">{c.followers}</span>
      </div>
      <dl>
        <div>
          <dt>Posts read this week</dt>
          <dd>{c.postsThisWeek}</dd>
        </div>
        <div>
          <dt>Paid campaigns found</dt>
          <dd>{c.unclassified ? <span className="dim">not classified</span> : c.campaignsThisWeek}</dd>
        </div>
        <div>
          <dt>Last contacted</dt>
          <dd>{c.lastContactedLabel}</dd>
        </div>
      </dl>

      {/*
        The reason comes from the detector, not from a sentence hardcoded here. "This
        channel has no classifier" and "the classifier has no API key" are different
        problems with different fixes, and rendering both as one sentence tells the
        reader the wrong thing about at least one of them.
      */}
      {c.unclassified ? (
        <p className="cardnote">
          {c.unclassifiedReason ?? 'Posts are recorded but not judged.'} A zero here would read as “they do no paid
          work”, which is untrue.
        </p>
      ) : null}
      {c.halted && !c.retired ? <div className="halt">On hold — they replied</div> : null}

      {confirm ? (
        <div className="connect-strip warn">
          {c.everContacted
            ? `We have already messaged @${c.handle}. Removing marks it never-contact and keeps that record, so nobody there is written to twice.`
            : `@${c.handle} has never been messaged, so it will be deleted outright.`}
          <button className="link-btn" onClick={remove} disabled={busy}>
            {busy ? 'Removing…' : c.everContacted ? 'Yes, stop messaging' : 'Yes, delete'}
          </button>
          <button className="link-btn" onClick={() => setConfirm(false)}>
            Keep it
          </button>
        </div>
      ) : (
        <button className="link-btn" onClick={() => setConfirm(true)}>
          Remove this channel
        </button>
      )}

      {msg ? <p className="cardnote">{msg}</p> : null}
    </div>
  )
}

/**
 * ADD A TARGET — and the first thing it asks is WHICH KIND, because the two do opposite
 * things and the answer decides everything else about the row.
 *
 * Until 2026-08-17 this form created one thing and its note said *"A new channel is messaged
 * by the fleet as soon as Autopilot is on"*. That was true, and it was the bug: adding
 * @viralbhayani to watch it also made it a recipient, and MEASURED, both competitors were
 * carrying 13 attempts each with 6 drafts waiting.
 */
function AddChannelForm({ onDone }: { onDone: () => void }) {
  const [role, setRole] = useState<'WATCH' | 'PROSPECT'>('WATCH')
  const [handle, setHandle] = useState('')
  const [name, setName] = useState('')
  const [greeting, setGreeting] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  const submit = async () => {
    setBusy(true)
    setMsg(null)
    try {
      const r = await addTarget(handle, name, greeting, role)
      setMsg({ ok: r.ok, text: r.message })
      if (r.ok) {
        setHandle('')
        setName('')
        setGreeting('')
      }
    } catch (e) {
      /**
       * AN EXCEPTION MUST RENDER A SENTENCE, NOT NOTHING (2026-08-20).
       *
       * Tabish added @filmigyan and "it did not get added" — no row, no audit row, and no
       * message on screen, because this had `finally` with no `catch`: a THROWN failure
       * (as opposed to a returned refusal) reset the button and rendered silence. The
       * reachable thrower is real, not hypothetical — a tab served by an older build calls
       * a server action by a build-time ID the new server no longer has, and Next throws
       * "Failed to find Server Action". At one deploy a day, every open tab is that tab.
       *
       * "A refusal must say why, on the thing it refuses" applies doubly to a failure
       * nobody chose. The reload hint is the actual remedy for the stale-bundle case.
       */
      setMsg({
        ok: false,
        text: `The add failed before it could run: ${e instanceof Error ? e.message : String(e)}. Reload the page and try again — an open tab from before a deploy is the usual cause.`,
      })
    } finally {
      setBusy(false)
    }
  }

  const watching = role === 'WATCH'

  return (
    <div className="addform">
      <div className="addform-row">
        <label>
          <span>What is this?</span>
          <select value={role} onChange={(e) => setRole(e.target.value as 'WATCH' | 'PROSPECT')}>
            <option value="WATCH">A page to watch for paid posts</option>
            <option value="PROSPECT">A company to message</option>
          </select>
        </label>
        <label>
          <span>Instagram handle</span>
          <input
            value={handle}
            onChange={(e) => setHandle(e.target.value)}
            placeholder={watching ? 'viralbhayani' : 'crocsindia'}
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        <label>
          <span>Name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={watching ? 'Viral Bhayani' : 'Crocs India'}
            autoComplete="off"
          />
        </label>
        {/*
          The greeting is the first thing a RECIPIENT reads. A watched page is never written
          to, so asking for it there would be asking for something nothing will ever use.
        */}
        {watching ? null : (
          <label>
            <span>Greeting</span>
            <input
              value={greeting}
              onChange={(e) => setGreeting(e.target.value)}
              placeholder="Crocs India"
              autoComplete="off"
            />
          </label>
        )}
        <button className="primary" onClick={submit} disabled={busy || handle.trim().length === 0}>
          {busy ? 'Adding…' : 'Add'}
        </button>
        <button onClick={onDone} disabled={busy}>
          Cancel
        </button>
      </div>
      {/*
        The note says which of the two things is about to happen, because they are opposites
        and only one of them puts a message in a stranger's inbox. The previous version said
        "a new channel is messaged by the fleet as soon as Autopilot is on" about EVERY row —
        true then, and the reason both competitors were carrying drafts.
      */}
      <p className="cardnote">
        {watching ? (
          <>
            We will read this page’s feed every 15 minutes and judge each post paid or ordinary. It is{' '}
            <strong>never messaged</strong> — the companies found in its paid posts are who we write to.
          </>
        ) : (
          <>
            This company is <strong>messaged by the fleet</strong> as soon as Autopilot is on, so add one only if you
            want it written to. Its feed is not read. The greeting is what they literally see first — “Hi{' '}
            <em>Crocs India</em>,”.
          </>
        )}
      </p>
      {msg ? (
        <p className={msg.ok ? 'cardnote note-ok' : 'cardnote note-warn'}>
          {msg.ok ? '✓ ' : '⚠ '}
          {msg.text}
        </p>
      ) : null}
    </div>
  )
}
