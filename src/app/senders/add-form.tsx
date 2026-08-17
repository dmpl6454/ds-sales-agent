'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { addSender } from '../actions'

/**
 * ADD A SENDING ACCOUNT — and until 2026-08-17 there was NO WAY TO DO THIS FROM THE UI.
 *
 * MEASURED: `addSender` has existed in `actions.ts` for weeks, complete with handle
 * validation, an existence check against Instagram, persona copying, cohort assignment and
 * route creation — and **not one file in `src/app` imported it.** `/senders` rendered the
 * account groups and the login queue and nothing else, so the only way to add an account was
 * to write to the database by hand.
 *
 * That is this codebase's signature failure in the one place it is most expensive: a
 * capability that exists, is guarded, is audited, and is unreachable. `addTarget` had a form
 * on `/targets` the whole time, which is exactly why nobody noticed the sender half was
 * missing — the pair looked symmetrical from the outside.
 *
 * ── WHAT THIS FORM MUST SAY, AND WHY ──────────────────────────────────────
 *
 * Adding an account does NOT make it able to send, and the copy has to be honest about that
 * or it recreates the "four yeses" confusion the one-switch change removed. Two things stand
 * between adding and sending, and neither is a switch:
 *
 *   a hand sign-in   in that account's OWN Chrome profile, from the home IP. Not copyable
 *                    from another machine — that is the load-bearing safety choice of the
 *                    whole design.
 *   the group ladder a new account joins the NEXT onboarding group, which waits 14 days
 *                    behind the one before it. Not overridable, enforced at delivery.
 */
export function AddSenderForm() {
  const router = useRouter()
  const [handle, setHandle] = useState('')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  const submit = async () => {
    if (busy || handle.trim() === '') return
    setBusy(true)
    setMsg(null)
    try {
      const r = await addSender(handle, name)
      setMsg({ ok: r.ok, text: r.message })
      if (r.ok) {
        setHandle('')
        setName('')
        /* The new row, its group and its sign-in state all live on this page. */
        router.refresh()
      }
    } catch {
      setMsg({ ok: false, text: 'Could not add the account. Check the handle and try again.' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <section>
      <h2>Add a sending account</h2>
      <p className="blurb">
        One of your own Instagram pages. Adding it does not make it send: it needs a one-time
        sign-in in its own browser profile, from this machine, and it joins the next onboarding
        group behind the one before it.
      </p>

      <div className="addform">
        <div className="addform-row">
          <label>
            <span>Instagram handle</span>
            <input
              value={handle}
              onChange={(e) => setHandle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void submit()
              }}
              placeholder="bollywoodchronicle"
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          <label>
            <span>Page name</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void submit()
              }}
              placeholder="Bollywood Chronicle"
              autoComplete="off"
            />
          </label>
          <button type="button" onClick={() => void submit()} disabled={busy || handle.trim() === ''}>
            {busy ? 'Checking…' : 'Add account'}
          </button>
        </div>

        {/*
          The handle is checked against Instagram before the row is created, so a typo is
          refused rather than stored. Said here because the button takes a second and a
          person should know what it is doing.
        */}
        <p className="cardnote">
          The handle is checked against Instagram first — a page that does not exist is refused
          rather than saved. The page name is what recipients see in the signature; leave it
          blank to use the handle.
        </p>

        {msg && <p className={msg.ok ? 'note-good' : 'note-warn'}>{msg.text}</p>}
      </div>
    </section>
  )
}
