import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { ourOwnPageHandles } from '@/detection/visibleChannels'

/**
 * ── OUR OWN PAGES MUST NOT APPEAR ON A SCREEN, AND THE FAILURE MODE IS A QUERY
 *    NOBODY HAS WRITTEN YET ───────────────────────────────────────────────
 *
 * `@bollywoodsocietyy` and `@bollywoodchronicle` are pages we own. They are watched because
 * watching a page we own is ground truth rather than prospecting, and their rows are kept
 * for exactly that. What was wrong is that no dashboard query filtered by channel, so
 * MEASURED 2026-08-17:
 *
 *     1,555 of 2,608 in-window posts were ours   →  59.6% of every figure on /paid-posts
 *     5 of the 26 open review rows were ours     →  the dashboard asking a person whether
 *                                                    OUR OWN page's post was paid
 *
 * A behavioural test cannot fail for a query that does not exist yet, which is precisely
 * how one rule with several callers has bitten this repo five times (`gate.ts`,
 * `readThread.ts`, the two Connect buttons, `judge.ts`). So this is a SOURCE GREP, like
 * `tests/one-route-rule.test.ts` and `tests/tag-evidence.test.ts`.
 *
 * It counts what it matches. A grep that matches nothing reports success, and
 * `tag-evidence.test.ts` shipped in exactly that state — matching ZERO calls in `judge.ts`
 * and passing vacuously.
 */

const root = join(import.meta.dirname, '..')
const read = (p: string) => readFileSync(join(root, p), 'utf8')

/**
 * Files that render `DetectedCampaign` figures to a person. Detection, storage,
 * `buildVocabulary` and `ig:accuracy` are deliberately NOT here — they must keep reading
 * every channel, and narrowing them would degrade the novelty filter and the accuracy
 * harness. This rule is about a screen, not about the corpus.
 */
/**
 * ── THE LIST WAS ONE FILE, AND TWO UNSCOPED QUERIES LIVED OUTSIDE IT ──────
 *
 * MEASURED 2026-08-26, from Tabish reading two numbers for "paid posts" side by side and
 * asking what the difference was:
 *
 *   `src/app/nav.tsx`               the sidebar badge — no channel scope at all, so it
 *                                   counted our own three pages on a rail linking to a page
 *                                   that excludes them, and on a different clock as well.
 *   `src/app/view-model/charts.ts`  the verdict chart — no channel scope, sitting directly
 *                                   under an Analytics tile computed WITH one.
 *
 * Neither was a rule anybody had removed. Both were simply not read: this constant named a
 * single file while dashboard figures had spread into `src/app/view-model/` and `nav.tsx`.
 * The docblock above says the failure mode is *"a query nobody has written yet"*; these were
 * queries nobody GREPPED, which is the same hole one level up.
 *
 * DISCOVERED rather than listed, so the next view model is covered on the day it is written
 * — a hand-maintained list is what failed here, and re-hand-maintaining it would be the same
 * bet twice.
 */
function dashboardFiles(): string[] {
  const out = ['src/app/nav.tsx', 'src/app/view-model.ts']
  const dir = join(root, 'src/app/view-model')
  for (const name of readdirSync(dir)) if (name.endsWith('.ts')) out.push(`src/app/view-model/${name}`)
  return out
}

const DASHBOARD_FILES = dashboardFiles()

describe('our own pages are excluded from every dashboard figure', () => {
  it('the exclusion list names the pages we own', () => {
    const ours = ourOwnPageHandles()
    expect(ours).toContain('bollywoodsocietyy')
    expect(ours).toContain('bollywoodchronicle')
  })

  /**
   * Every `detectedCampaign` query in a dashboard file must be scoped — by spreading
   * `inWindow` (which carries the filter), by calling `visibleChannelFilter()` directly, or
   * by already being scoped to ONE channel via `targetId`, which is a different question and
   * does not need it.
   */
  it('every dashboard DetectedCampaign query carries a channel scope', () => {
    let checked = 0
    const unscoped: string[] = []

    for (const file of DASHBOARD_FILES) {
      const src = read(file)
      const lines = src.split('\n')
      lines.forEach((line, i) => {
        if (!/prisma\.detectedCampaign\.(count|findMany|findFirst|groupBy|aggregate)/.test(line)) return
        checked += 1
        // The query's arguments may run onto following lines.
        const window = lines.slice(i, i + 14).join('\n')
        const scoped =
          window.includes('inWindow') ||
          window.includes('visibleChannelFilter') ||
          /targetId:\s*(t\.id|target\.id|[a-zA-Z]+\.id)/.test(window) ||
          window.includes('shortcode: { in:') ||
          // A lookup BY ID is not a survey of the corpus — it resolves rows already chosen.
          window.includes('id: { in: campaignIds }') ||
          /**
           * ── THE PROVENANCE LOOKUPS (2026-08-31) ────────────────────────────
           *
           * "Why was this message sent, and for which paid post?" is answered from two
           * stored columns. `attempt.campaignId` is a real relation and needs no query;
           * `target.discoveredFromCampaignId` is a bare scalar, so the posts it points at
           * are resolved in ONE batched read keyed on ids the rows already carry.
           *
           * Not a survey, and scoping it would be a BUG rather than a tightening: the id
           * comes from the recipient's own provenance, so a channel filter could only
           * blank the answer for a company discovered from a page that later became ours —
           * silently turning "here is why we wrote to them" into an em-dash. Same shape as
           * the enforcer preloads below: the question is not a figure anybody totals.
           *
           * The VARIABLE NAMES are the carve-out, as with `cardTargetIds` — a looser
           * pattern like any `id: { in: … }` would also accept a survey over every campaign
           * id somebody had gathered first.
           */
          window.includes('id: { in: provenanceIds }') ||
          /**
           * The batched channel cards (2026-08-20): `buildChannelCards` went from five
           * queries PER channel to five `groupBy`s over `cardTargetIds` — the exact rows
           * the caller already chose — when 11 new watch pages made the per-row loop blow
           * four pages' query budgets at once. The same scope as `targetId: t.id`, N rows
           * at a time. The VARIABLE NAME is the carve-out, deliberately: a looser pattern
           * like any `targetId: { in: ... }` would also accept a survey over every channel
           * id, which is the exact query this grep exists to refuse.
           */
          window.includes('targetId: { in: cardTargetIds }') ||
          /**
           * The paid-posts table and its pager (2026-08-25) share ONE named predicate,
           * `postsWhere`, because a count that scopes differently from the rows it counts is
           * a pager that lies about where the end is. The VARIABLE NAME is the carve-out for
           * the same reason as `cardTargetIds` above — and it only launders the scope
           * because the test directly below PROVES `postsWhere` is built by spreading
           * `inWindow`. Without that second assertion this line would be a hole.
           */
          window.includes('where: postsWhere') ||
          /**
           * ── THE ENFORCER PRELOADS, AND THEY MUST NOT BE SCOPED (2026-08-26) ──
           *
           * `messages-page.ts` and `rest-tally.ts` each load the in-window CAMPAIGN posts
           * ONCE and hand `campaignsNamingHandleRows` a stub whose `findMany` serves them —
           * the fix for a per-draft and a per-prospect N+1 that put `/` at 163 against a 160
           * budget. What comes back is the MATERIAL ALLOWANCE's input, not a figure anybody
           * reads.
           *
           * Scoping it would be a bug, not a tightening. `plan.ts` and `gate.ts` — the rule
           * itself — query every channel, so a view model that narrowed the same input would
           * report a hold the planner does not apply and clear one it does. That is exactly
           * the defect found in this same file's delivery count on the same day, and it is
           * the reason this file's own docblock says the rule is *about a screen, not about
           * the corpus*.
           *
           * The carve-out is the enforcer's exact PROJECTION rather than a variable name,
           * because that shape is what makes it an allowance input; and the test directly
           * below proves the enforcer really is unscoped, so this cannot quietly become
           * wrong the day that changes.
           */
          window.includes('select: { id: true, postedAt: true, caption: true, taggedAccounts: true, brands: true }')
        if (!scoped) unscoped.push(`${file}:${i + 1}  ${line.trim().slice(0, 90)}`)
      })
    }

    // The grep must actually be looking at something, or it passes vacuously.
    expect(checked, 'no detectedCampaign queries matched — this grep is not testing anything').toBeGreaterThan(8)
    expect(unscoped, 'a dashboard query reads every channel, including pages we own').toEqual([])
  })

  /**
   * THE CARVE-OUT ABOVE IS ONLY SAFE WHILE THIS IS TRUE. The preloads are exempt because
   * they mirror the enforcer; if the enforcer ever gained a channel scope they would have to
   * gain one too, and the exemption would silently hide the mismatch. Asserted rather than
   * described, for the same reason `postsWhere`'s carve-out is backed by a proof.
   */
  it('the material allowance itself reads every channel, which is why its preloads may too', () => {
    const src = read('src/outreach/materialAllowance.ts')
    expect(src, 'the allowance has gained a channel scope — the preload carve-out is now a hole').not.toContain(
      'visibleChannelFilter',
    )
  })

  /**
   * THE CARVE-OUT ABOVE IS ONLY SAFE IF THE NAME IT TRUSTS IS ITSELF SCOPED.
   *
   * `postsWhere` lets two queries pass the grep. If someone later rebuilt it without
   * `...inWindow` — say to "simplify" the channel filter — both the paid-posts table and its
   * total would quietly start surveying every channel including our own pages, and the grep
   * would keep passing because it is matching a variable name. So the definition is pinned
   * here, and this assertion is the thing standing behind that line.
   */
  it('postsWhere — the one name the grep trusts — is itself channel-scoped', () => {
    const src = read('src/app/view-model.ts')
    const at = src.indexOf('const postsWhere = {')
    expect(at, 'postsWhere is gone or renamed — re-check the carve-out above').toBeGreaterThan(-1)
    /* The declaration only; 400 chars is comfortably past its closing brace and nowhere near
       the next query, so this cannot pass on some other object's scope. */
    const def = src.slice(at, at + 400)
    expect(def, 'postsWhere no longer spreads inWindow').toContain('...inWindow')
  })

  /**
   * And the channel CARDS. They rendered every `kind: 'CHANNEL'` row with no filter, so our
   * own retired pages appeared as watched channels on `/` and `/paid-posts`, each stating a
   * post count and an accuracy note about a page we own.
   */
  it('the channel cards query excludes our own pages', () => {
    const src = read('src/app/view-model.ts')
    expect(src).toMatch(/role:\s*'WATCH',\s*handle:\s*\{\s*notIn:\s*\[\.\.\.ourOwnPageHandles\(\)\]/)
    // And the old unscoped form is gone rather than merely joined by a new one.
    expect(src.includes("where: { kind: 'CHANNEL' },")).toBe(false)
  })
})
