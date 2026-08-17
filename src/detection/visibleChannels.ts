import { prisma } from '@/lib/db'

/**
 * WHICH CHANNELS' POSTS BELONG ON A SCREEN A PERSON READS.
 *
 * ── THE PROBLEM THIS SOLVES ───────────────────────────────────────────────
 *
 * `@bollywoodsocietyy` and `@bollywoodchronicle` are OUR OWN PAGES. They are watched
 * because watching a page we own is ground truth rather than prospecting — we know which of
 * our own posts were paid — and that reason is still good, so their rows are kept.
 *
 * What was wrong is that **not one `DetectedCampaign` query on the dashboard filtered by
 * channel**, so every figure on `/paid-posts` silently described them too. MEASURED
 * 2026-08-17:
 *
 *     their in-window posts        1,555 of 2,608   →  59.6% of every number on the page
 *     rendered as paid findings       37 rows       →  12% of the posts table
 *     sitting in the review queue      5 of 26      →  the dashboard asking a person
 *                                                      whether OUR OWN page's post was paid
 *
 * That last one is what Tabish actually noticed, and it is the whole complaint: the system
 * was asking him to judge the commercial intent of a page he owns.
 *
 * ── WHY EXCLUDE AND NOT DELETE ────────────────────────────────────────────
 *
 * Deleting the two `TargetAccount` rows cascades away **1,739 `DetectedCampaign` rows that
 * can never be recovered** — the anonymous feed is a 48-post window, so a post that scrolls
 * out cannot be re-scraped by anything, ever. It would also destroy the only labelled
 * ground truth this system holds about pages whose paid posts we actually know.
 *
 * And it is genuinely dangerous: the SAME handles exist as `SenderAccount` rows with
 * DIFFERENT ids. Deleting the wrong one takes out the accounts that send, plus 158 attempts
 * of real send history.
 *
 * ── WHY ONE PREDICATE AND NOT A FILTER AT EACH SITE ───────────────────────
 *
 * There are ~12 query sites. Fixing them one at a time is how this codebase produced its
 * most repeated bug — one rule with several callers, a fix landing in some of them:
 * `gate.ts`, `readThread.ts`, the two Connect buttons, and `judge.ts` all drifted that way,
 * and `tests/one-judging-path.test.ts` exists because a COMMENT claiming otherwise was
 * already there and untrue.
 *
 * So: one function, and `tests/visible-channels.test.ts` greps the source to assert no
 * dashboard query omits it — because the failure mode is a query nobody has written yet,
 * and no behavioural test can fail for that.
 *
 * ── WHAT IT DOES NOT TOUCH, DELIBERATELY ──────────────────────────────────
 *
 * Detection, storage, `buildVocabulary` and `ig:accuracy` all keep reading every channel.
 * This is a rule about a SCREEN, not about the corpus: the novelty filter learns each
 * channel's normal vocabulary from every stored caption, and the accuracy harness needs
 * every label it can get. Narrowing either would be the "fix for a confusing number was
 * scope, never deletion" lesson thrown away one layer down.
 */

/** A page we own. Its posts are ground truth for us, and noise to a reader. */
const OUR_OWN_PAGES: readonly string[] = ['bollywoodsocietyy', 'bollywoodchronicle', 'tabishmukaddam1']

/**
 * Target ids whose posts a person should see, cached per request.
 *
 * Resolved from handles rather than stored as ids, because a sender row and a target row
 * for one account are two different rows with two different ids — the same trap `routes.ts`
 * documents, and the reason it compares on handle.
 */
export async function visibleChannelIds(): Promise<string[]> {
  const rows = await prisma.targetAccount.findMany({
    where: { handle: { notIn: [...OUR_OWN_PAGES] } },
    select: { id: true },
  })
  return rows.map((r) => r.id)
}

/**
 * The `where` fragment to spread into any dashboard query over `DetectedCampaign`.
 *
 * Returns a `targetId: { in: [...] }` clause. Spread it, do not replace an existing
 * `targetId` — a query already scoped to one channel is asking a different question and
 * does not need this.
 */
export async function visibleChannelFilter(): Promise<{ targetId: { in: string[] } }> {
  return { targetId: { in: await visibleChannelIds() } }
}

/** Exported for the test and for anything that needs to explain the exclusion on screen. */
export function ourOwnPageHandles(): readonly string[] {
  return OUR_OWN_PAGES
}
