/**
 * MAY THIS PAIR ROW BE DELETED?
 *
 * ── THE TRAP THIS MODULE EXISTS FOR ───────────────────────────────────────────────────
 *
 * `OutreachAttempt.pairId` is **`ON DELETE CASCADE`**. Deleting a pair therefore deletes
 * every attempt recorded against it — and attempts are the record of what real people were
 * actually sent. Spacing (`cooldownDays`), the unanswered-touch cap and the new-material
 * rule are all DERIVED from that record, so erasing it does not merely lose history: it
 * lets the system write to someone it has already written to, with no way to know it did.
 *
 * CLAUDE.md already states the principle for the UI — *"Removal never deletes send
 * history"*, which is why a used channel is RETIRED (`optedOut`) rather than deleted. This
 * is the same promise for the one path that deletes pair rows directly.
 *
 * MEASURED on the live database 2026-08-13: `@tabishmukaddam1` holds **72** pair rows and
 * **0 of them carry an attempt**, so a delete is safe TODAY. A delete PATH that can reach a
 * pair with history is not safe on any day, and "it happens to be empty right now" is not a
 * guard. Hence a refusal that is a property of the row rather than of today's data.
 *
 * PURE, and it takes counts rather than rows, so both directions are testable without a
 * database — the same shape as `governor.ts`, `pacing.ts` and `routes.ts`.
 */

/** Why a pair row may not be pruned. One per refusal, so it can name itself. */
export type PrunePairRefusal = 'sender-is-in-the-fleet' | 'pair-carries-send-history'

export interface PrunePairQuestion {
  /** `SenderAccount.fleetMember`. A fleet route is a route the planner is meant to have. */
  senderIsFleetMember: boolean
  /**
   * How many `OutreachAttempt` rows point at this pair — EVERY status, not just delivered.
   *
   * Counting only `SENT`/`REPLIED` would read a queued or failed attempt as "no history"
   * and cascade it away, and a `FAILED` row parked by `not-in-thread` is precisely the
   * record a person still has to settle: the recipient may hold that message. The safe
   * question is "has anything ever been recorded here", not "did it arrive".
   */
  attemptCount: number
}

export type PrunePairVerdict = { prune: true } | { prune: false; refusal: PrunePairRefusal; detail: string }

/** The ONE definition of which pair rows a command may delete. */
export function mayPrunePair(q: PrunePairQuestion): PrunePairVerdict {
  /**
   * Checked FIRST so the reported reason is the one an operator can act on. A fleet route
   * is not a mistake to clean up — it is what `ensureFleetPairs` creates on purpose, and it
   * would be recreated on the next pass, so reporting "it has history" about it would send
   * someone looking at the wrong thing.
   */
  if (q.senderIsFleetMember) {
    return {
      prune: false,
      refusal: 'sender-is-in-the-fleet',
      detail:
        'This account is part of the rotation, so this route is one the planner is meant to have. ' +
        'Take the account out of the fleet first if that is what you mean.',
    }
  }
  if (q.attemptCount > 0) {
    return {
      prune: false,
      refusal: 'pair-carries-send-history',
      detail:
        `This route carries ${q.attemptCount} recorded message${q.attemptCount === 1 ? '' : 's'}, and deleting it ` +
        'would delete them with it. That record is what spacing, the unanswered-message cap and the ' +
        'new-material rule are worked out from, so losing it would let a message go to someone who ' +
        'has already had one. Left alone deliberately.',
    }
  }
  return { prune: true }
}
