/**
 * ── ONE COMPUTATION PER KEY PER SHORT WINDOW, AND AT MOST TWO AT ONCE (2026-09-04) ──
 *
 * The hosted dashboard runs on a 2 GB / 1-vCPU Linode shared with eight other apps, 914 MB
 * in swap. On 2026-09-04 the web process was OOM-killed twice (773 MB and 607 MB anon-rss).
 * A SINGLE page render peaks at only +22..32 MB of heap — measured — so the memory did not
 * come from one render. It came from a PILE-UP: a CPU-starved render took over 60 s, nginx
 * returned 504, the person retried, every open tab auto-refreshed on its 30-45 s clock, and
 * ten-plus renders were alive at once, each hydrating its own copy of the same rows.
 *
 * Two structural properties close that, and both live here rather than in each builder:
 *
 *   1. SINGLE-FLIGHT PER KEY. Concurrent callers asking the same question share ONE
 *      in-flight promise, and a settled answer is served for a short window (10 s by
 *      default — inside the 30-45 s the pages already accept from `auto-refresh.tsx`).
 *      `buildCeoView` had exactly this as a private memo since 2026-09-02 (5.3 s cold /
 *      2.0 s warm per page on the server, recomputed by four pages per request); it is the
 *      pattern generalised, so there is one mechanism and not one per builder.
 *
 *   2. ADMISSION CONTROL. Even with every key memoised, a burst that asks for DIFFERENT
 *      pages still runs one computation per page at once, and the heap is the sum of them.
 *      So at most `MAX_INFLIGHT_VIEWS` distinct computations run per process; further
 *      distinct keys wait FIFO for a slot. Memo hits and in-flight joins never wait — they
 *      cost nothing and hold nothing.
 *
 * A REJECTED computation is never cached: a failed answer must not be served for ten
 * seconds, so the next call recomputes (the `.catch` pattern from the original memo).
 *
 * IN MEMORY, NEVER SERIALISED. This is a plain `Map`, deliberately NOT `unstable_cache`:
 * every label on these pages is built from `Date` objects, and a serialising cache hands
 * them back as strings. The object cached is the object returned, by reference.
 *
 * OFF UNDER VITEST BY DEFAULT. Tests mutate the database and rebuild a view in the same
 * second; a ten-second memo would make them assert against the previous fixture. The tests
 * of THIS module pass `enabled: true` explicitly.
 *
 * PER PROCESS, BY DESIGN. The web tier is a two-worker pm2 cluster; each worker holds its
 * own map, so the bound is per worker and the fleet-wide ceiling is twice the constant.
 * That is the correct granularity — heap is per process — and nothing here needs to agree
 * across workers, because a stale-by-ten-seconds page is already what the design accepts.
 */

/**
 * At most this many DISTINCT view computations may run at once in one process.
 *
 * Two, because the measurement that motivated this module is a per-render peak of
 * +22..32 MB against a process that was killed at 607 MB: ten-plus concurrent renders is
 * the pile-up, and a ceiling of two bounds the working set to a few tens of MB however
 * many tabs are open. It is not one, because the landing page legitimately asks for
 * several views in a `Promise.all`, and a ceiling of one would serialise a single page's
 * own builders behind each other for no memory gain worth having.
 */
export const MAX_INFLIGHT_VIEWS = 2

/** Default freshness window. Inside the 30-45 s auto-refresh the pages already accept. */
export const VIEW_MEMO_TTL_MS = 10_000

interface Entry {
  /**
   * When the computation SETTLED, or null while it is still in flight. Stamped on
   * completion rather than on request, because a computation may wait in the admission
   * queue before it starts: stamping the request time would let a result that waited eight
   * seconds for a slot expire the moment it arrived.
   */
  settledAt: number | null
  value: Promise<unknown>
}

const cache = new Map<string, Entry>()

/** How many computations hold a slot right now. */
let running = 0
/** Callers waiting for a slot, in arrival order. */
const waiters: Array<() => void> = []

/**
 * Take a slot, waiting FIFO if none is free. Returns the release function.
 *
 * The hand-off in `release` keeps the slot COUNTED while it passes to the next waiter —
 * `running` is not decremented and re-incremented — so a caller arriving in the gap cannot
 * take a slot a waiter was already promised. That is what makes the queue FIFO rather than
 * merely "eventually".
 */
async function admit(): Promise<() => void> {
  if (running < MAX_INFLIGHT_VIEWS) {
    running += 1
  } else {
    await new Promise<void>((resolve) => waiters.push(resolve))
  }
  let released = false
  return () => {
    if (released) return
    released = true
    const next = waiters.shift()
    if (next) next()
    else running -= 1
  }
}

/**
 * Serve `fn()`'s answer for `key`, computing it at most once per `ttlMs` and never more
 * than `MAX_INFLIGHT_VIEWS` distinct keys at a time.
 *
 * The key must name EVERY input the computation reads from its arguments — a builder that
 * takes a page number or a filter puts them in the key, or two different pages share one
 * answer. `viewKey` below builds one with a stable serialisation.
 */
export function memoView<T>(
  key: string,
  fn: () => Promise<T>,
  opts?: { ttlMs?: number; enabled?: boolean },
): Promise<T> {
  const ttlMs = opts?.ttlMs ?? VIEW_MEMO_TTL_MS
  const enabled = opts?.enabled ?? !process.env.VITEST
  if (!enabled) return fn()

  const hit = cache.get(key)
  if (hit && (hit.settledAt === null || Date.now() - hit.settledAt < ttlMs)) {
    return hit.value as Promise<T>
  }

  const entry: Entry = { settledAt: null, value: undefined as unknown as Promise<unknown> }
  const value = (async () => {
    const release = await admit()
    try {
      return await fn()
    } finally {
      release()
    }
  })()
  entry.value = value
  cache.set(key, entry)

  value.then(
    () => {
      entry.settledAt = Date.now()
    },
    () => {
      // A failed computation must not be served for ten seconds; the next request recomputes.
      if (cache.get(key) === entry) cache.delete(key)
    },
  )
  return value
}

/**
 * Forget every cached answer. In-flight computations finish for the callers already
 * holding them, but are not served to anyone who asks afterwards — a later call recomputes.
 *
 * Called beside every `revalidatePath` in the server actions: "the next render must be
 * fresh" is exactly what a ten-second memo would otherwise defeat.
 */
export function invalidateViews(): void {
  cache.clear()
}

/**
 * A stable cache key: the builder's name plus its arguments serialised with SORTED object
 * keys, so `{ page: 2, channel: 'x' }` and `{ channel: 'x', page: 2 }` are one key, and a
 * `Date` argument serialises to its instant rather than to `{}`.
 */
export function viewKey(name: string, args?: unknown): string {
  return args === undefined ? name : `${name}:${stableStringify(args)}`
}

function stableStringify(value: unknown): string {
  if (value instanceof Date) return JSON.stringify(value.toISOString())
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (value && typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>).sort()
    return `{${keys
      .map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'undefined'
}