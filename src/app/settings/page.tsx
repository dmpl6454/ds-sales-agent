import { prisma } from '@/lib/db'
import { env } from '@/lib/env'
import { getSettings } from '@/lib/settings'
import { updateSettings } from '../actions'
import { PairControls } from './pair-controls'

export const dynamic = 'force-dynamic'

export default async function Settings() {
  const settings = await getSettings()
  const pairs = await prisma.outreachPair.findMany({
    include: { sender: true, target: true },
    orderBy: [{ target: { handle: 'asc' } }, { sender: { handle: 'asc' } }],
  })

  // Volume projection, so the cooldown choice is made with its consequence visible.
  const perDay = pairs.filter((p) => p.enabled).reduce((n, p) => n + 1 / Math.max(1, p.cooldownDays), 0)
  const cappedPerDay = Math.min(perDay, settings.maxPerTargetPerDay * new Set(pairs.map((p) => p.targetId)).size)

  return (
    <>
      <h1>Settings</h1>
      <p className="sub">Runtime knobs. Stored in the database, so changes take effect without a redeploy.</p>

      <div className="banner info">
        <b>Projected volume at the current settings:</b> ≈{cappedPerDay.toFixed(1)} DMs/day (
        {Math.round(cappedPerDay * 30)}/month), peaking at{' '}
        {settings.maxPerTargetPerDay * new Set(pairs.map((p) => p.targetId)).size}/day. Detection finds far more
        campaigns than this — the cooldown is what converts ~12–18 daily opportunities into a rate two inboxes can
        tolerate.
      </div>

      <h2>Cadence</h2>
      <div className="card">
        <form action={updateSettings}>
          <div className="grid c3">
            <label className="field">
              <span>Default cooldown (days per pair)</span>
              <input
                type="number"
                name="defaultCooldownDays"
                min={0}
                max={365}
                defaultValue={settings.defaultCooldownDays}
              />
            </label>
            <label className="field">
              <span>Max DMs per target per day</span>
              <input
                type="number"
                name="maxPerTargetPerDay"
                min={1}
                max={10}
                defaultValue={settings.maxPerTargetPerDay}
              />
            </label>
            <label className="field">
              <span>Hook freshness window (hours)</span>
              <input type="number" name="hookMaxAgeHours" min={1} max={720} defaultValue={settings.hookMaxAgeHours} />
            </label>
          </div>

          <label className="btnrow" style={{ marginBottom: 14 }}>
            <input
              type="checkbox"
              name="autopilotEnabled"
              defaultChecked={settings.autopilotEnabled}
              disabled={!env.AUTOPILOT_ENABLED}
              style={{ width: 'auto' }}
            />
            <span className="muted">
              Autopilot globally enabled
              {!env.AUTOPILOT_ENABLED ? (
                <>
                  {' '}
                  — locked off because <code>AUTOPILOT_ENABLED=false</code> in <code>.env</code>. The environment is a
                  hard floor the database cannot override.
                </>
              ) : null}
            </span>
          </label>

          <button className="primary" type="submit">
            Save settings
          </button>
        </form>
      </div>

      <h2>Per-pair cadence</h2>
      <div className="card pad0 scroll">
        <table>
          <thead>
            <tr>
              <th>From</th>
              <th>To</th>
              <th>Cooldown</th>
              <th>Enabled</th>
            </tr>
          </thead>
          <tbody>
            {pairs.map((p) => (
              <tr key={p.id}>
                <td className="nowrap">@{p.sender.handle}</td>
                <td className="nowrap">@{p.target.handle}</td>
                <td>
                  <PairControls pairId={p.id} cooldownDays={p.cooldownDays} enabled={p.enabled} />
                </td>
                <td>{p.enabled ? <span className="pill good">on</span> : <span className="pill">off</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2>Environment (read-only)</h2>
      <div className="card pad0 scroll">
        <table>
          <tbody>
            <tr>
              <td className="muted nowrap">DRY_RUN</td>
              <td>
                {env.DRY_RUN ? (
                  <span className="pill warn">on — nothing sends</span>
                ) : (
                  <span className="pill bad">off — messages will be delivered</span>
                )}
              </td>
            </tr>
            <tr>
              <td className="muted nowrap">Slots</td>
              <td className="mono">
                {env.SLOTS.join(' / ')} {env.TZ}
              </td>
            </tr>
            <tr>
              <td className="muted nowrap">Catch-up window</td>
              <td className="mono">{env.CATCHUP_WINDOW_MINUTES} min</td>
            </tr>
            <tr>
              <td className="muted nowrap">Send jitter</td>
              <td className="mono">
                {env.SEND_JITTER_MIN_SECONDS}–{env.SEND_JITTER_MAX_SECONDS}s between DMs
              </td>
            </tr>
            <tr>
              <td className="muted nowrap">Operator</td>
              <td className="mono">{env.OPERATOR_NAME}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p className="dim" style={{ fontSize: 12 }}>
        These live in <code>.env</code> and require a worker restart to change.
      </p>
    </>
  )
}
