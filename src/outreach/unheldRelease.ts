import { prisma } from '@/lib/db'
import { discardAttempt } from './discard'
import { NOT_HELD_BY_AN_ONLINE_MAC } from './availability'

/**
 * RELEASE THE DRAFTS OF AN ACCOUNT NO ONLINE MAC HOLDS — at the top of every planning pass.
 *
 * ── WHY (17 October 2026, measured on the box) ─────────────────────────────
 *
 * @bollywoodchronicle's only Chrome profile lived on a Mac that no longer exists. Rotation kept
 * electing it (its row still read ACTIVE with a recorded session) and the planner wrote it 147
 * first touches and 45 follow-ups that no Mac could send. The new-brand bound is a fleet-wide
 * DEPTH (`readNewBrandTouchCounts`: touch-1 READY/QUEUED drafts to BRAND targets, against
 * `maxWaitingNewBrandDrafts` 150), so those drafts filled it: `new-brand-daily-cap=377`,
 * `queued=0` on every pass, and the four accounts the sending Mac DOES hold were starved. Zero
 * sends for a day. `availability.ts` now stops rotation electing such an account; this releases
 * what was already written for it, so the same pass can write the elected pages their own.
 *
 * ── RELEASE, NEVER RE-POINT ────────────────────────────────────────────────
 *
 * The `handOff.ts` argument, verbatim in shape: moving a draft's bytes onto another page made a
 * follow-up arrive as that page's first message and an introduction land as touch 2. The
 * planner is the one elector and the one composer; each draft goes through `discardAttempt`
 * (the one writer — status guard inside the update, audited), SKIPPED frees its post claim
 * (not in IN_FLIGHT_STATUSES), and `whoseTurn` hands the recipient to a page that can send.
 *
 * ── WHY ONLY THIS REASON RELEASES ──────────────────────────────────────────
 *
 * A flagged or signed-out account is fixable on a Mac that EXISTS, and its drafts are re-judged
 * by that Mac's gate the moment it is fixed — releasing them would throw away the queue every
 * time a session blinked. An account no Mac seen in three days holds is a different fact: its
 * drafts cannot move at all, and every one of them holds the shared depth for every other page.
 * The reason string is imported, never retyped, so the two files cannot drift.
 *
 * ── WHAT IS NEVER TOUCHED ──────────────────────────────────────────────────
 *
 *   SENDING                     a browser may be pasting it — `discardAttempt` refuses it
 *   FAILED (any code)           `onlyWaiting`: a not-in-thread park may have ARRIVED, and every
 *                               other park is a person's to settle on the landing page
 *   another sender's rows       the query is scoped to the unheld senders' ids
 *   a non-fleet account         the planner writes nothing for one, so it releases nothing for
 *                               one; the burner's on-demand rehearsal drafts are a person's
 *   a draft a PERSON touched    `attempt.edited` (the editor) or `ondemand.prepared` (the
 *                               "send a message now" dialog) recorded against that attempt.
 *                               Those bytes were chosen by a person, nothing re-writes them, and
 *                               they are bounded by human effort rather than by a 15-minute
 *                               clock, so they cannot refill the depth. KEPT, counted and named
 *                               in the log, for a person to send once the account is signed in
 *                               on a live Mac, or discard. Planner-written drafts carry no such
 *                               row, which is the whole of what the data allows us to tell apart
 *
 * Signing the account in on a live Mac (/senders → Connect) makes it electable on the next pass
 * and the planner writes to it again; nothing here is permanent.
 *
 * ── NEVER ON ONE SNAPSHOT, AND NEVER WHEN NO PAGE CAN SEND (review, same day) ──────────────
 *
 * Two holds, both found by adversarial review of the first version:
 *
 *   no-history        "not held" is per handle over a PERSISTED history (availability.ts,
 *                     `SESSION_HOLDER_SEEN_KEY`) so one bad beat cannot release a live account's
 *                     queue. On the first pass after deploy that history has just been seeded from
 *                     ONE read of the presence row, so the release waits one pass. Rotation still
 *                     skips the account in that pass; only the irreversible step waits.
 *   no-page-can-send  when EVERY fleet account is unavailable (the sending Mac away past the
 *                     window, every session gone), the release would free the depth for nobody —
 *                     rotation is `all-unavailable` for every recipient — and it would reverse
 *                     Tabish's recorded queue-and-send-on-return decision (CLAUDE.md, 8 Sept:
 *                     "drafts stay READY … they go out on reconnect") for no gain: a waiting
 *                     follow-up whose post has passed the planner's 72 h material floor is still
 *                     sendable by the gate's 7-day window on return, and once SKIPPED it could
 *                     never be written again. The wedge this exists for is the OPPOSITE shape —
 *                     some pages can send and one cannot — and is unaffected.
 */

export interface UnheldRelease {
  /** Per account released, in handle order. Empty when no fleet account is unheld. */
  released: { handle: string; count: number }[]
  /** Drafts kept because a person edited or prepared them. */
  keptPersonTouched: number
  /**
   * Why nothing was released although an account reads unheld — null when the release ran (or
   * had nothing to do). `no-history`: the first pass after deploy, the holder history was only
   * just seeded from one snapshot. `no-page-can-send`: every fleet account is unavailable, so
   * releasing would free the depth for nobody — see "WHEN NO PAGE CAN SEND" above.
   */
  heldBack: 'no-history' | 'no-page-can-send' | null
}

/** Postgres binds up to 65,535 parameters and SQLite 32,766; a batch well inside both. */
const ID_BATCH = 500

export async function releaseDraftsNoOnlineMacHolds(args: {
  /** `readSenderAvailability()` from this pass — the reason is read from it, not recomputed. */
  unavailable: ReadonlyMap<string, string>
  actor: string
  /** `recordSessionHolderHistory()`'s answer this pass: did a holder history exist before it? */
  hadHistory: boolean
}): Promise<UnheldRelease> {
  const out: UnheldRelease = { released: [], keptPersonTouched: 0, heldBack: null }
  const unheldIds = [...args.unavailable].filter(([, why]) => why === NOT_HELD_BY_AN_ONLINE_MAC).map(([id]) => id)
  if (unheldIds.length === 0) return out

  const fleet = await prisma.senderAccount.findMany({
    where: { fleetMember: true },
    select: { id: true, handle: true },
    orderBy: { handle: 'asc' },
  })
  const unheld = new Set(unheldIds)
  const senders = fleet.filter((s) => unheld.has(s.id))
  if (senders.length === 0) return out
  if (!args.hadHistory) return { ...out, heldBack: 'no-history' }
  if (fleet.every((s) => args.unavailable.has(s.id))) return { ...out, heldBack: 'no-page-can-send' }

  const waiting = await prisma.outreachAttempt.findMany({
    where: { senderId: { in: senders.map((s) => s.id) }, status: { in: ['READY', 'QUEUED'] } },
    select: { id: true, senderId: true },
    orderBy: { queuedAt: 'asc' },
  })
  if (waiting.length === 0) return out

  const touched = new Set<string>()
  for (let i = 0; i < waiting.length; i += ID_BATCH) {
    const entities = waiting.slice(i, i + ID_BATCH).map((a) => `OutreachAttempt:${a.id}`)
    for (const row of await prisma.auditLog.findMany({
      where: { entity: { in: entities }, action: { in: ['attempt.edited', 'ondemand.prepared'] } },
      select: { entity: true },
    })) {
      touched.add(row.entity.slice('OutreachAttempt:'.length))
    }
  }

  const handleOf = new Map(senders.map((s) => [s.id, s.handle]))
  const counts = new Map<string, number>()
  for (const a of waiting) {
    if (touched.has(a.id)) {
      out.keptPersonTouched += 1
      continue
    }
    const handle = handleOf.get(a.senderId) ?? a.senderId
    const r = await discardAttempt({
      attemptId: a.id,
      reason: `@${handle} is ${NOT_HELD_BY_AN_ONLINE_MAC}, so no Mac can send this — released for rotation to write to the recipient from a page that can`,
      actor: args.actor,
      onlyWaiting: true,
    })
    if (r.ok) counts.set(handle, (counts.get(handle) ?? 0) + 1)
  }
  out.released = [...counts].sort(([a], [b]) => a.localeCompare(b)).map(([handle, count]) => ({ handle, count }))
  return out
}
