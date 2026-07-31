import { prisma } from '@/lib/db'
import { env } from '@/lib/env'
import { log } from '@/lib/logger'
import { writeRecord } from '@/lib/json'
import { istStamp } from '@/lib/time'
import { runDetection } from '@/detection/pipeline'
import { runOutreach } from '@/outreach/plan'
import { deliverWaiting } from '@/outreach/deliver'

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
/** A slot that has not finished in this long is presumed dead, not running. */
const SLOT_LOCK_STALE_MS = 30 * 60_000

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
async function acquireSlotLock(slot: string): Promise<boolean> {
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
    return true
  } catch {
    // A row exists. Whether it represents a live slot is a separate question.
  }

  const row = await prisma.setting.findUnique({ where: { key: SLOT_LOCK_KEY } })
  if (!row) {
    // Vanished between the create and the read — the holder just finished. Try once more.
    try {
      await prisma.setting.create({ data: { key: SLOT_LOCK_KEY, value } })
      return true
    } catch {
      return false
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

  if (held && alive && held.pid !== process.pid && ageMs < SLOT_LOCK_STALE_MS) {
    log.warn('another slot is already running — declining to start a second', {
      otherPid: held.pid,
      otherSlot: held.slot,
      ageSeconds: Math.round(ageMs / 1000),
    })
    return false
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
    return false
  }
  if (held) {
    log.step('taking over a slot lock left by a process that is gone', {
      deadPid: held.pid,
      ageSeconds: Math.round(ageMs / 1000),
    })
  }
  return true
}

async function releaseSlotLock(): Promise<void> {
  await prisma.setting.deleteMany({ where: { key: SLOT_LOCK_KEY } }).catch(() => undefined)
}

export async function runSlot(slot: string): Promise<SlotResult> {
  const started = Date.now()
  log.info(`▶ slot ${slot} starting`, { at: istStamp(), dryRun: env.DRY_RUN })

  if (!(await acquireSlotLock(slot))) {
    return { runId: '', status: 'FAILED', postsSeen: 0, newPosts: 0, detected: 0, queued: 0, sent: 0 }
  }

  try {
    return await runSlotLocked(slot, started)
  } finally {
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

  // ── 1. Detection ───────────────────────────────────────────────────────────
  try {
    const d = await runDetection()
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

  // ── 2. Deliver what is already waiting ────────────────────────────────────
  //
  // Before planning, not after. Delivering is the point of a slot; drafting is
  // preparation for the next one. This step exists because without it autopilot
  // could only ever send a message it had just created — a draft prepared while
  // autopilot was off stayed waiting forever, since the governor correctly refuses
  // to stack a second unsent message on the same pair.
  try {
    const d = await deliverWaiting()
    sent += d.sent
    detail.delivered = d.outcomes
    if (d.failed > 0) {
      status = status === 'OK' ? 'PARTIAL' : status
      errors.push(`${d.failed} delivery failure(s)`)
    }
  } catch (err) {
    status = 'PARTIAL'
    const message = err instanceof Error ? err.message : String(err)
    errors.push(`delivery: ${message}`)
    log.alarm('delivery stage threw — waiting messages remain waiting', { error: message })
  }

  // ── 3. Decide and prepare ─────────────────────────────────────────────────
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
