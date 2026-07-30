import type { Locator, Page } from 'patchright'
import { profileUrl } from '@/lib/urls'
import { log } from '@/lib/logger'
import { copyToClipboard } from '@/lib/clipboard'
import { messageMatchesOurs } from '@/outreach/matching'
import { assertLoggedInAs, assertNoCheckpoint, launchProfile } from './session'

/**
 * Sending one DM from the account's own logged-in Chrome profile.
 *
 * The navigation path is the one a person takes and is not a detail:
 *
 *   feed → scroll → target's profile → scroll → Message → paste → read → send
 *
 * Never deep-link the thread. Arriving directly at `/direct/t/<id>` with no
 * referring page is a shape ordinary use does not produce.
 *
 * Input is via `page.mouse` / `page.keyboard` / `locator.click()` only, so every
 * event carries `isTrusted: true`. Never `evaluate(el => el.click())` and never
 * `fill()` — both produce synthetic events that a page can distinguish from a
 * person's, and `fill()` additionally skips the composer's own input handling.
 *
 * The body is PASTED, not typed. That is both safer and more realistic: nobody
 * hand-types a 1200-character pitch, and typing it would mean pressing Shift+Enter
 * between twenty lines, where a single missed modifier sends twenty separate
 * messages to a prospect. One paste cannot fail that way.
 */

export interface SendDmParams {
  senderHandle: string
  targetHandle: string
  body: string
  /** Rehearse everything except the final Enter. Nothing is delivered. */
  dryRun: boolean
}

export type SendDmResult =
  | { ok: true; threadUrl: string }
  | { ok: false; reason: string; checkpoint?: boolean }

/** Human-ish pause. Ranges are wide on purpose; a fixed delay is its own signal. */
function jitter(minMs: number, maxMs: number): Promise<void> {
  const ms = minMs + Math.floor(Math.random() * (maxMs - minMs))
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * Instagram's DOM changes without notice, so each element is looked up through a
 * short list of candidates rather than one brittle selector. Ordered most to least
 * specific; the first that attaches wins.
 */
async function firstVisible(page: Page, candidates: Locator[], timeoutMs: number): Promise<Locator | null> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    for (const c of candidates) {
      try {
        if (await c.first().isVisible({ timeout: 250 })) return c.first()
      } catch {
        // not attached yet — try the next candidate
      }
    }
    await jitter(200, 400)
  }
  return null
}

/** Scrolls a little, the way someone glancing at a page does. */
async function browseBriefly(page: Page): Promise<void> {
  for (let i = 0; i < 2 + Math.floor(Math.random() * 2); i++) {
    await page.mouse.wheel(0, 220 + Math.floor(Math.random() * 380))
    await jitter(500, 1400)
  }
}

export async function sendDm(params: SendDmParams): Promise<SendDmResult> {
  const { senderHandle, targetHandle, body, dryRun } = params
  const context = await launchProfile(senderHandle)

  try {
    const page = context.pages()[0] ?? (await context.newPage())

    // 1. Arrive at the feed, as a person opening Instagram would.
    await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded', timeout: 60_000 })
    assertNoCheckpoint(page)
    await assertLoggedInAs(page, senderHandle)
    await browseBriefly(page)

    // 2. Then the target's profile — not the thread.
    await page.goto(profileUrl(targetHandle), { waitUntil: 'domcontentloaded', timeout: 60_000 })
    assertNoCheckpoint(page)
    await jitter(1500, 3200)
    await browseBriefly(page)

    // 3. Message. If the button is absent the layout changed or the account cannot
    //    be messaged — either way, stop rather than improvise.
    const messageBtn = await firstVisible(
      page,
      [
        page.getByRole('button', { name: /^message$/i }),
        page.locator('div[role="button"]', { hasText: /^Message$/ }),
        page.locator('//div[@role="button"][normalize-space(.)="Message"]'),
      ],
      15_000,
    )
    if (!messageBtn) {
      return { ok: false, reason: 'could not find the Message button on the profile' }
    }
    await messageBtn.hover()
    await jitter(300, 900)
    await messageBtn.click()

    // 4. The composer.
    const composer = await firstVisible(
      page,
      [
        page.getByRole('textbox', { name: /message/i }),
        page.locator('div[contenteditable="true"][role="textbox"]'),
        page.locator('div[aria-label="Message"][contenteditable="true"]'),
        page.locator('textarea[placeholder*="Message" i]'),
      ],
      25_000,
    )
    if (!composer) {
      assertNoCheckpoint(page)
      return { ok: false, reason: 'message thread opened but no composer was found' }
    }
    assertNoCheckpoint(page)

    await composer.click()
    await jitter(600, 1400)

    // 5. Paste. The OS clipboard plus Cmd+V is a real user action; the paste event
    //    is trusted and the composer receives multi-line text as one message.
    await copyToClipboard(body)
    await page.keyboard.press('Meta+V')
    await jitter(900, 1800)

    // 6. THE GUARD. Read back what is actually in the composer and refuse to send
    //    unless it is our message. This is what stops a failed paste, a truncated
    //    body, or a focus that landed somewhere else from being delivered.
    const staged = ((await composer.textContent()) ?? '').trim()
    if (!messageMatchesOurs(staged, body)) {
      return {
        ok: false,
        reason: `composer content does not match the drafted message (${staged.length} chars staged vs ${body.length} drafted) — nothing sent`,
      }
    }

    // A person reads it once before sending.
    await jitter(1800, 3600)

    if (dryRun) {
      return {
        ok: false,
        reason: 'DRY_RUN — message was staged in the composer and verified, then abandoned unsent',
      }
    }

    // 7. Send.
    await page.keyboard.press('Enter')
    await jitter(1500, 2600)
    assertNoCheckpoint(page)

    // 8. Confirm it actually landed in the thread rather than trusting the keypress.
    const threadText = (await page.locator('body').textContent()) ?? ''
    if (!messageMatchesOurs(threadText, body)) {
      return {
        ok: false,
        reason: 'pressed send but the message did not appear in the thread — treat as unsent and check by hand',
      }
    }

    const threadUrl = page.url()
    log.info('dm delivered', { senderHandle, targetHandle, threadUrl })
    // A moment before closing; slamming the window shut on send is not what a
    // person does, and the context needs to flush its profile writes anyway.
    await jitter(1200, 2400)
    return { ok: true, threadUrl }
  } finally {
    await context.close()
  }
}
