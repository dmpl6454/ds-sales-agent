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
      const src = readFileSync(file, 'utf8')
      const isFeed = file.endsWith('/detection/feed.ts')
      if (/936619743392459/.test(src) && !isFeed) offenders.push(`${file}: retired web app id`)
      if (/www\.instagram\.com\/api\/v1\//.test(src)) offenders.push(`${file}: web API host`)
      if (/'User-Agent':\s*\n?\s*'(Mozilla|Instagram)/.test(src) && !isFeed) offenders.push(`${file}: its own User-Agent`)
    }
    expect(offenders).toEqual([])
  })
})
