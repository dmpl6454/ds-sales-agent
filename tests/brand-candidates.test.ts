import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { brandCandidatesFor } from '@/detection/brandCandidates'

const ROOT = resolve(__dirname, '..')
const AUTO = readFileSync(join(ROOT, 'src/detection/autoResolve.ts'), 'utf8')
const CLI = readFileSync(join(ROOT, 'src/scripts/brands.ts'), 'utf8')

/**
 * ── WHICH HANDLES A PAID POST OFFERS, AND WHY THIS IS A GREP AS WELL ──────────────────
 *
 * MEASURED 2026-08-17. The tag source shipped on 17 August, wired into `autoResolveBrands`
 * and nowhere else. `pnpm ig:brands` — the command the handoff tells an operator to run
 * FROM A HOME IP, precisely because the automatic pass is 429'd on the Linode — read caption
 * @mentions only, and `continue`d past any post whose caption had none.
 *
 * **51% of in-window CAMPAIGN posts carry no usable caption @mention.** So the CLI could not
 * see half of every paid post, which is exactly the half tags were added for, while the pass
 * that could see them made no request at all in production. The feature was reachable from
 * NEITHER path — and every unit test of `taggedHandlesIn` passed throughout, because the
 * defect was a missing CALLER.
 *
 * That is the fifth time one rule with several callers has drifted here. A behavioural test
 * cannot fail for a call site nobody has written, so this greps, exactly as
 * `tests/one-route-rule.test.ts` and `tests/tag-evidence.test.ts` do.
 */

const NO_EXCLUSIONS: ReadonlySet<string> = new Set()

describe('brandCandidatesFor', () => {
  it('reads BOTH sources, and a caption mention outranks a tag', () => {
    const got = brandCandidatesFor(
      {
        caption: 'Lovely evening with @philipsindia',
        taggedAccounts: JSON.stringify(['deepikapadukone', 'redchilliesent']),
        rawPayload: null,
      },
      NO_EXCLUSIONS,
    )

    expect(got).toEqual([
      { handle: 'philipsindia', source: 'mention' },
      { handle: 'deepikapadukone', source: 'tag' },
      { handle: 'redchilliesent', source: 'tag' },
    ])
  })

  /**
   * THE CASE THE CLI USED TO SKIP ENTIRELY. A post with no caption mention still offers its
   * tags, and this is the majority case — 51% of in-window CAMPAIGN posts.
   */
  it('offers tags on a post whose caption mentions nobody', () => {
    const got = brandCandidatesFor(
      { caption: 'What a look 😍', taggedAccounts: JSON.stringify(['sonytvofficial']), rawPayload: null },
      NO_EXCLUSIONS,
    )
    expect(got).toEqual([{ handle: 'sonytvofficial', source: 'tag' }])
  })

  it('a handle in BOTH sources is offered once, as the stronger source', () => {
    const got = brandCandidatesFor(
      { caption: 'thanks @sonytvofficial', taggedAccounts: JSON.stringify(['sonytvofficial']), rawPayload: null },
      NO_EXCLUSIONS,
    )
    expect(got).toEqual([{ handle: 'sonytvofficial', source: 'mention' }])
  })

  /**
   * THE EXCLUSION IS BEFORE THE BUDGET, NOT AFTER IT. @viralbhayani appears in its own
   * posts' media tags and our own senders appear in ours; `routes.ts` refuses those routes
   * anyway, but only once the scarce endpoint has already been spent.
   */
  it('never offers our own pages or a watched publisher, whatever the source', () => {
    const excluded = new Set(['viralbhayani', 'bollywoodchronicle'])
    const got = brandCandidatesFor(
      {
        caption: 'via @viralbhayani and @philipsindia',
        taggedAccounts: JSON.stringify(['viralbhayani', 'bollywoodchronicle', 'redchilliesent']),
        rawPayload: null,
      },
      excluded,
    )
    expect(got.map((c) => c.handle)).toEqual(['philipsindia', 'redchilliesent'])
  })

  it('is case-insensitive about the exclusion set', () => {
    const got = brandCandidatesFor(
      { caption: '', taggedAccounts: JSON.stringify(['ViralBhayani']), rawPayload: null },
      new Set(['viralbhayani']),
    )
    expect(got).toEqual([])
  })

  it('survives malformed evidence rather than throwing', () => {
    expect(brandCandidatesFor({ caption: null, taggedAccounts: 'not json', rawPayload: null }, NO_EXCLUSIONS)).toEqual([])
    expect(brandCandidatesFor({ caption: null, taggedAccounts: '', rawPayload: null }, NO_EXCLUSIONS)).toEqual([])
  })
})

describe('both callers use the one definition', () => {
  it('the automatic pass asks brandCandidatesFor', () => {
    expect(AUTO).toMatch(/brandCandidatesFor\(/)
  })

  it('the CLI asks brandCandidatesFor, in the dry run AND in the real run', () => {
    const hits = CLI.match(/brandCandidatesFor\(/g) ?? []
    expect(hits.length).toBeGreaterThanOrEqual(2)
  })

  /**
   * The specific line that caused this: `if (mentionsIn(c.caption).length === 0) continue`
   * threw away the whole post. Neither caller may decide a post has nothing to offer by
   * looking at the caption alone.
   */
  it('neither caller skips a post on caption mentions alone', () => {
    for (const [name, src] of [['autoResolve', AUTO], ['ig:brands', CLI]] as const) {
      expect(src, name).not.toMatch(/mentionsIn\([^)]*\)\.length === 0\)\s*continue/)
    }
  })

  /** Both must exclude through the same reader, or they spend the budget differently. */
  it('both build the exclusion set with excludedHandles', () => {
    expect(AUTO).toMatch(/excludedHandles\(\)/)
    expect(CLI).toMatch(/excludedHandles\(\)/)
  })

  /**
   * MUTATION-TESTED IN BOTH DIRECTIONS. The greps above are satisfied by a mention of the
   * name, so this asserts the OLD shape is really gone — a file still assembling candidates
   * inline would keep the `source: 'tag' as const` literal that used to be there.
   */
  it('neither caller assembles the two sources inline any more', () => {
    for (const [name, src] of [['autoResolve', AUTO], ['ig:brands', CLI]] as const) {
      expect(src, name).not.toMatch(/source: 'tag' as const/)
    }
  })
})
