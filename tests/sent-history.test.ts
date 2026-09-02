import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { SENT_PAGE_SIZE } from '@/app/view-model/sent-history'

/**
 * THE DELIVERED HISTORY IS A PAGE OF A KNOWN WHOLE — 2026-08-21.
 *
 * Third face in three days of *a bounded list read as a complete record*:
 *
 *   19→20 Aug   `sentToday` was `recentRaw.filter(...).length` over a `take: 50`
 *   21 Aug      the activity feed's `take: 40` made 07:51 look like the day's first send
 *   21 Aug      `SentList` rendered `Delivered ({recent.length})` — the WINDOW as the total
 *
 * At ~280 sends a day the third is simply a wrong number on the screen, and the complete
 * record existed only in the CSV export. So the history is paginated and every figure it
 * states is counted independently of the page it is showing.
 *
 * A source grep for the parts no behavioural test can reach: that `total` is its own count
 * rather than `rows.length` (deriving it from the page would report "50 of 50" and AGREE with
 * the truncation — a check verifying its own symmetry, three times recorded here), and that
 * the pager is actually rendered, because data nothing draws is the missing-caller failure
 * this repo keeps producing.
 */

const root = join(import.meta.dirname, '..')
const read = (p: string) => readFileSync(join(root, p), 'utf8')

describe('buildSentHistory', () => {
  const src = read('src/app/view-model/sent-history.ts')

  it('counts the total independently of the page it returns', () => {
    expect(src).toMatch(/const total = await prisma\.outreachAttempt\.count/)
    /* The killer: the total must never be derived from the rows the page holds. */
    expect(src).not.toMatch(/total:\s*rows\.length/)
  })

  it('clamps the requested page into range instead of trusting the URL', () => {
    expect(src).toMatch(/Math\.min\(Math\.max\(1,/)
    expect(src).toMatch(/pageCount/)
  })

  /**
   * A ~1-minute send period means two rows CAN share `sentAt` to the millisecond under a
   * concurrent claim, and an unstable sort silently repeats or skips a row across a page
   * boundary — quiet wrongness in the one view whose job is being the complete record.
   */
  it('orders by a stable key, not by timestamp alone — and a NULL timestamp sorts LAST', () => {
    /* `nulls: 'last'` (2026-09-02): Postgres puts NULL first under DESC, so a REPLIED row
       with no sentAt rendered at the TOP of the delivered lists as the "newest" send,
       wearing an em-dash for its time. */
    expect(src).toMatch(
      /orderBy:\s*\[\{\s*sentAt:\s*\{\s*sort:\s*'desc',\s*nulls:\s*'last'\s*\}\s*\},\s*\{\s*id:\s*'desc'\s*\}\]/,
    )
  })

  it('the page size is a named bound', () => {
    expect(SENT_PAGE_SIZE).toBeGreaterThan(0)
    expect(src).toMatch(/take:\s*SENT_PAGE_SIZE/)
  })
})

describe('and the pages render it', () => {
  it('SentList states the true total when paging, never the window length', () => {
    const src = read('src/app/messages/sent.tsx')
    expect(src).toMatch(/paging \? paging\.total : recent\.length/)
    expect(src).toMatch(/Showing \{paging\.from\}/)
  })

  it('SentList renders a pager with a way to reach the far end', () => {
    const src = read('src/app/messages/sent.tsx')
    expect(src).toMatch(/hrefForPage\(1\)/)
    expect(src).toMatch(/hrefForPage\(paging\.pageCount\)/)
    expect(src).toMatch(/hrefForPage\(paging\.page \+ 1\)/)
    expect(src).toMatch(/hrefForPage\(paging\.page - 1\)/)
  })

  it('/analytics drives it from the URL and keeps the range while paging', () => {
    const src = read('src/app/analytics/page.tsx')
    expect(src).toMatch(/buildSentHistory\(/)
    expect(src).toMatch(/paging=\{\{/)
    expect(src).toMatch(/range=\$\{picked\.key\}/)
    /* The anchor, or every page turn dumps the reader at the top of a long page. */
    expect(src).toMatch(/id="history"/)
  })

  /**
   * The landing page answers "is it sending"; until now it held no figure for what already
   * had been sent, and no route to the record. Both counts must be real counts.
   */
  it('the Autopilot page states today and all-time, and links to the history', () => {
    const src = read('src/app/page.tsx')
    expect(src).toMatch(/\{m\.sentToday\}/)
    expect(src).toMatch(/\{m\.deliveredTotal\}/)
    expect(src).toMatch(/\/analytics#history/)
  })

  it('deliveredTotal is its own count, not a list length', () => {
    const src = read('src/app/view-model/messages-page.ts')
    expect(src).toMatch(/prisma\.outreachAttempt\.count\(\{ where: \{ status: \{ in: \[\.\.\.DELIVERED_STATUSES\] \} \} \}\)/)
    expect(src).not.toMatch(/deliveredTotal:\s*recent/)
  })
})
