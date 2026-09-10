'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { setActiveDevice } from '../actions'

export interface SendingMacOption {
  name: string
  online: boolean
  /** Accounts this Mac holds a signed-in profile for, from its own presence row. */
  handles: string[]
  build: string | null
  paired: boolean
}

/**
 * ── THE SENDING MAC — one control, two steps (2026-09-10) ──
 *
 * One Mac does the fleet's work; every other Mac holds, whatever is signed in there. Choosing
 * a different Mac is the largest single exposure change this dashboard offers — it moves every
 * send onto another device identity and home IP — so, like the fleet checkboxes, it previews
 * before it writes: pick, read what will and will not send from there, confirm. The rehearsal
 * burner joined the rotation on a bare one-click button once (2026-08-26); not again.
 */
export function ActiveDeviceSection({
  options,
  selected,
  senderHandles,
}: {
  options: readonly SendingMacOption[]
  selected: string | null
  /** Every account in the rotation, so the preview can name the ones not signed in on the chosen Mac. */
  senderHandles: readonly string[]
}) {
  const router = useRouter()
  const [choice, setChoice] = useState<string | null>(selected)
  const [busy, setBusy] = useState(false)
  const [outcome, setOutcome] = useState<{ ok: boolean; message: string } | null>(null)
  const chosen = options.find((o) => o.name === choice) ?? null
  const changed = chosen !== null && chosen.name !== selected
  const missing = chosen ? senderHandles.filter((h) => !chosen.handles.includes(h)) : []
  const held = chosen ? senderHandles.filter((h) => chosen.handles.includes(h)) : []

  const submit = async () => {
    if (!chosen || !changed) return
    setBusy(true)
    setOutcome(null)
    try {
      const r = await setActiveDevice(chosen.name)
      setOutcome(r)
      if (r.ok) router.refresh()
    } catch (err) {
      setOutcome({ ok: false, message: `Could not switch: ${err instanceof Error ? err.message : String(err)}. Reload the page and try again.` })
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="group">
      <h2>Sending Mac</h2>
      {selected ? (
        <p>
          <strong>{selected}</strong> does everything — sending, reading replies, brand look-ups. Every other paired
          Mac holds, whatever accounts are signed in there. Switching moves all of that to the Mac you choose on its
          next tick; nothing is restarted and no draft is lost.
        </p>
      ) : (
        <p className="account-todo">
          No Mac is selected, so <strong>nothing sends anywhere</strong> — paid posts are still found and messages are
          still written. Choose the Mac that should send.
        </p>
      )}
      {options.length === 0 ? (
        <p className="muted">No Mac has paired or come online yet. Install the agent on the Mac that will send.</p>
      ) : (
        <ul className="plain">
          {options.map((o) => (
            <li key={o.name}>
              <label>
                <input
                  type="radio"
                  name="sending-mac"
                  value={o.name}
                  checked={choice === o.name}
                  disabled={busy}
                  onChange={() => {
                    setChoice(o.name)
                    setOutcome(null)
                  }}
                />{' '}
                <strong>{o.name}</strong>
                {o.name === selected ? ' — the sending Mac now' : ''} · {o.online ? 'online' : 'not beating'}
                {o.build ? ` · build ${o.build}` : ''} ·{' '}
                {o.handles.length > 0 ? `signed in: ${o.handles.map((h) => `@${h}`).join(', ')}` : 'no signed-in accounts'}
              </label>
            </li>
          ))}
        </ul>
      )}
      {changed && chosen && (
        <p className="account-todo">
          Switching to <strong>{chosen.name}</strong>: it sends for{' '}
          {held.length > 0 ? held.map((h) => `@${h}`).join(', ') : 'no account yet'}
          {missing.length > 0 ? `; ${missing.map((h) => `@${h}`).join(', ')} will not send until signed in there` : '; every account is signed in there'}
          . {selected ? `${selected} stops sending, reading replies and looking up brands.` : ''}
          {!chosen.online ? ' It is not online right now, so nothing sends until it is.' : ''}
        </p>
      )}
      <button disabled={!changed || busy} onClick={submit}>
        {busy ? 'Switching…' : chosen && changed ? `Make ${chosen.name} the sending Mac` : 'Choose a different Mac to switch'}
      </button>
      {outcome && <p className={outcome.ok ? 'muted' : 'account-todo'}>{outcome.message}</p>}
    </section>
  )
}
