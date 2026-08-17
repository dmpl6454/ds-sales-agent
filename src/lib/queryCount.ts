/**
 * ── HOW MANY DATABASE QUERIES DID THAT PAGE COST? ─────────────────────────────────────
 *
 * This exists because of one bug that was invisible for months and then became the whole
 * product's experience overnight.
 *
 * `buildBrandsPanel` read every BRAND target with no limit and then ran TWO serial queries
 * per brand. On SQLite at ~1 ms a query that cost 0.2 s and nobody could feel it. Hosting
 * put the database behind an SSH tunnel at 28–37 ms a round trip, brand discovery finally
 * worked and took 9 brands to 68, and the same code made `/` a **9.9-second page issuing
 * 174 queries**. Neither cause was sufficient alone, which is exactly why nothing caught
 * it: the N+1 was latent for as long as the latency was low, and the latency arrived on a
 * different day from the loop.
 *
 * `pnpm ig:layout` already asserts geometry in a real browser, and geometry is not the
 * property that broke. So it now also asserts a QUERY BUDGET per page — the one item in
 * the repair plan that prevents recurrence rather than repairing an instance.
 *
 * ── WHY A COUNTER AND NOT A TIMER ─────────────────────────────────────────────────────
 *
 * A wall-clock budget would pass on a fast laptop and fail on a slow tunnel, so it would be
 * measuring the network. The defect is a COUNT — a loop issuing one query per row — and a
 * count is the same number on every machine. `buildCeoView` went 9.9 s → 508 ms by going
 * from 174 queries to a fixed handful; the seconds were the symptom.
 *
 * ── OFF UNLESS ASKED FOR ──────────────────────────────────────────────────────────────
 *
 * Counting needs Prisma's query event log, which serialises every statement. That is fine
 * for a check and wasteful in production, so the whole mechanism is behind
 * `DS_QUERY_COUNT=1`. With it unset `queryCountingEnabled()` is false, nothing subscribes,
 * and the endpoint reports that plainly rather than returning a confident zero — a page
 * that "used 0 queries" because nobody was counting is exactly the kind of reassuring
 * falsehood this file exists to catch.
 */

/**
 * ── THE STATE LIVES ON `globalThis`, AND THE FIRST VERSION DID NOT ────────────────────
 *
 * Module-level `let` looks obviously right and is wrong here. Next.js bundles each route
 * separately, so `/api/query-count` and `/` each got their OWN copy of this module and
 * therefore their own counter. MEASURED on the first run: every page reported exactly
 * **2 queries** — `/`, which builds the entire CEO view, reported the same as `/settings` —
 * and every budget passed. Those 2 were the endpoint's own `requireUser()`; the page's
 * queries were being counted into a variable nobody read.
 *
 * The check caught itself, but only because the count is PRINTED. "8 budgets passed" was
 * true and meaningless. A checker must show its working, or it is indistinguishable from
 * one that cannot fail — the same lesson as `ig:prune`'s dry run printing "24.3 GB → 24.3
 * GB" in the command arguing that pruning helps.
 *
 * `globalForCount` is the pattern `db.ts` already uses for the client itself, for the same
 * reason: one process, one instance, however many bundles import it.
 */
const globalForCount = globalThis as unknown as { dsQueryCount?: { n: number } }
const state = (globalForCount.dsQueryCount ??= { n: 0 })

/** Is query counting turned on for this process? */
export function queryCountingEnabled(): boolean {
  return process.env.DS_QUERY_COUNT === '1'
}

/** Called once per query by the client's event log. Deliberately trivial. */
export function noteQuery(): void {
  state.n++
}

/** Read the running total. */
export function queryCount(): number {
  return state.n
}

/** Read and zero, so a caller can attribute the next stretch of work to itself. */
export function takeQueryCount(): number {
  const n = state.n
  state.n = 0
  return n
}

const SUBSCRIBED = Symbol.for('ds.queryCount.subscribed')

/**
 * ── ONE SUBSCRIPTION PER CLIENT, WHICH IS NOT THE SAME AS ONE PER MODULE ──────────────
 *
 * The mark is written on the CLIENT OBJECT, and getting there took two wrong answers, both
 * of which produced a passing check and a wrong number.
 *
 *   module-level flag  → each Next route bundle has its own copy of this module, so each
 *                        subscribed its own client and counted into its own variable. Every
 *                        page reported the endpoint's own 2 queries.
 *   a flag on globalThis → now only the FIRST bundle to load subscribes. But in production
 *                        `db.ts` deliberately does not cache the client on `globalThis`
 *                        (`if (NODE_ENV !== 'production')`), so every bundle builds its OWN
 *                        PrismaClient — and the one bundle that subscribed was usually not
 *                        the one rendering the page. Every page then reported **0**.
 *
 * Both were measured by reading the printed count rather than the tick beside it. 0 queries
 * to render `/` is not plausible, and that implausibility is the only thing that caught it.
 *
 * The COUNTER stays on `globalThis` — every client must add into one total, since the
 * endpoint that reads it is a different bundle from the page that spent them. The
 * SUBSCRIPTION is per client, which is exactly what "do not attach the same listener twice"
 * means. A `Symbol.for` key so two copies of this module agree on it.
 */
export function markSubscribed(client: object): boolean {
  const c = client as Record<symbol, boolean>
  if (c[SUBSCRIBED]) return false
  c[SUBSCRIBED] = true
  return true
}
