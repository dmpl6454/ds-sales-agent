'use client'

import { useState } from 'react'
import { setAutopilot } from './actions'
import type { AutopilotState, AccountCard } from './view-model'

/**
 * The autopilot switch.
 *
 * On = at each slot the agent sends by itself, no human present. That is a
 * consequential thing to put on a page a CEO reads, so it states what it will do in
 * a full sentence rather than relying on the word "autopilot", and it says which
 * accounts it actually covers — a toggle that reads ON while covering zero accounts
 * would be the worst possible outcome here.
 */
export function AutopilotPanel({ state, accounts }: { state: AutopilotState; accounts: AccountCard[] }) {
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  const flip = async (on: boolean) => {
    setBusy(true)
    setMsg(null)
    try {
      const r = await setAutopilot(on)
      setMsg({ ok: r.ok, text: r.message })
    } finally {
      setBusy(false)
    }
  }

  const covered = state.readyHandles.length
  const unarmed = accounts.filter((a) => a.canSendAutomatically && !a.autopilot)

  return (
    <section>
      <h2>
        Sending
        <span className="h2-note">who presses send</span>
      </h2>

      <div className={`card autopilot ${state.on && covered > 0 ? 'live' : ''}`}>
        <div className="autopilot-top">
          <div>
            <div className="autopilot-title">
              {state.on
                ? covered > 0
                  ? 'Autopilot is ON — the agent sends by itself'
                  : 'Autopilot is ON, but no account is ready to use it'
                : 'Autopilot is OFF — messages wait for you'}
            </div>
            <div className="autopilot-sub">
              {state.on
                ? covered > 0
                  ? `At 11:00, 15:00, 17:00 and 20:00 IST, ${state.readyHandles.map((h) => '@' + h).join(', ')} will send permitted messages with nobody present.`
                  : 'Under Your accounts, connect an account and switch its Auto-send on — until then this does nothing.'
                : 'Every message is written and safety-checked, then waits for a click.'}
            </div>
          </div>
          <button
            className={state.on ? '' : 'primary'}
            disabled={busy || (!state.on && !state.allowedByEnv)}
            onClick={() => flip(!state.on)}
            title={
              state.allowedByEnv
                ? 'Switches unattended sending on or off'
                : 'Blocked by AUTOPILOT_ENABLED=false in .env'
            }
          >
            {busy ? 'Saving…' : state.on ? 'Turn autopilot off' : 'Turn autopilot on'}
          </button>
        </div>

        {/*
          The scheduler is what turns the toggle into behaviour. Autopilot ON with
          nothing scheduled is a promise the system cannot keep, and that exact state
          existed unmentioned for a day — the page said messages go out at 11:00
          while no process existed to send one.
        */}
        <p
          className="cardnote"
          style={{ color: state.scheduler.running ? 'var(--muted)' : 'var(--bad)' }}
        >
          {state.scheduler.running ? (
            <>
              ● Watch is running{state.scheduler.host === 'dashboard' ? ' (inside this dashboard)' : ' (separate worker)'} —
              last heartbeat {state.scheduler.lastBeatLabel}. Slots will fire on their own.
            </>
          ) : (
            <>
              ■ <strong>Nothing is scheduled.</strong> No watch process has checked in
              {state.scheduler.lastBeatLabel ? ` since ${state.scheduler.lastBeatLabel}` : ' ever'}, so no slot will
              fire and no message will be sent by itself — whatever this toggle says. Restart the dashboard, or run{' '}
              <code>pnpm worker</code>.
            </>
          )}
        </p>

        {!state.allowedByEnv ? (
          <p className="cardnote">
            This deployment has autopilot disabled at the environment level
            (<code>AUTOPILOT_ENABLED=false</code>). That switch is intentionally not changeable from this page — a web
            page should not be able to start unattended sending on its own.
          </p>
        ) : null}

        {state.needLoginHandles.length > 0 ? (
          <p className="cardnote" style={{ color: 'var(--warn)' }}>
            ⚠ {state.needLoginHandles.map((h) => '@' + h).join(', ')} {state.needLoginHandles.length === 1 ? 'is' : 'are'}{' '}
            armed but not connected, so {state.needLoginHandles.length === 1 ? 'it' : 'they'} will keep waiting for
            you. Press <strong>Connect</strong> on {state.needLoginHandles.length === 1 ? 'it' : 'them'} under Your
            accounts.
          </p>
        ) : null}

        {unarmed.length > 0 ? (
          <p className="cardnote">
            Connected but not armed: {unarmed.map((a) => '@' + a.handle).join(', ')}. Arming is per account, under Your
            accounts — accounts graduate one at a time on purpose.
          </p>
        ) : null}

        <p className="cardnote">
          An account only sends unattended when four things are true: autopilot on, that account armed, a login done by
          hand, and the account not flagged by Instagram. If any is missing the message is still written — it just
          waits for you instead of being dropped.
        </p>
      </div>

      {msg ? (
        <p className="cardnote" style={{ color: msg.ok ? 'var(--good)' : 'var(--warn)' }}>
          {msg.ok ? '✓ ' : '⚠ '}
          {msg.text}
        </p>
      ) : null}
    </section>
  )
}
