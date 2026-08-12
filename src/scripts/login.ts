import { createInterface } from 'node:readline/promises'
import { prisma } from '@/lib/db'
import { log } from '@/lib/logger'
import { profileStatus } from '@/outreach/browser/profile'
import { launchProfile, loggedInAs } from '@/outreach/browser/session'
import { clearSessionInvalid } from '@/outreach/sessionHealth'

/**
 *   pnpm ig:login <handle>
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
    console.log(`\n  Usage:  pnpm ig:login <handle>\n`)
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
    console.log(`\n  @${handle} is not one of your sending accounts. Run \`pnpm ig:login\` to list them.\n`)
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
  const sender = await prisma.senderAccount.update({
    where: { handle },
    data: { sessionPath: st.dir, sessionSavedAt: new Date() },
  })

  /**
   * THROUGH `clearSessionInvalid`, not by writing the column here.
   *
   * This statement used to carry `sessionInvalidAt: null, sessionInvalidReason: null`
   * itself, which made it a SECOND writer of a column whose own module says there is one
   * ("Cleared only by PROOF, and `clearSessionInvalid` says which kinds count"). The cost
   * was the audit trail: the dashboard's login writes a `sender.session.restored` row and
   * this one wrote nothing, so a session coming back to life was recorded or not depending
   * on which of two identical flows the operator happened to use. Same discipline, and the
   * same reason, as `markChallenged` being the only writer of `challengedAt`.
   *
   * This IS a sanctioned proof: `recordLogin` is only reached after `loggedInAs` resolved
   * the session against Instagram and it matched this handle. A cookie merely appearing on
   * disk never clears it — that is the exact evidence the mark exists to overrule.
   */
  await clearSessionInvalid(sender.id, `hand login via pnpm ig:login, identity verified against Instagram`)

  /**
   * AND IT NO LONGER SETS `status: 'ACTIVE'`.
   *
   * It did, which meant a hand login silently released a CHALLENGED halt — with
   * `challengedAt` left set, so the fleet circuit breaker stayed tripped while this account
   * read as healthy. That exact bug was found and fixed in `checkConnect` on the dashboard
   * ("CHALLENGED is never cleared as a side effect"), and the CLI was never switched over:
   * one flow, two callers, one of them still wrong. A checkpoint means Instagram took
   * action, and a working session is not evidence that the cause was dealt with. Clearing
   * it is `clearChallenge`, a separate deliberate act by a person who looked.
   */
  if (sender.status === 'CHALLENGED') {
    console.log(
      `\n  ⚠ @${handle} is still marked CHALLENGED — Instagram questioned this account, and a\n` +
        `    working login is not evidence that was dealt with. Release it on the Senders page\n` +
        `    once you have checked the account. Nothing sends from it until you do.\n`,
    )
  }

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
