'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { clearChallenge, rejoinFleet, setSenderFleets, checkSignIn } from '../actions'
import { useConnect } from './use-connect'
import type { AccountGroup, AccountRow } from '../view-model/accounts-page'

/**
 * One group of accounts, collapsed to a count until you open it.
 *
 * COLLAPSED BY DEFAULT for the healthy groups, expanded for the ones that need a person.
 * At 65 accounts the page has to open on what is wrong; a list where everything is
 * equally visible is a list where nothing is.
 */
export function AccountGroupView({
  group,
  fleets = [],
  devices = [],
}: {
  group: AccountGroup
  /** Fleets an out-of-rotation account may rejoin for. Empty = only the default exists. */
  fleets?: readonly { slug: string; name: string }[]
  /**
   * Devices currently running an agent. On the hosted dashboard a Connect click opens the
   * sign-in window on one of these Macs, not here — so when more than one is online the row
   * offers a picker. On localhost this is ignored (the dashboard drives Chrome itself).
   */
  devices?: readonly string[]
}) {
  /**
   * OUT-OF-FLEET OPENS TOO, WHEN THERE IS SOMETHING TO DECIDE (2026-08-26).
   *
   * The group's only control is "put it back in the rotation", and a collapsed group renders
   * none of its rows — so an account we own, have already signed in, and want to use was
   * behind a click nothing invited. It opens when at least one row COULD rejoin (signed in,
   * not flagged); a burner with no session stays folded away, which is the state this group
   * was designed for.
   */
  const canRejoin = group.key === 'out-of-fleet' && group.rows.some((r) => r.connected && r.status !== 'CHALLENGED')
  const needsAttention = group.key === 'broken' || group.key === 'needs-login' || canRejoin
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
            <AccountRowView key={r.id} row={r} fleets={fleets} devices={devices} />
          ))}
        </div>
      )}
    </section>
  )
}

function AccountRowView({
  row,
  fleets = [],
  devices = [],
}: {
  row: AccountRow
  fleets?: readonly { slug: string; name: string }[]
  devices?: readonly string[]
}) {
  const router = useRouter()
  const [busyClear, setBusyClear] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  /**
   * The SHARED connect flow — the same start-then-poll the login queue runs. This button
   * used to fire once and say "reload this page"; the poll is what notices the sign-in,
   * closes the window (which is what saves the session), and records it.
   */
  const connect = useConnect(row.handle, { onConnected: () => router.refresh() })

  /**
   * Which Mac opens the sign-in window on the hosted dashboard. Defaults to the first
   * online device, so the common single-Mac case needs no choice; the picker appears only
   * when more than one is online, because then the wrong target would sign the account in
   * from the wrong home IP. Ignored on localhost (the server drives Chrome itself).
   */
  const [targetDevice, setTargetDevice] = useState<string | undefined>(devices[0])
  const startConnecting = () => connect.start(targetDevice)

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
        {/*
          ── THE WAY BACK INTO THE ROTATION (2026-08-26) ──────────────────────
          `fleetMember` was a one-way door: `removeSender` writes false and nothing in the
          tree ever wrote true, so an account we own and have already signed in could not be
          used again from anywhere in the product. It is rendered HERE, on the row it
          concerns, rather than as a separate form — the same reason every other remedy on
          this page sits on its own row.
        */}
        {!row.fleetMember && <RejoinControl handle={row.handle} fleets={fleets} onDone={() => router.refresh()} />}

        {/*
          ── WHICH FLEETS THIS PAGE SENDS FOR — A SET (2026-09-04, Tabish) ────
          Checkboxes rather than a dropdown, because a dropdown cannot express "both" and
          cannot express "none", and Tabish asked for all four states. Rendered only for a
          page IN the rotation: for one that has left it, the fleet is chosen as part of
          rejoining above, where the ordering is not in the operator's hands.
        */}
        {row.fleetMember && fleets.length > 0 && (
          <FleetControl
            handle={row.handle}
            fleets={fleets}
            current={row.categorySlugs}
            onDone={() => router.refresh()}
          />
        )}

        {/*
          ── VERIFY, AND SIGN IN AGAIN, ON AN ACCOUNT THAT LOOKS FINE (2026-08-26) ──
          `connected` is a cookie on disk plus the absence of a mark, so a session Instagram
          revoked server-side reads as connected and offered NO control — the row simply said
          it sends automatically until a real send failed. Both are here now: "Check sign-in"
          asks Instagram who the profile is, and "Sign in again" is the ordinary Connect flow
          made reachable deliberately rather than only after something breaks.
        */}
        {row.connected && connect.phase !== 'done' && <CheckSignIn handle={row.handle} onDone={() => router.refresh()} />}
        {devices.length > 1 && connect.phase !== 'done' && (
          <select
            value={targetDevice ?? ''}
            onChange={(e) => setTargetDevice(e.target.value)}
            aria-label={`Which Mac opens the sign-in for @${row.handle}`}
            title="More than one sending Mac is online — choose which one opens the sign-in window"
          >
            {devices.map((d) => (
              <option key={d} value={d}>
                on {d}
              </option>
            ))}
          </select>
        )}
        {row.connected && connect.phase !== 'done' && (
          <button
            className="btn-quiet"
            disabled={connect.phase === 'opening' || connect.phase === 'waiting' || row.connecting}
            onClick={startConnecting}
          >
            {connect.phase === 'opening'
              ? 'Opening Chrome…'
              : connect.phase === 'waiting' || row.connecting
                ? 'Waiting for you to sign in…'
                : 'Sign in again'}
          </button>
        )}

        {!row.connected && connect.phase !== 'done' && (
          <>
            <button
              disabled={connect.phase === 'opening' || connect.phase === 'waiting' || row.connecting}
              onClick={startConnecting}
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
            {/*
              ── `state` DOES NOT LOOK AT `fleetMember`, SO THIS SENTENCE DID NOT EITHER ──
              An out-of-rotation account with a live session is `state: 'ready'`, and this
              read "Sends automatically while Autopilot is on." underneath a heading that
              says it writes to nobody. Both cannot be true, and the heading is the correct
              one: `ensureFleetPairs` and `runOutreach` are scoped to `fleetMember: true`.
              A row asserting a capability its group denies is the same defect as a heading
              counting rows the claim is false of — already recorded here about this page,
              and reintroduced by a row that never asked the second question.
            */}
            {!row.fleetMember
              ? 'Writes to nobody — it is not in the rotation.'
              : row.state === 'ready'
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


/**
 * WHICH FLEETS A PAGE SENDS FOR — a SET, and any of the four states (2026-09-04, Tabish).
 *
 * *"a sender can be a part of either Bollywood or marketing or both or none."*
 *
 * CHECKBOXES, NOT A DROPDOWN, and that is the whole reason this is not `RejoinControl` with
 * one more option: a select expresses exactly one choice, so "both" and "none" are both
 * unsayable in it. The four states a person actually has are the four states this renders.
 *
 * PREVIEW THEN CONFIRM, like every other control on this page that creates routes: the first
 * press writes nothing and the server answers with the exact number of routes the selection
 * would create. Changing a box DISARMS it, because the count is a function of the selection
 * and confirming a number computed for a different one is the failure being prevented — the
 * 26 August one-click button put the burner in the rotation with 514 routes.
 *
 * Unchecking everything is allowed and is the "none" state: the page keeps its history and
 * its session and writes to nobody. Nothing is deleted — the membership is DISABLED, because
 * the send history rotation reads is interpreted against it.
 */
function FleetControl({
  handle,
  fleets,
  current,
  onDone,
}: {
  handle: string
  fleets: readonly { slug: string; name: string }[]
  current: readonly string[]
  onDone: () => void
}) {
  const [chosen, setChosen] = useState<string[]>([...current])
  const [busy, setBusy] = useState(false)
  const [armed, setArmed] = useState(false)
  const [outcome, setOutcome] = useState<{ ok: boolean; message: string } | null>(null)

  const toggle = (slug: string) => {
    setChosen((xs) => (xs.includes(slug) ? xs.filter((x) => x !== slug) : [...xs, slug]))
    setArmed(false)
    setOutcome(null)
  }
  const changed =
    chosen.length !== current.length || chosen.some((c) => !current.includes(c))

  return (
    <div className="fleet-control">
      <span className="fleet-control-label">Sends for</span>
      {fleets.map((f) => (
        <label key={f.slug} className="fleet-control-option">
          <input type="checkbox" checked={chosen.includes(f.slug)} onChange={() => toggle(f.slug)} />{' '}
          {f.name}
        </label>
      ))}
      {changed && (
        <button
          disabled={busy}
          onClick={async () => {
            setBusy(true)
            const r = await setSenderFleets(handle, chosen, armed)
            setOutcome(r)
            setBusy(false)
            /* A refused PREVIEW arms the second press; a real refusal must not. */
            if (!armed && !r.ok) setArmed(true)
            else {
              setArmed(false)
              onDone()
            }
          }}
        >
          {busy ? 'Saving…' : armed ? 'Confirm — change the fleets' : 'Save fleets'}
        </button>
      )}
      {chosen.length === 0 && changed ? (
        <p className="settingrow-argument">With no fleet ticked this page writes to nobody.</p>
      ) : null}
      {outcome ? <p className={outcome.ok ? 'account-todo' : 'settingrow-argument'}>{outcome.message}</p> : null}
    </div>
  )
}

/**
 * "Put it back in the rotation", with the fleet chosen at the same moment.
 *
 * THE FLEET IS PART OF THE SAME ACT, deliberately. `rejoinFleet` writes the membership
 * BEFORE creating the routes, because `routeAllowed` reads it — a fleet applied afterwards
 * leaves the account wired to every recipient of the other fleet and the gate holding those
 * drafts forever. Splitting this into "rejoin" then "set the fleet" would put that ordering
 * in the operator's hands, which is exactly where it must not be.
 *
 * The dropdown renders only when a second fleet exists, matching the add form: one option is
 * not a choice.
 */
function RejoinControl({
  handle,
  fleets,
  onDone,
}: {
  handle: string
  fleets: readonly { slug: string; name: string }[]
  onDone: () => void
}) {
  const [fleet, setFleet] = useState('')
  const [busy, setBusy] = useState(false)
  const [outcome, setOutcome] = useState<{ ok: boolean; message: string } | null>(null)
  /**
   * The server's PREVIEW has been shown and this click is the confirmation. Reset whenever
   * the fleet changes, because the route count is a function of the fleet — confirming a
   * number computed for a different one is the thing this exists to prevent.
   */
  const [armed, setArmed] = useState(false)

  return (
    <>
      {fleets.length > 0 && (
        <select
          value={fleet}
          onChange={(e) => {
            setFleet(e.target.value)
            setArmed(false)
            setOutcome(null)
          }}
          aria-label={`Which fleet @${handle} sends for`}
        >
          {/*
            The empty option is "no explicit membership", which `effectiveCategories` reads as
            bollywood. It is HIDDEN once a real `bollywood` Category row exists (2026-09-04),
            or the list would offer the same fleet twice under two names and the operator
            would have to guess which one the enforcers read.
          */}
          {!fleets.some((f) => f.slug === 'bollywood') && (
            <option value="">Bollywood (the original fleet)</option>
          )}
          {fleets.map((f) => (
            <option key={f.slug} value={f.slug}>
              {f.name}
            </option>
          ))}
        </select>
      )}
      <button
        disabled={busy}
        onClick={async () => {
          setBusy(true)
          const r = await rejoinFleet(handle, fleet, armed)
          setOutcome(r)
          setBusy(false)
          /* A refused PREVIEW arms the second press; a real refusal must not. */
          if (!armed && !r.ok) setArmed(true)
          else {
            setArmed(false)
            onDone()
          }
        }}
      >
        {busy ? 'Adding…' : armed ? 'Confirm — put it back in the rotation' : 'Put back in the rotation'}
      </button>
      {outcome ? <p className={outcome.ok ? 'account-todo' : 'settingrow-argument'}>{outcome.message}</p> : null}
    </>
  )
}

/**
 * "Is this account actually signed in?" — asked of Instagram, not of the filesystem.
 *
 * The answer is deliberately rendered in full rather than reduced to a tick: the four
 * outcomes have four different remedies, and the one that matters most — the profile holding
 * SOMEBODY ELSE'S session — is invisible in any boolean. `unknown` writes nothing and says
 * so, because "we could not ask" is not evidence about the account.
 */
function CheckSignIn({ handle, onDone }: { handle: string; onDone: () => void }) {
  const [busy, setBusy] = useState(false)
  const [outcome, setOutcome] = useState<{ ok: boolean; message: string } | null>(null)

  return (
    <>
      <button
        className="btn-quiet"
        disabled={busy}
        onClick={async () => {
          setBusy(true)
          setOutcome(await checkSignIn(handle))
          setBusy(false)
          onDone()
        }}
        title="Opens this account's browser profile and asks Instagram who it is"
      >
        {busy ? 'Asking Instagram…' : 'Check sign-in'}
      </button>
      {outcome ? (
        <p className={outcome.ok ? 'account-todo' : 'settingrow-argument'} style={{ flexBasis: '100%' }}>
          {outcome.message}
        </p>
      ) : null}
    </>
  )
}
