import type { Locator, Page } from 'patchright'
import { log } from '@/lib/logger'

/**
 * `jitter` and `firstVisible` LIVE here (moved from readThread.ts, 2026-08-19) so this
 * module — called by both `sendDm.ts` and `readThread.ts` — never imports back into a
 * caller. readThread re-exports them for its own existing importers.
 */
export function jitter(minMs: number, maxMs: number): Promise<void> {
  const ms = minMs + Math.floor(Math.random() * (maxMs - minMs))
  return new Promise((r) => setTimeout(r, ms))
}

export async function firstVisible(page: Page, candidates: Locator[], timeoutMs: number): Promise<Locator | null> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    for (const c of candidates) {
      try {
        if (await c.first().isVisible({ timeout: 250 })) return c.first()
      } catch {
        // not attached yet
      }
    }
    await jitter(200, 400)
  }
  return null
}

/**
 * Find and click whatever opens the DM composer on a profile — ONE implementation,
 * shared by `sendDm.ts` and `readThread.ts`, because those two files finding the
 * button by different rules is exactly the drift `gate.ts` and `readThread.ts`
 * themselves were extracted to stop.
 *
 * ── THE MESSAGE BUTTON IS NOT ALWAYS THERE, AND THAT IS NOT "CANNOT MESSAGE" ──
 *
 * Seen live 2026-08-19, from Tabish's own screenshots: @dharmaticent's profile header
 * shows Follow and the similar-accounts chip and NO Message button — "Send message"
 * lives behind the "…" options menu beside the username. The agent drove that profile
 * three times, found no button, and filed `no-message-button` about an account a person
 * standing in front of the same page could message in one click. Same DM lane,
 * different door: everything after the click (the composer, the read-back, the thread
 * delta) is unchanged.
 *
 * The options menu is tried only AFTER the plain button lookup fails, so ordinary
 * profiles never see an extra click — and if the menu opens but holds no "Send message"
 * item, Escape closes it before reporting failure, because leaving a dialog over the
 * profile would break every later lookup on the page.
 */
export type MessageEntry =
  | { ok: true; via: 'button' | 'options-menu' }
  | { ok: false }

export async function clickMessageEntry(page: Page, targetHandle: string): Promise<MessageEntry> {
  // A dialog can be sitting over the profile header before we look at all (blocker 3).
  await dismissBlockingDialog(page)

  const messageBtn = await firstVisible(
    page,
    [
      page.getByRole('button', { name: /^message$/i }),
      page.locator('div[role="button"]', { hasText: /^Message$/ }),
      page.locator('//div[@role="button"][normalize-space(.)="Message"]'),
    ],
    15_000,
  )
  if (messageBtn) {
    await messageBtn.hover()
    await jitter(300, 900)
    if (!(await clickPastDialogs(page, messageBtn, 'Message button'))) return { ok: false }
    return { ok: true, via: 'button' }
  }

  // The "…" beside the username. `aria-label="Options"` is what Instagram's own SVG
  // carries (observed 2026-08-19); the role lookup covers a layout that labels the
  // button itself instead.
  const options = await firstVisible(
    page,
    [
      page.locator('div[role="button"]:has(svg[aria-label="Options"])'),
      page.getByRole('button', { name: /^options$/i }),
      page.locator('svg[aria-label="Options"]'),
    ],
    5_000,
  )
  if (!options) return { ok: false }

  await options.hover()
  await jitter(300, 900)
  if (!(await clickPastDialogs(page, options, 'the … options menu'))) return { ok: false }

  const sendMessage = await firstVisible(
    page,
    [
      // Anchored, so "Send message request" (the business interstitial's button) can
      // never satisfy this lookup — that dialog is a different step with its own rule.
      page.getByRole('button', { name: /^send message$/i }),
      page.locator('button', { hasText: /^Send message$/ }),
      page.locator('div[role="dialog"] [role="button"]', { hasText: /^Send message$/ }),
    ],
    6_000,
  )
  if (!sendMessage) {
    await page.keyboard.press('Escape').catch(() => undefined)
    return { ok: false }
  }

  log.step('Message button hidden — using "Send message" from the … menu', { target: targetHandle })
  await sendMessage.hover()
  await jitter(300, 900)
  if (!(await clickPastDialogs(page, sendMessage, '"Send message" in the … menu'))) return { ok: false }
  return { ok: true, via: 'options-menu' }
}

/**
 * ── BLOCKER 3: A DIALOG THAT CAN APPEAR AT ANY MOMENT ──────────────────────
 *
 * *"Turn on notifications — Know straight away when people follow you…"*, with **Turn On**
 * and **Not Now**. Tabish's screenshot, 2026-08-19: it landed over the open @dharmaticent
 * conversation AFTER the … menu had been navigated successfully, and the send failed with
 * `locator.click: Timeout 30000ms exceeded` on the composer — the box was visible, so
 * every lookup passed, and the modal simply ate the click. **Visibility is not
 * clickability**, which is why this could not be caught by the selector list that already
 * handles the other two blockers.
 *
 * Unlike the … menu and the interstitial, this one is NOT tied to a step: Instagram raises
 * it on its own schedule. So it is not a step in the flow — it is checked at every dwell
 * point AND it is retried around the one click that must land (`clickPastDialogs`).
 *
 * **"Not Now" is the only button ever clicked, and never "Turn On".** Declining is the
 * conservative direction for every dialog Instagram phrases this way (notifications, "save
 * your login info?", "add to home screen"): accepting changes the profile's state, and the
 * profile is the credential this whole design protects. A single fast pass, because this
 * runs several times per send and the dialog is either in the DOM or it is not.
 */
export async function dismissBlockingDialog(page: Page): Promise<boolean> {
  const candidates = [
    page.getByRole('button', { name: /^not now$/i }),
    page.locator('button', { hasText: /^Not Now$/ }),
    page.locator('div[role="dialog"] [role="button"]', { hasText: /^Not Now$/ }),
  ]
  for (const c of candidates) {
    try {
      const first = c.first()
      if (await first.isVisible({ timeout: 300 })) {
        await first.click({ timeout: 5_000 })
        log.step('an Instagram dialog appeared — dismissed it with "Not Now"')
        await jitter(400, 900)
        return true
      }
    } catch {
      // Not present, or it vanished on its own between the check and the click. Either
      // way there is nothing to dismiss and nothing to report.
    }
  }
  return false
}

/**
 * Click something that MUST be clicked, surviving a dialog that lands mid-flow.
 *
 * The failed @dharmaticent send is the whole argument: one `click()` with a 30-second
 * timeout against an element a modal was covering burns the entire budget and then fails,
 * three times over, parking the draft. Same total budget here, spent as three attempts
 * with a dismissal before each — so a dialog that appears at any point during the click
 * costs a retry instead of a delivery.
 */
export async function clickPastDialogs(page: Page, target: Locator, what: string): Promise<boolean> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    await dismissBlockingDialog(page)
    try {
      await target.click({ timeout: 9_000 })
      return true
    } catch {
      log.step('a click did not land — looking for a dialog over it and retrying', { what, attempt })
    }
  }
  return false
}

/**
 * ── BLOCKER 2: THE BUSINESS-MESSAGING INTERSTITIAL ─────────────────────────
 *
 * After the entry click, some professional recipients get a dialog INSTEAD of the
 * composer — "Partnership messages are more likely to get a response…" — with
 * "Send prioritised message" and "Send message request". First seen on the SEND path
 * 2026-08-18 (handled there since); Tabish's 2026-08-19 screenshot (@cameratakefilms)
 * caught it blocking the READ path too, where it made a reply check file the thread
 * as unreadable. It lives here now so both paths bypass it from one implementation.
 *
 * "Send message request" is clicked, NEVER "Send prioritised message" — Tabish's
 * explicit instruction, and the request path is the ordinary DM lane this design
 * models. The anchored regex cannot match the prioritised button. The wait costs
 * nothing when the dialog is absent: both flows dwell deliberately anyway.
 */
export async function passBusinessInterstitial(page: Page, targetHandle: string): Promise<void> {
  const requestBtn = await firstVisible(
    page,
    [
      page.getByRole('button', { name: /^send message request$/i }),
      page.locator('div[role="button"]', { hasText: /^Send message request$/ }),
      page.locator('button', { hasText: /^Send message request$/ }),
    ],
    4_000,
  )
  if (!requestBtn) return
  log.step('business-messaging dialog appeared — choosing the plain message request', { target: targetHandle })
  await requestBtn.hover()
  await jitter(300, 900)
  await requestBtn.click()
}
