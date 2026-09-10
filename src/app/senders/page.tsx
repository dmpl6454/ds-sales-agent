import { redirect } from 'next/navigation'
import { currentUser } from '@/lib/session'
import { buildAccountsPage, buildLoginQueue } from '../view-model/accounts-page'
import { listCategories } from '@/outreach/categories'
import { readPresence } from '@/agent'
import { Nav } from '../nav'
import { PageHead } from '../page-head'
import { AccountGroupView } from '../accounts/group'
import { LoginQueue } from '../accounts/login/queue'
import { AddSenderForm } from './add-form'
import { RemoveSenderForm } from './remove-form'
import { TeamPanel } from './team-panel'
import { listTeam, revokeDevice, approveDevice } from '../actions'
import { listPairedDevices, listPendingEnrolments } from '@/lib/deviceEnrol'
import { readInstallerBuild } from '@/lib/installerBuild'
import { getSettings } from '@/lib/settings'
import { ActiveDeviceSection } from './active-device'
import { buildVersion } from '@/lib/buildVersion'

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
export default async function SendersPage({ searchParams }: { searchParams: Promise<{ paired?: string }> }) {
  const sp = await searchParams
  const user = await currentUser()
  if (!user) redirect('/sign-in')

  /**
   * The Macs currently running an agent (seen within 2 minutes). On the hosted dashboard a
   * Connect click opens the sign-in window on one of THESE, not on the server — so the rows
   * offer a picker when more than one is online. Read here (a server component) rather than
   * via the operator-gated action, so a VIEWER can still load the page.
   */
  const now = Date.now()
  const presence = (await readPresence()).filter((d) => now - new Date(d.at).getTime() < 2 * 60_000)
  const devices = presence.map((d) => d.device)
  // handle → the Macs holding a signed-in profile for it, so a row can say where an account
  // lives and warn when that is two places (2026-09-10).
  const signedInOn: Record<string, string[]> = {}
  for (const d of presence) for (const h of d.handles ?? []) (signedInOn[h] ??= []).push(d.device)
  // WHICH BUILD EACH MAC RUNS, BESIDE THE BUILD THE INSTALLER CARRIES (2026-09-08). Installed
  // Macs do not auto-update; a re-run of a newer image does update them, and this is the screen
  // that says whether that has happened. Absent (an agent older than this field) renders as
  // "unknown", never as current.
  const agentBuild = new Map(presence.map((d) => [d.device, d.version ? { version: d.version, source: d.versionSource ?? 'unknown' } : null] as const))
  const installerBuild = readInstallerBuild()
  const thisBuild = buildVersion()

  // Only an operator manages the team; a viewer gets the page without that section.
  const team = user.role === 'operator' ? await listTeam() : null

  const [v, q, fleets] = await Promise.all([
    buildAccountsPage(),
    buildLoginQueue(),
    /**
     * The fleets a new account may be put in, beside the default. Read here rather than
     * inside the form because the form is a CLIENT component — a query reachable from the
     * browser bundle is the `waiting.tsx -> gate.ts -> better-sqlite3` trap that returned
     * HTTP 500 on every route.
     */
    listCategories(),
  ])
  const total = q.done + q.remaining
  /* The Macs whose own tunnel keys this server holds; empty on a laptop, where there is no authorized_keys to read. */
  const paired = listPairedDevices()
  const waiting = await listPendingEnrolments()
  // THE SENDING MAC (2026-09-10): the one Mac doing the fleet's work, and every Mac that could be.
  // Paired (holds a tunnel key on this box) ∪ beating (the maintainer's Mac pairs by its own key).
  const activeDevice = (await getSettings()).activeDevice
  const knownMacs = [...new Set([...paired.map((d) => d.name), ...devices])]
  const sendingMacOptions = knownMacs.map((name) => ({
    name,
    online: devices.includes(name),
    handles: presence.find((d) => d.device === name)?.handles ?? [],
    build: agentBuild.get(name)?.version ?? null,
    paired: paired.some((d) => d.name === name),
  }))
  const rotationHandles = v.groups.flatMap((g) => g.rows.map((r) => r.handle))

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
          <li>
            <strong>{v.summary.needsLogin}</strong>
            <span>need signing in</span>
          </li>
          <li className={v.summary.broken > 0 ? 'bad' : undefined}>
            <strong>{v.summary.broken}</strong>
            <span>need you now</span>
          </li>
          {/* The fourth part of the partition. Rendered only when it is non-empty, because a
              permanent "0 out of the rotation" is furniture — but when it is non-zero the
              tiles must sum to the total printed above, or the reader's arithmetic fails. */}
          {v.summary.outOfFleet > 0 && (
            <li>
              <strong>{v.summary.outOfFleet}</strong>
              <span>write to nobody</span>
            </li>
          )}
        </ul>

        {/*
          ── ONBOARDING A NEW SENDING MAC — AT THE TOP (2026-09-02) ────────────
          This lived at the BOTTOM, below seven account cards and two forms, and Tabish
          could not find the download button ("Where is the download button? How would an
          individual know to download the file and sign in?"). A new operator's first job is
          to get a Mac sending, so it goes first — and urgent when no Mac is online, because
          then nothing can send at all and this is the only thing to do.
        */}
        <section className="group">
          <h2>{devices.length === 0 ? 'Start here — set up a sending Mac' : 'Add another sending Mac'}</h2>
          {devices.length === 0 ? (
            <p>
              Sending runs on a Mac with the accounts signed in on it — never on this server, so{' '}
              <strong>no account can send until a Mac is set up</strong>. Three steps:{' '}
              <strong>1.</strong> download the installer below and open it on the Mac that will send —
              double-click the app; it is signed and notarised by Apple, so nothing is blocked.{' '}
              <strong>2.</strong> a browser tab opens on this dashboard: check the code and key match the
              Mac&rsquo;s dialog and click <strong>Approve this Mac</strong>. No database details or key files
              change hands — the Mac makes its own key and is handed what it needs, once.{' '}
              <strong>3.</strong> when its agent is running it shows up here; press <strong>Connect</strong> on
              each account — the Instagram sign-in opens on that Mac, and it sends from that person&rsquo;s home
              internet.
            </p>
          ) : (
            <p className="muted">
              Sending runs on a Mac with the accounts signed in on it — not here. To add another sender&rsquo;s
              Mac, give them the installer and a dashboard login — nothing else. They double-click it, a browser tab
              asks you (or them) to <strong>Approve this Mac</strong> here, and it pairs itself. Once its agent is
              running, press <strong>Connect</strong> on its accounts below — the sign-in opens on their Mac.
            </p>
          )}
          <a className="btn" href="/api/download/agent" download>
            Download the installer (.dmg)
          </a>{' '}
          <span className="muted">
            {installerBuild
              ? `Installer build ${installerBuild}${installerBuild === thisBuild ? ' — the same as this dashboard.' : ` — this dashboard is build ${thisBuild}.`}`
              : 'No installer build is recorded beside the image.'}
            {' '}Running the newer image on an already-paired Mac updates it in place.
          </span>{' '}
          <details className="muted" style={{ margin: '0.5rem 0' }}>
            <summary>If the app is blocked on their Mac</summary>
            <p>
              Only happens with an old unsigned copy of the image or a managed security policy. The identical
              installer runs from Terminal:
            </p>
            <code style={{ display: 'block', userSelect: 'all' }}>
              bash &quot;/Volumes/DS Sales Agent/DS Sales Agent.app/Contents/Resources/install.sh&quot;
            </code>
          </details>
          <span className="muted">
            {devices.length > 0 ? `Online now: ${devices.join(', ')}.` : 'No sending Mac is online yet.'}
          </span>
        </section>

        {/*
          ── A MAC WAITING TO BE APPROVED IS ON SCREEN NOW (2026-09-04) ──────
          A second operator ran the installer and NOTHING appeared anywhere. The request was
          real; it was simply invisible. `findByUserCode` was the only reader and it needs the
          exact code out of the URL the installer opened — and that URL was lost the moment
          they were bounced to sign-in. Fifteen minutes later the row expired and no screen
          had ever mentioned it. Approving needs no URL and no code now.
        */}
        {waiting.length > 0 && (
          <section className="group">
            <h2>Macs waiting to be approved</h2>
            <p>
              Someone has run the installer on {waiting.length === 1 ? 'this Mac' : 'these Macs'}. Check the
              fingerprint matches the one shown on that Mac, then approve it. Requests expire fifteen minutes
              after the installer starts.
            </p>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Mac</th>
                    <th>Tunnel key</th>
                    <th>Code</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {waiting.map((w) => (
                    <tr key={w.userCode}>
                      <td>{w.deviceName}</td>
                      <td>
                        <code>{w.fingerprint}</code>
                      </td>
                      <td>
                        <code>{w.userCode}</code>
                      </td>
                      <td>
                        <form action={approveDevice}>
                          <input type="hidden" name="code" value={w.userCode} />
                          <button className="btn" type="submit">
                            Approve this Mac
                          </button>
                        </form>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        <ActiveDeviceSection options={sendingMacOptions} selected={activeDevice} senderHandles={rotationHandles} />

        <section className="group">
          <h2>Paired Macs</h2>
          {sp.paired && (
            <p>
              <strong>{sp.paired}</strong> is approved. Its installer is finishing on its own; it appears under
              &ldquo;Online now&rdquo; above once the agent is running, usually within a few minutes.
            </p>
          )}
          {paired.length === 0 ? (
            <p className="muted">
              No Mac has paired itself yet. Pairing happens when someone double-clicks the installer and approves
              it in the browser tab it opens — no secrets change hands.
            </p>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Mac</th>
                    <th>Tunnel key</th>
                    <th>Now</th>
                    <th>Agent build</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {paired.map((d) => (
                    <tr key={d.name + d.fingerprint}>
                      <td>{d.name}</td>
                      <td>
                        <code>{d.fingerprint}</code>
                      </td>
                      <td>{devices.includes(d.name) ? 'online' : 'not beating'}</td>
                      <td>
                        {(() => {
                          const b = agentBuild.get(d.name)
                          if (!devices.includes(d.name)) return <span className="muted">—</span>
                          if (!b) return <span className="muted">unknown (agent predates the stamp)</span>
                          if (b.source === 'git') return <span className="muted">{b.version} (development checkout)</span>
                          if (installerBuild && b.version !== installerBuild)
                            return (
                              <span style={{ color: 'var(--warn, #b45309)' }}>
                                {b.version} — not the installer&rsquo;s {installerBuild}; re-run the installer on that Mac
                              </span>
                            )
                          return <code>{b.version}</code>
                        })()}
                      </td>
                      <td>
                        <form action={revokeDevice}>
                          <input type="hidden" name="name" value={d.name} />
                          <button className="btn btn-quiet" type="submit">
                            Revoke
                          </button>
                        </form>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

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

            <LoginQueue queue={q.queue} devices={devices} />
          </section>
        )}

        {v.groups.map((g) => (
          <AccountGroupView
            key={g.key}
            group={g}
            fleets={fleets.map((f) => ({ slug: f.slug, name: f.name }))}
            devices={devices}
            signedInOn={signedInOn}
          />
        ))}

        {/*
          ADDING AN ACCOUNT HAD NO UI AT ALL until 2026-08-17. `addSender` existed in
          actions.ts — validated, audited, creating routes — and nothing in `src/app`
          imported it, so the only way in was writing to the database by hand. `/targets`
          had its form the whole time, which is why the pair looked symmetrical.

          Last on the page deliberately: the question this page answers is "can my accounts
          send", and adding one is the rarer act.
        */}
        <AddSenderForm fleets={fleets.map((f) => ({ slug: f.slug, name: f.name }))} />

        {/*
          Removal, with the queue handed off by rotation — see remove-form.tsx. Only
          accounts still IN the rotation are offered: removing one that is already out
          is a no-op wearing a control's clothes.
        */}
        <RemoveSenderForm
          /**
            EVERY account, not only fleet members (2026-08-26). The filter was
            `r.fleetMember`, so an account already out of the rotation could not be removed
            at all — Tabish hit exactly that on @madaboutmarketingg and had to put it BACK
            in the rotation first in order to take it out. Removal is about the account, not
            about whether it is currently rotating.
          */
          handles={v.groups.flatMap((g) => g.rows.map((r) => r.handle))}
        />

        {team && <TeamPanel users={team} />}
      </div>
    </>
  )
}
