import type { Page } from 'patchright'
import { log } from '@/lib/logger'
import { launchProfile, assertLoggedInAs, assertNoCheckpoint, CheckpointError } from './session'
import { browseBriefly } from './readThread'
import { firstVisible, jitter, dismissBlockingDialog, clickPastDialogs } from './messageEntry'

/**
 * READ THE INBOX LIST — one browser drive that answers "who wrote last, and when?"
 * for EVERY conversation this sender has, instead of one drive per conversation.
 *
 * ── WHY THIS EXISTS (measured, 2026-08-21) ────────────────────────────────
 *
 * The sweep read 4 threads per run against ~600 open conversations — coverage 10%, and
 * six replies EVER detected fleet-wide. One probe of @bollywoodchronicle's real inbox
 * found SIX undetected replies in ten minutes, one of them a buyer conversation in
 * Hindi sitting in the "Partnership messages" folder the sweep never opened, and one
 * (@indiagatefoods) that arrived DURING the probe. The inbox list is Instagram's own
 * answer to the question the sweep was paying a browser drive per thread to ask.
 *
 * ── WHAT A ROW LOOKS LIKE (observed, not assumed) ─────────────────────────
 *
 * Rows are `div[role="button"][tabindex]` containers holding a `span[title="Display
 * Name"]`, a snippet span, a "·" separator, a relative age span ("41m", "1h", "2d"),
 * and sometimes an "Unread" marker or "2 new messages". Our own last message renders
 * as "You sent an attachment." / "You: …" — the You-prefix is the ours/theirs signal,
 * with a body-prefix check behind it as insurance (see inboxTriage.ts).
 *
 * READ-ONLY BY CONSTRUCTION: this module scrolls and reads. It clicks exactly two
 * things — the inbox nav icon and the "Partnership messages" folder — and never a
 * conversation row, never a composer.
 */

export interface InboxRow {
  /** The `span[title]` display name — matched against TargetAccount.displayName/handle. */
  displayName: string
  /** The row's preview text: "You sent an attachment.", the reply text, "2 new messages". */
  snippet: string
  /** The relative age as printed ("41m", "2d"), or null when the row shows none. */
  ageText: string | null
  unread: boolean
  folder: 'primary' | 'partnership'
  /**
   * The row's own `/direct/t/<id>/` link when it carries one, else null. This is the
   * IDENTITY of the conversation, and it is what `replyCheck` matches first: 84 live
   * prospects store the raw handle as their display name (2026-09-03), so @mynykaa's row
   * titled "Nykaa" and @maybelline_ind's titled "Maybelline New York - India" could never
   * match by name — Nykaa's reply of 27 Aug went unrecorded for a week. Every delivered
   * message to those 84 carries a `threadUrl`, so the link resolves them exactly.
   */
  threadUrl: string | null
}

export type InboxScanResult =
  | { ok: true; rows: InboxRow[] }
  | { ok: false; reason: 'checkpoint' | 'unreadable'; detail?: string }

/**
 * Collect the rows currently rendered, scrolling the list to load more.
 * All logic inlined — named inner functions inside `page.evaluate` die on esbuild's
 * `__name` wrapper (the documented trap; found by running it, again, this session).
 */
async function collectRows(page: Page, folder: InboxRow['folder']): Promise<InboxRow[]> {
  const raw = await page.evaluate(async () => {
    const out: { title: string; texts: string[]; href: string | null }[] = []
    const seen = new Set<string>()
    let scroller: Element | null = null
    {
      const all = [...document.querySelectorAll('div[role="button"][tabindex]')]
      let p: Element | null = all.find((r) => r.querySelector('span[title]')) ?? null
      while (p && p !== document.body) {
        const s = getComputedStyle(p)
        if ((s.overflowY === 'auto' || s.overflowY === 'scroll') && p.scrollHeight > p.clientHeight) break
        p = p.parentElement
      }
      scroller = p === document.body ? null : p
    }
    for (let round = 0; round < 8; round++) {
      for (const r of [...document.querySelectorAll('div[role="button"][tabindex]')]) {
        const title = r.querySelector('span[title]')?.getAttribute('title') ?? ''
        if (!title) continue
        const texts: string[] = []
        for (const l of [...r.querySelectorAll('span, div')]) {
          if (l.children.length !== 0) continue
          const t = (l.textContent ?? '').trim()
          if (t) texts.push(t)
        }
        const key = title + '|' + texts.join('|')
        if (seen.has(key)) continue
        seen.add(key)
        // The conversation link, on the row itself, an ancestor, or a descendant — read,
        // never followed. Absent when Instagram renders the row without an anchor.
        const a = r.closest('a[href*="/direct/t/"]') ?? r.querySelector('a[href*="/direct/t/"]')
        out.push({ title, texts, href: a ? a.getAttribute('href') : null })
      }
      if (!scroller) break
      scroller.scrollTop = scroller.scrollHeight
      await new Promise((r) => setTimeout(r, 1100))
    }
    return out
  })

  const rows: InboxRow[] = []
  const dedupe = new Set<string>()
  for (const r of raw) {
    /* The same conversation can be collected twice across scroll rounds if its row
       re-rendered (a new message moves it); keep the FIRST sighting per title. */
    if (dedupe.has(r.title)) continue
    dedupe.add(r.title)
    const ageText = [...r.texts].reverse().find((t) => /^\d+\s*[smhdw]$/i.test(t)) ?? null
    const unread = r.texts.some((t) => t === 'Unread' || /^\d+ new messages?$/i.test(t))
    const snippet =
      r.texts.find(
        (t) =>
          t !== r.title &&
          t !== '·' &&
          t !== 'Unread' &&
          t !== ageText &&
          /**
           * PRESENCE IS NOT A MESSAGE. Rows for accounts currently online carry an
           * "Active" / "Active now" / "Active 3h ago" text BEFORE the real snippet, and
           * the first live run recorded one as a reply ("Active", @shirin_tuli_sharma) —
           * a false reply halts a target for seven days, the expensive direction. Skip
           * presence and keep looking; the real snippet follows it in the same row.
           */
          !/^active\b/i.test(t) &&
          t.length > 0,
      ) ?? ''
    rows.push({ displayName: r.title, snippet, ageText, unread, folder, threadUrl: r.href })
  }
  return rows
}

/**
 * Open this sender's inbox and read every visible conversation row, Primary AND the
 * "Partnership messages" folder — business recipients answered via "Send message
 * request" file there, which is where the probe found a live buyer conversation the
 * sweep had never seen.
 */
/**
 * ── ONE SCAN IS BOUNDED, BECAUSE A HUNG PASS WEDGES THE WHOLE SWEEP ───────
 *
 * Same value and same mechanism as `READ_DEADLINE_MS` in readThread.ts, and for a reason
 * measured on 2026-08-22 rather than imagined: when the Mac's network dropped, the brand
 * pass's unbounded lookup hung and `brandPassRunning` stayed true for 70+ MINUTES, so that
 * pass was skipped every 30 minutes while the log honestly said "still running". The reply
 * sweep's flag does the same job and this scan is the newest thing inside it — per-navigation
 * timeouts (60s) do not bound the `page.evaluate` scroll loop, which can hang on a stalled
 * renderer. The sweep also holds the fleet-wide SEND LOCK for its whole run, so a hung scan
 * does not merely delay reading: it stops the fleet sending.
 *
 * CLOSING THE CONTEXT IS THE INTERRUPT AND THE CLEANUP — never racing the promise and
 * walking away, which would leave a live context on a profile a send may pick up seconds
 * later. And a timeout is `unreadable`, NEVER "an empty inbox": a stalled network must not
 * become an assertion that nobody has written to us.
 */
export const SCAN_DEADLINE_MS = 6 * 60 * 1000

export interface ScanOptions {
  /**
   * Which rows are worth OPENING to learn which conversation they are. MEASURED 2026-09-03
   * on a live inbox: a row is a `div[role=button]` with a `span[title]`, an avatar whose alt
   * is the literal "user-profile-picture", and NO anchor anywhere in or around it — so the
   * row itself carries no identity at all. Opening it does: the page lands on
   * `/direct/t/<id>`, and that id is what every delivered message stores as `threadUrl`.
   * The caller names the rows that need this (the ones the name rules could not place
   * and where THEY wrote last); everything else is never clicked.
   */
  needsThread?: (row: InboxRow) => boolean
}

/**
 * Rows opened per sender per scan. Each open is a trusted click, a ~2s dwell and a back
 * navigation on a revenue account — bounded so a backlog of unplaced rows is worked down
 * over several sweeps rather than in one long drive.
 */
export const MAX_THREAD_OPENS = 8

async function resolveThreads(
  page: Page,
  rows: InboxRow[],
  needs: (row: InboxRow) => boolean,
  senderHandle: string,
): Promise<number> {
  const listUrl = page.url()
  let opened = 0
  for (const row of rows) {
    if (opened >= MAX_THREAD_OPENS) break
    if (row.threadUrl || !needs(row)) continue
    await dismissBlockingDialog(page)
    // The row titled exactly this name. `getByTitle(..., exact)` needs no CSS escaping of
    // whatever punctuation a display name carries.
    const el = page
      .locator('div[role="button"][tabindex]')
      .filter({ has: page.getByTitle(row.displayName, { exact: true }) })
      .first()
    if ((await el.count()) === 0) continue
    await el.scrollIntoViewIfNeeded().catch(() => {})
    await jitter(400, 900)
    opened += 1
    if (!(await clickPastDialogs(page, el, `the conversation with "${row.displayName}"`))) continue
    await page.waitForURL(/\/direct\/t\/\d+/, { timeout: 8_000 }).catch(() => {})
    assertNoCheckpoint(page, senderHandle)
    if (/\/direct\/t\/\d+/.test(page.url())) row.threadUrl = page.url()
    await jitter(1200, 2200)
    // Back to the list we were reading. goBack keeps the folder; the list URL is the fallback.
    const back = await page.goBack({ waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => null)
    if (!back || !page.url().startsWith(listUrl.split('?')[0]!)) {
      await page.goto(listUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => {})
    }
    await jitter(1500, 2500)
    await dismissBlockingDialog(page)
  }
  return opened
}

export async function scanInbox(senderHandle: string, opts: ScanOptions = {}): Promise<InboxScanResult> {
  const context = await launchProfile(senderHandle)
  let deadlineFired = false
  const deadline = setTimeout(() => {
    deadlineFired = true
    // Errors ignored on purpose: the `finally` closes again, and a double close must not
    // mask the real outcome.
    void context.close().catch(() => {})
  }, SCAN_DEADLINE_MS)
  try {
    const page = context.pages()[0] ?? (await context.newPage())
    await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded', timeout: 60_000 })
    assertNoCheckpoint(page, senderHandle)
    await assertLoggedInAs(page, senderHandle)
    await browseBriefly(page)
    await dismissBlockingDialog(page)

    const dmLink = await firstVisible(page, [page.locator('a[href="/direct/inbox/"]')], 10_000)
    if (dmLink) {
      await dmLink.click()
    } else {
      await page.goto('https://www.instagram.com/direct/inbox/', { waitUntil: 'domcontentloaded', timeout: 60_000 })
    }
    await jitter(2500, 4000)
    assertNoCheckpoint(page, senderHandle)
    await dismissBlockingDialog(page)

    const rows = await collectRows(page, 'primary')
    let opened = 0
    if (opts.needsThread) opened += await resolveThreads(page, rows, opts.needsThread, senderHandle)

    /* The partnership folder, when the account has one. Its absence is ordinary. */
    const folder = page.locator('div[role="button"]', { hasText: /partnership messages/i }).first()
    if ((await folder.count()) > 0) {
      await folder.scrollIntoViewIfNeeded().catch(() => {})
      await jitter(400, 900)
      await folder.click().catch(() => {})
      await jitter(2500, 4000)
      assertNoCheckpoint(page, senderHandle)
      if (page.url().includes('/direct/partnerships')) {
        const partnership = await collectRows(page, 'partnership')
        if (opts.needsThread && opened < MAX_THREAD_OPENS) {
          opened += await resolveThreads(page, partnership, opts.needsThread, senderHandle)
        }
        rows.push(...partnership)
      }
    }
    if (opened > 0) log.step('opened unplaced inbox rows to learn their thread ids', { sender: senderHandle, opened })

    if (rows.length === 0) {
      /* An empty inbox and an unreadable one are different facts; a sender with 600
         delivered messages cannot have an empty list, so say "unreadable", not "quiet". */
      return { ok: false, reason: 'unreadable', detail: 'no conversation rows matched — the inbox DOM may have drifted' }
    }
    return { ok: true, rows }
  } catch (err) {
    /**
     * THE DEADLINE IS CHECKED BEFORE THE CHECKPOINT BRANCH, and that order is the point.
     * Closing the context mid-flight throws a Playwright error whose text we do not
     * control, and `checkConversation` marks an account CHALLENGED on
     * /checkpoint|challenge|suspend/i — so a network stall must never be able to flag a
     * healthy revenue account and halt the whole fleet through the breaker. Same
     * assertion `tests/read-deadline.test.ts` carries for the thread reader.
     */
    if (deadlineFired) {
      log.warn('inbox scan exceeded its deadline — the context was closed, nothing recorded', {
        sender: senderHandle,
        deadlineMs: SCAN_DEADLINE_MS,
      })
      return { ok: false, reason: 'unreadable', detail: `the inbox did not finish loading within ${SCAN_DEADLINE_MS / 60000} minutes` }
    }
    if (err instanceof CheckpointError) {
      return { ok: false, reason: 'checkpoint', detail: err.message }
    }
    log.warn('inbox scan failed — nothing recorded from it', {
      sender: senderHandle,
      error: err instanceof Error ? err.message : String(err),
    })
    return { ok: false, reason: 'unreadable', detail: err instanceof Error ? err.message : String(err) }
  } finally {
    clearTimeout(deadline)
    await context.close().catch(() => {}) // closing is what flushes cookies to disk
  }
}
