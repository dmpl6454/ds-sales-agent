'use client'

import { useState } from 'react'
import { isStaleServerAction, reloadForStaleBuild, STALE_BUILD_MESSAGE } from './stale-build'
import Link from 'next/link'
import { setAutopilot } from './actions'
import type { AutopilotState } from './view-model'

/**
 * THE switch. Since 2026-08-08 there is no other one.
 *
 * On = the agent finds paid posts, decides brands, writes messages and sends them, with no
 * human present. That is a consequential thing to put on a page a CEO reads, so it states what
 * it will do in a full sentence rather than relying on the word "autopilot", and it says which
 * accounts it actually covers — a toggle that reads ON while covering zero accounts would be
 * the worst possible outcome here.
 *
 * It no longer takes the account cards. It used them for one thing — listing accounts whose
 * per-account switch was off — and that switch is gone, so the prop would have been furniture:
 * a parameter nobody reads is the sort of thing a later reader wires a new rule to.
 */
export function AutopilotPanel({ state }: { state: AutopilotState }) {
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  const flip = async (on: boolean) => {
    setBusy(true)
    setMsg(null)
    try {
      const r = await setAutopilot(on)
      setMsg({ ok: r.ok, text: r.message })
    } catch (err) {
      // A rejected action used to vanish here (no catch): the switch looked dead. A tab from
      // before a deploy is the common cause, and the fix is a reload, said out loud.
      if (isStaleServerAction(err)) {
        setMsg({ ok: false, text: STALE_BUILD_MESSAGE })
        reloadForStaleBuild()
      } else {
        setMsg({ ok: false, text: `Could not switch autopilot: ${err instanceof Error ? err.message : String(err)}` })
      }
    } finally {
      setBusy(false)
    }
  }

  const covered = state.readyHandles.length

  return (
    <section>
      <div className={`card autopilot ${state.on && covered > 0 ? 'live' : ''}`}>
        <div className="autopilot-top">
          {/*
            A REAL SWITCH, not a button labelled with its next action.
            `role="switch"` + `aria-checked` is the difference between a control that
            announces "Turn autopilot on, button" (which reads as the current state to
            anyone scanning quickly, and is the opposite of it) and one that announces
            "Autopilot, switch, off". On the single most consequential control in the
            product, that ambiguity is not acceptable.

            It is deliberately large. This is the one thing on the page that changes what
            the system does to strangers' inboxes; it should not look like the Discard
            button next to a draft.
          */}
          <button
            type="button"
            role="switch"
            aria-checked={state.on}
            aria-label="Autopilot"
            className="bigswitch"
            disabled={busy}
            onClick={() => flip(!state.on)}
            title={
              state.allowedByEnv
                ? 'Switches unattended sending on or off'
                : 'Controls the whole fleet — this machine itself never sends'
            }
          >
            <span className="bigswitch-knob" />
          </button>

          <div>
            <div className="autopilot-title">
              {state.on
                ? !state.sendingMac.selected
                  ? 'Autopilot is ON, but no Mac is selected to send'
                  : !state.sendingMac.online
                    ? `Autopilot is ON, but ${state.sendingMac.selected} — the sending Mac — is not online`
                    : covered > 0
                      ? `Autopilot is ON — ${state.sendingMac.selected} sends by itself`
                      : 'Autopilot is ON, but no account is ready to use it'
                : 'Autopilot is OFF — messages wait for you'}
            </div>
            {/*
              ── THE SWITCH STATES ITS CONTRACT ─────────────────────────────────

              ONE SWITCH, 2026-08-08. This used to describe the SLOTS and name the accounts it
              covered, on the assumption that a reader had already armed some of them. With the
              per-account toggle gone, this sentence IS the product: it has to say what turning
              it on causes, end to end, because there is nothing else left to configure.

              Tabish: *"Automated mode must simply send the messages."* So the ON copy names the
              whole chain — find, decide, write, send — and the pacing, because "on" must not read
              as "immediately and continuously". The OFF copy states the one thing an operator
              needs to trust: nothing is dropped, drafts keep their Send buttons.
            */}
            <div className="autopilot-sub">
              {state.on
                ? !state.sendingMac.selected
                  ? 'Nothing sends anywhere until a Mac is chosen under Senders → Sending Mac. Paid posts are still found and messages are still written.'
                  : !state.sendingMac.online
                    ? `Nothing sends until ${state.sendingMac.selected} is back online — open its lid, or choose another Mac under Senders. Paid posts are still found and messages are still written.`
                    : covered > 0
                      ? `It finds paid posts, decides which brands are worth writing to, writes the messages, and sends them from ${state.sendingMac.selected} — ${state.paceClause}. Every other Mac holds.`
                      : 'It finds paid posts, decides brands and writes messages — but no account can send yet, so everything waits. Sign one in and it starts on its own.'
                : 'Nothing sends. Paid posts are still found and messages are still written — drafts keep their Send buttons.'}
            </div>
          </div>

          {/*
            THE FLOOR THE PAGE CANNOT CROSS, stated beside the control rather than in a
            footnote. `AUTOPILOT_ENABLED` lives in the environment precisely so a web page
            cannot widen its own access — same reasoning as `SIGNUP_INVITE_CODE` — and a
            reader who cannot find why the switch is refusing them would otherwise go
            looking for a second switch that does not exist.
          */}
          <div className="autopilot-env">
            <p className="eyebrow">Permitted by the machine</p>
            <p className="autopilot-envnote">
              {state.allowedByEnv
                ? 'This deployment allows unattended sending. The switch is yours.'
                : 'This machine never sends itself — the signed-in Macs do. The switch controls the whole fleet, including them.'}
            </p>
            {busy ? <p className="autopilot-envnote muted">Saving…</p> : null}
          </div>
        </div>

        {/*
          The scheduler is what turns the toggle into behaviour. Autopilot ON with
          nothing scheduled is a promise the system cannot keep, and that exact state
          existed unmentioned for a day — the page said messages go out at 11:00
          while no process existed to send one.
        */}
        {state.scheduler.running ? (
          <p className="cardnote">
            <span className="pill good">watch running</span>{' '}
            {/*
              WHERE, not just WHAT. This read `host === 'dashboard'` and said "inside this
              dashboard" — true of the machine that is beating, and the reader is usually
              somewhere else. The hosted deployment beats `host: 'dashboard'` from the
              Linode, so a Mac dashboard (which correctly declines to schedule anything)
              told its reader the watch was inside it. Someone deciding whether they may
              close this window got the wrong answer, on the one card that exists because
              a watch stopped for twenty hours and nothing said so.
            */}
            {!state.scheduler.here
              ? `on another machine${state.scheduler.machine ? ` (${state.scheduler.machine})` : ''}, not this one`
              : state.scheduler.host === 'dashboard'
                ? 'inside this dashboard'
                : 'in a separate worker on this machine'}{' '}
            — last heartbeat {state.scheduler.lastBeatLabel}. Slots will fire on their own
            {state.scheduler.here ? '' : ' whether or not this window is open'}.
          </p>
        ) : (
          /*
            The one case where this panel is a LIE if it stays quiet: autopilot reading ON with
            nothing scheduled is a promise the system cannot keep, and that exact state existed
            unmentioned for a day. `.reason.bad` because it is the most severe thing this card can
            say — not a delay, an impossibility.
          */
          <p className="reason bad">
            <strong>Nothing is scheduled.</strong> No watch process has checked in
            {state.scheduler.lastBeatLabel ? ` since ${state.scheduler.lastBeatLabel}` : ' ever'}, so no slot will fire
            and no message will be sent by itself — whatever this toggle says. Restarting the dashboard starts it again.
          </p>
        )}

        {/*
          The environment floor USED TO BE RESTATED HERE as well as beside the switch. It
          is now said once, in the panel above, where the control it constrains actually
          is. A reader who sees the same fact twice on one screen learns to skip both.
        */}

        {/*
          `.reason` rather than an inline colour. Step F: every "why this will not happen" on the
          dashboard now carries the same left severity stripe, so it is recognisable as a refusal
          before a word of it is read. Inline `style={{ color }}` was six different treatments for
          one idea.
        */}
        {/*
          ONE SWITCH, 2026-08-08: this read "@x is ALLOWED to send on its own but is not signed
          in". "Allowed" was the per-account bit, and it no longer exists — so the sentence would
          have named a permission a reader could not find, about the very accounts it is telling
          them to go and fix. Being signed in IS the permission now.

          `needLoginHandles` also widened with the bit's removal, deliberately: it used to list
          only accounts somebody had armed, which meant a signed-out account nobody had flipped
          was invisible on the one card that explains why nothing is sending.
        */}
        {state.needLoginHandles.length > 0 ? (
          <p className="reason">
            {state.needLoginHandles.map((h) => '@' + h).join(', ')}{' '}
            {state.needLoginHandles.length === 1 ? 'is' : 'are'} not signed in, so{' '}
            {state.needLoginHandles.length === 1 ? 'it' : 'they'} cannot send and{' '}
            {state.needLoginHandles.length === 1 ? 'its' : 'their'} messages will keep waiting for you.{' '}
            <Link href="/senders">Sign {state.needLoginHandles.length === 1 ? 'it' : 'them'} in</Link>.
          </p>
        ) : null}

        {/*
          "Signed in but not yet allowed to send on their own" USED TO RENDER HERE, listing
          accounts whose per-account switch was off. There is no such switch (one switch,
          2026-08-08), so the state it described cannot exist and the sentence would have sent a
          reader to the Senders page looking for a control that is not there.

          Nothing replaces it, because nothing is hidden by its absence: a signed-in, healthy
          account is now covered by the switch above and appears in that sentence's own count,
          and an account that CANNOT send says so on its own row.
        */}

        <p className="cardnote">
          An account sends unattended when three things are true: this switch is on, someone signed that account in by
          hand, and Instagram has not flagged it. If any is missing the message is still written — it waits for you
          instead of being dropped. New accounts also serve a settling-in period before they join in, which is
          automatic; nothing needs switching on.
        </p>
      </div>

      {msg ? (
        <p className={msg.ok ? 'cardnote note-ok' : 'cardnote note-warn'}>
          {msg.ok ? '✓ ' : '⚠ '}
          {msg.text}
        </p>
      ) : null}
    </section>
  )
}
