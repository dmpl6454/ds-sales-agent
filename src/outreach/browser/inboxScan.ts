import type { Page } from 'patchright'
import { log } from '@/lib/logger'
import { launchProfile, assertLoggedInAs, assertNoCheckpoint, CheckpointError } from './session'
import { browseBriefly } from './readThread'
import { firstVisible, jitter, dismissBlockingDialog } from './messageEntry'

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
    const out: { title: string; texts: string[] }[] = []
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
        out.push({ title, texts })
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
    rows.push({ displayName: r.title, snippet, ageText, unread, folder })
  }
  return rows
}

/**
 * Open this sender's inbox and read every visible conversation row, Primary AND the
 * "Partnership messages" folder — business recipients answered via "Send message
 * request" file there, which is where the probe found a live buyer conversation the
 * sweep had never seen.
 */
export async function scanInbox(senderHandle: string): Promise<InboxScanResult> {
  const context = await launchProfile(senderHandle)
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

    /* The partnership folder, when the account has one. Its absence is ordinary. */
    const folder = page.locator('div[role="button"]', { hasText: /partnership messages/i }).first()
    if ((await folder.count()) > 0) {
      await folder.scrollIntoViewIfNeeded().catch(() => {})
      await jitter(400, 900)
      await folder.click().catch(() => {})
      await jitter(2500, 4000)
      assertNoCheckpoint(page, senderHandle)
      if (page.url().includes('/direct/partnerships')) {
        rows.push(...(await collectRows(page, 'partnership')))
      }
    }

    if (rows.length === 0) {
      /* An empty inbox and an unreadable one are different facts; a sender with 600
         delivered messages cannot have an empty list, so say "unreadable", not "quiet". */
      return { ok: false, reason: 'unreadable', detail: 'no conversation rows matched — the inbox DOM may have drifted' }
    }
    return { ok: true, rows }
  } catch (err) {
    if (err instanceof CheckpointError) {
      return { ok: false, reason: 'checkpoint', detail: err.message }
    }
    log.warn('inbox scan failed — nothing recorded from it', {
      sender: senderHandle,
      error: err instanceof Error ? err.message : String(err),
    })
    return { ok: false, reason: 'unreadable', detail: err instanceof Error ? err.message : String(err) }
  } finally {
    await context.close() // closing is what flushes cookies to disk
  }
}
