import type { Page } from 'patchright'
import { isOneOfOurs, normalise } from '@/outreach/matching'
import { profileUrl } from '@/lib/urls'
import { assertLoggedInAs, assertNoCheckpoint, launchProfile } from './session'
import {
  clickMessageEntry,
  openThreadViaInbox,
  passBusinessInterstitial,
  acceptMessageRequest,
  dismissBlockingDialog,
  firstVisible,
  jitter,
} from './messageEntry'
import { parseThreadTimestamp } from './threadDates'

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
  /**
   * When this message was WRITTEN, as far as the thread's own date separators showed —
   * the nearest separator ABOVE the bubble ("18:04", "Yesterday 14:21", "19 August
   * 2026, 14:21"), parsed by `parseThreadTimestamp`. NULL when no separator above it
   * parsed, or when the bubble was seen only by the mutation observer (which has no
   * position). The seven-day reply halt keys on this: an undatable reply is recorded
   * but does not hold the halt — Tabish's rule, 2026-08-21.
   */
  approxAt: Date | null
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
  | {
      ok: false
      reason: 'unreadable' | 'incomplete' | 'no-message-button' | 'checkpoint'
      detail?: string
      /**
       * What an INCOMPLETE read did see. A partial read may never vouch for silence, but a
       * reply it has in hand is a fact:  answered the 1 Sept first touch,
       * three reads on 2-3 Sept came back "saw 0 of 1" and each discarded the bubble they
       * had seen, and a follow-up went into the answered conversation on 3 Sept (2026-09-03).
       */
      messages?: ThreadMessage[]
    }

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
export async function readMessages(page: Page, bodies: ThreadBodies): Promise<ThreadMessage[] | null> {
  const read = await collectMessages(page, bodies, 0)
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
  bodies: ThreadBodies,
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
  //
  // The final sweep returns the panel's bubbles AND its date separators in DOCUMENT
  // ORDER, so each bubble can be dated from the nearest separator above it. Separators
  // are `span[dir=auto]` nodes OUTSIDE any bubble — observed live 2026-08-21 ("12:39"
  // above our message, "18:04" above the reply on the @indiagatefoods thread); the
  // bubble selector never matches them, which is why replies were never falsely minted
  // from them. `querySelectorAll` returns document order, which is what makes the
  // nearest-preceding association sound.
  const sweepOnce = () => page.evaluate(
    ([sel, key]) => {
      const w = window as unknown as Record<string, unknown>
      const collected = (w[key!] as string[] | undefined) ?? []

      const box =
        document.querySelector('div[contenteditable="true"][role="textbox"]') ??
        document.querySelector('div[role="textbox"]')
      if (!box) return collected.length > 0 ? { collected, ordered: [] as { b: number; t: string }[] } : null

      // One final direct sweep, so a thread that never mutated after we attached is still
      // read. The observer only fires on change; a static thread would otherwise be empty.
      let panel: Element | null = box.parentElement
      for (let i = 0; i < 12 && panel; i++) {
        if (panel.querySelectorAll(sel!).length > 0) break
        panel = panel.parentElement
      }
      const ordered: { b: number; t: string }[] = []
      if (panel) {
        for (const el of panel.querySelectorAll(`${sel!}, span[dir="auto"]`)) {
          if (box.contains(el) || el.contains(box)) continue
          const t = (el.textContent ?? '').trim()
          if (t.length === 0) continue
          if (el.matches(sel!)) {
            ordered.push({ b: 1, t })
          } else if (!el.closest('div[role="presentation"], div[role="row"]')) {
            // A span[dir=auto] outside every bubble: a candidate date separator. The
            // anchored parser decides; prose here can never become a date.
            ordered.push({ b: 0, t })
          }
        }
      }
      return { collected, ordered }
    },
    [SEL, KEY] as const,
  )

  let swept = await sweepOnce()
  if (swept === null) return null

  /** One sweep → one read: date, de-duplicate, classify, judge completeness. */
  const assemble = (s: NonNullable<typeof swept>): ThreadRead => {
    /** Nearest parseable separator ABOVE each bubble, keyed by the bubble's raw text. */
    const approx = new Map<string, Date | null>()
    {
      let current: Date | null = null
      for (const e of s.ordered) {
        if (e.b === 0) {
          const ts = parseThreadTimestamp(e.t)
          if (ts) current = ts
        } else if (!approx.has(e.t)) {
          approx.set(e.t, current)
        }
      }
    }

    const texts = [...s.collected, ...s.ordered.filter((e) => e.b === 1).map((e) => e.t)]

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
     * regression; it is silent information loss in the guard whose whole job is to notice
     * what the other side said, which is not a trade worth making for tidier output.
     * `normalise` is still used for the emptiness test, where merging is exactly what is wanted.
     */
    const seen = new Set<string>()
    const messages: ThreadMessage[] = []
    for (const text of texts) {
      const raw = text.trim()
      if (normalise(raw).length === 0 || seen.has(raw)) continue
      seen.add(raw)
      messages.push({ text, ours: isOneOfOurs(text, bodies.allOurs), approxAt: approx.get(raw) ?? null })
    }

    /* Completeness is judged against THIS PAIR's deliveries — see ThreadBodies. */
    return assessRead(messages, bodies.expected)
  }

  let read = assemble(swept)

  /**
   * ── LOAD THE HISTORY BEFORE CALLING A READ INCOMPLETE (2026-09-03) ──────────────────
   *
   * Instagram renders only the most recent stretch of a thread; older bubbles load when the
   * message pane is scrolled to its top. Every pair with three deliveries read *"saw 1 of 3
   * messages we sent"* on EVERY read — the sweep logged `incomplete=4 of 4` all morning, four
   * such pairs were parked as failed, and a reply sitting above the fold could never be seen.
   *
   * So an incomplete first sweep scrolls the pane to its top and sweeps again, a bounded
   * number of times; the observer keeps collecting through each load. It stops early when the
   * pane is already at its top (nothing more will load) and never abandons the bar: a thread
   * Instagram genuinely stops loading still reports INCOMPLETE and holds, exactly as before.
   * Setting `scrollTop` is a DOM read/write like `inboxScan`'s, not a synthesised input event.
   */
  for (let round = 0; round < HISTORY_SCROLL_ROUNDS && !read.complete && bodies.expected.length > 0; round++) {
    const scrolled = await page.evaluate(
      ([sel]) => {
        const box =
          document.querySelector('div[contenteditable="true"][role="textbox"]') ??
          document.querySelector('div[role="textbox"]')
        if (!box) return false
        let panel: Element | null = box.parentElement
        for (let i = 0; i < 12 && panel; i++) {
          if (panel.querySelectorAll(sel!).length > 0) break
          panel = panel.parentElement
        }
        /**
         * MEASURED 2026-09-03 on the profile-panel view the reader actually uses: the ONLY
         * scrollable on the page is the message list — scrollHeight 1740 against a 386px
         * viewport, ONE bubble mounted, and scrollTop 0. Instagram lays the list out
         * column-reverse, so scrollTop 0 is the NEWEST message and older ones live at
         * NEGATIVE scroll. That is what the 5 August note ("scrollTop is already 0") was
         * seeing, and why a "scroll to 0" could never load anything. Drive it negative;
         * a plain top-down list clamps the same write to 0, its own top. It is also NOT an
         * ancestor of the composer, so the search is page-wide: any scrollable that holds a
         * bubble, not only the composer's own panel.
         */
        if (!panel) return false
        const candidates = [panel, ...document.querySelectorAll('div')]
        for (const c of candidates) {
          const s = getComputedStyle(c)
          if ((s.overflowY !== 'auto' && s.overflowY !== 'scroll') || c.scrollHeight <= c.clientHeight + 4) continue
          if (c.querySelectorAll(sel!).length === 0) continue
          /**
           * STEP, do not jump. MEASURED 2026-09-03 on @bollywoodsocietyy → @amazonmgmstudiosin:
           * the pane mounts ONLY the bubbles in view — one bubble at scrollTop 0 (the newest),
           * one at −1102 (the oldest), nothing in between in the DOM at either position. A
           * jump to the top skips every message in the middle. So each round moves one
           * viewport toward the older end and the caller sweeps again; the observer collects
           * whatever mounts at each stop, and `assemble` merges it all.
           */
          const reversed = getComputedStyle(c).flexDirection === 'column-reverse'
          const before = c.scrollTop
          const olderLimit = reversed ? -(c.scrollHeight - c.clientHeight) : 0
          const step = Math.max(120, Math.floor(c.clientHeight * 0.8))
          const next = Math.max(olderLimit, before - step)
          if (next === before) return false
          c.scrollTop = next
          return c.scrollTop !== before
        }
        return false
      },
      [SEL] as const,
    )
    if (!scrolled) break
    await page.waitForTimeout(700)
    const again = await sweepOnce()
    if (again === null) break
    swept = again
    read = assemble(again)
  }

  return read
}

/**
 * Viewport-sized steps toward the older end when the first sweep did not see every message
 * we sent. 25 steps × ~80% of a 386px viewport covers ~7,700px of thread — dozens of messages —
 * and stops early at the top; a longer thread still reports incomplete and holds.
 */
const HISTORY_SCROLL_ROUNDS = 25

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
/**
 * HOW LONG ONE CONVERSATION READ MAY TAKE BEFORE IT IS ABANDONED.
 *
 * MEASURED 2026-08-20: a single read hung for **88 minutes** (09:04 → 10:32 IST) while
 * the SSH tunnel to the database dropped, and because the reply sweep holds the
 * fleet-wide SEND LOCK for its whole duration, **the entire fleet stopped sending for
 * those 88 minutes** — with every screen healthy and the dispatcher reporting only
 * "another send is already running". A hard stop with no release, again.
 *
 * Every `page.goto` here is already bounded at 60s, so the hang was not a navigation: an
 * in-page `fetch` (the identity check) has no timeout of its own and waits forever on a
 * stalled socket. **Closing the CONTEXT is what unblocks it** — which is also exactly the
 * cleanup the `finally` performs anyway, so this bomb does not abandon a browser to leak.
 * That matters more than the timeout itself: racing the promise and walking away would
 * leave a live context on a profile a send might pick up seconds later, and two contexts
 * on one profile is how device identity dies.
 *
 * SIX MINUTES: a healthy read is 30-60s, so this cannot fire on a slow-but-working thread,
 * and it caps the fleet's worst-case silence at one read rather than one outage. The
 * outcome is `unreadable` — never "no reply" — so a timeout can never be mistaken for
 * verified silence, which is the whole reason that distinction exists.
 */
export const READ_DEADLINE_MS = 6 * 60 * 1000

/**
 * ── TWO BODY SETS, TWO JOBS, AND CONFLATING THEM SILENCED THE REPLY GUARD (2026-08-21) ──
 *
 * `allOurs` — everything ANY of our pages ever delivered to this recipient. Used to classify
 * a bubble as ours-or-theirs, where fleet-wide is strictly SAFER: a body that exists in any
 * of our threads must never be read back as the recipient's words.
 *
 * `expected` — what THIS PAIR delivered, occurrence-correct. Used for COMPLETENESS, where
 * fleet-wide is strictly WRONG: a thread holds ONE pair's conversation, so on a recipient the
 * ring fanned out to, five pages' identical messages live in five different threads and no
 * single thread can ever show more than one.
 *
 * MEASURED before the split: every sweep read since ~03:39 on 2026-08-21 reported
 * `incomplete=4` — the completeness bar was fleet-wide, so it was structurally unsatisfiable
 * for every fanned-out recipient, `replyCheckedAt` was never stamped, and **a recipient's
 * rate negotiation ("this will cost you 8k per post", "10 posts deal lelo", a phone number)
 * sat unrecorded while other pages kept messaging her.** The reply guard's own fail-closed
 * design (incomplete never vouches for silence) did exactly what it promised — and the wrong
 * expected-set upstream turned that safety into a permanent blindfold.
 *
 * The old comment defending the fleet-wide set ("it can only make 'not ours' a stricter
 * test") was TRUE — for classification. Completeness inherited the same input silently, and
 * the two questions have opposite safe directions. Hence one object with two named fields,
 * so no future caller can hand one set to both jobs without saying so.
 */
export interface ThreadBodies {
  /** Delivered by THIS pair — the completeness bar. */
  expected: readonly string[]
  /** Delivered by ANY of our pages to this recipient — the ours/theirs classifier. */
  allOurs: readonly string[]
}

export async function openAndReadThread(
  senderHandle: string,
  targetHandle: string,
  bodies: ThreadBodies,
): Promise<ReadThreadResult> {
  const context = await launchProfile(senderHandle)
  let deadlineFired = false
  const deadline = setTimeout(() => {
    deadlineFired = true
    // Closing is the interrupt AND the cleanup. Errors here are ignored on purpose: the
    // `finally` below closes again, and a double close must not mask the real outcome.
    void context.close().catch(() => {})
  }, READ_DEADLINE_MS)
  try {
    const page = context.pages()[0] ?? (await context.newPage())

    await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded', timeout: 60_000 })
    assertNoCheckpoint(page, senderHandle)
    await assertLoggedInAs(page, senderHandle)
    // Blocker 3: a dialog over the conversation would be read as page text and, worse,
    // hide the bubbles the completeness check needs — an incomplete read must never be
    // caused by something we could have clicked away.
    await dismissBlockingDialog(page)
    await browseBriefly(page)

    await page.goto(profileUrl(targetHandle), { waitUntil: 'domcontentloaded', timeout: 60_000 })
    assertNoCheckpoint(page, senderHandle)
    await jitter(1500, 3200)
    await dismissBlockingDialog(page)

    // The button when the profile shows one, the "…" menu's "Send message" when it does
    // not — the same door the send path uses, from the same implementation. A profile
    // that hides the button (measured: @dharmaticent, 2026-08-19) must stay READABLE,
    // or its conversation can never be checked for a reply.
    const entry = await clickMessageEntry(page, targetHandle)
    if (!entry.ok) {
      // Blocker 4: a profile with no door at all still has a conversation worth reading —
      // the inbox-compose route reaches the same thread the send path would use.
      const viaInbox = await openThreadViaInbox(page, targetHandle)
      if (!viaInbox) return { ok: false, reason: 'no-message-button' }
    }

    // And the business-messaging dialog, which blocks READS exactly as it blocks sends —
    // Tabish's 2026-08-19 screenshot caught it over @cameratakefilms while the first
    // sweep filed that thread unreadable. "Send message request" opens the ordinary
    // conversation; nothing is typed and nothing is sent by this module, as ever.
    await passBusinessInterstitial(page, targetHandle)
    await dismissBlockingDialog(page)

    /**
     * BLOCKER 5 on the READ path too, and this is the half that matters most for it: an
     * unaccepted request is a message somebody sent US, so refusing to accept it means the
     * one thread most likely to contain a real enquiry is the one we can never read. A
     * blocker fixed on one path and not the other is this codebase's most repeated defect,
     * which is why every door lives in `messageEntry.ts` and both callers take it.
     */
    if (await acceptMessageRequest(page, targetHandle)) {
      await dismissBlockingDialog(page)
    }

    /**
     * The dwell is now spent INSIDE the read rather than before it. Same wall-clock pause, so
     * the behavioural property is unchanged; the difference is that the one-second window in
     * which Instagram has the whole thread in the DOM is observed instead of slept through.
     * See `collectMessages` for the measurement.
     */
    const dwellMs = 2000 + Math.floor(Math.random() * 1500)
    const read = await collectMessages(page, bodies, dwellMs)
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
        messages: read.messages,
      }
    }

    /**
     * The page URL usually stays on the PROFILE — the conversation opens as a panel over
     * it (verified live 2026-08-19: the first sweep read three threads and backfilled
     * zero URLs, because `page.url()` never said `/direct/t/`). If the panel renders an
     * anchor to the real thread, prefer it; a DOM read, no navigation.
     */
    let url = page.url()
    if (!url.includes('/direct/t/')) {
      const href = await page
        .locator('a[href*="/direct/t/"]')
        .first()
        .getAttribute('href', { timeout: 1_000 })
        .catch(() => null)
      if (href) url = new URL(href, 'https://www.instagram.com').toString()
    }
    return { ok: true, ...read, url }
  } catch (err) {
    /**
     * A deadline expiry is `unreadable`, NEVER "no reply" — the caller must not stamp
     * `replyCheckedAt` on it, or a stalled network would convert into an assertion of
     * verified silence and release the hardest guard in the system. Re-thrown as an
     * ordinary read failure so `checkConversation`'s existing branch handles it, and
     * NOT matching /checkpoint|challenge|suspend/, so it can never flag an account.
     */
    if (deadlineFired) {
      throw new Error(`reply read abandoned after ${READ_DEADLINE_MS / 60_000} minutes — thread could not be read in time`)
    }
    throw err
  } finally {
    clearTimeout(deadline)
    // Skipped when the bomb already closed the context: jittering after an abandoned
    // read only delays releasing the send lock, which is the thing being protected.
    if (!deadlineFired) {
      await jitter(1000, 2000)
      await context.close()
    }
  }
}
