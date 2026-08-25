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
import { sameCategory } from './senderCategories'

export type RouteRefusal =
  | 'self'
  | 'sender-not-in-fleet'
  | 'target-is-our-own-page'
  | 'target-retired'
  | 'target-is-watch-only'
  | 'different-category'

export interface RouteQuestion {
  /**
   * Category slugs this SENDER belongs to. EMPTY means the default category — see
   * `senderCategories.ts`; it is not "no restriction", it is `['bollywood']`.
   *
   * Required rather than optional so the compiler names every call site the day a third
   * category appears — the `RenderTarget.kind` pattern, which has caught a silently-defaulting
   * caller twice in this codebase.
   */
  senderCategories: readonly string[]
  /** Category slugs this RECIPIENT belongs to. Empty means the default category. */
  targetCategories: readonly string[]
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
   * The burner never SENDS on a schedule regardless — see `senderIsFleetMember` below,
   * which is where that now lives.
   */
  ourHandles: ReadonlySet<string>
  /**
   * `SenderAccount.fleetMember` — is this account part of the automatic rotation?
   *
   * ── WHY THIS MOVED HERE, AND WHAT IT MEASURED ────────────────────────────────────────
   *
   * Until 2026-08-13 this file said the burner's routes were "excluded at the query rather
   * than here", because `ensureFleetPairs` and `runOutreach` both scope to
   * `fleetMember: true`. True, and it left the rows in place — and the whole content of the
   * 2026-08-08 change is that **a pair row IS a live route**. Excluding at the query means
   * the route exists and one query happens not to read it.
   *
   * MEASURED on the live database: `@tabishmukaddam1` is `fleetMember: false` and held
   * **72 pair rows** — every BRAND target discovered, plus both channels. Not one of the
   * three creators that make them (`addTarget`, `brandTarget`, `importProspects`) filtered
   * on fleet membership; each read `senderAccount.findMany()` unfiltered, and `addTarget`'s
   * own comment defended that, on the reasoning that scoping would "silently stop creating
   * the burner's rehearsal routes". It would — and rehearsal does not need them:
   * `prepareOnDemandSend` CREATES the one pair it needs when a person picks a sender and a
   * recipient, which is the exempt path in `tests/one-route-rule.test.ts`. So the 72 rows
   * bought nothing and stood one query-scope away from being routes to real companies from
   * the one account that must never do outreach.
   *
   * Note what this does NOT do: the burner stays MESSAGEABLE as a target. That is
   * `ourHandles` above, which is fleet-only for exactly this reason, and the two facts are
   * independent — a non-fleet account may receive, and may not automatically send.
   */
  senderIsFleetMember: boolean
  /**
   * `TargetAccount.optedOut` — retirement. Housekeeping here rather than the promise: the
   * promise is kept by `governor.ts` and again by `gate.ts` at delivery, which is why
   * retirement is a flag on the TARGET and never a missing pair row.
   */
  targetOptedOut: boolean
  /**
   * `TargetAccount.role` — WATCH or PROSPECT. A WATCH row is a publisher whose feed we read
   * to find paid posts, and it must never be written to.
   *
   * ── WHY THIS IS A FIELD AND NOT DERIVED FROM `kind` HERE ─────────────────
   *
   * MEASURED the day it was added: @viralbhayani and @madovermarketing_mom are our two
   * COMPETITORS, each held 13 attempts and 4 pairs, and 6 drafts to them were waiting to
   * go out. Nothing in this file — four refusals — was about what a target IS.
   *
   * Deriving it from `kind === 'CHANNEL'` was the obvious fix and is wrong: `importProspects`
   * writes messageable prospects as CHANNEL, so that rule would have stopped messaging every
   * imported prospect. The column exists precisely so this predicate does not have to guess.
   * See the docblock on `TargetAccount.role`.
   */
  targetIsWatchOnly: boolean
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
   * The sender side, checked before anything about the target: an account outside the
   * rotation has no automatic route to ANY recipient, so nothing about who the recipient is
   * can make one allowable. `prepareOnDemandSend` is the deliberate exception and does not
   * come through here — a person choosing both ends and being shown every rule they cross
   * is a different act from a route appearing because a brand was discovered.
   */
  if (!q.senderIsFleetMember) return { allowed: false, refusal: 'sender-not-in-fleet' }
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
  /**
   * The COMPETITOR clause, and the one this file was missing entirely.
   *
   * A WATCH row is a publisher we read to find who is buying placement FROM them. Writing
   * to one is writing to a competitor, and it is what the system was doing: 26 attempts and
   * 8 pairs across @viralbhayani and @madovermarketing_mom, 6 of them still waiting to send.
   *
   * Checked LAST because the refusals above are more specific statements about the same
   * row — an opted-out WATCH channel should still report `target-retired`, which is the
   * fact an operator can act on.
   */
  if (q.targetIsWatchOnly) return { allowed: false, refusal: 'target-is-watch-only' }
  /**
   * ── THE TWO FLEETS NEVER WRITE TO EACH OTHER'S COMPANIES (2026-08-25) ────
   *
   * Tabish: *"brand category senders must never send messages to targets … discovered via
   * bollywood categories' monitoring targets and vice versa."* An absent membership on either
   * side means the DEFAULT category, so today's fleet and today's recipients keep routing to
   * each other with no migration — see `senderCategories.ts` for the full table.
   *
   * Checked LAST, after every refusal that is a more specific statement about the row: a
   * retired marketing recipient should still report `target-retired`, which is the fact an
   * operator can act on.
   */
  if (!sameCategory(q.senderCategories, q.targetCategories)) {
    return { allowed: false, refusal: 'different-category' }
  }
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
