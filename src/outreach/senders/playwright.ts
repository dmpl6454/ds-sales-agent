import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { chromium, type BrowserContext, type Page } from 'playwright'
import type { OutreachSender, SendOutcome, SendRequest } from './types'
import { env } from '@/lib/env'
import { log } from '@/lib/logger'
import { randomInt, sleep } from '@/lib/time'
import { findFirst, dumpDiagnostic, type LocatorAttempt } from './diagnose'
import { openBrowserForSender, humanisedApproach } from './browser'
import { distinctiveSlice } from '@/outreach/matching'

/**
 * Autopilot sender. Drives a real logged-in Instagram web session.
 *
 * ⚠️ The locators below have never met a live page — Instagram's DM interface is
 * unreachable logged out, so they were written from documented structure. That is
 * why every one goes through `findFirst()`, which tries named candidates in order
 * and records what each matched, and why any failure writes a full diagnostic
 * (screenshot, HTML, every button and editable on the page). The first live run
 * should produce enough to fix a selector in one pass.
 *
 * Safety properties, in priority order:
 *  1. Any checkpoint/challenge → abort immediately, report `challenged`, never
 *     retry. Retrying into a challenge is how accounts get permanently banned.
 *  2. Delivery is confirmed by reading the message back out of the thread — not
 *     by assuming an emptied composer means it sent.
 *  3. Human-shaped approach and pacing before the send.
 *  4. Never types a password. The session comes from storageState captured
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
  const text = ((await page.textContent('body').catch(() => '')) ?? '').toLowerCase()
  for (const m of CHALLENGE_MARKERS) {
    if (text.includes(m.toLowerCase())) throw new ChallengeDetected(`text:${m}`)
  }
}

async function assertLoggedIn(page: Page, senderHandle: string): Promise<void> {
  if (page.url().includes('/accounts/login')) {
    throw new Error(
      `session for @${senderHandle} has expired — re-run: pnpm session:add --sender=${senderHandle}`,
    )
  }
}

/** Candidate locators for the profile's Message button, best-understood first. */
export function messageButtonCandidates(page: Page) {
  return [
    { label: 'role=button name=/^message$/i', locator: page.getByRole('button', { name: /^message$/i }) },
    { label: 'role=link name=/^message$/i', locator: page.getByRole('link', { name: /^message$/i }) },
    { label: 'div[role=button]:has-text("Message")', locator: page.locator('div[role="button"]:has-text("Message")') },
    { label: 'text=Message (exact)', locator: page.getByText('Message', { exact: true }) },
    { label: 'a[href^="/direct/t/"]', locator: page.locator('a[href^="/direct/t/"]') },
  ]
}

/** Candidate locators for the thread composer. */
export function composerCandidates(page: Page) {
  return [
    { label: 'role=textbox name=/message/i', locator: page.getByRole('textbox', { name: /message/i }) },
    {
      label: 'div[contenteditable][role=textbox]',
      locator: page.locator('div[contenteditable="true"][role="textbox"]'),
    },
    { label: 'div[contenteditable="true"]', locator: page.locator('div[contenteditable="true"]') },
    { label: 'textarea[placeholder*=Message]', locator: page.locator('textarea[placeholder*="Message" i]') },
    { label: 'aria-label*=Message', locator: page.locator('[aria-label*="Message" i][contenteditable]') },
  ]
}

export const playwrightSender: OutreachSender = {
  name: 'playwright-autopilot',

  async send(req: SendRequest): Promise<SendOutcome> {
    if (!req.sessionPath) {
      return {
        status: 'FAILED',
        error: `no saved session for @${req.senderHandle}. Run: pnpm session:add --sender=${req.senderHandle}`,
      }
    }
    const sessionFile = resolve(process.cwd(), req.sessionPath)
    if (!existsSync(sessionFile)) {
      return {
        status: 'FAILED',
        error: `session file missing (${req.sessionPath}). Run: pnpm session:add --sender=${req.senderHandle}`,
      }
    }

    const attempts: LocatorAttempt[] = []
    let context: BrowserContext | null = null
    let page: Page | null = null
    let stage = 'launch'

    try {
      context = await openBrowserForSender(req.senderHandle, sessionFile)
      page = await context.newPage()

      // Land on the feed and behave like someone opening the app, then navigate to
      // the profile — rather than teleporting straight to a stranger's page and
      // typing. See browser.ts for why this matters.
      stage = 'approach'
      await humanisedApproach(page, req.targetHandle)
      await assertLoggedIn(page, req.senderHandle)
      await assertNoChallenge(page)

      // ── Open the thread ────────────────────────────────────────────────────
      stage = 'message-button'
      const btn = await findFirst('message-button', messageButtonCandidates(page), { timeoutMs: 20_000 })
      attempts.push(btn.attempt)
      if (!btn.locator) {
        const dir = await dumpDiagnostic(page, {
          stage,
          senderHandle: req.senderHandle,
          targetHandle: req.targetHandle,
          attempts,
          error: 'no Message button matched any candidate',
        })
        return {
          status: 'FAILED',
          error: `could not find the Message button on @${req.targetHandle}'s profile. Diagnostic: ${dir}/summary.txt`,
        }
      }
      await btn.locator.click()

      stage = 'composer'
      const composer = await findFirst('composer', composerCandidates(page), { timeoutMs: 30_000 })
      attempts.push(composer.attempt)
      if (!composer.locator) {
        const dir = await dumpDiagnostic(page, {
          stage,
          senderHandle: req.senderHandle,
          targetHandle: req.targetHandle,
          attempts,
          error: 'no composer matched any candidate',
        })
        return {
          status: 'FAILED',
          error: `opened the thread but could not find the message box. Diagnostic: ${dir}/summary.txt`,
        }
      }
      await assertNoChallenge(page)

      // ── Pace, then type ────────────────────────────────────────────────────
      stage = 'typing'
      const waitSec = randomInt(env.SEND_JITTER_MIN_SECONDS, env.SEND_JITTER_MAX_SECONDS)
      log.step('pacing before send', { sender: req.senderHandle, target: req.targetHandle, waitSec })
      await sleep(waitSec * 1_000)

      await composer.locator.click()
      // Newlines must not submit early: type each line, Shift+Enter between them.
      const lines = req.body.split('\n')
      for (let i = 0; i < lines.length; i += 1) {
        if (lines[i]) await page.keyboard.type(lines[i]!, { delay: randomInt(8, 28) })
        if (i < lines.length - 1) await page.keyboard.press('Shift+Enter')
      }

      await assertNoChallenge(page)

      stage = 'send'
      await page.keyboard.press('Enter')

      // ── Confirm delivery by reading it back ────────────────────────────────
      // An emptied composer is a proxy, not proof. Assert the text actually
      // appears in the conversation, so a silent failure is reported as FAILED
      // rather than recorded as SENT and starting a 7-day cooldown.
      stage = 'confirm'
      const confirmed = await confirmDelivered(page, req.body)
      if (!confirmed.ok) {
        const dir = await dumpDiagnostic(page, {
          stage,
          senderHandle: req.senderHandle,
          targetHandle: req.targetHandle,
          attempts,
          error: `could not confirm delivery: ${confirmed.reason}`,
        })
        return {
          status: 'FAILED',
          error: `typed the message but could not confirm it was delivered (${confirmed.reason}). Diagnostic: ${dir}/summary.txt`,
        }
      }

      await assertNoChallenge(page)
      const threadUrl = page.url()
      log.info('sent and confirmed', {
        sender: req.senderHandle,
        target: req.targetHandle,
        threadUrl,
        via: `${btn.attempt.chosen} / ${composer.attempt.chosen}`,
      })
      return { status: 'SENT', threadUrl }
    } catch (err) {
      if (err instanceof ChallengeDetected) {
        if (page) {
          await dumpDiagnostic(page, {
            stage,
            senderHandle: req.senderHandle,
            targetHandle: req.targetHandle,
            attempts,
            error: err.message,
          })
        }
        log.alarm('challenge detected — pausing sender, not retrying', {
          sender: req.senderHandle,
          marker: err.marker,
        })
        return { status: 'FAILED', error: err.message, challenged: true }
      }

      const message = err instanceof Error ? err.message : String(err)
      let hint = ''
      if (page) {
        const dir = await dumpDiagnostic(page, {
          stage,
          senderHandle: req.senderHandle,
          targetHandle: req.targetHandle,
          attempts,
          error: message,
        })
        hint = ` Diagnostic: ${dir}/summary.txt`
      }
      log.error('send failed', { sender: req.senderHandle, target: req.targetHandle, stage, error: message })
      return { status: 'FAILED', error: `[${stage}] ${message}${hint}` }
    } finally {
      await context?.close().catch(() => undefined)
    }
  },
}

/**
 * Verify the message is present in the conversation.
 *
 * Matches on a distinctive slice of the body rather than the whole thing:
 * Instagram may collapse whitespace, linkify URLs, or truncate a long message
 * behind a "see more", any of which would break an exact full-text comparison.
 */
export async function confirmDelivered(
  page: Page,
  body: string,
  timeoutMs = 25_000,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const needle = distinctiveSlice(body)
  if (!needle) return { ok: false, reason: 'message body had no distinctive text to match' }

  try {
    await page.waitForFunction(
      (text: string) => {
        const body = document.body?.innerText ?? ''
        return body.includes(text)
      },
      needle,
      { timeout: timeoutMs },
    )
  } catch {
    return { ok: false, reason: `message text not found in the thread after ${timeoutMs}ms` }
  }

  // The composer should also be empty. If the text is present AND the composer
  // still holds it, the message was typed but not submitted.
  const composerStillFull = await page
    .evaluate(() => {
      const box = document.querySelector('div[contenteditable="true"]')
      return box ? (box.textContent ?? '').trim().length > 20 : false
    })
    .catch(() => false)

  if (composerStillFull) {
    return { ok: false, reason: 'text is on screen but still sitting in the composer — Enter did not submit' }
  }

  return { ok: true }
}

