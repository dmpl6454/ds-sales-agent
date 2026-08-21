import { describe, it, expect } from 'vitest'
import { isOwnMark, stripOwnMarksFromFrame, stripOwnMarksFromBrands, selfInitialisms } from '@/detection/ownMarks'

/**
 * A PUBLISHER'S OWN MARKS ARE NOT EVIDENCE ABOUT THE PUBLISHER — 2026-08-21.
 *
 * Every fixture below is a REAL string from the live corpus. The two that carry the weight
 * are the control cases: `acerpure` must survive (a genuine placement the caption missed, and
 * exactly what reading the footage is for), and `Zee5` must survive (a real brand shaped like
 * an internal code). A rule that drops those is worse than the bug it fixes, because a missed
 * paid post is invisible and unappealable while a false one is a row on a screen.
 */

const filmygyan = { handle: 'filmygyan', displayName: 'F I L M Y G Y A N' }
const society = { handle: 'bollywoodsocietyy', displayName: 'Bollywood Society' }

describe('isOwnMark', () => {
  it('recognises the publisher itself, however it was spaced by OCR', () => {
    expect(isOwnMark('FILMYGYAN', filmygyan)).toBe(true)
    expect(isOwnMark('Filmygyan', filmygyan)).toBe(true)
    expect(isOwnMark('F I L M Y G Y A N', filmygyan)).toBe(true)
    /* A watermark with a suffix — containment toward the publisher's own long name only. */
    expect(isOwnMark('filmygyanofficial', filmygyan)).toBe(true)
  })

  /** The internal series codes Tabish named: initials + a number, nothing else. */
  it('recognises internal series codes built from the publisher initials', () => {
    for (const code of ['fg6', 'fg2', 'fg11', 'FG17', 'fg18', 'FG18']) {
      expect(isOwnMark(code, filmygyan), `${code} should be an own mark`).toBe(true)
    }
    expect(isOwnMark('bs2', society)).toBe(true)
  })

  /**
   * ── THE CONTROL CASES ─────────────────────────────────────────────────────
   * `acerpure` came from the frame of `DcRB5e1Cy_M` alongside "Dolby" and "120Hz", and its
   * escalation to CAMPAIGN was CORRECT. `Zee5` and `5Star` are real brands with the shape of
   * an internal code. Dropping any of these would trade recall, which this project never does.
   */
  it('keeps real brands, including ones shaped like a code', () => {
    for (const brand of ['acerpure', 'Zee5', '5Star', 'Fastrack', 'Dolby', 'Philips India', 'LEGO']) {
      expect(isOwnMark(brand, filmygyan), `${brand} must survive`).toBe(false)
    }
  })

  /** Another publisher's name is not OUR publisher's own mark — it may be a genuine collab. */
  it('does not treat a different publisher as an own mark', () => {
    expect(isOwnMark('Filmygyan', society)).toBe(false)
    expect(isOwnMark('fg6', society)).toBe(false)
  })

  it('an empty or punctuation-only token is not a mark', () => {
    expect(isOwnMark('', filmygyan)).toBe(false)
    expect(isOwnMark('  —  ', filmygyan)).toBe(false)
  })
})

describe('selfInitialisms', () => {
  it('derives initials from a spaced display name and from a dotted handle', () => {
    expect(selfInitialisms('filmygyan', 'Filmy Gyan')).toContain('fg')
    expect(selfInitialisms('manav.manglani', 'Manav Manglani')).toContain('mm')
    /* A letter-spaced display name yields no usable initialism — the acronym branch in
       `isOwnMark` is what covers @filmygyan, and it is tested directly above. */
    expect(selfInitialisms('filmygyan', 'F I L M Y G Y A N')).toEqual([])
  })
})

describe('stripOwnMarksFromFrame', () => {
  /**
   * The anniversary post's frame, VERBATIM from the row that was wrongly escalated.
   *
   * The bare `FILMYGYAN` in shot is what read as "a brand is present" and must go. The
   * run-together title card SURVIVES on purpose: it is prose about the publisher, and the
   * caption classifier already reads that correctly ("Publisher's own anniversary, not a
   * paid promotion"). Stripping evidence the model judges correctly would be the wrong fix.
   */
  it('drops the bare watermark and keeps the title card', () => {
    const frame =
      'on screen: AglamorouscelebrationasFilmygyan | marks10amazingyearsintheindustry! — in shot: FILMYGYAN'
    const out = stripOwnMarksFromFrame(frame, filmygyan)
    expect(out).not.toBeNull()
    expect(out).toContain('marks10amazingyearsintheindustry')
    expect(out).not.toMatch(/in shot: FILMYGYAN/)
  })

  it('a frame that is ONLY the watermark carries no evidence at all', () => {
    expect(stripOwnMarksFromFrame('in shot: FILMYGYAN', filmygyan)).toBeNull()
    expect(stripOwnMarksFromFrame('on screen: fg6 | in shot: FILMYGYAN', filmygyan)).toBeNull()
  })

  /** THE CONTROL: the acerpure placement must come through untouched apart from the logo. */
  it('keeps a real placement while dropping the watermark beside it', () => {
    const frame = 'on screen: acerpu | Pose toh AkshayKumar sir — in shot: acerpure | BaDolby | 120Hz | FILMYGYAN'
    const out = stripOwnMarksFromFrame(frame, filmygyan)
    expect(out).toContain('acerpure')
    expect(out).toContain('120Hz')
    expect(out).not.toMatch(/\|\s*FILMYGYAN/)
  })

  it('null in, null out — and an absent frame is not an empty finding', () => {
    expect(stripOwnMarksFromFrame(null, filmygyan)).toBeNull()
  })
})

describe('stripOwnMarksFromBrands', () => {
  it('drops the publisher and its codes, keeps the advertiser', () => {
    expect(stripOwnMarksFromBrands(['Filmygyan', 'fg6', 'acerpure'], filmygyan)).toEqual(['acerpure'])
  })

  it('leaves an unrelated list alone', () => {
    expect(stripOwnMarksFromBrands(['LEGO India', 'Zee5'], filmygyan)).toEqual(['LEGO India', 'Zee5'])
  })
})
