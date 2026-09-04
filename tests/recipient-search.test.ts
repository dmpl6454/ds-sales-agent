import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { searchTerms, casings, normaliseSearch, targetNameClauses, MIN_SEARCH_LENGTH } from '@/lib/searchTerms'
import { attributedPostId } from '@/app/view-model/recipient-search'
import { PROSPECTS_PAGE_SIZE } from '@/app/view-model/prospects-page'

const root = join(import.meta.dirname, '..')
const read = (p: string) => readFileSync(join(root, p), 'utf8')
/** Code only: the docblocks here quote the very strings the greps refuse. */
const code = (p: string) => read(p).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

/**
 * "FOR WHICH PAID POST WAS THIS PERSON MESSAGED?" (2026-09-04). Tabish searched `celina` and
 * could not tell. The pure halves are driven here; the wiring — which the pure halves cannot
 * prove reached the screen — is pinned by source greps over the three files that carry it.
 */
describe('searchTerms — one typed term, every string a contains-filter must try', () => {
  it('fans out casings and the separators a handle uses', () => {
    const t = searchTerms('arshad warsi')
    for (const want of ['arshad warsi', 'Arshad Warsi', 'ARSHAD WARSI', 'arshad_warsi', 'arshad.warsi', 'arshadwarsi']) {
      expect(t).toContain(want)
    }
  })
  it('a single word gets casings only, de-duplicated', () => {
    expect(casings('celina')).toEqual(['celina', 'CELINA', 'Celina'])
    expect(new Set(searchTerms('celina')).size).toBe(searchTerms('celina').length)
  })
  it('normalises a URL parameter: trims, bounds, and refuses a term too short to mean anything', () => {
    expect(normaliseSearch('  celina ')).toBe('celina')
    expect(normaliseSearch('a')).toBeNull()
    expect(normaliseSearch(null)).toBeNull()
    expect(normaliseSearch('x'.repeat(200))!.length).toBe(80)
    expect(MIN_SEARCH_LENGTH).toBe(2)
  })
  it('matches a target by handle (every variant) and by display name (casings only)', () => {
    const clauses = targetNameClauses('celina jaitly')
    expect(clauses).toContainEqual({ handle: { contains: 'celina_jaitly' } })
    expect(clauses).toContainEqual({ displayName: { contains: 'Celina Jaitly' } })
    expect(clauses).not.toContainEqual({ displayName: { contains: 'celinajaitly' } })
  })
})

describe('attributedPostId — the partition rule, in one place', () => {
  it('the CLAIMED post wins; discovery is the fallback; neither is nothing', () => {
    expect(attributedPostId({ campaignId: 'claimed' }, 'discovered')).toBe('claimed')
    expect(attributedPostId({ campaignId: null }, 'discovered')).toBe('discovered')
    expect(attributedPostId({ campaignId: null }, null)).toBeNull()
  })
})

describe('the wiring, by source', () => {
  it('/paid-posts search ORs in the posts a matching recipient was messaged under', () => {
    const src = read('src/app/view-model.ts')
    expect(src).toMatch(/attributedPostIdsForRecipients\(searchQuery\)/)
    expect(src).toMatch(/\{ id: \{ in: attributedIds \} \}/)
  })
  it('recipient-search counts the SAME statuses the column does, and sorts NULL last', () => {
    const src = read('src/app/view-model/recipient-search.ts')
    expect(src).toMatch(/status: \{ in: \[\.\.\.DELIVERED_STATUSES\] \}/)
    expect(src).toMatch(/nulls: 'last'/)
    expect(src).toMatch(/take: 100/)
  })
  it('the syndication note renders ONLY where the row carries no message — a note, never a second count', () => {
    const page = read('src/app/paid-posts/page.tsx')
    expect(page).toMatch(/p\.messagesSent\.length === 0 && p\.messagedUnder \?/)
    expect(page).toMatch(/p\.messagesSent\.length === 0 && !p\.messagedUnder \?/)
    const rs = read('src/app/view-model/recipient-search.ts')
    expect(rs).toMatch(/under\.postId === row\.postId\) continue/) // never about itself
  })
  it('/analytics filters the sent history by recipient with the shared fan-out, and counts the filtered total', () => {
    const sh = code('src/app/view-model/sent-history.ts')
    expect(sh).toMatch(/target: \{ OR: targetNameClauses\(targetQuery\) \}/)
    expect(sh).not.toMatch(/mode: 'insensitive'/)
    const page = read('src/app/analytics/page.tsx')
    expect(page).toMatch(/name="to"/)
    expect(page).toMatch(/targetQuery: to \?\? null/)
  })
  it('/targets is paged: counted before the rows, clamped, id tiebreak, bounded take', () => {
    const src = read('src/app/view-model/prospects-page.ts')
    expect(PROSPECTS_PAGE_SIZE).toBe(50)
    expect(src.indexOf('prisma.targetAccount.count({ where: messagedWhere })')).toBeLessThan(src.indexOf('skip: (page - 1)'))
    expect(src).toMatch(/Math\.min\(Math\.max\(1, Math\.floor\(input\?\.page \?\? 1\)\), pageCount\)/)
    expect(src).toMatch(/orderBy: \[\{ handle: 'asc' \}, \{ id: 'asc' \}\],\s*skip:/)
    expect(src).toMatch(/take: PROSPECTS_PAGE_SIZE/)
    /* The WATCH group is always whole — it must never land on page 18. */
    expect(src).toMatch(/role: 'WATCH', \.\.\.nameWhere/)
    const page = read('src/app/targets/page.tsx')
    expect(page).toMatch(/messagedTotal=\{v\.paging\.total\}/)
  })
})
