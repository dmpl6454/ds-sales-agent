import { redirect } from 'next/navigation'
import { currentUser } from '@/lib/session'
import { buildAccountsPage, buildLoginQueue } from '../view-model/accounts-page'
import { Nav } from '../nav'
import { PageHead } from '../page-head'
import { AccountGroupView } from '../accounts/group'
import { LoginQueue } from '../accounts/login/queue'
import { AddSenderForm } from './add-form'

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
        <PageHead title="Senders" sub={`${v.total} sending ${v.total === 1 ? 'account' : 'accounts'}`} />

        {/*
          A JOINED grid rather than four floating numbers: these four counts partition the
          fleet — every account is in exactly one bucket and they sum to the total — so they
          are one object, and hairlines between the cells say that better than gaps do.
        */}
        <ul className="statgrid" aria-label="Fleet summary">
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
              <div className="ladder">
                {q.ladder.map((c) => (
                  <div className="ladder-row" key={c.cohort}>
                    <span className="ladder-name">Group {c.cohort}</span>
                    <span className="ladder-counts">
                      {c.connected} of {c.total} signed in · {c.live} sending
                    </span>
                    {/*
                      The soak drawn against the required days, so "day 9 of 14" is a length
                      rather than a sentence to parse. A group with no send history has no bar
                      at all — an empty bar would read as "0% of the way through", which is a
                      claim about progress that has not started.
                    */}
                    <div
                      className="ladder-bar"
                      role="img"
                      aria-label={
                        c.soakDays === null
                          ? 'Has not started sending'
                          : `Sending for ${c.soakDays} of ${q.soakDays} days`
                      }
                    >
                      {c.soakDays !== null && (
                        <span style={{ width: `${Math.min(100, Math.round((c.soakDays / q.soakDays) * 100))}%` }} />
                      )}
                    </div>
                    <span className="ladder-state">
                      {c.flagged > 0 ? (
                        <span className="note-bad">{c.flagged} questioned by Instagram</span>
                      ) : c.blockedBecause ? (
                        `Not sending yet: ${c.blockedBecause}`
                      ) : c.soakDays !== null ? (
                        `Sending for ${c.soakDays} day${c.soakDays === 1 ? '' : 's'}`
                      ) : (
                        'Has not started'
                      )}
                    </span>
                  </div>
                ))}
              </div>
            )}

            <LoginQueue queue={q.queue} />
          </section>
        )}

        {v.groups.map((g) => (
          <AccountGroupView key={g.key} group={g} />
        ))}

        {/*
          ADDING AN ACCOUNT HAD NO UI AT ALL until 2026-08-17. `addSender` existed in
          actions.ts — validated, audited, creating routes — and nothing in `src/app`
          imported it, so the only way in was writing to the database by hand. `/targets`
          had its form the whole time, which is why the pair looked symmetrical.

          Last on the page deliberately: the question this page answers is "can my accounts
          send", and adding one is the rarer act.
        */}
        <AddSenderForm />
      </div>
    </>
  )
}
