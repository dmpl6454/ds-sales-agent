/**
 * WHAT DOES INSTAGRAM'S CONVERSATION PAGE CONTAIN, SECOND BY SECOND? — a read-only capture.
 *
 *   pnpm exec tsx scripts/capture-dm-dom.ts <sender> <target> [--shots]   the conversation
 *   pnpm exec tsx scripts/capture-dm-dom.ts <sender> --inbox [--shots]    the inbox list
 *
 * --shots saves screenshots at 1 s, 3 s and 16 s to /tmp/ds-capture-*.png (the business's own
 * inbox — look at them, share them only if you choose to).
 *
 * WHY IT EXISTS (15 Nov). The sending Mac's agent has filed ~200 conversation reads a day
 * `unreadable` since at least 27 Oct, and every inbox scan of two pages "no conversation rows
 * matched". So every follow-up that earned material was parked and no reply was seen. But the
 * SAME read run by hand (`pnpm ig:thread totalfilmii zenofar_fathima`) found the message ten
 * minutes after the agent failed on it — same account, same pair, same `collectMessages`. The
 * display never sleeps on that Mac, so the difference left is TIMING: the CLI starts watching
 * the conversation immediately after clicking Message, while the agent first waits for the
 * business-messaging button and the message-request Accept button (`firstVisible` up to 4 s
 * each) and only then installs its observer. In August Instagram was measured restructuring
 * the thread ~2.5 s after it opened, leaving one matching bubble; if it now leaves none, the
 * agent always arrives after the only moment the bubbles match.
 *
 * This prints, at fixed times after the click, how many nodes each selector the reader relies
 * on matches, and at the end WHERE our own message's text sits in the settled page (the chain
 * of tag/role/dir/aria-label above it). That is what a selector fix is written from.
 *
 * WHAT THE FIRST RUN SHOWED (15 Nov, the Mac Studio). It is not a selector drift. The thread's
 * one message matched the reader at 2 s after the click and was GONE from the page by 3 s — its
 * text no longer anywhere in the DOM at 16 s, the composer still present. The inbox list rendered
 * 15 conversations at 1 s and collapsed to 3 elements by 2 s. Instagram loads the messages and
 * then removes them, so the second run also records WHY: the visible text of the page (a prompt
 * or an error banner a count cannot show), the console errors, failed requests and WebSocket
 * closes during the sampling, the window size, and — with --shots — screenshots to /tmp.
 *
 * READ-ONLY. It opens the account's own Chrome profile the way every read does (launchProfile),
 * clicks Message (or opens the inbox) and LOOKS. It types nothing, accepts nothing, dismisses
 * nothing, and writes nothing to the database. It does not take the send lock: if the agent is
 * using the profile at that moment, Chrome refuses the second launch and this exits — run it
 * again a minute later. It prints up to 60 characters of conversation text, which is the
 * business's own inbox.
 */
import type { Page } from 'patchright'
import { launchProfile, assertLoggedInAs, assertNoCheckpoint } from '@/outreach/browser/session'
import { profileUrl } from '@/lib/urls'

const SAMPLE_AT_MS = [300, 1_000, 2_000, 3_000, 4_000, 6_000, 8_000, 10_000, 13_000, 16_000]
/** Text that is in every standard first message (the single template) — where it sits is the answer. */
const DEFAULT_NEEDLE = 'Entertainment & Pop Culture Media Network'

/** The selectors the September reader and inbox scan rely on, plus neighbours worth knowing about. */
export const THREAD_PROBE = `(() => {
  const SEL = 'div[role="presentation"] div[dir="auto"], div[role="row"]'
  const composer = document.querySelector('div[contenteditable="true"][role="textbox"]') ?? document.querySelector('div[role="textbox"]')
  let panel = composer
  let panelMatches = 0
  while (panel && panel !== document.body) {
    const n = panel.querySelectorAll(SEL).length
    if (n > 0) { panelMatches = n; break }
    panel = panel.parentElement
  }
  const count = (s) => document.querySelectorAll(s).length
  return {
    path: location.pathname,
    visible: document.visibilityState,
    composer: composer ? 'yes' : 'no',
    readerMatches: panelMatches,
    'presentation>dir=auto': count('div[role="presentation"] div[dir="auto"]'),
    'role=row': count('div[role="row"]'),
    'div[dir=auto]': count('div[dir="auto"]'),
    'span[dir=auto]': count('span[dir="auto"]'),
    'role=grid': count('[role="grid"]'),
    'role=gridcell': count('[role="gridcell"]'),
    'role=dialog': count('[role="dialog"]'),
    'role=listitem': count('[role="listitem"]'),
  }
})()`

export const INBOX_PROBE = `(() => {
  const count = (s) => document.querySelectorAll(s).length
  const rows = [...document.querySelectorAll('div[role="button"][tabindex]')]
  return {
    path: location.pathname,
    visible: document.visibilityState,
    'button[tabindex]': rows.length,
    'with span[title]': rows.filter((r) => r.querySelector('span[title]')).length,
    'a[href*=/direct/t/]': count('a[href*="/direct/t/"]'),
    'role=listitem': count('[role="listitem"]'),
    'role=row': count('[role="row"]'),
    'role=gridcell': count('[role="gridcell"]'),
    'img[alt]': count('img[alt]'),
  }
})()`

/** The window, and what a person would read on the page (a prompt or banner shows up here). */
export const PAGE_TEXT_PROBE = `(() => {
  const root = document.querySelector('[role="main"]') || document.body
  return {
    window: window.innerWidth + 'x' + window.innerHeight,
    text: (root.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 1500),
    bodyText: root === document.body ? '' : (document.body.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 600),
  }
})()`

/** Where a piece of text sits: the innermost element containing it, and the chain above it. */
export function locateProbe(needle: string): string {
  return `(() => {
    const needle = ${JSON.stringify(needle)}
    const describe = (el) => {
      const a = (k) => el.getAttribute(k)
      const bits = [el.tagName.toLowerCase()]
      for (const k of ['role', 'dir', 'aria-label', 'tabindex', 'title', 'data-scope', 'data-testid']) {
        const v = a(k)
        if (v !== null) bits.push(k + '=' + JSON.stringify(v.slice(0, 40)))
      }
      return bits.join(' ')
    }
    const hits = []
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    for (let t = walker.nextNode(); t && hits.length < 3; t = walker.nextNode()) {
      if ((t.textContent || '').includes(needle) && t.parentElement) hits.push(t.parentElement)
    }
    return hits.map((el) => {
      const chain = []
      for (let e = el, i = 0; e && e !== document.body && i < 16; e = e.parentElement, i++) chain.push(describe(e))
      return chain
    })
  })()`
}

/** Short rows for the inbox: what each clickable thing that holds an avatar looks like. */
export const INBOX_ROWS_PROBE = `(() => {
  const out = []
  for (const img of document.querySelectorAll('img[alt]')) {
    const row = img.closest('[role="button"], a[href], [role="listitem"], [role="row"], [role="gridcell"]')
    if (!row || out.some((o) => o.el === row)) continue
    out.push({ el: row })
    if (out.length >= 6) break
  }
  return out.map(({ el }) => ({
    tag: el.tagName.toLowerCase(),
    role: el.getAttribute('role'),
    href: (el.getAttribute('href') || '').slice(0, 30),
    tabindex: el.getAttribute('tabindex'),
    hasSpanTitle: !!el.querySelector('span[title]'),
    text: (el.innerText || '').replace(/\\s+/g, ' ').slice(0, 60),
  }))
})()`

function printTable(rows: { atMs: number; probe: Record<string, unknown> }[]): void {
  if (rows.length === 0) return
  const cols = ['at', ...Object.keys(rows[0]!.probe)]
  const cells = rows.map((r) => [`${(r.atMs / 1000).toFixed(1)}s`, ...Object.values(r.probe).map((v) => String(v))])
  const w = cols.map((c, i) => Math.max(c.length, ...cells.map((r) => r[i]!.length)))
  console.log('  ' + cols.map((c, i) => c.padEnd(w[i]!)).join(' | '))
  for (const r of cells) console.log('  ' + r.map((c, i) => c.padEnd(w[i]!)).join(' | '))
}

/** A URL with no query string or fragment — they can carry tokens, and the path is what matters here. */
export function bareUrl(u: string): string {
  try {
    const x = new URL(u)
    return (x.origin + x.pathname).slice(0, 110)
  } catch {
    return u.split(/[?#]/)[0]!.slice(0, 110)
  }
}

/** Console errors, page errors, failed requests and WebSocket closes while the sampling runs. */
export function recordEvents(page: Page): string[] {
  const events: string[] = []
  const started = Date.now()
  const at = () => `${((Date.now() - started) / 1000).toFixed(1)}s`
  const push = (line: string) => {
    if (events.length < 40) events.push(`${at()} ${line}`)
  }
  // Patchright suppresses Runtime.enable (it is a detection signal), so the PAGE's own console.log
  // and uncaught errors mostly never arrive here; the browser's own messages (failed loads, socket
  // errors) do. URLs inside them lose their query strings for the same reason as bareUrl.
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') {
      const text = m.text().replace(/(?:https?|wss?):\/\/[^\s'"]+/g, (u) => bareUrl(u)).replace(/\s+/g, ' ')
      push(`console.${m.type()}: ${text.slice(0, 160)}`)
    }
  })
  page.on('pageerror', (e) => push(`page error: ${e.message.replace(/\s+/g, ' ').slice(0, 160)}`))
  page.on('requestfailed', (r) => push(`request failed: ${r.method()} ${bareUrl(r.url())} — ${r.failure()?.errorText ?? '?'}`))
  page.on('response', (r) => {
    if (r.status() >= 400) push(`HTTP ${r.status()}: ${r.request().method()} ${bareUrl(r.url())}`)
  })
  page.on('websocket', (ws) => {
    push(`websocket opened: ${bareUrl(ws.url())}`)
    ws.on('close', () => push(`websocket closed: ${bareUrl(ws.url())}`))
    ws.on('socketerror', (err) => push(`websocket error: ${bareUrl(ws.url())} — ${String(err).slice(0, 80)}`))
  })
  return events
}

const SHOT_AT_MS = new Set([1_000, 3_000, 16_000])

async function sampleOverTime(
  page: Page,
  probe: string,
  shots: { prefix: string } | null,
): Promise<{ atMs: number; probe: Record<string, unknown> }[]> {
  const started = Date.now()
  const out: { atMs: number; probe: Record<string, unknown> }[] = []
  for (const at of SAMPLE_AT_MS) {
    const wait = at - (Date.now() - started)
    if (wait > 0) await page.waitForTimeout(wait)
    const probeResult = (await page.evaluate(probe).catch((e: Error) => ({ error: e.message.slice(0, 80) }))) as Record<string, unknown>
    out.push({ atMs: Date.now() - started, probe: probeResult })
    if (shots && SHOT_AT_MS.has(at)) {
      const file = `/tmp/${shots.prefix}-${String(at / 1000).padStart(2, '0')}s.png`
      await page.screenshot({ path: file }).then(() => console.log(`  screenshot saved: ${file}`)).catch(() => undefined)
    }
  }
  return out
}

async function printAfter(page: Page, events: string[]): Promise<void> {
  const t = (await page.evaluate(PAGE_TEXT_PROBE).catch(() => null)) as { window: string; text: string; bodyText: string } | null
  if (t) {
    console.log(`\n  window ${t.window}; what the page says at the end (up to 1500 characters):`)
    console.log('    ' + (t.text || '(no text)'))
    if (t.bodyText) console.log('  and outside the main area: ' + t.bodyText)
  }
  console.log(`\n  errors, failed requests and connections while sampling (${events.length}${events.length >= 40 ? ', first 40' : ''}):`)
  if (events.length === 0) console.log('    (none)')
  for (const e of events) console.log('    ' + e)
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const inbox = argv.includes('--inbox')
  const wantShots = argv.includes('--shots')
  const needleAt = argv.indexOf('--needle')
  const needle = needleAt >= 0 && argv[needleAt + 1] ? argv[needleAt + 1]! : DEFAULT_NEEDLE
  const [sender, target] = argv.filter((a, i) => !a.startsWith('--') && (needleAt < 0 || i !== needleAt + 1))
  if (!sender || (!inbox && !target)) {
    console.log('\n  Usage: pnpm exec tsx scripts/capture-dm-dom.ts <sender> <target> [--shots]   |   <sender> --inbox [--shots]\n')
    process.exitCode = 1
    return
  }

  const context = await launchProfile(sender)
  try {
    const page = context.pages()[0] ?? (await context.newPage())
    await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded', timeout: 60_000 })
    assertNoCheckpoint(page, sender)
    await assertLoggedInAs(page, sender)
    await page.waitForTimeout(2_500)

    if (inbox) {
      console.log(`\n  @${sender}: the inbox list, sampled after it opens\n`)
      const events = recordEvents(page)
      await page.goto('https://www.instagram.com/direct/inbox/', { waitUntil: 'domcontentloaded', timeout: 60_000 })
      assertNoCheckpoint(page, sender)
      printTable(await sampleOverTime(page, INBOX_PROBE, wantShots ? { prefix: `ds-capture-inbox-${sender}` } : null))
      await printAfter(page, events)
      console.log('\n  the first rows that hold an avatar (what a row looks like now):')
      for (const r of (await page.evaluate(INBOX_ROWS_PROBE)) as Record<string, unknown>[]) console.log('   ', JSON.stringify(r))
      return
    }

    console.log(`\n  @${sender} → @${target}: the conversation, sampled after clicking Message\n`)
    await page.goto(profileUrl(target!), { waitUntil: 'domcontentloaded', timeout: 60_000 })
    assertNoCheckpoint(page, sender)
    await page.waitForTimeout(2_500)
    const candidates = [
      page.getByRole('button', { name: /^message$/i }),
      page.locator('div[role="button"]', { hasText: /^Message$/ }),
    ]
    let clicked = false
    // Recording starts BEFORE the click: what fails is in the first second or two after it.
    const events = recordEvents(page)
    for (const c of candidates) {
      const first = c.first()
      if (await first.isVisible({ timeout: 5_000 }).catch(() => false)) {
        await first.click()
        clicked = true
        break
      }
    }
    if (!clicked) {
      console.log('  No Message button on the profile — pick a target whose profile shows one.\n')
      process.exitCode = 1
      return
    }
    printTable(await sampleOverTime(page, THREAD_PROBE, wantShots ? { prefix: `ds-capture-thread-${sender}` } : null))
    await printAfter(page, events)
    console.log(`\n  where "${needle}" sits now, innermost element first:`)
    const located = (await page.evaluate(locateProbe(needle))) as string[][]
    if (located.length === 0) console.log('    (not on the page)')
    located.forEach((chain, i) => {
      console.log(`    occurrence ${i + 1}:`)
      for (const link of chain) console.log('      ' + link)
    })
    console.log('')
  } finally {
    await context.close()
  }
}

// Run only when invoked as a script, so the probes can be imported and exercised by a test.
if ((process.argv[1] ?? '').endsWith('capture-dm-dom.ts')) {
  main().catch((e: Error) => {
    console.log('\n  capture failed: ' + e.message + '\n')
    process.exitCode = 1
  })
}
