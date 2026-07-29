import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { chromium } from 'playwright'
import { prisma } from '@/lib/db'
import { env } from '@/lib/env'
import { log } from '@/lib/logger'

/**
 * Verify each saved session is still logged in, and confirm the DM composer is
 * reachable.
 *
 *   pnpm session:check
 *   pnpm session:check --sender=bollywood_society
 *
 * Two reasons this exists:
 *
 *  1. Sessions expire silently. Without this, the first symptom is a failed send
 *     at 20:00 on a day you were counting on.
 *
 *  2. PlaywrightSender's DM selectors were written against documented structure,
 *     not a live logged-in page — Instagram's DM UI is unreachable logged out.
 *     This is where they get validated. Run it against a throwaway account
 *     before enabling autopilot on an account that matters.
 *
 * It never sends anything. It opens the composer, confirms it is focusable, and
 * closes the browser.
 */

async function main() {
  const only = process.argv.find((a) => a.startsWith('--sender='))?.split('=')[1]?.trim()

  const senders = await prisma.senderAccount.findMany({
    where: only ? { handle: only } : {},
    include: { pairs: { include: { target: true } } },
    orderBy: { handle: 'asc' },
  })

  if (senders.length === 0) {
    log.error(only ? `no sender @${only}` : 'no senders in the database')
    await prisma.$disconnect()
    process.exit(1)
  }

  let failures = 0

  for (const sender of senders) {
    const label = `@${sender.handle}`

    if (!sender.sessionPath) {
      console.log(`  ${label.padEnd(26)} ✗  no session    → pnpm session:add --sender=${sender.handle}`)
      failures += 1
      continue
    }

    const path = resolve(process.cwd(), sender.sessionPath)
    if (!existsSync(path)) {
      console.log(`  ${label.padEnd(26)} ✗  file missing  (${sender.sessionPath})`)
      failures += 1
      continue
    }

    const browser = await chromium.launch({ headless: env.HEADLESS })
    try {
      const context = await browser.newContext({ storageState: path, locale: 'en-US' })
      const page = await context.newPage()

      await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded', timeout: 45_000 })

      if (page.url().includes('/accounts/login')) {
        console.log(`  ${label.padEnd(26)} ✗  expired       → pnpm session:add --sender=${sender.handle}`)
        failures += 1
        await context.close()
        continue
      }

      const body = ((await page.textContent('body').catch(() => '')) ?? '').toLowerCase()
      if (body.includes('challenge') || body.includes('suspicious login') || page.url().includes('/challenge/')) {
        console.log(`  ${label.padEnd(26)} ✗  CHALLENGED    → log in by hand and clear it`)
        await prisma.senderAccount.update({ where: { id: sender.id }, data: { status: 'CHALLENGED' } })
        failures += 1
        await context.close()
        continue
      }

      // Probe the DM composer against a real target, without sending.
      const target = sender.pairs[0]?.target.handle
      let composerNote = 'no routed target to probe'
      if (target) {
        composerNote = await probeComposer(page, target)
      }

      console.log(`  ${label.padEnd(26)} ✓  logged in     ${composerNote}`)
      await context.close()
    } catch (err) {
      console.log(`  ${label.padEnd(26)} ✗  error: ${err instanceof Error ? err.message.slice(0, 70) : String(err)}`)
      failures += 1
    } finally {
      await browser.close().catch(() => undefined)
    }
  }

  console.log(`\n  ${senders.length - failures}/${senders.length} sessions healthy\n`)
  await prisma.$disconnect()
  process.exit(failures > 0 ? 1 : 0)
}

/** Open a thread and confirm the composer is present. Types nothing, sends nothing. */
async function probeComposer(
  page: Awaited<ReturnType<Awaited<ReturnType<typeof chromium.launch>>['newPage']>>,
  targetHandle: string,
): Promise<string> {
  try {
    await page.goto(`https://www.instagram.com/${targetHandle}/`, {
      waitUntil: 'domcontentloaded',
      timeout: 30_000,
    })

    const messageButton = page
      .getByRole('button', { name: /^message$/i })
      .or(page.getByRole('link', { name: /^message$/i }))
      .or(page.locator('div[role="button"]:has-text("Message")'))
      .first()

    await messageButton.waitFor({ state: 'visible', timeout: 15_000 })
    await messageButton.click()

    const composer = page
      .getByRole('textbox', { name: /message/i })
      .or(page.locator('div[contenteditable="true"][role="textbox"]'))
      .or(page.locator('textarea[placeholder*="Message" i]'))
      .first()

    await composer.waitFor({ state: 'visible', timeout: 20_000 })
    return `· composer OK for @${targetHandle}`
  } catch (err) {
    return `· ⚠ composer NOT reachable for @${targetHandle} (${err instanceof Error ? err.message.slice(0, 40) : 'unknown'}) — PlaywrightSender selectors need updating`
  }
}

main().catch(async (err) => {
  log.error('session check failed', { error: err instanceof Error ? err.message : String(err) })
  await prisma.$disconnect().catch(() => undefined)
  process.exit(1)
})
