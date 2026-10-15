/**
 * Every anonymous Instagram read presents ONE identity, defined once (feed.ts, 8 Sept 2026).
 *
 * The web identity (www host, app id 936619743392459, a Chrome User-Agent) was refused for
 * four days from four unrelated networks while the Android app's identity was served on the
 * same networks the same minute. When the next such change comes, it must be one edit —
 * four copies of a User-Agent are four places for it to be half-applied, which is how the
 * anonymous gate itself arrived. So: no module under src/detection may declare its own
 * Instagram identity, and the retired web constants must not come back anywhere.
 */
import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { FEED_HEADERS, IG_APP_ID, IG_HOST } from '@/detection/feed'

const root = join(process.cwd(), 'src')
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const full = join(dir, name)
    if (name === 'generated') return []
    return statSync(full).isDirectory() ? walk(full) : full.endsWith('.ts') || full.endsWith('.tsx') ? [full] : []
  })

describe('one anonymous Instagram identity', () => {
  it('is the Android app on i.instagram.com, with no cookie and no session anywhere in it', () => {
    expect(IG_HOST).toBe('https://i.instagram.com')
    expect(FEED_HEADERS['X-IG-App-ID']).toBe(IG_APP_ID)
    expect(FEED_HEADERS['User-Agent']).toMatch(/^Instagram \d/)
    for (const k of Object.keys(FEED_HEADERS)) expect(k.toLowerCase()).not.toMatch(/cookie|authorization/)
  })

  it('no other file declares an Instagram User-Agent or the retired web app id or host', () => {
    const offenders: string[] = []
    for (const file of walk(root)) {
      // The browser driver is the LOGGED-IN web app itself (identify() asks the web endpoints
      // from inside a signed-in Chrome). That is the web identity legitimately, and it is not
      // an anonymous read — this test is about sessionless reads only.
      if (file.includes('/outreach/browser/')) continue
      // feed.ts is checked below, with its one sanctioned exception cut out first.
      if (file.endsWith('/detection/feed.ts')) continue
      const src = readFileSync(file, 'utf8')
      if (/936619743392459/.test(src)) offenders.push(`${file}: retired web app id`)
      if (/www\.instagram\.com\/api\/v1\//.test(src)) offenders.push(`${file}: web API host`)
      if (/'User-Agent':\s*\n?\s*'(Mozilla|Instagram)/.test(src)) offenders.push(`${file}: its own User-Agent`)
    }
    expect(offenders).toEqual([])
  })

  /**
   * THE ONE OTHER PLACE AN IDENTITY MAY LIVE (15 Oct 2026): FEED_IDENTITY_PROBES, the candidates
   * `pnpm ig:probe` asks with — a newer app version and the retired web identity as a control. They
   * are declared in feed.ts so this file stays the single home of every identity; and OUTSIDE that
   * array feed.ts must still declare exactly one (FEED_HEADERS) and, in code, neither the web app id
   * nor the web host. So a probe candidate can never become the production identity by accident.
   * MUTATION (applied by hand, saw red, restored): moving the web control's
   * `'x-ig-app-id': '936619743392459'` into FEED_HEADERS fails "outside the probes, feed.ts …".
   */
  describe('feed.ts — FEED_IDENTITY_PROBES is the only other place', () => {
    const src = readFileSync(join(root, 'detection', 'feed.ts'), 'utf8')
    // `Accept: '*/*'` is a header value, and its `/*` would read as a comment opening and swallow
    // code up to the next docblock's end — so that literal is neutralised before comments go.
    const code = src
      .replace(/(['"])\*\/\*\1/g, '$1any$1')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
    /** The array literal, by bracket matching from its `= [`. A scan that cannot close fails, never skips. */
    const block = (() => {
      const start = code.indexOf('export const FEED_IDENTITY_PROBES')
      const open = code.indexOf('[', code.indexOf('=', start))
      let depth = 0
      for (let i = open; i < code.length; i++) {
        if (code[i] === '[') depth++
        else if (code[i] === ']' && --depth === 0) return code.slice(start, i + 1)
      }
      return null
    })()

    it('the probes block is found, and it is where the web control lives', () => {
      expect(block).not.toBeNull()
      expect(block).toMatch(/www\.instagram\.com\/api\/v1\//)
      expect(block).toMatch(/936619743392459/)
    })

    it('outside the probes, feed.ts declares exactly one User-Agent and no web identity in code', () => {
      const outside = code.replace(block ?? '', '')
      expect(outside).not.toMatch(/936619743392459/)
      expect(outside).not.toMatch(/www\.instagram\.com\/api\/v1\//)
      expect(outside.match(/'User-Agent':\s*\n?\s*'(Mozilla|Instagram)/g) ?? []).toHaveLength(1)
    })
  })
})
