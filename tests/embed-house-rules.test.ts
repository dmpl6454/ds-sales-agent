import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * THE EMBED READER'S HOUSE RULES — SOURCE GREPS, because each failure here is a line nobody has written yet.
 *
 * `tests/one-instagram-identity.test.ts` says every anonymous Instagram read presents ONE identity. Since 26 Nov
 * 2026 there is deliberately a SECOND one: a desktop Chrome loading an embed page in an iframe, for exactly two
 * kinds of URL. This file is what keeps that second identity from spreading, and keeps the things around it true:
 *
 *   1. one file builds embed URLs and the browser identity, and it carries no API identity and no cookie;
 *   2. production reaches it only through the gated door; a person's probe reaches it and touches no gate;
 *   3. the three files the Mac check downloads on their own import nothing but each other and Node;
 *   4. the agent runs the post step inside the role-checked brand pass, in its own try, with a named budget;
 *   5. the switch ships OFF.
 *
 * Comments are stripped before every check: a docblock that MENTIONS a call is not a call.
 */

const src = join(process.cwd(), 'src')
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const full = join(dir, name)
    if (name === 'generated') return []
    return statSync(full).isDirectory() ? walk(full) : full.endsWith('.ts') || full.endsWith('.tsx') ? [full] : []
  })
const rel = (file: string): string => file.slice(src.length + 1)
const code = (file: string): string =>
  readFileSync(file, 'utf8')
    .replace(/(['"])\*\/\*\1/g, '$1any$1') // `'*/*'` is a header value, not a comment end
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\s\/\/ .*$/gm, '')
const all = walk(src)
const filesWhoseCodeMatches = (re: RegExp): string[] => all.filter((f) => re.test(code(f))).map(rel).sort()

describe('one file is the embed identity', () => {
  it('only embedFetch.ts builds an embed URL', () => {
    expect(filesWhoseCodeMatches(/\/embed\//)).toEqual(['detection/embedFetch.ts'])
  })

  it('only embedFetch.ts (and the logged-in browser driver, and feed.ts’s probe list) spells a browser User-Agent', () => {
    const offenders = filesWhoseCodeMatches(/Mozilla\/5\.0/).filter((f) => !f.startsWith('outreach/browser/') && f !== 'detection/feed.ts')
    expect(offenders).toEqual(['detection/embedFetch.ts'])
  })

  it('embedFetch.ts carries no API identity, no API path, and never a cookie or a credential', () => {
    const c = code(join(src, 'detection', 'embedFetch.ts'))
    expect(c).not.toMatch(/x-ig-app-id/i)
    expect(c).not.toMatch(/\/api\/v1\//)
    expect(c).not.toMatch(/i\.instagram\.com/)
    expect(c).not.toMatch(/graph\.(facebook|instagram)\.com/)
    expect(c).not.toMatch(/['"`](cookie|authorization|x-csrftoken)['"`]/i)
    expect(c).not.toMatch(/sessionid/i)
    // and it never reads a cookie an answer set: the only place "set-cookie" could matter is a parser, and there is none
    expect(c).not.toMatch(/set-cookie/i)
    // no redirect is followed by the client itself, and curl is given no cookie jar
    expect(c).not.toMatch(/['"]-L['"]|['"]--location['"]|['"]-b['"]|['"]-c['"]|cookie-jar/)
  })

  it('the app-identity readers never ask for an embed page', () => {
    for (const name of ['feed.ts', 'exists.ts', 'resolveBrand.ts', 'igHttp.ts', 'graphFeed.ts']) {
      const c = code(join(src, 'detection', name))
      expect(c, name).not.toMatch(/embedFetch|fetchEmbed/)
    }
  })
})

describe('production reaches it only through the gated door', () => {
  it('fetchEmbed is called from the door and from the person’s check, nowhere else', () => {
    expect(filesWhoseCodeMatches(/\bfetchEmbed\(/).filter((f) => f !== 'detection/embedFetch.ts')).toEqual(['scripts/embed-check.ts'])
    // the door calls it through its seam (`fetch: fetchEmbed`), so it is found by the import instead
    expect(filesWhoseCodeMatches(/import[^;]*\bfetchEmbed\b[^;]*from/).sort()).toEqual(['detection/embedDoor.ts', 'scripts/embed-check.ts'])
  })

  it('the door asks the gate before a request, and records a refusal and a success under the embed scope', () => {
    const c = code(join(src, 'detection', 'embedDoor.ts'))
    expect(c).toMatch(/anonGateCheck\('embed'\)/)
    expect(c).toMatch(/anonGateRecordThrottle\('embed'/)
    expect(c).toMatch(/anonGateRecordSuccess\('embed'\)/)
    // never the other doors' scopes: an embed answer must not open or close the feed or the profile door
    expect(c).not.toMatch(/anonGate(Check|RecordThrottle|RecordSuccess)\('(feed|profile|exists)'/)
    // and it asks the switch and the machine
    expect(c).toMatch(/env\.SEND_ENABLED/)
    expect(c).toMatch(/settings\.embedReads/)
  })

  it('only three files ask the door', () => {
    // by import: embedEvidence.ts hands the reader on as a value (`opts.read ?? readPostEmbed`), with no call parens
    expect(filesWhoseCodeMatches(/import[^;]*\bread(Profile|Post)Embed\b[^;]*from/)).toEqual([
      'detection/embedEvidence.ts',
      'detection/enrichHandle.ts',
      'scripts/embed-evidence.ts',
    ])
  })

  it('a person’s check touches no gate, no database and no setting', () => {
    const c = code(join(src, 'scripts', 'embed-check.ts'))
    expect(c).not.toMatch(/anonGate/)
    expect(c).not.toMatch(/prisma|getSettings|@\/lib\//)
  })
})

describe('the three files the Mac check downloads stand on their own', () => {
  const imports = (file: string): string[] => [...code(file).matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1] ?? '')

  it('embedParse.ts imports nothing at all', () => {
    expect(imports(join(src, 'detection', 'embedParse.ts'))).toEqual([])
  })

  it('embedFetch.ts imports only Node', () => {
    for (const spec of imports(join(src, 'detection', 'embedFetch.ts'))) expect(spec).toMatch(/^node:/)
  })

  it('embed-check.ts imports only Node and those two, by relative path', () => {
    const specs = imports(join(src, 'scripts', 'embed-check.ts'))
    expect(specs.filter((s) => !s.startsWith('node:')).sort()).toEqual(['../detection/embedFetch', '../detection/embedParse'])
  })

  it('the Mac script downloads exactly those three', () => {
    const sh = readFileSync(join(process.cwd(), 'scripts', 'embed-check-on-mac.sh'), 'utf8')
    expect(sh).toContain('for f in src/detection/embedParse.ts src/detection/embedFetch.ts src/scripts/embed-check.ts; do')
  })
})

describe('the agent runs the post step inside the brand pass', () => {
  const agent = code(join(src, 'agent', 'index.ts'))
  const body = agent.slice(agent.indexOf('async function brandPass('), agent.indexOf('let replyPassStartedAt'))

  it('after the role check, in its own try, with a named budget', () => {
    expect(body.length).toBeGreaterThan(500)
    const role = body.indexOf('thisMacRole()')
    const post = body.indexOf('await postEmbedPass(')
    const auto = body.indexOf('await autoResolveBrands(')
    expect(role).toBeGreaterThan(-1)
    expect(post).toBeGreaterThan(role)
    // first, so the handles it restores are candidates in the same pass
    expect(post).toBeLessThan(auto)
    expect(body).toMatch(/try \{\s*const embed = await postEmbedPass\(\{ maxReads: POST_EMBED_READS_PER_PASS \}\)/)
    expect(body).toMatch(/log\.error\('post embed pass failed'/)
    expect(agent).toMatch(/const POST_EMBED_READS_PER_PASS = \d+/)
  })

  it('asks about asserted handles (the badge door) before guessed ones (official-page discovery)', () => {
    expect(body.indexOf('await badgeDoorPass(')).toBeGreaterThan(-1)
    expect(body.indexOf('await badgeDoorPass(')).toBeLessThan(body.indexOf('await discoverOfficialPages('))
  })
})

describe('the switch ships off', () => {
  const settings = readFileSync(join(src, 'lib', 'settings.ts'), 'utf8')
  it('embedReads defaults to false, and the client to the one that was measured', () => {
    expect(settings).toMatch(/embedReads: 'embedReads'/)
    expect(settings).toMatch(/\n\s+embedReads: false,/)
    expect(settings).toMatch(/\n\s+embedTransport: 'curl',/)
    expect(settings).toMatch(/embedReads: bool\(SETTING_KEYS\.embedReads, d\.embedReads\)/)
  })
})
