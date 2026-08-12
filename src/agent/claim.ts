import { prisma } from '@/lib/db'
import { log } from '@/lib/logger'
import { hostname } from 'node:os'

/**
 * CLAIMING WORK FOR THIS DEVICE — the atomic half of the agent.
 *
 * ── WHY THIS EXISTS SEPARATELY FROM THE DISPATCHER ──────────────────────────
 *
 * The server writes drafts and cannot send them: the Chrome profiles carrying device
 * identity live on a user's own machine, and copying them to a datacenter is the cookie
 * transplant this whole design refuses. So a draft the server marks as wanted has to be
 * picked up by a device, and "picked up" has to be exactly once.
 *
 * ── A CHECK AND A WRITE IN TWO STATEMENTS IS NOT A GUARD ────────────────────
 *
 * This codebase has made that mistake twice in one day, both found by running rather than
 * reading: `sendNow` read the status and then wrote SENDING under a comment asserting a
 * double click could not double-send (it could), and the first slot lock did
 * `findUnique` then `upsert` and let two concurrent slots run.
 *
 * So the claim is `updateMany` with the status IN THE WHERE CLAUSE, and the returned
 * count is the answer. `create` on a primary key and `updateMany` on a status are the
 * two atomic test-and-sets available here; a count-then-compare is passed by two callers
 * simultaneously, every time.
 *
 * With several devices this matters more than it did with one process: two agents polling
 * the same database is the ORDINARY case now, not a race someone has to provoke.
 */

/**
 * Identifies the machine that claimed an attempt.
 *
 * Recorded so that "which device is sending this?" is answerable, and so a draft stuck in
 * SENDING names the machine to go and look at. `hostname()` is not unique in principle
 * and is the honest best available — the alternative is a generated id nobody can map
 * back to a physical laptop, which is worse for the operator question this answers.
 */
export function deviceId(): string {
  return process.env.DS_DEVICE_NAME ?? hostname()
}

export interface ClaimedAttempt {
  id: string
  senderHandle: string
  targetHandle: string
  renderedBody: string
}

/**
 * Take exactly one waiting attempt for one of the accounts THIS device holds a profile
 * for, or return null.
 *
 * `senderHandles` is what the caller found on disk. A device must never claim work for an
 * account whose profile it does not have: it would move the attempt to SENDING, fail to
 * find a session, and return it to READY — burning an attempt counter and, worse, making
 * the dashboard show a send in progress on a machine that cannot perform it.
 *
 * ONE at a time, deliberately. The device runs the same `withSendLock` as everything else
 * (one clipboard, one send), so claiming a batch would only queue work behind a lock while
 * holding rows in SENDING — which is the state that looks like a stuck send.
 */
export async function claimOneForDevice(senderHandles: readonly string[]): Promise<ClaimedAttempt | null> {
  if (senderHandles.length === 0) return null

  /**
   * Oldest first. The queue is FIFO because a draft's hook line is age-bounded
   * (`HOOK_MAX_AGE_HOURS`) and the oldest waiting message is the one closest to going
   * stale — not because fairness is a virtue in itself.
   */
  const candidate = await prisma.outreachAttempt.findFirst({
    where: { status: 'READY', senderHandle: { in: [...senderHandles] } },
    orderBy: { queuedAt: 'asc' },
    select: { id: true, senderHandle: true, targetHandle: true, renderedBody: true },
  })
  if (!candidate) return null

  /**
   * THE ATOMIC CLAIM. `status: 'READY'` in the WHERE is the whole guard: two devices
   * reaching this line with the same candidate produce one count of 1 and one count of 0,
   * and the loser simply looks again. Nothing is retried, nothing is queued behind a
   * mutex, and no message can be claimed twice.
   */
  const claimed = await prisma.outreachAttempt.updateMany({
    where: { id: candidate.id, status: 'READY' },
    data: { status: 'SENDING', sentBy: `device:${deviceId()}` },
  })

  if (claimed.count === 0) {
    // Another device took it between the read and the write. Not an error — this is the
    // guard working, and saying so keeps it from being read as a failure in the log.
    log.step('another device claimed that one first', { attemptId: candidate.id })
    return null
  }

  return candidate
}

/**
 * Put an attempt back exactly as it was, when the device decides not to send it after all.
 *
 * Used when the LOCAL gate refuses — the server's verdict was computed when the draft was
 * written and can be minutes or days old, so the device asks again and may disagree. That
 * is the point of asking: a hold must leave no trace beyond the log line, because the
 * message is still perfectly good and its Send button must still work.
 *
 * `status: 'SENDING'` in the where clause again, so this cannot resurrect an attempt that
 * something else has already moved to SENT.
 */
export async function releaseClaim(attemptId: string, why: string): Promise<void> {
  const released = await prisma.outreachAttempt.updateMany({
    where: { id: attemptId, status: 'SENDING' },
    data: { status: 'READY', sentBy: null },
  })
  if (released.count > 0) log.step('held, not sent', { attemptId, why })
}
