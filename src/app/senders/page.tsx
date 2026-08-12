import { redirect } from 'next/navigation'
import { currentUser } from '@/lib/session'
import { buildAccountsPage, buildLoginQueue } from '../view-model/accounts-page'
import { Nav } from '../nav'
import { AccountGroupView } from '../accounts/group'
import { LoginQueue } from '../accounts/login/queue'

export const dynamic = 'force-dynamic'

/**
 * `/senders` — our accounts. One page for the whole question, since the simple-sender
 * redesign folded `/accounts` and `/accounts/login` together: an account that needs a
 * login and the queue for doing logins were two pages describing one job.
 *
 * Rows are grouped by THE NEXT THING TO DO, counts first. Each row's signed-in state is
 * one of three, from §3.5, and it is EVIDENCE rather than a cookie check: `signed in`
 * (cookie on disk, nothing has disproved it) · `needs signing in again` (a real send
 * found it logged out, with the time) · `never signed in`. The rationale prose that
 * lived here — device identity, why logins are by hand, the group ladder's reasoning —
 * is on /rules.
 */
export default async function SendersPage() {
  const user = await currentUser()
  if (!user) redirect('/sign-in')

  const [v, q] = await Promise.all([buildAccountsPage(), buildLoginQueue()])
  const total = q.done + q.remaining

  return (
    <>
      <Nav current="/senders" email={user.email} />
      <div className="page">
        <header className="page-head">
          <h1>Senders</h1>
          <p className="page-sub">
            {v.total} sending {v.total === 1 ? 'account' : 'accounts'}
          </p>
        </header>

        <ul className="summary-row" aria-label="Fleet summary">
          <li>
            <strong>{v.summary.ready}</strong>
            <span>sending on their own</span>
          </li>
          {/*
            "waiting for a click" IS GONE — one switch, 2026-08-08.

            It counted accounts whose per-account auto-send bit was off, and there is no such bit.
            Every account is now in exactly one of the four remaining buckets, so the row still
            sums to the total; nothing is hidden by the removal.
          */}
          {/* "signature", not "persona" — the banner below and every row already say signature. */}
          <li>
            <strong>{v.summary.needsPersona}</strong>
            <span>sharing a signature</span>
          </li>
          <li>
            <strong>{v.summary.needsLogin}</strong>
            <span>need signing in</span>
          </li>
          <li className={v.summary.broken > 0 ? 'bad' : undefined}>
            <strong>{v.summary.broken}</strong>
            <span>need you now</span>
          </li>
        </ul>

        {/* The binding constraint when it binds, stated once — not repeated per row. */}
        {v.sharingPersona > 0 && v.personaGateCoversChannels && (
          <div className="banner banner-warn">
            <strong>Nothing is sending.</strong> {v.sharingPersona} of {v.total} accounts sign off identically. Give
            each its own signature below.
          </div>
        )}

        {q.remaining > 0 && (
          <section className="group">
            <h2>Sign-ins</h2>
            <div className="progress-block">
              <div className="progress-bar" role="img" aria-label={`${q.done} of ${total} signed in`}>
                <span style={{ width: `${total === 0 ? 0 : Math.round((q.done / total) * 100)}%` }} />
              </div>
              <p>
                <strong>
                  {q.done} of {total}
                </strong>{' '}
                signed in
              </p>
            </div>

            {/*
              The group ladder, shown when there is more than the baseline group. It is still
              enforced — `gate.ts` asks `mayArmAccount` at the moment of delivery — and it is
              still invisible without this, which is why the refusal has to be on screen: a
              group serving its settling-in period looks exactly like one that is simply idle.

              ONE SWITCH, 2026-08-08: the wording no longer says "armed" or "switched on", because
              there is nothing to switch. A blocked group is one that has not STARTED SENDING yet.
            */}
            {q.ladder.length > 1 && (
              <ul className="plain-list">
                {q.ladder.map((c) => (
                  <li key={c.cohort}>
                    <strong>Group {c.cohort}</strong> — {c.total} account{c.total === 1 ? '' : 's'}, {c.connected}{' '}
                    signed in, {c.live} sending on their own
                    {c.soakDays !== null && (
                      <>
                        {' '}
                        · sending for {c.soakDays} day{c.soakDays === 1 ? '' : 's'}
                      </>
                    )}
                    {c.flagged > 0 && (
                      <>
                        {' '}
                        · <strong>{c.flagged} questioned by Instagram</strong>
                      </>
                    )}
                    {c.blockedBecause && <div className="muted">Not sending yet: {c.blockedBecause}</div>}
                  </li>
                ))}
              </ul>
            )}

            <LoginQueue queue={q.queue} />
          </section>
        )}

        {v.groups.map((g) => (
          <AccountGroupView key={g.key} group={g} />
        ))}
      </div>
    </>
  )
}
