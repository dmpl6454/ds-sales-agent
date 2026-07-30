import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { chromium, type BrowserContext, type Page } from 'playwright'
import { env } from '@/lib/env'
import { log } from '@/lib/logger'
import { randomInt, sleep } from '@/lib/time'

/**
 * The browser layer for sending.
 *
 * Correcting an earlier assumption in this project: low volume (2 DMs/day against
 * ~60/day of safe capacity) protects against RATE-LIMIT blocks. It does nothing
 * about AUTOMATION FINGERPRINTING, which is a separate detection system asking
 * "does this look like a person?" rather than "how many?".
 *
 * This module addresses that second question:
 *
 *  1. A persistent profile per sender. A pristine browser context on every run —
 *     no cache, no IndexedDB, no service workers — is itself an anomaly. A
 *     long-lived profile accumulates the ordinary debris of a real browser.
 *
 *  2. Fingerprint patches. Playwright leaves `navigator.webdriver === true`, an
 *     empty plugin array, and other tells that are trivially readable from JS.
 *
 *  3. A human-shaped approach. Landing directly on a stranger's profile and
 *     typing is not what a person does; they open the app, glance at the feed,
 *     then navigate. `humanisedApproach()` does that.
 *
 * None of this makes cold DMs sanctioned. It lowers the odds of being flagged.
 */

const PROFILES_DIR = resolve(process.cwd(), 'browser-profiles')

/**
 * Removes the obvious automation tells before any page script runs.
 *
 * Deliberately a small, well-understood set rather than a large stealth bundle:
 * every patch here is one we can explain, and an over-patched browser is itself
 * detectable through inconsistency (e.g. claiming plugins that do not behave like
 * plugins).
 */
const STEALTH_INIT = `
(() => {
  // navigator.webdriver is the single most-checked automation flag.
  try { Object.defineProperty(Navigator.prototype, 'webdriver', { get: () => undefined, configurable: true }) } catch {}

  // Headless Chromium reports zero plugins and zero mimeTypes; real Chrome does not.
  try {
    const fake = [
      { name: 'PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
      { name: 'Chrome PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
    ];
    Object.defineProperty(navigator, 'plugins', { get: () => fake, configurable: true });
  } catch {}

  // window.chrome is present in real Chrome and absent in bare Chromium builds.
  try { if (!window.chrome) window.chrome = { runtime: {} } } catch {}

  // Permissions.query for 'notifications' returns 'denied' under automation but
  // 'prompt' in a real browser that has never been asked.
  try {
    const orig = navigator.permissions?.query?.bind(navigator.permissions);
    if (orig) {
      navigator.permissions.query = (p) =>
        p && p.name === 'notifications'
          ? Promise.resolve({ state: Notification.permission === 'default' ? 'prompt' : Notification.permission })
          : orig(p);
    }
  } catch {}
})();
`

/**
 * Open a browser for one sender, reusing that sender's persistent profile.
 *
 * `storageState` still seeds the session on first use, so an existing captured
 * login keeps working; after that the profile carries it and accumulates real
 * browsing state.
 */
export async function openBrowserForSender(
  senderHandle: string,
  sessionFile: string,
): Promise<BrowserContext> {
  const profileDir = resolve(PROFILES_DIR, senderHandle)
  mkdirSync(profileDir, { recursive: true })

  const context = await chromium.launchPersistentContext(profileDir, {
    headless: env.HEADLESS,
    viewport: { width: 1440, height: 900 },
    locale: 'en-US',
    timezoneId: 'Asia/Kolkata',
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
    // Real browsers are not launched with automation banners and default prefs.
    args: ['--disable-blink-features=AutomationControlled'],
    ignoreDefaultArgs: ['--enable-automation'],
  })

  await context.addInitScript(STEALTH_INIT)

  // Seed cookies from the captured session. Harmless when the profile already has
  // them; essential on the profile's first run.
  await seedFromStorageState(context, sessionFile)

  return context
}

async function seedFromStorageState(context: BrowserContext, sessionFile: string): Promise<void> {
  try {
    const { readFileSync } = await import('node:fs')
    const raw = JSON.parse(readFileSync(sessionFile, 'utf8')) as {
      cookies?: Parameters<BrowserContext['addCookies']>[0]
    }
    if (raw.cookies && raw.cookies.length > 0) {
      await context.addCookies(raw.cookies)
    }
  } catch (err) {
    log.warn('could not seed cookies from session file', {
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

/**
 * Arrive at a target's profile the way a person would.
 *
 * The previous implementation went straight to the profile URL and started
 * typing. This opens the feed first, scrolls a little, pauses to "read", and only
 * then navigates — so the request sequence and timing resemble someone using the
 * app rather than a script hitting one endpoint.
 */
export async function humanisedApproach(page: Page, targetHandle: string): Promise<void> {
  await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded', timeout: 45_000 })
  await sleep(randomInt(1_200, 3_000))

  // A couple of lazy scrolls with a pause between, like glancing at the feed.
  for (let i = 0; i < randomInt(2, 4); i += 1) {
    await page.mouse.wheel(0, randomInt(300, 700)).catch(() => undefined)
    await sleep(randomInt(700, 1_800))
  }

  // Some incidental mouse movement. Zero pointer events across a whole session is
  // an unusual signal on its own.
  for (let i = 0; i < randomInt(2, 4); i += 1) {
    await page.mouse.move(randomInt(200, 1200), randomInt(150, 800)).catch(() => undefined)
    await sleep(randomInt(120, 400))
  }

  await page.goto(`https://www.instagram.com/${targetHandle}/`, {
    waitUntil: 'domcontentloaded',
    timeout: 45_000,
  })

  // Dwell, as though looking at the profile before messaging.
  await sleep(randomInt(1_800, 4_500))
  await page.mouse.wheel(0, randomInt(150, 450)).catch(() => undefined)
  await sleep(randomInt(600, 1_600))
}
