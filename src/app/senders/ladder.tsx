import Link from 'next/link'
import type { AccountGroup } from '../view-model/accounts-page'

/**
 * THE FLEET AS ONE LADDER — the mockup's Accounts list.
 *
 * ── WHY ONE LIST RATHER THAN THE FOUR GROUPS BELOW IT ───────────────────────
 *
 * The grouped cards answer "what is wrong with this account, and what are the controls";
 * they are the right shape for acting on a row and the wrong shape for the question a person
 * opens this page with, which is *can the fleet send right now*. Four collapsible groups make
 * that a counting exercise across headings.
 *
 * So this is one row per account, ordered worst-first, each stating its own state in a
 * sentence and carrying at most ONE control — the single next thing a person must do. The
 * groups keep everything else. Nothing is duplicated between them that a reader must
 * reconcile: this list never offers a control the group below would offer differently.
 *
 * ── THE DOT IS THE STATE, AND IT IS DERIVED ─────────────────────────────────
 *
 * Green means this account can send unattended right now; amber means a person must sign it
 * in; red means Instagram has flagged it and nothing should touch it until someone looks.
 * All three come from `AccountRow.state`, which is computed from the session, the status and
 * the fleet flag — never from a switch, because there has not been one since the one-switch
 * change and a row claiming otherwise would be describing a control that does not exist.
 */
export function SenderLadder({ groups }: { groups: AccountGroup[] }) {
  /* Worst first: a flagged account is the only row on this page that can stop the whole
     fleet, so it must never sit below three healthy ones. */
  const order: AccountGroup['key'][] = ['broken', 'needs-login', 'ready', 'out-of-fleet']
  const rows = order.flatMap((key) => groups.find((g) => g.key === key)?.rows ?? [])
  if (rows.length === 0) return null

  return (
    <section>
      <h2>Accounts</h2>
      <div className="ladder">
        {rows.map((r) => {
          const dot = r.state === 'broken' ? 'dot-bad' : r.state === 'ready' ? 'dot-good' : 'dot-warn'
          return (
            <div className="ladder-row" key={r.id}>
              {/*
                LEFT CLUSTER, AS ITS OWN FLEX GROUP. The dot and `.sender-main` used to be two
                direct children of the row alongside the badge/button, which made `.sender-main`
                a flex item with nothing forcing it to fill the row -- so its two children (the
                name line and the status sentence) sat side by side as two cramped, independently
                text-wrapping columns instead of one stacked block. Wrapping them here gives the
                row a clean two-part shape -- identity (flexes, shrinks, truncates) and action
                (fixed, pinned right) -- which is the layout every other `.ladder-row` reader
                sees for granted below.
              */}
              <div className="ladder-left">
                <span className={`dot ${dot}`} aria-hidden />
                <div className="sender-main">
                  <div className="sender-name">
                    @{r.handle} <span className="sender-real">{r.name}</span>
                  </div>
                  {/*
                    The row's own sentence, from the view model. `todo` is the ONE next action
                    when there is one; otherwise the row reports what it has been doing, which
                    is what makes a healthy fleet legible at a glance rather than blank.
                  */}
                  <div className={r.todo ? 'sender-sub sender-sub-warn' : 'sender-sub'}>
                    {r.todo ??
                      (r.state === 'ready'
                        ? `${r.sentThisWeek} sent this week · ${r.sentToday} today`
                        : 'Not in the rotation — writes to nobody')}
                  </div>
                </div>
              </div>

              {r.state === 'ready' ? (
                /*
                  "Sending" and "Ready" are the mockup's own split, and it is a real one
                  rather than an invented flourish: `sentThisWeek`/`sentToday` are already
                  computed for the sub-line two rows up, so an account that CAN send but has
                  not delivered anything yet this week (just signed in, or waiting for the
                  active-hours window to open) is a genuinely different fact from one that
                  is actively working through the queue -- collapsing both into "Sending"
                  claimed an activity level nothing had observed.
                */
                r.sentThisWeek > 0 || r.sentToday > 0 ? (
                  <span className="pill pill-good">Sending</span>
                ) : (
                  <span className="pill pill-ac">Ready</span>
                )
              ) : r.state === 'broken' ? (
                <span className="pill pill-bad">Flagged</span>
              ) : (
                /* A sign-in cannot happen on this server — it needs the Mac that holds the
                   profile — so the control is a link to where that is done, never a button
                   that would have to refuse. Worded like the mockup's own action ("Open
                   Chrome, sign in") because that is genuinely where this leads: the Connect
                   control just below opens a real Chrome window on the operator's own Mac. */
                <Link href="/senders#sign-ins" className="btn btn-primary">
                  Open Chrome, sign in
                </Link>
              )}
            </div>
          )
        })}
      </div>
    </section>
  )
}
