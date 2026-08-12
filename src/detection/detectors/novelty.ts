/**
 * Stage 1: is this post's vocabulary unusual for THIS channel?
 *
 * The observation this is built on: a paid post drags in hashtags the channel has
 * never used, because it is carrying someone else's campaign. Editorial recycles the
 * channel's own recurring subjects.
 *
 * Measured against 306 stored @viralbhayani posts (2026-08-03):
 *
 *   262 distinct hashtags
 *     8 used 3+ times   — the channel's actual vocabulary
 *                         (#malaikaarora #bhartisingh #ramayana #lockupp2 …)
 *   229 used exactly once
 *    66 posts carry 2+ rare hashtags   ← ~20% of the corpus
 *
 * The commercial posts sit squarely in that 66:
 *   #jananayagan #jannetalntheaters   "Blockbuster … running successfully in cinemas"
 *   #danielwellington #sharvari       "introduces Sharvari as its new brand ambassador"
 *   #daayra #talvar #raazi            "DAAYRA ARRIVES IN CINEMAS ON 18TH SEPTEMBER"
 *
 * WHY THIS IS A FILTER AND NOT A VERDICT
 *
 * The same measurement refutes the stronger claim. Mean novelty is 0.86 across ALL
 * posts, and pure editorial scores just as high:
 *   #salmankhan #bhaijaan             "Bollywood superstar … aka Bhaijaan now"
 *   #riteshdeshmukh #geneliadeshmukh  "the most adored Bollywood couple"
 * The channel never repeats a celebrity name, so novelty alone cannot separate a
 * brand being promoted from a person being reported on. That needs meaning.
 *
 * So this decides ONLY "is this worth paying a model to read", and it is deliberately
 * biased toward yes: a false negative here is a paid post that is never detected and
 * never appealable, while a false positive costs a fraction of a cent.
 */

import { looksLikeSlogan } from './mom'

export interface ChannelVocabulary {
  /** hashtag (lowercased, with #) -> how many times this channel has used it. */
  frequency: Map<string, number>
  /** Posts the frequency map was built from. Below MIN_CORPUS it is not trustworthy. */
  corpusSize: number
}

/**
 * A hashtag used this many times or fewer is "rare for this channel".
 *
 * 2 rather than 1: at 306 posts the once-only bucket held 229 tags, so requiring
 * strictly-unseen would have flagged almost everything. Twice is still rare against
 * a channel whose top tag appears five times.
 */
const RARE_AT_OR_BELOW = 2

/**
 * Below this many posts, the frequency map cannot distinguish rare from unseen and
 * every tag looks novel. A new channel therefore sends everything to stage 2 —
 * expensive but correct — rather than filtering on a baseline that does not exist.
 */
const MIN_CORPUS = 40

/**
 * Phrases that only appear in marketing copy. Deliberately narrow: each one is a
 * call to action or a transaction, none of which occur in "spotted at the airport".
 */
const CTA_PATTERNS: [RegExp, string][] = [
  [/\b(in cinemas|in theatres|in theaters|releasing|out now|streaming now|book (your )?tickets)\b/i, 'cta:release'],
  [/\b(shop now|buy now|order now|available (now|at|on)|link in bio|swipe up|dm us|visit us)\b/i, 'cta:purchase'],
  [/\b(use code|coupon|discount|offer ends|limited period|launch(ing|ed)? (offer|today))\b/i, 'cta:offer'],
  [/\b(brand ambassador|unveil(s|ed|ing)?|introduc(es|ing)|presents|proudly presents)\b/i, 'cta:launch'],
  [/\b(register (now|here)|sign up|free (screening|checkup|camp|consultation))\b/i, 'cta:signup'],
]

/**
 * Hashtags with their ORIGINAL casing preserved.
 *
 * Casing is load-bearing here and easy to destroy by accident. Frequency matching
 * needs lowercase (#JanaNayagan and #jananayagan are the same tag), but slogan
 * detection needs the CamelCase to find word boundaries — "#OneLastTimeWithThalapathy"
 * is only recognisable as a sentence while it still has capitals. Lowercasing once at
 * the top would have silently disabled the slogan signal, which is the part that
 * separates a campaign tagline from a celebrity's name.
 */
export function extractHashtagsRaw(caption: string): string[] {
  return [...new Set(caption.match(/#[A-Za-z0-9_]{2,}/g) ?? [])]
}

/** Lowercased, for frequency lookups only. */
export function extractHashtags(caption: string): string[] {
  return [...new Set(extractHashtagsRaw(caption).map((t) => t.toLowerCase()))]
}

/** Build the channel's vocabulary from its stored captions. */
export function buildVocabulary(captions: string[]): ChannelVocabulary {
  const frequency = new Map<string, number>()
  for (const c of captions) {
    for (const t of extractHashtags(c)) frequency.set(t, (frequency.get(t) ?? 0) + 1)
  }
  return { frequency, corpusSize: captions.length }
}

export interface NoveltyResult {
  /** Should stage 2 read this post? */
  worthClassifying: boolean
  rareTags: string[]
  signals: string[]
}

export function noveltyScore(caption: string, vocab: ChannelVocabulary): NoveltyResult {
  // No baseline yet — cannot judge, so do not filter. Fails toward the model.
  if (vocab.corpusSize < MIN_CORPUS) {
    return { worthClassifying: true, rareTags: [], signals: ['stage1:corpus-too-small'] }
  }

  // Raw casing kept so `looksLikeSlogan` can find word boundaries; the frequency
  // lookup lowercases per tag.
  const rawTags = extractHashtagsRaw(caption)
  const tags = rawTags.map((t) => t.toLowerCase())
  const rareRaw = rawTags.filter((t) => (vocab.frequency.get(t.toLowerCase()) ?? 0) <= RARE_AT_OR_BELOW)
  const rareTags = rareRaw.map((t) => t.toLowerCase())
  // Reuses mom.ts's implementation rather than a second one. Its test is smarter than
  // a length threshold: it looks for connective words ("of", "with", "where") that
  // appear in taglines and essentially never in a brand or person's name.
  const slogans = rareRaw.filter((t) => looksLikeSlogan(t.replace(/^#/, '')))

  const ctaHits: string[] = []
  for (const [re, label] of CTA_PATTERNS) if (re.test(caption)) ctaHits.push(label)

  const signals: string[] = []
  if (rareTags.length > 0) signals.push(`novel:${rareTags.length}`)
  if (slogans.length > 0) signals.push(`slogan:${slogans.length}`)
  signals.push(...ctaHits)

  /**
   * ── ALWAYS TRUE SINCE 2026-08-07. THIS IS NO LONGER A GATE. ───────────────
   *
   * It was `tags.length === 0 || rareTags.length >= 2 || slogans.length >= 1 || ctaHits.length >= 1`
   * and the `rareTags.length >= 2` arm was the single largest source of missed paid posts
   * on @viralbhayani. MEASURED against the live corpus (592 stored posts):
   *
   *   76 posts were filtered here and the model NEVER read them — and 49 of those failed
   *   the gate for one reason only: they carried EXACTLY ONE rare hashtag.
   *
   * Tabish hand-picked five paid posts we had missed. Four were already CAMPAIGN. The
   * fifth — `DbtNU9UzWYU`, "#Thane just got its first double decker bus" — was filtered
   * right here, on one rare tag. Reading the other 48 in that bucket found obvious
   * commercial copy that was never judged: *"#CommuneCircus, presented by Vartik T…"*,
   * a Star Plus show launch (*"#YehFitoorTera … Star Plus' newest jodi"*). The header
   * of this file already argued the correct principle — *"a false negative here is a
   * paid post that is never detected and never appealable, while a false positive costs
   * a fraction of a cent"* — and then the code shipped a two-tag threshold that made
   * false negatives the common case.
   *
   * WHY THE THRESHOLD IS DELETED RATHER THAN LOWERED TO 1. Measured both: at `>= 1`,
   * 540 of 592 VB posts pass, so the filter discards 9% of the corpus while still
   * being able to veto a paid post. A filter that saves 9% of $0.000023 a post and can
   * silently lose revenue is not a trade worth making — reading EVERY post never read
   * on any channel (1,137 of them) costs **2.7 cents** at the measured rate, with an
   * 88% prompt-cache hit. The economics this stage was built for do not exist.
   *
   * The scoring is KEPT and still returned. `rareTags` and `signals` are recorded on
   * every post, so the vocabulary evidence stays available for ranking, for the
   * accuracy harness, and for reviving a gate if volume ever makes one necessary — the
   * measurement is the valuable part, the veto was the bug.
   *
   * `worthClassifying` stays in the type rather than being removed so the field keeps
   * its meaning at the call site and a future gate has somewhere to live. If you set it
   * false again, you are choosing to lose paid posts to save fractions of a cent: read
   * the numbers above first.
   */
  const worthClassifying = true

  return { worthClassifying, rareTags, signals }
}
