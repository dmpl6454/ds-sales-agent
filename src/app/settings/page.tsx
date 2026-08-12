import Link from 'next/link'
import { redirect } from 'next/navigation'
import { currentUser } from '@/lib/session'
import { getSettings, describeCap } from '@/lib/settings'
import { env } from '@/lib/env'
import { Nav } from '../nav'
import { PageHead } from '../page-head'
import { cohortSize, cohortSoakDays } from '@/outreach/cohorts'
import { SettingsForm } from './form'

export const dynamic = 'force-dynamic'

/**
 * `/settings` — the knobs that change who gets messaged, and how often.
 *
 * Every one of these is a SAFETY control, so each is shown with what it actually does and
 * what it costs to change, not just a label and a box. That principle is unchanged; what
 * changed is that the reasoning now sits behind a disclosure instead of stacking four
 * essays on top of each other, so all four caps are visible at once.
 *
 * The env HARD FLOORS are shown read-only in their own section, in a dashed box that does
 * not look like the editable ones. `AUTOPILOT_ENABLED` in particular is a boundary a web
 * page must not be able to cross: a dashboard is reachable by anything that can reach the
 * port, so the environment is what limits it — the same reasoning as `SIGNUP_INVITE_CODE`.
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
        <PageHead
          title="Settings"
          sub="These change who gets messaged and how often. Each one is a safety control."
        />

        <div className="settings-layout">
          {/* Sticky, because the page is long by necessity and losing your place in a list
              of safety controls is how the wrong one gets changed. */}
          <nav className="settings-nav" aria-label="Setting groups">
            <a href="#volume">Volume and spacing</a>
            <a href="#identity">Identity</a>
            <a href="#off">Built, and switched off</a>
            <a href="#env">Set outside the dashboard</a>
          </nav>

          <div className="settings-body">
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
              Two things that are BUILT and switched off. On screen because a capability
              nobody can see is one nobody can decide about — and both are DECISIONS rather
              than settings, so neither gets a toggle here.
            */}
            <section id="off">
              <h2>Built, and switched off</h2>
              <div className="stack">
                <div className="card">
                  <div className="row-between">
                    <p style={{ margin: 0, fontWeight: 500 }}>Letting the computer write the messages</p>
                    <span className="eyebrow">{s.generateMessages ? 'on' : 'off'}</span>
                  </div>
                  <p className="settingrow-consequence">
                    Each draft would be written from scratch for its recipient and checked automatically
                    before anyone could send it: no gaps left unfilled, the right length, your name and
                    number untouched, and no claim about our reach that is not one of ours.
                  </p>
                  {/*
                    THE HONEST LIMIT, stated rather than buried. This is the reason it is off,
                    and it is not the cost — measured at well under $10/year at full scale.
                  */}
                  <p className="blurb">
                    What the checks <em>cannot</em> do is tell whether a sentence about the recipient, or
                    about us, is true — one draft claimed we run pet-food pages. So this stays off until
                    someone has read a few.
                  </p>
                </div>

                <div className="card">
                  <div className="row-between">
                    <p style={{ margin: 0, fontWeight: 500 }}>Going live a few accounts at a time</p>
                    <span className="eyebrow">
                      groups of {groupSize} · {soakDays} days apart
                    </span>
                  </div>
                  <p className="settingrow-consequence">
                    Sixty-one more pages are meant to send from here. A group sends for {soakDays} days
                    before the next one can, and any account questioned by Instagram stops the sequence.
                  </p>
                  <p className="blurb">
                    Nothing needs switching on — it is worked out from what has actually been delivered,
                    not from a setting. Progress is on <Link href="/senders">Senders</Link>.
                  </p>
                </div>
              </div>
            </section>

            <section id="env">
              <h2>Set outside the dashboard</h2>
              {/*
                A DASHED border, so it does not read as "editable but currently disabled".
                These are not switched off — they are not this page's to change at all.
              */}
              <div className="card card-locked">
                <p className="settingrow-consequence">
                  A dashboard is reachable by anything that can reach the port, so unattended sending
                  needs a boundary a web page cannot cross. These are read-only here, by design.
                </p>
                <div className="lockedrows">
                  <div className="row-between">
                    <span>May this machine send unattended at all</span>
                    <span className="muted">{env.AUTOPILOT_ENABLED ? 'yes' : 'no'}</span>
                  </div>
                  <div className="row-between">
                    <span>Lifetime ceiling on messages</span>
                    <span className="muted">
                      {env.MAX_TOTAL_SENDS === null ? 'no ceiling' : env.MAX_TOTAL_SENDS}
                    </span>
                  </div>
                  <div className="row-between">
                    <span>Detection starts</span>
                    <span className="muted">1 August 2026</span>
                  </div>
                </div>
              </div>
            </section>
          </div>
        </div>
      </div>
    </>
  )
}
