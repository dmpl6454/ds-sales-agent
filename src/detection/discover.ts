import { chromium, type Browser } from 'playwright'
import type { DiscoveredPost } from './types'
import { log } from '@/lib/logger'
import { env } from '@/lib/env'

/**
 * Discovery: read a profile grid and return the shortcodes it shows.
 *
 * Verified 2026-07-29:
 *   - A raw HTTP GET of a profile page returns 684 KB of JS shell and ZERO
 *     shortcodes. The grid is client-rendered, so a browser is unavoidable here.
 *   - A logged-OUT rendered page does expose 12 post links behind the signup
 *     overlay. That is enough, and it means discovery needs no credentials and
 *     therefore cannot put any of our accounts at risk.
 *
 * Coverage limitation, accepted for Phase 1: the grid shows 12 posts. MOM posts
 * ~3/day so 12 spans days. Viral Bhayani posted 12+ in a single morning, so
 * between the 20:00 and 11:00 slots some posts will roll off unseen. This costs
 * nothing in Phase 1 (detection supplies a hook line, not the prospect list) and
 * is the specific trigger for adding a paginating source in Phase 1.5.
 */

export class DiscoverError extends Error {
  constructor(
    public readonly handle: string,
    message: string,
    /** True when the page loaded but yielded no posts — i.e. the parser or the
     *  page shape broke. This is an ALARM, not a quiet day. */
    public readonly isParseFailure = false,
  ) {
    super(`[@${handle}] ${message}`)
    this.name = 'DiscoverError'
  }
}

const SHORTCODE_RE = /\/(?:p|reel)\/([A-Za-z0-9_-]{5,20})/

let sharedBrowser: Browser | null = null

/** One browser for the whole run — launching Chromium per channel is wasteful. */
async function getBrowser(): Promise<Browser> {
  if (sharedBrowser?.isConnected()) return sharedBrowser
  sharedBrowser = await chromium.launch({ headless: env.HEADLESS })
  return sharedBrowser
}

export async function closeBrowser(): Promise<void> {
  if (sharedBrowser?.isConnected()) await sharedBrowser.close()
  sharedBrowser = null
}

/**
 * Fresh, stateless context per channel: no cookies, no storage, no session.
 * Detection deliberately carries no identity.
 */
export async function discoverProfile(handle: string, attempt = 1): Promise<DiscoveredPost[]> {
  const browser = await getBrowser()
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
    locale: 'en-US',
    viewport: { width: 1440, height: 900 },
  })

  try {
    const page = await context.newPage()
    // Images/media are irrelevant to us and dominate load time.
    await page.route('**/*.{png,jpg,jpeg,webp,gif,mp4,woff,woff2}', (route) => route.abort())

    const res = await page.goto(`https://www.instagram.com/${handle}/`, {
      waitUntil: 'domcontentloaded',
      timeout: 30_000,
    })
    if (res && res.status() >= 400) {
      throw new DiscoverError(handle, `profile returned HTTP ${res.status()}`)
    }

    // Wait for at least one post link rather than a fixed sleep.
    await page
      .waitForSelector('a[href*="/p/"], a[href*="/reel/"]', { timeout: 15_000 })
      .catch(() => undefined)

    // NOTE: `$$eval` is Playwright's DOM-query helper — it serialises the callback
    // below and runs it against matched elements inside the page. It is not
    // JavaScript `eval()`; no string is ever executed, and no external input
    // reaches it. Static scanners sometimes flag the name.
    const hrefs = await page.$$eval('a[href*="/p/"], a[href*="/reel/"]', (els) =>
      els.map((e) => e.getAttribute('href') ?? ''),
    )

    const seen = new Set<string>()
    const posts: DiscoveredPost[] = []
    for (const href of hrefs) {
      const sc = SHORTCODE_RE.exec(href)?.[1]
      if (!sc || seen.has(sc)) continue
      seen.add(sc)
      posts.push({ shortcode: sc, gridIndex: posts.length })
    }

    if (posts.length === 0) {
      // One retry: transient render failures happen. A second empty result means
      // the page shape genuinely changed, and that must be loud.
      if (attempt < 2) {
        log.warn('discover found 0 posts, retrying', { handle, attempt })
        await context.close()
        return discoverProfile(handle, attempt + 1)
      }
      throw new DiscoverError(
        handle,
        'rendered profile yielded 0 post links after retry — grid selector or page shape has changed',
        true,
      )
    }

    log.step('discovered', { handle, posts: posts.length })
    return posts
  } finally {
    await context.close().catch(() => undefined)
  }
}
