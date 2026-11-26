/**
 * embedParse.ts — PURE. What ONE Instagram embed page says about a profile's badge, or about a post's @mentions.
 *
 * It imports NOTHING, on purpose: `scripts/embed-check-on-mac.sh` fetches this file on its own and runs it from an
 * installed tree BEFORE a new build exists, so the parser a Mac build will ship is the parser that was checked
 * against real pages first.
 *
 * ── WHY THESE PAGES (26 Nov 2026) ─────────────────────────────────────────────────────────────────
 *
 * Since 15 Oct the anonymous feed — the only place the verified badge was ever read — refuses every address we
 * have, and Meta's official read carries no badge, no tags and no "@". MEASURED 26 Nov with
 * `scripts/embed-badge-probe.sh` from the Mac Studio's home address, no login, no cookie:
 *
 *   /<handle>/embed/               page data ties "is_verified" to the asked username: true for @netflix_in and
 *                                  @sonytvofficial, false for @marketingmentalist and @chumbak_official. A handle
 *                                  that does not exist answers 200 WITHOUT profile data.
 *   /p/<shortcode>/embed/captioned/ the caption comes back in class="Caption" with its @mentions LINKED to
 *                                  accounts (DcyE65LPYMj: five of five). Media tags are not on the page.
 *
 * From the server the same pages answer 302 to the login page, so these readers only ever run on a Mac.
 *
 * ── THE ONE DANGEROUS MISTAKE HERE IS A FALSE "VERIFIED" ──────────────────────────────────────────
 *
 * VERIFIED ONLY is the admission rule for every recipient, and this file is what would feed it. `enrichHandle`
 * once read `items[0].user` — the newest post's owner — and so took a COLLABORATOR's badge for the asked account;
 * 29 unverified accounts sat in the live list before anyone noticed. So a badge is read ONLY from an object whose
 * own "username" is the handle that was asked, at that object's own level: never from a neighbour, never from an
 * object nested inside it, never "the nearest value", never page-wide. Two independent methods read it —
 *
 *   exact   the object is cut out of the served bytes with a STRING-AWARE brace walk at the escaping depth the key
 *           was found at, un-escaped by the JSON parser itself, and parsed. A brace inside a biography cannot move
 *           the boundary, and the username is compared after parsing.
 *   flat    the probe's own method, ported: every layer of escaping stripped, then a brace walk that does not know
 *           about strings. It is the method that was RUN against the four control pages on 26 Nov.
 *
 * — and when both answer they must agree, or the reading is `null`. A reading that says both true and false is
 * `null`. `null` is never "not verified": callers treat it as "could not tell", exactly as before.
 *
 * What a page does NOT say is never a verdict either: no username key for the handle is `no-profile-data` (a
 * missing account, a gated one and an empty shell all look like that), and a login page is `wall`.
 */

/** Path segments under instagram.com that are not accounts. The probe's list, plus the ones a caption links. */
export const EMBED_RESERVED_SEGMENTS: ReadonlySet<string> = new Set([
  'p', 'reel', 'reels', 'tv', 'explore', 'accounts', 'stories', 'about', 'legal', 'privacy', 'directory',
  'developer', 'developers', 'web', 'static', 'api', 'graphql', 'challenge', 'embed.js', 'terms', 'help', 'press',
  'blog', 'locations', 'emails', 'oauth', 'share', 's', 'direct', 'tags', 'login',
])

const HANDLE_SHAPE = /^[a-z0-9._]{1,30}$/

/** A handle as we store one: lower case, no "@", no trailing dots. Null when it is not shaped like a handle. */
export function normaliseHandle(input: string): string | null {
  const h = input.trim().replace(/^@/, '').toLowerCase().replace(/\.+$/, '')
  return HANDLE_SHAPE.test(h) ? h : null
}

/** The page as the probe looked at it: control characters out, tabs and line ends as spaces, so it is one line. */
export function oneLine(raw: string): string {
  // eslint-disable-next-line no-control-regex
  return raw.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').replace(/[\t\n\r]/g, ' ')
}

/** ONE layer of HTML entities, `&amp;` last so `&amp;quot;` stays the text `&quot;` and never becomes a quote. */
export function decodeEntities(s: string): string {
  if (!s.includes('&')) return s
  return s
    .replace(/&#[xX]([0-9a-fA-F]{1,6});/g, (m, hex: string) => codePoint(parseInt(hex, 16), m))
    .replace(/&#([0-9]{1,7});/g, (m, dec: string) => codePoint(parseInt(dec, 10), m))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
}

function codePoint(n: number, original: string): string {
  if (!Number.isFinite(n) || n <= 0 || n > 0x10ffff) return original
  try {
    return String.fromCodePoint(n)
  } catch {
    return original
  }
}

/**
 * Every layer of escaping taken off, for LOOKING only — the probe's `flatten`, ported gsub for gsub, because the
 * flat method below must see exactly what the probe saw on 26 Nov. Never use its output as a value: it turns every
 * non-ASCII escape into "~" and cannot tell a quote inside a string from a quote that ends one.
 */
export function flattenEmbed(s: string): string {
  if (s.includes('\\')) {
    s = s
      .replace(/\\+u0022/g, '"')
      .replace(/\\+u0026/g, '&')
      .replace(/\\+u0027/g, "'")
      .replace(/\\+u002[Ff]/g, '/')
      .replace(/\\+u003[Cc]/g, '<')
      .replace(/\\+u003[Dd]/g, '=')
      .replace(/\\+u003[Ee]/g, '>')
      .replace(/\\+u0040/g, '@')
      .replace(/\\+u2019/g, "'")
      .replace(/\\+u[0-9A-Fa-f]{4}/g, '~')
      .replace(/\\+[nrt]/g, ' ')
      .replace(/\\/g, '')
  }
  if (s.includes('&')) {
    s = s
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&#0*34;/g, '"')
      .replace(/&#[xX]22;/g, '"')
      .replace(/&#0*64;/g, '@')
      .replace(/&#[xX]40;/g, '@')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&#0*39;/g, "'")
      .replace(/&#[xX]27;/g, "'")
      .replace(/&apos;/g, "'")
      .replace(/&#0*47;/g, '/')
      .replace(/&#[xX]2[Ff];/g, '/')
  }
  return s
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Is this page a refusal?
// ─────────────────────────────────────────────────────────────────────────────────────────────────

export interface WallMarks {
  /** The page's own <title> reads as a login or sign-up page. */
  titleIsLogin: boolean
  hasPasswordField: boolean
  /** `require_login` or `login_required` appears in the page. */
  requireLogin: boolean
}

function pageTitle(flat: string): string {
  const lower = flat.toLowerCase()
  const i = lower.indexOf('<title')
  if (i < 0) return ''
  const t = flat.slice(i, i + 600)
  const j = t.indexOf('>')
  if (j < 0) return ''
  const rest = t.slice(j + 1)
  const k = rest.toLowerCase().indexOf('</title')
  return (k >= 0 ? rest.slice(0, k) : rest.slice(0, 150)).replace(/ {2,}/g, ' ').trim()
}

function isLoginTitle(title: string): boolean {
  const lt = title.toLowerCase()
  return /^log ?in([^a-z]|$)/.test(lt) || /[^a-z]log ?in$/.test(lt) || /^sign ?up([^a-z]|$)/.test(lt)
}

export function wallMarks(raw: string): WallMarks {
  const flat = flattenEmbed(oneLine(raw))
  const lower = flat.toLowerCase()
  return {
    titleIsLogin: isLoginTitle(pageTitle(flat)),
    hasPasswordField: lower.includes('type="password"') || lower.includes('name="password"'),
    requireLogin: lower.includes('require_login') || lower.includes('login_required'),
  }
}

/** The probe's rule: a page with none of what we came for that looks like a login page IS a login page. */
function isWall(marks: WallMarks, bytes: number): boolean {
  return marks.titleIsLogin || marks.hasPasswordField || (marks.requireLogin && bytes < 3000)
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// The exact method: cut the username's own object out of the served bytes and let JSON.parse read it
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/** Most occurrences of the username key one page is walked for. The probe's bound. */
const MAX_KEYS = 60
/** How far from the key an object's braces are looked for. A profile object carries its posts, so this is large. */
const MAX_OBJECT_SPAN = 2_000_000

/**
 * JSON embedded in a page sits at an escaping DEPTH: 0 is plain (`"username":"x"`), 1 is JSON inside a JSON or
 * script string (`\"username\":\"x\"`), 2 is that again. At depth d a quote that STARTS or ENDS a string is
 * written with r = 2^d − 1 backslashes before it, and a quote INSIDE a string's text with 2^(d+1) − 1; a literal
 * backslash in the text adds runs in multiples of m = 2^(d+1). So for a quote with n backslashes before it:
 * n mod m = r is structural, n mod m = m − 1 is text. Anything else belongs to another depth and is text here.
 */
function depthOfRun(run: number): number | null {
  if (run === 0) return 0
  if (run === 1) return 1
  if (run === 3) return 2
  if (run === 7) return 3
  return null
}

function isStructuralQuote(run: number, depth: number): boolean {
  const m = 2 ** (depth + 1)
  return run % m === 2 ** depth - 1
}

/** Length of the run of backslashes that ends just before position `i`. */
function runBefore(s: string, i: number): number {
  let n = 0
  for (let j = i - 1; j >= 0 && s.charCodeAt(j) === 92; j--) n++
  return n
}

/**
 * The text of the object that directly holds the key at `keyAt` (the position of the key's opening quote), at
 * `depth`. Null when its braces cannot be found inside the span — never a guess.
 */
function enclosingObject(s: string, keyAt: number, depth: number): string | null {
  // LEFT: we start outside a string (a key's opening quote is structural), so each structural quote toggles.
  let inString = false
  let nesting = 0
  let start = -1
  const leftLimit = Math.max(0, keyAt - MAX_OBJECT_SPAN)
  for (let i = keyAt - 1 - runBefore(s, keyAt); i >= leftLimit; i--) {
    const c = s.charCodeAt(i)
    if (c === 34 /* " */) {
      const run = runBefore(s, i)
      if (isStructuralQuote(run, depth)) inString = !inString
      i -= run
      continue
    }
    if (inString) continue
    if (c === 125 /* } */) nesting++
    else if (c === 123 /* { */) {
      if (nesting === 0) {
        start = i
        break
      }
      nesting--
    }
  }
  if (start < 0) return null
  // RIGHT: from the opening brace, string-aware, to the brace that closes it.
  inString = false
  nesting = 0
  const rightLimit = Math.min(s.length, start + MAX_OBJECT_SPAN)
  let run = 0
  for (let i = start; i < rightLimit; i++) {
    const c = s.charCodeAt(i)
    if (c === 92 /* \ */) {
      run++
      continue
    }
    if (c === 34) {
      if (isStructuralQuote(run, depth)) inString = !inString
    } else if (!inString) {
      if (c === 123) nesting++
      else if (c === 125) {
        nesting--
        if (nesting === 0) return s.slice(start, i + 1)
      }
    }
    run = 0
  }
  return null
}

/** Take `depth` layers of string-escaping off, with the JSON parser's own rules. Null when the text is not that. */
function unescapeLayers(text: string, depth: number): string | null {
  let out = text
  for (let d = 0; d < depth; d++) {
    try {
      const v: unknown = JSON.parse(`"${out}"`)
      if (typeof v !== 'string') return null
      out = v
    } catch {
      return null
    }
  }
  return out
}

export interface OwnObjectReading {
  /** How deep the object sat in the page's escaping: 0 plain, 1 inside a string, … */
  depth: number
  /** True when the object was found only after one layer of HTML entities was decoded. */
  viaEntities: boolean
  isVerified: boolean | null
  fullName: string | null
  followers: number | null
  /** The object's own key names (the first forty), so a person can see what else the page says about the account. */
  keys: string[]
}

function readOwnFields(obj: Record<string, unknown>): Pick<OwnObjectReading, 'isVerified' | 'fullName' | 'followers'> {
  const v = obj['is_verified']
  const name = obj['full_name']
  let followers: number | null = null
  for (const key of ['follower_count', 'followers_count']) {
    const n = obj[key]
    if (typeof n === 'number' && Number.isFinite(n) && n >= 0) {
      followers = n
      break
    }
  }
  if (followers === null) {
    const edge = obj['edge_followed_by']
    if (edge && typeof edge === 'object') {
      const n = (edge as Record<string, unknown>)['count']
      if (typeof n === 'number' && Number.isFinite(n) && n >= 0) followers = n
    }
  }
  return {
    isVerified: typeof v === 'boolean' ? v : null,
    fullName: typeof name === 'string' && name.trim() !== '' ? name.trim() : null,
    followers,
  }
}

/**
 * Every object on the page whose OWN "username" is `handle`, parsed. Exported for the check script, which prints
 * how many there were and at what depth.
 */
export function ownObjectsFor(raw: string, handle: string): { objects: OwnObjectReading[]; keysSeen: number; undecodable: number } {
  const objects: OwnObjectReading[] = []
  let keysSeen = 0
  let undecodable = 0
  const variants: Array<{ text: string; viaEntities: boolean }> = [{ text: raw, viaEntities: false }]
  if (raw.includes('&quot;') || raw.includes('&#34;')) variants.push({ text: decodeEntities(raw), viaEntities: true })
  const escaped = handle.replace(/[.]/g, '[.]')
  for (const variant of variants) {
    const s = variant.text
    // The same run of backslashes before all four quotes, or it is not one key at one depth.
    const re = new RegExp(`(\\\\*)"username\\1"\\s*:\\s*\\1"${escaped}\\1"`, 'gi')
    let m: RegExpExecArray | null
    while ((m = re.exec(s)) !== null && keysSeen < MAX_KEYS) {
      keysSeen++
      const run = (m[1] ?? '').length
      const depth = depthOfRun(run)
      if (depth === null) {
        undecodable++
        continue
      }
      const keyAt = m.index + run
      const cut = enclosingObject(s, keyAt, depth)
      const plain = cut === null ? null : unescapeLayers(cut, depth)
      if (plain === null) {
        undecodable++
        continue
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(plain)
      } catch {
        undecodable++
        continue
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        undecodable++
        continue
      }
      const obj = parsed as Record<string, unknown>
      // Compared AFTER parsing: this is the identity check `enrichHandle` did not have.
      if (typeof obj['username'] !== 'string' || obj['username'].toLowerCase() !== handle) {
        undecodable++
        continue
      }
      objects.push({ depth, viaEntities: variant.viaEntities, ...readOwnFields(obj), keys: Object.keys(obj).slice(0, 40) })
    }
  }
  return { objects, keysSeen, undecodable }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// The flat method: the probe's, ported — the one that was RUN on the 26 Nov control pages
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/** The probe's window: how far either side of the key its brace walk looks. */
const FLAT_WINDOW = 900

/** What the flat method counted in the username's own objects. */
export interface FlatReading {
  usernameKeys: number
  ownTrue: number
  ownFalse: number
}

export function flatReadingFor(raw: string, handle: string): FlatReading {
  const F = flattenEmbed(oneLine(raw))
  const escaped = handle.replace(/[.]/g, '[.]')
  const re = new RegExp(`"username" *: *"${escaped}"`, 'g')
  const out: FlatReading = { usernameKeys: 0, ownTrue: 0, ownFalse: 0 }
  let m: RegExpExecArray | null
  while ((m = re.exec(F)) !== null && out.usernameKeys < MAX_KEYS) {
    out.usernameKeys++
    const at = m.index
    const s0 = Math.max(0, at - FLAT_WINDOW)
    const w = F.slice(s0, at + FLAT_WINDOW)
    const rel = at - s0
    let left = ''
    let depth = 0
    for (let i = rel - 1; i >= 0; i--) {
      const c = w[i]
      if (c === '}') {
        depth++
        continue
      }
      if (c === '{') {
        if (depth === 0) break
        depth--
        continue
      }
      if (depth === 0) left = c + left
    }
    let right = ''
    depth = 0
    for (let i = rel; i < w.length; i++) {
      const c = w[i]
      if (c === '{') {
        depth++
        continue
      }
      if (c === '}') {
        if (depth === 0) break
        depth--
        continue
      }
      if (depth === 0) right += c
    }
    // One object says one thing: its first is_verified, as the probe counted each key once per object.
    const own = /"is_verified" *: *(true|false)/.exec(left + right)
    if (own) {
      if (own[1] === 'true') out.ownTrue++
      else out.ownFalse++
    }
  }
  return out
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// A profile embed
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/** Which method answered. `both` means the two agreed. */
export type BadgeBasis = 'both' | 'exact' | 'flat' | 'none'

export type ProfileEmbedReading =
  | {
      kind: 'profile'
      handle: string
      /** null = the page names this account and does not say, or says both, or the two methods disagree. */
      isVerified: boolean | null
      basis: BadgeBasis
      /** Why `isVerified` is null, when it is. */
      undecided: string | null
      /** Only ever from an exactly parsed object: the flat method turns non-ASCII into "~". */
      fullName: string | null
      followers: number | null
      exact: { objects: number; withBadge: number; trueCount: number; falseCount: number; keysSeen: number; undecodable: number; depths: number[] }
      flat: FlatReading
    }
  | { kind: 'no-profile-data'; handle: string; reason: string }
  | { kind: 'wall'; handle: string; reason: string }

function verdictOf(t: number, f: number): 'T' | 'F' | 'M' | '-' {
  if (t > 0 && f === 0) return 'T'
  if (f > 0 && t === 0) return 'F'
  if (t > 0 && f > 0) return 'M'
  return '-'
}

/** PURE. What a profile embed page says about `handle`. See the header for what it refuses to conclude. */
export function parseProfileEmbed(raw: string, handleInput: string): ProfileEmbedReading {
  const handle = normaliseHandle(handleInput)
  if (handle === null) return { kind: 'no-profile-data', handle: handleInput, reason: 'not a handle' }
  const page = oneLine(raw)
  const own = ownObjectsFor(page, handle)
  const flat = flatReadingFor(page, handle)

  if (own.objects.length === 0 && flat.usernameKeys === 0) {
    const marks = wallMarks(raw)
    if (isWall(marks, raw.length)) return { kind: 'wall', handle, reason: wallReason(marks) }
    return { kind: 'no-profile-data', handle, reason: 'the page has no "username" key for this handle' }
  }

  const withBadge = own.objects.filter((o) => o.isVerified !== null)
  const trueCount = withBadge.filter((o) => o.isVerified === true).length
  const falseCount = withBadge.length - trueCount
  const exactSays = verdictOf(trueCount, falseCount)
  const flatSays = verdictOf(flat.ownTrue, flat.ownFalse)

  let isVerified: boolean | null = null
  let basis: BadgeBasis = 'none'
  let undecided: string | null = null
  if (exactSays === 'M' || flatSays === 'M') {
    undecided = 'the account’s own data says both true and false'
  } else if (exactSays !== '-' && flatSays !== '-') {
    if (exactSays === flatSays) {
      isVerified = exactSays === 'T'
      basis = 'both'
    } else {
      undecided = 'the two ways of reading the page disagree'
    }
  } else if (exactSays !== '-') {
    isVerified = exactSays === 'T'
    basis = 'exact'
  } else if (flatSays !== '-') {
    isVerified = flatSays === 'T'
    basis = 'flat'
  } else {
    undecided = 'the page names this account and carries no is_verified beside it'
  }

  // A name and a follower count only from an object that was really parsed, and preferably the one with the badge.
  const fullName = withBadge.find((o) => o.fullName !== null)?.fullName ?? own.objects.find((o) => o.fullName !== null)?.fullName ?? null
  const followers = withBadge.find((o) => o.followers !== null)?.followers ?? own.objects.find((o) => o.followers !== null)?.followers ?? null

  return {
    kind: 'profile',
    handle,
    isVerified,
    basis,
    undecided,
    fullName,
    followers,
    exact: {
      objects: own.objects.length,
      withBadge: withBadge.length,
      trueCount,
      falseCount,
      keysSeen: own.keysSeen,
      undecodable: own.undecodable,
      depths: [...new Set(own.objects.map((o) => o.depth))].sort((a, b) => a - b),
    },
    flat,
  }
}

function wallReason(m: WallMarks): string {
  const parts: string[] = []
  if (m.titleIsLogin) parts.push('the page title is a login page')
  if (m.hasPasswordField) parts.push('a password field')
  if (m.requireLogin) parts.push('require_login')
  return parts.join(', ') || 'a login page'
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// A post embed
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/** The account an href points at, or null. Only instagram.com (or a relative path), first segment, not reserved. */
export function handleFromHref(hrefRaw: string): string | null {
  let p = decodeEntities(hrefRaw).trim()
  if (/^https?:\/\//i.test(p)) {
    p = p.replace(/^https?:\/\//i, '')
    const host = p.replace(/[/?#].*$/, '').toLowerCase()
    if (!/(^|\.)instagram\.com$/.test(host)) return null
    const slash = p.indexOf('/')
    if (slash < 0) return null
    p = p.slice(slash)
  } else if (p.startsWith('//')) {
    p = p.slice(2)
    const host = p.replace(/[/?#].*$/, '').toLowerCase()
    if (!/(^|\.)instagram\.com$/.test(host)) return null
    const slash = p.indexOf('/')
    if (slash < 0) return null
    p = p.slice(slash)
  } else if (!p.startsWith('/')) {
    return null
  }
  const seg = p.replace(/^\/+/, '').replace(/[/?#].*$/, '').toLowerCase()
  if (!HANDLE_SHAPE.test(seg)) return null
  if (EMBED_RESERVED_SEGMENTS.has(seg)) return null
  return seg
}

function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim()
}

/** The probe's caption region: after the tag that carries the class, up to the first `</div` or `<div`. */
function captionRegion(page: string): { region: string; cls: string } | null {
  const re = /class="([^"]*[Cc]aption[^"]*)"/g
  let m: RegExpExecArray | null
  let tries = 0
  while ((m = re.exec(page)) !== null && tries++ < 8) {
    const w = page.slice(m.index, m.index + 60_000)
    const e = w.indexOf('>')
    if (e < 0) continue
    const body = w.slice(e + 1)
    const e1 = body.indexOf('</div')
    const e2 = body.indexOf('<div')
    let cut = e1
    if (e2 >= 0 && (cut < 0 || e2 < cut)) cut = e2
    const region = cut >= 0 ? body.slice(0, cut) : body
    if (stripTags(region) !== '') return { region, cls: m[1] ?? '' }
  }
  return null
}

export type PostEmbedReading =
  | {
      kind: 'post'
      /** The account the caption is signed by (the CaptionUsername link), when the page shows one. */
      owner: string | null
      /**
       * Accounts the caption @mentions, AS INSTAGRAM LINKED THEM: an <a> whose text is "@handle" and whose href
       * goes to that same account. The owner is never one of them. Lower case, in caption order, no duplicates.
       */
      mentions: string[]
      /** The probe's looser count — a linked account whose "@handle" appears anywhere in the caption text. */
      looseMentions: string[]
      /** Every account the caption links, the owner included. */
      linked: string[]
      /** "@" characters in the caption's text. More "@" than mentions means some were not linked. */
      atSigns: number
      captionChars: number
      captionClass: string
    }
  | { kind: 'no-caption'; reason: string }
  | { kind: 'wall'; reason: string }

/** PURE. What a post embed page says the caption mentions. Tags and collaborators are NOT read here. */
export function parsePostEmbed(raw: string): PostEmbedReading {
  const page = oneLine(raw)
  const cap = captionRegion(page)
  if (cap === null) {
    const marks = wallMarks(raw)
    if (isWall(marks, raw.length)) return { kind: 'wall', reason: wallReason(marks) }
    return { kind: 'no-caption', reason: 'no element with a Caption class that has text of its own' }
  }
  const text = stripTags(cap.region)
  const lowerText = text.toLowerCase()
  let owner: string | null = null
  const linked: string[] = []
  const mentions: string[] = []
  const looseMentions: string[] = []
  const anchor = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi
  let m: RegExpExecArray | null
  let seen = 0
  while ((m = anchor.exec(cap.region)) !== null && seen++ < 120) {
    const attrs = m[1] ?? ''
    const href = /\bhref="([^"]*)"/i.exec(attrs)
    if (!href) continue
    const h = handleFromHref(href[1] ?? '')
    if (h === null) continue
    if (!linked.includes(h)) linked.push(h)
    const label = stripTags(m[2] ?? '')
    if (owner === null && /class="[^"]*CaptionUsername[^"]*"/i.test(attrs)) {
      owner = h
      continue
    }
    if (label.toLowerCase().replace(/\.+$/, '') === `@${h}` && !mentions.includes(h)) mentions.push(h)
  }
  for (const h of linked) {
    if (lowerText.includes(`@${h}`) && !looseMentions.includes(h)) looseMentions.push(h)
  }
  const own = owner
  return {
    kind: 'post',
    owner,
    mentions: mentions.filter((h) => h !== own),
    looseMentions,
    linked,
    atSigns: (text.match(/@/g) ?? []).length,
    captionChars: text.length,
    captionClass: cap.cls,
  }
}

/** EVIDENCE, not a reading: the served bytes around the first "username" key for `handle`, for a person to look at. */
export function usernameKeyEvidence(raw: string, handleInput: string): string | null {
  const handle = normaliseHandle(handleInput)
  if (handle === null) return null
  const page = oneLine(raw)
  const m = new RegExp(`username[\\\\"]*\\s*:\\s*[\\\\"]*${handle.replace(/[.]/g, '[.]')}[\\\\"]`, 'i').exec(page)
  if (!m) return null
  return page.slice(Math.max(0, m.index - 220), m.index + 420).replace(/ {2,}/g, ' ')
}

/**
 * EVIDENCE, not a reading: up to `max` cuts of the served bytes around collaborator markup, for a person to look
 * at. Collaborators are not parsed anywhere yet — the 26 Nov probe saw the words (CollabUsername…) and nobody has
 * seen the markup, and a parser written from memory is how a wrong account gets a message.
 */
export function collaboratorEvidence(raw: string, max = 3): string[] {
  const page = oneLine(raw)
  const out: string[] = []
  const re = /Collab(?:Username|Avatar)[A-Za-z]*/g
  let m: RegExpExecArray | null
  let last = -10_000
  while ((m = re.exec(page)) !== null && out.length < max) {
    if (m.index - last < 700) continue
    last = m.index
    out.push(page.slice(Math.max(0, m.index - 160), m.index + 520).replace(/ {2,}/g, ' '))
  }
  return out
}
