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
 * SEVEN DAYS since 2026-08-19 — Tabish: the 7-day constraint applies when "a reply has
 * been detected (which would resume after 7 days automatically or manually by clicking
 * on the UI)". Was 48h (2026-08-18, "cooldown if conversation is ongoing to 2 days").
 * "I have replied" stays as the early release; a hard stop with no release is a bug
 * wearing a safety feature's clothes.
 */
export const REPLY_RESUME_HOURS_DEFAULT = 168

/** Replies at or after this instant still hold the halt; older ones have released. */
export function replyHaltFloor(resumeHours: number, now: Date = new Date()): Date {
  return new Date(now.getTime() - resumeHours * 60 * 60 * 1000)
}

/**
 * Is this attempt's reply holding the halt right now?
 *
 * ── THE HALT KEYS ON WHEN THEY WROTE, NOT ON WHEN WE LOOKED (2026-08-21) ──
 *
 * `repliedAt` is the sweep's OBSERVATION clock. While coverage was 10%, growing it meant
 * "discovering" weeks-old replies, and a halt keyed on observation would have paused each
 * of those targets for seven days from the day of DISCOVERY — a reply from July silencing
 * outreach in August. Tabish's rule, verbatim: *"the agent must see the date on the reply
 * or message sent; if no date is visible send the message … as the reply might be to an
 * older conversation."*
 *
 * So the halt reads `replyPostedAt` — the reply's own date, taken from the thread's date
 * separator or the inbox row's age — and an UNDATABLE reply (`replyPostedAt: null`) does
 * not hold it. That is the permissive direction and it is HIS call, recorded here: the
 * reply itself is still recorded, still on the replies card, still a person's to answer;
 * only the automatic seven-day pause requires a date it can count from. Query sites
 * filter `replyPostedAt: { gte: floor }`, which never matches NULL, so the predicate and
 * the queries fail in the same direction by construction.
 */
export function replyHaltActive(args: {
  /** When the reply was WRITTEN, as the thread or inbox showed us. Null = undatable. */
  replyPostedAt: Date | null
  replyHandledAt: Date | null
  resumeHours: number
  now?: Date
}): boolean {
  if (args.replyPostedAt === null) return false
  if (args.replyHandledAt !== null) return false
  return args.replyPostedAt >= replyHaltFloor(args.resumeHours, args.now ?? new Date())
}
