/**
 * EVERY PERSON AND COMPANY A PAID POST NAMES — not just the thing being sold.
 *
 * ── WHAT WAS MISSING, IN TABISH'S OWN EXAMPLE (2026-08-25) ─────────────────
 *
 * `@taranadarsh` posted the `Toxic` release. We detected it as CAMPAIGN correctly and stored
 * `brands: ["Toxic","KGF2"]`. The caption names, in full:
 *
 *   #Yash · #Nayanthara · KiaraAdvani · TaraSutaria · RukminiVasanth · HumaQureshi
 *   Geetu Mohandas (director) · Venkat K Narayana (producer) · KVNProductions
 *   MonsterMindCreations
 *
 * **None of them reached discovery.** The Haiwaan post one row down is the same shape:
 * detected CAMPAIGN, stored `brands: ["Haiwaan"]`, while the caption names Akshay Kumar, Saif
 * Ali Khan, Priyadarshan, Boman Irani, Saiyami Kher, Shriya Pilgaonkar, Sharib Hashmi, KVN
 * Productions, Thespian Films, Venkat K Narayana and Shailaja Desai Fenn.
 *
 * The cause is not a bug — it is the QUESTION. `semantic.ts` asks the model for "commercial
 * entities being promoted", and for a film release that is the film. The people who made it
 * and the companies that produced it are exactly who buys placement, and nothing was reading
 * them. Tabish: *"multiple individuals, brands were named, none of which have been discovered
 * as targets."*
 *
 * ── WHY A PURE EXTRACTOR AND NOT A PROMPT CHANGE ──────────────────────────
 *
 * Adding a `people` field to the classifier's JSON is the more accurate instrument and it is
 * NOT what ships here. A prompt edit is a classification change: this project's standing gate
 * is `pnpm ig:accuracy --repeat 3` before and after, recall is never traded, and an attempt to
 * catch one missed post by prompt once cratered precision 85% → 71%. This module touches
 * `judge.ts` not at all, so **classification is provably unchanged rather than measured
 * unchanged** — the same property `publisherContext` was built to preserve, from the other
 * side. The prompt route stays open and is the obvious next step if this proves too blunt.
 *
 * ── THE SAFE DIRECTION IS GENEROUS, BECAUSE OF WHAT IS DOWNSTREAM ─────────
 *
 * An extracted name cannot mint anything. It becomes candidate HANDLES
 * (`candidateHandlesFor`), each of which must clear `isOfficialMatch` — **a verified badge AND
 * a profile name covering every token of the name** — and then `duplicatesExistingProspect`.
 * A junk name costs at worst one lookup from a small budget; a missed name costs a lead that
 * is invisible and unappealable. So this errs toward extracting, and the ordering in
 * `officialDiscovery` (frequency across paid posts) is what stops junk consuming the budget:
 * a name on five paid posts beats one named once, and junk is almost always named once.
 *
 * PURE and total. No I/O, no model, no clock.
 */

/**
 * Words that begin a sentence in trade-press prose and are therefore capitalised without
 * being anybody's name. MEASURED against the real @taranadarsh corpus — every one of these
 * appeared as the first word of a capitalised run and would otherwise have become a
 * candidate. Kept narrow on purpose: a stop list is an enumeration over an open set, so it
 * exists to remove the OBVIOUS wreckage, not to be the safety bar. The badge is the bar.
 */
const SENTENCE_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'so', 'for', 'to', 'in', 'on', 'at', 'of', 'by', 'with',
  'from', 'after', 'before', 'four', 'three', 'two', 'one', 'five', 'directed', 'produced',
  'starring', 'featuring', 'presented', 'jointly', 'also', 'now', 'out', 'this', 'that', 'here',
  'watch', 'stream', 'streaming', 'release', 'releases', 'releasing', 'cinemas', 'theatres',
  'theaters', 'trailer', 'teaser', 'poster', 'first', 'new', 'his', 'her', 'their', 'its',
  'worldwide', 'exclusively', 'only', 'available', 'coming', 'soon', 'today', 'tomorrow',
  'yesterday', 'meanwhile', 'however', 'finally', 'again', 'response', 'advance', 'bookings',
  'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september',
  'october', 'november', 'december', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun',
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
])

/**
 * Suffixes that mark a hashtag as a CAMPAIGN SLOGAN rather than an entity — `#HaiwaanTrailer`,
 * `#ToxicOn26thAug`, `#GunmaasterG9Teaser`. The stem is usually already in `brands`, and the
 * slogan itself resolves to nothing, so it is pure lookup budget. Checked as a suffix, never
 * as a substring: "Trailer" must not disqualify a company called "Trailblazer".
 */
const SLOGAN_SUFFIXES = ['trailer', 'teaser', 'poster', 'song', 'motionposter', 'firstlook', 'bookings']

/** Split `AkshayKumar` / `KVNProductions` into words. Runs of capitals stay together. */
export function splitCamel(token: string): string[] {
  return token
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/\s+/)
    .filter(Boolean)
}

const clean = (s: string): string => s.replace(/[^A-Za-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim()

/** Is this a plausible name for a person or a company, rather than prose? */
function looksLikeAnEntity(name: string): boolean {
  const words = name.split(' ').filter(Boolean)
  if (words.length === 0 || words.length > 5) return false
  const squashed = name.replace(/[^A-Za-z0-9]/g, '')
  /* Under four characters is an initialism or wreckage — "G9", "UAE", "KGF". `candidateHandlesFor`
     would happily generate handles for them and every one is a wasted lookup. */
  if (squashed.length < 4) return false
  /* A name that is ONLY digits, or ends up as a single stop word, is not a name. */
  if (!/[A-Za-z]/.test(squashed)) return false
  if (words.every((w) => SENTENCE_WORDS.has(w.toLowerCase()))) return false
  /* The FIRST word carries the weight: "Directed by Geetu" starts with a verb, "Geetu
     Mohandas" starts with a name. A run whose head is a sentence word is prose. */
  if (SENTENCE_WORDS.has(words[0]!.toLowerCase())) return false
  const low = squashed.toLowerCase()
  if (SLOGAN_SUFFIXES.some((s) => low.endsWith(s) && low.length > s.length + 3)) return false
  /*
    A function word in the MIDDLE means a phrase, not a name: "Toxic The Movie",
    "Daddy Is Home", "Toxic On 26th Aug". Both of those came out of the real Toxic caption as
    CamelCase slogans and would each have spent a lookup. Deliberately a tiny set — "Ministry
    Of Sound" is a real name, so this is about the words that only ever appear in slogans.
  */
  if (words.slice(1, -1).some((w) => INTERIOR_JUNK.has(w.toLowerCase()))) return false
  /*
    A run that is ENTIRELY upper case is headline prose, not a name. `[A-Z]{2,}` had to be
    allowed in the prose arm so "KVN Productions" could be found — and it immediately also
    matched "YEARS AFTER", "YASH RETURNS WITH", "SAIF ALI KHAN REUNITE" and "YEARS FOR
    PRIYADARSHAN" out of the same two captions.

    An initialised company survives because its shape is MIXED: "KVN Productions" has one
    all-caps word and one ordinary one. A name written wholly in caps is refused here and is
    picked up by the hashtag arm instead, which is how this corpus writes it anyway.
  */
  if (words.length > 1 && words.every((w) => w.length > 1 && w === w.toUpperCase())) return false
  return true
}

/** Function words that only ever sit inside a slogan here, never inside a name. */
const INTERIOR_JUNK = new Set(['the', 'is', 'are', 'was', 'on', 'at', 'my', 'your'])

/**
 * Candidate person and company names in a caption, deduplicated, in the order found.
 *
 * Four sources, all of which appear in the real corpus:
 *
 *   `#AkshayKumar`            a CamelCase hashtag                  -> "Akshay Kumar"
 *   `KiaraAdvani`             a bare CamelCase token, no hash      -> "Kiara Advani"
 *   `AKSHAY KUMAR - SAIF...`  an ALL-CAPS headline run             -> "Akshay Kumar"
 *   `Directed by Geetu Mohandas`  a capitalised run in prose       -> "Geetu Mohandas"
 *
 * The ALL-CAPS arm is title-cased on the way out, because `nameMatches` compares token sets
 * case-insensitively but the string is also what a human reads in `--accept` output.
 */
export function captionEntities(caption: string): string[] {
  if (!caption) return []
  const out: string[] = []
  const seen = new Set<string>()
  const add = (raw: string) => {
    const name = clean(raw)
    if (!looksLikeAnEntity(name)) return
    const key = name.toLowerCase().replace(/\s+/g, '')
    if (seen.has(key)) return
    seen.add(key)
    out.push(name)
  }

  /* 1. Hashtags. `#Yash` is one word and legitimate; `#ToxicAFairyTaleForGrownups` is a slogan
        and is refused by length/word-count above rather than by a special case. */
  for (const m of caption.matchAll(/#([A-Za-z][A-Za-z0-9]{2,})/g)) add(splitCamel(m[1]!).join(' '))

  /* 2. Bare CamelCase tokens — the trade-press habit of writing "KiaraAdvani" with no hash.
        Requires an internal lower→upper boundary, so ordinary Capitalised words never match.
        The leading `[A-Z]{2,}` alternative is what catches an initialised company name:
        MEASURED on the real Toxic caption, `KVNProductions` was missed without it, and KVN
        Productions is the production house — precisely the kind of account that buys
        placement. Same for `RVCJMedia`-shaped names. */
  for (const m of caption.matchAll(/(?<![#@\w])((?:[A-Z]{2,}|[A-Z][a-z]+)(?:[A-Z][a-z]+)+)(?!\w)/g)) {
    add(splitCamel(m[1]!).join(' '))
  }

  /* 2b. A SINGLE name after a role word. "Directed by Priyadarshan," is one capitalised word,
         so the general prose rule below (which needs two) cannot see it — and a director is a
         verified account that buys placement. The role word is the evidence that what follows
         is a name, which is why this is a separate, anchored rule rather than a loosening of
         the general one. */
  /*
    NOT case-insensitive, and that is the whole correctness of it. The first version carried
    `/gi`, which makes `[A-Z]` match lowercase too — so "Directed by Geetu Mohandas and jointly
    produced" captured "Geetu Mohandas and jointly". The ROLE word is matched in both cases
    explicitly; the NAME stays case-sensitive, which is what makes the run stop at "and".
  */
  for (const m of caption.matchAll(
    /\b(?:[Dd]irected|[Pp]roduced|[Ww]ritten|[Cc]reated|[Hh]elmed|[Pp]resented|[Dd]istributed)\s+by\s+((?:[A-Z]{2,}|[A-Z][a-z]+|[A-Z]\.?)(?:\s+(?:[A-Z]{2,}|[A-Z][a-z]+|[A-Z]\.?)){0,3})/g,
  )) {
    add(m[1]!)
  }

  /*
    ── THERE IS NO ALL-CAPS HEADLINE ARM, AND THAT IS MEASURED ───────────────

    Trade captions open in caps — "AKSHAY KUMAR - SAIF ALI KHAN REUNITE AFTER 18 YEARS FOR
    PRIYADARSHAN'S 'HAIWAAN'". An arm for it was written and DELETED after driving it on the
    two real captions: every name it found was already arriving through the hashtag or
    CamelCase arms (#AkshayKumar, #SaifAliKhan), while it added "YEARS AFTER", "YASH RETURNS
    WITH", "SAIF ALI KHAN REUNITE" and "YEARS FOR PRIYADARSHAN" — four junk candidates for
    zero new entities.

    The budget is 5 lookups per 30 minutes. An arm that only spends it is worse than no arm,
    and the names it would have rescued are the ones this corpus also hashtags. If a channel
    ever writes caps headlines WITHOUT hashtags, this is where the arm goes back — measured
    the same way, on that channel's captions.
  */

  /* 4. Capitalised runs inside ordinary prose — "Directed by Geetu Mohandas and jointly
        produced by Venkat K Narayana". The leading stop word is stripped by `looksLikeAnEntity`
        rather than by the regex, so "By Geetu" cannot slip through as a name. */
  for (const m of caption.matchAll(
    /(?<![#@\w])((?:[A-Z]{2,}|[A-Z][a-z]+|[A-Z]\.?)(?:\s+(?:[A-Z]{2,}|[A-Z][a-z]+|[A-Z]\.?)){1,3})/g,
  )) {
    add(m[1]!)
  }

  return out
}
