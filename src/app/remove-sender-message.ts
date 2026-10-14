/**
 * REMOVING A SENDING ACCOUNT: which of its rows keep it, and the sentences that say so — PURE,
 * so the form, the server action and the tests ask ONE rule.
 *
 * ── REMOVE DELETED WHAT THE HAND-OFF HAD JUST KEPT (2026-10-09) ───────────
 *
 * `removeSender` decided delete-or-retire on DELIVERED messages alone, and `OutreachPair.sender`
 * and `OutreachAttempt.sender` are ON DELETE CASCADE. So on an account that had never delivered,
 * the delete erased exactly the rows the hand-off leaves in place on purpose:
 *
 *   - a `not-in-thread` park — the recipient may HAVE that message;
 *   - a `profile-gone` park — the recipient's own 7-day stop for every page (`parkedRows.ts`);
 *   - a SENDING row mid-drive — `recordDelivered` then lands on a row that no longer exists, and
 *     a message that reached a real person is recorded nowhere;
 *   - a superseded draft carrying a reply (C2) — the permanent "they know who we are" fact the
 *     introduction stop reads, so other pages were free to send the standard introduction again.
 *
 * And the result then said these "stayed with" the account it had just deleted.
 *
 * ── THE RULE ──────────────────────────────────────────────────────────────
 *
 * A row KEEPS its account when anything still reads it: every status except SKIPPED, and a
 * SKIPPED row that carries a reply. The only rows a delete may take are drafts released unsent
 * with nothing recorded on them — a message nobody received and no rule reads. The server asks
 * this inside the delete statement itself (`removeSender`); `keepsSender` is the same rule over
 * rows already in hand, for the sentence.
 */

export interface SenderRow {
  status: string
  failureCode: string | null
  repliedAt: Date | null
  replyPostedAt: Date | null
}

/** Does this row stop its account being deleted? Unknown statuses keep — the direction that keeps data. */
export function keepsSender(r: SenderRow): boolean {
  return r.status !== 'SKIPPED' || r.repliedAt !== null || r.replyPostedAt !== null
}

export interface HeldTally {
  delivered: number
  mayHaveReached: number
  pageGone: number
  sending: number
  replies: number
  /** Anything else that keeps the account — a draft prepared after the withdrawal, a status this does not know. */
  other: number
}

export function tallyHeld(rows: SenderRow[]): HeldTally {
  const t: HeldTally = { delivered: 0, mayHaveReached: 0, pageGone: 0, sending: 0, replies: 0, other: 0 }
  for (const r of rows) {
    if (!keepsSender(r)) continue
    const reply = r.repliedAt !== null || r.replyPostedAt !== null
    if (reply) t.replies += 1
    if (r.status === 'SENT' || r.status === 'REPLIED') t.delivered += 1
    else if (r.status === 'SENDING') t.sending += 1
    else if (r.status === 'FAILED' && r.failureCode === 'not-in-thread') t.mayHaveReached += 1
    else if (r.status === 'FAILED' && r.failureCode === 'profile-gone') t.pageGone += 1
    else if (!reply) t.other += 1
  }
  return t
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

export interface QueueOutcome {
  /** Released by the hand-off for the page rotation elects next. */
  released: number
  /** Discarded by the hand-off: the recipient is retired, or another page already covers them. */
  discarded: number
  /** Withdrawn by the removal: the hand-off kept them because no other page sends for their fleet. */
  withdrawn: number
}

function queueNote(q: QueueOutcome): string {
  const parts: string[] = []
  if (q.released > 0)
    parts.push(
      `${plural(q.released, 'waiting message')} released — the account the rotation picks next writes to ` +
        `each of those recipients on the next planning pass (within 15 minutes)`,
    )
  if (q.discarded > 0) parts.push(`${q.discarded} discarded as already covered or retired`)
  if (q.withdrawn > 0)
    parts.push(
      `${q.withdrawn} withdrawn unsent, because no other account sends for their fleet — ` +
        `they are written to again once one does`,
    )
  return parts.length === 0 ? '' : ` Queue: ${parts.join('; ')}.`
}

/** What a retired account holds, in words — only the reasons that are actually there. */
function heldList(t: HeldTally, borrowed: number): string[] {
  const out: string[] = []
  if (t.delivered > 0) out.push(`${t.delivered} delivered — the record that stops anyone being contacted twice`)
  if (t.mayHaveReached > 0)
    out.push(`${plural(t.mayHaveReached, 'message')} that may have reached the recipient (check the conversation)`)
  if (t.pageGone > 0)
    out.push(`${plural(t.pageGone, 'recipient')} whose page was found gone, which keeps every account away for a week`)
  if (t.sending > 0) out.push(`${plural(t.sending, 'message')} being sent right now`)
  if (t.replies > 0) out.push(`${plural(t.replies, 'recorded reply', 'recorded replies')}`)
  if (t.other > 0) out.push(`${plural(t.other, 'other recorded message')}`)
  if (borrowed > 0) out.push(`${plural(borrowed, "other account's message", "other accounts' messages")} using its stored text`)
  return out
}

export function removeSenderResult(
  r:
    | { handle: string; outcome: 'deleted'; queue: QueueOutcome }
    | { handle: string; outcome: 'retired'; queue: QueueOutcome; held: HeldTally; borrowed: number },
): string {
  if (r.outcome === 'deleted') {
    return (
      `Removed @${r.handle}: it held nothing any rule still reads. ` +
      `Its Chrome profile is left on disk in case you re-add it.${queueNote(r.queue)}`
    )
  }
  const held = heldList(r.held, r.borrowed)
  return (
    `@${r.handle} is retired rather than deleted, because it holds ` +
    (held.length > 0 ? held.join('; ') : 'records a rule still reads') +
    `. It is out of the rotation and writes to nobody; its sign-in and its Chrome profile are left ` +
    `as they are.${queueNote(r.queue)}`
  )
}

/**
 * The form's own description, true for BOTH outcomes because it is written before either is
 * known. Kept beside the result so the two cannot drift apart.
 */
export const REMOVE_SENDER_BLURB =
  'Each recipient it was about to write to is written to within 15 minutes by the account the rotation ' +
  "picks next, as that account's own message — unless no other account sends for their fleet, in which " +
  'case the message is withdrawn unsent until one does. Anything a rule still reads — a delivered message, ' +
  'one that may have reached someone, a send in progress, a recorded reply — stays with this account, and ' +
  'an account holding any of it is retired (out of the rotation, kept on record) rather than deleted. ' +
  'An account holding none of it is deleted outright.'
