import { prisma } from '@/lib/db'

/**
 * THE ONE WRITER THAT TURNS A WAITING DRAFT INTO `SKIPPED`.
 *
 * ── WHY IT IS ITS OWN MODULE ──────────────────────────────────────────────
 *
 * The claim-and-audit below lived inside the `skipAttempt` server action, which is
 * unreachable from a terminal: it opens with `requireOperator()` and closes with
 * `revalidatePath`. So the 2026-08-13 duplicate-draft cleanup — 15 rows that had to go
 * through the ordinary discard path *because* each removal must be audited — had nowhere
 * to call.
 *
 * The tempting shortcut is a second `updateMany` in the script. This repo has been bitten
 * FOUR times by one rule with several callers (`gate.ts`, `readThread.ts`, the two Connect
 * buttons, `judge.ts`), and the specific thing that would have drifted here is the STATUS
 * GUARD: `where: { status: { in: ['READY','QUEUED'] } }` inside the update rather than a
 * read-then-write. Without it, discarding a SENT attempt erases the record of a message a
 * real person received — and that record is what spacing, the unanswered-touch cap and the
 * new-material rule are derived from, so the system would then be free to write to someone
 * it had already written to.
 *
 * A discarded draft does NOT burn the campaign pool: `usedCampaignIds` counts
 * `IN_FLIGHT_STATUSES`, and `SKIPPED` is not one of them. That was a real bug once (the
 * since-deleted `pnpm burner off` mass-SKIPped drafts and silently consumed the pool), so
 * it is worth restating rather than rediscovering.
 */

export interface DiscardResult {
  ok: boolean
  /** Prose for whoever asked — a person on the dashboard or a line in a CLI report. */
  message: string
}

export async function discardAttempt(args: {
  attemptId: string
  reason: string
  /** `AuditLog.actor` — a signed-in email from the dashboard, `cli:<name>` from a terminal. */
  actor: string
}): Promise<DiscardResult> {
  /**
   * Conditional `updateMany` rather than read-then-write, for the same reason `sendNow`
   * needed it: a check and a write in two statements is not a guard. Applied to a SENDING
   * attempt it would corrupt the state of a live browser send.
   */
  const claimed = await prisma.outreachAttempt.updateMany({
    /**
     * FAILED joined the discardable set on 2026-08-18, with ONE exclusion that carries
     * the safety: `not-in-thread` means the recipient MAY HAVE the message, and
     * discarding it would erase the only record of a possibly-delivered DM — spacing
     * and the unanswered-touch cap are derived from delivery records, so the system
     * would be free to write again to someone who already heard from us. Those rows
     * have their own two-button resolution on the landing page and must go through it.
     * Every other FAILED row is a message that provably never left the composer.
     */
    where: {
      id: args.attemptId,
      OR: [
        { status: { in: ['READY', 'QUEUED'] } },
        { status: 'FAILED', failureCode: { not: 'not-in-thread' } },
      ],
    },
    data: { status: 'SKIPPED', error: args.reason || 'skipped by operator' },
  })

  if (claimed.count === 0) {
    const now = await prisma.outreachAttempt.findUnique({
      where: { id: args.attemptId },
      select: { status: true },
    })
    return {
      ok: false,
      message:
        now?.status === 'SENDING'
          ? 'That message is being sent right now — too late to discard.'
          : `That message is already ${(now?.status ?? 'gone').toLowerCase()} and cannot be discarded.`,
    }
  }

  await prisma.auditLog.create({
    data: { actor: args.actor, action: 'attempt.skipped', entity: `OutreachAttempt:${args.attemptId}`, detail: args.reason },
  })
  return { ok: true, message: 'Discarded.' }
}
