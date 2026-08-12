import { prisma } from '@/lib/db'
import { env } from '@/lib/env'
import { validatePersona } from '@/outreach/render'
import { getSettings } from '@/lib/settings'
import { mayArmAccount } from '@/outreach/cohorts'
import { profileStatus } from '@/outreach/browser/profile'
import { sessionUsable } from '@/outreach/sessionHealth'

/**
 * Operator controls, deliberately kept off the dashboard.
 *
 * These change how the agent behaves — pausing an account, clearing a lock. Putting
 * them on the page a CEO reads is how they get pressed by accident, so they live
 * behind a command instead.
 *
 *   pnpm agent status
 *   pnpm agent pause  bollywoodsociety
 *   pnpm agent resume bollywoodsociety        # also clears a CHALLENGED state
 *
 * ── `pnpm agent autopilot on|off <handle>` IS GONE. ONE SWITCH, 2026-08-08. ──────────
 *
 * It read and wrote `SenderAccount.autoSendEnabled`, the per-account arming bit, and
 * nothing enforces that bit any more: `gate.ts` and `deliver.ts` stopped consulting it
 * when Tabish removed the per-account switches (*"The moment autopilot is turned on there
 * must be no more switches"*). A command that writes a column no guard reads does not
 * change what the fleet does — it just prints a confident sentence about a switch that
 * is not wired to anything.
 *
 * THAT IS WORSE THAN NO COMMAND. This file's whole job is answering "why can this
 * account not send", and the same bit was ALSO reported as the blocker `autopilot off`
 * by `status` below — so an operator could read a refusal, run the command that names
 * it, watch it succeed, and see nothing change. Deleted rather than reworded: the
 * autopilot switch is one row in `Setting`, fleet-wide, and it belongs on the dashboard
 * where it is tracked, not behind a per-account CLI verb.
 */

async function main() {
  const [command, ...rest] = process.argv.slice(2)

  switch (command) {
    case 'status':
      return status()
    case 'pause':
      return setStatus(rest[0], 'PAUSED')
    case 'resume':
      return setStatus(rest[0], 'ACTIVE')
    default:
      usage()
  }
}

function usage(): never {
  console.log(`
  pnpm agent status                      show every account and what is blocking it
  pnpm agent pause  <handle>             stop using this account entirely
  pnpm agent resume <handle>             resume (also clears an Instagram lock)
`)
  process.exit(1)
}

/**
 * What is actually stopping each account from sending unattended.
 *
 * ONE SWITCH, 2026-08-08: the blocker `autopilot off` is gone from this list. It was read
 * off `SenderAccount.autoSendEnabled`, which no guard consults any more — so it named a
 * refusal nothing was enforcing, on the one screen whose entire purpose is naming real
 * refusals. Reporting a stop that does not exist is the mirror image of the failure this
 * project keeps finding, and it costs the same thing: the list stops being trusted.
 *
 * What replaces it is the set of stops that DO hold, each asked of the thing that enforces
 * it rather than re-derived here:
 *
 *   - the fleet-wide autopilot switch, from `getSettings()` — which folds the `.env`
 *     hard floor into the `Setting` row exactly as the dispatcher reads it, so this cannot
 *     disagree with what actually fires.
 *   - a USABLE session, via `sessionUsable` — not `sessionPath`. A path in the database is
 *     not a live session: Instagram revokes server-side, and §3.5 records that as
 *     `sessionInvalidAt`. "The dashboard says connected" and "every send fails with a login
 *     form" were both true at once before that mark existed, and reading the column alone
 *     would reproduce it here.
 *   - the cohort ladder, via `mayArmAccount` — the same function `gate.ts:414` calls at
 *     delivery. It is the only per-account gate left, and it was invisible from the CLI.
 *   - status (CHALLENGED / PAUSED) and the persona shape check, both unchanged.
 */
async function status() {
  const [senders, settings] = await Promise.all([
    prisma.senderAccount.findMany({
      include: { pairs: { include: { target: true } } },
      orderBy: { handle: 'asc' },
    }),
    getSettings(),
  ])

  console.log(`\n  Autopilot: ${settings.autopilotEnabled ? 'ON' : 'OFF'}`)
  if (!env.AUTOPILOT_ENABLED) {
    console.log(`  (.env AUTOPILOT_ENABLED=false is a hard floor — the dashboard cannot cross it)`)
  }
  console.log(`  Practice mode (.env DRY_RUN): ${env.DRY_RUN ? 'ON — nothing sends' : 'off'}\n`)

  /**
   * Resolved up front rather than inside the loop. `mayArmAccount` is three queries per
   * account, and awaited per-iteration that is 195 sequential round trips at the planned
   * fleet size of 65 — on a Postgres reached through an SSH tunnel. A status command that
   * takes a minute stops being run, and this is the command that answers "why is nothing
   * sending".
   */
  const ladders = new Map(
    await Promise.all(senders.map(async (s) => [s.handle, await mayArmAccount(s.handle)] as const)),
  )

  for (const s of senders) {
    const problems = validatePersona(s)
    const ladder = ladders.get(s.handle)
    const blockers: string[] = []
    if (s.status !== 'ACTIVE') blockers.push(s.status.toLowerCase())
    if (problems.length > 0) blockers.push('invalid contact details')
    if (
      !sessionUsable({
        hasSessionOnDisk: profileStatus(s.handle).hasSession,
        sessionInvalidAt: s.sessionInvalidAt,
      })
    ) {
      blockers.push(s.sessionInvalidAt ? 'signed out (found logged out)' : 'never signed in')
    }
    /**
     * `fleetMember: false` is not a fault and must not read as one. The burner is
     * deliberately outside automatic rotation and reachable only by a person pressing
     * Send, so it is reported as what it is rather than as a broken account.
     */
    if (!s.fleetMember) blockers.push('not in the fleet (on-demand only)')
    /**
     * An absent verdict is reported as unknown, never skipped. The map is keyed off the same
     * list being iterated so a miss should be impossible — which is exactly when "absence of
     * data hardens into a permission" gets written by accident.
     */
    if (!ladder) blockers.push('group unknown (could not read the ladder)')
    else if (!ladder.ok) blockers.push(`group waiting: ${ladder.reason}`)
    if (!settings.autopilotEnabled) blockers.push('autopilot off')
    if (env.DRY_RUN) blockers.push('practice mode')

    const willSend = blockers.length === 0
    console.log(`  ${willSend ? '✓' : '·'} @${s.handle.padEnd(22)} ${willSend ? 'SENDS AUTOMATICALLY' : `blocked: ${blockers.join(', ')}`}`)
    console.log(`      → ${s.pairs.map((p) => `@${p.target.handle}`).join(', ') || 'no targets'}`)
  }
  console.log()
  await prisma.$disconnect()
}

async function setStatus(handle: string | undefined, status: 'ACTIVE' | 'PAUSED') {
  if (!handle) usage()
  const sender = await prisma.senderAccount.findUnique({ where: { handle } })
  if (!sender) {
    console.error(`  no account @${handle}`)
    process.exit(1)
  }

  const wasChallenged = sender.status === 'CHALLENGED'
  await prisma.senderAccount.update({ where: { id: sender.id }, data: { status } })
  await prisma.auditLog.create({
    data: { actor: 'operator', action: 'sender.status', entity: `SenderAccount:${sender.id}`, detail: status },
  })

  console.log(`  @${handle} is now ${status}`)
  if (wasChallenged && status === 'ACTIVE') {
    console.log(`  Instagram lock cleared. Confirm you resolved it in the app first —`)
    console.log(`  re-running into an unresolved lock is what gets accounts banned.`)
  }
  await prisma.$disconnect()
}

main().catch(async (err) => {
  console.error(err instanceof Error ? err.message : String(err))
  await prisma.$disconnect().catch(() => undefined)
  process.exit(1)
})
