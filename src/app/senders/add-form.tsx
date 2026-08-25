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
export function AddSenderForm({ fleets }: { fleets: { slug: string; name: string }[] }) {
  const router = useRouter()
  const [handle, setHandle] = useState('')
  /**
   * WHICH FLEET (2026-08-25, Tabish: *"There is no segregation between adding accounts for
   * the two types of categories I mentioned in the UI"*).
   *
   * The empty value is the DEFAULT category, not "unassigned" — every existing account
   * carries it, and it is the correct answer for a bollywood page. Naming it explicitly in
   * the dropdown is the point: an operator adding a marketing sender has to SEE that the
   * other option exists, because the cost of getting it wrong is one page cold-pitching the
   * other fleet's companies.
   */
  const [fleet, setFleet] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  const submit = async () => {
    if (busy || handle.trim() === '') return
    setBusy(true)
    setMsg(null)
    try {
      const r = await addSender(handle, '', fleet)
      setMsg({ ok: r.ok, text: r.message })
      if (r.ok) {
        setHandle('')
        setFleet('')
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
          {/*
            Rendered only when a second fleet actually exists. With one fleet the choice is
            not a choice, and a dropdown with a single option is furniture that implies a
            decision nobody has to make.
          */}
          {fleets.length > 0 && (
            <label>
              <span>Sends for</span>
              <select value={fleet} onChange={(e) => setFleet(e.target.value)}>
                <option value="">Bollywood (the original fleet)</option>
                {fleets.map((f) => (
                  <option key={f.slug} value={f.slug}>
                    {f.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <button type="button" onClick={() => void submit()} disabled={busy || handle.trim() === ''}>
            {busy ? 'Checking…' : 'Add account'}
          </button>
        </div>

        {/*
          The handle is the whole form since 2026-08-18: messages carry no signature and no
          page name (Tabish: "channels dont have unique names, only the template message"),
          so there is nothing else to collect. The handle is checked against Instagram
          before the row is created, so a typo is refused rather than stored.
        */}
        <p className="cardnote">
          The handle is checked against Instagram first — a page that does not exist is refused
          rather than saved. Every message it sends is the one standard template on the
          Autopilot page.
          {fleets.length > 0 && (
            <>
              {' '}
              A page only ever writes to companies of its OWN fleet, and the choice is made
              here — it cannot be changed by editing a draft later.
            </>
          )}
        </p>

        {msg && <p className={msg.ok ? 'note-good' : 'note-warn'}>{msg.text}</p>}
      </div>
    </section>
  )
}
