import { prisma } from '@/lib/db'
import { istDayStart } from '@/lib/time'
import { DELIVERED_STATUSES } from '@/lib/constants'

/**
 * ── "2 NEW BRANDS A DAY" MEANT "2 PER RUN", AND ONE HALF NEVER BOUND AT ALL ───────────
 *
 * `checkNewBrandTouchCap` was asked one number: how many brands were contacted for the
 * first time today. It was counted over `DELIVERED_STATUSES` with `sentAt >= dayStart` —
 * and at the time nothing had ever been delivered, so that number was permanently ZERO. The
 * only thing actually binding was a counter reset at the top of every run, which makes the
 * rule "2 per run" — 4 runs a day, so ~8.
 *
 * **CORRECTION 2026-08-17: the delivered counter BINDS NOW, for the first time.** The
 * sentence above ("nothing has ever been delivered") was true when it was written and is
 * false today: @bollywoodchronicle delivered a first touch to @crocsindia at 10:42 IST on
 * 17 August, so `delivered` read 1 the same day. This is the branch that had never once
 * executed against real data, and it is live — which is exactly why the two counters were
 * separated before anyone needed them to be.
 *
 * That is the `MAX_TOTAL_SENDS` shape again: a limit whose reported meaning and enforced
 * meaning are different rules, reading as headroom.
 *
 * It matters much more now. Removing the autopilot gate on `detectThenDraft` takes drafting
 * from 4 passes a day to 96, and the per-run counter would then permit ~192 first touches a
 * day rather than 2 — from a queue nobody watched grow. The cap on CREATION is the thing
 * that bounds it, which is why 4.1 and 4.2 ship together or not at all.
 *
 * ── TWO FACTS, TWO COUNTERS, NEVER ONE NUMBER ─────────────────────────────────────────
 *
 * They answer different questions and they will diverge:
 *
 *   CREATED    how many new-brand conversations were OPENED IN THE QUEUE today. Bounds the
 *              draft backlog. Every draft is a frozen body carrying a claim that decays
 *              (`HOOK_STALE_SINCE_DRAFT` exists because of exactly that), so an unbounded
 *              queue is not free even though drafting contacts nobody.
 *   DELIVERED  how many strangers actually heard from us today. This is the one the rule
 *              was written about — ten first touches in an afternoon and ten across ten
 *              days are the same volume and look nothing alike from a recipient's side.
 *
 * Merging them into one number would hide whichever is smaller, and today they are 6 and 0.
 * Both are surfaced on `/rules` from here, so the page cannot report the cap by a different
 * rule than the planner enforces.
 *
 * Both are scoped `touchNumber: 1` and `kind: 'BRAND'` — the cap is about opening a
 * conversation with a stranger, and a follow-up is already spaced by `cooldownDays` and
 * bounded by `maxUnansweredTouches`.
 */
export interface NewBrandTouchCounts {
  /** First touches to brands WRITTEN today, whatever became of them. */
  created: number
  /** First touches to brands DELIVERED today. */
  delivered: number
}

export async function readNewBrandTouchCounts(dayStart: Date = istDayStart()): Promise<NewBrandTouchCounts> {
  const [created, delivered] = await Promise.all([
    /**
     * `queuedAt`, not `createdAt` — `OutreachAttempt` has no `createdAt` column, and a
     * plausible-looking `createdAt` filter is a runtime error rather than a compile one.
     *
     * EVERY status counts, `SKIPPED` included. A draft that was written and then discarded
     * still opened a conversation as far as this cap is concerned: excluding discards would
     * let a loop draft, discard and redraft its way past the cap without limit, and the
     * discarded body has already burned its campaign from the pool (documented in
     * `compose.ts`) so it was not free either.
     */
    prisma.outreachAttempt.count({
      where: { touchNumber: 1, queuedAt: { gte: dayStart }, pair: { target: { kind: 'BRAND' } } },
    }),
    prisma.outreachAttempt.count({
      where: {
        touchNumber: 1,
        status: { in: [...DELIVERED_STATUSES] },
        sentAt: { gte: dayStart },
        pair: { target: { kind: 'BRAND' } },
      },
    }),
  ])
  return { created, delivered }
}
