/**
 * ── IS THE SENDING MAC'S LOOP ACTUALLY COMPLETING? (audit H11, 2026-10-09) ─────────────
 *
 * The device agent writes its presence at the TOP of every tick and again from its own
 * 30-second interval, before anything that can throw. So a Mac whose every tick throws — the
 * database half-reachable through a flapping tunnel, a bad deploy of the agent, a module that
 * fails to load on one path — reads as "online" on /senders and the landing page says
 * "<Mac> sends by itself", while nothing has been evaluated for hours. `dispatchState` is
 * simply not rewritten, and nothing renders its age; the only record was a log line on that
 * Mac's own disk. A tick that HANGS rather than throws looks the same from outside: the
 * presence interval keeps beating while the loop never comes round again.
 *
 * Detection and planning already had this split (`PASS_OK_KEYS` in worker/scheduler.ts, the
 * 22 Aug Postgres-exhaustion outage); the one process that SENDS did not. This is the same
 * shape: the agent stamps the end of every tick that completed on the selected Mac, and the
 * health ladder alarms on a FRESH beat beside a STALE stamp.
 *
 * WHAT THE STAMP MEANS, PRECISELY: the selected Mac's tick ran to its end. Not "a message went
 * out" — an all-held tick, an autopilot-off tick and a busy-lock tick all complete, and none of
 * them is a fault. A selected Mac with no signed-in profile completes too: that is a different
 * problem with its own sentence on /senders, and "its sending loop keeps failing" would send
 * someone looking for a crash that is not there.
 *
 * A STANDBY MAC NEVER STAMPS, and the stamp NAMES its Mac, so the stamp a previous selection
 * left behind never vouches for — or alarms about — the Mac selected now.
 *
 * ABSENCE NEVER ALARMS, exactly like the pass stamps: a fleet whose agents predate this, or a
 * newly selected Mac that has not finished its first tick, reads as "not yet measured".
 * Stated rather than hidden: that means a Mac that throws from its very first tick after
 * being selected is not caught by this rung — the dispatcher's own state row and the agent log
 * remain the witness for that one case.
 */
import { prisma } from '@/lib/db'

export const DISPATCH_OK_KEY = 'dispatchLastOkAt'

/**
 * Fifteen minutes is thirty 30-second ticks. A tick that drives a browser takes about a
 * minute, and one carrying a follow-up's pre-send read can take up to the read's 6-minute
 * deadline plus the send, so ten minutes would alarm on a single slow-but-healthy tick.
 * Thirty missed ticks is not a blip.
 */
export const DISPATCH_STALE_MS = 15 * 60 * 1000

export interface DispatchStamp {
  device: string
  at: Date
}

/** Parse the stored row. Anything unreadable is "not measured", never "stale". */
export function parseDispatchStamp(value: string | null | undefined): DispatchStamp | null {
  if (!value) return null
  try {
    const parsed = JSON.parse(value) as { device?: unknown; at?: unknown }
    if (typeof parsed.device !== 'string' || typeof parsed.at !== 'string') return null
    const at = new Date(parsed.at)
    return Number.isNaN(at.getTime()) ? null : { device: parsed.device, at }
  } catch {
    return null
  }
}

/**
 * PURE. Is the selected Mac beating while its loop has stopped completing?
 *
 * Every branch that cannot say so returns `stale: false`: no Mac selected, the selected Mac
 * not beating (that is the "not online" sentence, a different rung), no stamp, or a stamp
 * naming a different Mac.
 */
export function assessDispatch(args: {
  selected: string | null
  selectedBeating: boolean
  stamp: DispatchStamp | null
  /**
   * When the current selection was written (`activeDevice`'s `updatedAt`). A stamp older than
   * that predates this selection and says nothing about it: select A, then another Mac for a
   * while, then A again, and A's old stamp would otherwise read as "A's loop keeps failing"
   * until A's first tick — found by review. Null means unknown and ignores nothing.
   */
  selectedSince?: Date | null
  now?: number
}): { stale: boolean; lastOkAt: Date | null } {
  const now = args.now ?? Date.now()
  if (args.selected === null || !args.selectedBeating) return { stale: false, lastOkAt: null }
  if (args.stamp === null || args.stamp.device !== args.selected) return { stale: false, lastOkAt: null }
  if (args.selectedSince && args.stamp.at.getTime() < args.selectedSince.getTime()) return { stale: false, lastOkAt: null }
  return { stale: now - args.stamp.at.getTime() > DISPATCH_STALE_MS, lastOkAt: args.stamp.at }
}

/**
 * At most one write a minute. A tick ends every 30 s, every 5 s while the fleet lock is busy and
 * every SECOND while an agent older than the lock's device field holds it — a write per tick
 * would be a database write a second over the tunnel to record a fact a 15-minute threshold
 * reads. A minute of staleness costs the alarm nothing.
 */
export const DISPATCH_STAMP_EVERY_MS = 60_000
let lastWrite: { device: string; at: number } | null = null

/** Written by the device agent at the end of a completed tick. Never fails the tick. */
export async function recordDispatchOk(device: string, now: number = Date.now()): Promise<void> {
  if (lastWrite !== null && lastWrite.device === device && now - lastWrite.at < DISPATCH_STAMP_EVERY_MS) return
  const value = JSON.stringify({ device, at: new Date(now).toISOString() })
  await prisma.setting
    .upsert({ where: { key: DISPATCH_OK_KEY }, update: { value }, create: { key: DISPATCH_OK_KEY, value } })
    .then(() => {
      lastWrite = { device, at: now }
    })
    .catch(() => undefined)
}
