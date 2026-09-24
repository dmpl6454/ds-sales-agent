'use client'

import { useState } from 'react'
import { isStaleServerAction, reloadForStaleBuild, STALE_BUILD_MESSAGE } from './stale-build'
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
        <p className="autopilot-sub">
          {state.on
            ? !state.sendingMac.selected
              ? 'Nothing sends anywhere until a Mac is chosen under Senders → Sending Mac. Paid posts are still found and messages are still written.'
              : !state.sendingMac.online
                ? `Nothing sends until ${state.sendingMac.selected} is back online — open its lid, or choose another Mac under Senders. Paid posts are still found and messages are still written.`
                : covered > 0
                  ? `It finds paid posts, decides which brands are worth writing to, writes the messages, and sends them from ${state.sendingMac.selected} — ${state.paceClause}. Every other Mac holds.`
                  : 'It finds paid posts, decides brands and writes messages — but no account can send yet, so everything waits. Sign one in and it starts on its own.'
            : 'Nothing sends. Paid posts are still found and messages are still written — drafts keep their Send buttons.'}
        </p>

        {/*
          ── THE HAIRLINE FOOTER: IS ANYTHING ACTUALLY BEHIND THE SWITCH ─────

          The scheduler is what turns the toggle into behaviour. Autopilot ON with nothing
          scheduled is a promise the system cannot keep, and that exact state existed
          unmentioned for a day — the page said messages go out at 11:00 while no process
          existed to send one. One line when it is running, a refusal when it is not.
        */}
        {state.scheduler.running ? (
          <p className="autopilot-foot">
            <span className="dot dot-good" aria-hidden />
            heartbeat {state.scheduler.lastBeatLabel}{' '}&mdash; slots fire on their own
            {/*
              WHERE, not just WHAT — but only when it is somewhere else. This used to name the
              host on every render, and "inside this dashboard" was wrong on a Mac reading a
              Linode's heartbeat. Said only when the answer is not "here", which is the only
              time it changes what a reader may do (close this window).
            */}
            {state.scheduler.here ? null : (
              <>
                {' '}
                on {state.scheduler.machine ?? 'another machine'}, whether or not this window is open
              </>
            )}
          </p>
        ) : (
          /*
            The one case where this panel is a LIE if it stays quiet: autopilot reading ON with
            nothing scheduled. `.reason.bad` because it is the most severe thing this card can
            say — not a delay, an impossibility.
          */
          <p className="reason bad">
            <strong>Nothing is scheduled.</strong> No watch process has checked in
            {state.scheduler.lastBeatLabel ? ` since ${state.scheduler.lastBeatLabel}` : ' ever'}, so no slot will fire
            and no message will be sent by itself — whatever this toggle says. Restarting the dashboard starts it again.
          </p>
        )}

        {busy ? <p className="cardnote muted">Saving…</p> : null}

        {/*
          ── WHAT WAS REMOVED FROM THIS CARD, AND WHERE IT WENT ──────────────

          Four blocks used to sit below the sentence and made this the tallest thing on the
          page. Every one of them was a SECOND copy:

          · the "@x is not signed in" list — `BlockerList` already carries it, ranked, with the
            time a real send found the account logged out and a link straight to Senders. Two
            copies of one fault on one screen, and the blocker is the better one.
          · "An account sends unattended when three things are true…" — that is a rule, and
            /rules states every stop from the module that enforces it. This page reports.
          · "This deployment allows unattended sending. The switch is yours." — true on every
            deployment a person can reach this page from, so it told nobody anything. The
            interesting half (this machine never sends; the Macs do) is in the sentence above
            whenever it is the reason nothing is going out.
          · the environment floor, restated a third time.

          Nothing is hidden by their absence: a fault that is actually stopping sending is a
          blocker, and a rule is on /rules.
        */}
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
