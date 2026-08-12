import type { ChannelDetector, Classification, EnrichedPost } from '../types'

/**
 * Detector for @madovermarketing_mom.
 *
 * Grounded in real posts captured 2026-07-29. MOM labels paid work explicitly
 * with #Collaboration, and names the brand in the same breath:
 *
 *   DbXfC7Pk7FQ  "...#Collaboration #HarRoofTilara #Tilara #SustainableRoofing"   -> Tilara
 *   DbVMqWgTOOg  "...#Collaboration #RoyalCanin #UniqueNeedsPreciseNutrition"     -> Royal Canin
 *   DbVAgeNE2rE  "...@theleela @mind_shifters #Collaboration #TheLeela"           -> The Leela
 *
 * Their organic posts carry no such tag ("Good ol' advertising 🤌🏻", "How Uber
 * entered the world of football..."). So a hashtag test is both sufficient and
 * near-exact here — no LLM, no cost, no drift.
 */

/** Primary marker. `#Collaboration` is MOM's house style; the rest are industry standard. */
const DISCLOSURE_TAGS = [
  'collaboration',
  'collab',
  'ad',
  'ads',
  'sponsored',
  'sponsoredpost',
  'paidpartnership',
  'paidpartner',
  'partnership',
  'promotion',
  'promoted',
  'advertisement',
  'barter',
] as const

/** Phrases that disclose without a hashtag. */
const DISCLOSURE_PHRASES: [RegExp, string][] = [
  [/\bpaid partnership\b/i, 'phrase:paid-partnership'],
  [/\bin (?:paid )?(?:association|collaboration|partnership) with\b/i, 'phrase:in-association-with'],
  [/\bpresented by\b/i, 'phrase:presented-by'],
  [/\bpowered by\b/i, 'phrase:powered-by'],
  [/\bbrought to you by\b/i, 'phrase:brought-to-you-by'],
  [/\bsponsored by\b/i, 'phrase:sponsored-by'],
]

/**
 * Hashtags that are descriptive rather than brand names. Filtered out of brand
 * extraction so `#Collaboration #RoyalCanin #PetNutrition` yields "RoyalCanin"
 * and not the campaign-speak around it.
 */
const GENERIC_TAG_WORDS = new Set([
  ...DISCLOSURE_TAGS,
  'marketing',
  'advertising',
  'branding',
  'brand',
  'campaign',
  'experientialmarketing',
  'socialmedia',
  'socialmediamarketing',
  'digitalmarketing',
  'contentmarketing',
  'storytelling',
  'creative',
  'creativity',
  'design',
  'innovation',
  'sustainability',
  'sustainableroofing',
  'petnutrition',
  'india',
  'mom',
  'madovermarketing',
  'reels',
  'reel',
  'instagram',
  'viral',
  'trending',
  'explore',
])

/** Accounts that are agencies/partners rather than the paying brand. */
const NON_BRAND_MENTIONS = new Set(['madovermarketing_mom', 'mind_shifters'])

export function extractHashtags(caption: string): string[] {
  return [...caption.matchAll(/#([\p{L}\p{N}_]+)/gu)].map((m) => m[1]!)
}

export function extractMentions(caption: string): string[] {
  return [...caption.matchAll(/@([A-Za-z0-9._]+)/g)].map((m) => m[1]!.replace(/\.$/, ''))
}

/**
 * Number of CamelCase words in a hashtag. "RoyalCanin" -> 2,
 * "WhereStillnessFindsYou" -> 4. Used to separate brands from slogans.
 */
export function countCamelWords(tag: string): number {
  const matches = tag.match(/[A-Z][a-z0-9]*/g)
  return matches ? matches.length : 1
}

/**
 * Brand candidates, most reliable first: @mentions are explicit accounts, then
 * non-generic hashtags. Deduped case-insensitively, original casing kept so
 * "RoyalCanin" renders nicely in a hook line.
 *
 * Two filters, both derived from the real MOM captions:
 *
 *  - Campaign slogans are hashtagged exactly like brands ("#WhereStillnessFindsYou",
 *    "#UniqueNeedsPreciseNutrition", "#TheLeelaCoorgForestSanctuary"). Four or more
 *    CamelCase words, or 20+ characters, means slogan rather than brand name.
 *
 *  - Brands appear at several granularities in one caption: "#HarRoofTilara"
 *    alongside "#Tilara". Keeping both produces "collaboration with Har Roof
 *    Tilara and Tilara", so a candidate containing an already-accepted brand as a
 *    substring is dropped in favour of the shorter, cleaner one.
 */
/** Lowercase, strip everything non-alphanumeric. "@tilara.india" -> "tilaraindia" */
export function normaliseBrandKey(raw: string): string {
  return raw.replace(/^[@#]/, '').toLowerCase().replace(/[^a-z0-9]/g, '')
}

/**
 * Extract the brand(s) a paid post is for.
 *
 * The governing rule, derived from every real MOM collaboration observed:
 * **the paying brand @mentions the post; a slogan cannot.** So when the caption
 * contains any usable @mention, only mention-corroborated brands are returned.
 * Hashtags are then used purely to improve the *display form*, because handles
 * are lowercase and full of noise ("@tilara.india", "@royalcanin.india",
 * "@theleelacoorgforestsanctuary") while the matching hashtag is clean and
 * properly cased ("#Tilara", "#RoyalCanin", "#TheLeela").
 *
 * Without this rule, live data produced:
 *   ["blackandwhite_nonalc", "MagicOfSharing", "FanStandardTime"]
 * where the last two are campaign slogans that would have gone into a real
 * message as if they were the client.
 *
 * Matching is fuzzy in both directions on the normalised key, so "tilara.india"
 * pairs with "Tilara" and "theleelacoorgforestsanctuary" pairs with "TheLeela".
 *
 * When a caption has no @mention at all, fall back to hashtag heuristics.
 */
export function extractBrands(caption: string): string[] {
  const hashtags = extractHashtags(caption)

  const mentionHandles = extractMentions(caption).filter(
    (h) => !NON_BRAND_MENTIONS.has(h.toLowerCase()) && normaliseBrandKey(h).length > 2,
  )

  if (mentionHandles.length > 0) {
    /** One entry per distinct real-world brand. */
    const groups: { keys: string[]; display: string }[] = []

    for (const handle of mentionHandles) {
      const key = normaliseBrandKey(handle)
      const existing = groups.find((g) => g.keys.some((k) => k.includes(key) || key.includes(k)))
      if (existing) {
        existing.keys.push(key)
        continue
      }
      groups.push({ keys: [key], display: `@${handle}` })
    }

    // Upgrade each group's display to the cleanest matching hashtag: properly
    // cased, and the shortest such match (so "#Tilara" beats "#HarRoofTilara").
    for (const group of groups) {
      const matches = hashtags
        .filter((t) => {
          const tk = normaliseBrandKey(t)
          if (GENERIC_TAG_WORDS.has(t.toLowerCase())) return false
          return group.keys.some((k) => k.includes(tk) || tk.includes(k))
        })
        .filter((t) => /[A-Z]/.test(t))
        .sort((a, b) => a.length - b.length)

      if (matches[0]) group.display = matches[0]
    }

    return groups.map((g) => g.display).slice(0, 4)
  }

  // ── No @mention: hashtags only, with slogan filtering ─────────────────────
  const candidates = hashtags
    .filter((tag) => {
      if (GENERIC_TAG_WORDS.has(tag.toLowerCase())) return false
      if (tag.length >= 20) return false
      if (countCamelWords(tag) >= 4) return false
      if (looksLikeSlogan(tag)) return false
      return true
    })
    .sort((a, b) => a.length - b.length)

  // Only the single best candidate. This path has no @mention to corroborate
  // against, so it is the least reliable one — naming one brand we might have
  // wrong is recoverable in a sales message; naming three is not.
  return candidates.slice(0, 1)
}

/**
 * Slogans read like sentences, so they contain connective words that brand names
 * almost never do: "#MagicOfSharing", "#WhereStillnessFindsYou",
 * "#UniqueNeedsPreciseNutrition".
 */
const SLOGAN_WORDS = new Set([
  'of', 'the', 'with', 'for', 'in', 'and', 'your', 'my', 'our', 'to', 'is', 'are',
  'where', 'when', 'what', 'why', 'how', 'you', 'we', 'us', 'that', 'this', 'every',
])

export function looksLikeSlogan(tag: string): boolean {
  const words = tag.match(/[A-Z][a-z0-9]*/g)
  if (!words || words.length < 2) return false
  // Ignore the first word — "TheLeela" is a brand, "MagicOfSharing" is not.
  return words.slice(1).some((w) => SLOGAN_WORDS.has(w.toLowerCase()))
}

export const momDetector = {
  key: 'mom',
  describe: 'Rules on #Collaboration and disclosure phrases. Deterministic, no LLM.',

  classify(post: EnrichedPost): Classification {
    const caption = post.caption
    const tags = extractHashtags(caption).map((t) => t.toLowerCase())
    const signals: string[] = []

    for (const tag of DISCLOSURE_TAGS) {
      if (tags.includes(tag)) signals.push(`hashtag:#${tag}`)
    }
    for (const [re, label] of DISCLOSURE_PHRASES) {
      if (re.test(caption)) signals.push(label)
    }

    if (signals.length === 0) {
      // 'rules' even for ORGANIC: this channel discloses, so the ABSENCE of a
      // disclosure is itself evidence and was genuinely evaluated. That is a
      // different claim from passthrough's "nobody looked".
      return { verdict: 'ORGANIC', confidence: 0, signals: [], brands: [], verdictSource: 'rules' }
    }

    const brands = extractBrands(caption)
    if (brands.length > 0) signals.push(`brands:${brands.length}`)

    // An explicit disclosure is definitive. Extra signals do not make it more
    // true, so confidence reflects only whether we also identified the brand —
    // which is what determines whether a hook line can be personalised.
    return {
      verdict: 'CAMPAIGN',
      confidence: brands.length > 0 ? 100 : 85,
      signals,
      brands,
      verdictSource: 'rules',
    }
  },
} satisfies ChannelDetector
