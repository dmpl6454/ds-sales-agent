import { prisma } from '@/lib/db'

/**
 * THE FLEET'S PACE CLOCK — when did a message drive last BEGIN?
 *
 * Its own module rather than a corner of dispatcher.ts, because the two things that need it
 * sit on opposite sides of an import edge: the dispatcher READS it to pace ticks, and
 * `browserSender.send` WRITES it when a drive actually starts — and the dispatcher imports
 * `deliver.ts`, which imports the sender. Writing the stamp from the sender out of
 * dispatcher.ts would have made that a cycle.
 *
 * A `Setting` row rather than a column, for the reason the accuracy history is one too: this
 * machine cannot deploy a migration to the server, and a schema change applied to a live
 * database from a host that cannot ship the code using it is a split-brain window for no
 * gain. It is a single scalar the whole fleet shares, which is exactly what a Setting is for.
 */
export const LAST_SEND_STARTED_KEY = 'fleetLastSendStartedAt'

/**
 * Stamp the moment a message drive begins. Called by `browserSender.send` — the ONE
 * implementation every delivered message passes through — inside the send lock, before
 * the browser moves.
 *
 * It used to be called by `withSendLock` itself on every `isSend` acquisition, and that
 * placement was MEASURED wrong on 2026-08-21: a dispatch tick takes the lock before it
 * knows whether any draft passes the gate, so on a drained queue every passing tick
 * stamped the clock and the log read "the last message went out 0 minute(s) ago" for
 * TWELVE consecutive minutes with zero sends (17:07–17:18 IST, watch.log). A stamp on
 * intent is the completion-clock bug's mirror image: it converts "gap since the last
 * SEND" into "gap since the last dispatch ATTEMPT", and it delays a newly-cleared draft
 * by up to a full gap period while asserting a send that never happened.
 */
export async function recordSendStarted(at: Date): Promise<void> {
  await prisma.setting.upsert({
    where: { key: LAST_SEND_STARTED_KEY },
    create: { key: LAST_SEND_STARTED_KEY, value: at.toISOString() },
    update: { value: at.toISOString() },
  })
}

/**
 * PURE. Which clock does the fleet gap measure from, given both candidates?
 *
 * Extracted so the answer is testable without a database, because the bug it encodes was a
 * one-line comparison that a source grep could not see and that the caller exercised
 * perfectly — see the docblock inside `lastSendStartedAt` in dispatcher.ts.
 */
export function gapClock(started: Date | null, lastCompleted: Date | null): Date | null {
  /* The stamp wins whenever it exists; completion is the fallback, never the maximum. */
  if (started) return started
  return lastCompleted
}
