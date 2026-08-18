/**
 * How long a reply halts outreach to its target — and when it releases ITSELF.
 *
 * ── THE DECISION, AND WHOSE IT IS ──────────────────────────────────────────
 *
 * Until 2026-08-07 a reply halted every sender to that target until a person pressed
 * "handled" (`replyHandledAt`) — a hard stop with a manual release. **Tabish removed the
 * manual step: a reply pauses the target for one day, then automated messaging resumes on
 * its own.** The risk was stated to him plainly when he chose it — an automated follow-up
 * resuming into a conversation a human answered is the "repeated unwanted contact"
 * pattern Meta penalises, aimed at the one prospect who engaged — and he reaffirmed
 * auto-resume after 1 day. Recorded as his decision, 2026-08-07.
 *
 * What survives of the old design, on purpose:
 *   - Every reply is still RECORDED (`repliedAt`, `replyText`) and still halts instantly.
 *   - "Mark as handled" still works as an EARLY release inside the window, and still
 *     files the reply away; it is just no longer the only way out.
 *   - A NEWER reply re-arms the window from ITS timestamp — an actively-replying prospect
 *     keeps deferring, because only messages we have not already recorded count as new
 *     replies (see replyCheck.ts).
 *   - Detection is untouched; it never gated on any of this.
 *
 * ── ONE PREDICATE, MANY CALLERS ────────────────────────────────────────────
 *
 * The halt used to be the query shape `repliedAt != null AND replyHandledAt == null`,
 * spelled out at seven call sites — the exact drift that put DELIVERED_STATUSES in
 * constants.ts. The time window would have made it eight subtly different date
 * calculations. So: `replyHaltFloor` is the one place the arithmetic lives (query sites
 * add `repliedAt: { gte: floor }`), and `replyHaltActive` is the same rule for callers
 * that already hold the row. PURE, tested in both directions.
 */

/**
 * Default hours a reply pauses its target. A `Setting` row (`replyResumeHours`) overrides.
 *
 * TWO DAYS since 2026-08-18 — Tabish: "cooldown if conversation is ongoing to 2 days",
 * given in the same instruction that removed every other volume cap. This is the one
 * number that got MORE conservative that day.
 */
export const REPLY_RESUME_HOURS_DEFAULT = 48

/** Replies at or after this instant still hold the halt; older ones have released. */
export function replyHaltFloor(resumeHours: number, now: Date = new Date()): Date {
  return new Date(now.getTime() - resumeHours * 60 * 60 * 1000)
}

/** Is this attempt's reply holding the halt right now? */
export function replyHaltActive(args: {
  repliedAt: Date | null
  replyHandledAt: Date | null
  resumeHours: number
  now?: Date
}): boolean {
  if (args.repliedAt === null) return false
  if (args.replyHandledAt !== null) return false
  return args.repliedAt >= replyHaltFloor(args.resumeHours, args.now ?? new Date())
}
