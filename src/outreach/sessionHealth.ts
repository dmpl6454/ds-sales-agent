import { prisma } from '@/lib/db'
import { log } from '@/lib/logger'

/**
 * Recording that a sender's Instagram session is DEAD. ONE writer, like `markChallenged`.
 *
 * ── THE BUG THIS EXISTS TO REMOVE ─────────────────────────────────────────
 *
 * `profileStatus().hasSession` asks the FILESYSTEM whether a `sessionid` cookie exists.
 * Instagram revokes server-side, invisibly, so both of these were live at once on
 * 2026-08-06 for @tabishmukaddam1:
 *
 *   - the dashboard said "connected"  (cookie on disk → hasSession: true)
 *   - two real sends failed with "Chrome profile for @tabishmukaddam1 is not logged in"
 *
 * Nothing wrote the failure anywhere: `NotLoggedInError` became
 * `{ status: 'FAILED', failureCode: 'navigation' }` and the draft went back to READY —
 * which is exactly what the paced dispatcher picks up. So autopilot drove a browser at
 * the dead session every fifteen minutes, forever, with the circuit breaker silent (it
 * watches `challenged` and `not-in-thread`, not login failures). Freshness is not
 * liveness — the fourth appearance of that failure in this codebase.
 *
 * ── THE SHAPE OF THE FIX: record the evidence, never poll ─────────────────
 *
 * A send already PROVED the session is dead; polling Instagram on page render would
 * re-learn the same fact by driving a browser (~10 MB of profile cache per session,
 * measured). So the failure writes `sessionInvalidAt` + `sessionInvalidReason`, and the
 * gate folds it into the EXISTING `no-session` stop as an input — no new rule.
 *
 * Cleared only by PROOF, and `clearSessionInvalid` says which kinds count. Never cleared
 * by a page load, and never as a side effect — the same discipline as `clearChallenge`.
 *
 * Like `markChallenged`, this does not retry, back off, or touch `autoSendEnabled`.
 */
export async function markSessionInvalid(args: {
  senderId: string
  /** For the log and the audit trail. */
  handle: string
  /** What proved it, in prose — shown verbatim on the Senders page. */
  detail: string
  /** Who noticed: 'autopilot' | an operator's email. */
  actor: string
  now?: Date
}): Promise<void> {
  const at = args.now ?? new Date()

  await prisma.senderAccount.update({
    where: { id: args.senderId },
    data: { sessionInvalidAt: at, sessionInvalidReason: args.detail.slice(0, 500) },
  })

  await prisma.auditLog
    .create({
      data: {
        actor: args.actor,
        action: 'sender.session.invalid',
        entity: `SenderAccount:${args.handle}`,
        detail: args.detail.slice(0, 500),
      },
    })
    .catch((e) => log.warn('session-invalid audit row not written', { handle: args.handle, error: String(e) }))

  log.alarm('this account is logged out of Instagram — nothing will send from it until it is signed in again', {
    sender: args.handle,
    noticedBy: args.actor,
  })
}

/**
 * Clear the mark — a real event proved the session works again.
 *
 * The only proofs that count, and each caller is one of them:
 *   - an identity-verified hand login (`loggedInAs` matched the expected handle)
 *   - a send that actually delivered (the whole path ran, including `assertLoggedInAs`)
 *
 * A cookie appearing on disk, a page load, or a Connect window closing are NOT proof —
 * `pollConnect`'s no-identity-check fallback reports "connected" from a cookie alone,
 * which is the exact confusion this column exists to resolve.
 *
 * `updateMany` scoped to a non-null mark, so proof against an already-clean account
 * writes nothing and the audit trail only records real transitions.
 */
export async function clearSessionInvalid(senderId: string, proof: string): Promise<void> {
  const cleared = await prisma.senderAccount.updateMany({
    where: { id: senderId, sessionInvalidAt: { not: null } },
    data: { sessionInvalidAt: null, sessionInvalidReason: null },
  })
  if (cleared.count > 0) {
    await prisma.auditLog
      .create({
        data: {
          actor: 'system',
          action: 'sender.session.restored',
          entity: `SenderAccount:${senderId}`,
          detail: proof.slice(0, 500),
        },
      })
      .catch((e) => log.warn('session-restored audit row not written', { senderId, error: String(e) }))
  }
}

/**
 * May this sender's session be treated as usable? PURE — both inputs are passed in.
 *
 * Both halves are required and they answer different questions:
 *   `hasSessionOnDisk`  — was there ever a login (cheap filesystem check, fails closed)
 *   `sessionInvalidAt`  — has anything since PROVED that login dead
 *
 * "Cookie on disk AND nothing has disproved it" is the strongest claim available without
 * driving a browser, and it is what `senderHasSession` now means everywhere the gate,
 * the planner and the dashboard ask.
 */
export function sessionUsable(s: { hasSessionOnDisk: boolean; sessionInvalidAt: Date | null }): boolean {
  return s.hasSessionOnDisk && s.sessionInvalidAt === null
}

/**
 * The MACHINE-INDEPENDENT half of the same question, for code that runs where the Chrome
 * profiles are not. PURE.
 *
 * ── WHY THIS IS NOT `sessionUsable`, AND WHY THE DIFFERENCE IS LOAD-BEARING ────────
 *
 * `sessionUsable` asks the FILESYSTEM (`profileStatus().hasSession`). That is the right
 * question at the moment of delivery, because the send drives a real Chrome profile on the
 * machine doing the sending — `gate.ts`, the dispatcher and every /senders row ask it, and
 * they must keep asking it.
 *
 * It is the WRONG question for anything that merely decides what to WRITE, because the
 * planner does not run on a sending machine. MEASURED 2026-08-13: `schedulerHeartbeat`
 * reads `machine: linode-detect`, every waiting draft was created at :30/:31 UTC by the
 * slot path on that host, and the Linode has **no `~/.ds-sales-agent` directory at all** —
 * profiles live on each operator's own device by design, and the server may never send
 * (`SEND_ENABLED=false`, verified in its `.env`). So `profileStatus(h).hasSession` is
 * `false` for EVERY account on the one machine that drafts.
 *
 * That is why rotation asks this instead. Feeding the filesystem answer into a binding
 * rotation would have made every recipient resolve to `all-unavailable` on the server and
 * stopped drafting fleet-wide — silently, and looking exactly like a planner that ran and
 * found nothing to do. The fix for one inert guard would have installed a worse one.
 *
 * What this can honestly claim is weaker, and that is the point: `sessionPath` records that
 * a hand login once happened, and `sessionInvalidAt` records that something later PROVED it
 * dead. A path in the database is not a live session (§3.5) — so this decides only whose
 * turn it is to be written to, never whether a message may go out. The send is re-checked
 * by `gate.ts` on the device that actually sends, which is strictly better than deciding it
 * when the draft was written.
 */
export function sessionRecorded(s: { sessionPath: string | null; sessionInvalidAt: Date | null }): boolean {
  return s.sessionPath !== null && s.sessionInvalidAt === null
}
