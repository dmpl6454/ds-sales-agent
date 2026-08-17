import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
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
const DASHBOARD_FILES = ['src/app/view-model.ts']

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
          window.includes('id: { in: campaignIds }')
        if (!scoped) unscoped.push(`${file}:${i + 1}  ${line.trim().slice(0, 90)}`)
      })
    }

    // The grep must actually be looking at something, or it passes vacuously.
    expect(checked, 'no detectedCampaign queries matched — this grep is not testing anything').toBeGreaterThan(8)
    expect(unscoped, 'a dashboard query reads every channel, including pages we own').toEqual([])
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
