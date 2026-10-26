import { prisma } from '@/lib/db'
import { discardAttempt } from './discard'

/**
 * DISCARD EVERY WAITING DRAFT ADDRESSED TO A RETIRED RECIPIENT (26 Oct 2026).
 *
 * ── WHAT WAS MEASURED ──────────────────────────────────────────────────────
 *
 * The Mac Studio's watch.log, 19–22 Oct, held ~7,000 lines a day reading *"waiting message held
 * back … reason=this recipient is retired"* — among them a draft to @hemantpandeyji, retired on
 * 9 Sept when its page vanished. `optedOut` is the one promise that survives every feature: the
 * gate refuses such a draft forever (`TARGET_OPTED_OUT`, not overridable), so it can never be
 * sent. A command to remove them existed since 23 Aug (`pnpm ig:discard-retired-drafts`, written
 * after the same measurement on that day) but NOTHING RAN IT — a cleanup that works only when
 * someone runs a command is not running — and no retirement path touched the queue:
 * `ig:retire-target` printed a note pointing at `ig:discard-stale-drafts` (which judges message
 * COPY and never looks at the recipient), and `removeTarget` and `ig:reverify-identity` said
 * nothing at all. So each such draft was re-asked of the gate every 30 seconds for weeks, sat in
 * the queue the screens count, and — a touch-1 draft to a BRAND — took a slot of the fleet-wide
 * waiting depth `readNewBrandTouchCounts` reads.
 *
 * ── TWO CALLERS, ONE RULE ──────────────────────────────────────────────────
 *
 *   every planner pass   the server runs it at the top of each 15-minute pass, whatever
 *                        autopilot says and whichever Mac is selected — the H5 sweep's reason
 *                        (staleIntroductions.ts). It is the cleanup of the backlog AND the net
 *                        for every retirement path, including a dashboard still serving a build
 *                        older than this file (the hosted web tier is rebuilt only from a Mac).
 *   each retirement      `removeTarget`, `ig:retire-target`, `ig:reverify-identity` call it with
 *                        the ids they just retired, so the person who retired a company sees
 *                        the count at once instead of fifteen minutes later. Best effort there:
 *                        the retirement is already written, so a failed sweep is reported and
 *                        left to the planner's next pass, never allowed to hide the retirement.
 *   by hand              `pnpm ig:discard-retired-drafts` is now this function behind a dry run,
 *                        so the rule has one query (it used to read the denormalised
 *                        `attempt.target` and to discard without `onlyWaiting`).
 *
 * ── WHAT IT TOUCHES, AND WHAT IT LEAVES ────────────────────────────────────
 *
 * READY and QUEUED only, through `discardAttempt({ onlyWaiting: true })` — the ONE writer, with
 * its status guard inside the update and an audit row per discard. Never SENDING (a browser is
 * mid-paste, and interrupting the record of a paste is how a message lands unrecorded). Never FAILED: a `not-in-thread`
 * park is the only record that the recipient may HOLD a message, and every other park is a
 * person's to settle and is not re-evaluated by the dispatcher, so it costs nothing to keep.
 * Never a delivered row — send history is the record of what a real person received.
 *
 * A draft a person EDITED or PREPARED is discarded too, unlike the unheld release
 * (unheldRelease.ts) — and that difference is deliberate. That release leaves a person's draft
 * because the account may come back on a Mac and send it; a retired recipient is refused at the
 * gate by a stop no override crosses, so a person's draft to one can never be sent by anyone.
 * The body stays on the SKIPPED row. If the recipient is un-retired (`ig:unretire-target`), the
 * planner writes a fresh draft on its next pass.
 *
 * "Retired" is read exactly as the gate reads it — `pair.target.optedOut` — and read TWICE: once
 * to list the drafts, and again inside each discard's own update (`onlyIfRecipientRetired`), so a
 * recipient un-retired mid-sweep keeps its draft. It discards precisely the drafts the gate
 * refuses as `target-opted-out`, nothing more.
 */
export const RETIRED_RECIPIENT_DISCARD_REASON =
  'this recipient is retired — the gate refuses every message to them, so this draft can never be sent'

export async function discardWaitingDraftsToRetiredRecipients(args: {
  /** `AuditLog.actor` for each discard. */
  actor: string
  /** Narrow to these recipients (a retirement path passing what it just retired). Omit for all. */
  targetIds?: readonly string[]
}): Promise<{ discarded: number; byRecipient: { handle: string; count: number }[] }> {
  if (args.targetIds && args.targetIds.length === 0) return { discarded: 0, byRecipient: [] }

  const waiting = await prisma.outreachAttempt.findMany({
    where: {
      status: { in: ['READY', 'QUEUED'] },
      pair: {
        target: { optedOut: true },
        ...(args.targetIds ? { targetId: { in: [...args.targetIds] } } : {}),
      },
    },
    select: { id: true, pair: { select: { target: { select: { handle: true } } } } },
    orderBy: { queuedAt: 'asc' },
  })

  const counts = new Map<string, number>()
  let discarded = 0
  for (const a of waiting) {
    const r = await discardAttempt({
      attemptId: a.id,
      reason: RETIRED_RECIPIENT_DISCARD_REASON,
      actor: args.actor,
      onlyWaiting: true,
      /* Re-asked INSIDE the update: an `ig:unretire-target` landing mid-sweep keeps its draft. */
      onlyIfRecipientRetired: true,
    })
    if (!r.ok) continue
    discarded++
    const handle = a.pair.target.handle
    counts.set(handle, (counts.get(handle) ?? 0) + 1)
  }
  return {
    discarded,
    byRecipient: [...counts.entries()].map(([handle, count]) => ({ handle, count })),
  }
}
