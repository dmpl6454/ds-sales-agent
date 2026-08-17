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
/**
 * ── THE QUEUE COUNTER IS A DEPTH, NOT A DAILY RATE (2026-08-17, Tabish) ───────────────
 *
 * *"cap should not exist for drafts should it, what if we discover several targets?"*
 *
 * He is right, and the old shape had three faults that only show up together:
 *
 * 1. **A draft reaches nobody.** The rule's whole rationale — ten first touches in one
 *    afternoon look nothing like ten across ten days — is about what a RECIPIENT sees. That
 *    argument is about delivery. Applying it to creation guards a thing no stranger observes.
 * 2. **It made the delivery cap unreachable.** Both counters were compared against ONE
 *    number, and `created` was checked FIRST. So once the queue held N first touches, no more
 *    were written — and `delivered` could therefore never reach N either. The counter
 *    carrying the actual safety argument was dead in practice, which is this project's
 *    signature failure wearing the costume of a second guard.
 * 3. **A cleanup spent the day's allowance.** MEASURED, and it is what prompted the question:
 *    9 drafts were discarded for carrying the old template, a tenth was written, and
 *    `created` read 10/10 — so no new company could be contacted for the rest of the day,
 *    on account of messages nobody ever received.
 *
 * So the queue bound is now the DEPTH OF THE WAITING QUEUE, against its own setting:
 *
 *   - discovering 200 companies fills the queue to the bound and stops, rather than stalling
 *     drafting for the day;
 *   - discarding a draft returns its room immediately, because the room is a slot, not a
 *     spent token;
 *   - a draft/discard/redraft loop — the thing the old docblock feared — still cannot exceed
 *     the bound, because it never grows the queue. It also contacts nobody and, with
 *     `singleTemplate` on, spends no model call: rendering is template substitution.
 *
 * And the delivery counter keeps the name that carries the rationale,
 * `maxNewBrandTouchesPerDay`, now measured against nothing else.
 */
export interface NewBrandTouchCounts {
  /** First-touch brand drafts WAITING right now. A depth, not a rate — see above. */
  waiting: number
  /** First touches to brands DELIVERED today. The pattern guard. */
  delivered: number
}

export async function readNewBrandTouchCounts(dayStart: Date = istDayStart()): Promise<NewBrandTouchCounts> {
  const [waiting, delivered] = await Promise.all([
    /**
     * READY/QUEUED only. `SKIPPED` is deliberately NOT counted: a discarded draft is not in
     * the queue, and the whole point of a depth bound is that clearing the queue makes room.
     */
    prisma.outreachAttempt.count({
      where: { touchNumber: 1, status: { in: ['READY', 'QUEUED'] }, pair: { target: { kind: 'BRAND' } } },
    }),
    /**
     * `sentAt`, scoped to today — this one IS a daily rate, because it is about how many
     * strangers heard from us in one day.
     */
    prisma.outreachAttempt.count({
      where: {
        touchNumber: 1,
        status: { in: [...DELIVERED_STATUSES] },
        sentAt: { gte: dayStart },
        pair: { target: { kind: 'BRAND' } },
      },
    }),
  ])
  return { waiting, delivered }
}
