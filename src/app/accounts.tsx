'use client'

import { useEffect, useRef, useState } from 'react'
import {
  connectAccount,
  checkConnect,
  abortConnect,
  addSender,
  removeSender,
  setAccountAutopilot,
  setPairEnabled,
} from './actions'
import type { AccountCard } from './view-model'
import type { ConnectState } from '@/outreach/browser/connect'

/**
 * Managing the sending accounts, without a terminal.
 *
 * "Connect" opens a real Chrome window on that account's own profile and the page
 * polls until Instagram reports the login. That is the same flow `pnpm ig:login`
 * runs — the person still types the password into Instagram's own form, and this
 * process never sees it. Only the "are you done yet?" changed, from a shell prompt
 * to a poll.
 *
 * Each account shows exactly what is stopping it, because "not working" with no
 * reason is the failure mode that wastes the most time: not connected, connected but
 * not armed, armed but no channels enabled, or flagged by Instagram.
 */
export function AccountsPanel({ accounts }: { accounts: AccountCard[] }) {
  const [adding, setAdding] = useState(false)

  return (
    <section>
      <h2>
        Your accounts
        <span className="h2-note">the Instagram accounts that send</span>
      </h2>

      <div className="accounts">
        {accounts.map((a) => (
          <AccountRow key={a.handle} account={a} />
        ))}
      </div>

      {adding ? (
        <AddAccountForm onDone={() => setAdding(false)} />
      ) : (
        <div className="row">
          <button onClick={() => setAdding(true)}>Add an account</button>
        </div>
      )}
    </section>
  )
}

function AccountRow({ account }: { account: AccountCard }) {
  const [busy, setBusy] = useState(false)
  const [connect, setConnect] = useState<ConnectState | null>(
    account.connecting ? { state: 'waiting', message: 'Log in in the Chrome window.' } : null,
  )
  const [msg, setMsg] = useState<string | null>(null)
  const [confirmRemove, setConfirmRemove] = useState(false)
  const polling = useRef<ReturnType<typeof setInterval> | null>(null)

  /**
   * Poll only while a window is actually open, and always clear on unmount — a
   * forgotten interval would keep driving a browser after the operator navigated
   * away, which is the sort of thing that ends up sending something unexpected.
   */
  useEffect(() => {
    const live = connect?.state === 'waiting' || connect?.state === 'wrong-account'
    if (!live) {
      if (polling.current) clearInterval(polling.current)
      polling.current = null
      return
    }
    polling.current = setInterval(async () => {
      const next = await checkConnect(account.handle)
      setConnect(next)
    }, 3000)
    return () => {
      if (polling.current) clearInterval(polling.current)
      polling.current = null
    }
  }, [connect?.state, account.handle])

  const start = async () => {
    setBusy(true)
    setMsg(null)
    setConnect({ state: 'opening' })
    try {
      setConnect(await connectAccount(account.handle))
    } finally {
      setBusy(false)
    }
  }

  const stop = async () => {
    await abortConnect(account.handle)
    setConnect(null)
  }

  const arm = async () => {
    setBusy(true)
    try {
      const r = await setAccountAutopilot(account.handle, !account.autopilot)
      if (!r.ok) setMsg(r.message)
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    setBusy(true)
    try {
      const r = await removeSender(account.handle)
      setMsg(r.message)
      setConfirmRemove(false)
    } finally {
      setBusy(false)
    }
  }

  const connected = account.canSendAutomatically
  const enabledRoutes = account.routes.filter((r) => r.enabled)

  return (
    <div className="account-block">
      <div className="account">
        <span className={`dot ${account.state}`} aria-hidden />
        <span className="acc-name">{account.name}</span>
        <span className="acc-handle">@{account.handle}</span>
        <span className="acc-note">
          {connected
            ? account.autopilot
              ? enabledRoutes.length > 0
                ? `armed · messages ${enabledRoutes.length} channel${enabledRoutes.length === 1 ? '' : 's'}`
                : 'armed, but no channels turned on below'
              : 'connected · not armed'
            : account.note}
        </span>
        <span className="acc-actions">
          <button onClick={start} disabled={busy || connect?.state === 'waiting'}>
            {connect?.state === 'opening'
              ? 'Opening…'
              : connect?.state === 'waiting'
                ? 'Waiting…'
                : connected
                  ? 'Reconnect'
                  : 'Connect'}
          </button>
          <button
            onClick={arm}
            disabled={busy || !connected}
            title={connected ? '' : 'Connect this account first'}
          >
            {account.autopilot ? 'Disarm' : 'Arm'}
          </button>
          <button onClick={() => setConfirmRemove((v) => !v)} disabled={busy}>
            Remove
          </button>
        </span>
      </div>

      {connect && connect.state !== 'connected' ? (
        <div className={`connect-strip ${connect.state}`}>
          {connect.state === 'opening' ? 'Opening Chrome…' : null}
          {connect.state === 'waiting' ? (
            <>
              <strong>Log in as @{account.handle}</strong> in the Chrome window that just opened. Type the password
              yourself — this app never sees it. Accept “Save your login info” if offered. This page will notice
              automatically.
              <button className="link-btn" onClick={stop}>
                Cancel
              </button>
            </>
          ) : null}
          {connect.state === 'wrong-account' ? (
            <>
              That window is logged in as <strong>@{connect.actual}</strong>, not @{connect.expected}. Log out in the
              Chrome window and log in as @{connect.expected}.
              <button className="link-btn" onClick={stop}>
                Cancel
              </button>
            </>
          ) : null}
          {connect.state === 'closed' || connect.state === 'error' ? connect.message : null}
        </div>
      ) : null}

      {confirmRemove ? (
        <div className="connect-strip warn">
          Remove @{account.handle}? Anything it has already sent is kept — that record is what stops someone being
          messaged twice.
          <button className="link-btn" onClick={remove} disabled={busy}>
            Yes, remove
          </button>
          <button className="link-btn" onClick={() => setConfirmRemove(false)}>
            Keep it
          </button>
        </div>
      ) : null}

      {account.routes.length > 0 ? (
        <div className="routes">
          <span className="routes-label">Messages:</span>
          {account.routes.map((r) => (
            <RouteChip key={r.targetHandle} senderHandle={account.handle} route={r} />
          ))}
        </div>
      ) : (
        <div className="routes">
          <span className="routes-label">No channels yet — add one below.</span>
        </div>
      )}

      {msg ? <div className="connect-strip">{msg}</div> : null}
    </div>
  )
}

function RouteChip({ senderHandle, route }: { senderHandle: string; route: AccountCard['routes'][number] }) {
  const [busy, setBusy] = useState(false)
  const flip = async () => {
    setBusy(true)
    try {
      await setPairEnabled(senderHandle, route.targetHandle, !route.enabled)
    } finally {
      setBusy(false)
    }
  }
  return (
    <button
      className={`chip ${route.enabled ? 'on' : ''}`}
      onClick={flip}
      disabled={busy || route.targetRetired}
      title={
        route.targetRetired
          ? `@${route.targetHandle} is retired and will never be contacted again`
          : route.enabled
            ? `Stop messaging @${route.targetHandle} from @${senderHandle}`
            : `Let @${senderHandle} message @${route.targetHandle}`
      }
    >
      {route.enabled ? '● ' : '○ '}
      @{route.targetHandle}
    </button>
  )
}

function AddAccountForm({ onDone }: { onDone: () => void }) {
  const [handle, setHandle] = useState('')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  const submit = async () => {
    setBusy(true)
    setMsg(null)
    try {
      const r = await addSender(handle, name)
      setMsg({ ok: r.ok, text: r.message })
      if (r.ok) {
        setHandle('')
        setName('')
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="addform">
      <div className="addform-row">
        <label>
          <span>Instagram handle</span>
          <input
            value={handle}
            onChange={(e) => setHandle(e.target.value)}
            placeholder="tabishmukaddam1"
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        <label>
          <span>Display name (optional)</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Trial account" autoComplete="off" />
        </label>
        <button className="primary" onClick={submit} disabled={busy || handle.trim().length === 0}>
          {busy ? 'Adding…' : 'Add'}
        </button>
        <button onClick={onDone} disabled={busy}>
          Cancel
        </button>
      </div>
      <p className="cardnote">
        Added accounts start disconnected, unarmed, and with every channel off. Nothing sends until you connect it and
        turn a channel on.
      </p>
      {msg ? (
        <p className="cardnote" style={{ color: msg.ok ? 'var(--good)' : 'var(--warn)' }}>
          {msg.ok ? '✓ ' : '⚠ '}
          {msg.text}
        </p>
      ) : null}
    </div>
  )
}
