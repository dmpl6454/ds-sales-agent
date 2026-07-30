'use client'

import { useState } from 'react'
import { setAutopilot, setAccountAutopilot } from './actions'
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
                  : 'Arm an account below, and give it a one-time login, before this does anything.'
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
            armed but {state.needLoginHandles.length === 1 ? 'has' : 'have'} no browser profile, so{' '}
            {state.needLoginHandles.length === 1 ? 'it' : 'they'} will keep waiting for you. Run{' '}
            <code>pnpm ig:login {state.needLoginHandles[0]}</code> once.
          </p>
        ) : null}

        <div className="arm-list">
          {accounts.map((a) => (
            <ArmRow key={a.handle} account={a} />
          ))}
        </div>

        <p className="cardnote">
          An account only sends unattended when four things are true: autopilot on, that account armed, a one-time
          login done by hand, and the account not flagged by Instagram. If any is missing the message is still
          written — it just waits for you instead of being dropped.
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

function ArmRow({ account }: { account: AccountCard }) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const flip = async () => {
    setBusy(true)
    setErr(null)
    try {
      const r = await setAccountAutopilot(account.handle, !account.autopilot)
      if (!r.ok) setErr(r.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="arm-row">
      <span className={`dot ${account.state}`} aria-hidden />
      <span className="acc-name">{account.name}</span>
      <span className="acc-handle">@{account.handle}</span>
      <span className="acc-note">{err ?? account.note}</span>
      <button
        className="arm-btn"
        disabled={busy || !account.canSendAutomatically}
        onClick={flip}
        title={
          account.canSendAutomatically
            ? account.autopilot
              ? 'Stop this account sending by itself'
              : 'Let this account send by itself'
            : `Needs its one-time login first: pnpm ig:login ${account.handle}`
        }
      >
        {busy ? '…' : account.autopilot ? 'Armed' : 'Arm'}
      </button>
    </div>
  )
}
