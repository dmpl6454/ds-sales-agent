import { prisma } from '@/lib/db'
import { log } from '@/lib/logger'

/**
 * Marking an account as flagged by Instagram. ONE writer, four callers.
 *
 * ── WHY THIS IS A FUNCTION AND NOT FOUR `update` CALLS ────────────────────
 *
 * Four code paths set `status: 'CHALLENGED'` — the planner, autopilot delivery, the
 * dashboard's Send button, and the reply reader. Phase 5 adds a second field that MUST be
 * written at the same moment (`challengedAt`, which the fleet circuit breaker reads), and
 * a fifth path added later would set the status and not the timestamp.
 *
 * That failure would be silent and would fail in the PERMISSIVE direction: the breaker
 * counts accounts flagged recently, so a missing timestamp reads as "nothing was flagged"
 * and the fleet keeps sending straight through a checkpoint. This project has the same
 * shape on record twice already — `repliedAt` read in six places and written in none, and
 * the daily caps counting `'SENT'` alone in three places after being fixed in a fourth.
 * The fix both times was one definition instead of several copies.
 *
 * ── WHAT IT DELIBERATELY DOES NOT DO ─────────────────────────────────────
 *
 * It does not retry, back off, or re-arm anything. A checkpoint is a stop. It also does
 * not touch `autoSendEnabled`: coming back from a halt and returning to unattended
 * sending are two separate decisions, and `clearChallenge` only makes the first.
 */
export async function markChallenged(args: {
  senderId: string
  /** For the log and the audit trail. */
  handle: string
  /** What Instagram showed us, in prose. */
  detail: string
  /** Who noticed: 'autopilot' | 'worker' | 'reply-check' | an operator's email. */
  actor: string
  now?: Date
}): Promise<void> {
  const at = args.now ?? new Date()

  await prisma.senderAccount.update({
    where: { id: args.senderId },
    data: { status: 'CHALLENGED', challengedAt: at },
  })

  await prisma.auditLog
    .create({
      data: {
        actor: args.actor,
        action: 'sender.challenged',
        entity: `SenderAccount:${args.handle}`,
        detail: args.detail.slice(0, 500),
      },
    })
    .catch((e) => log.warn('challenge audit row not written', { handle: args.handle, error: String(e) }))

  log.alarm('Instagram checkpoint — this account is halted and nothing will be retried', {
    sender: args.handle,
    noticedBy: args.actor,
  })
}

/**
 * Clear the halt. A human has looked at the account.
 *
 * `challengedAt` is nulled as well as the status, and that is what releases the fleet
 * breaker immediately rather than making everyone wait out the window. It is the same
 * atomic write, so there is no moment where the account is ACTIVE and still counted.
 */
export async function clearChallenged(senderId: string): Promise<void> {
  await prisma.senderAccount.update({
    where: { id: senderId },
    data: { status: 'ACTIVE', challengedAt: null },
  })
}
