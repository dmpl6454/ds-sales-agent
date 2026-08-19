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
    await messageBtn.click()
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
  await options.click()

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
  await sendMessage.click()
  return { ok: true, via: 'options-menu' }
}
