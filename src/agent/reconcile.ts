import { prisma } from '@/lib/db'
import { log } from '@/lib/logger'
import { profileStatus } from '@/outreach/browser/profile'
import { deviceId } from './claim'
import { needsSessionRecord } from './sessionRecord'

/**
 * A HAND LOGIN THAT NOBODY RECORDED, RECORDED — by the machine that can prove it.
 *
 * MEASURED 2026-08-17: @madaboutmarketingg was signed in by hand at 16:53 IST — a live
 * `sessionid` on this machine's disk — and `sessionPath` in the shared database stayed
 * NULL, because the dashboard's Connect poll is the only thing that wrote it and the poll
 * had stopped before the login finished. Eight `sender.connect.start` audit rows that day,
 * one `sender.login`. The consequence was invisible by construction: `/senders` asks the
 * FILESYSTEM (`sessionUsable`) and said "signed in", while rotation on the server asks the
 * DATABASE (`sessionRecorded`) and said "never signed in" — so the account looked healthy
 * on the one screen anybody reads, and no draft was ever written for it. Two readers, two
 * stores, each self-consistent. The 2026-08-07 unrecorded-login failure in a new guise.
 *
 * So the device agent — the long-lived process on the machine that HOLDS the profiles —
 * closes the gap on every tick: a profile with a session on disk whose row records no
 * login gets its login recorded, with an audit row saying a machine did it.
 *
 * ── WHAT THIS MAY AND MAY NOT WRITE, and both halves are load-bearing ──────────────
 *
 * It writes `sessionPath` + `sessionSavedAt` ONLY. That is the weaker claim rotation
 * needs — "a hand login once happened" — and it is honest evidence: a session cookie in
 * a profile directory on this device exists only because a person signed in here once.
 *
 * It NEVER touches `sessionInvalidAt`. That mark means something later PROVED the session
 * dead, and it clears only on proof — an identity-verified login or a delivered send
 * (§3.5). A cookie surviving on disk is exactly the evidence `sessionInvalidAt` exists to
 * overrule, so a reconcile pass resurrecting it would re-open the hole that rule closed.
 *
 * Worst case if the disk is wrong (say, somebody logged the profile into a different
 * account): rotation writes a draft, and the send path's `identify()` refuses with
 * WrongAccountError before anything reaches a recipient. A wasted draft, never a wrong
 * message — the same direction of error the gate already absorbs.
 */

/**
 * Record any hand login this machine can prove and the database has missed.
 *
 * `handlesWithDiskSession` is the answer `localSenderHandles()` already computed for
 * presence — the agent's tick passes it through rather than asking the disk twice.
 * Returns how many rows were repaired; a failure repairs nothing and never throws,
 * because one bad row must not take down the loop that exists to keep sends flowing.
 */
export async function reconcileSessionRecords(handlesWithDiskSession: string[]): Promise<number> {
  if (handlesWithDiskSession.length === 0) return 0
  try {
    const onDisk = new Set(handlesWithDiskSession)
    const senders = await prisma.senderAccount.findMany({
      where: { handle: { in: handlesWithDiskSession } },
      select: { id: true, handle: true, sessionPath: true, sessionInvalidAt: true },
    })

    let repaired = 0
    for (const s of senders) {
      if (!needsSessionRecord(s, onDisk.has(s.handle))) continue
      const dir = profileStatus(s.handle).dir
      await prisma.senderAccount.update({
        where: { id: s.id },
        data: { sessionPath: dir, sessionSavedAt: new Date() },
      })
      await prisma.auditLog.create({
        data: {
          actor: `device:${deviceId()}`,
          action: 'sender.login.reconciled',
          entity: `SenderAccount:${s.handle}`,
          detail:
            `a session exists on disk at ${dir} and no login was recorded — recorded now, unverified. ` +
            `Identity is still checked at every send; a dead-session mark is never cleared this way.`,
        },
      })
      log.info('recorded a hand login the poll missed', { handle: s.handle })
      repaired += 1
    }
    return repaired
  } catch (err) {
    log.error('session reconcile failed — will retry next tick', {
      error: err instanceof Error ? err.message : String(err),
    })
    return 0
  }
}
