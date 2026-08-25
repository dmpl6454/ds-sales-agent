'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { clearChallenge } from '../actions'
import { useConnect } from './use-connect'
import type { AccountGroup, AccountRow } from '../view-model/accounts-page'

/**
 * One group of accounts, collapsed to a count until you open it.
 *
 * COLLAPSED BY DEFAULT for the healthy groups, expanded for the ones that need a person.
 * At 65 accounts the page has to open on what is wrong; a list where everything is
 * equally visible is a list where nothing is.
 */
export function AccountGroupView({ group }: { group: AccountGroup }) {
  const needsAttention = group.key === 'broken' || group.key === 'needs-login'
  const [open, setOpen] = useState(needsAttention)

  return (
    <section className={`group group-${group.key}`}>
      <button className="group-head groupbtn" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="group-count">{group.rows.length}</span>
        <span className="group-title">{group.title}</span>
        <span className="group-toggle">{open ? '−' : '+'}</span>
      </button>
      {open && (
        <div className="sendergrid">
          {group.rows.map((r) => (
            <AccountRowView key={r.id} row={r} />
          ))}
        </div>
      )}
    </section>
  )
}

function AccountRowView({ row }: { row: AccountRow }) {
  const router = useRouter()
  const [busyClear, setBusyClear] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  /**
   * The SHARED connect flow — the same start-then-poll the login queue runs. This button
   * used to fire once and say "reload this page"; the poll is what notices the sign-in,
   * closes the window (which is what saves the session), and records it.
   */
  const connect = useConnect(row.handle, { onConnected: () => router.refresh() })

  return (
    <article className={`account account-${row.state}`}>
      <div className="account-main">
        <div>
          <h3>
            @{row.handle} <span className="account-name">{row.name}</span>
            {/*
              WHICH FLEET this page sends for (2026-08-25). Rendered only for an explicit
              membership: the default IS the absence of one, so a "bollywood" chip on every
              row would be furniture. A marketing chip is the answer to "why has this page
              sent nothing to any of the companies I can see?".
            */}
            {row.categories.map((c) => (
              <span className="chip" key={c}>
                {c}
              </span>
            ))}
          </h3>
        </div>
        <div className="account-figures">
          <span title="Delivered in the last 7 days">{row.sentThisWeek} this week</span>
          <span title="Today's allowance used">
            {row.sentToday}/{row.dailyCap} today
          </span>
        </div>
      </div>

      {/* THE one next action, on the row it concerns — never a to-do list elsewhere. */}
      {row.todo && <p className="account-todo">{row.todo}</p>}

      <div className="account-actions">
        {!row.connected && connect.phase !== 'done' && (
          <>
            <button
              disabled={connect.phase === 'opening' || connect.phase === 'waiting' || row.connecting}
              onClick={connect.start}
            >
              {connect.phase === 'opening'
                ? 'Opening Chrome…'
                : connect.phase === 'waiting' || row.connecting
                  ? 'Waiting for you to sign in…'
                  : connect.phase === 'error'
                    ? 'Try again'
                    : 'Connect'}
            </button>
            {connect.phase === 'waiting' && (
              <button className="link-quiet" onClick={connect.cancel}>
                cancel
              </button>
            )}
          </>
        )}

        {row.status === 'CHALLENGED' && (
          <button
            className="danger"
            disabled={busyClear}
            onClick={async () => {
              setBusyClear(true)
              const r = await clearChallenge(row.handle)
              setMessage(r.message)
              setBusyClear(false)
            }}
          >
            {busyClear ? 'Releasing…' : 'I have checked it — release the halt'}
          </button>
        )}

        {/*
          ── ABILITY, NOT A TOGGLE ─────────────────────────────────────────────

          This was an "Auto-send: on/off" button. It is a SENTENCE now, because with one
          switch there is nothing per-account left to decide: either this account can send
          or it needs a sign-in, and both are facts rather than settings.

          It still says whether anything will happen here — the control went, the answer
          did not. "while Autopilot is on" is the honest qualifier: a row must not promise
          sending when the one switch is off.

          `broken` says nothing here on purpose, and that is not an omission. Those rows
          already carry `row.todo` above plus the control that resolves them (release the
          halt, edit the signature); a second sentence guessing "needs a sign-in" would be
          WRONG about a flagged account and would be the duplication the redesign removed.
        */}
        {row.state !== 'broken' && (
          <span className="muted">
            {row.state === 'ready'
              ? 'Sends automatically while Autopilot is on.'
              : 'Needs a one-time sign-in before it can send.'}
          </span>
        )}
      </div>

      {/* Outside the editor, so the success message is not unmounted by the save. */}
      {(connect.detail || message) && (
        <p className={connect.phase === 'error' ? 'account-message bad' : 'account-message'}>
          {connect.detail ?? message}
        </p>
      )}
    </article>
  )
}

