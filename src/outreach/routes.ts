/**
 * MAY THIS SENDER→TARGET ROUTE EXIST AT ALL?
 *
 * ── WHY THIS IS ITS OWN MODULE, AND WHY IT IS PURE ────────────────────────
 *
 * `ensureFleetPairs` (plan.ts) creates every route the fleet is allowed to have, and it
 * carries two exclusions that are the whole safety content of the one-switch change:
 * never pair a sender to itself, and never pair one of OUR OWN PAGES to another. Since
 * nothing reads `OutreachPair.enabled` any more (Tabish, 2026-08-08), a pair row IS a live
 * route — so a row created anywhere else, by any other code path, is a route the planner
 * will act on whether or not `ensureFleetPairs` would have allowed it.
 *
 * MEASURED 2026-08-08, and this is the gap this module closes: FIVE other paths created
 * pairs directly, none of them applying the fleet-page exclusion —
 *
 *     addSender · addTarget · confirmBrand · scripts/brands.ts · importProspects.ts
 *
 * `addTarget` was the worst of them: it read `senderAccount.findMany()` with NO filter and
 * paired the new target with all of them. So `addTarget('bollywoodsocietyy')` — a handle
 * that is a fleet SENDER and legitimately also a CHANNEL target row, because watching our
 * own pages is ground truth rather than prospecting — created exactly the route
 * `ensureFleetPairs` explicitly refuses to create, and one of our own revenue pages would
 * have cold-pitched another. While routes were created DISABLED that row was inert and a
 * human still had to flip a chip; with the chips gone it is live.
 *
 * THIS REPO HAS BEEN BITTEN FOUR TIMES BY ONE RULE WITH SEVERAL CALLERS — `gate.ts`,
 * `readThread.ts`, the two Connect buttons, and `judge.ts` (CLAUDE.md names all four, and
 * `tests/one-judging-path.test.ts` exists because a COMMENT claiming "one implementation,
 * two callers" was already present and untrue). So the rule lives here once, every creator
 * asks it, and `tests/one-route-rule.test.ts` asserts that rather than a comment claiming
 * it.
 *
 * PURE, and it takes handles and flags rather than rows. Two reasons. A sender row and a
 * target row for the same account are two DIFFERENT rows with two different ids, so the
 * comparison has to be on handle — passing rows would invite an `id` comparison that is
 * silently always false. And a pure predicate over primitives is testable in both
 * directions without a database, which is what `governor.ts` and `pacing.ts` already do
 * for the rules that matter most.
 */

/** Why a route may not exist. One per exclusion, so a refusal can name itself. */
export type RouteRefusal = 'self' | 'target-is-our-own-page' | 'target-retired'

export interface RouteQuestion {
  /** The sending account's handle, lowercase and without the leading `@`. */
  senderHandle: string
  /** The recipient's handle, lowercase and without the leading `@`. */
  targetHandle: string
  /**
   * Every handle that is a FLEET sending account (`fleetMember: true`). Membership here is
   * what makes a target one of our own pages.
   *
   * FLEET MEMBERS ONLY, AND NOT EVERY ACCOUNT WE OWN — the direction matters and is pinned
   * by a test. The burner `@tabishmukaddam1` is `fleetMember: false` and is deliberately
   * still MESSAGEABLE as a target: it is the rehearsal recipient every end-to-end send in
   * this project was proven against, and `safeTargetIds()` exists to keep exactly that
   * reachable. Widening this to "every handle we own" reads like the safer simplification
   * and would silently retire the only safe test recipient there is. See
   * `tests/fleet-pairs.test.ts` — *"a NON-fleet sender that is also a target row is still
   * messageable"* — which fails if this is widened.
   *
   * The burner never SENDS on a schedule regardless: `ensureFleetPairs` and `runOutreach`
   * both scope senders to `fleetMember: true`, so the burner's own routes are excluded at
   * the query rather than here.
   */
  ourHandles: ReadonlySet<string>
  /**
   * `TargetAccount.optedOut` — retirement. Housekeeping here rather than the promise: the
   * promise is kept by `governor.ts` and again by `gate.ts` at delivery, which is why
   * retirement is a flag on the TARGET and never a missing pair row.
   */
  targetOptedOut: boolean
}

export type RouteVerdict = { allowed: true } | { allowed: false; refusal: RouteRefusal }

/**
 * The ONE definition of which routes may exist.
 *
 * Order matters only for which reason a refusal reports, and `self` is checked first
 * because it is the more specific statement about the same handle.
 */
export function mayRouteExist(q: RouteQuestion): RouteVerdict {
  if (q.senderHandle === q.targetHandle) return { allowed: false, refusal: 'self' }
  /**
   * The wider case, and the one that actually bites. `@bollywoodsocietyy` and
   * `@bollywoodchronicle` are fleet SENDERS *and* CHANNEL target rows (retired as message
   * targets by Tabish on 2026-08-07, kept as watched pages for ground truth). Without this
   * clause `@madaboutmarketingg` is paired to `@bollywoodsocietyy` and one revenue page
   * cold-pitches another. Compared on HANDLE rather than id, because a sender row and a
   * target row for the same account are two DIFFERENT rows with two different ids — an id
   * comparison here would be silently always false.
   */
  if (q.ourHandles.has(q.targetHandle)) return { allowed: false, refusal: 'target-is-our-own-page' }
  if (q.targetOptedOut) return { allowed: false, refusal: 'target-retired' }
  return { allowed: true }
}

/** The same question, when only the boolean answer is wanted (a `.filter` predicate). */
export function routeAllowed(q: RouteQuestion): boolean {
  return mayRouteExist(q).allowed
}

/**
 * Every FLEET page's handle, for `ourHandles` above.
 *
 * A helper rather than the same query written at five call sites, because
 * `where: { fleetMember: true }` is the load-bearing part — a call site that dropped the
 * filter would widen the rule and retire the burner as a rehearsal target, and one that
 * added a different filter would narrow it. One spelling, one meaning.
 *
 * Takes the client as an argument so this module keeps no database import of its own.
 * `routes.ts` therefore stays reachable from anywhere, including a client component — the
 * trap that returned HTTP 500 on EVERY route on 2026-08-06, when `waiting.tsx` imported a
 * guard that reached `gate.ts` → `profile.ts` → `better-sqlite3` and could not resolve `fs`.
 */
export async function fleetHandles(db: {
  senderAccount: {
    findMany: (args: {
      where: { fleetMember: true }
      select: { handle: true }
    }) => Promise<{ handle: string }[]>
  }
}): Promise<Set<string>> {
  const fleet = await db.senderAccount.findMany({ where: { fleetMember: true }, select: { handle: true } })
  return new Set(fleet.map((s) => s.handle))
}
