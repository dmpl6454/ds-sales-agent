import { describe, it, expect } from 'vitest'
import {
  parseProfileEmbed,
  parsePostEmbed,
  ownObjectsFor,
  flatReadingFor,
  handleFromHref,
  normaliseHandle,
  decodeEntities,
  collaboratorEvidence,
} from '@/detection/embedParse'

/**
 * THE BADGE IS READ ONLY FROM THE ASKED ACCOUNT'S OWN OBJECT — 26 Nov 2026.
 *
 * The pages below are MADE UP: nobody outside the Mac Studio's network can fetch a real embed page, and the
 * 26 Nov probe printed tallies and one snippet a page, not the pages. So these fixtures do not prove the reader
 * matches Instagram — `pnpm ig:embed-check` on the Mac does that, against live pages, before any build. What they
 * pin is the RULE: every shape in which a careless reader would take somebody else's badge, in both directions.
 *
 * The dangerous direction is a false TRUE (VERIFIED ONLY admits on it), so every trap asserts `not true` first.
 */

/** JSON as it sits `depth` strings deep in a page. */
function atDepth(value: unknown, depth: number): string {
  let s = JSON.stringify(value)
  for (let d = 0; d < depth; d++) s = JSON.stringify(s).slice(1, -1)
  return s
}

const page = (body: string, title = 'Instagram') => `<!DOCTYPE html><html><head><title>${title}</title></head><body>${body}</body></html>`

describe('parseProfileEmbed — reading the right object', () => {
  it('reads a plain object: badge, name and followers', () => {
    const data = {
      data: {
        user: {
          username: 'netflix_in',
          full_name: 'Netflix India',
          is_verified: true,
          follower_count: 6734504,
          hd: { is_verified: false },
          friends: [{ username: 'somebody', is_verified: false }],
        },
      },
    }
    const r = parseProfileEmbed(page(`<script type="application/json">${atDepth(data, 0)}</script>`), 'netflix_in')
    expect(r.kind).toBe('profile')
    if (r.kind !== 'profile') return
    expect(r.isVerified).toBe(true)
    expect(r.basis).toBe('both')
    expect(r.fullName).toBe('Netflix India')
    expect(r.followers).toBe(6734504)
  })

  it('reads the same thing one string deep (contextJSON) and two strings deep', () => {
    for (const depth of [1, 2]) {
      const ctx = { context: { username: 'chumbak_official', full_name: 'Chumbak', is_verified: false, followers_count: 412000 } }
      const html = page(`<script>s.handle({"require":[["Embed","init",[],[{"contextJSON":"${atDepth(ctx, depth)}"}]]]})</script>`)
      const r = parseProfileEmbed(html, 'chumbak_official')
      expect(r.kind, `depth ${depth}`).toBe('profile')
      if (r.kind !== 'profile') continue
      expect(r.isVerified, `depth ${depth}`).toBe(false)
      expect(r.fullName).toBe('Chumbak')
      expect(r.followers).toBe(412000)
      expect(r.exact.depths).toEqual([depth])
    }
  })

  it('a name with a quote, an ampersand and non-Latin letters comes back exactly', () => {
    const data = { user: { username: 'sonytvofficial', is_verified: true, full_name: 'Sony & "Friends" सोनी' } }
    const r = parseProfileEmbed(page(`<script type="application/json">${atDepth(data, 0)}</script>`), 'sonytvofficial')
    expect(r.kind === 'profile' && r.fullName).toBe('Sony & "Friends" सोनी')
  })

  /** THE @yamigautam DEFECT (23 Aug): the newest post's owner was a collaborator, and its badge was taken. */
  it('never takes a collaborator’s badge for the asked account', () => {
    const data = {
      items: [{ user: { username: 'amazonmgmstudiosin', full_name: 'Amazon MGM Studios India', is_verified: true } }],
      user: { username: 'yamigautam', full_name: 'Yami Gautam Dhar', is_verified: false },
    }
    const html = page(`<script type="application/json">${atDepth(data, 0)}</script>`)
    const asked = parseProfileEmbed(html, 'yamigautam')
    expect(asked.kind).toBe('profile')
    if (asked.kind === 'profile') {
      expect(asked.isVerified).not.toBe(true)
      expect(asked.isVerified).toBe(false)
      expect(asked.fullName).toBe('Yami Gautam Dhar')
    }
    const other = parseProfileEmbed(html, 'amazonmgmstudiosin')
    expect(other.kind === 'profile' && other.isVerified).toBe(true)
  })

  it('does not read the NEAREST value, a nested object’s value, or a neighbour’s', () => {
    const data = [
      { username: 'neighbour', is_verified: true },
      { username: 'asked.one', pic: { is_verified: true }, full_name: 'Asked One' },
      { username: 'after', is_verified: true },
    ]
    const r = parseProfileEmbed(page(`<script type="application/json">${atDepth(data, 0)}</script>`), 'asked.one')
    expect(r.kind).toBe('profile')
    if (r.kind !== 'profile') return
    expect(r.isVerified).not.toBe(true)
    expect(r.isVerified).toBeNull()
    expect(r.undecided).toMatch(/no is_verified/)
    expect(r.fullName).toBe('Asked One')
  })

  it('a dot in a handle is a dot, and a longer handle is a different account', () => {
    const data = [
      { username: 'askedXone', is_verified: true },
      { username: 'asked.one_official', is_verified: true },
    ]
    const r = parseProfileEmbed(page(`<script type="application/json">${atDepth(data, 0)}</script>`), 'asked.one')
    expect(r.kind).toBe('no-profile-data')
  })

  it('says nothing when the account’s own objects say both', () => {
    const data = { a: { username: 'asked', is_verified: true }, b: { username: 'asked', is_verified: false } }
    const r = parseProfileEmbed(page(`<script type="application/json">${atDepth(data, 0)}</script>`), 'asked')
    expect(r.kind).toBe('profile')
    if (r.kind !== 'profile') return
    expect(r.isVerified).toBeNull()
    expect(r.undecided).toMatch(/both/)
  })

  it('agrees with itself when every own object says the same', () => {
    const data = { a: { username: 'asked', is_verified: false }, b: { owner: { username: 'asked', is_verified: false } } }
    const r = parseProfileEmbed(page(`<script type="application/json">${atDepth(data, 0)}</script>`), 'asked')
    expect(r.kind === 'profile' && r.isVerified).toBe(false)
  })

  /**
   * WHY THERE ARE TWO METHODS. A brace inside a biography moves the flat method's boundary: here it walks out of
   * the asked account's object and reads the PARENT's `is_verified: true`. The exact method knows a string when
   * it sees one. They disagree, and a disagreement is `null` — the flat method alone would have admitted this.
   */
  it('a brace inside a string cannot move the boundary — and where the two methods disagree, nothing is said', () => {
    const data = { wrap: { username: 'asked', bio: 'a { b', is_verified: false }, is_verified: true }
    const html = page(`<script type="application/json">${atDepth(data, 0)}</script>`)
    expect(flatReadingFor(html, 'asked')).toMatchObject({ ownTrue: 1, ownFalse: 0 })
    const own = ownObjectsFor(html, 'asked')
    expect(own.objects.map((o) => o.isVerified)).toEqual([false])
    const r = parseProfileEmbed(html, 'asked')
    expect(r.kind).toBe('profile')
    if (r.kind !== 'profile') return
    expect(r.isVerified).not.toBe(true)
    expect(r.isVerified).toBeNull()
    expect(r.undecided).toMatch(/disagree/)
  })

  it('a quote and a closing brace inside a string, one string deep, do not end the object early', () => {
    const ctx = { context: { username: 'asked', biography: 'say "hi" } and \\ more {', is_verified: true, full_name: 'A "B" C' } }
    const html = page(`<script>x({"contextJSON":"${atDepth(ctx, 1)}"})</script>`)
    const own = ownObjectsFor(html, 'asked')
    expect(own.objects).toHaveLength(1)
    expect(own.objects[0]).toMatchObject({ isVerified: true, fullName: 'A "B" C', depth: 1 })
  })

  it('a username written in another letter case is still that account, read exactly', () => {
    const data = { user: { username: 'Netflix_IN', is_verified: true } }
    const r = parseProfileEmbed(page(`<script type="application/json">${atDepth(data, 0)}</script>`), 'netflix_in')
    expect(r.kind).toBe('profile')
    if (r.kind !== 'profile') return
    expect(r.isVerified).toBe(true)
    expect(r.basis).toBe('exact')
  })

  it('is_verified must be a real true or false — a string or a number is not a badge', () => {
    for (const bad of ['true', 1, null, 'yes']) {
      const data = { user: { username: 'asked', is_verified: bad } }
      const r = parseProfileEmbed(page(`<script type="application/json">${atDepth(data, 0)}</script>`), 'asked')
      expect(r.kind === 'profile' ? r.isVerified : 'x', String(bad)).toBeNull()
    }
  })
})

/**
 * THE ACCOUNT WRITES SOME OF ITS OWN PAGE. A biography is typed text and it is on the page, so somebody can type
 * something shaped like the page's data. Every case below is an UNVERIFIED account whose page carries a typed
 * `"is_verified":true` for its own username; none may read as verified.
 */
describe('parseProfileEmbed — text an account typed is not the page\u2019s data', () => {
  const forged = '{"username":"asked","is_verified":true}'

  it('typed into its biography: the real object is shallower, and the typed one does not count', () => {
    const data = { user: { username: 'asked', biography: forged, is_verified: false, full_name: 'Asked' } }
    for (const depth of [0, 1]) {
      const body = depth === 0 ? atDepth(data, 0) : `{"contextJSON":"${atDepth(data, 1)}"}`
      const r = parseProfileEmbed(page(`<script type="application/json">${body}</script>`), 'asked')
      expect(r.kind, `depth ${depth}`).toBe('profile')
      if (r.kind !== 'profile') continue
      expect(r.isVerified, `depth ${depth}`).not.toBe(true)
      // the exact method read the REAL object alone; the flat one saw both and took the verdict away
      expect(r.exact.trusted).toBe(1)
      expect(r.exact.falseCount).toBe(1)
      expect(r.exact.trueCount).toBe(0)
    }
  })

  it('typed into its biography when the real object carries no badge at all', () => {
    const data = { user: { username: 'asked', biography: forged, full_name: 'Asked' } }
    const r = parseProfileEmbed(page(`<script type="application/json">${atDepth(data, 0)}</script>`), 'asked')
    expect(r.kind).toBe('profile')
    if (r.kind !== 'profile') return
    expect(r.isVerified).toBeNull()
    expect(r.exact.objects).toBe(2)
    expect(r.exact.trusted).toBe(1)
  })

  it('shown as visible text outside any script, with real quotes', () => {
    const r = parseProfileEmbed(page(`<div class="Bio">${forged}</div>`), 'asked')
    expect(r.kind).toBe('profile')
    if (r.kind !== 'profile') return
    expect(r.isVerified).toBeNull()
    expect(r.exact.objects).toBe(1)
    expect(r.exact.trusted).toBe(0)
    expect(r.undecided).toMatch(/not enough/)
  })

  it('shown as visible text with its quotes as HTML entities — never decoded into data', () => {
    const r = parseProfileEmbed(page(`<div class="Bio">{&quot;username&quot;:&quot;asked&quot;,&quot;is_verified&quot;:true}</div>`), 'asked')
    expect(r.kind).toBe('profile')
    if (r.kind !== 'profile') return
    expect(r.isVerified).toBeNull()
    expect(r.exact.objects).toBe(0)
    expect(r.flat.ownTrue).toBe(1)
  })

  it('visible text beside a real, shallower-or-deeper object in a script: the script\u2019s object is the one read, and the two disagree', () => {
    const data = { context: { username: 'asked', is_verified: false } }
    const r = parseProfileEmbed(page(`<div>${forged}</div><script>x({"contextJSON":"${atDepth(data, 1)}"})</script>`), 'asked')
    expect(r.kind).toBe('profile')
    if (r.kind !== 'profile') return
    expect(r.isVerified).not.toBe(true)
    expect(r.exact.trusted).toBe(1)
    expect(r.exact.falseCount).toBe(1)
  })

  it('an object whose LAST "username" is somebody else is somebody else\u2019s object', () => {
    // JSON.parse keeps the last of two keys. The pattern that found this object matched the first.
    const r = parseProfileEmbed(page('<script type="application/json">{"u":{"username":"asked","is_verified":true,"username":"other"}}</script>'), 'asked')
    expect(r.kind).toBe('profile')
    if (r.kind !== 'profile') return
    expect(r.isVerified).toBeNull()
    expect(r.exact.objects).toBe(0)
  })

  it('and none of this stops an honest page: a verified account with braces and quotes in its biography reads verified', () => {
    const data = { context: { username: 'asked', biography: 'we make {things} "well"', is_verified: true, full_name: 'Asked Co' } }
    const r = parseProfileEmbed(page(`<script>x({"contextJSON":"${atDepth(data, 1)}"})</script>`), 'asked')
    expect(r.kind === 'profile' && r.isVerified).toBe(true)
  })
})

describe('parseProfileEmbed — what a page does not say is not a verdict', () => {
  it('a page that never names the account in its data is no-profile-data, whatever else it holds', () => {
    const html = page(`<script type="application/json">{"viewer":{"username":"somebody","is_verified":true}}</script><p>@ghost_handle</p>`)
    expect(parseProfileEmbed(html, 'ghost_handle')).toMatchObject({ kind: 'no-profile-data' })
  })

  it('a login page is a wall, not an unverified account', () => {
    const html = page('<form><input type="password" name="password"></form>', 'Login • Instagram')
    expect(parseProfileEmbed(html, 'netflix_in')).toMatchObject({ kind: 'wall' })
  })

  it('a small require_login answer is a wall', () => {
    expect(parseProfileEmbed('{"message":"Please wait","require_login":true}', 'netflix_in')).toMatchObject({ kind: 'wall' })
  })

  it('refuses something that is not a handle', () => {
    expect(parseProfileEmbed('<html></html>', 'not a handle!')).toMatchObject({ kind: 'no-profile-data', reason: 'not a handle' })
  })
})

describe('parsePostEmbed — the caption’s @mentions as Instagram linked them', () => {
  const caption = [
    '<div class="Caption"><a class="CaptionUsername" href="https://www.instagram.com/officialsocialsamosa/?utm_source=ig_embed&amp;ig_rid=Ab12" data-ios-link="user?username=officialsocialsamosa" target="_blank">officialsocialsamosa</a>',
    ' Festive camp with <a href="https://www.instagram.com/itsbevygood/?utm_source=ig_embed&amp;ig_rid=Ab12" target="_blank">@itsbevygood</a>,',
    ' <a href="/plumbodylovin/">@plumbodylovin</a> and <a href="//www.instagram.com/SuperSox_India/">@SuperSox_India</a>.',
    ' <a href="https://www.instagram.com/explore/tags/festive/">#festive</a> write to hello@example.com',
    ' <a href="https://evil.example/farmleyin/">@farmleyin</a>',
    ' <a href="https://www.instagram.com/realbrand/">@otherbrand</a>',
    ' <a href="https://www.instagram.com/officialsocialsamosa/">@officialsocialsamosa</a>',
    ' <a href="https://www.instagram.com/hkvitals/">@hkvitals.</a>',
    '<div class="CaptionComments">later <a href="https://www.instagram.com/commenter/">@commenter</a></div></div>',
  ].join('')

  it('keeps a mention only when the link text is "@handle" and the link goes to that same account', () => {
    const r = parsePostEmbed(page(caption))
    expect(r.kind).toBe('post')
    if (r.kind !== 'post') return
    expect(r.owner).toBe('officialsocialsamosa')
    expect(r.mentions).toEqual(['itsbevygood', 'plumbodylovin', 'supersox_india', 'hkvitals'])
    // an off-site link, a link whose text names another account, the owner, a hashtag, and a comment are not mentions
    expect(r.mentions).not.toContain('farmleyin')
    expect(r.mentions).not.toContain('realbrand')
    expect(r.mentions).not.toContain('otherbrand')
    expect(r.mentions).not.toContain('officialsocialsamosa')
    expect(r.mentions).not.toContain('commenter')
    expect(r.linked).toContain('realbrand')
    expect(r.atSigns).toBeGreaterThanOrEqual(7)
  })

  it('a caption with no linked mention has none, and says so rather than failing', () => {
    const r = parsePostEmbed(page('<div class="Caption"><a class="CaptionUsername" href="https://www.instagram.com/taranadarsh/">taranadarsh</a> A plain caption about a film.</div>'))
    expect(r).toMatchObject({ kind: 'post', owner: 'taranadarsh', mentions: [], atSigns: 0 })
  })

  it('no caption is no-caption; a login page is a wall', () => {
    expect(parsePostEmbed(page('<div class="Embed">nothing here</div>'))).toMatchObject({ kind: 'no-caption' })
    expect(parsePostEmbed(page('<input type="password">', 'Log in'))).toMatchObject({ kind: 'wall' })
  })

  it('skips an empty Caption element and reads the one with text', () => {
    const html = page('<div class="CaptionIcon"></div><div class="Caption"><a class="CaptionUsername" href="/owner_page/">owner_page</a> hi <a href="/brand_one/">@brand_one</a></div>')
    expect(parsePostEmbed(html)).toMatchObject({ kind: 'post', owner: 'owner_page', mentions: ['brand_one'] })
  })
})

describe('small parts', () => {
  it('handleFromHref takes only an instagram.com account path', () => {
    expect(handleFromHref('https://www.instagram.com/Netflix_IN/?utm_source=ig_embed&amp;x=1')).toBe('netflix_in')
    expect(handleFromHref('/a.b_c/')).toBe('a.b_c')
    expect(handleFromHref('//instagram.com/abc')).toBe('abc')
    expect(handleFromHref('https://www.instagram.com/p/Dcc4pQ8sX0N/')).toBeNull()
    expect(handleFromHref('https://www.instagram.com/explore/tags/x/')).toBeNull()
    expect(handleFromHref('https://notinstagram.com/abc/')).toBeNull()
    expect(handleFromHref('https://instagram.com.evil.example/abc/')).toBeNull()
    expect(handleFromHref('abc')).toBeNull()
    expect(handleFromHref('https://www.instagram.com/')).toBeNull()
    expect(handleFromHref('/way_too_long_to_be_a_real_instagram_handle_x/')).toBeNull()
  })

  it('normaliseHandle', () => {
    expect(normaliseHandle('@Netflix_IN')).toBe('netflix_in')
    expect(normaliseHandle('hkvitals.')).toBe('hkvitals')
    expect(normaliseHandle('has space')).toBeNull()
    expect(normaliseHandle('')).toBeNull()
  })

  it('decodeEntities takes ONE layer off, so &amp;quot; never becomes a quote', () => {
    expect(decodeEntities('&amp;quot;')).toBe('&quot;')
    expect(decodeEntities('&quot;a&quot; &#64; &#x40; &lt;b&gt;')).toBe('"a" @ @ <b>')
  })

  it('collaboratorEvidence only cuts text out for a person to read', () => {
    const html = page('<div class="CollabUsernameRow"><a class="CollabUsername" href="/partner_page/">partner_page</a></div>')
    const ev = collaboratorEvidence(html)
    expect(ev.length).toBe(1)
    expect(ev[0]).toContain('partner_page')
    expect(collaboratorEvidence(page('<div>none</div>'))).toEqual([])
  })
})
