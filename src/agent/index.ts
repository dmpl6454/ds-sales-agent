import { prisma } from '@/lib/db'
import { env } from '@/lib/env'
import { log } from '@/lib/logger'
import { dispatchTick } from '@/outreach/dispatcher'
import { deviceId } from './claim'
import { profileStatus } from '@/outreach/browser/profile'
import { reconcileSessionRecords } from './reconcile'

/**
 *   pnpm agent:device
 *
 * THE PROCESS THAT RUNS ON A USER'S OWN MACHINE AND DOES THE SENDING.
 *
 * ── IT IS A LOOP AROUND `dispatchTick`, NOT A SECOND SEND PATH ──────────────
 *
 * The obvious shape — poll for work, claim it, drive a browser, write back — would be a
 * FIFTH implementation of "may this message be sent now", after `deliverWaiting`,
 * `sendNow`, the planner and the on-demand dialog. This codebase has watched that exact
 * drift four times (`gate.ts` where deliverWaiting checked eight conditions and sendNow
 * three; `readThread.ts`; the two Connect buttons; the frame check that 166 saved frames
 * proved was never running). A fifth copy on the machine that actually talks to Instagram
 * would be the worst place yet for it.
 *
 * So the agent adds NO send logic. `dispatchTick` already: asks whether the fleet may send
 * at all (circuit breaker, autopilot, active hours, the gap), decides whose turn it is,
 * reads the conversation before a follow-up, claims atomically, holds the fleet-wide send
 * lock, and re-runs `gate.ts` at delivery. Every one of those guards applies here for
 * free, and a change to any of them reaches the device without anyone remembering to
 * copy it.
 *
 * What the agent contributes is exactly two things the server cannot do:
 *
 *   1. It runs where the Chrome profiles are.
 *   2. It says so, so the dashboard can tell a user their device is offline rather than
 *      leaving "nothing has sent" unexplained — the failure this project keeps finding.
 *
 * ── WHY THE SERVER CANNOT DO THIS ───────────────────────────────────────────
 *
 * A send drives a Chrome profile logged in BY HAND from a home IP. That login wrote
 * durable device identifiers (`mid`, `ig_did`, `ig-u-rur`) and a login event binding the
 * browser to the account from that network. Copying the profile to a datacenter is a
 * session transplant in all but name: `sessionid` is a bearer token with no channel
 * binding, so it WORKS — right up until enforcement lands silently. Research established
 * device + network continuity as a pass/fail gate, not a score.
 *
 * `SEND_ENABLED=false` on the server is the hard floor that makes this structural rather
 * than a convention, and it is checked here before anything else.
 *
 * ── A POWERED-OFF DEVICE CANNOT SEND, AND NOTHING PRETENDS OTHERWISE ────────
 *
 * Closing the dashboard tab is fine; the tab was never the sender. A machine that is off
 * has no browser and no session, and the only ways around that are the transplant above.
 * So drafts WAIT — they stay READY, the dashboard shows when this device was last seen,
 * and they go out when it comes back, under the ordinary pacing rules. Nothing is lost,
 * nothing is dropped, and nothing is rushed on return: a device reconnecting after a day
 * must not empty its queue into one inbox, which is the recipient-side pattern the whole
 * dispatcher design exists to avoid. `dispatchTick` enforces that for us.
 */

/** How often the device asks whether there is anything to send. */
const POLL_INTERVAL_MS = 60_000

/** Written this often so the dashboard can say how long a device has been away. */
const PRESENCE_INTERVAL_MS = 30_000

/** `Setting` key holding the last time each device checked in. */
export const DEVICE_PRESENCE_KEY = 'devicePresence'

export interface DevicePresence {
  device: string
  at: string
  /** Which accounts this device holds a logged-in Chrome profile for. */
  handles: string[]
}

/**
 * Which sending accounts THIS machine can actually drive.
 *
 * Asked of the disk, not of the database. `SenderAccount.status` is what the server
 * believes; a profile directory with a session in it is what this machine can prove. When
 * they disagree the disk wins here, because the disk is what the browser will find.
 */
export async function localSenderHandles(): Promise<string[]> {
  const senders = await prisma.senderAccount.findMany({ select: { handle: true } })
  return senders.filter((s) => profileStatus(s.handle).hasSession).map((s) => s.handle)
}

/**
 * Record that this device is here, and which accounts it can send from.
 *
 * Merged into one Setting row keyed by device name, so several people's machines can be
 * present at once without a schema change. A device that stops writing simply goes stale,
 * exactly like the scheduler heartbeat — and staleness is reported rather than inferred,
 * because "no message has gone out" with no reason is the failure this project keeps
 * rediscovering.
 */
export async function writePresence(handles: string[]): Promise<void> {
  const me: DevicePresence = { device: deviceId(), at: new Date().toISOString(), handles }
  const row = await prisma.setting.findUnique({ where: { key: DEVICE_PRESENCE_KEY } })

  let all: DevicePresence[] = []
  if (row) {
    try {
      const parsed = JSON.parse(row.value)
      if (Array.isArray(parsed)) all = parsed as DevicePresence[]
    } catch {
      // A corrupt row is replaced rather than allowed to stop this device reporting in.
      all = []
    }
  }

  const next = [...all.filter((d) => d.device !== me.device), me]
  const value = JSON.stringify(next)
  await prisma.setting
    .upsert({ where: { key: DEVICE_PRESENCE_KEY }, update: { value }, create: { key: DEVICE_PRESENCE_KEY, value } })
    .catch(() => undefined) // presence must never take the agent down
}

/** Every device the dashboard knows about, freshest first. */
export async function readPresence(): Promise<DevicePresence[]> {
  const row = await prisma.setting.findUnique({ where: { key: DEVICE_PRESENCE_KEY } })
  if (!row) return []
  try {
    const parsed = JSON.parse(row.value)
    if (!Array.isArray(parsed)) return []
    return (parsed as DevicePresence[]).sort((a, b) => b.at.localeCompare(a.at))
  } catch {
    return []
  }
}

let stopping = false

async function tick(): Promise<void> {
  const handles = await localSenderHandles()
  await writePresence(handles)

  /**
   * A hand login the Connect poll missed is recorded here, by the machine that can prove
   * it — otherwise /senders says "signed in" (filesystem) while rotation says "never
   * signed in" (database) and no draft is ever written for the account. Measured, not
   * hypothetical: @madaboutmarketingg, 2026-08-17. See src/agent/reconcile.ts.
   */
  await reconcileSessionRecords(handles)

  if (handles.length === 0) {
    // Not an error, and said plainly: a machine with no signed-in profile has nothing to
    // do, and the dashboard will show it as present-but-empty rather than silently idle.
    log.step('no signed-in Instagram profiles on this device — nothing to send from')
    return
  }

  /**
   * `dispatchTick` decides everything else, including whether now is a permitted time and
   * whether any of it is this device's business. It sends AT MOST ONE message, which is
   * the fleet's pacing rule and not something the agent may relax.
   */
  await dispatchTick('device')
}

export async function runDeviceAgent(): Promise<void> {
  /**
   * THE HARD FLOOR, CHECKED FIRST. A server must never reach the browser code — not
   * because it would work badly, but because the profiles that make it work cannot
   * legitimately be there. Environment only, exactly like `AUTOPILOT_ENABLED`, so a
   * dashboard cannot switch it on.
   */
  if (!env.SEND_ENABLED) {
    log.alarm('SEND_ENABLED=false — this machine is not allowed to send, and the agent will not start')
    log.info('that is correct on the server: Instagram sessions live on a person\'s own machine, never here')
    return
  }

  const handles = await localSenderHandles()
  log.info('device agent starting', {
    device: deviceId(),
    accounts: handles.length > 0 ? handles.join(', ') : '(none signed in yet)',
    pollSeconds: POLL_INTERVAL_MS / 1000,
  })

  const presence = setInterval(() => {
    void localSenderHandles().then(writePresence).catch(() => undefined)
  }, PRESENCE_INTERVAL_MS)
  presence.unref?.()

  while (!stopping) {
    try {
      await tick()
    } catch (err) {
      // One bad tick must never end the loop: the device going quiet is the failure this
      // whole process exists to prevent.
      log.error('device tick failed', { error: err instanceof Error ? err.message : String(err) })
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
  }

  clearInterval(presence)
}

export function stopDeviceAgent(): void {
  stopping = true
}
