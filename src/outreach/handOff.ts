import { prisma } from '@/lib/db'
import { log } from '@/lib/logger'
import { fleetRingFor } from './categories'
import { ensureFleetPairs } from './plan'
import { discardAttempt } from './discard'

/**
 * WHEN A SENDER LEAVES THE ROTATION, ITS QUEUE IS RELEASED — NEVER RE-POINTED.
 *
 * Tabish, 2026-08-19: *"when a sender is deleted the queue must not get hampered —
 * their messages must be transferred to another sender which can send it accordingly,
 * in the round rotating format."*
 *
 * ── WHY THIS NO LONGER MOVES A DRAFT (2026-10-09) ─────────────────────────
 *
 * Until now every waiting draft was re-pointed — `pairId`, `senderId` and `touchNumber`
 * rewritten onto the account rotation would choose — on the premise that *"every waiting
 * draft is the same standard template, so moving it changes WHO speaks and not WHAT is
 * said"*. That premise stopped being true three times over and nothing here noticed:
 * follow-ups carry their own copy citing a post (1 Sept), each fleet has its own message
 * (25-26 Aug), and whether a message is an introduction depends on the RECEIVING page's
 * history and on whether the recipient has ever replied (`isFollowUp`, 4 Sept).
 *
 * REPRODUCED at the base commit, against the real gate expressions:
 *
 *   - a FOLLOW-UP moved to a page that had never written to the recipient was renumbered
 *     touch 1 — so the gate read it as a first touch, skipped every follow-up rule, and
 *     `deliver.ts` skipped the pre-send thread read. The follow-up went out as that page's
 *     FIRST message;
 *   - a FIRST TOUCH moved to a page that had already written was renumbered touch 2 with
 *     the introduction's bytes, held forever as `identical-to-a-message-they-already-have`,
 *     and — because the planner's pending check is per pair — nothing replaced it. The
 *     recipient stalled. The old test in this file pinned that outcome as correct;
 *   - the election was this file's own, not the planner's: it skipped blocked routes
 *     (`readBlockedRoutes` — parked pairs, pair-scoped reply halts) and ignored a group
 *     ring's `CategorySender.position`, so a draft could land on a route rotation would
 *     never elect, and the planner then wrote the elected page a SECOND draft;
 *   - the re-point had no status condition, so a row the dispatcher claimed SENDING after
 *     this read the queue was rewritten to READY under another page mid-paste;
 *   - a `profile-gone` park was in the movable set, and moving it erased the recipient's
 *     7-day TARGET_UNREACHABLE stop;
 *   - a moved draft kept the leaving account's `variantId`, and `OutreachAttempt.variant`
 *     is ON DELETE RESTRICT — so deleting a never-delivered sender after a hand-off threw.
 *
 * Every one of those is a second planner living inside a removal action and drifting from
 * the first. So the hand-off no longer elects and no longer composes: it RELEASES each
 * waiting draft through `discardAttempt` (the one writer, status guard inside the update),
 * which frees its post claim (SKIPPED is not in IN_FLIGHT_STATUSES) and leaves no pending
 * draft on any fleet pair. The planner — the one elector and the one composer — then writes
 * the correct message for whichever page `whoseTurn` elects, on its next pass: drafting
 * runs on the 15-minute detect clock whatever Autopilot says. Tabish's rule is kept as
 * "nothing is lost, each recipient is written to within fifteen minutes by the next page",
 * not as "the same bytes move". An attempt's route, bytes and variant are fixed when the
 * planner writes it for that route, and never change afterwards
 * (`tests/attempt-route-immutable.test.ts`).
 *
 * ── WHAT IS RELEASED, WHAT STAYS, WHAT GOES ────────────────────────────────
 *
 *   READY / QUEUED drafts          → released (SKIPPED, audited); the planner re-writes
 *   FAILED, any other code         → released — the failure belonged to a drive from the
 *                                    leaving account, and the next page starts clean
 *   FAILED, code = not-in-thread   → STAYS ON THE LEAVING ACCOUNT, untouched. The
 *                                    recipient may already HAVE that message
 *   FAILED, code = profile-gone    → STAYS, untouched. It is the recipient-scoped 7-day
 *                                    stop (`parkedRows.ts`); a SKIPPED row is not read by it
 *   a recipient already covered    → discarded: another page holds a draft for them, or is
 *                                    sending one right now (SENDING counts)
 *   a retired recipient            → discarded — retirement outranks everything
 *   no other page in their fleet   → KEPT on the leaving account and said so; releasing it
 *                                    would leave nobody to write, and re-adding the page
 *                                    finds it where it was
 *
 * Delivered history is never touched — that is the removal rule that predates this file.
 */

export interface HandOffSummary {
  /** Released for the planner to re-write from whichever page rotation elects next. */
  released: number
  /** Discarded because the recipient is retired or another page already covers them. */
  discarded: number
  /** Left on the leaving account: no other page sends for their fleet, or it is mid-send. */
  kept: number
  details: string[]
}

export async function handOffWaitingDrafts(args: {
  senderId: string
  senderHandle: string
  /** `AuditLog.actor` — a signed-in email from the dashboard, `cli:<name>` from a terminal. */
  actor: string
}): Promise<HandOffSummary> {
  const { senderId, senderHandle, actor } = args
  const out: HandOffSummary = { released: 0, discarded: 0, kept: 0, details: [] }

  const otherFleet = await prisma.senderAccount.count({
    where: { fleetMember: true, id: { not: senderId } },
  })

  /**
   * The ring below is built from the pair rows that EXIST, so the routes the planner will
   * create must exist before it is asked — otherwise a page with every right to write to a
   * recipient would count as no page, and that draft would be kept on an account that just
   * left. `ensureFleetPairs` is the ONE permitted creator for fleet routes; this file
   * creates no pair row of its own.
   */
  if (otherFleet > 0) await ensureFleetPairs()

  const releasable = await prisma.outreachAttempt.findMany({
    where: {
      senderId,
      OR: [
        { status: { in: ['READY', 'QUEUED'] } },
        /* not-in-thread: they may have it. profile-gone: the recipient's own 7-day stop. */
        { status: 'FAILED', failureCode: { notIn: ['not-in-thread', 'profile-gone'] } },
      ],
    },
    include: { pair: { include: { target: true } } },
    orderBy: { queuedAt: 'asc' },
  })
  if (releasable.length === 0) return out

  /**
   * Recipients another page already holds a draft for — or is SENDING to right now. SENDING
   * is in the planner's own pending set (`hasPendingAttempt`); leaving it out here let a
   * draft land beside a send in flight, which then delivered the identical template.
   */
  const covered = new Set(
    (
      await prisma.outreachAttempt.findMany({
        where: { status: { in: ['READY', 'QUEUED', 'SENDING'] }, senderId: { not: senderId } },
        select: { targetId: true },
      })
    ).map((a) => a.targetId),
  )
  /* A second leaving draft to a recipient already released is a duplicate, not a release. */
  const releasedTargets = new Set<string>()

  /**
   * Every write goes through `discardAttempt` — the ONE writer that turns a draft into
   * SKIPPED, with the status guard inside the update. A draft the dispatcher claimed
   * SENDING after the read above is refused there and stays where it is, so its delivery is
   * recorded on the pair that actually drove it.
   */
  const drop = async (
    attemptId: string,
    targetHandle: string,
    reason: string,
    bucket: 'released' | 'discarded',
  ): Promise<boolean> => {
    const r = await discardAttempt({ attemptId, reason: `hand-off from @${senderHandle}: ${reason}`, actor })
    if (r.ok) {
      out[bucket] += 1
      out.details.push(`@${targetHandle}: ${bucket} — ${reason}`)
      return true
    }
    out.kept += 1
    out.details.push(`@${targetHandle}: kept — ${r.message}`)
    return false
  }

  for (const attempt of releasable) {
    const target = attempt.pair.target

    if (target.optedOut) {
      await drop(attempt.id, target.handle, 'the recipient is retired', 'discarded')
      continue
    }
    if (covered.has(target.id)) {
      await drop(
        attempt.id,
        target.handle,
        'another account already has a message waiting for or being sent to them',
        'discarded',
      )
      continue
    }
    if (releasedTargets.has(target.id)) {
      await drop(attempt.id, target.handle, 'a second draft to them, released with the first', 'discarded')
      continue
    }

    /**
     * THE PLANNER'S OWN RING for this recipient, minus the leaving page: pair-based,
     * `fleetMember`-filtered and fleet-matched (`ringMembersFor`), so a page with no route,
     * or a page whose fleet forbids this recipient, counts as no page. The explicit filter
     * covers a caller that has not flipped `fleetMember` yet. This decides only whether
     * ANYONE is left to write; WHO writes is `whoseTurn`'s answer on the next pass.
     */
    const ring = (await fleetRingFor(target.id)).filter((m) => m.senderId !== senderId)
    if (ring.length === 0) {
      out.kept += 1
      out.details.push(`@${target.handle}: kept — no other account in the rotation sends for their fleet`)
      continue
    }

    const ok = await drop(
      attempt.id,
      target.handle,
      "released — rotation's next page writes to them on the next planning pass",
      'released',
    )
    if (ok) releasedTargets.add(target.id)
  }

  log.info('queue handed off', {
    from: senderHandle,
    released: out.released,
    discarded: out.discarded,
    kept: out.kept,
  })
  return out
}
