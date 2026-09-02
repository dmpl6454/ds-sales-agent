'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { setUserRole } from '../actions'
import type { Role } from '@/lib/roles'

/**
 * WHO CAN USE THIS DASHBOARD. Operator-only — the page renders it only for an operator, and
 * every action re-checks on the server, so a viewer cannot reach it either way.
 *
 * People sign up with the invite code as VIEWERS (a leaked code must never land on a Send
 * button). An operator promotes a trusted person here; the promotion is audited under the
 * operator's name. You cannot change your own role — the server refuses it — which keeps at
 * least one operator standing and stops a self-lockout.
 */
export function TeamPanel({ users }: { users: Array<{ email: string; role: Role; isSelf: boolean }> }) {
  const router = useRouter()
  const [busy, setBusy] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  const change = async (email: string, role: Role) => {
    setBusy(email)
    setMessage(null)
    const r = await setUserRole(email, role)
    setMessage(r.message)
    setBusy(null)
    if (r.ok) router.refresh()
  }

  return (
    <section className="group">
      <h2>People who can use this dashboard</h2>
      <p className="muted">
        A viewer can watch everything. An operator can connect accounts, send, and switch
        Autopilot. New people arrive as viewers — promote the ones you trust.
      </p>
      <ul className="plain-list">
        {users.map((u) => (
          <li key={u.email} className="team-row">
            <span>
              {u.email} <span className="chip">{u.role}</span>
              {u.isSelf && <span className="muted"> — you</span>}
            </span>
            {!u.isSelf &&
              (u.role === 'operator' ? (
                <button className="btn-quiet" disabled={busy === u.email} onClick={() => change(u.email, 'viewer')}>
                  {busy === u.email ? 'Saving…' : 'Make viewer'}
                </button>
              ) : (
                <button disabled={busy === u.email} onClick={() => change(u.email, 'operator')}>
                  {busy === u.email ? 'Saving…' : 'Make operator'}
                </button>
              ))}
          </li>
        ))}
      </ul>
      {message && <p className="account-message">{message}</p>}
    </section>
  )
}
