import type { Locator, Page } from 'patchright'
import { profileUrl } from '@/lib/urls'
import { log } from '@/lib/logger'
import { copyToClipboard } from '@/lib/clipboard'
import { pasteShortcut } from '@/lib/platform'
import { bodyAppearedSince, messageMatchesOurs } from '@/outreach/matching'
import type { FailureCode } from '@/lib/constants'
import { assertLoggedInAs, assertNoCheckpoint, assertNoEnforcement, launchProfile } from './session'
import { clickMessageEntry, passBusinessInterstitial, dismissBlockingDialog, clickPastDialogs } from './messageEntry'

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
  /** `threadUrl` is absent when the conversation opened over the profile and never
   *  exposed its own `/direct/t/<id>` URL. Delivery is still confirmed. */
  | { ok: true; threadUrl?: string }
  /**
   * `failureCode` is the queryable half of `reason`. It is required rather than optional
   * so a new failure path cannot be added without deciding which kind it is — and one of
   * these kinds, `not-in-thread`, means the recipient may already have the message.
   */
  | { ok: false; reason: string; failureCode: FailureCode; checkpoint?: boolean }

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
    // Blocker 3: the "Turn on notifications" dialog most often lands on the feed. Cleared
    // here so it is not still sitting there when the profile loads.
    await dismissBlockingDialog(page)
    await browseBriefly(page)

    // 2. Then the target's profile — not the thread.
    await page.goto(profileUrl(targetHandle), { waitUntil: 'domcontentloaded', timeout: 60_000 })
    assertNoCheckpoint(page)
    await jitter(1500, 3200)
    await dismissBlockingDialog(page)
    await browseBriefly(page)

    // 3. Message — the button when the profile shows one, the "…" menu's "Send message"
    //    when it does not (measured on @dharmaticent, 2026-08-19: three failed drives
    //    against a profile a person could message in one click). One implementation for
    //    this and the thread reader: `clickMessageEntry`.
    const entry = await clickMessageEntry(page, targetHandle)
    if (!entry.ok) {
      return {
        ok: false,
        reason: 'no Message button on the profile, and the … menu offered no "Send message" either',
        failureCode: 'no-message-button',
      }
    }

    /**
     * 3b. THE BUSINESS-MESSAGING INTERSTITIAL — "Send message request", never
     * "prioritised". One implementation in messageEntry.ts since 2026-08-19, because
     * Tabish's screenshot caught the same dialog blocking the READ path too.
     */
    await passBusinessInterstitial(page, targetHandle)

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
      return { ok: false, reason: 'message thread opened but no composer was found', failureCode: 'no-composer' }
    }
    await assertNoEnforcement(page, senderHandle)

    /**
     * The thread AS IT STANDS, before we have typed anything into it.
     *
     * This is the baseline the post-send confirmation at step 8 measures against, and it
     * has to be read HERE — with the composer still empty — or it is worthless. Reading it
     * after the paste would count our own staged text and the delta could never be 1.
     *
     * See `bodyAppearedSince`: "the needle is present" is satisfiable by a message we sent
     * last week, so the only honest question is whether an occurrence was ADDED.
     */
    const threadBefore = (await page.locator('body').textContent()) ?? ''

    /**
     * THE CLICK THAT FAILED ON @dharmaticent, 2026-08-19. The composer was visible and the
     * lookup above passed; a "Turn on notifications" modal was over it, so a plain
     * `click()` waited out its whole 30-second timeout and the send was filed `unknown`.
     * `clickPastDialogs` dismisses any such dialog and retries — same total budget.
     */
    if (!(await clickPastDialogs(page, composer, 'the message box'))) {
      return {
        ok: false,
        reason: 'the message box could not be clicked — a dialog kept covering it',
        failureCode: 'no-composer',
      }
    }
    await jitter(600, 1400)

    // 5. Paste. The OS clipboard plus a real modifier+V is a user action; the paste
    //    event is trusted and the composer receives multi-line text as one message.
    //    The modifier resolves per platform - it was hardcoded Meta+V, which is the
    //    Super key on Windows and therefore pasted nothing at all.
    await copyToClipboard(body)
    await page.keyboard.press(pasteShortcut())
    await jitter(900, 1800)

    // 6. THE GUARD. Read back what is actually in the composer and refuse to send
    //    unless it is our message. This is what stops a failed paste, a truncated
    //    body, or a focus that landed somewhere else from being delivered.
    const staged = ((await composer.textContent()) ?? '').trim()
    if (!messageMatchesOurs(staged, body)) {
      /**
       * Show the actual bytes, not just the lengths. The 2026-08-18 template mismatch
       * (242 staged vs 238 drafted) was undiagnosable from the count alone — the refusal
       * must carry what the composer actually held so the transformation is visible.
       */
      log.step('composer mismatch — staged bytes follow', {
        staged: JSON.stringify(staged.slice(0, 300)),
        drafted: JSON.stringify(body.slice(0, 300)),
      })
      return {
        ok: false,
        reason: `composer content does not match the drafted message (${staged.length} chars staged vs ${body.length} drafted) — nothing sent`,
        failureCode: 'composer-mismatch',
      }
    }

    // A person reads it once before sending.
    await jitter(1800, 3600)

    if (dryRun) {
      return {
        ok: false,
        reason: 'DRY_RUN — message was staged in the composer and verified, then abandoned unsent',
        // Not a failure at all; DRY_RUN never presses Enter. Coded so the union stays closed.
        failureCode: 'still-staged',
      }
    }

    /**
     * 6b. A dialog landing in THIS gap is the dangerous one, and not because it delays the
     * send: a modal holds focus, so `Enter` would go to ITS default button — which on the
     * notifications dialog is **Turn On** — instead of to the composer. So it is dismissed,
     * and if one was there the composer is re-focused and re-verified, because a keystroke
     * aimed at the wrong element is exactly what the read-back guard exists to catch.
     */
    if (await dismissBlockingDialog(page)) {
      if (!(await clickPastDialogs(page, composer, 'the message box (refocus after a dialog)'))) {
        return {
          ok: false,
          reason: 'a dialog appeared just before sending and the message box could not be re-focused',
          failureCode: 'still-staged',
        }
      }
      const restaged = ((await composer.textContent()) ?? '').trim()
      if (!messageMatchesOurs(restaged, body)) {
        return {
          ok: false,
          reason: `a dialog appeared just before sending and the message box no longer holds our message (${restaged.length} chars) — nothing sent`,
          failureCode: 'composer-mismatch',
        }
      }
      await jitter(600, 1200)
    }

    // 7. Send.
    await page.keyboard.press('Enter')
    await jitter(1500, 2600)
    // Full check, not URL-only: "Action Blocked" is a modal on the same URL, and this is
    // the moment it appears.
    await assertNoEnforcement(page, senderHandle)

    /**
     * 8. Confirm it actually left, in two parts.
     *
     * The first check used to be the only one, and it could not fail. It read the
     * whole page for our text — but our text is sitting in the composer at that
     * moment whether Enter worked or not, so a failed send would have read as a
     * success. The one assertion the entire system rests on was a tautology, and it
     * passed the first live send only because that send genuinely worked.
     *
     * The composer clearing is what actually distinguishes the two: Instagram empties
     * it on send and leaves it untouched on failure. So:
     *
     *   composer still holds our text  → Enter did nothing. NOT sent.
     *   composer cleared, text on page → it moved from composer to thread. Sent.
     *   composer cleared, text absent  → it left the box but never appeared. Unknown,
     *                                    so report unsent and let a human look.
     */
    const stillStaged = ((await composer.textContent().catch(() => '')) ?? '').trim()
    if (stillStaged.length > 0 && messageMatchesOurs(stillStaged, body)) {
      return {
        ok: false,
        reason: 'pressed send but the message is still sitting in the composer — nothing was delivered',
        failureCode: 'still-staged',
      }
    }

    /**
     * A NEW occurrence, not merely an occurrence. `threadBefore` was read at step 4 with an
     * empty composer, so this asks whether pressing Enter added our message to the
     * conversation — which an earlier message of ours carrying the same needle cannot fake.
     */
    const threadText = (await page.locator('body').textContent()) ?? ''
    if (!bodyAppearedSince(threadBefore, threadText, body)) {
      return {
        ok: false,
        reason: 'the composer cleared but the message never appeared in the thread — treat as unsent and check by hand',
        /**
         * THE ONE THAT IS NOT LIKE THE OTHERS. Instagram accepted the keystroke — the
         * composer emptied — and then did not show the message. Two things are true at
         * once: this is what a shadow restriction looks like from outside, and it is the
         * only failure where the recipient may actually HAVE the message. Recording it
         * as an ordinary failure loses both facts.
         */
        failureCode: 'not-in-thread',
      }
    }

    /**
     * Clicking Message can leave the URL on the profile while the conversation opens
     * over it; the real `/direct/t/<id>` appears a beat later. The first live send
     * recorded the profile URL as its "thread URL", which is useless for going back
     * to the conversation. Wait briefly for the real one, and record nothing rather
     * than something misleading if it never arrives.
     */
    let threadUrl: string | undefined
    for (let i = 0; i < 10; i++) {
      if (page.url().includes('/direct/t/')) {
        threadUrl = page.url()
        break
      }
      await jitter(400, 700)
    }
    /**
     * The URL usually never changes: the conversation opens as a panel OVER the profile,
     * so `page.url()` stays on the profile forever. MEASURED 2026-08-19: all 21 delivered
     * messages carried `threadUrl: null`, and the CSV export's thread column was empty
     * end to end. When the panel renders an anchor to the real thread, take it from
     * there instead — a DOM read, no navigation, no extra activity.
     */
    if (!threadUrl) {
      const href = await page
        .locator('a[href*="/direct/t/"]')
        .first()
        .getAttribute('href', { timeout: 1_500 })
        .catch(() => null)
      if (href) threadUrl = new URL(href, 'https://www.instagram.com').toString()
    }
    log.info('dm delivered', { senderHandle, targetHandle, threadUrl })
    // A moment before closing; slamming the window shut on send is not what a
    // person does, and the context needs to flush its profile writes anyway.
    await jitter(1200, 2400)
    return { ok: true, threadUrl }
  } finally {
    await context.close()
  }
}
