import { prisma } from '@/lib/db'
import { log } from '@/lib/logger'
import { DELIVERED_STATUSES } from '@/lib/constants'
import { fleetRingOrder, nextSender } from './rotation'
import { readSenderAvailability } from './availability'
import { ensureFleetPairs } from './plan'
import { discardAttempt } from './discard'

/**
 * WHEN A SENDER LEAVES THE ROTATION, ITS QUEUE DOES NOT LEAVE WITH IT.
 *
 * Tabish, 2026-08-19: *"when a sender is deleted the queue must not get hampered —
 * their messages must be transferred to another sender which can send it accordingly,
 * in the round rotating format."*
 *
 * Every waiting draft is the same standard template (2026-08-18), which is what makes a
 * transfer safe at all: the body carries nothing about the account that would have sent
 * it, so moving a draft between senders changes WHO speaks and not WHAT is said. Each
 * draft's new sender is chosen by `nextSender` on the fleet ring MINUS the leaving
 * account — the same rule, the same hash spread for never-messaged recipients — so the
 * hand-off is the rotation working, not a special case beside it.
 *
 * ── WHAT MOVES, WHAT STAYS, WHAT GOES ──────────────────────────────────────
 *
 *   READY / QUEUED drafts        → transferred to the rotation's choice, attempts reset
 *   FAILED, code ≠ not-in-thread → transferred and re-queued: the failure belonged to a
 *                                  drive from the OLD account, and the retry cap starts
 *                                  over for the new one (still bounded at 3)
 *   FAILED, code = not-in-thread → STAYS ON THE LEAVING ACCOUNT, untouched. The
 *                                  recipient may already HAVE that message, and it must
 *                                  go through the two-button human flow under the
 *                                  account that actually sent it
 *   a target already covered     → the duplicate is DISCARDED (audited), because two
 *                                  waiting drafts to one recipient is the 2026-08-17
 *                                  incident queued up on purpose
 *   a retired target             → discarded — retirement outranks every transfer
 *
 * Touch numbers are recomputed for the RECEIVING pair: what the new account has
 * delivered to this recipient is the only history that means anything in its thread.
 * Delivered history is never touched — that is the removal rule that predates this file.
 */

export interface HandOffSummary {
  transferred: number
  discarded: number
  /** Drafts that could not move (no other fleet sender usable) and stayed put. */
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
  const out: HandOffSummary = { transferred: 0, discarded: 0, kept: 0, details: [] }

  const fleet = await prisma.senderAccount.findMany({
    where: { fleetMember: true, id: { not: senderId } },
    select: { id: true, handle: true, cohort: true },
  })
  const ring = fleetRingOrder(fleet)

  /**
   * Pairs must exist before drafts can move onto them. `ensureFleetPairs` is the ONE
   * permitted creator for fleet routes (routes.ts rules applied, watch-only and retired
   * targets excluded) — this file deliberately creates no pair row of its own.
   */
  if (ring.length > 0) await ensureFleetPairs()

  const unavailable = await readSenderAvailability()

  const moving = await prisma.outreachAttempt.findMany({
    where: {
      senderId,
      OR: [
        { status: { in: ['READY', 'QUEUED'] } },
        { status: 'FAILED', failureCode: { not: 'not-in-thread' } },
      ],
    },
    include: { pair: { include: { target: true } } },
    orderBy: { queuedAt: 'asc' },
  })
  if (moving.length === 0) return out

  /**
   * Recipients that already hold a waiting draft from some OTHER account. Seeded once,
   * then maintained as drafts transfer, so the second of two drafts to one recipient —
   * including a parked retry behind a fresh draft to the same company — is caught
   * whichever order the loop meets them in.
   */
  const covered = new Set(
    (
      await prisma.outreachAttempt.findMany({
        where: { status: { in: ['READY', 'QUEUED'] }, senderId: { not: senderId } },
        select: { targetId: true },
      })
    ).map((a) => a.targetId),
  )

  /**
   * Discards go through `discardAttempt` — the ONE writer that turns a draft into
   * SKIPPED, with the status guard inside the update. A second inline writer here is
   * exactly the drift its docblock warns about.
   */
  const discard = async (attemptId: string, targetHandle: string, reason: string) => {
    const r = await discardAttempt({ attemptId, reason: `hand-off from @${senderHandle}: ${reason}`, actor })
    if (r.ok) {
      out.discarded += 1
      out.details.push(`@${targetHandle}: discarded — ${reason}`)
    } else {
      out.kept += 1
      out.details.push(`@${targetHandle}: kept — ${r.message}`)
    }
  }

  for (const attempt of moving) {
    const target = attempt.pair.target

    if (target.optedOut) {
      await discard(attempt.id, target.handle, 'the recipient is retired')
      continue
    }
    if (covered.has(target.id)) {
      await discard(attempt.id, target.handle, 'another account already has a draft waiting for this recipient')
      continue
    }
    if (ring.length === 0) {
      out.kept += 1
      out.details.push(`@${target.handle}: kept — no other account in the rotation to take it`)
      continue
    }

    const lastDelivered = await prisma.outreachAttempt.findFirst({
      where: { targetId: target.id, status: { in: [...DELIVERED_STATUSES] } },
      orderBy: { sentAt: 'desc' },
      select: { senderId: true },
    })

    /**
     * The rotation's own choice, twice if needed: first among accounts that can send
     * RIGHT NOW, then among the whole remaining ring. The second ask exists because
     * "signed out this afternoon" must not decide where a draft lives — a draft on a
     * signed-out account waits honestly (the gate says why), which beats both dropping
     * it and piling every orphan onto whichever account happens to be logged in.
     */
    const choice = (() => {
      const strict = nextSender({
        ring,
        lastSenderId: lastDelivered?.senderId ?? null,
        unavailable,
        targetId: target.id,
      })
      if (strict.ok) return strict
      return nextSender({ ring, lastSenderId: lastDelivered?.senderId ?? null, targetId: target.id })
    })()

    if (!choice.ok) {
      out.kept += 1
      out.details.push(`@${target.handle}: kept — ${choice.detail}`)
      continue
    }

    const newPair = await prisma.outreachPair.findFirst({
      where: { senderId: choice.senderId, targetId: target.id },
      select: { id: true },
    })
    if (!newPair) {
      // ensureFleetPairs declined this route (routes.ts said no). Not overridden here.
      out.kept += 1
      out.details.push(`@${target.handle}: kept — no route exists from @${choice.handle}`)
      continue
    }

    const deliveredOnNewPair = await prisma.outreachAttempt.count({
      where: { pairId: newPair.id, status: { in: [...DELIVERED_STATUSES] } },
    })

    await prisma.$transaction([
      prisma.outreachAttempt.update({
        where: { id: attempt.id },
        data: {
          pairId: newPair.id,
          senderId: choice.senderId,
          touchNumber: deliveredOnNewPair + 1,
          status: 'READY',
          attempts: 0,
          error: null,
          failureCode: null,
        },
      }),
      prisma.auditLog.create({
        data: {
          actor,
          action: 'attempt.transferred.handoff',
          entity: `OutreachAttempt:${attempt.id}`,
          detail: `@${target.handle}: @${senderHandle} → @${choice.handle} (rotation's choice)`,
        },
      }),
    ])
    covered.add(target.id)
    out.transferred += 1
    out.details.push(`@${target.handle}: now with @${choice.handle}`)
  }

  log.info('queue handed off', {
    from: senderHandle,
    transferred: out.transferred,
    discarded: out.discarded,
    kept: out.kept,
  })
  return out
}
