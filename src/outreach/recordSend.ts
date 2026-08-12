import { prisma } from '@/lib/db'
import { log } from '@/lib/logger'

/**
 * Recording that a DM was DELIVERED — the one write in this system that must not fail.
 *
 * THE BUG THIS EXISTS TO REMOVE.
 *
 * All five send paths recorded SENT like this:
 *
 *     await prisma.$transaction([
 *       outreachAttempt.update({ status: 'SENT', ... }),   // the irreplaceable fact
 *       messageVariant.update({ timesUsed: +1 }),          // a rotation statistic
 *       auditLog.create({ ... }),                          // a log line
 *     ])
 *
 * A transaction is all-or-nothing, so the two disposable writes could roll back the one
 * that matters. Measured: the database was in `journal_mode = delete` with a 5-second
 * busy timeout and three processes sharing the file, so `SQLITE_BUSY` was reachable. The
 * result of that rollback is the worst outcome this project has: **the recipient has the
 * message and our records say we never sent it** — so the next slot writes to them again,
 * every guard derived from send history (spacing, the unanswered-touch cap, the
 * new-material rule, the daily caps) is computed from a lie, and nothing anywhere reports
 * a problem.
 *
 * The fix is ordering, not retrying:
 *
 *   1. Commit the SENT row ALONE. Nothing else can take it down with it.
 *   2. Then the bookkeeping, best effort. A lost variant bump costs a slightly wrong
 *      rotation order. A lost audit line costs a log entry. Neither is worth a
 *      double-DM to a real person.
 *
 * Step 1 is retried, briefly, because at that moment the message is ALREADY DELIVERED and
 * there is no safe way to abandon the record. If every retry fails the attempt is left in
 * whatever status it had — never READY, which is the status the delivery loop picks up —
 * and an alarm carries everything needed to reconcile by hand.
 */

/** Retry only the SENT write, and only for lock contention. */
const RECORD_RETRIES = 4
const RECORD_BACKOFF_MS = [250, 1000, 3000, 7000]

export interface DeliveredRecord {
  attemptId: string
  variantId: string
  /** `autopilot:<handle>` | `operator:<handle>` | `override(...):<handle>` | `cli:<name>` | an email. */
  sentBy: string
  threadUrl?: string | null
  audit?: { actor: string; action: string; entity: string; detail: string }
}

export async function recordDelivered(rec: DeliveredRecord): Promise<void> {
  const sentAt = new Date()

  // ── 1. The fact. Alone, retried, and never conditional on anything else. ──
  let lastError: unknown = null
  for (let attempt = 0; attempt <= RECORD_RETRIES; attempt++) {
    try {
      await prisma.outreachAttempt.update({
        where: { id: rec.attemptId },
        data: {
          status: 'SENT',
          sentAt,
          sentBy: rec.sentBy,
          threadUrl: rec.threadUrl ?? null,
          error: null,
          failureCode: null,
        },
      })
      lastError = null
      break
    } catch (e) {
      lastError = e
      if (attempt === RECORD_RETRIES) break
      const wait = RECORD_BACKOFF_MS[attempt] ?? 7000
      log.warn('could not record a delivered message yet — retrying', {
        attemptId: rec.attemptId,
        try: attempt + 1,
        waitMs: wait,
        error: e instanceof Error ? e.message : String(e),
      })
      await new Promise((r) => setTimeout(r, wait))
    }
  }

  if (lastError !== null) {
    /**
     * The DM is out and we cannot say so in the database. Leave the row where it is —
     * it will be SENDING, which no automatic path picks up — and shout. Setting READY
     * here would hand it straight back to the next slot to send a second time.
     */
    log.alarm('DELIVERED BUT NOT RECORDED — reconcile by hand before the next slot', {
      attemptId: rec.attemptId,
      sentBy: rec.sentBy,
      threadUrl: rec.threadUrl ?? null,
      error: lastError instanceof Error ? lastError.message : String(lastError),
    })
    throw lastError
  }

  // ── 2. Bookkeeping. Never allowed to undo step 1. ──
  try {
    await prisma.messageVariant.update({
      where: { id: rec.variantId },
      data: { timesUsed: { increment: 1 }, lastUsedAt: sentAt },
    })
  } catch (e) {
    log.warn('variant usage counter not bumped — rotation order may be slightly off', {
      variantId: rec.variantId,
      error: e instanceof Error ? e.message : String(e),
    })
  }

  if (rec.audit) {
    try {
      await prisma.auditLog.create({ data: rec.audit })
    } catch (e) {
      log.warn('audit row not written for a delivered message', {
        attemptId: rec.attemptId,
        error: e instanceof Error ? e.message : String(e),
      })
    }
  }
}
