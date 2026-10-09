/**
 * TWO FLEETS, ONE SYSTEM — which senders may write to which recipients.
 *
 * ── TABISH'S RULE, 2026-08-25 ─────────────────────────────────────────────
 *
 * *"we are to have two categories of senders and monitoring targets. The first category is
 * whatever is happening now for both senders and targets (these can be dubbed category one or
 * bollywood category), the second category would consist of target channels: madovermarketing,
 * socialsamosa, afaqs, exchange4media, Marketingmentalist … Only targets obtained from them
 * are to be messaged using a new sender that I would be adding … Thus brand category senders
 * must never send messages to targets … discovered via bollywood categories' monitoring
 * targets and vice versa."*
 *
 * And the exception, in his own parenthesis: *"unless they are present common elsewhere"* — a
 * company that BOTH fleets have found is reachable by both.
 *
 * ── "NO CATEGORY" IS THE DEFAULT CATEGORY, AND THAT IS THE WHOLE DESIGN ───
 *
 * The obvious implementation is to tag every existing sender and every existing target
 * `bollywood` and compare sets. That is ~500 target rows and 5 sender rows of migration
 * before anything works, and it rewrites the input of a rotation that is currently delivering
 * — the ring-resize hazard this project has already paid for once (36 surplus drafts, one
 * recipient at a time, when removing a sender changed the hash spread).
 *
 * So an ABSENT membership is read as the default category instead:
 *
 *     effective([])                 -> ['bollywood']
 *     effective(['marketing'])      -> ['marketing']
 *
 * and a route is allowed when the two effective sets intersect. Every case falls out, and the
 * bollywood half needs no migration at all:
 *
 *   | sender            | target                     | verdict |
 *   |-------------------|----------------------------|---------|
 *   | (none) = bollywood| (none) = bollywood         | ALLOWED — today's fleet, unchanged |
 *   | marketing         | (none) = bollywood         | refused |
 *   | (none) = bollywood| marketing                  | refused |
 *   | marketing         | marketing                  | ALLOWED |
 *   | (none) = bollywood| [bollywood, marketing]     | ALLOWED — "common elsewhere" |
 *   | marketing         | [bollywood, marketing]     | ALLOWED — "common elsewhere" |
 *
 * A THIRD category costs one `Category` row and tagging its own senders and channels; nothing
 * here changes. That is what "futureproof in case we need to add anything to both categories"
 * asks for, and it is why this is a set intersection rather than a pair of booleans.
 *
 * ── WHERE IT IS ENFORCED ──────────────────────────────────────────────────
 *
 * Both ends, like every load-bearing rule here:
 *   `routes.ts`  refuses to CREATE a cross-category pair, so the queue never fills with them
 *   `gate.ts`    refuses to SEND one, catching anything written before the rule
 * and rotation never ELECTS a sender it may not use, so a recipient's own fleet takes its turn
 * rather than the pair being written and then held.
 *
 * PURE. No I/O, no clock.
 */

/**
 * The category a row belongs to when it carries no membership of its own.
 *
 * NOT a magic string at three call sites: the whole safety of the scheme is that the default
 * is the SAME on both sides of the comparison, and two spellings of it would silently make
 * every legacy route cross-category — i.e. would stop the fleet.
 */
export const DEFAULT_CATEGORY_SLUG = 'bollywood'

/** The slug of the second fleet. Its channels are watched; its prospects are messaged only by its own senders. */
export const MARKETING_CATEGORY_SLUG = 'marketing'

/**
 * The monitoring channels of the second category, as Tabish listed them.
 *
 * `madovermarketing_mom` is the handle we already watch — his list says "madovermarketing",
 * and the account is the same one. Recorded here rather than typed into a seed script so the
 * list is greppable and the next channel is one line.
 */
export const MARKETING_CHANNEL_HANDLES = [
  'madovermarketing_mom',
  'socialsamosa',
  'afaqs',
  'exchange4media',
  'marketingmentalist',
] as const

/** An absent membership means the default category. Never an empty set — see the docblock. */
export function effectiveCategories(slugs: readonly string[]): string[] {
  const cleaned = [...new Set(slugs.map((s) => s.trim().toLowerCase()).filter(Boolean))]
  return cleaned.length > 0 ? cleaned : [DEFAULT_CATEGORY_SLUG]
}

/**
 * May this sender write to this recipient, on category grounds alone?
 *
 * Says nothing about the badge, the allowance, spacing or a reply — every one of those is
 * asked separately and all of them still apply. This answers ONE question: are they in the
 * same fleet.
 */
export function sameCategory(
  senderSlugs: readonly string[],
  targetSlugs: readonly string[],
): boolean {
  const s = new Set(effectiveCategories(senderSlugs))
  return effectiveCategories(targetSlugs).some((t) => s.has(t))
}

/**
 * The sentence a refusal shows. ONE writer, shared by `routes.ts`, `gate.ts` and the screen,
 * so a page can never describe this hold by a different rule than the one enforcing it.
 */
export function crossCategoryDetail(
  senderSlugs: readonly string[],
  targetSlugs: readonly string[],
): string {
  const s = effectiveCategories(senderSlugs).join(', ')
  const t = effectiveCategories(targetSlugs).join(', ')
  return `this page sends for ${s} and this recipient belongs to ${t} — the two fleets never write to each other's companies`
}

/**
 * WHICH CATEGORY DOES EACH SENDER AND EACH RECIPIENT BELONG TO — the SHAPE of the answer.
 *
 * The reader (`readCategoryMemberships`, two queries for the whole fleet) lives in
 * `categories.ts`, which touches the database. The shape and the lookups over it live
 * here, beside `sameCategory`, so a PURE module (`crossSpacing.ts`, which `governor.ts`
 * imports) can apply the fleet rule without importing Prisma. `categories.ts` re-exports
 * both, so every existing import keeps working.
 *
 * Keyed by HANDLE, because `routes.ts` asks in handles — a sender row and a target row for
 * the same account are two different ids, and an id-keyed map would silently answer for the
 * wrong one.
 *
 * An EMPTY list for a handle is the correct and common answer, and it does not mean
 * "unrestricted": `effectiveCategories` reads it as the default category.
 */
export interface CategoryMemberships {
  bySenderHandle: ReadonlyMap<string, string[]>
  byTargetHandle: ReadonlyMap<string, string[]>
}

/** The categories one handle belongs to, or `[]` — which `effectiveCategories` reads as the default. */
export function categoriesFor(map: ReadonlyMap<string, string[]>, handle: string): readonly string[] {
  return map.get(handle.toLowerCase()) ?? []
}

/**
 * THE PAGES THAT CAN WRITE TO THIS RECIPIENT ON CATEGORY GROUNDS — the ONE fleet filter.
 *
 * Two questions ask it and they must not disagree (rule 45, *every ring passes through the
 * fleet filter*):
 *
 *   rotation       who may be ELECTED to write next (`ringMembersFor` delegates here)
 *   the ring rule  who counts as "all our pages" for the 7-day rest (`crossSpacingVerdict`)
 *
 * M12, 2026-10-09: the ring rule counted the WHOLE fleet. @madaboutmarketingg holds only
 * `marketing`, so it can never deliver to a bollywood recipient — `routes.ts` refuses the
 * route, `gate.ts` refuses the send, rotation never elects it — and "every page has written"
 * was therefore unsatisfiable for every bollywood recipient. The rest Tabish asked for
 * ("the 7 day constraint … only if target has been contacted by all targets") never fired
 * on the fleet that sends most. A page that can never write here is not one of "all".
 */
export function fleetMembersFor<T extends { handle: string }>(
  senders: readonly T[],
  targetHandle: string,
  memberships: CategoryMemberships,
): T[] {
  const targetCats = categoriesFor(memberships.byTargetHandle, targetHandle)
  return senders.filter((s) => sameCategory(categoriesFor(memberships.bySenderHandle, s.handle), targetCats))
}
