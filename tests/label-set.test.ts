import { describe, expect, it } from 'vitest'
import { findBulkWrites, DISCLOSURE_PATTERN, BULK_WRITE_MIN, LABEL_SOURCES } from '@/detection/labels'

/**
 * ── THE LABELLED SET, WHOSE TWO RULES DECIDE WHETHER ANY ACCURACY FIGURE MEANS ANYTHING ──
 *
 * `pnpm ig:accuracy` is the only instrument this project has, and both of the rules below
 * were arrived at by measuring against the live corpus rather than by reasoning:
 *
 *   1. a label written in BULK is not an answer about a post — 21 share one timestamp;
 *   2. a disclosure hashtag ABSENT is a label on a channel that discloses, and on no other.
 *
 * Get (2) backwards and @viralbhayani contributes 1,003 fake ORGANIC labels against 2 real
 * positives, and the harness reports something like 99% for a channel it has not measured.
 */

const at = (iso: string) => new Date(iso)

describe('findBulkWrites — a label written in bulk is not an answer about a post', () => {
  it('keeps answers a person gave one at a time', () => {
    const rows = [
      { id: 'a', at: at('2026-08-13T04:33:19.273Z') },
      { id: 'b', at: at('2026-08-13T04:34:26.816Z') },
      { id: 'c', at: at('2026-08-13T06:50:10.840Z') },
    ]
    const r = findBulkWrites(rows)
    expect(r.bulk).toEqual([])
    expect(r.individual).toHaveLength(3)
    expect(r.groups).toEqual([])
  })

  /** The real one: 21 rows stamped `2026-08-08 11:04:04.042` by a script not in this repo. */
  it('separates a run of labels sharing one byte-identical timestamp', () => {
    const stamp = at('2026-08-08T11:04:04.042Z')
    const rows = [
      ...Array.from({ length: 21 }, (_, i) => ({ id: `bulk${i}`, at: stamp })),
      { id: 'real', at: at('2026-08-13T06:50:10.840Z') },
    ]
    const r = findBulkWrites(rows)
    expect(r.bulk).toHaveLength(21)
    expect(r.individual).toEqual([{ id: 'real', at: at('2026-08-13T06:50:10.840Z') }])
    expect(r.groups).toEqual([{ at: stamp, count: 21 }])
  })

  /**
   * THE THRESHOLD, ASSERTED IN BOTH DIRECTIONS against the exported constant rather than a
   * literal. Two people-clicks landing in the same millisecond is not plausible, but three
   * is not a script either — the boundary has to be somewhere and it has to be stated.
   */
  it('leaves a group SMALLER than the threshold alone', () => {
    const stamp = at('2026-08-08T11:04:04.042Z')
    const rows = Array.from({ length: BULK_WRITE_MIN - 1 }, (_, i) => ({ id: `x${i}`, at: stamp }))
    expect(findBulkWrites(rows).bulk).toEqual([])
    expect(findBulkWrites(rows).individual).toHaveLength(BULK_WRITE_MIN - 1)
  })

  it('catches a group exactly AT the threshold', () => {
    const stamp = at('2026-08-08T11:04:04.042Z')
    const rows = Array.from({ length: BULK_WRITE_MIN }, (_, i) => ({ id: `x${i}`, at: stamp }))
    expect(findBulkWrites(rows).bulk).toHaveLength(BULK_WRITE_MIN)
  })

  /**
   * A label predating the column keeps its answer. Dropping an undated row would silently
   * discard ground truth, which is the opposite of what this function is for — it removes
   * labels that were never judgements, not labels whose timestamp is missing.
   */
  it('keeps an undated label rather than discarding it', () => {
    const r = findBulkWrites([{ id: 'old', at: null }])
    expect(r.individual).toHaveLength(1)
    expect(r.bulk).toEqual([])
  })

  it('separates two different bulk writes, and reports each', () => {
    const one = at('2026-08-08T11:04:04.042Z')
    const two = at('2026-09-01T09:00:00.000Z')
    const rows = [
      ...Array.from({ length: 6 }, (_, i) => ({ id: `a${i}`, at: one })),
      ...Array.from({ length: 8 }, (_, i) => ({ id: `b${i}`, at: two })),
    ]
    const r = findBulkWrites(rows)
    expect(r.bulk).toHaveLength(14)
    // Biggest first, so a report names the worst one first.
    expect(r.groups.map((g) => g.count)).toEqual([8, 6])
  })
})

describe('DISCLOSURE_PATTERN — what a publisher saying "I was paid" looks like', () => {
  /** Real captions from the live corpus. */
  it('matches the disclosures actually found in the corpus', () => {
    for (const caption of [
      'Sunday brunch done right #Collaboration',
      'Our favourite influencers promoting the new range of Vivo phones @vivo_india #Ad',
      'The vivo S2 marks the beginning of an exciting new chapter #ad',
      'a caption with #Sponsored in it',
      'mixed case #PaidPartnership here',
    ]) {
      expect(DISCLOSURE_PATTERN.test(caption), caption).toBe(true)
    }
  })

  /**
   * THE WORD BOUNDARY IS THE WHOLE POINT, and `#adventure` is why. Without `\\b` every
   * travel post on a paparazzi feed becomes a labelled-paid post, and the harness would
   * then measure the classifier against a set of labels that are simply wrong — the most
   * expensive kind of error there is here, because it looks like data.
   */
  it('does NOT match a longer word that merely starts with a disclosure tag', () => {
    for (const caption of [
      'weekend #adventure in Goa',
      '#advertisingweek panel recap',
      '#collabs are fun',
      '#partnerships explained',
      'no hashtag at all, just the word ad in prose',
    ]) {
      expect(DISCLOSURE_PATTERN.test(caption), caption).toBe(false)
    }
  })

  /**
   * Commercial-sounding prose is NOT a disclosure. MEASURED on @viralbhayani's 1,005 posts:
   * "presented by" appears 7 times, "in association with" 3, "brand ambassador" 5 — every
   * one of them ordinary film-promotion language on a paparazzi feed. Treating any of them
   * as a label would be the tag-as-a-rule mistake that cratered precision 85% to 71%.
   */
  it('does NOT match commercial phrasing that is not a disclosure', () => {
    for (const caption of [
      'The film is presented by Dharma Productions',
      'in association with Zee Studios',
      'X is the new brand ambassador for Y',
      'powered by the fans',
      'out now in cinemas',
    ]) {
      expect(DISCLOSURE_PATTERN.test(caption), caption).toBe(false)
    }
  })

  /**
   * The pattern is shared with the BLINDING step in `ig:accuracy`, and that sharing is a
   * safety property rather than tidiness: a label derived from a tag the blinding does not
   * strip would let the model read the answer off the caption, turning a held-out test into
   * a demonstration. Asserted here so the two cannot drift apart.
   */
  it('is case-insensitive, so blinding removes exactly what labelling matched', () => {
    const caption = 'launch day #COLLABORATION with the team'
    expect(DISCLOSURE_PATTERN.test(caption)).toBe(true)
    expect(caption.replace(new RegExp(DISCLOSURE_PATTERN.source, 'gi'), '')).not.toMatch(/collaboration/i)
  })
})

describe('the three sources stay distinguishable', () => {
  /**
   * A hashtag is a FACT and a human answer is a JUDGEMENT. `verdictSource` exists to keep
   * those apart everywhere else in this system; the labelled set must not be the one place
   * they are added together into a single number.
   */
  it('names three sources, and they are distinct strings', () => {
    const values = Object.values(LABEL_SOURCES)
    expect(values).toHaveLength(3)
    expect(new Set(values).size).toBe(3)
  })
})
