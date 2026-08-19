import type { Page } from 'patchright'
import { isOneOfOurs, normalise } from '@/outreach/matching'
import { profileUrl } from '@/lib/urls'
import { assertLoggedInAs, assertNoCheckpoint, launchProfile } from './session'
import { clickMessageEntry, firstVisible, jitter } from './messageEntry'

/**
 * Opening a real conversation and reading it back.
 *
 * Extracted from `src/scripts/thread.ts`, which owned the only working
 * implementation inside its CLI `main()`. That was fine while reply detection was
 * something a person ran by hand; it stops being fine the moment the scheduler needs
 * the same behaviour, because the alternative is a second copy — and this codebase
 * has already paid for a second copy of a gate once (`sendNow` vs `deliverWaiting`,
 * which drifted until one of them was missing five checks including *they replied*).
 *
 * One implementation, two callers: the CLI and `replyCheck.ts`.
 *
 * NAVIGATION IS THE SAME AS SENDING, FOR THE SAME REASON
 * feed → profile → Message. Never `/direct/t/<id>`: arriving at a thread with no
 * referring page is a shape ordinary use does not produce, and this drives the same
 * accounts the send path protects.
 *
 * This module NEVER composes, types into the composer, or presses Enter. It is
 * read-only against Instagram by construction.
 */

export interface ThreadMessage {
  text: string
  /** True when this matches something we sent. */
  ours: boolean
}

/**
 * What one read of a thread actually established.
 *
 * `foundOurs` / `expectedOurs` exist because a read can SUCCEED and still be incomplete, and
 * an incomplete read reporting "no reply" is the worst outcome available here. See
 * `collectMessages`.
 */
export interface ThreadRead {
  messages: ThreadMessage[]
  /** How many of the bodies we believe we delivered were actually found in the thread. */
  foundOurs: number
  expectedOurs: number
  /** True when every message we believe we sent was visible, so silence can be vouched for. */
  complete: boolean
}

export type ReadThreadResult =
  | ({ ok: true; url: string } & ThreadRead)
  /**
   * `unreadable` is deliberately distinct from an empty thread. Instagram's DOM
   * shape here is OBSERVED (2026-07-31) and will drift, and "we could not read it"
   * must never be silently downgraded to "they have not replied" — that would let a
   * layout change quietly disable the hardest safety stop in the system.
   *
   * `incomplete` is the third case, added 2026-08-05 after measuring it live: the thread WAS
   * read, and what came back provably was not all of it. Distinct from `unreadable` because
   * the causes and the fixes differ — a DOM change versus a race we lost — and because
   * collapsing them would hide which one is happening.
   */
  | { ok: false; reason: 'unreadable' | 'incomplete' | 'no-message-button' | 'checkpoint'; detail?: string }

/**
 * `jitter` and `firstVisible` moved to `messageEntry.ts` (2026-08-19) so that module —
 * which both this file and `sendDm.ts` call — never has to import back into this one.
 * Re-exported here because `scripts/thread.ts` imports them from this path, and an
 * import path that silently stops resolving is how that CLI drifted onto its own copy
 * once before.
 */
export { jitter, firstVisible } from './messageEntry'

/** Behavioural telemetry: a person scrolls before acting. Not decoration. */
export async function browseBriefly(page: Page): Promise<void> {
  for (let i = 0; i < 2 + Math.floor(Math.random() * 2); i++) {
    await page.mouse.wheel(0, 220 + Math.floor(Math.random() * 380))
    await jitter(500, 1400)
  }
}

/**
 * Reads the message bubbles out of an already-open thread.
 *
 * Measured against the live DOM on 2026-07-31, a bubble's text sits at:
 *   div[dir=auto] < span[dir=auto] < div[role=presentation] < … < div[role=none]
 * There is no `role="grid"` and no `role="row"` — the obvious guesses, both absent.
 * So this shape is observed, not assumed, and it will drift.
 *
 * WHY IT ANCHORS ON THE COMPOSER
 * `div[role="presentation"]` and `div[dir="auto"]` occur elsewhere on a profile page,
 * so collecting them document-wide would sweep up page furniture and classify it as
 * "not ours" — i.e. as a reply. A false reply silently halts every sender to that
 * target, so that direction of error is the expensive one and is designed against.
 */
export async function readMessages(page: Page, ourBodies: readonly string[]): Promise<ThreadMessage[] | null> {
  const read = await collectMessages(page, ourBodies, 0)
  if (read === null || read.messages.length === 0) return null
  return read.messages
}

/**
 * ── THE READ MUST NOT RACE A ONE-SECOND WINDOW ────────────────────────────
 *
 * MEASURED LIVE 2026-08-05, and this was found by pruning a profile and re-reading a thread
 * to check the session survived — two consecutive reads of the SAME conversation returned
 * "1 message, no reply" and then "6 messages, they replied twice". The truth was two replies.
 *
 * Instrumenting the page explained it completely. After clicking Message:
 *
 *     t+1528ms   composer visible, all 6 bubbles present in the DOM
 *     t+2528ms   the DOM RESTRUCTURES and exactly ONE bubble still matches the selector
 *     ever after 1 bubble. Scrolling does not bring them back — `scrollTop` is already 0.
 *
 * And `openAndReadThread` slept `jitter(2000, 3500)` before reading. So the read landed
 * either side of 2528ms depending on a random number: **the completeness of the hardest
 * safety guard in this system was decided by a jitter**, and the losing side is the silent,
 * permissive one — a thread showing only our own newest message reports "no reply", gets
 * `replyCheckedAt` stamped as verified silence, and the next follow-up fires into a live
 * conversation. That is the "repeated unwanted contact" this whole guard exists to prevent.
 *
 * Note the shape: it is not that the read failed. It SUCCEEDED and returned a truthful
 * subset. `unreadable` was designed against, and this walked around it.
 *
 * ── WHAT THIS DOES INSTEAD ────────────────────────────────────────────────
 *
 * Observe DURING the dwell rather than sleeping through it. The human-like pause is unchanged
 * in length — it is a documented behavioural property and is not being traded away — but the
 * window in which the data exists is no longer thrown away.
 *
 * A `MutationObserver` rather than polling, for two reasons. It catches a node that appears
 * and is removed BETWEEN two samples, which is precisely this failure; and it costs two CDP
 * round-trips instead of a dozen, so it adds less to the automation surface than polling
 * would.
 *
 * The observer still only collects from the conversation subtree found by walking up from the
 * composer. That constraint is load-bearing and predates this change: `div[role=presentation]`
 * and `div[dir=auto]` occur elsewhere on a profile page, and sweeping them document-wide
 * would classify page furniture as "not ours", i.e. as a reply, which halts every sender to
 * that target.
 *
 * ── AND IT REPORTS WHETHER IT SAW EVERYTHING ──────────────────────────────
 *
 * Accumulating makes losing the race unlikely; it cannot make it impossible, and a fix that
 * relies on winning a race is not a fix. So completeness is CHECKED rather than assumed: we
 * know which bodies we delivered to this pair, so a read that cannot find them all has
 * provably not seen the whole conversation and must not be allowed to vouch for silence.
 *
 * The caller treats incomplete as a HOLD, never as "no reply". Fail-closed can in principle
 * wedge a very long thread whose oldest messages Instagram stops loading — that is why
 * `foundOurs`/`expectedOurs` are returned rather than a bare boolean, so the degradation is
 * visible on `/messages` instead of being a number nobody can see.
 */
export async function collectMessages(
  page: Page,
  ourBodies: readonly string[],
  dwellMs: number,
): Promise<ThreadRead | null> {
  const SEL = 'div[role="presentation"] div[dir="auto"], div[role="row"]'
  const KEY = '__dsThreadBubbles'

  /**
   * Install the observer FIRST, before waiting for the composer — the full DOM is present
   * before the restructure, and waiting would spend part of the window.
   *
   * No named inner functions inside `page.evaluate`: tsx/esbuild's `keepNames` wraps them in
   * a `__name()` helper that does not exist in the page, and the call throws
   * `ReferenceError: __name is not defined`. Found by running it.
   */
  await page.evaluate(
    ([sel, key]) => {
      const w = window as unknown as Record<string, unknown>
      if (w[key]) return
      const collected: string[] = []
      w[key] = collected

      const observer = new MutationObserver(() => {
        const box =
          document.querySelector('div[contenteditable="true"][role="textbox"]') ??
          document.querySelector('div[role="textbox"]')
        if (!box) return
        let panel: Element | null = box.parentElement
        for (let i = 0; i < 12 && panel; i++) {
          if (panel.querySelectorAll(sel!).length > 0) break
          panel = panel.parentElement
        }
        if (!panel) return
        for (const el of panel.querySelectorAll(sel!)) {
          if (box.contains(el) || el.contains(box)) continue
          const t = (el.textContent ?? '').trim()
          if (t.length > 0) collected.push(t)
        }
      })
      observer.observe(document.body, { childList: true, subtree: true, characterData: true })
      ;(w[`${key}Observer`] as unknown) = observer
    },
    [SEL, KEY] as const,
  )

  const composer = await firstVisible(
    page,
    [page.getByRole('textbox', { name: /message/i }), page.locator('div[contenteditable="true"][role="textbox"]')],
    20_000,
  )
  if (!composer) return null

  // The dwell a person spends looking at a conversation — now spent watching it.
  if (dwellMs > 0) await page.waitForTimeout(dwellMs)

  // Read-only DOM traversal. The prohibition on `evaluate` in this codebase concerns
  // synthesised INPUT events, which lack `isTrusted`; reading has no such issue.
  const texts = await page.evaluate(
    ([sel, key]) => {
      const w = window as unknown as Record<string, unknown>
      const collected = (w[key!] as string[] | undefined) ?? []

      const box =
        document.querySelector('div[contenteditable="true"][role="textbox"]') ??
        document.querySelector('div[role="textbox"]')
      if (!box) return collected.length > 0 ? collected : null

      // One final direct sweep, so a thread that never mutated after we attached is still
      // read. The observer only fires on change; a static thread would otherwise be empty.
      let panel: Element | null = box.parentElement
      for (let i = 0; i < 12 && panel; i++) {
        if (panel.querySelectorAll(sel!).length > 0) break
        panel = panel.parentElement
      }
      const out = [...collected]
      if (panel) {
        for (const el of panel.querySelectorAll(sel!)) {
          if (box.contains(el) || el.contains(box)) continue
          const t = (el.textContent ?? '').trim()
          if (t.length > 0) out.push(t)
        }
      }
      return out
    },
    [SEL, KEY] as const,
  )

  if (texts === null) return null

  /**
   * De-duplicate on RAW text, not normalised text, preserving first-seen order.
   *
   * The observer sees the same bubble on several mutations, and those repeats are
   * byte-identical, so raw comparison removes exactly them. Normalising instead ALSO merges
   * genuinely distinct messages that differ only in case or spacing — measured on the live
   * thread, a reply of "Hi" and a later one of "hi" collapsed into a single bubble, so the
   * read returned 5 messages where 6 were sent.
   *
   * The halt fires either way (any reply halts every sender), so this is not a safety
   * regression; it is silent information loss in the guard whose whole job is to notice what
   * the other side said, which is not a trade worth making for tidier output. `normalise` is
   * still used for the emptiness test, where merging is exactly what is wanted.
   */
  const seen = new Set<string>()
  const messages: ThreadMessage[] = []
  for (const text of texts) {
    const raw = text.trim()
    if (normalise(raw).length === 0 || seen.has(raw)) continue
    seen.add(raw)
    messages.push({ text, ours: isOneOfOurs(text, ourBodies) })
  }

  return assessRead(messages, ourBodies)
}

/**
 * Did this read cover the whole conversation? PURE, so it can be driven both ways.
 *
 * The decision that gates a send must be testable without a browser. And it must be
 * assertable in the FAILING direction — a completeness check that only ever runs on complete
 * reads is the same unfalsifiable guard this codebase keeps rediscovering.
 *
 * Counted per body rather than by comparing lengths: two of our messages can render as one
 * bubble if Instagram groups them, and `messages.length >= ourBodies.length` would then be
 * satisfied by bubbles that are not ours at all — including a reply, which is precisely the
 * thing we are trying not to miss.
 *
 * ── EACH SENT BODY MUST CLAIM ITS OWN BUBBLE (2026-08-17) ─────────────────
 *
 * This asked `messages.some(...)` per body — MEMBERSHIP, not occurrence — and membership is
 * a property of the whole thread. So N copies of one body were all answered by ONE visible
 * bubble: `foundOurs` reached `ourBodies.length` from a read that had seen a single message,
 * `complete` came back true, and the caller stamped `replyCheckedAt` as VERIFIED SILENCE
 * over a conversation it had not seen.
 *
 * It was latent only while every body differed. The single standard template makes every
 * message to a recipient byte-identical, which turns the common case into the broken one —
 * so this ships WITH that change, not after it.
 *
 * That is the third time this exact shape has appeared here, and the answer has been the
 * same every time: `matching.ts` asked *is the needle present* when the composer held it
 * either way, then asked it again when an EARLIER BUBBLE held it. **Count the thing that
 * changes, not the thing that is there either way.**
 *
 * The claim is greedy and each message is consumed at most once. Where Instagram GROUPS two
 * of our messages into one bubble the second body finds nothing left to claim and the read
 * reports INCOMPLETE — which holds the send. That is the safe direction and the deliberate
 * one: a hold is visible on `/messages` with the buttons that settle it, while a false
 * `complete` is a guard reporting silence it never verified.
 */
export function assessRead(messages: ThreadMessage[], ourBodies: readonly string[]): ThreadRead {
  const claimed = new Set<number>()
  let foundOurs = 0
  for (const body of ourBodies) {
    const idx = messages.findIndex((m, i) => !claimed.has(i) && isOneOfOurs(m.text, [body]))
    if (idx === -1) continue
    claimed.add(idx)
    foundOurs += 1
  }
  return {
    messages,
    foundOurs,
    expectedOurs: ourBodies.length,
    complete: foundOurs >= ourBodies.length,
  }
}

/**
 * Full journey: launch the sender's profile, navigate feed → target → Message, read.
 *
 * Caller owns nothing; the browser context is opened and closed here, because a leaked
 * context is a visible Chrome window nobody closes and, worse, a profile directory left
 * locked against the next run.
 */
export async function openAndReadThread(
  senderHandle: string,
  targetHandle: string,
  ourBodies: readonly string[],
): Promise<ReadThreadResult> {
  const context = await launchProfile(senderHandle)
  try {
    const page = context.pages()[0] ?? (await context.newPage())

    await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded', timeout: 60_000 })
    assertNoCheckpoint(page, senderHandle)
    await assertLoggedInAs(page, senderHandle)
    await browseBriefly(page)

    await page.goto(profileUrl(targetHandle), { waitUntil: 'domcontentloaded', timeout: 60_000 })
    assertNoCheckpoint(page, senderHandle)
    await jitter(1500, 3200)

    // The button when the profile shows one, the "…" menu's "Send message" when it does
    // not — the same door the send path uses, from the same implementation. A profile
    // that hides the button (measured: @dharmaticent, 2026-08-19) must stay READABLE,
    // or its conversation can never be checked for a reply.
    const entry = await clickMessageEntry(page, targetHandle)
    if (!entry.ok) return { ok: false, reason: 'no-message-button' }

    /**
     * The dwell is now spent INSIDE the read rather than before it. Same wall-clock pause, so
     * the behavioural property is unchanged; the difference is that the one-second window in
     * which Instagram has the whole thread in the DOM is observed instead of slept through.
     * See `collectMessages` for the measurement.
     */
    const dwellMs = 2000 + Math.floor(Math.random() * 1500)
    const read = await collectMessages(page, ourBodies, dwellMs)
    assertNoCheckpoint(page, senderHandle)

    if (read === null || read.messages.length === 0) return { ok: false, reason: 'unreadable' }

    /**
     * A read that could not find every message we believe we delivered has provably not seen
     * the whole conversation, so it must not be allowed to vouch for silence. Reported as its
     * own reason, with the counts, because "the layout changed" and "we lost the race" need
     * different fixes.
     */
    if (!read.complete) {
      return {
        ok: false,
        reason: 'incomplete',
        detail: `saw ${read.foundOurs} of ${read.expectedOurs} messages we sent — cannot vouch for silence`,
      }
    }

    return { ok: true, ...read, url: page.url() }
  } finally {
    await jitter(1000, 2000)
    await context.close()
  }
}
