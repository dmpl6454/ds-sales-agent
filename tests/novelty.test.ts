import { describe, expect, it } from 'vitest'
import { buildVocabulary, noveltyScore, extractHashtagsRaw } from '@/detection/detectors/novelty'
import { mergeBrands } from '@/detection/detectors/semantic'

/**
 * Stage 1 of semantic detection: is a post's vocabulary unusual for THIS channel?
 *
 * Both directions matter more than usual here. A filter that passes everything is
 * merely expensive; a filter that drops too much makes paid posts permanently
 * invisible with nothing on screen to say so — the exact silent failure this
 * codebase keeps producing.
 *
 * The fixture below mirrors the real @viralbhayani shape measured 2026-08-03: a
 * handful of recurring celebrity tags, a long tail of one-offs.
 */
function viralBhayaniish() {
  return buildVocabulary([
    // Recurring editorial subjects — the channel's actual vocabulary.
    ...Array(5).fill('The ageless diva #malaikaarora spotted with her mystery friend'),
    ...Array(4).fill('#bhartisingh and family out and about'),
    ...Array(3).fill('#ramayana update for the fans'),
    // A long tail of one-offs, so the corpus clears MIN_CORPUS.
    ...Array(30)
      .fill(0)
      .map((_, i) => `Spotted at the airport today #celebrity${i}`),
  ])
}

describe('extractHashtagsRaw — casing is load-bearing', () => {
  it('preserves original casing so slogans stay detectable', () => {
    expect(extractHashtagsRaw('promo #OneLastTimeWithThalapathy now')).toEqual(['#OneLastTimeWithThalapathy'])
  })

  it('deduplicates', () => {
    expect(extractHashtagsRaw('#Same and #Same again')).toEqual(['#Same'])
  })

  it('returns nothing when there are no hashtags', () => {
    expect(extractHashtagsRaw('just a caption')).toEqual([])
  })
})

describe('noveltyScore — keeps what the model should read', () => {
  const vocab = viralBhayaniish()

  it('keeps a film promo: novel tags plus a release call to action', () => {
    const r = noveltyScore(
      'Blockbuster #JanaNayagan is running successfully in cinemas now #JanNeTalnTheaters',
      vocab,
    )
    expect(r.worthClassifying).toBe(true)
    expect(r.signals.some((s) => s.startsWith('novel:'))).toBe(true)
    expect(r.signals).toContain('cta:release')
  })

  it('keeps a brand launch on the call to action alone', () => {
    const r = noveltyScore('Daniel Wellington introduces Sharvari as its new brand ambassador', vocab)
    expect(r.worthClassifying).toBe(true)
    expect(r.signals).toContain('cta:launch')
  })

  it('keeps a campaign slogan hashtag', () => {
    const r = noveltyScore('A new chapter #WhereStillnessFindsYou', vocab)
    expect(r.worthClassifying).toBe(true)
    expect(r.signals.some((s) => s.startsWith('slogan:'))).toBe(true)
  })

  it('keeps a caption with NO hashtags — a paid post need not carry any', () => {
    // 155 of 306 real posts had no hashtag at all. Treating those as organic would
    // blindfold the classifier on half the channel.
    const r = noveltyScore('Some caption with no tags whatsoever, quite long though', vocab)
    expect(r.worthClassifying).toBe(true)
  })

  it('keeps a purchase call to action', () => {
    expect(noveltyScore('Available now at all stores, link in bio', vocab).worthClassifying).toBe(true)
  })
})

/**
 * ── STAGE 1 NO LONGER DROPS ANYTHING (2026-08-07) ─────────────────────────
 *
 * This block asserted the opposite until today, and one of its cases was the bug
 * verbatim: *"drops a single novel celebrity name — one rare tag is not enough"*.
 * MEASURED on the live 592-post @viralbhayani corpus, 76 posts were filtered here and
 * never read by the model; 49 of them failed for that one-rare-tag reason alone,
 * including a paid post Tabish had to find by hand (`DbtNU9UzWYU`) and obvious
 * commercial copy like *"#CommuneCircus, presented by Vartik T…"*.
 *
 * The file's own header always said the right thing — a missed paid post is invisible
 * and unappealable, a wasted call costs a fraction of a cent — and the threshold
 * contradicted it. Reading every never-read post across all channels costs 2.7 cents.
 *
 * These tests now pin the CURRENT contract: score everything, veto nothing. They are
 * deliberately written as the cases that used to be dropped, so re-introducing a
 * threshold fails here with the reason attached.
 */
describe('noveltyScore — scores, and vetoes NOTHING', () => {
  const vocab = viralBhayaniish()

  it('passes routine editorial rather than dropping it', () => {
    const r = noveltyScore('The ageless diva #malaikaarora spotted with her mystery friend', vocab)
    expect(r.worthClassifying).toBe(true)
  })

  it('passes a single rare tag — the exact shape of the 49 missed posts', () => {
    // Tabish's DbtNU9UzWYU had exactly one rare hashtag (#Thane) and was filtered.
    const r = noveltyScore("Thanekars have double reasons to celebrate! The super awesome #Thane just got its first double decker bus", vocab)
    expect(r.worthClassifying).toBe(true)
  })

  it('passes a post using only well-known channel vocabulary', () => {
    expect(noveltyScore('#bhartisingh and family out and about', vocab).worthClassifying).toBe(true)
  })

  /** The measurement survives — it is the veto that was wrong, not the scoring. */
  it('still REPORTS which tags are rare, so the evidence is not lost', () => {
    const r = noveltyScore('Bollywood superstar #SalmanKhan spotted at the airport', vocab)
    expect(r.rareTags).toContain('#salmankhan')
    const known = noveltyScore('#malaikaarora again', vocab)
    expect(known.rareTags).not.toContain('#malaikaarora')
  })
})

describe('noveltyScore — refuses to filter without a baseline', () => {
  it('passes everything when the corpus is too small to judge', () => {
    // A brand-new channel has no vocabulary, so every tag looks novel and the
    // filter would be noise. Failing toward the model is expensive, never wrong.
    const tiny = buildVocabulary(['#one post only'])
    const r = noveltyScore('The ageless diva #malaikaarora spotted', tiny)
    expect(r.worthClassifying).toBe(true)
    expect(r.signals).toContain('stage1:corpus-too-small')
  })
})

describe('buildVocabulary', () => {
  it('counts case-insensitively', () => {
    const v = buildVocabulary(['#Tilara here', '#tilara again', '#TILARA thrice'])
    expect(v.frequency.get('#tilara')).toBe(3)
  })

  it('counts a repeated tag in one caption only once', () => {
    const v = buildVocabulary(['#Same and #Same and #Same'])
    expect(v.frequency.get('#same')).toBe(1)
  })

  it('records the corpus size', () => {
    expect(buildVocabulary(['a', 'b', 'c']).corpusSize).toBe(3)
  })
})

describe('mergeBrands — the same brand must never appear twice', () => {
  it('collapses spacing and casing differences', () => {
    // Measured on the real caption: the model returns "Jana Nayagan" while
    // extractBrands returns "JanaNayagan" from #JanaNayagan. A plain Set keeps both,
    // and the hook line then reads "your Jana Nayagan and JanaNayagan campaign".
    expect(mergeBrands(['Jana Nayagan'], ['JanaNayagan'])).toEqual(['Jana Nayagan'])
  })

  it('prefers the model spelling, which is the human-readable one', () => {
    expect(mergeBrands(['Royal Canin'], ['royalcanin', 'RoyalCanin'])).toEqual(['Royal Canin'])
  })

  it('keeps genuinely different brands', () => {
    expect(mergeBrands(['Nykaa'], ['Tilara'])).toEqual(['Nykaa', 'Tilara'])
  })

  it('ignores punctuation differences', () => {
    expect(mergeBrands(['The Leela'], ['@theleela', '#TheLeela'])).toEqual(['The Leela'])
  })

  it('drops empty and punctuation-only entries', () => {
    expect(mergeBrands(['', '  '], ['#'])).toEqual([])
  })

  it('caps the list', () => {
    const many = Array.from({ length: 20 }, (_, i) => `Brand${i}`)
    expect(mergeBrands(many, []).length).toBe(8)
  })
})

/**
 * A FILTERED POST IS NOT AN EDITORIAL VERDICT.
 *
 * The stage-1 branch in semantic.ts returned `verdict: 'ORGANIC'` with
 * `verdictSource: 'rules'` for posts no classifier had read — 76 of them on
 * @viralbhayani, all counted as judged-and-editorial on /paid-posts. Same family as
 * `identify()` reading a dead endpoint as "logged out". It now returns UNCLASSIFIED /
 * 'none', which is what "not judged" means everywhere else in this pipeline.
 *
 * Asserted on the detector's own source because the branch is unreachable while
 * `worthClassifying` is unconditionally true — a behavioural test would pass vacuously,
 * which is the failure this project keeps rediscovering.
 */
describe('a filtered post is never recorded as ORGANIC', () => {
  it('the stage-1 branch yields UNCLASSIFIED / none, never a verdict', async () => {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync('src/detection/detectors/semantic.ts', 'utf8')
    const branch = src.slice(src.indexOf('if (novelty && !novelty.worthClassifying)'))
    const body = branch.slice(0, branch.indexOf('}'))
    expect(body).toContain("verdict: 'UNCLASSIFIED'")
    expect(body).toContain("verdictSource: 'none'")
    expect(body).not.toContain("verdict: 'ORGANIC'")
    expect(body).not.toContain("verdictSource: 'rules'")
  })
})
