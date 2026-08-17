import { nextSender, ringOrder, type RingMember } from './rotation'

/**
 * WHICH OF SEVERAL DRAFTS TO ONE RECIPIENT SURVIVES. PURE.
 *
 * ── WHAT THIS IS CLEANING UP ──────────────────────────────────────────────
 *
 * `whoseTurn` returned null for every recipient there had ever been (see
 * `fleetRingOrder`), so every sender drafted to every recipient. MEASURED on the live
 * database 2026-08-13: 24 waiting drafts across 9 recipients — 7 of them holding one from
 * all three fleet accounts, 1 holding two — with near-identical bodies under one phone
 * number and one email. `MAX_PER_TARGET_PER_DAY` is 2, so the moment a second account is
 * signed in and Autopilot goes on, two of those three reach one inbox on one day.
 *
 * Fixing rotation stops NEW duplicates. It does nothing about the ones already queued, and
 * they are the live exposure.
 *
 * ── WHY THIS IS PURE AND SEPARATE ─────────────────────────────────────────
 *
 * It decides which real drafts get thrown away. That is exactly the kind of rule this
 * codebase keeps pure — `governor.ts`, `gate.ts`, `pacing.ts`, `rotation.ts` — so both
 * directions can be driven without a database.
 *
 * It answers by REUSING `nextSender` rather than re-deriving rotation, on a ring narrowed
 * to the senders that actually hold a draft. Narrowing first is what guarantees the keeper
 * is a draft that exists: asking the full ring could elect an account holding nothing, and
 * "keep the draft rotation would have chosen" would then have no draft to keep.
 */

export interface DraftRef {
  attemptId: string
  senderId: string
  handle: string
  /** Tie-break of last resort, and only that. */
  queuedAt: Date
}

export interface KeepDecision {
  keep: DraftRef
  discard: DraftRef[]
  /** Why this one survived, recorded on every discarded row's audit entry. */
  why: string
}

export function chooseDraftToKeep(input: {
  drafts: readonly DraftRef[]
  ring: readonly RingMember[]
  lastSenderId: string | null
  unavailable?: ReadonlyMap<string, string>
}): KeepDecision | null {
  const drafts = [...input.drafts].sort((a, b) => a.queuedAt.getTime() - b.queuedAt.getTime())
  if (drafts.length === 0) return null
  if (drafts.length === 1) return { keep: drafts[0]!, discard: [], why: 'only one draft' }

  const holders = new Set(drafts.map((d) => d.senderId))
  const narrowed = ringOrder(input.ring).filter((m) => holders.has(m.senderId))

  /**
   * The ordinary answer: rotation's own choice, among the accounts holding a draft.
   */
  const choice = nextSender({
    ring: narrowed,
    lastSenderId: input.lastSenderId,
    unavailable: input.unavailable,
  })
  if (choice.ok) {
    const keep = drafts.find((d) => d.senderId === choice.senderId)!
    return {
      keep,
      discard: drafts.filter((d) => d.attemptId !== keep.attemptId),
      why: `@${keep.handle} is next in the rotation`,
    }
  }

  /**
   * NOBODY CAN WRITE TODAY, AND A DRAFT MUST STILL SURVIVE.
   *
   * `all-unavailable` means every candidate is flagged or signed out. That is a fact about
   * SENDING, and these rows are not being sent — they are waiting, with their refusal shown
   * on /messages. Discarding all of them because none can go out right now would throw away
   * the queue every time the fleet is signed out, which is precisely when the queue is the
   * only record of what was going to be said.
   *
   * So the ring decides again, this time ignoring availability: whoever comes first after
   * the last delivered message keeps their draft. Deterministic, and it becomes the ordinary
   * answer again the moment somebody signs in.
   */
  if (narrowed.length > 0) {
    const start =
      input.lastSenderId === null
        ? 0
        : (narrowed.findIndex((m) => m.senderId === input.lastSenderId) + 1) % narrowed.length
    const first = narrowed[start === -1 ? 0 : start]!
    const keep = drafts.find((d) => d.senderId === first.senderId)!
    return {
      keep,
      discard: drafts.filter((d) => d.attemptId !== keep.attemptId),
      why: `no account can write today; kept @${keep.handle}, first in the ring`,
    }
  }

  /**
   * No draft's sender is in the ring at all — a route was withdrawn, or the account left
   * the fleet, after these were written. Keep the OLDEST rather than guessing: it is the
   * one an operator is most likely to have already read.
   */
  const keep = drafts[0]!
  return {
    keep,
    discard: drafts.slice(1),
    why: `no sender holding a draft is still in the ring; kept the oldest (@${keep.handle})`,
  }
}
