import { existsSync } from 'node:fs'
import { chromium, type BrowserContext, type Page } from 'playwright'
import type { OutreachSender, SendOutcome, SendRequest } from './types'
import { env } from '@/lib/env'
import { log } from '@/lib/logger'
import { randomInt, sleep } from '@/lib/time'

/**
 * Autopilot sender. Drives a real logged-in Instagram web session.
 *
 * ⚠️ SELECTORS ARE UNVERIFIED until a real session exists. Instagram's DM UI
 * cannot be reached logged out, so these locators were written from the
 * documented structure and MUST be validated with `pnpm session:check` against a
 * throwaway account before this adapter is enabled for a real sender. Every
 * locator therefore has fallbacks and the whole flow aborts rather than guesses.
 *
 * Safety properties, in priority order:
 *  1. Any checkpoint/challenge => abort immediately, report `challenged`, never
 *     retry. The caller sets the sender to CHALLENGED and stops using it. A retry
 *     loop against a challenge is how accounts get permanently banned.
 *  2. Human-like pacing via jitter before sending.
 *  3. Never types a password. The session comes from storageState captured
 *     interactively by the operator.
 */

/** Text/URL fragments that mean Instagram wants human verification. */
const CHALLENGE_MARKERS = [
  '/challenge/',
  '/accounts/suspended',
  '/accounts/disabled',
  'confirm it’s you',
  "confirm it's you",
  'suspicious login',
  'we detected unusual activity',
  'help us confirm',
  'your account has been temporarily',
  'try again later',
] as const

class ChallengeDetected extends Error {
  constructor(public readonly marker: string) {
    super(`Instagram challenge detected: ${marker}`)
    this.name = 'ChallengeDetected'
  }
}

async function assertNoChallenge(page: Page): Promise<void> {
  const url = page.url().toLowerCase()
  for (const m of CHALLENGE_MARKERS) {
    if (url.includes(m.toLowerCase())) throw new ChallengeDetected(`url:${m}`)
  }
  const text = (await page.textContent('body').catch(() => '')) ?? ''
  const lower = text.toLowerCase()
  for (const m of CHALLENGE_MARKERS) {
    if (lower.includes(m.toLowerCase())) throw new ChallengeDetected(`text:${m}`)
  }
}

/** Confirm the session is still valid before attempting anything destructive. */
async function assertLoggedIn(page: Page, senderHandle: string): Promise<void> {
  const url = page.url()
  if (url.includes('/accounts/login')) {
    throw new Error(`session for @${senderHandle} has expired — re-run: pnpm session:add --sender=${senderHandle}`)
  }
}

export const playwrightSender: OutreachSender = {
  name: 'playwright-autopilot',

  async send(req: SendRequest): Promise<SendOutcome> {
    if (!req.sessionPath || !existsSync(req.sessionPath)) {
      return {
        status: 'FAILED',
        error: `no saved session for @${req.senderHandle}. Run: pnpm session:add --sender=${req.senderHandle}`,
      }
    }

    const browser = await chromium.launch({ headless: env.HEADLESS })
    let context: BrowserContext | null = null

    try {
      context = await browser.newContext({
        storageState: req.sessionPath,
        userAgent:
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
        locale: 'en-US',
        viewport: { width: 1440, height: 900 },
      })
      const page = await context.newPage()

      // Land on the target's profile and use its Message button. More stable
      // than the /direct/new/ search flow, which changes shape often.
      await page.goto(`https://www.instagram.com/${req.targetHandle}/`, {
        waitUntil: 'domcontentloaded',
        timeout: 45_000,
      })
      await assertLoggedIn(page, req.senderHandle)
      await assertNoChallenge(page)

      const messageButton = page
        .getByRole('button', { name: /^message$/i })
        .or(page.getByRole('link', { name: /^message$/i }))
        .or(page.locator('div[role="button"]:has-text("Message")'))
        .first()

      await messageButton.waitFor({ state: 'visible', timeout: 20_000 })
      await messageButton.click()

      // Thread view: a contenteditable composer.
      const composer = page
        .getByRole('textbox', { name: /message/i })
        .or(page.locator('div[contenteditable="true"][role="textbox"]'))
        .or(page.locator('textarea[placeholder*="Message" i]'))
        .first()

      await composer.waitFor({ state: 'visible', timeout: 30_000 })
      await assertNoChallenge(page)

      // Pace it like a person before committing. The jitter is the point.
      const waitSec = randomInt(env.SEND_JITTER_MIN_SECONDS, env.SEND_JITTER_MAX_SECONDS)
      log.step('pacing before send', { sender: req.senderHandle, target: req.targetHandle, waitSec })
      await sleep(waitSec * 1_000)

      await composer.click()
      // Newlines must not submit early: type each line, Shift+Enter between them.
      const lines = req.body.split('\n')
      for (let i = 0; i < lines.length; i += 1) {
        if (lines[i]) await page.keyboard.type(lines[i]!, { delay: randomInt(8, 28) })
        if (i < lines.length - 1) await page.keyboard.press('Shift+Enter')
      }

      await assertNoChallenge(page)
      await page.keyboard.press('Enter')

      // Confirm the text actually left the composer rather than assuming.
      await page
        .waitForFunction(
          () => {
            const box = document.querySelector('div[contenteditable="true"][role="textbox"]')
            return !box || (box.textContent ?? '').trim().length === 0
          },
          { timeout: 20_000 },
        )
        .catch(() => {
          throw new Error('composer still populated after Enter — send likely did not go through')
        })

      await assertNoChallenge(page)
      const threadUrl = page.url()
      log.info('sent', { sender: req.senderHandle, target: req.targetHandle, threadUrl })
      return { status: 'SENT', threadUrl }
    } catch (err) {
      if (err instanceof ChallengeDetected) {
        log.alarm('challenge detected — pausing sender, not retrying', {
          sender: req.senderHandle,
          marker: err.marker,
        })
        return { status: 'FAILED', error: err.message, challenged: true }
      }
      const message = err instanceof Error ? err.message : String(err)
      log.error('send failed', { sender: req.senderHandle, target: req.targetHandle, error: message })
      return { status: 'FAILED', error: message }
    } finally {
      await context?.close().catch(() => undefined)
      await browser.close().catch(() => undefined)
    }
  },
}
