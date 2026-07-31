import type { Locator, Page } from 'patchright'
import { prisma } from '@/lib/db'
import { profileUrl } from '@/lib/urls'
import { istStamp } from '@/lib/time'
import { matchesAnyOfOurs, normalise } from '@/outreach/matching'
import { assertLoggedInAs, assertNoCheckpoint, launchProfile } from '@/outreach/browser/session'

/**
 *   pnpm ig:thread <sender> <target>
 *   pnpm ig:thread <sender> <target> --record-reply
 *
 * Opens the real conversation and reads it back, so a send can be confirmed against
 * Instagram rather than against our own log.
 *
 * WHY A SEPARATE READ IS WORTH IT
 *
 * `sendDm` already confirms delivery three ways — the composer read-back before
 * Enter, the composer clearing after it, and our text being present in the thread.
 * That is genuinely strong. But all three observe the same page in the same session
 * moments after pressing Enter, and a web app can render a message optimistically
 * before the server has accepted it. A fresh navigation gets the thread as Instagram
 * actually stores it, which is a different and better claim.
 *
 * This is deliberately read-only about sending. It never composes, never types into
 * the composer, never presses Enter.
 *
 * WHY IT DOUBLES AS REPLY DETECTION
 *
 * Reading a thread is exactly what detecting a reply requires, and until now nothing
 * could write `OutreachAttempt.repliedAt` at all — the governor's hardest stop, the
 * one that halts every sender to a target the moment a human answers, had never been
 * able to fire. `--record-reply` closes that: if the thread holds a message that is
 * not one of ours, the reply is recorded and outreach to that target halts.
 *
 * The test for "theirs" is deliberately conservative: a message counts as a reply
 * only if it matches NONE of the bodies we have ever sent this target. A false
 * negative costs a follow-up; a false positive would silently halt a live campaign,
 * so ambiguity resolves toward "not a reply".
 *
 * NAVIGATION IS THE SAME AS SENDING, FOR THE SAME REASON
 *
 * feed -> profile -> Message. Never `/direct/t/<id>` directly: arriving at a thread
 * with no referring page is a shape ordinary use does not produce, and this runs
 * against the same accounts the send path protects.
 */

function jitter(minMs: number, maxMs: number): Promise<void> {
  const ms = minMs + Math.floor(Math.random() * (maxMs - minMs))
  return new Promise((r) => setTimeout(r, ms))
}

async function firstVisible(page: Page, candidates: Locator[], timeoutMs: number): Promise<Locator | null> {
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

async function browseBriefly(page: Page): Promise<void> {
  for (let i = 0; i < 2 + Math.floor(Math.random() * 2); i++) {
    await page.mouse.wheel(0, 220 + Math.floor(Math.random() * 380))
    await jitter(500, 1400)
  }
}

interface ThreadMessage {
  text: string
  /** True when this matches something we sent. */
  ours: boolean
}

/**
 * Pulls the message rows out of the open thread.
 *
 * Instagram gives each message bubble `role="row"` inside the conversation's
 * `role="grid"`. That is markedly more stable than class names, but it is still
 * Instagram's DOM, so an empty result is reported as "could not read" rather than
 * as "the thread is empty" — the difference matters when the caller is deciding
 * whether a message was delivered.
 */
/**
 * Reads the message bubbles out of the open thread.
 *
 * Measured against the live DOM on 2026-07-31, a bubble's text sits at:
 *
 *   div[dir=auto] < span[dir=auto] < div[role=presentation] < … < div[role=none]
 *
 * There is no `role="grid"` and no `role="row"` — the obvious guesses, and both
 * absent. So the shape here is observed, not assumed, and it will drift.
 *
 * WHY IT ANCHORS ON THE COMPOSER
 *
 * `div[role="presentation"]` and `div[dir="auto"]` both occur elsewhere on a profile
 * page, so collecting them document-wide would sweep up page furniture and classify
 * it as "not ours" — i.e. as a reply. A false reply silently halts every sender to
 * that target, so that direction of error is the expensive one and must be designed
 * against, not hoped about.
 *
 * The composer is the one element guaranteed to be inside the conversation and
 * nowhere else, so the thread panel is found by walking up from it. Anything outside
 * that subtree is not a message, by construction.
 */
async function readMessages(page: Page, ourBodies: readonly string[]): Promise<ThreadMessage[] | null> {
  // The composer must exist, or the thread never opened and there is nothing to read.
  const composer = await firstVisible(
    page,
    [
      page.getByRole('textbox', { name: /message/i }),
      page.locator('div[contenteditable="true"][role="textbox"]'),
    ],
    20_000,
  )
  if (!composer) return null

  // Read-only DOM traversal. The prohibition on `evaluate` in this codebase concerns
  // synthesised INPUT events, which lack `isTrusted`; reading has no such issue.
  const texts = await page.evaluate(() => {
    const box =
      document.querySelector('div[contenteditable="true"][role="textbox"]') ??
      document.querySelector('div[role="textbox"]')
    if (!box) return null

    // Walk up until the subtree holds clearly more than just the composer. The
    // conversation panel is a handful of levels above; the cap stops a runaway walk
    // reaching <body> and re-admitting the whole page.
    let panel: Element | null = box.parentElement
    for (let i = 0; i < 12 && panel; i++) {
      const bubbles = panel.querySelectorAll('div[role="presentation"] div[dir="auto"], div[role="row"]')
      if (bubbles.length > 0) break
      panel = panel.parentElement
    }
    if (!panel) return null

    const seen = new Set<string>()
    const out: string[] = []
    for (const el of panel.querySelectorAll('div[role="presentation"] div[dir="auto"], div[role="row"]')) {
      // The composer's own contents are not a message in the thread.
      if (box.contains(el) || el.contains(box)) continue
      const t = (el.textContent ?? '').trim()
      if (t.length === 0 || seen.has(t)) continue
      seen.add(t)
      out.push(t)
    }
    return out
  })

  if (texts === null || texts.length === 0) return null

  return texts
    .filter((t) => normalise(t).length > 0)
    .map((text) => ({ text, ours: matchesAnyOfOurs(text, ourBodies) }))
}

/**
 * What the page actually contains, for when none of the row shapes match.
 *
 * Printed rather than guessed at: the alternative is another round of inventing
 * selectors, and Instagram's markup is not something to reason about from memory.
 */
async function describeDom(page: Page, ourBodies: readonly string[]): Promise<void> {
  console.log('\n  --debug: what the page contains\n')
  console.log(`  url: ${page.url()}`)

  const bodyText = (await page.locator('body').textContent().catch(() => '')) ?? ''
  console.log(`  body text length: ${bodyText.length}`)
  console.log(`  our message present in body text: ${matchesAnyOfOurs(bodyText, ourBodies) ? 'YES' : 'no'}`)

  for (const sel of [
    'div[role="grid"]',
    'div[role="row"]',
    'div[role="listitem"]',
    'div[role="textbox"]',
    'div[data-scope="messages_table"]',
    'div[aria-label*="essage" i]',
    'div[dir="auto"]',
  ]) {
    const n = await page.locator(sel).count().catch(() => -1)
    console.log(`  ${String(n).padStart(5)}  ${sel}`)
  }

  /**
   * Where does our text actually live?
   *
   * `body.textContent()` includes <script> contents, so "our message is in the body
   * text" can be satisfied by an embedded JSON payload rather than by a rendered
   * message bubble. That is the same shape of mistake as the old post-send guard that
   * read the whole page and therefore could not fail — so locate the real element
   * and print its ancestry instead of trusting the substring.
   *
   * `page.evaluate` is used to READ. The rule against `evaluate` in this codebase is
   * about synthesising input events, which lack `isTrusted`; reading the DOM carries
   * no such problem.
   */
  const probe = ourBodies[0]?.split('\n').map((l) => l.trim()).filter((l) => l.length > 40)[0]
  if (!probe) {
    console.log('\n  no sufficiently distinctive line to probe with\n')
    return
  }
  console.log(`\n  probing for: "${probe.slice(0, 60)}…"\n`)

  const hits = await page.evaluate((needle: string) => {
    const out: string[] = []
    const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    let node: Node | null
    while ((node = walk.nextNode())) {
      if (!node.textContent?.includes(needle)) continue
      const el = node.parentElement
      if (!el) continue
      if (el.closest('script,style')) {
        out.push('(inside <script> or <style> — NOT rendered content)')
        continue
      }
      const chain: string[] = []
      for (let e: Element | null = el, i = 0; e && i < 6; e = e.parentElement, i++) {
        const role = e.getAttribute('role')
        const label = e.getAttribute('aria-label')
        const dir = e.getAttribute('dir')
        chain.push(
          `${e.tagName.toLowerCase()}` +
            `${role ? `[role=${role}]` : ''}` +
            `${dir ? `[dir=${dir}]` : ''}` +
            `${label ? `[aria-label="${label.slice(0, 30)}"]` : ''}`,
        )
      }
      out.push(chain.join(' < '))
    }
    return out
  }, probe)

  if (hits.length === 0) console.log('  our text was NOT found in any text node (so the body match was scripts)\n')
  for (const h of hits.slice(0, 6)) console.log(`  ${h}`)
  console.log('')
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const recordReply = argv.includes('--record-reply')
  const debug = argv.includes('--debug')
  const [sender, target] = argv.filter((a) => !a.startsWith('--')).map((a) => a.replace(/^@/, ''))

  if (!sender || !target) {
    console.log('\n  Usage: pnpm ig:thread <sender> <target> [--record-reply]\n')
    process.exitCode = 1
    await prisma.$disconnect()
    return
  }

  const pair = await prisma.outreachPair.findFirst({
    where: { sender: { handle: sender }, target: { handle: target } },
    include: { sender: true, target: true, attempts: true },
  })
  if (!pair) {
    console.log(`\n  No routing pair @${sender} → @${target}.\n`)
    process.exitCode = 1
    await prisma.$disconnect()
    return
  }

  // Everything we have ever put in this thread, so "not ours" is a real distinction.
  // Every sender to this target counts: a reply belongs to the conversation, not to
  // one pair, and the governor halts all of them together.
  const ourBodies = (
    await prisma.outreachAttempt.findMany({
      where: { pair: { targetId: pair.targetId }, status: { in: ['SENT', 'REPLIED'] } },
      select: { renderedBody: true },
    })
  ).map((a) => a.renderedBody)

  console.log(`\n  Opening @${sender} → @${target} …`)
  const context = await launchProfile(sender)
  try {
    const page = context.pages()[0] ?? (await context.newPage())

    await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded', timeout: 60_000 })
    assertNoCheckpoint(page, sender)
    await assertLoggedInAs(page, sender)
    await browseBriefly(page)

    await page.goto(profileUrl(target), { waitUntil: 'domcontentloaded', timeout: 60_000 })
    assertNoCheckpoint(page, sender)
    await jitter(1500, 3200)

    const messageBtn = await firstVisible(
      page,
      [
        page.getByRole('button', { name: /^message$/i }),
        page.locator('div[role="button"]', { hasText: /^Message$/ }),
      ],
      15_000,
    )
    if (!messageBtn) {
      console.log('\n  Could not find the Message button — cannot open the thread.\n')
      process.exitCode = 1
      return
    }
    await messageBtn.hover()
    await jitter(300, 900)
    await messageBtn.click()
    await jitter(2000, 3500)
    assertNoCheckpoint(page, sender)

    const messages = await readMessages(page, ourBodies)
    if (messages === null) {
      console.log(`\n  Could not read the thread. This is NOT the same as "empty" —`)
      console.log(`  Instagram's layout may have changed. Check by hand.`)
      if (debug) await describeDom(page, ourBodies)
      else console.log(`  Re-run with --debug to see what the page actually contains.\n`)
      process.exitCode = 1
      return
    }

    const url = page.url()
    console.log(`\n  ${messages.length} message(s) in the thread`)
    console.log(`  ${url.includes('/direct/t/') ? url : '(thread opened over the profile; no /direct/t/ URL)'}\n`)

    for (const m of messages) {
      const who = m.ours ? 'US ' : 'THEM'
      const oneLine = m.text.replace(/\s+/g, ' ').slice(0, 150)
      console.log(`  [${who}] ${oneLine}${m.text.length > 150 ? '…' : ''}`)
    }

    const theirs = messages.filter((m) => !m.ours)
    console.log('')

    if (theirs.length === 0) {
      console.log(`  No reply from @${target} visible in the thread.\n`)
      return
    }

    console.log(`  ${theirs.length} message(s) in this thread are not ours — @${target} has replied.`)

    if (!recordReply) {
      console.log(`  Re-run with --record-reply to halt outreach to @${target}.\n`)
      return
    }

    const latest = await prisma.outreachAttempt.findFirst({
      where: { pairId: pair.id, status: { in: ['SENT', 'REPLIED'] } },
      orderBy: { sentAt: 'desc' },
    })
    if (!latest) {
      console.log(`  Nothing delivered on this pair, so there is no message to attach a reply to.\n`)
      return
    }
    if (latest.repliedAt) {
      console.log(`  Already recorded (${istStamp(latest.repliedAt)}). Nothing to do.\n`)
      return
    }

    // The thread does not expose a machine-readable timestamp per bubble without
    // more scraping than this is worth, so the recorded time is "when we observed
    // it". `pnpm ig:reply <sender> <target> --at <ISO>` corrects it if the real
    // time is known. Recording an approximate time is far better than leaving the
    // guard unable to fire, which is where this started.
    const at = new Date()
    await prisma.$transaction([
      prisma.outreachAttempt.update({ where: { id: latest.id }, data: { repliedAt: at, status: 'REPLIED' } }),
      prisma.auditLog.create({
        data: {
          actor: 'ig:thread',
          action: 'reply.record',
          entity: `OutreachAttempt:${latest.id}`,
          detail: `@${target} replied (observed in thread at ${at.toISOString()}; time is observation, not the reply itself)`,
        },
      }),
    ])
    console.log(`  Recorded. Outreach to @${target} is now halted for every sender.`)
    console.log(`  Correct the time with: pnpm ig:reply ${sender} ${target} --at <ISO>\n`)
  } finally {
    await jitter(1000, 2000)
    await context.close()
    await prisma.$disconnect()
  }
}

main().catch(async (err) => {
  console.error(`\n  ${err instanceof Error ? err.message : String(err)}\n`)
  await prisma.$disconnect()
  process.exitCode = 1
})
