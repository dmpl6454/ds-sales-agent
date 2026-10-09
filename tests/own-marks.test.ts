import { describe, it, expect } from 'vitest'
import { isOwnMark, stripOwnMarksFromFrameText, stripOwnMarksFromBrands, selfInitialisms } from '@/detection/ownMarks'
import { frameTextForPrompt, type FrameText } from '@/detection/ocr'

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

/** A FrameText as OCR produces it — line-level items in three groups. */
function ft(overlay: string[], smaller: string[] = [], misread: string[] = []): FrameText {
  return { overlay, smaller, misread, dropped: 0, engine: 'rapidocr' }
}

describe('stripOwnMarksFromFrameText — on the STRUCTURED text, item by item', () => {
  /**
   * The anniversary post's frame, VERBATIM from the row that was wrongly escalated, as the
   * arrays OCR produced rather than the summary line.
   *
   * The bare `FILMYGYAN` in shot is what read as "a brand is present" and must go. The
   * run-together title card SURVIVES on purpose: it is prose about the publisher, and the
   * caption classifier already reads that correctly ("Publisher's own anniversary, not a
   * paid promotion"). Stripping evidence the model judges correctly would be the wrong fix.
   */
  it('drops the bare watermark and keeps the title card', () => {
    const out = stripOwnMarksFromFrameText(
      ft(['AglamorouscelebrationasFilmygyan', 'marks10amazingyearsintheindustry!'], ['FILMYGYAN']),
      filmygyan,
    )
    expect(out.overlay).toEqual(['AglamorouscelebrationasFilmygyan', 'marks10amazingyearsintheindustry!'])
    expect(out.smaller).toEqual([])
  })

  /**
   * ── A TWO-WORD LOGO ARRIVES AS ONE ITEM ───────────────────────────────────
   * OCR returns LINE-level items, so a per-word test lets every one of these through: no
   * single word of `VIRAL BHAYANI` is the handle. The whole-item EQUALITY test is what
   * catches them — and @filmygyan's display name is literally the letter-spaced form.
   */
  it.each([
    ['FILMYGYAN', filmygyan],
    ['F I L M Y G Y A N', filmygyan],
    ['FILMY GYAN', filmygyan],
    ['@filmygyan', filmygyan],
    /* A watermark wearing only non-brand affixes is still the logo. */
    ['filmygyanofficial', filmygyan],
    ['thefilmygyan', filmygyan],
    ['FILMYGYAN OFFICIAL', filmygyan],
    /**
     * A series code drops when its stem is a DERIVABLE initialism. Under the real display name
     * `F I L M Y G Y A N` none is derivable — see the KEEP case below — so the code is tested
     * where the initials can be pointed at, which is what the frame rule requires.
     */
    ['fg6', { handle: 'filmygyan', displayName: 'Filmy Gyan' }],
    ['bs2', society],
    ['VIRAL BHAYANI', { handle: 'viralbhayani', displayName: 'Viral Bhayani' }],
    ['RVCJ MEDIA', { handle: 'rvcjinsta', displayName: 'RVCJ Media' }],
  ])('drops %s as the publisher’s own mark', (item, publisher) => {
    const out = stripOwnMarksFromFrameText(ft([], [item]), publisher)
    expect(out.smaller, `${item} should be dropped`).toEqual([])
  })

  /**
   * THE COST OF THE FRAME RULE, PINNED SO IT IS A DECISION RATHER THAN A SURPRISE. Under
   * @filmygyan's real display name no initialism is derivable, and the only arm that matched
   * `fg6` — first letter + in-order subsequence of the handle — is the arm that also matches
   * `FLY91` and `VO5`. So in FOOTAGE a lone `fg6` is kept and sent: one classifier call with
   * nothing to escalate on. The caption rule still removes it from brand strings, where the fg
   * codes were actually measured.
   */
  it('keeps fg6 in footage under the letter-spaced display name — the cheap direction', () => {
    const out = stripOwnMarksFromFrameText(ft([], ['fg6']), filmygyan)
    expect(out.smaller).toEqual(['fg6'])
    expect(isOwnMark('fg6', filmygyan), 'the CAPTION rule is unchanged').toBe(true)
  })

  /**
   * ── THE OTHER DIRECTION, WHICH IS THE EXPENSIVE ONE ───────────────────────
   * Running `isOwnMark` on the WHOLE item would drop all of these: run together, each is
   * within the affix slack of the handle. They are the shape of a real collaboration or a
   * real placement, and dropping a real advertiser is the error this project does not make.
   */
  it.each([
    'Filmygyan x Acer',
    'FILMYGYAN PRESENTS',
    'Pose toh FILMYGYAN',
    'acerpure',
    'BaDolby',
    '120Hz',
    'AglamorouscelebrationasFilmygyan',
  ])('keeps %s', (item) => {
    const out = stripOwnMarksFromFrameText(ft([], [item]), filmygyan)
    expect(out.smaller).toEqual([item])
  })

  /**
   * ── OCR RUNS WORDS TOGETHER, AND THE CAPTION RULE WAS DROPPING THE ADVERTISER WITH THEM ──
   * Found by review 2026-10-09, running the real functions. RapidOCR on the server emits a
   * collaboration card as ONE word, so every one of these was a single "word" that passed the
   * CAPTION `isOwnMark` — its affix branch (contains the handle, within 8 characters) or its
   * series-code arm (first letter + an in-order subsequence of the handle). Dropped, a frame
   * whose only text this was made no call and was recorded `frame:only-own-marks`, which is
   * never retried: a genuine placement missed permanently. `FLY91` (an airline) and `VO5` (a
   * hair-care brand) are the two that rule out keeping the subsequence arm for frames at all,
   * even as a fallback for a publisher with no derivable initials.
   */
  const viral = { handle: 'viralbhayani', displayName: 'Viral Bhayani' }
  const pinkvilla = { handle: 'pinkvilla', displayName: 'Pinkvilla' }
  const mom = { handle: 'madovermarketing_mom', displayName: 'Mad Over Marketing (M.O.M)' }
  const rvcj = { handle: 'rvcjinsta', displayName: 'RVCJ Media' }
  const trolls = { handle: 'trolls_official', displayName: 'Trolls Official' }
  const voompla = { handle: 'voompla', displayName: 'Voompla' }
  it.each([
    ['FILMYGYANxACER', filmygyan],
    ['FilmygyanXZee5', filmygyan],
    ['#FilmygyanXNike', filmygyan],
    ['AcerxFilmygyan', filmygyan],
    ['ViralBhayaniXNykaa', viral],
    ['NykaaxViralBhayani', viral],
    ['PinkvillaXMyntra', pinkvilla],
    ['PINKVILLAxLAKME', pinkvilla],
    ['PosetohFILMYGYAN', filmygyan],
    ['FILMYGYANPRESENTS', filmygyan],
    ['VH1', viral],
    ['MG4', mom],
    ['Rs499', rvcj],
    ['TCL55', trolls],
    ['FLY91', filmygyan],
    ['VO5', voompla],
  ])('keeps the run-together or code-shaped %s — it can be the advertiser', (item, publisher) => {
    const out = stripOwnMarksFromFrameText(ft([], [item]), publisher)
    expect(out.smaller, `${item} must survive under @${publisher.handle}`).toEqual([item])
  })

  /** THE CONTROL: the acerpure placement must come through untouched apart from the logo. */
  it('keeps a real placement while dropping the watermark beside it', () => {
    const out = stripOwnMarksFromFrameText(
      ft(['acerpu', 'Pose toh AkshayKumar sir'], ['acerpure', 'BaDolby', '120Hz', 'FILMYGYAN']),
      filmygyan,
    )
    expect(out.overlay).toEqual(['acerpu', 'Pose toh AkshayKumar sir'])
    expect(out.smaller).toEqual(['acerpure', 'BaDolby', '120Hz'])
  })

  /**
   * A WATERMARK AT THE START OF A GROUP NEVER TAKES A NEIGHBOUR WITH IT. The string version
   * deleted the previous group's last real item (`NIKE AIR`) on exactly this shape, and on
   * the FIRST group it deleted the `[BEGIN FRAME-TEXT-…]` fence itself. There is no
   * delimiter in an array to damage.
   */
  it('a watermark first in a group never removes a neighbouring item or the fence', () => {
    const out = stripOwnMarksFromFrameText(ft(['FILMYGYAN', 'NIKE AIR'], ['FILMYGYAN', 'JUST DO IT']), filmygyan)
    expect(out.overlay).toEqual(['NIKE AIR'])
    expect(out.smaller).toEqual(['JUST DO IT'])
    const prompt = frameTextForPrompt(out, 'abc123')!
    expect(prompt.startsWith('[BEGIN FRAME-TEXT-abc123')).toBe(true)
    expect(prompt).toContain('[END FRAME-TEXT-abc123]')
    expect(prompt).toContain('NIKE AIR')
  })

  /* The overlay was `fg6` until 2026-10-09; under this display name a frame `fg6` is now kept
     (see above), so the watermark-only frame is built from forms of the logo itself. */
  it('a frame that is ONLY the watermark strips to empty groups — nothing left to send', () => {
    const out = stripOwnMarksFromFrameText(ft(['@filmygyan'], ['FILMYGYAN'], ['FILMYGYAN']), filmygyan)
    expect([out.overlay, out.smaller, out.misread]).toEqual([[], [], []])
    expect(frameTextForPrompt(out, 'abc123')).toBeNull()
  })

  it('carries the engine and the dropped count through unchanged — they describe the OCR', () => {
    const out = stripOwnMarksFromFrameText({ ...ft(['FILMYGYAN']), dropped: 3, engine: 'vision' }, filmygyan)
    expect(out.engine).toBe('vision')
    expect(out.dropped).toBe(3)
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
