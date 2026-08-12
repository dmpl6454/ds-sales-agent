import { describe, it, expect } from 'vitest'
import {
  parseProspects,
  splitCsvLine,
  cleanHandle,
  IMPORT_ROW_LIMIT,
} from '@/outreach/importProspects'
import { assertSafeHandle } from '@/lib/urls'

/**
 * Phase 7 — the import parser.
 *
 * Every case here is one somebody's spreadsheet will actually produce. The parser's job is
 * to be forgiving about FORMAT and completely unforgiving about the handle itself, because
 * "never guess a handle" has a measurement behind it: `@royalcanin`, invented from the
 * display name "RoyalCanin", returns HTTP 404, and messaging the wrong account is worse
 * than messaging nobody.
 */

describe('splitCsvLine', () => {
  it('splits on commas', () => {
    expect(splitCsvLine('a,b,c')).toEqual(['a', 'b', 'c'])
  })

  it('splits on tabs — what pasting from a spreadsheet actually produces', () => {
    expect(splitCsvLine('a\tb\tc')).toEqual(['a', 'b', 'c'])
  })

  it('keeps a comma inside quotes', () => {
    expect(splitCsvLine('"Milano Ice Cream, Bangalore",x')).toEqual(['Milano Ice Cream, Bangalore', 'x'])
  })

  it('understands a doubled quote as a literal one', () => {
    expect(splitCsvLine('"say ""hi""",x')).toEqual(['say "hi"', 'x'])
  })

  it('trims surrounding whitespace', () => {
    expect(splitCsvLine('  a ,  b ')).toEqual(['a', 'b'])
  })
})

describe('cleanHandle', () => {
  it('strips a leading @', () => expect(cleanHandle('@viralbhayani')).toBe('viralbhayani'))
  it('lowercases', () => expect(cleanHandle('ViralBhayani')).toBe('viralbhayani'))
  it('extracts from a pasted profile URL', () =>
    expect(cleanHandle('https://www.instagram.com/royalcanin.india/')).toBe('royalcanin.india'))
  it('handles a URL with query parameters', () =>
    expect(cleanHandle('instagram.com/kalkifashion?hl=en')).toBe('kalkifashion'))
  it('leaves a bare handle alone', () => expect(cleanHandle('madovermarketing_mom')).toBe('madovermarketing_mom'))
})

describe('parseProspects — the shapes a real sheet arrives in', () => {
  it('reads a bare list of handles, one per line', () => {
    const r = parseProspects('@alpha\n@bravo\ncharlie')
    expect(r.prospects.map((p) => p.handle)).toEqual(['alpha', 'bravo', 'charlie'])
    expect(r.usedHeader).toBe(false)
  })

  it('reads a header row and maps the columns', () => {
    const r = parseProspects('handle,name,greeting,category,note\n@alpha,Alpha Media,Ravi,Bollywood,big reach')
    expect(r.usedHeader).toBe(true)
    expect(r.prospects[0]).toMatchObject({
      handle: 'alpha',
      displayName: 'Alpha Media',
      greeting: 'Ravi',
      category: 'Bollywood',
      note: 'big reach',
    })
  })

  it('accepts alternative header spellings', () => {
    const r = parseProspects('Username,Display Name\n@alpha,Alpha')
    expect(r.usedHeader).toBe(true)
    expect(r.prospects[0]!.displayName).toBe('Alpha')
  })

  it('does NOT eat the first row when it is data, not a header', () => {
    const r = parseProspects('@alpha,Alpha Media\n@bravo,Bravo')
    expect(r.usedHeader).toBe(false)
    expect(r.prospects).toHaveLength(2)
  })

  it('survives a byte-order mark from Excel', () => {
    const r = parseProspects('﻿handle\n@alpha')
    expect(r.prospects[0]!.handle).toBe('alpha')
    expect(r.rejected).toHaveLength(0)
  })

  it('survives CRLF line endings', () => {
    const r = parseProspects('@alpha\r\n@bravo\r\n')
    expect(r.prospects.map((p) => p.handle)).toEqual(['alpha', 'bravo'])
  })

  it('ignores blank rows, including a trailing one', () => {
    const r = parseProspects('@alpha\n\n\n@bravo\n')
    expect(r.prospects).toHaveLength(2)
    expect(r.rejected).toHaveLength(0)
  })

  it('falls back the display name to the handle, and the greeting to the display name', () => {
    const r = parseProspects('@alpha')
    expect(r.prospects[0]!.displayName).toBe('alpha')
    expect(r.prospects[0]!.greeting).toBe('alpha')
  })
})

describe('parseProspects — what it refuses', () => {
  /**
   * NAMED, never repaired, and with the line number. A silently dropped row in a 50-row
   * import is a prospect that vanishes with nothing on screen to say so.
   */
  it('rejects an invalid handle and says which line', () => {
    const r = parseProspects('@alpha\nnot a handle!\n@bravo')
    expect(r.prospects.map((p) => p.handle)).toEqual(['alpha', 'bravo'])
    expect(r.rejected).toHaveLength(1)
    expect(r.rejected[0]!.line).toBe(2)
    expect(r.rejected[0]!.reason).toContain('not a valid Instagram handle')
  })

  it('one bad row does not abort the rest of the import', () => {
    const r = parseProspects(['@a', 'bad handle!', '@b', 'also bad!!', '@c'].join('\n'))
    expect(r.prospects).toHaveLength(3)
    expect(r.rejected).toHaveLength(2)
  })

  it('rejects a row with no handle at all', () => {
    const r = parseProspects('handle,name\n,Alpha Media')
    expect(r.rejected[0]!.reason).toContain('no handle')
  })

  it('keeps a duplicate once and reports it', () => {
    const r = parseProspects('@alpha\n@ALPHA\n@bravo')
    expect(r.prospects.map((p) => p.handle)).toEqual(['alpha', 'bravo'])
    expect(r.duplicates).toEqual(['alpha'])
  })

  /**
   * NO SILENT CAPS. A truncated import that reported success would leave someone believing
   * 80 prospects were added when 50 were — and they would find out by wondering why a
   * channel was never messaged.
   */
  it('caps the import and REPORTS what it dropped', () => {
    const many = Array.from({ length: IMPORT_ROW_LIMIT + 7 }, (_, i) => `@handle${i}`).join('\n')
    const r = parseProspects(many)
    expect(r.prospects).toHaveLength(IMPORT_ROW_LIMIT)
    expect(r.overLimit).toBe(7)
  })

  it('reports nothing dropped when the import fits', () => {
    expect(parseProspects('@alpha\n@bravo').overLimit).toBe(0)
  })

  it('returns empty for empty input rather than throwing', () => {
    const r = parseProspects('')
    expect(r.prospects).toEqual([])
    expect(r.rejected).toEqual([])
  })
})

describe('the parser and assertSafeHandle agree', () => {
  /**
   * The parser has its own handle pattern because `assertSafeHandle` THROWS, which is
   * right for a single action and wrong for a 50-row import where one bad row must not
   * take the other 49 with it. Two patterns is a drift risk, so this asserts they accept
   * and reject the same things — the same reason DETECTOR_KEYS is cross-checked against
   * the detector registry.
   */
  const cases = ['alpha', 'royalcanin.india', 'mad_about_marketing', 'a', 'a'.repeat(30)]
  const bad = ['a'.repeat(31), 'has space', 'has-dash', 'has!bang', '']

  for (const h of cases) {
    it(`both accept "${h}"`, () => {
      expect(parseProspects(h).prospects).toHaveLength(1)
      expect(() => assertSafeHandle(h)).not.toThrow()
    })
  }
  for (const h of bad) {
    it(`both reject ${JSON.stringify(h)}`, () => {
      expect(parseProspects(h).prospects).toHaveLength(0)
      expect(() => assertSafeHandle(h)).toThrow()
    })
  }
})
