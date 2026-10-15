import { prisma } from '@/lib/db'
import { env } from '@/lib/env'
import { describeError, log } from '@/lib/logger'
import { writeRecord } from '@/lib/json'
import { istStamp } from '@/lib/time'
import { runDetection } from '@/detection/pipeline'
import { DETECT_CATCHUP_LOOKBACK_HOURS } from '@/detection/cadence'
import { runOutreach } from '@/outreach/plan'
import { dispatchTick, holderIsSameMachine } from '@/outreach/dispatcher'
import { deviceId } from '@/outreach/devicePresence'
import { hostId } from '@/lib/hostId'
import { checkForReplies, isReplyCheckSlot } from '@/outreach/replyCheck'
import { HEARTBEAT_STALE_MS, readSchedulerHeartbeat, type SchedulerHeartbeat } from './heartbeat'

/**
 * One complete slot:
 *
 *   1. READ    both channels  → detect paid campaigns (anonymous, no login)
 *   2. DECIDE  safety gate    → is any pair permitted a message
 *   3. PREPARE draft          → queue it for a human to send
 *
 * Detection cannot abort step 2. If the feed endpoint breaks, a permitted message
 * is still prepared, just without a specific hook. A monitoring subsystem must
 * never be able to silence the thing it monitors — the run is marked PARTIAL so it
 * surfaces, and the rest keeps working.
 *
 * There is no automated reply-detection stage: reading the inbox requires a
 * logged-in session, which is exactly the exposure detection is built to avoid.
 *
 * A reply IS load-bearing, though — the governor halts every sender to a target
 * that has answered, so an unrecorded reply means the agent keeps preparing cold
 * follow-ups to a live conversation. So it is marked by hand on the dashboard, and
 * that is currently the weakest link in the loop.
 */

export interface SlotResult {
  runId: string
  status: 'OK' | 'PARTIAL' | 'FAILED'
  postsSeen: number
  newPosts: number
  detected: number
  queued: number
  sent: number
}

/**
 * Setting key holding `{"pid":123,"slot":"11:00","at":"...","device":"linode-detect","host":"…",
 * "beatAt":"…"}` while a slot or a planning run holds the lock. `device`, `host` and `beatAt`
 * since 2026-10-15 — see `SlotLockHolder`; a row written by an older build carries none of them.
 */
const SLOT_LOCK_KEY = 'slotRunning'
/**
 * How long a slot may make NO PROGRESS before it is worth shouting about.
 *
 * `at` is refreshed at every stage boundary (`touchSlotLock`), so this measures time
 * since the last sign of life, not time since the slot began. It used to measure the
 * latter, and the comment here read "a slot that has not finished in this long is
 * presumed dead, not running" — which was false in the one case that mattered.
 *
 * MEASURED: healthy slots take 24-81 s; `feed.ts` had no request timeout, and PARTIAL
 * runs of 3957 s, 7574 s, 12782 s, 19230 s and 24674 s (6.85 hours) are in `ScrapeRun`.
 * Those slots were HUNG BUT ALIVE. Age alone therefore said "dead, take over" about a
 * process that was still running — "freshness is not liveness" again, the lesson already
 * learned once for the scheduler heartbeat and present here in a different guard.
 */
const SLOT_LOCK_STALE_MS = 30 * 60_000

/**
 * How often a holder's own process proves it is alive by rewriting `beatAt` (`beatSlotLock`,
 * from a timer that runs whatever the current stage is doing), and how old that proof may be
 * before it is no proof. Derived, the way `PRESENCE_FRESH_MS` is: three missed beats is dead.
 */
const SLOT_LOCK_BEAT_MS = 60_000
export const SLOT_LOCK_BEAT_STALE_MS = 3 * SLOT_LOCK_BEAT_MS

export interface SlotLockHolder {
  pid: number
  slot: string
  /** When the holder last ENDED A STAGE (`touchSlotLock`). Moves only at stage boundaries. */
  at: string
  /**
   * When the holder's PROCESS last proved it was alive (2026-10-15, reviewer major 3 on the first
   * version of this build). Rewritten every `SLOT_LOCK_BEAT_MS` by a timer in the holder's own
   * process, independent of its stages, so a reader on another machine can tell a SLOW holder
   * (stale `at`, fresh `beatAt`) from a DEAD one (both stale) — `at` alone cannot, because
   * nothing moves it inside a stage. Absent on rows from builds older than the field; such a row
   * is vouched for by nothing of its own and is judged on `at`, the ≤30-minute bound.
   */
  beatAt?: string
  /**
   * WHICH MACHINE'S NAME wrote the row (`deviceId()`, 2026-10-15). Absent on rows written by
   * a build older than this field, which `acquireSlotLock` treats as ANOTHER machine — see
   * `decideSlotLock` for why that is the opposite of the send lock's reading of its own
   * host-less legacy row.
   */
  device?: string
  /**
   * WHICH MACHINE wrote it (`hostId()`). A device NAME is typed by a person and two Macs can
   * share one (rule 51: a name is not an identity); the host is what tells them apart. Absent
   * on rows from older builds and when the id could not be read — then the name alone decides.
   */
  host?: string
}

export type LockVerdict =
  /** Somebody else is running it. Do not start. */
  | { action: 'decline'; stalled: boolean }
  /** The holder's process is gone, or it is us, or a foreign holder has gone silent. Safe to claim. */
  | { action: 'take-over' }

/**
 * PURE. Given what the lock row says, where it was written and whether that process still
 * exists, may we run?
 *
 * Extracted so both directions are testable without a database or a second process —
 * the same reason `decideRoute`, `evaluatePair` and `recheckBeforeSend` are pure. The
 * previous version of this decision lived inline and had never been exercised in the
 * case that mattered.
 *
 * `ageMs` is time since the holder last reported PROGRESS, not since it started, because
 * `touchSlotLock` refreshes the timestamp at every stage boundary.
 *
 * ── A PID IS A FACT ABOUT ONE MACHINE, AND THIS LOCK IS SHARED BETWEEN MACHINES (2026-10-15) ──
 *
 * The row lives in the one Postgres every host shares. The Linode worker holds it for the
 * four slots and the 15-minute planner; the Mac's `:3100` dashboard's "Sync now" runs
 * `runSlot('manual')` in the MAC's own process. Until this date that process asked ITS OWN
 * kernel about the Linode's pid, was told "no such process" (ESRCH), and read a crash — so it
 * took the lock over a live planner and planned beside it. Two planners both read
 * `hasPendingAttempt: false` for one pair and both write a draft: two DMs to one prospect,
 * the worst spam signal available. The send lock fixed the identical mistake on 2026-09-10
 * (`decideSendLock`); this is the same fix for the same reason, one lock along.
 *
 * So `holderAlive` is EVIDENCE ONLY WHEN THE HOLDER IS LOCAL. A foreign holder is judged by
 * two things it leaves in the shared store — and the second was missing from the first version
 * of this build, which stepped over a stale foreign holder on AGE ALONE (reviewer major F1):
 *
 *   1. its PROGRESS STAMP, `at`. `touchSlotLock` rewrites it at every stage boundary; a planning
 *      run under `withSlotLock` has no boundaries. Fresh means a stage ended recently; stale
 *      (`SLOT_LOCK_STALE_MS`, 30 min) means no stage has ended in half an hour — which cannot
 *      tell a DEAD holder from a SLOW one. Nothing moves it inside a stage, one detection stage
 *      ran 36 minutes (8 Sept, judging a four-day backlog after an outage), and `ScrapeRun`
 *      holds hung-but-ALIVE slots of 3957–24674 s.
 *   2. its PROCESS WITNESS, `holderProcessFresh`: a proof, younger than three minutes, that the
 *      holder's PROCESS is alive. Two things count, and the caller asks them in this order:
 *        - the row's OWN BEAT, `beatAt` (`beatSlotLock`). A timer in the holder's own process
 *          rewrites it every 60 s whatever its current stage is doing, so it keeps moving while
 *          a stage is wedged awaiting I/O and stops within a minute of the process dying. EVERY
 *          holder writes one — the Linode worker's slots and its planner, a Mac dashboard's
 *          "Sync now", a `pnpm run:slot` — which is the point: the first version of this build
 *          had only the scheduler heartbeat below, which only the worker writes, so a Mac's
 *          "Sync now" wedged for 30 minutes was stepped over ALIVE (reviewer major 3). The
 *          send lock's machine witness (`deviceIsBeating`) was the obvious alternative and is
 *          deliberately NOT used here: it proves the MACHINE, and on a Mac the slot's holder is
 *          not the process that beats — a "Sync now" killed mid-slot (a dashboard restart) on a
 *          Mac whose agent keeps beating would be vouched for indefinitely, and nothing on a
 *          Mac reclaims a dead slot row (the agent never takes this lock, unlike the send
 *          lock's, which the same Mac's agent recovers within a tick). The holder's own beat
 *          proves the process and expires with it.
 *        - the SCHEDULER HEARTBEAT (`Setting.schedulerHeartbeat`, `./heartbeat`), written every
 *          60 s by the Linode worker process that holds this lock for the four slots and the
 *          15-minute planner. Redundant for every row this build writes — the same process
 *          writes both — and kept as a second witness precisely because its timer is not this
 *          module's: a defect in the beat here leaves the worker's rows vouched for by a
 *          witness it does not own. Consulted only when the own beat does not vouch AND the
 *          stamp is stale, the one cell of the table that steps over; a beat naming the row's
 *          machine AND pid, younger than `HEARTBEAT_STALE_MS`, vouches.
 *
 * The foreign verdict over both inputs:
 *
 *     vouched   × fresh  → decline, not stalled   the ordinary "Sync now" during a Linode pass
 *     vouched   × stale  → decline, STALLED       a slow LIVE holder: an alarm, not a silence
 *     unvouched × fresh  → decline, not stalled   the stamp is honoured on its own
 *     unvouched × stale  → take-over              THE TRADE below: nothing vouches for it
 *
 * THE TRADE, STATED — and it applies ONLY to a foreign holder that NOTHING vouches for. The
 * send lock never steps over a live holder, because a hung sender still owns the OS clipboard
 * and taking its lock puts message A into thread B. The slot lock holds no clipboard: what a
 * take-over risks is a duplicate PLANNER, if the stepped-over holder's stage ever returns. Who
 * can be stepped over now, exactly: a foreign holder whose progress stamp is 30 minutes old AND
 * whose own beat is 3 minutes old (or absent — a row from a build older than `beatAt`) AND that
 * no scheduler heartbeat vouches for. A live process on any machine beats every 60 s, so that
 * is a process that is DEAD; or one whose DATABASE WRITES have failed for three minutes (a Mac
 * whose tunnel dropped mid-slot, a worker that lost its Postgres); or one whose event loop has
 * been blocked synchronously for three minutes, which no stage here does (every stage awaits
 * the network, a browser or a spawned child — the one synchronous spawn in the tree is disk
 * care's `ps`, on the agent). The second is the honest residue: when its writes come back, a
 * stepped-over SLOT finishes the stage it was in and then STOPS — `touchSlotLock` reports the
 * row changed hands and `runSlotLocked`'s fence halts before the next stage (reviewer major
 * F2) — while a planning run under `withSlotLock` has no fence and finishes beside the new
 * holder; see its docblock. What NOT stepping over such a row risks is the fleet's drafting
 * deadlocked on a row nobody can refresh and nobody is allowed to delete: a take-over after
 * thirty minutes of silence from a holder that has not proved itself alive for three is the
 * right side of that trade — and before this build EVERY foreign read stepped over, fresh or
 * not.
 *
 * ABSENT IS NOT A VOUCH; UNREADABLE IS NOT AN ANSWER. A witness that is ABSENT — no `beatAt`,
 * no heartbeat row, a row that is not a beat, a beat for another machine or pid — is passed as
 * `holderProcessFresh: false`: absence never vouches, and that is the direction that KEEPS the
 * 30-minute bound rather than deadlocking, because a missing or stale witness is precisely what
 * a dead holder leaves behind. A witness the caller could not READ — the heartbeat query threw
 * — is a different fact: `acquireSlotLock` never reaches this function and DECLINES that
 * attempt instead (reviewer major 2 on the first version, which read a thrown read as "no
 * vouch" and could have stepped over a vouched holder on a transient error). Declining there
 * cannot deadlock: the next attempt reads again.
 *
 * A ROW WITH NO `device` IS FOREIGN — the OPPOSITE of the send lock's reading of its own
 * legacy row (`holderIsSameMachine` treats a row under our name with no HOST as ours, so the
 * first restart onto that build recovers its predecessor's row at once). Here the only reader
 * that trips over a device-less row today is a Mac reading the Linode worker's row — the
 * exact case this fix exists for — and the cost of the other reading is small and bounded: a
 * Linode worker killed mid-slot and restarted onto this build waits at most `staleMs` for its
 * predecessor's old-format row to go stale, then takes it over. One ≤30-minute wait, never a
 * second planner. (The worker's own first restart onto this build may therefore wait up to
 * 30 minutes for a stale pre-upgrade row; the log says so when it does. A device-less row names
 * no machine for a heartbeat to vouch for, so it is always "unvouched": the wait is the bound.)
 */
export function decideSlotLock(args: {
  held: SlotLockHolder | null
  /** The local OS's answer to `process.kill(pid, 0)` — EVIDENCE ONLY WHEN THE HOLDER IS LOCAL. */
  holderAlive: boolean
  /** The row names THIS machine (name AND, when both carry one, host). A row naming no machine is NOT local. */
  holderIsLocal: boolean
  /**
   * The holder's PROCESS is vouched for by a witness in the shared store: a `schedulerHeartbeat`
   * younger than `HEARTBEAT_STALE_MS` whose machine AND pid are the row's. Read only when the
   * holder is foreign (the local OS answers for a local one); an unreadable beat is `false`.
   */
  holderProcessFresh: boolean
  ourPid: number
  ageMs: number
  staleMs?: number
}): LockVerdict {
  const { held, holderAlive, holderIsLocal, holderProcessFresh, ourPid, ageMs, staleMs = SLOT_LOCK_STALE_MS } = args

  // No parseable holder: an unparseable row must not deadlock the scheduler forever.
  if (held === null) return { action: 'take-over' }
  const stalled = ageMs >= staleMs

  if (!holderIsLocal) {
    /**
     * FOREIGN. Its pid means nothing here — NOT EVEN WHEN IT EQUALS OURS: pids collide across
     * machines (a container's first process is pid 1; `tests/dispatcher.test.ts` pins the same
     * for the send lock), so the own-pid take-over below is reachable only for a LOCAL row.
     * The evidence is the progress stamp and the process witness, per the table above.
     */
    if (holderProcessFresh) return { action: 'decline', stalled }
    if (stalled) return { action: 'take-over' }
    return { action: 'decline', stalled: false }
  }

  // Our own row, from an earlier stage or a crashed sibling in this process.
  if (held.pid === ourPid) return { action: 'take-over' }
  // The holder's process is gone — a crash or a kill -9 left the row behind.
  if (!holderAlive) return { action: 'take-over' }

  /**
   * ALIVE, LOCAL. Never take over, however old the lock is.
   *
   * This used to be `alive && ageMs < staleMs`, so age overruled liveness and a second
   * slot started alongside a hung-but-running first one. Two live runs share the OS
   * clipboard, and `sendDm` pastes from it — an interleaved copy and paste puts message
   * A into thread B. The per-attempt READY→SENDING claim stops the SAME message going
   * twice; nothing stops two DIFFERENT messages racing through one clipboard.
   *
   * Stated plainly: a wedged slot now blocks later slots instead of being stepped over.
   * Nothing sends, rather than something sends twice — and `stalled` makes it an alarm
   * rather than a silence. (A local holder shares our clipboard; a foreign one does not,
   * which is why the foreign branch above may step over a stale row and this one may not.)
   */
  return { action: 'decline', stalled }
}

/**
 * The exact value of the slot-lock row THIS process last wrote, or null when it holds none.
 *
 * Release is conditioned on it (below), and the refresh — and the beat — move it forward, so
 * the three can never disagree. The first version of the conditional release compared against the value
 * written at ACQUISITION, while this refresh rewrites the row at every stage boundary: the
 * delete matched nothing and every slot would have left its lock behind, blocking the
 * dashboard's Sync now and `pnpm run:slot` until the row went stale. Found by reading the
 * diff, before it shipped.
 */
let slotLockValue: string | null = null

/**
 * THE ONE BUILDER of the row's bytes, for every writer: the acquire, the take-over, the refresh
 * and the beat. `touchSlotLock` rewrites the WHOLE row at every stage boundary, so a refresh that
 * dropped `device`/`host` would hand this holder's own later reads a device-less row — which
 * `acquireSlotLock` treats as foreign — and a planning run would then decline its own slot's
 * lock as another machine's. One builder, so the four writers cannot disagree on the shape.
 *
 * `progressAt` is passed by the BEAT alone: it proves the process is alive and must not claim a
 * stage ended, so it carries the row's `at` forward and stamps only `beatAt`. Every other writer
 * stamps both with the same instant.
 *
 * `host` is dropped by `JSON.stringify` when `hostId()` is undefined, so a machine without an
 * id writes the same row it would have before the field, plus `device` and `beatAt`.
 */
function slotLockRowFor(slot: string, progressAt?: string): string {
  const now = new Date().toISOString()
  return JSON.stringify({ pid: process.pid, slot, at: progressAt ?? now, device: deviceId(), host: hostId(), beatAt: now })
}

/**
 * EVERY WRITE TO THE ROW FROM THIS PROCESS GOES THROUGH ONE QUEUE. The stage-boundary refresh,
 * the 60-second beat and the release each rewrite (or delete) the row CONDITIONALLY on the exact
 * value this process last wrote, and the beat fires from a timer — so without a queue a beat in
 * flight and a boundary refresh could both read the same `slotLockValue`, both send
 * `where value = V0`, and the second would match nothing: a self-inflicted "lost the lock" that
 * stops a healthy slot, or a release that misses its own row and leaves it behind. Each write
 * therefore waits for the one before it and reads `slotLockValue` only once that one settled.
 */
let rowWrites: Promise<unknown> = Promise.resolve()

function queuedRowWrite<T>(fn: () => Promise<T>): Promise<T> {
  const run = rowWrites.then(fn, fn)
  rowWrites = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

/** Logged once per hold: a beat that finds the row changed hands says so, then stays quiet. */
let lossNoticed = false

/**
 * Rewrite the row — the whole row, through the one builder — conditionally on it still being
 * the one WE wrote. `kind` decides what the rewrite claims: `progress` stamps `at` and `beatAt`
 * (a stage ended), `beat` stamps `beatAt` alone (the process is alive; `at` is carried over).
 * The three answers are `touchSlotLock`'s, below.
 */
async function rewriteSlotLockRow(slot: string, kind: 'progress' | 'beat'): Promise<boolean> {
  const ours = slotLockValue
  // Holding no row of ours is not evidence that one changed hands: nothing to refresh, nothing lost.
  if (ours === null) return true
  // Our own bytes, from the one builder: always parseable.
  const next = slotLockRowFor(slot, kind === 'beat' ? (JSON.parse(ours) as SlotLockHolder).at : undefined)
  let r: { count: number }
  try {
    r = await prisma.setting.updateMany({ where: { key: SLOT_LOCK_KEY, value: ours }, data: { value: next } })
  } catch (err) {
    log.warn(`could not ${kind === 'beat' ? 'beat' : 'refresh'} the slot lock — continuing; its stamp is stale until the next write lands`, {
      slot,
      error: describeError(err),
    })
    return true
  }
  if (r.count === 1) {
    slotLockValue = next
    return true
  }
  if (!lossNoticed) {
    lossNoticed = true
    log.warn('the slot lock changed hands while this holder ran — another machine stepped over it; a slot stops at its next stage boundary', { slot })
  }
  return false
}

/**
 * Refresh the lock's timestamp — "still going" — and REPORT WHETHER THE ROW IS STILL OURS.
 *
 * Conditional on the row still being the one WE wrote, so a slot that lost the lock cannot
 * stamp over whoever holds it now. Returns:
 *
 *   true   the row was ours and is now refreshed (`count === 1`);
 *   FALSE  the row CHANGED HANDS (`count === 0`) — another machine took it over past
 *          `SLOT_LOCK_STALE_MS` while a stage of ours ran long and nothing vouched for this
 *          process. `slotLockValue` is left as it was, so the value-conditioned release below
 *          matches nothing and deletes nothing;
 *   true   the write itself threw. A liveness write must never stop the slot it reports on;
 *          it is logged, because a refresh that cannot be written is the stale stamp the next
 *          foreign reader will see.
 *
 * Until the review of this build (reviewer major F2, 2026-10-15) this returned void, `count`
 * was ignored, and `runSlotLocked` ran its remaining stages regardless — so the "bounded
 * duplicate planner" the take-over trade accepts actually happened on the slot path. The slot
 * now stops at the first false; see the fence in `runSlotLocked`.
 *
 * Since 2026-10-15 this stamp is also what a FOREIGN machine reads as this holder's progress
 * (`decideSlotLock`): a holder that stops refreshing for `SLOT_LOCK_STALE_MS`, whose own beat
 * (`beatSlotLock`) has stopped too, and that no scheduler heartbeat vouches for is stepped over
 * from another host.
 *
 * Exported for tests; the slot calls it at each stage boundary.
 */
export async function touchSlotLock(slot: string): Promise<boolean> {
  return queuedRowWrite(() => rewriteSlotLockRow(slot, 'progress'))
}

/**
 * The holder's own liveness proof: rewrite `beatAt` and nothing else, so a foreign reader can
 * tell this process is alive however long its current stage runs. The timer below calls it every
 * `SLOT_LOCK_BEAT_MS`; exported so a test can drive one beat and read the row back. Answers like
 * the refresh — a beat that finds the row is no longer ours stamps nothing over the new holder.
 */
export async function beatSlotLock(slot: string): Promise<boolean> {
  return queuedRowWrite(() => rewriteSlotLockRow(slot, 'beat'))
}

let beatTimer: ReturnType<typeof setInterval> | null = null

/**
 * Started the moment the lock is ours, stopped BEFORE the release so no beat can be queued behind
 * the delete. `unref`'d: a `pnpm run:slot` must exit when its slot does, not when the timer does.
 */
function startSlotLockBeat(slot: string): void {
  stopSlotLockBeat()
  lossNoticed = false
  beatTimer = setInterval(() => void beatSlotLock(slot), SLOT_LOCK_BEAT_MS)
  beatTimer.unref?.()
}

function stopSlotLockBeat(): void {
  if (beatTimer !== null) clearInterval(beatTimer)
  beatTimer = null
}

/**
 * PURE. Does this scheduler heartbeat vouch for this lock holder's PROCESS?
 *
 * The beat must name the row's machine AND pid and be younger than `HEARTBEAT_STALE_MS`. Both
 * sides must actually CARRY a machine: a row from a build older than `device`, or a beat older
 * than `machine`, is `undefined` on that side, and `undefined === undefined` would otherwise let
 * every legacy beat vouch for every legacy row. An unparseable `at` is NaN, and `NaN < x` is
 * false: no vouch. The beat carries a NAME and no host id, so a same-name twin running the same
 * pid at the same moment could vouch falsely — and that error is a decline bounded by the
 * beat's 3-minute staleness, never a take-over.
 */
function heartbeatVouchesFor(beat: SchedulerHeartbeat | null, held: SlotLockHolder, now: number = Date.now()): boolean {
  if (beat === null) return false
  if (held.device === undefined || beat.machine === undefined) return false
  if (beat.machine !== held.device || beat.pid !== held.pid) return false
  return now - new Date(beat.at).getTime() < HEARTBEAT_STALE_MS
}

/**
 * PURE. Does the row's OWN beat vouch for its holder's process? A `beatAt` younger than
 * `SLOT_LOCK_BEAT_STALE_MS`. Absent (a row older than the field) or unparseable (`NaN < x` is
 * false) is no vouch: absence never vouches. Exported for the pure half of its test.
 */
export function slotBeatVouchesFor(held: SlotLockHolder, now: number = Date.now()): boolean {
  if (typeof held.beatAt !== 'string') return false
  return now - new Date(held.beatAt).getTime() < SLOT_LOCK_BEAT_STALE_MS
}

/**
 * Is another slot genuinely running?
 *
 * cron tasks pass `noOverlap`, but that is per-task and does not cover `syncNow` (the
 * dashboard's Sync now button), a second `pnpm run:slot`, or a click landing during a
 * cron slot. Two concurrent `runOutreach` calls both read `hasPendingAttempt: false` for
 * the same pair, both create an attempt, and both dispatch — two DMs to one prospect
 * seconds apart, which is the worst spam signal available.
 *
 * Freshness alone is not liveness: a `kill -9` leaves the record behind, which is exactly
 * the bug that once stopped the scheduler starting at all. So ask the OS, the same way
 * `startScheduler` does — but ONLY about a row this machine wrote (2026-10-15). The OS can
 * answer for its own pids alone; asked about the Linode's pid, the Mac's kernel said "no such
 * process" and this function took the lock over a live planner. See `decideSlotLock`.
 */
async function acquireSlotLock(slot: string): Promise<string | null> {
  const ourDevice = deviceId()
  const ourHost = hostId()
  const value = slotLockRowFor(slot)

  /**
   * `create` on the primary key is the atomic test-and-set: it succeeds only if no row
   * exists, and throws otherwise. There is no window between the test and the set.
   *
   * The first version of this used `findUnique` then `upsert`, which is a check-then-act
   * — the identical flaw this commit fixes in `sendNow`. Two `pnpm run:slot` processes
   * started together both read "no lock" before either wrote, both proceeded, and two
   * ScrapeRuns appeared. Caught by running it rather than by reading it.
   */
  try {
    await prisma.setting.create({ data: { key: SLOT_LOCK_KEY, value } })
    return value
  } catch {
    // A row exists. Whether it represents a live slot is a separate question.
  }

  const row = await prisma.setting.findUnique({ where: { key: SLOT_LOCK_KEY } })
  if (!row) {
    // Vanished between the create and the read — the holder just finished. Try once more.
    try {
      await prisma.setting.create({ data: { key: SLOT_LOCK_KEY, value } })
      return value
    } catch {
      return null
    }
  }

  let held: SlotLockHolder | null = null
  try {
    held = JSON.parse(row.value) as SlotLockHolder
  } catch {
    held = null // unparseable: treat as dead rather than deadlocking forever
  }

  /**
   * Is the row THIS machine's? Same name AND (when both sides carry one) same host — the send
   * lock's own predicate, reused rather than copied so the two locks cannot drift on what "mine"
   * means. It reads only `device` and `host`; the `what` is the structural tax of handing it a
   * slot row without touching the dispatcher.
   *
   * `held.device !== undefined` is stated even though the predicate already fails a device-less
   * row: the rule "a row naming no machine is foreign" is this lock's own (see `decideSlotLock`)
   * and must survive the predicate ever learning to forgive a missing device the way it forgives
   * a missing host.
   */
  const holderIsLocal =
    held !== null && held.device !== undefined && holderIsSameMachine({ ...held, what: held.slot }, ourDevice, ourHost)
  // Asked of a LOCAL holder only — this OS cannot answer for a pid on another machine.
  const alive =
    holderIsLocal &&
    (() => {
      try {
        process.kill(held!.pid, 0)
        return true
      } catch {
        return false
      }
    })()
  // An unreadable `at` is NO progress, not fresh progress: `NaN >= staleMs` is false, and a
  // foreign row whose stamp cannot be read would otherwise be declined forever.
  const rawAge = held ? Date.now() - new Date(held.at).getTime() : Infinity
  const ageMs = Number.isFinite(rawAge) ? rawAge : Infinity
  /**
   * The process witness, for a FOREIGN holder only — the local path asks the OS and reads nothing.
   * The row's own beat answers first and costs no read. The scheduler heartbeat is read only where
   * it can change the verdict: the own beat did not vouch AND the stamp is stale, the one cell of
   * the table that steps over. A heartbeat that cannot be READ (the query threw) is not "no vouch"
   * — it is no answer, and this attempt DECLINES rather than step over a holder it might have
   * vouched for; the next attempt reads again (reviewer major 2 on the first version).
   */
  const ownBeat = held !== null && !holderIsLocal && slotBeatVouchesFor(held)
  let vouchedBy: 'own-beat' | 'scheduler-heartbeat' | 'nothing' = ownBeat ? 'own-beat' : 'nothing'
  if (held !== null && !holderIsLocal && !ownBeat && ageMs >= SLOT_LOCK_STALE_MS) {
    let witness: SchedulerHeartbeat | null
    try {
      witness = await readSchedulerHeartbeat()
    } catch (err) {
      log.warn('could not read the scheduler heartbeat — declining this attempt rather than stepping over a holder it might vouch for', {
        otherPid: held.pid,
        otherDevice: held.device ?? 'unknown (a build older than the device field)',
        otherHost: held.host,
        secondsSinceProgress: Math.round(ageMs / 1000),
        error: describeError(err),
      })
      return null
    }
    if (heartbeatVouchesFor(witness, held)) vouchedBy = 'scheduler-heartbeat'
  }
  const holderProcessFresh = vouchedBy !== 'nothing'

  const verdict = decideSlotLock({ held, holderAlive: alive, holderIsLocal, holderProcessFresh, ourPid: process.pid, ageMs })
  if (verdict.action === 'decline') {
    const detail = {
      otherPid: held?.pid,
      otherSlot: held?.slot,
      secondsSinceProgress: Math.round(ageMs / 1000),
    }
    if (!holderIsLocal) {
      const foreign = {
        ...detail,
        otherDevice: held?.device ?? 'unknown (a build older than the device field)',
        otherHost: held?.host,
        vouchedBy,
      }
      if (verdict.stalled) {
        // Its process is still beating, so it is ALIVE — and its current stage has outrun the bound.
        log.alarm("another machine's slot is alive but has made no progress for a long time — nothing else can start", foreign)
      } else {
        // The ordinary case for the Mac's "Sync now" while the Linode worker plans: not a fault.
        log.warn('another machine is running a slot — declining', foreign)
      }
    } else if (verdict.stalled) {
      log.alarm('a slot is running but has made no progress for a long time — nothing else can start', detail)
    } else {
      log.warn('another slot is already running — declining to start a second', detail)
    }
    return null
  }

  /**
   * The holder is dead, us, or a foreign machine gone silent. Take over — but conditionally
   * on the row still holding exactly the value we just read, so two processes both finding
   * the same corpse cannot both claim it.
   */
  const claimed = await prisma.setting.updateMany({
    where: { key: SLOT_LOCK_KEY, value: row.value },
    data: { value },
  })
  if (claimed.count === 0) {
    log.warn('another slot took over the lock first — declining', { previousPid: held?.pid })
    return null
  }
  /**
   * Four reasons we reach here (three until 2026-10-15), and they printed as one.
   *
   * `if (held)` covers the case where the row is our OWN pid, so this reported a live
   * process — the one running this very line — as "a process that is gone". Found while
   * verifying Phase 5 against the identical line in the send lock: `deadPid=<us>`, sending
   * anyone debugging a wedged slot after a crash that never happened. The foreign case is
   * tested FIRST: its pid is a fact about another machine, and "a process that is gone" would
   * send the reader looking for a crash on the wrong host.
   */
  if (held === null) {
    log.step('the slot lock held an unreadable value — replacing it')
  } else if (!holderIsLocal) {
    // Loud on purpose: another machine held the lock, stopped refreshing it for half an hour, its own
    // beat stopped for three minutes and no scheduler heartbeat vouches for its process — a crash, a
    // lost tunnel — and a person should know the fleet's drafting waited on it.
    log.alarm('taking over a slot lock held by another machine that has made no progress for a long time, whose own beat has stopped and that no heartbeat vouches for', {
      device: held.device ?? 'unknown (a build older than the device field)',
      host: held.host,
      pid: held.pid,
      previousSlot: held.slot,
      secondsSinceProgress: Math.round(ageMs / 1000),
    })
  } else if (held.pid === process.pid) {
    log.step('reclaiming a slot lock this process left behind', { previousSlot: held.slot })
  } else {
    log.step('taking over a slot lock left by a process that is gone', {
      deadPid: held.pid,
      ageSeconds: Math.round(ageMs / 1000),
    })
  }
  return value
}

/**
 * ── THE SLOT LOCK IS ALSO HELD IN THIS PROCESS, AND RELEASED ONLY BY ITS HOLDER (2026-10-09) ──
 *
 * The row decides between PROCESSES, and `decideSlotLock` grants a take-over whenever the row
 * names our own pid — right for a crash leftover, wrong for a LIVE holder in the same process.
 * On the Linode the four slots and the 15-minute detect-then-draft run in ONE worker, so the
 * planner's `withSlotLock` took over a running slot's lock, planned beside it (two planners,
 * two drafts per pair possible), and its `finally` then deleted the row while the slot was still
 * running. The same "nested acquire, inner finally unlocks" hole `withSendLock` closed with
 * `heldInThisProcess`, closed the same way here — and the release is conditioned on the exact
 * value this holder wrote, like the send lock's.
 */
let slotLockHeldHere = false

async function releaseSlotLock(): Promise<void> {
  // Queued behind any beat or refresh in flight, so it deletes the value that write left — not the one before it.
  await queuedRowWrite(async () => {
    const ours = slotLockValue
    slotLockValue = null
    if (ours === null) return
    await prisma.setting.deleteMany({ where: { key: SLOT_LOCK_KEY, value: ours } }).catch(() => undefined)
  })
}

/**
 * A slot must not be SKIPPED because this process is planning — a slot carries the twice-daily
 * reply sweep and the catch-up detection, and losing one is worse than waiting for a planning
 * run to finish. So a slot waits, bounded, for an in-process holder; the planner (which runs
 * again in fifteen minutes) simply skips. The bound is generous because a slot has nothing else
 * to do, and after it the slot declines exactly as it did for a foreign holder.
 */
const SLOT_WAIT_FOR_IN_PROCESS_MS = 15 * 60_000

async function waitForInProcessSlotLock(maxMs: number): Promise<boolean> {
  const deadline = Date.now() + maxMs
  while (slotLockHeldHere && Date.now() < deadline) await new Promise((r) => setTimeout(r, 1000))
  return !slotLockHeldHere
}

/** True while a slot or a planning run in THIS process holds the slot lock. For tests and health. */
export function slotLockHeldInThisProcess(): boolean {
  return slotLockHeldHere
}

/**
 * Run something under the SLOT LOCK, for a caller that is not a slot.
 *
 * Exported so the 15-minute detect task can plan drafts without becoming a second unlocked
 * planner. The hazard is written out at `acquireSlotLock` above and is not hypothetical here:
 * `noOverlap` is PER TASK, so it does nothing between the detect cron and a slot — and the
 * four slots sit on minute 0, which is always a multiple of `DETECT_INTERVAL_MINUTES`, so the
 * two collide FOUR TIMES A DAY by construction. (The same collision is why the pipeline's
 * upsert `update:` branch fires 16 times a day and must not be deleted as dead code.)
 *
 * Two concurrent `runOutreach` calls both read `hasPendingAttempt: false` for one pair, both
 * create an attempt, and both become deliverable — two DMs to one prospect, which is the worst
 * spam signal available. `hasPendingAttempt` is a read-then-write and cannot close that on its
 * own; the lock is what does.
 *
 * Returns `null` when the lock is held, which the caller must treat as "someone else is doing
 * this", never as a failure: a slot running right now does the same planning anyway.
 *
 * `acquire`/`release` are NOT exported. One lock, one owner — handing out the primitives is how
 * a caller ends up releasing a lock it did not take, which already happened here once with the
 * nested send lock.
 *
 * A RUN UNDER THIS LOCK IS VOUCHED FOR BY ITS OWN BEAT, AND CANNOT NOTICE LOSING IT (2026-10-15).
 * Its progress stamp is written once, at acquisition — there are no stage boundaries to refresh
 * it at — but the beat timer rewrites `beatAt` every 60 s for as long as the process lives, so a
 * planning pass that outlives `SLOT_LOCK_STALE_MS` is declined by every foreign reader as a slow
 * LIVE holder, however long it runs. (The first version of this build had no beat: a pass on a
 * host whose scheduler heartbeat had gone stale could be stepped over.) What remains is the pass
 * whose beat STOPS while it is alive — its database writes failing for three minutes, a lost
 * tunnel or Postgres — and a foreign holder then steps over the row: unlike `runSlotLocked`,
 * whose fence halts a slot before its next stage, a pass here has no boundary at which to find
 * out and finishes beside the new holder. That residue is alarmed rather than silent: the first
 * beat of the stepped-over pass that lands says so (`rewriteSlotLockRow`), an in-process slot
 * waiting on it alarms after `SLOT_WAIT_FOR_IN_PROCESS_MS`, and a plan stamp older than
 * `PASS_STALE_MS` (scheduler.ts) is the "fresh heartbeat, stale pass" signature the dashboard
 * ladder names. The release is value-conditioned either way, so a stepped-over pass deletes
 * nothing of the new holder's.
 */
export async function withSlotLock<T>(label: string, fn: () => Promise<T>): Promise<T | null> {
  if (slotLockHeldHere) {
    log.step('a slot is already running in this process — skipping this run', { label })
    return null
  }
  /* The flag is taken BEFORE the first await and dropped only AFTER the release has finished.
     Set after the acquire (the first version), two callers starting in the same tick both passed
     the check, and — a row naming our own pid always grants a take-over — both held the lock;
     dropped before the delete, a waiting slot woke mid-release and was declined by the row. */
  slotLockHeldHere = true
  try {
    const ours = await acquireSlotLock(label)
    if (ours === null) return null
    slotLockValue = ours
    startSlotLockBeat(label)
    return await fn()
  } finally {
    stopSlotLockBeat()
    await releaseSlotLock()
    slotLockHeldHere = false
  }
}

export async function runSlot(slot: string): Promise<SlotResult> {
  const started = Date.now()
  log.info(`▶ slot ${slot} starting`, { at: istStamp(), dryRun: env.DRY_RUN })

  if (slotLockHeldHere) {
    log.step('planning is running in this process — the slot waits for it rather than being skipped', { slot })
    if (!(await waitForInProcessSlotLock(SLOT_WAIT_FOR_IN_PROCESS_MS))) {
      log.alarm('the slot waited for an in-process run that never finished — skipping it', { slot })
      return { runId: '', status: 'FAILED', postsSeen: 0, newPosts: 0, detected: 0, queued: 0, sent: 0 }
    }
  }
  /* Same ordering as `withSlotLock`, for the same two races. No await separates the wait above
     from this line, so nothing in this process can take the flag in between. */
  slotLockHeldHere = true
  try {
    const ours = await acquireSlotLock(slot)
    if (ours === null) {
      return { runId: '', status: 'FAILED', postsSeen: 0, newPosts: 0, detected: 0, queued: 0, sent: 0 }
    }
    slotLockValue = ours
    startSlotLockBeat(slot)
    return await runSlotLocked(slot, started)
  } finally {
    stopSlotLockBeat()
    await releaseSlotLock()
    slotLockHeldHere = false
  }
}

/**
 * The slot itself. Only ever called with the lock held.
 *
 * ── THE FENCE (reviewer major F2, 2026-10-15) ────────────────────────────────────────
 *
 * Every stage boundary refreshes the lock's stamp, and since this build the refresh REPORTS
 * whether the row is still ours. It is not when another machine stepped over this slot: a
 * stage of ours outran `SLOT_LOCK_STALE_MS` while nothing vouched for this process — its own
 * beat had not landed for three minutes (a tunnel that dropped mid-slot) and no scheduler
 * heartbeat named it. From that moment this slot IS the duplicate the take-over trade accepts, and the
 * cheapest duplicate is one that never reaches its next stage: no reply sweep, no dispatch, no
 * planning. The stages that already ran are real and are recorded; the run is PARTIAL, not
 * FAILED; the alarm names the stage it stopped before. The release at the end is conditioned on
 * the value this slot last wrote, so it deletes nothing of the new holder's.
 *
 * Before this build `touchSlotLock` returned void and every stage ran regardless, so the
 * "bounded duplicate planner" written into the trade actually happened on the slot path.
 */
async function runSlotLocked(slot: string, started: number): Promise<SlotResult> {
  const run = await prisma.scrapeRun.create({ data: { slot } })

  let status: SlotResult['status'] = 'OK'
  let postsSeen = 0
  let newPosts = 0
  let detected = 0
  let queued = 0
  let sent = 0
  const detail: Record<string, unknown> = {}
  const errors: string[] = []

  /**
   * Refreshed between stages so the lock's timestamp means "still progressing" rather
   * than "started a while ago". A stage boundary is the right granularity: each one is
   * seconds apart on a healthy slot, and a slot wedged inside a stage is precisely the
   * state that must NOT read as fresh.
   *
   * Returns whether the NEXT stage may run. Once the lock is lost it stays lost: a later
   * refresh cannot win the row back (its `where` still names our old value), and a slot that
   * has been stepped over must not resume a stage later just because the new holder finished.
   */
  let lockLost = false
  const progress = async (nextStage: string): Promise<boolean> => {
    if (lockLost) return false
    if (await touchSlotLock(slot)) return true
    lockLost = true
    status = 'PARTIAL'
    errors.push(`lost the slot lock to another machine — stopped before ${nextStage}`)
    log.alarm(`this slot lost its lock to another machine — stopping before ${nextStage}`, { slot, stage: nextStage })
    return false
  }

  // ── 1. Detection ───────────────────────────────────────────────────────────
  if (await progress('detection')) {
    try {
      /**
       * The slot keeps the LONG lookback. Detection has its own 15-minute cron now
       * (scheduler.ts), so this call is not the primary way posts arrive — it is the
       * safety net that guarantees a slot never plans outreach against a stale corpus,
       * including after the machine was asleep and the fast passes never fired. See
       * src/detection/cadence.ts.
       */
      const d = await runDetection({ lookbackHours: DETECT_CATCHUP_LOOKBACK_HOURS })
      postsSeen = d.postsSeen
      newPosts = d.newPosts
      detected = d.detected
      detail.channels = d.channels

      if (d.hadParseFailure) {
        status = 'PARTIAL'
        errors.push('parse failure — see ALARM above')
      } else if (d.hadError) {
        status = 'PARTIAL'
        errors.push('one or more channels failed')
      }
    } catch (err) {
      status = 'PARTIAL'
      const message = err instanceof Error ? err.message : String(err)
      errors.push(`detection: ${message}`)
      log.alarm('detection stage threw — continuing to outreach anyway', { error: message })
    }
  }

  /**
   * ── 2. Check for replies ──────────────────────────────────────────────────
   *
   * BEFORE delivering, deliberately. A reply is the hardest stop in the system, and
   * discovering one after this slot has already sent into the conversation would make
   * the check worthless for the one message it most needed to prevent.
   *
   * Only on the slots in REPLY_CHECK_SLOTS (11:00 and 20:00), because each check is a
   * real browser session against a revenue account. Running it at all four slots is
   * the volume increase CLAUDE.md declines, and that judgement is respected here.
   *
   * **NOT on 'manual'.** That was the first version of this and it was wrong: the
   * dashboard's "Check now" button calls `runSlot('manual')`, so pressing it would
   * have opened up to four Chrome windows and driven Instagram for minutes — a
   * control doing something entirely different from what its label promises, and
   * unattended browser activity nobody asked for. Reply checking is reachable
   * deliberately, via `pnpm ig:replies`, or on its own schedule. A button that says
   * "check the channels" checks the channels.
   *
   * Never fatal to the slot: failing to read a thread must not stop delivery of
   * messages that are already permitted, or a DOM change would silently halt outreach.
   */
  if (await progress('reply check')) {
    if (isReplyCheckSlot(slot)) {
      try {
        const r = await checkForReplies()
        detail.replyCheck = r.outcomes
        if (r.repliesFound > 0) {
          log.info(`${r.repliesFound} reply(ies) detected — outreach to those targets is halted`, {})
        }
        if (r.unreadable > 0) {
          // PARTIAL, not silence: an unreadable thread means the guard could not be
          // evaluated, and the operator has to be able to see that happened.
          status = status === 'OK' ? 'PARTIAL' : status
          errors.push(`${r.unreadable} conversation(s) could not be read`)
        }
        if (r.deferred > 0) {
          /**
           * Recorded, not silent. The sweep's budget is a constant and the number of
           * conversations is not, so this number is the honest measure of how much of the
           * sweep's coverage the fleet has outgrown. It is NOT an error — a follow-up into
           * any of these reads its own thread first (`ensureConversationChecked`), which is
           * the guarantee the sweep alone could never give.
           */
          detail.replyCheckDeferred = r.deferred
          log.step('reply sweep did not reach every conversation', {
            deferred: r.deferred,
            note: 'each is still read before anything is sent into it',
          })
        }
      } catch (err) {
        status = status === 'OK' ? 'PARTIAL' : status
        const message = err instanceof Error ? err.message : String(err)
        errors.push(`reply check: ${message}`)
        log.alarm('reply check threw — replies may be undetected this slot', { error: message })
      }
    }
  }

  /**
   * ── 3. One dispatcher tick ────────────────────────────────────────────────
   *
   * Before planning, not after. Delivering is the point of a slot; drafting is
   * preparation for the next one. This step exists because without it autopilot could
   * only ever send a message it had just created — a draft prepared while autopilot was
   * off stayed waiting forever, since the governor correctly refuses to stack a second
   * unsent message on the same pair.
   *
   * SINCE PHASE 5 IT IS ONE TICK, NOT THE WHOLE QUEUE, and that is the change that keeps
   * a slot bounded. It used to call `deliverWaiting` with no limit, which drained
   * everything waiting with a 45-180 s sleep between sends: at four accounts a two-minute
   * slot, at fleet volume (measured: 11-14 paid posts a day from `@viralbhayani` alone)
   * an hour of continuous browser driving, all of it landing inside one hour in one inbox
   * from a dozen different pages.
   *
   * Nothing is lost by the bound. The dispatcher runs on its own cadence every
   * DISPATCH_INTERVAL_MINUTES, from the same scheduler that fires these slots, so
   * whatever this tick does not send is picked up within minutes — and the slot is no
   * longer the only unattended path to a delivered message, which is what made the old
   * arrangement able to take hours.
   */
  if (await progress('dispatch')) {
    try {
      const d = await dispatchTick(`slot:${slot}`)
      sent += d.delivered?.sent ?? 0
      detail.dispatch = {
        action: d.verdict.action,
        reason: d.verdict.action === 'hold' ? d.verdict.reason : 'sending',
        detail: d.verdict.action === 'hold' ? d.verdict.detail : undefined,
        outcomes: d.delivered?.outcomes ?? [],
      }
      if ((d.delivered?.failed ?? 0) > 0) {
        status = status === 'OK' ? 'PARTIAL' : status
        errors.push(`${d.delivered!.failed} delivery failure(s)`)
      }
    } catch (err) {
      status = 'PARTIAL'
      const message = err instanceof Error ? err.message : String(err)
      errors.push(`delivery: ${message}`)
      log.alarm('delivery stage threw — waiting messages remain waiting', { error: message })
    }
  }

  // ── 4. Decide and prepare ─────────────────────────────────────────────────
  if (await progress('planning')) {
    try {
      const o = await runOutreach()
      queued = o.queued
      sent += o.sent
      detail.outreach = o.outcomes
      if (o.failed > 0) {
        status = status === 'OK' ? 'PARTIAL' : status
        errors.push(`${o.failed} outreach failure(s)`)
      }
    } catch (err) {
      status = 'FAILED'
      const message = err instanceof Error ? err.message : String(err)
      errors.push(`outreach: ${message}`)
      log.alarm('outreach stage threw — no messages queued this slot', { error: message })
    }
  }

  await prisma.scrapeRun.update({
    where: { id: run.id },
    data: {
      finishedAt: new Date(),
      postsSeen,
      newPosts,
      detected,
      queued,
      sent,
      status,
      error: errors.length > 0 ? errors.join(' | ') : null,
      detail: writeRecord(detail),
    },
  })

  const seconds = ((Date.now() - started) / 1000).toFixed(1)
  log.info(`■ slot ${slot} ${status}`, { seconds, postsSeen, newPosts, detected, queued, sent })

  return { runId: run.id, status, postsSeen, newPosts, detected, queued, sent }
}
