import type { Locator, Page } from 'patchright'
import { log } from '@/lib/logger'
// session.ts imports only profile.ts and the logger, so this cannot form a cycle.
import { assertNoEnforcement } from './session'

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

/**
 * The To:-search result must be the EXACT account, or we refuse. PURE and exported so the
 * "existence is not identity" property is TESTED rather than trusted to an inline literal:
 * a search for `crocs` must never click `crocsindia`, and a handle's dots
 * (@audionirvana.in) must not become regex wildcards that match @audionirvanaXin.
 *
 * ── CASE-SENSITIVE, AND THAT IS THE POINT (2026-10-09, audit C1) ─────────────
 *
 * This was `/^handle$/i`, and a result row's DISPLAY NAME satisfied it: @tips and @tips_india
 * both display "TIPS", so a search for `tips` could click whichever row Instagram ranked first
 * — executed, `exactHandleMatcher('tips').test('TIPS') === true`. Instagram usernames are
 * lower case and render lower case on the result's username line, so the handle is
 * lower-cased once and matched WITHOUT the flag: a display name in capitals no longer
 * matches. A display name that is literally the lower-case handle still can, which is why
 * this narrowing is defence in depth and `confirmInboxThreadRecipient` carries the weight.
 */
export function exactHandleMatcher(handle: string): RegExp {
  return new RegExp(`^${handle.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`)
}

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
 * ── BLOCKER 4: NO WAY INTO THE DM FROM THE PROFILE AT ALL ──────────────────
 *
 * Some pages show NO Message button and their "…" menu has NO "Send message" item —
 * @idfreshfood, 2026-08-19, from Tabish's own screen recording: the profile simply does
 * not link to a conversation. MEASURED before this existed: the draft to it failed twice
 * as `no-message-button` WITH the …-menu fallback already live.
 *
 * The route a person takes instead, and the one this follows: open the INBOX, press
 * compose ("New message"), type the handle into the To: search, pick the exact account,
 * Chat. Tried only after blockers 1-3's answers have all failed, because it is the
 * longest path and the least profile-shaped.
 *
 * ── EXACT MATCH OR NOTHING ──────────────────────────────────────────────────
 *
 * The search-result click is the one step here that can reach a WRONG PERSON, and
 * "existence is not identity" is a measured rule in this repo (a guessed handle was the
 * right company 6 times in 10). So the result row is matched on the username line EXACTLY —
 * anchored, CASE-SENSITIVE against the lower-case handle, dots escaped — and no fuzzy row is
 * ever clicked. No exact match within the wait is a refusal, not a guess.
 *
 * ── AND THE CLICK IS NOT THE GUARD; WHAT OPENED IS (2026-10-09, audit C1) ─────
 *
 * Display names are not unique — @tips and @tips_india both display "TIPS" — and the old
 * case-insensitive matcher let a display name satisfy it, after which nothing between the
 * row click and `return true` read who had been selected. Every later guard is blind to the
 * recipient: under the single template our bytes are identical in every thread, so the
 * composer read-back, the thread delta and the reply reader's completeness check all pass in
 * the WRONG conversation, the gate has only ever checked the intended target, and the wrong
 * `/direct/t/<id>` would be stored as this pair's thread forever.
 *
 * So after Chat the opened conversation must NAME this recipient, read twice in a row
 * (`confirmInboxThreadRecipient`), or this THROWS `RecipientUnconfirmedError` before anything
 * is typed, accepted or passed — both callers run the interstitial, the request Accept and the
 * composer only after this returns. It throws rather than returning a value because both
 * callers test `if (!viaInbox)`, and an object return would make that always false: a silent
 * fail-open TypeScript cannot see. A thrown error fails closed in any caller that forgets it.
 *
 * FAIL-CLOSED UNTIL MEASURED, stated rather than discovered: nothing in this repo has observed
 * a username-bearing element in an inbox-opened thread, so the evidence reader is inferred and
 * a recipient whose profile offers no door is refused until the first live refusal's logged
 * path and hrefs are read and the reader tuned from them. That direction is chosen: a refused
 * open costs a parked draft, a wrong open costs a pitch in a stranger's inbox.
 *
 * Navigation note: this clicks the rail's own Inbox link and the dialog's own buttons —
 * trusted clicks on visible controls, the same rule as everywhere else. The standing ban
 * is on deep-linking a THREAD (`/direct/t/<id>`) out of nowhere; arriving at the inbox by
 * clicking Instagram's own entry point is what a person does.
 */
export async function openThreadViaInbox(page: Page, targetHandle: string, senderHandle: string): Promise<boolean> {
  await dismissBlockingDialog(page)

  // 1. Into the inbox, via Instagram's own controls: the rail's Direct link, or the
  //    floating bottom-right "Messages" chip.
  const inboxEntry = await firstVisible(
    page,
    [
      page.locator('a[href*="/direct/inbox"]'),
      page.locator('div[role="button"]', { hasText: /^Messages\b/ }),
      page.locator('svg[aria-label="Direct"]'),
    ],
    8_000,
  )
  if (!inboxEntry) return false
  if (!(await clickPastDialogs(page, inboxEntry, 'the inbox'))) return false
  await jitter(1200, 2200)
  await dismissBlockingDialog(page)

  // 2. Compose. The pencil — "New message" — in the inbox header (or the chip's panel).
  const compose = await firstVisible(
    page,
    [
      page.locator('div[role="button"]:has(svg[aria-label="New message"])'),
      page.locator('svg[aria-label="New message"]'),
      page.getByRole('button', { name: /^new message$/i }),
    ],
    8_000,
  )
  if (!compose) return false
  if (!(await clickPastDialogs(page, compose, 'the compose button'))) return false
  await jitter(800, 1500)

  // 3. Type the handle into the To: search — real keystrokes, so the results are the
  //    same ones a person would see.
  const toBox = await firstVisible(
    page,
    [
      page.locator('div[role="dialog"] input[name="queryBox"]'),
      page.locator('div[role="dialog"] input[placeholder*="Search" i]'),
      page.locator('input[name="queryBox"]'),
    ],
    8_000,
  )
  if (!toBox) return false
  await toBox.click()
  await jitter(300, 700)
  await page.keyboard.type(targetHandle, { delay: 90 })
  await jitter(1500, 2600)

  // 4. The exact account, or nothing. Both candidates are case-sensitive against the
  //    lower-case handle, so a display name in capitals ("TIPS") cannot satisfy either.
  const exact = exactHandleMatcher(targetHandle)
  const row = await firstVisible(
    page,
    [
      page.locator('div[role="dialog"] span', { hasText: exact }),
      page.locator('div[role="dialog"]').getByText(targetHandle.toLowerCase(), { exact: true }),
    ],
    10_000,
  )
  if (!row) {
    log.step('the To: search offered no exact match for the handle — refusing to guess', { target: targetHandle })
    await page.keyboard.press('Escape').catch(() => undefined)
    return false
  }
  if (!(await clickPastDialogs(page, row, 'the exact account in the search results'))) return false
  await jitter(600, 1200)

  // 5. Chat.
  const chat = await firstVisible(
    page,
    [
      page.locator('div[role="dialog"] div[role="button"]', { hasText: /^(Chat|Next)$/ }),
      page.locator('div[role="dialog"] button', { hasText: /^(Chat|Next)$/ }),
      page.getByRole('button', { name: /^(chat|next)$/i }),
    ],
    8_000,
  )
  if (!chat) return false
  if (!(await clickPastDialogs(page, chat, 'the Chat button'))) return false
  await jitter(1200, 2200)

  // 6. WHO DID THAT OPEN? Nothing has been typed, accepted or passed yet — both callers do
  //    those only after this returns — so this is the last moment a wrong door costs nothing.
  //    Throws `RecipientUnconfirmedError` (or the session's own error) unless confirmed.
  await requireConfirmedRecipient(page, targetHandle, senderHandle)

  log.step('opened the conversation through the inbox — the profile offered no door at all', {
    target: targetHandle,
  })
  return true
}

/**
 * ── WHO IS THE OPENED CONVERSATION WITH? (2026-10-09, audit C1) ────────────────────────
 *
 * Everything from here to the blocker-2 docblock is the identity check for the inbox route.
 * It sits HERE, between `openThreadViaInbox` and `acceptMessageRequest`, deliberately:
 * `tests/blocker-five.test.ts` slices `acceptMessageRequest..passBusinessInterstitial` and
 * `dismissBlockingDialog..clickPastDialogs`, and nothing may enter either range.
 *
 * The split is the usual one: the decision is PURE and tested both ways; reading the page is
 * one read-only `page.evaluate` that gathers evidence and judges nothing.
 */

const INSTAGRAM_HOSTS = new Set(['instagram.com', 'www.instagram.com'])

/**
 * PURE. Is this a conversation page — `/direct/t/<digits>` on Instagram itself?
 *
 * ANCHORED, and parsed rather than regex-tested on the raw string: an unanchored
 * `/\/direct\/t\/\d+/` accepts `https://www.instagram.com/tips/?next=/direct/t/123`, which is
 * the target's own PROFILE — exactly the case this gate exists to refuse, because a profile
 * page is full of `/<target>/` links and would confirm whoever it belongs to. (inboxTriage's
 * `threadIdFrom` has the same unanchored pattern; harmless there, never reused as this gate.)
 */
export function threadUrlOk(url: string): boolean {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return false
  }
  return INSTAGRAM_HOSTS.has(u.hostname) && /^\/direct\/t\/\d+\/?$/.test(u.pathname)
}

/**
 * First path segments that are Instagram's own sections, never a username. INCOMPLETE BY
 * NATURE, and in the safe direction: a missing entry can only add a non-username to `seen`,
 * which makes a verdict ambiguous or a mismatch — a refusal — and never a false confirm.
 */
const RESERVED_SEGMENTS = new Set([
  'p', 'reel', 'reels', 'tv', 'explore', 'stories', 'direct', 'accounts', 'about', 'legal', 'web',
  'api', 'challenge', 'emails', 'privacy', 'session', 'developer', 'download', 'notifications',
])

/**
 * PURE. The username a link points at, when it points at a PROFILE: Instagram's own host,
 * exactly one path segment, a legal username, not one of Instagram's sections. Lower-cased,
 * because a username is case-insensitive as an identity even where the matcher above is not.
 */
export function profileHandleFromHref(href: string): string | null {
  let u: URL
  try {
    u = new URL(href, 'https://www.instagram.com')
  } catch {
    return null
  }
  if (!INSTAGRAM_HOSTS.has(u.hostname)) return null
  const segments = u.pathname.split('/').filter((s) => s.length > 0)
  if (segments.length !== 1) return null
  const seg = segments[0]!
  if (!/^[a-z0-9._]{1,30}$/i.test(seg)) return null
  const lower = seg.toLowerCase()
  return RESERVED_SEGMENTS.has(lower) ? null : lower
}

/**
 * PURE. The username in a message-request panel's prose — OBSERVED live (blocker 5): *"Accept
 * message request from Soham Rockstar Entertainment (sohamrockstrent)?"*.
 *
 * The LAST parenthesised group before the closing `?` (the greedy `[\s\S]*`), because the
 * display name comes first and is free text: a stranger named "TIPS (tips)" whose username is
 * tips_india reads "…TIPS (tips) (tips_india)?", and the first group would confirm the spoof.
 */
export function requestPanelHandle(text: string): string | null {
  const m = /accept message request from[\s\S]*\(([a-z0-9._]{1,30})\)\s*\?\s*$/i.exec(text)
  return m ? m[1]!.toLowerCase() : null
}

export type ThreadRecipient =
  | { kind: 'confirmed' }
  /** The conversation names someone, and the recipient is not among them. */
  | { kind: 'mismatch'; seen: string[] }
  /** The recipient AND someone else — a partial view must never be allowed to confirm. */
  | { kind: 'ambiguous'; seen: string[] }
  | { kind: 'unknown'; why: string }

/** What one read of the opened page offered as evidence. Judges nothing. */
export type RecipientEvidence = { url: string } & (
  | { kind: 'pane'; hrefs: string[] }
  | { kind: 'request'; prose: string[] }
  | { kind: 'none'; why: string }
)

/**
 * PURE. Does the evidence name exactly this recipient?
 *
 * SET EQUALITY, never `includes()` or `every()`: `includes` confirms a pane naming the target
 * beside somebody else, and `every` is vacuously true of an empty set. Our own page is removed
 * from a pane's links (our avatar sits on our own bubbles) — and a pane that named only us is
 * `unknown`, never confirmed.
 */
export function decideThreadRecipient(ev: RecipientEvidence, target: string, sender: string): ThreadRecipient {
  const t = target.toLowerCase()
  if (!threadUrlOk(ev.url)) return { kind: 'unknown', why: 'not a /direct/t/<id> page' }
  if (ev.kind === 'none') return { kind: 'unknown', why: ev.why }

  const seen = new Set<string>()
  if (ev.kind === 'request') {
    for (const p of ev.prose) {
      const h = requestPanelHandle(p)
      if (h !== null) seen.add(h)
    }
  } else {
    const s = sender.toLowerCase()
    for (const href of ev.hrefs) {
      const h = profileHandleFromHref(href)
      if (h !== null && h !== s) seen.add(h)
    }
  }

  if (seen.size === 0) return { kind: 'unknown', why: 'no profile link in the conversation' }
  const names = [...seen].sort()
  if (seen.size === 1 && seen.has(t)) return { kind: 'confirmed' }
  if (seen.has(t)) return { kind: 'ambiguous', seen: names }
  return { kind: 'mismatch', seen: names }
}

/**
 * PURE. The first verdict that held for two consecutive readings, else `unknown`.
 *
 * ONE READING NEVER CONFIRMS. The thread renders in stages — the readThread jitter measured a
 * DOM restructure ~2.5 s after the composer appears — and a reading taken mid-render can hold
 * a partial pane that names only some of who is in it. Two identical readings 500 ms apart is
 * the cheapest evidence that the page has settled.
 */
export function firstStableVerdict(readings: readonly ThreadRecipient[]): ThreadRecipient {
  const same = (a: ThreadRecipient, b: ThreadRecipient): boolean => {
    if (a.kind !== b.kind) return false
    if (a.kind === 'confirmed') return true
    // `seen` is sorted by `decideThreadRecipient`, so equal sets compare equal as strings.
    if ((a.kind === 'mismatch' || a.kind === 'ambiguous') && (b.kind === 'mismatch' || b.kind === 'ambiguous')) {
      return a.seen.join(',') === b.seen.join(',')
    }
    return false
  }
  for (let i = 1; i < readings.length; i++) {
    const cur = readings[i]!
    if (cur.kind !== 'unknown' && same(readings[i - 1]!, cur)) return cur
  }
  return { kind: 'unknown', why: 'verdict never settled' }
}

/**
 * The inbox route opened a conversation we could not confirm is with this recipient.
 *
 * Extends `Error` DIRECTLY — never `WrongAccountError` or `NotLoggedInError`, which
 * `senders/browser.ts` maps to `sessionInvalid: true` and would mark the SENDER's live session
 * dead over a question about the RECIPIENT.
 *
 * The message is FIXED and names nobody: `replyCheck.ts` regex-tests thrown messages for
 * /checkpoint|challenge|suspend/i to decide whether to halt an account, and a handle (ours, the
 * target's, or one seen in the conversation) can contain any of those words.
 */
export class RecipientUnconfirmedError extends Error {
  constructor(readonly verdict: ThreadRecipient) {
    super('the inbox route could not confirm who the opened conversation is with — nothing was typed or accepted')
    this.name = 'RecipientUnconfirmedError'
  }
}

/** The path of an evidence URL for a log line; the query string is not evidence. */
function evidencePath(url: string): string {
  try {
    return new URL(url).pathname
  } catch {
    return url.slice(0, 80)
  }
}

/**
 * Read what the opened page offers as evidence of WHO it is with. ONE read-only `evaluate`,
 * judging nothing; `decideThreadRecipient` decides.
 *
 * With a composer: the conversation region is the LAST ancestor of the composer before one
 * that holds the page's navigation or the inbox list (the observed row shape,
 * `div[role="button"][tabindex] span[title]`), and EVERY link in it is gathered — a union,
 * never the first link-bearing ancestor, because the nearest one can be the newest message
 * area holding a shared profile card while the header's link sits further up. Links inside
 * the composer or inside a message bubble (the observed bubble shape) are left out, because a
 * bubble can carry a link to anyone.
 *
 * Without one: a message-request panel (blocker 5) has no composer, and its OBSERVED prose
 * names the username — the three shortest distinct containers holding the sentence are taken,
 * so the innermost one with the whole sentence is among them.
 *
 * No named inner functions inside `evaluate`: esbuild's `keepNames` wraps them in a `__name()`
 * helper that does not exist in the page (readThread.ts, found by running it).
 */
export async function readThreadRecipientEvidence(page: Page): Promise<RecipientEvidence> {
  try {
    return await page.evaluate(
      ([bubbleSel, stopSel]): RecipientEvidence => {
        const url = location.href
        const box =
          document.querySelector('div[contenteditable="true"][role="textbox"]') ??
          document.querySelector('div[role="textbox"]')
        if (box) {
          let region: Element | null = null
          let cur: Element | null = box.parentElement
          for (let i = 0; i < 25 && cur; i++) {
            if (cur.matches(stopSel!) || cur.querySelector(stopSel!)) break
            region = cur
            cur = cur.parentElement
          }
          if (!region) return { url, kind: 'none', why: 'the composer sits directly inside the page chrome' }
          const hrefs: string[] = []
          for (const a of region.querySelectorAll('a[href]')) {
            if (box.contains(a) || a.closest(bubbleSel!)) continue
            const h = a.getAttribute('href')
            if (h) hrefs.push(h)
            if (hrefs.length >= 40) break
          }
          return { url, kind: 'pane', hrefs }
        }

        const phrase = 'accept message request from'
        if (!(document.body.textContent ?? '').toLowerCase().includes(phrase)) {
          return { url, kind: 'none', why: 'no composer and no request panel' }
        }
        const texts: string[] = []
        for (const el of document.body.querySelectorAll('*')) {
          const t = (el.textContent ?? '').trim()
          if (t.length < 400 && t.toLowerCase().includes(phrase) && !texts.includes(t)) texts.push(t)
        }
        texts.sort((x, y) => x.length - y.length)
        if (texts.length === 0) return { url, kind: 'none', why: 'no composer and no request panel' }
        return { url, kind: 'request', prose: texts.slice(0, 3) }
      },
      [
        'div[role="presentation"] div[dir="auto"], div[role="row"]',
        'nav, [role="navigation"], div[role="button"][tabindex] span[title]',
      ] as const,
    )
  } catch {
    let url = ''
    try {
      url = page.url()
    } catch {
      // A closed page has no URL either; the verdict is `unknown` regardless.
    }
    return { url, kind: 'none', why: 'page could not be read' }
  }
}

/** Polling bounds for the confirmation. ~8 s on inbox-route drives only, inside the send lock. */
export const CONFIRM_POLL_MS = 500
export const CONFIRM_MAX_MS = 8_000

/**
 * Read the evidence every 500 ms until a verdict holds for two consecutive readings, or 8 s
 * pass. Bounded by a COUNT as well as the clock, so a page whose waits resolve instantly
 * cannot spin forever. Returns the settled verdict (or `unknown`) and the last evidence read,
 * which the caller logs on a refusal.
 */
export async function confirmInboxThreadRecipient(
  page: Page,
  targetHandle: string,
  senderHandle: string,
): Promise<{ verdict: ThreadRecipient; evidence: RecipientEvidence }> {
  const readings: ThreadRecipient[] = []
  let evidence: RecipientEvidence = { url: '', kind: 'none', why: 'never read' }
  const deadline = Date.now() + CONFIRM_MAX_MS
  const maxReadings = Math.ceil(CONFIRM_MAX_MS / CONFIRM_POLL_MS) + 1
  for (let i = 0; i < maxReadings; i++) {
    evidence = await readThreadRecipientEvidence(page)
    readings.push(decideThreadRecipient(evidence, targetHandle, senderHandle))
    const verdict = firstStableVerdict(readings)
    if (verdict.kind !== 'unknown') return { verdict, evidence }
    if (Date.now() >= deadline) break
    await page.waitForTimeout(CONFIRM_POLL_MS)
  }
  return { verdict: firstStableVerdict(readings), evidence }
}

/**
 * The inbox route's last step: return only when the opened conversation is confirmed as this
 * recipient's; otherwise THROW. Its own function so the order inside it is driven by a test
 * against a fake page rather than trusted to a grep.
 */
export async function requireConfirmedRecipient(page: Page, targetHandle: string, senderHandle: string): Promise<void> {
  const { verdict, evidence } = await confirmInboxThreadRecipient(page, targetHandle, senderHandle)
  if (verdict.kind === 'confirmed') return

  /**
   * A checkpoint, login form, 2FA prompt or Action-Blocked notice OUTRANKS "could not
   * confirm". Without this a /challenge/ redirect after Chat fails the URL gate, reads as
   * `unknown`, and is filed `recipient-unconfirmed` — no `markChallenged`, the reservation
   * released, and the next tick drives the same flagged account at the next recipient: a
   * retry into a checkpoint. This throws the session's own errors, which both callers already
   * classify; it returns only when the page is clean.
   */
  await assertNoEnforcement(page, senderHandle)

  /**
   * The evidence is LOGGED on every refusal, not only a mismatch: until the conversation DOM
   * is observed live, the first refusals are the only measurement of it anyone gets. A
   * mismatch is an alarm (a conversation that names somebody else opened); ambiguous and
   * unknown are warnings, because a correct thread whose card links a mutual follower must not
   * raise a wrong-account alarm about the right account.
   */
  const fields = {
    target: targetHandle,
    verdict: verdict.kind,
    ...(verdict.kind === 'unknown' ? { why: verdict.why } : { seen: verdict.seen.join(',') }),
    path: evidencePath(evidence.url),
    ...(evidence.kind === 'pane'
      ? { hrefs: evidence.hrefs.slice(0, 10).join(' ') }
      : evidence.kind === 'request'
        ? { prose: evidence.prose.map((p) => p.slice(0, 120)).join(' | ') }
        : { evidence: evidence.why }),
  }
  if (verdict.kind === 'mismatch') {
    log.alarm('the inbox route opened a conversation that does not name the recipient — nothing typed', fields)
  } else {
    log.warn('the inbox route could not confirm who the opened conversation is with — nothing typed', fields)
  }
  throw new RecipientUnconfirmedError(verdict)
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
/**
 * ── BLOCKER 5: THEY MESSAGED US FIRST, SO THERE IS A REQUEST INSTEAD OF A COMPOSER ──
 *
 * Found by Tabish from a screenshot, 2026-08-21, and it is the fifth recipient-side blocker
 * in this family — the rate this file's docblock predicted ("expect a fifth").
 *
 * When an account has sent US a message we never accepted, opening the conversation shows a
 * REQUEST panel — *"Accept message request from Soham Rockstar Entertainment
 * (sohamrockstrent)?"* with **Block · Delete · Accept** — and no composer at all. The send
 * therefore timed out looking for a composer and was filed `no-composer`, which reads as
 * "this account cannot be messaged" about an account that has literally just messaged us.
 *
 * MEASURED: @sohamrockstrent collected **six parked drafts at three attempts each** on exactly
 * this, i.e. eighteen browser drives at one revenue profile against a door that was never
 * going to open. (The re-drafting half of that is fixed separately in `governor.ts`; this is
 * the half that makes the door open.)
 *
 * ── ACCEPT IS THE ONLY BUTTON EVER CLICKED, AND THAT IS THE WHOLE DISCIPLINE ──
 *
 * The same rule as blocker 3's "Not Now": exactly one button is safe and the others are
 * destructive in ways nothing here could undo. **Delete** throws away an inbound message from
 * a real company — which is a LEAD, and the most valuable thing this system can receive — and
 * **Block** severs the account relationship permanently. Neither is ever clicked, and the
 * matcher is anchored so "Accept" cannot fall through to something else.
 *
 * ── THE EXPOSURE, STATED RATHER THAN SLIPPED IN ───────────────────────────
 *
 * Accepting is a real state change on OUR account: Instagram's own dialog says the sender will
 * then be able to call us and see our activity status and read receipts. That is a small,
 * deliberate widening, and it is the price of reading a message somebody sent us on purpose.
 * It is also the direction a person would take by hand, which is the test this project applies
 * to every automated click.
 *
 * ── AND AN ACCEPTED REQUEST USUALLY MEANS A HUMAN SHOULD LOOK ─────────────
 *
 * Their message is now visible in the thread, so the reply guard will see a bubble that is
 * THEIRS on the next read and halt outreach to that recipient for a person to take over. That
 * is not a side effect to design around — it is the correct outcome. Somebody who wrote to us
 * first should get a human, not a cold pitch.
 */
export async function acceptMessageRequest(page: Page, targetHandle: string): Promise<boolean> {
  /**
   * Anchored to the whole label, and deliberately NOT a `hasText` substring match: the panel
   * also contains the words "Accept message request from …" as prose, and matching that would
   * click whatever element happened to contain the sentence rather than the button.
   */
  const acceptBtn = await firstVisible(
    page,
    [
      page.getByRole('button', { name: /^accept$/i }),
      page.locator('div[role="button"]', { hasText: /^Accept$/ }),
      page.locator('button', { hasText: /^Accept$/ }),
    ],
    4_000,
  )
  if (!acceptBtn) return false

  /**
   * A bare "Accept" could in principle belong to some other dialog, so the surrounding panel
   * must also look like a message request before we touch it. Refusing on doubt costs one
   * `no-composer` failure; clicking the wrong Accept changes account state we cannot see.
   */
  const looksLikeRequest = await page
    .locator('text=/accept message request|wants to send you a message|sent you a message request/i')
    .first()
    .isVisible()
    .catch(() => false)
  if (!looksLikeRequest) return false

  log.step('they messaged us first — accepting the message request', { target: targetHandle })
  await acceptBtn.hover()
  await jitter(300, 900)
  await acceptBtn.click()
  await jitter(800, 1_500)

  /**
   * ── BLOCKER 6: ACCEPT IS FOLLOWED BY "MOVE MESSAGES INTO: PRIMARY / GENERAL / CANCEL" ──
   *
   * Found by Tabish from a screenshot, 2026-08-21, minutes after blocker 5 shipped — and it
   * is WHY the accept did not stick: the verification run clicked Accept, this dialog rose
   * over the thread, nothing answered it, and the next visit found the request panel intact.
   * An accept that is not filed is not an accept.
   *
   * **PRIMARY is the only destination ever chosen** (his instruction: "must add them to our
   * primary"). It is also the only correct one structurally: the reply sweep reads the
   * inbox a person reads, and a conversation filed under General is a lead in a tab nothing
   * opens. Cancel would abandon the accept — which is also why this dialog must never be
   * handled by `dismissBlockingDialog`: that helper declines things, and declining here
   * undoes the acceptance. Anchored match, same discipline as every button in this file.
   */
  const moveDialog = await page
    .locator('text=/move messages from/i')
    .first()
    .isVisible()
    .catch(() => false)
  if (moveDialog) {
    const primaryBtn = await firstVisible(
      page,
      [
        page.getByRole('button', { name: /^primary$/i }),
        page.locator('div[role="button"]', { hasText: /^Primary$/ }),
        page.locator('button', { hasText: /^Primary$/ }),
      ],
      4_000,
    )
    if (primaryBtn) {
      log.step('filing the accepted conversation under Primary', { target: targetHandle })
      await primaryBtn.hover()
      await jitter(250, 700)
      await primaryBtn.click()
    } else {
      /* Seen the dialog but not the button: say so rather than sailing on — the accept may
         not have been filed, and the next read will find the panel again and retry. */
      log.warn('the move-to-Primary dialog appeared but its button was not found', { target: targetHandle })
    }
  }

  /* The panel is replaced by the real thread; give it a moment to render the composer. */
  await jitter(1_200, 2_200)
  return true
}

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
