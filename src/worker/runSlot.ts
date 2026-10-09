import { prisma } from '@/lib/db'
import { env } from '@/lib/env'
import { log } from '@/lib/logger'
import { writeRecord } from '@/lib/json'
import { istStamp } from '@/lib/time'
import { runDetection } from '@/detection/pipeline'
import { DETECT_CATCHUP_LOOKBACK_HOURS } from '@/detection/cadence'
import { runOutreach } from '@/outreach/plan'
import { dispatchTick } from '@/outreach/dispatcher'
import { checkForReplies, isReplyCheckSlot } from '@/outreach/replyCheck'

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

/** Setting key holding `{"pid":123,"slot":"11:00","at":"..."}` while a slot runs. */
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

export interface SlotLockHolder {
  pid: number
  slot: string
  at: string
}

export type LockVerdict =
  /** Somebody else is running it. Do not start. */
  | { action: 'decline'; stalled: boolean }
  /** The holder's process is gone, or it is us. Safe to claim. */
  | { action: 'take-over' }

/**
 * PURE. Given what the lock row says and whether that process still exists, may we run?
 *
 * Extracted so both directions are testable without a database or a second process —
 * the same reason `decideRoute`, `evaluatePair` and `recheckBeforeSend` are pure. The
 * previous version of this decision lived inline and had never been exercised in the
 * case that mattered.
 *
 * `ageMs` is time since the holder last reported PROGRESS, not since it started, because
 * `touchSlotLock` refreshes the timestamp at every stage boundary.
 */
export function decideSlotLock(args: {
  held: SlotLockHolder | null
  holderAlive: boolean
  ourPid: number
  ageMs: number
  staleMs?: number
}): LockVerdict {
  const { held, holderAlive, ourPid, ageMs, staleMs = SLOT_LOCK_STALE_MS } = args

  // No parseable holder: an unparseable row must not deadlock the scheduler forever.
  if (held === null) return { action: 'take-over' }
  // Our own row, from an earlier stage or a crashed sibling in this process.
  if (held.pid === ourPid) return { action: 'take-over' }
  // The holder's process is gone — a crash or a kill -9 left the row behind.
  if (!holderAlive) return { action: 'take-over' }

  /**
   * ALIVE. Never take over, however old the lock is.
   *
   * This used to be `alive && ageMs < staleMs`, so age overruled liveness and a second
   * slot started alongside a hung-but-running first one. Two live runs share the OS
   * clipboard, and `sendDm` pastes from it — an interleaved copy and paste puts message
   * A into thread B. The per-attempt READY→SENDING claim stops the SAME message going
   * twice; nothing stops two DIFFERENT messages racing through one clipboard.
   *
   * Stated plainly: a wedged slot now blocks later slots instead of being stepped over.
   * Nothing sends, rather than something sends twice — and `stalled` makes it an alarm
   * rather than a silence.
   */
  return { action: 'decline', stalled: ageMs >= staleMs }
}

/**
 * The exact value of the slot-lock row THIS process last wrote, or null when it holds none.
 *
 * Release is conditioned on it (below), and the refresh moves it forward — so the two can
 * never disagree. The first version of the conditional release compared against the value
 * written at ACQUISITION, while this refresh rewrites the row at every stage boundary: the
 * delete matched nothing and every slot would have left its lock behind, blocking the
 * dashboard's Sync now and `pnpm run:slot` until the row went stale. Found by reading the
 * diff, before it shipped.
 */
let slotLockValue: string | null = null

/**
 * Refresh the lock's timestamp — "still going".
 *
 * Conditional on the row still being the one WE wrote, so a slot that lost the lock cannot
 * stamp over whoever holds it now. Silent on failure: this is a liveness signal, and failing
 * to write one must never take down the slot it is reporting on.
 *
 * Exported for tests only; the slot calls it at each stage boundary.
 */
export async function touchSlotLock(slot: string): Promise<void> {
  const ours = slotLockValue
  if (ours === null) return
  const next = JSON.stringify({ pid: process.pid, slot, at: new Date().toISOString() })
  const r = await prisma.setting
    .updateMany({ where: { key: SLOT_LOCK_KEY, value: ours }, data: { value: next } })
    .catch(() => null)
  if (r !== null && r.count === 1) slotLockValue = next
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
 * `startScheduler` does.
 */
async function acquireSlotLock(slot: string): Promise<string | null> {
  const value = JSON.stringify({ pid: process.pid, slot, at: new Date().toISOString() })

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

  let held: { pid: number; slot: string; at: string } | null = null
  try {
    held = JSON.parse(row.value) as { pid: number; slot: string; at: string }
  } catch {
    held = null // unparseable: treat as dead rather than deadlocking forever
  }

  const alive =
    held !== null &&
    (() => {
      try {
        process.kill(held!.pid, 0)
        return true
      } catch {
        return false
      }
    })()
  const ageMs = held ? Date.now() - new Date(held.at).getTime() : Infinity

  const verdict = decideSlotLock({ held, holderAlive: alive, ourPid: process.pid, ageMs })
  if (verdict.action === 'decline') {
    const detail = {
      otherPid: held?.pid,
      otherSlot: held?.slot,
      secondsSinceProgress: Math.round(ageMs / 1000),
    }
    if (verdict.stalled) {
      log.alarm('a slot is running but has made no progress for a long time — nothing else can start', detail)
    } else {
      log.warn('another slot is already running — declining to start a second', detail)
    }
    return null
  }

  /**
   * The holder is dead, stale, or us. Take over — but conditionally on the row still
   * holding exactly the value we just read, so two processes both finding the same
   * corpse cannot both claim it.
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
   * Three reasons we reach here, and they printed as one.
   *
   * `if (held)` covers the case where the row is our OWN pid, so this reported a live
   * process — the one running this very line — as "a process that is gone". Found while
   * verifying Phase 5 against the identical line in the send lock: `deadPid=<us>`, sending
   * anyone debugging a wedged slot after a crash that never happened.
   */
  if (held === null) {
    log.step('the slot lock held an unreadable value — replacing it')
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
  const ours = slotLockValue
  slotLockValue = null
  if (ours === null) return
  await prisma.setting.deleteMany({ where: { key: SLOT_LOCK_KEY, value: ours } }).catch(() => undefined)
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
 */
export async function withSlotLock<T>(label: string, fn: () => Promise<T>): Promise<T | null> {
  if (slotLockHeldHere) {
    log.step('a slot is already running in this process — skipping this run', { label })
    return null
  }
  const ours = await acquireSlotLock(label)
  if (ours === null) return null
  slotLockValue = ours
  slotLockHeldHere = true
  try {
    return await fn()
  } finally {
    slotLockHeldHere = false
    await releaseSlotLock()
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
  const ours = await acquireSlotLock(slot)
  if (ours === null) {
    return { runId: '', status: 'FAILED', postsSeen: 0, newPosts: 0, detected: 0, queued: 0, sent: 0 }
  }

  slotLockValue = ours
  slotLockHeldHere = true
  try {
    return await runSlotLocked(slot, started)
  } finally {
    slotLockHeldHere = false
    await releaseSlotLock()
  }
}

/** The slot itself. Only ever called with the lock held. */
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
   */
  const progress = () => touchSlotLock(slot)

  // ── 1. Detection ───────────────────────────────────────────────────────────
  await progress()
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
  await progress()
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
  await progress()
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

  // ── 4. Decide and prepare ─────────────────────────────────────────────────
  await progress()
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
