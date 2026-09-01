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
 * ── WHOSE CONVERSATION DOES A REPLY HALT? (2026-09-01, Tabish's decision) ─────
 *
 * *"It does not make sense if all activity is halted for a target for 7 days by all
 * senders if a reply is detected. Only the channel (sender) which has gotten the reply
 * should halt for 7 days with the new logic of follow up."*
 *
 * Until today the halt was TARGET-scoped: one reply from any thread stopped EVERY page
 * writing to that recipient for `replyResumeHours`. That was the deliberate 2026-08-03
 * design ("a human takes over") and it is now PAIR-scoped by his instruction.
 *
 * ── THE RISK WAS STATED AND THE CALL IS RECORDED AS HIS ───────────────────────
 *
 * Put to him in one paragraph before the change, with the alternatives: the recipient who
 * replied is the one engaged human in the funnel, other pages cold-messaging them
 * mid-conversation is the "repeated unwanted contact" pattern aimed at exactly the wrong
 * person, and every page signs with the SAME phone number and the same name — so "a
 * different page" is transparent to precisely this reader. The offered safer variant was
 * pair-scoped-plus-follow-ups-only; he chose the plain pair scope, with the other pages
 * continuing under the ring rule. Recorded as his, like the caps removal, the 24/7 window
 * and the auto-resume before it.
 *
 * ── THE MECHANISM STAYS, AND `target` IS ONE ROW AWAY ─────────────────────────
 *
 * Exactly as `crossPageGapHours` kept its mechanism at 0 and `ACTIVE_FROM_HOUR`/
 * `ACTIVE_TO_HOUR` kept theirs at 0/0: `replyHaltScope = target` in one `Setting` row
 * restores the old behaviour with no code change, and the tests drive BOTH scopes so the
 * one that is switched off stays enforceable.
 */
export type ReplyHaltScope = 'pair' | 'target'

/** Tabish, 2026-09-01. See the docblock above for the risk he was shown. */
export const REPLY_HALT_SCOPE_DEFAULT: ReplyHaltScope = 'pair'

/**
 * An unrecognised value reads as `target`, NOT as the default — and the asymmetry is
 * deliberate.
 *
 * `readNumericSetting` warns and falls back to the default, which is right when the default
 * is the conservative value. Here it is not: the default is the PERMISSIVE scope, so a typo
 * (`"targt"`, `"Target "`, `"all"`) falling back to it would silently widen who may be
 * messaged mid-conversation — absence of a readable value becoming a permission, which is
 * this codebase's most-repeated defect. And the only reason anybody writes this row at all
 * is to move AWAY from the default, so `target` is also the likely intent.
 *
 * Absent is different from unreadable and keeps the default: nobody has expressed a wish.
 */
export function parseReplyHaltScope(raw: string | undefined): ReplyHaltScope {
  if (raw === undefined) return REPLY_HALT_SCOPE_DEFAULT
  const v = raw.trim().toLowerCase()
  if (v === 'pair') return 'pair'
  if (v === 'target') return 'target'
  console.warn(
    `[settings] ignoring replyHaltScope="${raw}" — expected "pair" or "target". ` +
      `Using "target", the wider halt, because an unreadable value must not widen who is messaged.`,
  )
  return 'target'
}

/**
 * The `OutreachPair` filter a halt applies through — the ONE place the scope is spelled.
 *
 * Every enforcer and every view model that predicts a hold asks this rather than writing
 * `pair: { targetId }` itself. That is not tidiness: `replyHalt.ts` exists because the halt
 * was once spelled out at seven call sites and drifted, and a scope switch spelled out at
 * eight of them would produce a page claiming a halt the gate is not enforcing — the
 * failure this file's own header records.
 */
export function replyHaltPairFilter(
  scope: ReplyHaltScope,
  ids: { senderId: string; targetId: string },
): { targetId: string; senderId?: string } {
  return scope === 'pair' ? { senderId: ids.senderId, targetId: ids.targetId } : { targetId: ids.targetId }
}

/**
 * The whole `where` an enforcer needs: the right conversations, still inside the window,
 * not released early. Handed out as one object so a caller cannot take the scope and forget
 * the window, or the window and forget `replyHandledAt`.
 */
export function replyHaltWhere(args: {
  scope: ReplyHaltScope
  senderId: string
  targetId: string
  resumeHours: number
  now?: Date
}) {
  return {
    pair: replyHaltPairFilter(args.scope, { senderId: args.senderId, targetId: args.targetId }),
    replyPostedAt: { gte: replyHaltFloor(args.resumeHours, args.now) },
    replyHandledAt: null,
  }
}

/**
 * The key a halt applies TO, for callers holding rows in memory rather than issuing a query.
 *
 * `messages-page` and `rest-tally` load every in-window reply once and group it, because a
 * lookup per draft would be an N+1 inside a render with a query budget. They grouped by
 * `targetId`; under a pair-scoped halt that would hold every page's draft on one page's
 * reply — a screen enforcing a rule the gate dropped. Same function, same answer.
 */
export function replyHaltKey(scope: ReplyHaltScope, ids: { senderId: string; targetId: string }): string {
  return scope === 'pair' ? `${ids.senderId}→${ids.targetId}` : ids.targetId
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
