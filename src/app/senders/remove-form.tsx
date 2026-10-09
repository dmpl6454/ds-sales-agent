'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { removeSender } from '../actions'

/**
 * REMOVE A SENDING ACCOUNT — with its queue handed off, never dropped.
 *
 * Tabish, 2026-08-19: *"There must be an ability to delete senders and when a sender is
 * deleted the queue must not get hampered — their messages must be transferred to another
 * sender in the round rotating format."* The hand-off itself lives in
 * `src/outreach/handOff.ts` behind the `removeSender` action; this form is the door.
 *
 * SINCE 2026-10-09 THE DRAFTS ARE RELEASED, NOT MOVED, and this copy said "move to the
 * other accounts … nothing in the queue is lost", which is now false about the bytes and
 * would send someone looking for the same message under a different page. What is true is
 * that each recipient is written to within fifteen minutes by the account rotation picks
 * next, as that account's OWN message — `handOff.ts` records why moving the bytes made a
 * follow-up into another page's first message.
 *
 * The copy states both halves of what removal actually does, because they differ by
 * history: an account that has DELIVERED messages is retired (its send history is what
 * stops anyone being contacted twice — the standing removal rule), an account that never
 * delivered is deleted outright. Either way the queue is handed off first.
 *
 * A typed confirmation rather than a checkbox: this is the one control on the page that
 * takes an account out of the rotation, and a select-plus-click can be an accident.
 */
export function RemoveSenderForm({ handles }: { handles: string[] }) {
  const router = useRouter()
  const [handle, setHandle] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  const ready = handle !== '' && confirm.trim().replace(/^@/, '') === handle && !busy

  const submit = async () => {
    if (!ready) return
    setBusy(true)
    setMsg(null)
    try {
      const r = await removeSender(handle)
      setMsg({ ok: r.ok, text: r.message })
      if (r.ok) {
        setHandle('')
        setConfirm('')
        router.refresh()
      }
    } catch {
      setMsg({ ok: false, text: 'Could not remove the account. Reload the page and try again.' })
    } finally {
      setBusy(false)
    }
  }

  if (handles.length === 0) return null

  return (
    <section>
      <h2>Remove a sending account</h2>
      <p className="blurb">
        Nobody it was about to write to is dropped: within 15 minutes each of them is written to by the
        account the rotation picks next, as that account&apos;s own message. A message that may already
        have reached someone stays with this account. An account that has already delivered messages is
        retired rather than deleted, because that history is what stops anyone being contacted twice.
      </p>

      <div className="addform">
        <div className="addform-row">
          <label>
            <span>Account</span>
            <select value={handle} onChange={(e) => setHandle(e.target.value)}>
              <option value="">Choose…</option>
              {handles.map((h) => (
                <option key={h} value={h}>
                  @{h}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Type the handle to confirm</span>
            <input
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void submit()
              }}
              placeholder={handle ? `@${handle}` : ''}
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          <button type="button" onClick={() => void submit()} disabled={!ready}>
            {busy ? 'Removing…' : 'Remove account'}
          </button>
        </div>

        {msg && <p className={msg.ok ? 'note-good' : 'note-warn'}>{msg.text}</p>}
      </div>
    </section>
  )
}
