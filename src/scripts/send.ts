import { prisma } from '@/lib/db'
import { env } from '@/lib/env'
import { log } from '@/lib/logger'
import { profileUrl } from '@/lib/urls'
import { copyToClipboard } from '@/lib/clipboard'
import { openUrlCommand, run } from '@/lib/platform'
import { recordDelivered } from '@/outreach/recordSend'
import { recheckBeforeSend } from '@/outreach/gate'

/**
 * No shell is involved anywhere in the URL open, so nothing in the URL can be
 * interpreted as a shell metacharacter. Named explicitly to stop the next reader
 * (or scanner) mistaking it for the shell-invoking `exec`.
 */

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
 * None of that is an argument against automating — it is the list of constraints
 * the automated version has to satisfy. See CLAUDE.md decision 1: a dedicated
 * Chrome profile logged in by hand, Patchright rather than stock Playwright, the
 * home residential IP, real input APIs, proven on a throwaway account first.
 * Manual is the gate that proves the pipeline before any of that is worth building.
 *
 * It opens the PROFILE rather than deep-linking the thread deliberately: the
 * navigation path profile → Message → type is the one a person takes. (The
 * `ig.me/m/<handle>` deep link is also simply dead on desktop — HTTP 400.)
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

  /**
   * ── THE GATE IS ASKED HERE TOO (2026-08-26) ───────────────────────────────
   *
   * This script used to take `attempts[0]` outright. `recheckBeforeSend` was never called —
   * so the ONE path a person drives by hand was the one path with no opt-out check, no
   * verified check, no watch-only check, no reply halt and no fleet rule. "One gate, two
   * callers, never re-inline it" is CLAUDE.md's own rule, recorded after `deliverWaiting`
   * and `sendNow` drifted; this was a THIRD caller that never had it.
   *
   * AND THE ORDERING MADE IT WORSE RATHER THAN MERELY INCOMPLETE. A permanently-held draft
   * — a cross-fleet one, say — never has its `queuedAt` bumped (only a retryable failure
   * does that, in deliver.ts) and the planner will not replace it while `hasPendingAttempt`
   * is true. So it drifts to the FRONT of this `queuedAt asc` queue and stays there: the
   * ungated path preferentially offered the exact draft every other path refuses. Measured
   * on the live queue the day this was fixed, the oldest waiting draft was precisely that.
   *
   * Held drafts are REPORTED and skipped rather than silently passed over — the reason is
   * the gate's own sentence, so this command can never describe a hold by a different rule
   * than the one enforcing it.
   */
  let a: (typeof attempts)[number] | null = null
  for (const candidate of attempts) {
    const verdict = await recheckBeforeSend(candidate, { unattended: false })
    if (verdict.ok) {
      a = candidate
      break
    }
    console.log(
      `  held  @${candidate.pair.sender.handle} → @${candidate.pair.target.handle}  ${verdict.reason}` +
        (verdict.detail ? `\n        ${verdict.detail}` : ''),
    )
  }

  if (a === null) {
    console.log(`\n  Every one of the ${attempts.length} waiting message(s) is held by a rule. Nothing to send.\n`)
    await prisma.$disconnect()
    return
  }

  const { sender, target } = a.pair
  const url = profileUrl(target.handle)

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
  const browserLabel = env.SEND_BROWSER ?? 'your default browser'
  console.log(`
  NEXT, in ${browserLabel} — the one you are logged into @${sender.handle} in:

    1. Opening  ${url}
    2. Click  Message
    3. Paste  (⌘V)  and read it once
    4. Send

  Open the profile, not the DM inbox — that navigation path is the one a
  person takes, and it is most of why this approach is safe.
${
  env.SEND_BROWSER
    ? ''
    : `
  If that opens a browser where you are not logged in, set SEND_BROWSER in .env
  (e.g. SEND_BROWSER="Google Chrome") — the agent holds no Instagram session of
  its own, so a login wall means the wrong browser, not a lost session.
`
}`)

  if (!auto) {
    await prompt(`  Press Enter to open the profile (Ctrl+C to abort)… `)
  }

  try {
    // Platform-specific; see src/lib/platform.ts. `open` was hardcoded, so this
    // fallback was unavailable on Windows - and it is the documented escape hatch when
    // the automated path fails.
    await run(openUrlCommand(process.platform, url, env.SEND_BROWSER))
  } catch {
    console.log(`  Could not open ${browserLabel}. Go to: ${url}`)
  }

  console.log()
  const answer = auto ? 'y' : await prompt(`  Did you send it? [y/N/skip] `)
  const said = answer.trim().toLowerCase()

  if (said === 'y' || said === 'yes') {
    /**
     * `cli:` prefixed, because the dashboard now records the SIGNED-IN USER's email and
     * this path has no session to read — a CLI is a terminal, not a browser.
     *
     * Without the prefix both would write a bare name and the audit trail could not
     * distinguish "someone pressed Send on the dashboard" from "someone typed y in a
     * terminal after sending it themselves by hand". Those are different claims about
     * what actually happened, and `sentBy` is the only place either is recorded.
     */
    const actor = `cli:${env.OPERATOR_NAME}`
    // SENT alone, then the bookkeeping. See `recordSend.ts` — this path recorded a
    // delivered DM in the same transaction as a rotation counter.
    await recordDelivered({
      attemptId: a.id,
      variantId: a.variantId,
      sentBy: actor,
      audit: {
        actor,
        action: 'attempt.sent',
        entity: `OutreachAttempt:${a.id}`,
        detail: `@${sender.handle} → @${target.handle} (sent by hand)`,
      },
    })

    const total = await prisma.outreachAttempt.count({ where: { status: { in: ['SENT', 'REPLIED'] } } })
    console.log(`
  ✓ Recorded.

    Lifetime total: ${total}${env.MAX_TOTAL_SENDS !== null ? ` of ${env.MAX_TOTAL_SENDS}` : ''}.
    @${target.handle} can be written to again once two things are true: the pair's
    spacing window has passed, and a campaign we have not already referenced
    appears. A follow-up with nothing new to say is what the guard blocks.
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
