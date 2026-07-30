import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { prisma } from '@/lib/db'
import { env } from '@/lib/env'
import { log } from '@/lib/logger'

/**
 * `execFile`, not `exec` — no shell is involved, so nothing in the URL can be
 * interpreted as a shell metacharacter. Named explicitly to stop the next reader
 * (or scanner) mistaking it for the shell-invoking `exec`.
 */
const openUrl = promisify(execFile)

/** Instagram handles are [A-Za-z0-9._]. Defence in depth: the value comes from our
 *  own DB, but a URL handed to the OS should never be unvalidated. */
function assertSafeHandle(handle: string): void {
  if (!/^[A-Za-z0-9._]{1,30}$/.test(handle)) {
    throw new Error(`refusing to open a URL for a malformed handle: ${JSON.stringify(handle)}`)
  }
}

/**
 * The send step: everything automated except the click.
 *
 *   pnpm send
 *
 * Shows the next prepared message, copies it to the clipboard, opens the
 * recipient's PROFILE in your normal browser, and waits for you to confirm.
 *
 * Why it works this way, from research on 2026-07-30:
 *
 *   Driving the browser was removed, not deferred. Cookie-replay into a fresh
 *   automation profile destroys the device/network identity continuity that made
 *   manual sending survive — no login event, new device identifiers — and
 *   `sessionid` is a bearer token with no channel binding, so it *works* right up
 *   until enforcement arrives silently. Attaching to a real Chrome does not help:
 *   `navigator.webdriver` is true in every Playwright configuration, and
 *   `Runtime.enable` is emitted identically whether you launch or attach.
 *
 *   Meanwhile the behavioural stream a person produces — pointer movement, focus
 *   changes, scroll depth, keystroke timing, dwell before clicking Message — is
 *   exactly what automation cannot fake, and exactly what this flow preserves for
 *   free.
 *
 *   At one or two messages a day, automating the click saves about ninety seconds
 *   and puts three revenue-generating accounts on the table. This is that trade,
 *   declined.
 *
 * It opens the PROFILE rather than deep-linking the thread deliberately: the
 * navigation path profile → Message → type is the one a person takes.
 */

async function main() {
  const auto = process.argv.includes('--yes')

  const attempts = await prisma.outreachAttempt.findMany({
    where: { status: { in: ['READY', 'QUEUED'] } },
    include: { pair: { include: { sender: true, target: true } }, campaign: true },
    orderBy: { queuedAt: 'asc' },
  })

  if (attempts.length === 0) {
    const totalSent = await prisma.outreachAttempt.count({ where: { status: { in: ['SENT', 'REPLIED'] } } })
    console.log(`\n  Nothing prepared to send.\n`)
    if (env.DRY_RUN) {
      console.log(`  Practice mode is on (DRY_RUN=1), so nothing is ever queued.`)
      console.log(`  Set DRY_RUN=0 in .env, then: pnpm run:slot\n`)
    } else if (env.MAX_TOTAL_SENDS !== null && totalSent >= env.MAX_TOTAL_SENDS) {
      console.log(`  Lifetime ceiling reached: ${totalSent} of ${env.MAX_TOTAL_SENDS} sent.`)
      console.log(`  Raise MAX_TOTAL_SENDS in .env to allow more.\n`)
    } else {
      console.log(`  Run a check first:  pnpm run:slot\n`)
    }
    await prisma.$disconnect()
    return
  }

  const a = attempts[0]!
  const { sender, target } = a.pair
  assertSafeHandle(target.handle)
  const profileUrl = `https://www.instagram.com/${target.handle}/`

  console.log(`
${'═'.repeat(76)}
  SEND THIS MESSAGE                                    ${attempts.length > 1 ? `(${attempts.length - 1} more after this)` : ''}
${'═'.repeat(76)}

  FROM    @${sender.handle}   (${sender.displayName})
  TO      @${target.handle}   (${target.displayName})
  ${a.campaign ? `BASED ON  ${a.campaign.permalink}` : 'BASED ON  no recent campaign — generic opener'}

${'─'.repeat(76)}
${a.renderedBody
  .split('\n')
  .map((l) => `  ${l}`)
  .join('\n')}
${'─'.repeat(76)}
  ${a.renderedBody.length} characters
`)

  // Clipboard first, so the paste is ready before the browser even opens.
  let copied = false
  try {
    await copyToClipboard(a.renderedBody)
    copied = true
  } catch (err) {
    log.warn('could not copy to clipboard', { error: err instanceof Error ? err.message : String(err) })
  }

  console.log(`  ${copied ? '✓ Copied to your clipboard' : '✗ Clipboard failed — copy the text above by hand'}`)
  console.log(`
  NEXT, in your own browser (the one already logged in):

    1. Opening  ${profileUrl}
    2. Click  Message
    3. Paste  (⌘V)  and read it once
    4. Send

  Open the profile, not the DM inbox — that navigation path is the one a
  person takes, and it is most of why this approach is safe.
`)

  if (!auto) {
    await prompt(`  Press Enter to open the profile (Ctrl+C to abort)… `)
  }

  try {
    await openUrl('open', [profileUrl])
  } catch {
    console.log(`  Could not open the browser. Go to: ${profileUrl}`)
  }

  console.log()
  const answer = auto ? 'y' : await prompt(`  Did you send it? [y/N/skip] `)
  const said = answer.trim().toLowerCase()

  if (said === 'y' || said === 'yes') {
    await prisma.$transaction([
      prisma.outreachAttempt.update({
        where: { id: a.id },
        data: { status: 'SENT', sentAt: new Date(), sentBy: env.OPERATOR_NAME },
      }),
      prisma.messageVariant.update({
        where: { id: a.variantId },
        data: { timesUsed: { increment: 1 }, lastUsedAt: new Date() },
      }),
      prisma.auditLog.create({
        data: {
          actor: env.OPERATOR_NAME,
          action: 'attempt.sent',
          entity: `OutreachAttempt:${a.id}`,
          detail: `@${sender.handle} → @${target.handle} (sent by hand)`,
        },
      }),
    ])

    const total = await prisma.outreachAttempt.count({ where: { status: { in: ['SENT', 'REPLIED'] } } })
    console.log(`
  ✓ Recorded.

    @${target.handle} will not be contacted again — one message per target, ever.
    Lifetime total: ${total}${env.MAX_TOTAL_SENDS !== null ? ` of ${env.MAX_TOTAL_SENDS}` : ''}.
${
  env.MAX_TOTAL_SENDS !== null && total >= env.MAX_TOTAL_SENDS
    ? `\n    Ceiling reached — nothing further will be prepared until you raise\n    MAX_TOTAL_SENDS in .env.\n`
    : ''
}
    If they reply, mark it on the dashboard so it shows up as a result.
`)
  } else if (said === 'skip' || said === 's') {
    await prisma.outreachAttempt.update({
      where: { id: a.id },
      data: { status: 'SKIPPED', error: 'skipped by operator' },
    })
    console.log(`\n  Skipped. @${target.handle} stays contactable.\n`)
  } else {
    console.log(`\n  Left as-is. Run \`pnpm send\` again when you are ready.\n`)
  }

  await prisma.$disconnect()
}

async function copyToClipboard(text: string): Promise<void> {
  // pbcopy takes stdin, which execFile does not expose directly.
  const { spawn } = await import('node:child_process')
  await new Promise<void>((resolve, reject) => {
    const p = spawn('pbcopy')
    p.on('error', reject)
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`pbcopy exited ${code}`))))
    p.stdin.write(text)
    p.stdin.end()
  })
}

function prompt(question: string): Promise<string> {
  return new Promise((resolve) => {
    process.stdout.write(question)
    process.stdin.resume()
    process.stdin.once('data', (d) => {
      process.stdin.pause()
      resolve(d.toString())
    })
  })
}

main().catch(async (err) => {
  log.error('send failed', { error: err instanceof Error ? err.message : String(err) })
  await prisma.$disconnect().catch(() => undefined)
  process.exit(1)
})
