import { prisma } from '@/lib/db'
import { env } from '@/lib/env'
import { log } from '@/lib/logger'
import { dispatchTick, withSendLock } from '@/outreach/dispatcher'
import { deviceId } from './claim'
import { profileStatus } from '@/outreach/browser/profile'
import { reconcileSessionRecords } from './reconcile'
import { autoResolveBrands } from '@/detection/autoResolve'
import { checkForReplies } from '@/outreach/replyCheck'
import { withinActiveHours } from '@/outreach/pacing'
import { istHourOfDay } from '@/lib/time'

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

/**
 * How often the device asks whether there is anything to send.
 *
 * 30 SECONDS SINCE 2026-08-19, because the fleet gap became ONE minute the same day and
 * the poll interval is the real ceiling: one send per tick means a 60-second poll delivers
 * at best every 60s, and on average waits half a poll past the moment the gap clears. At
 * 30s the gap is what paces the fleet rather than this timer, which is where the decision
 * belongs — `pacing.ts` is the file with the rules and the tests in it.
 *
 * It does NOT widen anything: `dispatchTick` still sends at most one message and still
 * asks every guard. A tick with nothing to do is a handful of cheap queries.
 */
const POLL_INTERVAL_MS = 30_000

/** Written this often so the dashboard can say how long a device has been away. */
const PRESENCE_INTERVAL_MS = 30_000

/**
 * ── BRAND DISCOVERY RUNS HERE NOW, BECAUSE HERE IS THE HOME IP ─────────────
 *
 * MEASURED 2026-08-12 and unchanged since: Instagram 429s the Linode on the profile
 * endpoint while answering the same handles from this Mac seconds later. So
 * `autoResolveBrands` at the end of every server detect pass halts on its first lookup,
 * forever, and the only thing that ever created a prospect was a person typing
 * `pnpm ig:brands --run` here.
 *
 * That is the shape this codebase has been bitten by repeatedly — *a feature that works
 * only when someone runs a command is not running* (166 cover frames saved and never
 * read). Tabish, 2026-08-18: *"this should run automatically, nothing should be manually
 * run."* So the device agent runs the pass on its own clock.
 *
 * It is the SAME function the server calls, not a copy: one bound, one ordering, one
 * cache, one set of safety rules. It spends no browser and drives nothing — HTTP lookups
 * against a public endpoint — so it runs on its own timer rather than inside the send
 * tick, where six-second spacing would delay delivery by minutes.
 */
const BRAND_INTERVAL_MS = 30 * 60_000

/**
 * Lookups per pass. Higher than the server's 10 because this host is not throttled and
 * the pass is half-hourly rather than every fifteen minutes — but still BOUNDED, because
 * the endpoint is undocumented, politeness is a 6s gap between lookups, and an unbounded
 * pass here would be a burst against the one IP every account also logs in from.
 */
const BRAND_LOOKUPS_PER_PASS = 25

/**
 * ── THE REPLY SWEEP RUNS HERE NOW, BECAUSE HERE IS WHERE THE SESSIONS ARE ──
 *
 * MEASURED 2026-08-18 and again 2026-08-19: `replyCheckedAt` was non-null on ZERO
 * attempts, ever. The 11:00/20:00 sweep is scheduled inside `runSlot` on the LINODE,
 * which has no `~/.ds-sales-agent` at all — so it fired twice a day, found every
 * account signed out, and skipped every conversation. The same hosted-split shape as
 * brand discovery above, fixed the same way: the SAME function the server calls
 * (`checkForReplies` — one implementation, its caps and checkpoint handling intact),
 * on the machine whose disk actually holds the profiles. Tabish, 2026-08-19: "Make
 * sure replies are being detected."
 *
 * Three properties keep it from costing sends:
 *
 *   1. It holds the fleet-wide SEND LOCK while it reads. Reading drives the same
 *      Chrome profiles the send path drives, and two contexts on one profile is how
 *      cookies get corrupted. A dispatch tick that lands mid-sweep returns
 *      `lockBusy` and loses nothing — the next tick is sixty seconds away.
 *   2. It is bounded (MAX_REPLY_CHECKS_PER_RUN conversations per pass) and half-hourly,
 *      so the worst case is a few minutes of read time per half hour.
 *   3. It runs inside active hours only. Reading is lower-risk than sending, but a
 *      browser touring conversations at 03:00 from an Indian business page is a
 *      behavioural signal for no benefit — the old slot times were daytime too.
 */
const REPLY_INTERVAL_MS = 30 * 60_000

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

/**
 * One brand pass at a time on this machine.
 *
 * A pass can outlive its interval — 25 lookups at 6s spacing is up to 2.5 minutes, and a
 * slow endpoint makes it longer — so without this a stalled pass would have a second one
 * started on top of it, both spending the same lookup budget against the same throttled
 * endpoint. In-process is the right scope: the bound this protects is per host.
 */
let brandPassRunning = false

async function brandPass(): Promise<void> {
  if (brandPassRunning) {
    log.step('brand discovery is still running from the last pass — skipping this one')
    return
  }
  brandPassRunning = true
  try {
    const summary = await autoResolveBrands({ maxLookups: BRAND_LOOKUPS_PER_PASS })
    /**
     * Logged EVERY pass, including the empty one. "Nothing was discovered" and "the pass
     * never ran" are different facts and this is the only place that can tell them apart —
     * the same reason the dispatcher reports what it held rather than going quiet.
     */
    log.info('brand discovery pass', {
      looked: summary.looked,
      created: summary.decided,
      unsure: summary.skippedUnsure,
      unreached: summary.unreached,
      haltedEarly: summary.haltedEarly,
      awaitingRetry: summary.awaitingRetry,
    })
  } catch (err) {
    /**
     * Never allowed to take the agent down, exactly like the detect-pass rule: discovering
     * prospects is upstream of sending, and a failure here must not stop messages that are
     * already written from going out.
     */
    log.error('brand discovery pass failed', { error: err instanceof Error ? err.message : String(err) })
  } finally {
    brandPassRunning = false
  }
}

/** One reply sweep at a time on this machine — same reasoning as `brandPassRunning`. */
let replyPassRunning = false

async function replyPass(): Promise<void> {
  if (replyPassRunning) {
    log.step('the reply sweep is still running from the last pass — skipping this one')
    return
  }
  if (!withinActiveHours(istHourOfDay(new Date()))) return
  replyPassRunning = true
  try {
    const summary = await withSendLock('reply-sweep', () => checkForReplies())
    if (summary === null) {
      // A send holds the lock. Nothing is lost: the next pass is half an hour away and
      // the just-in-time check still reads any thread a follow-up is about to land in.
      log.step('a send is in progress — the reply sweep waits for the next pass')
      return
    }
    /**
     * Logged every pass, including the empty one — "nothing new" and "the sweep never
     * ran" are different facts, and for reply detection that difference was invisible
     * for eleven days.
     */
    log.info('reply sweep', {
      checked: summary.checked,
      repliesFound: summary.repliesFound,
      unreadable: summary.unreadable,
      incomplete: summary.incomplete,
      deferred: summary.deferred,
    })
  } catch (err) {
    // Never allowed to take the agent down: reply reading is a guard, and a guard
    // failing must not stop the deliveries it guards.
    log.error('reply sweep failed', { error: err instanceof Error ? err.message : String(err) })
  } finally {
    replyPassRunning = false
  }
}

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

  /**
   * Brand discovery, on its own clock and NOT gated on autopilot: finding out which
   * companies bought a placement is reading public data, not writing to anyone. The
   * queue can only grow when a prospect exists, so gating discovery on the send switch
   * would mean turning autopilot on to a queue that had stopped being filled hours ago.
   *
   * Fired once at startup as well as on the interval, so a restart does not mean waiting
   * half an hour for the first pass.
   */
  void brandPass()
  const brands = setInterval(() => void brandPass(), BRAND_INTERVAL_MS)
  brands.unref?.()

  /**
   * The reply sweep, on its own clock like brand discovery, and NOT gated on autopilot:
   * a reply to a hand-sent message halts outreach exactly the same way, and the halt is
   * only as good as the last time anything looked. Fired once at startup so a restart
   * does not mean half an hour of unwatched conversations.
   */
  void replyPass()
  const replies = setInterval(() => void replyPass(), REPLY_INTERVAL_MS)
  replies.unref?.()

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
  clearInterval(brands)
  clearInterval(replies)
}

export function stopDeviceAgent(): void {
  stopping = true
}
