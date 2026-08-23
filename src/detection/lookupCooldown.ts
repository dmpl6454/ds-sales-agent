/**
 * A BOUNDED PASS MUST NOT SPEND ITS WHOLE BUDGET ON THE SAME FAILING CANDIDATES.
 *
 * ── WHY THIS IS A SHARED MODULE AND NOT A THIRD COPY ──────────────────────────
 *
 * This exact livelock has now been found and fixed THREE times, in three modules, each
 * time by someone watching a log repeat itself:
 *
 *   2026-08-12  `resolveBrand`        — one throttled handle held the whole per-pass
 *                                       budget every pass. Fixed by "sort a just-failed
 *                                       handle LAST".
 *   2026-08-22  `badgeDoor`           — `enriched=10 unreachable=10` for HOURS: the queue
 *                                       is rebuilt newest-first, an unreachable enrichment
 *                                       recorded NOTHING, so the same ~10 dead handles held
 *                                       the front and companies on NEW paid posts waited
 *                                       behind them.
 *   2026-08-23  `officialDiscovery`   — `names=304 looked=5 created=0 needsHuman=1`,
 *                                       byte-identical pass after pass. Same shape again.
 *
 * Twice the lesson was written down and twice it failed to reach the next module, so the
 * mechanism now lives in ONE place with several callers — the discipline this repo applies
 * to `gate.ts`, `judgeWithFrame` and `messageEntry.ts` for the same reason.
 *
 * THE SIGNATURE TO LOOK FOR, recorded so a fourth occurrence is recognised in seconds:
 * **identical summary numbers on consecutive passes of a bounded queue.** A pass that is
 * genuinely finding nothing varies; a livelocked one does not.
 *
 * ── THE MEMORY IS IN-PROCESS AND TIME-BASED, DELIBERATELY ─────────────────────
 *
 * Nothing is persisted about a handle that failed to answer: **a failure must never become
 * a verdict**, which is this codebase's most-repeated defect. The candidate is only SENT TO
 * THE BACK and not retried within the cooldown. A long-lived agent keeps the memory between
 * passes; a restart forgets it, which costs exactly one pass of re-learning and can never
 * wedge anything — the safe direction, per the `resetBrandResolverLimit` lesson (a latch
 * that quietly means "forever" the day a resident process calls it).
 *
 * Excluded candidates are COUNTED and reported by every caller, never silently dropped: a
 * bounded pass that hides what it skipped reads as "covered everything" when it did not.
 */

/** A day. Long enough that a dead handle stops costing budget, short enough that a
 *  genuinely transient outage self-heals without anyone running a command. */
export const UNREACHABLE_RETRY_AFTER_MS = 24 * 60 * 60 * 1000

export interface CooldownOrder<T> {
  /** What this pass may try, best-first. */
  queue: T[]
  /** How many eligible candidates were held back by an unexpired cooldown. Report it. */
  coolingOff: number
}

/**
 * PURE. Orders a pass's eligible candidates so a just-failed one cannot hold the front.
 *
 * Three tiers, and the order between them is the whole fix:
 *   1. never failed        — in the caller's own priority order, untouched
 *   2. cooldown expired    — oldest failure first, so the longest-waiting is retried first
 *   3. still cooling off   — excluded from this pass entirely, and counted
 *
 * The caller's ordering is PRESERVED inside tier 1 (a stable filter, never a re-sort),
 * because each caller has its own idea of what is most worth a lookup — newest post for the
 * badge door, most-asserted brand name for official discovery — and this function must not
 * quietly overrule it.
 */
export function orderByFailureCooldown<T>(
  items: readonly T[],
  keyOf: (item: T) => string,
  failedAt: ReadonlyMap<string, number>,
  now: number,
  retryAfterMs: number = UNREACHABLE_RETRY_AFTER_MS,
): CooldownOrder<T> {
  const cooling = new Set<string>()
  for (const item of items) {
    const key = keyOf(item)
    const at = failedAt.get(key)
    if (at != null && now - at < retryAfterMs) cooling.add(key)
  }

  const fresh = items.filter((i) => !cooling.has(keyOf(i)) && !failedAt.has(keyOf(i)))
  const retryable = items
    .filter((i) => !cooling.has(keyOf(i)) && failedAt.has(keyOf(i)))
    .sort((a, b) => failedAt.get(keyOf(a))! - failedAt.get(keyOf(b))!)

  return { queue: [...fresh, ...retryable], coolingOff: cooling.size }
}

export interface FailureMemory {
  /** Record that this key just failed to answer. It goes to the back for the cooldown. */
  note(key: string): void
  /**
   * Is this key inside its cooldown right now? For callers whose QUEUE is not the same
   * shape as the thing that fails — official discovery queues brand NAMES but the lookups,
   * and therefore the failures, are per candidate HANDLE. Skipping such a candidate before
   * it is looked up is what keeps a dead handle from consuming the budget at all.
   */
  isCoolingOff(key: string): boolean
  /** It answered — forget the failure, so it competes normally again. */
  clear(key: string): void
  /** Test seam: module state would otherwise leak between cases in one suite process. */
  reset(): void
  /** Order a pass's candidates. See `orderByFailureCooldown`. */
  order<T>(items: readonly T[], keyOf: (item: T) => string): CooldownOrder<T>
}

/** One memory per calling module — they are separate queues over separate populations. */
export function createFailureMemory(retryAfterMs: number = UNREACHABLE_RETRY_AFTER_MS): FailureMemory {
  const failedAt = new Map<string, number>()
  return {
    note: (key) => void failedAt.set(key, Date.now()),
    isCoolingOff: (key) => {
      const at = failedAt.get(key)
      return at != null && Date.now() - at < retryAfterMs
    },
    clear: (key) => void failedAt.delete(key),
    reset: () => failedAt.clear(),
    order: (items, keyOf) => orderByFailureCooldown(items, keyOf, failedAt, Date.now(), retryAfterMs),
  }
}
