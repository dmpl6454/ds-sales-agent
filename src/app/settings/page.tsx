import Link from 'next/link'
import { redirect } from 'next/navigation'
import { currentUser } from '@/lib/session'
import { getSettings, describeCap } from '@/lib/settings'
import { env } from '@/lib/env'
import { Nav } from '../nav'
import { cohortSize, cohortSoakDays } from '@/outreach/cohorts'
import { SettingsForm } from './form'

export const dynamic = 'force-dynamic'

/**
 * `/settings` — the knobs that change who gets messaged, and how often.
 *
 * Every one of these is a SAFETY control, so each is shown with what it actually does
 * and what it costs to change, not just a label and a box. A number on a form with no
 * consequence attached invites tuning it toward throughput, which is the one direction
 * this system must not drift.
 *
 * The env HARD FLOORS are shown read-only beside them. `AUTOPILOT_ENABLED` in particular
 * is a boundary a web page must not be able to cross: a dashboard is reachable by
 * anything that can reach the port, so the environment is what limits it.
 */
export default async function SettingsPage() {
  const user = await currentUser()
  if (!user) redirect('/sign-in')

  const s = await getSettings()
  /**
   * The LIVE values, not the exported defaults. A page that states a rule from a constant
   * while a `Setting` row is what the code enforces is the "a limit reported by a different
   * rule than the one enforcing it" mistake, and CLAUDE.md records what that already cost:
   * the planner refused to prepare anything for two days behind a dashboard showing headroom.
   */
  const [soakDays, groupSize] = await Promise.all([cohortSoakDays(), cohortSize()])

  return (
    <>
      <Nav current="/settings" email={user.email} />
      <div className="page">
        <header className="page-head">
          <h1>Settings</h1>
          <p className="page-sub">These change who gets messaged and how often. Each one is a safety control.</p>
        </header>

        <SettingsForm
          initial={{
            maxPerTargetPerDay: describeCap(s.maxPerTargetPerDay),
            defaultCooldownDays: String(s.defaultCooldownDays),
            hookMaxAgeHours: String(s.hookMaxAgeHours),
            maxNewBrandTouchesPerDay: String(s.maxNewBrandTouchesPerDay),
            personaGateChannels: s.personaGateChannels,
            autopilotEnabled: s.autopilotEnabled,
          }}
        />

        {/*
          Two things that are BUILT and switched off. On screen because a capability nobody
          can see is one nobody can decide about — and both of these are decisions rather than
          settings, so neither gets a toggle here.
        */}
        <section className="group">
          <h2>Built, and switched off</h2>
          <ul className="plain-list">
            <li>
              <strong>Letting the computer write the messages</strong> — {s.generateMessages ? 'ON' : 'off'}
              <div className="group-blurb">
                A draft would be written from scratch for each recipient and checked automatically before anyone could
                send it: no gaps left unfilled, the right length, your name and number untouched, and no number about
                our reach that is not one of ours. Anything that fails those checks falls back to a message you wrote.
                <br />
                What the checks <em>cannot</em> do is tell whether a sentence about the recipient, or about us, is
                true — one draft claimed we run pet-food pages. So this stays off until you have read a few. Run{' '}
                <code>pnpm ig:generate --run --limit 3</code> to print three real ones for about a third of a penny.
              </div>
            </li>
            <li>
              <strong>Going live a few accounts at a time</strong> — groups of {groupSize},{' '}
              {soakDays} days apart
              <div className="group-blurb">
                Sixty-one more pages are meant to send from here. A group sends for {soakDays} days before the next
                can be switched on, and any account questioned by
                Instagram stops the sequence. Progress is on{' '}
                <Link href="/senders">the sign-in page</Link>. Nothing has been added yet.
              </div>
            </li>
          </ul>
        </section>

        <section className="group">
          <h2>Set outside the dashboard</h2>
          <p className="group-blurb">
            These live in <code>.env</code> and a web page deliberately cannot change them. A dashboard is reachable
            by anything that can reach the port, so unattended sending needs a boundary that a page cannot cross.
          </p>
          <ul className="plain-list">
            <li>
              <strong>May this machine send unattended at all</strong> —{' '}
              {env.AUTOPILOT_ENABLED ? 'yes' : 'no'} <span className="muted">AUTOPILOT_ENABLED</span>
            </li>
            <li>
              <strong>Lifetime ceiling on messages</strong> —{' '}
              {env.MAX_TOTAL_SENDS === null ? 'no ceiling' : env.MAX_TOTAL_SENDS}{' '}
              <span className="muted">MAX_TOTAL_SENDS</span>
            </li>
            <li>
              <strong>Detection starts</strong> — 1 August 2026 <span className="muted">DETECTION_CUTOFF</span>
            </li>
          </ul>
        </section>
      </div>
    </>
  )
}
