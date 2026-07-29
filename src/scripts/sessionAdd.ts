import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { chromium } from 'playwright'
import { prisma } from '@/lib/db'
import { log } from '@/lib/logger'

/**
 * Capture a logged-in Instagram session for one of OUR sender accounts.
 *
 *   pnpm session:add --sender=bollywood_society
 *
 * This is the only place credentials are involved, and they are never involved
 * with this code: a real Chromium window opens, the operator logs in themselves,
 * and Playwright saves the resulting cookies to sessions/<handle>.json.
 *
 * Consequences of that design, which is why it is done this way:
 *   - No password is ever typed into, stored by, or committed with this project.
 *   - 2FA, SMS codes and "was this you?" checkpoints all just work, because a
 *     human is driving a real browser.
 *   - sessions/ is gitignored, so the repository stays safe to push publicly.
 *
 * Sessions last weeks. Re-run this when `pnpm session:check` reports one expired.
 */

const SESSIONS_DIR = resolve(process.cwd(), 'sessions')

async function main() {
  const arg = process.argv.find((a) => a.startsWith('--sender='))
  const handle = arg?.split('=')[1]?.trim()

  if (!handle) {
    const senders = await prisma.senderAccount.findMany({ orderBy: { handle: 'asc' } })
    console.log('\n  Usage: pnpm session:add --sender=<handle>\n')
    console.log('  Known senders:')
    for (const s of senders) {
      console.log(`    ${s.handle.padEnd(24)} ${s.sessionPath ? 'session saved' : 'no session'}`)
    }
    console.log()
    await prisma.$disconnect()
    process.exit(1)
  }

  const sender = await prisma.senderAccount.findUnique({ where: { handle } })
  if (!sender) {
    log.error(`no sender @${handle} in the database`, { hint: 'check /senders or run pnpm db:seed' })
    await prisma.$disconnect()
    process.exit(1)
  }

  mkdirSync(SESSIONS_DIR, { recursive: true })
  const sessionPath = resolve(SESSIONS_DIR, `${handle}.json`)

  console.log(`
  ────────────────────────────────────────────────────────────────
   Capturing a session for @${handle}

   A Chromium window will open on instagram.com.

   1. Log in AS @${handle} yourself. Complete 2FA if prompted.
   2. Wait until you can see your feed or profile.
   3. Come back here and press Enter.

   Nothing you type in that window passes through this program.
   Only the resulting cookies are saved, to:
     sessions/${handle}.json   (gitignored)
  ────────────────────────────────────────────────────────────────
`)

  // Headed, always — the entire point is that a human drives it.
  const browser = await chromium.launch({ headless: false })
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    locale: 'en-US',
  })
  const page = await context.newPage()
  await page.goto('https://www.instagram.com/accounts/login/', { waitUntil: 'domcontentloaded' })

  await waitForEnter('  Press Enter once you are logged in… ')

  // Verify rather than trust: a saved "session" that is not logged in would fail
  // silently at the first send attempt.
  await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded' })
  const url = page.url()
  if (url.includes('/accounts/login')) {
    log.error('still on the login page — nothing was saved')
    await browser.close()
    await prisma.$disconnect()
    process.exit(1)
  }

  const cookies = await context.cookies()
  const hasAuth = cookies.some((c) => c.name === 'sessionid' && c.value.length > 0)
  if (!hasAuth) {
    log.error('no Instagram sessionid cookie found — login did not complete. Nothing was saved.')
    await browser.close()
    await prisma.$disconnect()
    process.exit(1)
  }

  await context.storageState({ path: sessionPath })
  await browser.close()

  await prisma.senderAccount.update({
    where: { id: sender.id },
    data: { sessionPath: `sessions/${handle}.json`, sessionSavedAt: new Date() },
  })
  await prisma.auditLog.create({
    data: { actor: 'operator', action: 'session.saved', entity: `SenderAccount:${sender.id}`, detail: handle },
  })

  console.log(`
  ✓ Session saved for @${handle}

    ${cookies.length} cookies written to sessions/${handle}.json
    Verify any time with:  pnpm session:check
`)

  await prisma.$disconnect()
}

function waitForEnter(prompt: string): Promise<void> {
  return new Promise((done) => {
    process.stdout.write(prompt)
    process.stdin.resume()
    process.stdin.once('data', () => {
      process.stdin.pause()
      done()
    })
  })
}

main().catch(async (err) => {
  log.error('session capture failed', { error: err instanceof Error ? err.message : String(err) })
  await prisma.$disconnect().catch(() => undefined)
  process.exit(1)
})
