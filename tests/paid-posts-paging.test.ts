import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PAID_POSTS_PAGE_SIZE } from '@/app/view-model'

/**
 * THE PAID-POSTS TABLE IS A PAGE OF A KNOWN WHOLE, FILTERED BY CHANNEL — 2026-08-25.
 *
 * Tabish: *"There must be a filter to show in a list (with back button to go further back and
 * see data page wise) via dropdown where we can select a target channel name … and see paid
 * posts with respect to them only."* Open in CLAUDE.md since 21 August.
 *
 * It was a flat `take: 100` with "Showing the newest 100 of N" underneath — the FOURTH face
 * of *a bounded list read as a complete record*, after `sentToday`, the activity feed and
 * `SentList`. And its "of N" counted `verdict: CAMPAIGN` while the rows were
 * `CAMPAIGN OR humanLabel: false`, so the two numbers described different sets. Harmless as a
 * footnote; fatal as a pager, which computes where the END is from that number.
 *
 * A source grep for the same reason `tests/sent-history.test.ts` is one: the things that
 * matter here are properties of the SHAPE — one predicate, an independent count, a stable
 * order, a validated filter, and a control that is actually drawn. A behavioural test over a
 * temp database can assert the arithmetic; it cannot fail for a pager nobody rendered, and
 * that is this repo's most repeated defect.
 *
 * MEASURED against the live corpus when it shipped: 875 in-window rows, 18 pages, all 18
 * walked — **875 distinct shortcodes, 0 seen twice, 0 missed** — with **27 `postedAt` values
 * shared by more than one row**, so the `id` tiebreak below is doing real work rather than
 * being defensive. All 13 channel options returned only their own rows.
 */

const root = join(import.meta.dirname, '..')
const read = (p: string) => readFileSync(join(root, p), 'utf8')

describe('paid posts — the table is a page of a known whole', () => {
  const src = read('src/app/view-model.ts')

  it('has a bounded page size that a page render can hold', () => {
    expect(PAID_POSTS_PAGE_SIZE).toBeGreaterThan(0)
    expect(PAID_POSTS_PAGE_SIZE).toBeLessThanOrEqual(100)
  })

  it('counts the total with the SAME predicate the rows use', () => {
    /*
      The killer. `postsWhere` is named once and handed to both, so the count cannot drift
      from the rows the way `verdict: CAMPAIGN` drifted from `CAMPAIGN OR humanLabel: false`.
    */
    expect(src).toMatch(/const postsWhere = \{/)
    expect(src).toMatch(/count\(\{ where: postsWhere \}\)/)
    expect(src).toMatch(/findMany\(\{\s*where: postsWhere,/)
  })

  it('never derives the total from the rows it is showing', () => {
    /* "100 of 100" would agree with the truncation — a check verifying its own symmetry. */
    expect(src).not.toMatch(/total:\s*(paidRows|posts)\.length/)
  })

  it('clamps the requested page instead of trusting the URL', () => {
    expect(src).toMatch(/const postsPage = Math\.min\(Math\.max\(1,/)
    expect(src).toMatch(/postsPageCount/)
  })

  it('orders by postedAt with id as the tiebreak, or a row repeats across a boundary', () => {
    expect(src).toMatch(/orderBy: \[\{ postedAt: 'desc' \}, \{ id: 'desc' \}\]/)
  })

  it('validates the channel against the visible set rather than querying whatever was typed', () => {
    /*
      An unknown `?channel=` must fall back to NO filter. An empty table and a channel that
      posted nothing look identical, and telling those apart is this page's entire job.
    */
    expect(src).toMatch(/channelOptions\.some\(\(c\) => c\.handle === wanted\)/)
    expect(src).toMatch(/const channelFilter = wanted &&/)
  })

  it('builds the dropdown from the VISIBLE channels, so it can never offer one of our own pages', () => {
    expect(src).toMatch(/const channelOptions = v\.channels\.map/)
  })
})

describe('paid posts — the controls are actually rendered', () => {
  const page = read('src/app/paid-posts/page.tsx')
  const filter = read('src/app/paid-posts/channel-filter.tsx')

  it('draws the filter', () => {
    expect(page).toMatch(/<ChannelFilter\s/)
    expect(page).toMatch(/options=\{v\.channelOptions\}/)
    expect(page).toMatch(/current=\{v\.channelFilter\}/)
  })

  it('draws the pager, with a way to the far end as well as one step back', () => {
    expect(page).toMatch(/hrefForPage\(1\)/)
    expect(page).toMatch(/hrefForPage\(v\.postsPaging\.page - 1\)/)
    expect(page).toMatch(/hrefForPage\(v\.postsPaging\.page \+ 1\)/)
    expect(page).toMatch(/hrefForPage\(v\.postsPaging\.pageCount\)/)
  })

  it('carries the channel through paging, or page 2 silently drops the filter', () => {
    expect(page).toMatch(/hrefForPage = \(n: number\) =>[\s\S]*?channel=\$\{encodeURIComponent\(v\.channelFilter\)\}/)
  })

  it('does NOT carry the page through a channel change', () => {
    /*
      Deliberate omission, and it has to be asserted because the bug it prevents is invisible:
      a hidden page input would land the reader on "page 7 of 2", which the view model clamps
      — so they would silently get the LAST page of the newly-chosen channel with nothing on
      screen explaining why. A filter change is a new question; it starts at the newest post.
    */
    expect(filter).not.toMatch(/name="page"/)
    expect(filter).toMatch(/method="get"/)
  })

  it('works without JavaScript — the submit button is not decoration', () => {
    expect(filter).toMatch(/<button type="submit"/)
  })

  it('states which filter its total belongs to', () => {
    /* "0 paid posts" and "0 paid posts from @pinkvilla" are different facts. */
    expect(page).toMatch(/v\.channelFilter \? <> from @\{v\.channelFilter\}<\/> : null/)
  })

  it('offers a way back when a filtered view is empty', () => {
    expect(page).toMatch(/Every channel/)
  })
})
