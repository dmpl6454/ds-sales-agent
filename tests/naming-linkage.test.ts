import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { campaignsNamingHandleRows, campaignsNamingHandle } from '@/outreach/materialAllowance'

/**
 * "WHICH PAID POSTS NAME THIS RECIPIENT?" HAS ONE IMPLEMENTATION — 2026-08-22.
 *
 * ── THE DEFECT, FOUR TIMES ────────────────────────────────────────────────
 *
 * `DetectedCampaign.targetId` is the CHANNEL THAT POSTED. It is never the brand named in
 * the post. So every query of the form
 *
 *     detectedCampaign.count({ where: { targetId: <recipient>, verdict: 'CAMPAIGN' } })
 *
 * returns **zero for every prospect, forever**. That query existed in FOUR places:
 *
 *   1. `materialAllowance` — found 2026-08-21 when the unlock half of Tabish's rule could
 *      never fire and the fleet went quiet (`skipped=851 queued=0`). Fixed then.
 *   2. `plan.ts`, inlined — the PLANNER's own copy, unfixed, so `NO_NEW_MATERIAL` refused
 *      every follow-up to every prospect permanently.
 *   3. `compose.ts` `unusedCampaignCount` — the same, for the on-demand path.
 *   4. `compose.ts` `pickHook` — the same, so a hook could never be found for a prospect.
 *
 * MEASURED the morning it was found, from Tabish asking why sending had stopped:
 * @amazonmgmstudios had **17 paid posts naming it inside the window and 5 messages, capped
 * forever**; 40 recipients the allowance would have permitted another message to were
 * refused by every sender. Each (sender → prospect) pair could send exactly one message
 * ever — the first touch, which is exempt by construction — and never another.
 *
 * ── WHAT FIXING IT ACTUALLY RELEASED, MEASURED BOTH WAYS ──────────────────
 *
 * The planner's skip breakdown, same corpus, before and after:
 *
 *     before   no-new-material-to-reference = 137   target-recently-contacted =   0
 *     after    no-new-material-to-reference =   0   target-recently-contacted = 135
 *
 * i.e. the refusal moved from a rule that COULD NOT PASS to the rule Tabish actually
 * specified — the seven-day rest once every page has written — and two drafts released.
 * That is the shape a blindfold-removal should have: the guard that remains is the one with
 * a satisfiable precondition. *"A fail-closed guard with an unsatisfiable precondition is a
 * blindfold wearing a seatbelt."*
 */

const root = join(import.meta.dirname, '..')
const read = (p: string) => readFileSync(join(root, p), 'utf8')

/** Every .ts under src, so a fifth copy in a new file cannot hide from this. */
const SOURCES = (() => {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'generated' || entry === 'node_modules') continue
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) walk(full)
      else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) out.push(full)
    }
  }
  walk(join(root, 'src'))
  return out
})()

/** Comments stripped: prose describing the old bug must not read as the old bug. */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

describe('no query asks DetectedCampaign.targetId for a RECIPIENT', () => {
  it('found the sources', () => {
    expect(SOURCES.length).toBeGreaterThan(50)
  })

  /**
   * A SOURCE GREP, because the failure mode is a query somebody writes NEXT. No behavioural
   * test can fail for a fifth copy that does not exist yet — the same reasoning as
   * `tests/one-route-rule.test.ts` and the visible-channels grep.
   *
   * `targetId` on a DetectedCampaign query is legitimate when the question really is about
   * the POSTING CHANNEL (detection, per-channel counts, the paid-posts table). What must
   * never appear again is `targetId: pair.targetId` / `targetId: <a recipient>` — a
   * recipient's id used as if it were the publisher's.
   */
  /**
   * THE VARIABLE NAME IS THE CARVE-OUT, exactly as it is in the visible-channels grep.
   *
   * `targetId: target.id` is CORRECT in detection, classification and re-judging: there,
   * `target` IS the watched publisher whose feed produced the post, which is what the
   * column means. The ambiguity is real and cannot be resolved by a regex — so this flags
   * only the names that unambiguously denote SOMEBODY WE MESSAGE (`pair.targetId`,
   * `pair.target.id`, `recipient.id`). Those five legitimate detection uses were checked by
   * hand when this test was written; the two that were NOT legitimate — `scripts/generate.ts`
   * and `scripts/preview.ts`, both claiming to mirror the planner — were found by this grep
   * on its first run and fixed.
   */
  it('no detectedCampaign query keys targetId off a PAIR or a recipient', () => {
    const offenders: string[] = []
    for (const file of SOURCES) {
      /* SOURCES are absolute — read them directly, not through the root-relative helper. */
      const src = code(readFileSync(file, 'utf8'))
      for (const m of src.matchAll(/targetId:\s*(pair\.targetId|pair\.target\.id|recipient\.id)\b/g)) {
        /* Only flag it when it sits inside a detectedCampaign query. */
        const before = src.slice(Math.max(0, m.index! - 400), m.index!)
        if (/detectedCampaign\.(count|findMany|findFirst|groupBy|aggregate)\s*\(/.test(before)) {
          offenders.push(`${file.split('/src/')[1]}: ${m[0]}`)
        }
      }
    }
    expect(offenders, 'a recipient id used as DetectedCampaign.targetId — see this file').toEqual([])
  })

  /** And the grep must be able to FAIL, or it is decoration. */
  it('the grep catches the exact shape it exists for', () => {
    const bad = `await prisma.detectedCampaign.count({ where: { targetId: pair.targetId, verdict: 'CAMPAIGN' } })`
    const hits = [...code(bad).matchAll(/targetId:\s*(pair\.targetId|pair\.target\.id|recipient\.id)\b/g)]
    expect(hits).toHaveLength(1)
    const before = bad.slice(0, hits[0]!.index!)
    expect(/detectedCampaign\.(count|findMany|findFirst|groupBy|aggregate)\s*\(/.test(before)).toBe(true)
  })

  /**
   * ── THE SHARED LINKAGE, NOW REACHED ONE LAYER UP FROM plan.ts (2026-09-01) ──
   *
   * `compose.ts` still calls `campaignsNamingHandleRows` directly. `plan.ts` no longer
   * does, and that is a strengthening rather than a regression: it used to filter the rows
   * with its own inline `usedCampaignIds(pair.id)` — a THIRD reading of "what has this pair
   * already written about". With the claim ledger going per-RECIPIENT that third copy would
   * have excluded a different set from `pickHook`, so the governor could report "there is
   * new material" and the composer then find none. `freshCampaignsFor` is the one selector,
   * and it is what `plan.ts` asks.
   *
   * So the accepted call is either the linkage itself or the selector built on it — and the
   * assertion directly below PROVES the selector really does ask the linkage, which is what
   * keeps this from being a name that launders a re-implementation (the `postsWhere`
   * discipline in tests/visible-channels.test.ts).
   */
  it('the three former copies now call the shared linkage, or the one selector built on it', () => {
    for (const f of ['src/outreach/plan.ts', 'src/outreach/compose.ts']) {
      expect(code(read(f)), `${f} must ask the shared function`).toMatch(
        /campaignsNamingHandleRows\(|freshCampaignsFor\(/,
      )
    }
  })

  it('freshCampaignsFor — the name plan.ts trusts — is itself built on the linkage', () => {
    const src = code(read('src/outreach/compose.ts'))
    const at = src.indexOf('export async function freshCampaignsFor')
    expect(at, 'freshCampaignsFor is gone or renamed — re-check the carve-out above').toBeGreaterThan(-1)
    const body = src.slice(at, at + 800)
    expect(body, 'freshCampaignsFor no longer asks campaignsNamingHandleRows').toMatch(
      /campaignsNamingHandleRows\(/,
    )
    /* And that it excludes BOTH sets: the pair's own claims and the whole recipient's. A
       version that dropped the second would silently restore the four-messages-under-one-post
       ledger collapse of 2026-09-01. */
    expect(body, 'the per-pair arm of the exclusion is gone').toMatch(/usedCampaignIds\(/)
    expect(body, 'the per-recipient arm of the exclusion is gone — the claim ledger is back to per-pair').toMatch(
      /claimedCampaignIds\(/,
    )
  })
})

describe('campaignsNamingHandleRows — the one linkage, both directions', () => {
  const floor = new Date('2026-08-15T00:00:00Z')
  const rows = [
    { id: 'a', postedAt: new Date('2026-08-20T00:00:00Z'), caption: 'promo with @amazonmgmstudios', taggedAccounts: '[]', brands: '[]' },
    { id: 'b', postedAt: new Date('2026-08-21T00:00:00Z'), caption: 'no mention', taggedAccounts: '["amazonmgmstudios"]', brands: '[]' },
    { id: 'c', postedAt: new Date('2026-08-19T00:00:00Z'), caption: 'no mention', taggedAccounts: '[]', brands: '["Amazon MGM Studios"]' },
    { id: 'd', postedAt: new Date('2026-08-18T00:00:00Z'), caption: 'unrelated @someoneelse', taggedAccounts: '[]', brands: '["fg6"]' },
  ]
  const stub = { detectedCampaign: { findMany: async () => rows } }
  const prospect = { handle: 'amazonmgmstudios', displayName: 'Amazon MGM Studios' }

  it('returns the mention, the tag and the exact brand string — and not the unrelated row', async () => {
    const got = await campaignsNamingHandleRows(stub as never, prospect, floor)
    expect(got.map((r) => r.id).sort()).toEqual(['a', 'b', 'c'])
  })

  it('carries postedAt, so pickHook can choose the freshest', async () => {
    const got = await campaignsNamingHandleRows(stub as never, prospect, floor)
    const newest = got.sort((x, y) => y.postedAt.getTime() - x.postedAt.getTime())[0]!
    expect(newest.id).toBe('b')
  })

  it('the count is the same question — one implementation, not two', async () => {
    expect(await campaignsNamingHandle(stub as never, prospect, floor)).toBe(3)
  })

  it('a recipient nothing names gets zero, so the guard still guards', async () => {
    expect(await campaignsNamingHandle(stub as never, { handle: 'nobodyhere', displayName: 'Nobody Here' }, floor)).toBe(0)
  })
})
