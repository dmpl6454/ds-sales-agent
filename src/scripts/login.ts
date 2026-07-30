import { createInterface } from 'node:readline/promises'
import { prisma } from '@/lib/db'
import { log } from '@/lib/logger'
import { profileStatus } from '@/outreach/browser/profile'
import { launchProfile, loggedInAs } from '@/outreach/browser/session'

/**
 *   pnpm login <handle>
 *
 * The one-time, by-hand login for a sending account. Run once per account, ever.
 *
 * This script deliberately does very little: it opens the account's own Chrome
 * profile at instagram.com and then waits. YOU type the password. YOU clear any
 * 2FA. Nothing here reads, stores, or transmits a credential — there is no field
 * for one anywhere in this repo.
 *
 * Doing it this way is the entire safety argument for automated sending. A hand
 * login writes durable device identifiers into this profile and records a login
 * event binding this browser to this account, from your home IP. Every later
 * automated send reuses that same profile, so Instagram sees a device it already
 * knows. The alternative — pasting a `sessionid` into a fresh browser — works
 * immediately and is exactly what gets accounts disabled later.
 *
 * After this, `pnpm send` and the dashboard's Send button can drive it unattended.
 */

async function main() {
  const handle = process.argv[2]?.replace(/^@/, '').trim().toLowerCase()

  if (!handle) {
    const senders = await prisma.senderAccount.findMany({ orderBy: { handle: 'asc' } })
    console.log(`\n  Usage:  pnpm login <handle>\n`)
    console.log(`  Your sending accounts:\n`)
    for (const s of senders) {
      const st = profileStatus(s.handle)
      console.log(`    @${s.handle.padEnd(22)} ${st.initialised ? 'profile exists' : 'never logged in'}`)
    }
    console.log()
    await prisma.$disconnect()
    return
  }

  const sender = await prisma.senderAccount.findUnique({ where: { handle } })
  if (!sender) {
    console.log(`\n  @${handle} is not one of your sending accounts. Run \`pnpm login\` to list them.\n`)
    await prisma.$disconnect()
    return
  }

  const st = profileStatus(handle)
  console.log(`
${'═'.repeat(76)}
  ONE-TIME LOGIN — @${handle}
${'═'.repeat(76)}

  Chrome profile:  ${st.dir}
  ${st.initialised ? 'This profile has been used before.' : 'Creating a fresh profile for this account.'}

  A Chrome window will open at instagram.com. Log in BY HAND:

    1. Type the username and password yourself
    2. Complete 2FA if asked
    3. If Instagram offers "Save your login info", accept — that is what
       makes the session persist
    4. Leave the browser open and come back here

  Nothing in this project stores your password. This window is the only place
  it is ever typed, and it is Chrome's own login form.
`)

  const context = await launchProfile(handle)
  const page = context.pages()[0] ?? (await context.newPage())

  try {
    await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded', timeout: 60_000 })

    const already = await loggedInAs(page)
    if (already === handle) {
      console.log(`  ✓ Already logged in as @${already}. Nothing to do.\n`)
      await recordLogin(handle)
      return
    }
    if (already && already !== handle) {
      console.log(`  ⚠ This profile is logged in as @${already}, not @${handle}.`)
      console.log(`    Log out in the browser, then log in as @${handle}.\n`)
    }

    const rl = createInterface({ input: process.stdin, output: process.stdout })
    // Deliberately blocking on a human. Polling for a session and closing the
    // window automatically would race a half-finished 2FA flow.
    await rl.question(`  Press Enter here once you are logged in as @${handle}… `)
    rl.close()

    const who = await loggedInAs(page)
    if (who === handle) {
      console.log(`\n  ✓ Logged in as @${who}. This profile is ready.`)
      console.log(`    Automated sends from @${handle} will reuse this exact profile.\n`)
      await recordLogin(handle)
    } else if (who) {
      console.log(`\n  ✗ Logged in as @${who}, not @${handle}. Nothing recorded.\n`)
    } else {
      console.log(`\n  ✗ Still not logged in. Nothing recorded — run this again.\n`)
    }
  } finally {
    // Closing the context is what flushes cookies and device identifiers to disk.
    await context.close()
    await prisma.$disconnect()
  }
}

/**
 * Records WHEN the hand login happened. Not the session itself — that lives in
 * Chrome's own profile directory, which is the whole point.
 */
async function recordLogin(handle: string) {
  const st = profileStatus(handle)
  await prisma.senderAccount.update({
    where: { handle },
    data: { sessionPath: st.dir, sessionSavedAt: new Date(), status: 'ACTIVE' },
  })
  await prisma.auditLog.create({
    data: {
      actor: 'operator',
      action: 'sender.login',
      entity: `SenderAccount:${handle}`,
      detail: `hand login into ${st.dir}`,
    },
  })
  log.info('login recorded', { handle })
}

main().catch(async (e) => {
  console.error(`\n  ${e instanceof Error ? e.message : String(e)}\n`)
  await prisma.$disconnect()
  process.exit(1)
})
