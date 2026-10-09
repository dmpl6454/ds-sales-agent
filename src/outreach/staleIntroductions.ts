import { prisma } from '@/lib/db'
import { DELIVERED_STATUSES } from '@/lib/constants'
import { isStandardMessageBody, type TemplateSettings } from './fleetTemplate'
import { isIntroductionToSomeoneWhoKnowsUs } from './followUpTemplate'
import { discardAttempt } from './discard'

/**
 * DISCARD EVERY WAITING INTRODUCTION TO A RECIPIENT WHO ALREADY KNOWS US (H5, 2026-10-09).
 *
 * ── WHY A RELEASE IS NEEDED AT ALL ─────────────────────────────────────────
 *
 * The gate refuses these drafts (`RESEND_BLOCKS.INTRODUCTION_TO_SOMEONE_WHO_KNOWS_US`). A
 * refusal alone would STALL the recipient: a refused draft is never replaced while it waits
 * (`hasPendingAttempt`), the turn passes only on a delivery, and so when the page holding it
 * is the elected one, nobody writes to that recipient again — the 26 Aug self-locking shape,
 * on the one recipient who answered us. And there is no Discard control on a waiting draft
 * on `/`, so "a person discards it" would point at nothing. So the planner discards it, and
 * on the same pass the page's turn is free to draft a follow-up that names a post of theirs
 * — or to hold as `no-post-we-can-describe`, which is Tabish's intended cost.
 *
 * ── WHY THE PLANNER AND NOT THE DISPATCHER ─────────────────────────────────
 *
 * The planner runs on the server every 15 minutes whatever autopilot says and whichever Mac
 * is selected, and it is updated by `deploy.sh` rather than by a DMG reinstall. The
 * dispatcher stops at autopilot OFF and runs only on the selected Mac, so a release there
 * would not run in exactly the states where the stall is easiest to fall into. It drives no
 * browser.
 *
 * ── WHAT IT TOUCHES, AND WHAT IT LEAVES ────────────────────────────────────
 *
 * READY and QUEUED only — a FAILED park is a person's to settle, and SENDING is a browser
 * mid-paste. Each discard goes through `discardAttempt`, the ONE writer, whose status guard
 * sits inside the update (a row that moved to SENDING since this read is left alone) and
 * which writes an audit row. The rule is `isIntroductionToSomeoneWhoKnowsUs`, the same one
 * the gate asks, over the same facts the gate reads: dated replies to the RECIPIENT from any
 * page, and deliveries on THIS page's pair. Three queries for the whole queue, never one per
 * draft — one, when nothing waiting carries a standard message at all.
 */
export async function discardIntroductionsToRecipientsWhoKnowUs(args: {
  settings: TemplateSettings
  /** `AuditLog.actor` for each discard. */
  actor: string
}): Promise<{ examined: number; discarded: number }> {
  const waiting = await prisma.outreachAttempt.findMany({
    where: { status: { in: ['READY', 'QUEUED'] } },
    select: { id: true, senderId: true, targetId: true, touchNumber: true, renderedBody: true },
  })
  const introductions = waiting.filter((a) => isStandardMessageBody(a.renderedBody, args.settings))
  if (introductions.length === 0) return { examined: waiting.length, discarded: 0 }

  const targetIds = [...new Set(introductions.map((a) => a.targetId))]
  const senderIds = [...new Set(introductions.map((a) => a.senderId))]
  const [replied, delivered] = await Promise.all([
    /* The gate's own predicate: a DATED reply from this recipient to any of our pages. */
    prisma.outreachAttempt.findMany({
      where: { targetId: { in: targetIds }, replyPostedAt: { not: null } },
      select: { targetId: true },
      distinct: ['targetId'],
    }),
    /* Deliveries on the pairs involved — narrowed to the senders and recipients at hand,
       matched exactly per (sender, recipient) in JS, as the gate scopes `deliveredRows`. */
    prisma.outreachAttempt.findMany({
      where: { senderId: { in: senderIds }, targetId: { in: targetIds }, status: { in: [...DELIVERED_STATUSES] } },
      select: { senderId: true, targetId: true },
      distinct: ['senderId', 'targetId'],
    }),
  ])
  const everReplied = new Set(replied.map((r) => r.targetId))
  const pairDelivered = new Set(delivered.map((d) => `${d.senderId}\u0000${d.targetId}`))

  let discarded = 0
  for (const a of introductions) {
    const stale = isIntroductionToSomeoneWhoKnowsUs({
      storedBodyIsStandardMessage: true,
      storedTouchNumber: a.touchNumber,
      pairHasDelivered: pairDelivered.has(`${a.senderId}\u0000${a.targetId}`),
      targetHasEverReplied: everReplied.has(a.targetId),
    })
    if (!stale) continue
    const r = await discardAttempt({
      attemptId: a.id,
      reason:
        'our introduction to a recipient who already knows us — they have replied to one of our pages, or this page has already written to them; a company that knows us only receives follow-ups',
      actor: args.actor,
    })
    if (r.ok) discarded++
  }
  return { examined: waiting.length, discarded }
}
