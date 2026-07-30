import { prisma } from '@/lib/db'
import { env } from '@/lib/env'
import { validatePersona } from '@/outreach/render'

/**
 * Operator controls, deliberately kept off the dashboard.
 *
 * These change how the agent behaves — enabling autopilot, pausing an account,
 * clearing a lock. Putting them on the page a CEO reads is how they get pressed
 * by accident, so they live behind a command instead.
 *
 *   pnpm agent status
 *   pnpm agent autopilot on  bollywoodchronicle
 *   pnpm agent autopilot off bollywoodchronicle
 *   pnpm agent pause  bollywoodsociety
 *   pnpm agent resume bollywoodsociety        # also clears a CHALLENGED state
 */

async function main() {
  const [command, ...rest] = process.argv.slice(2)

  switch (command) {
    case 'status':
      return status()
    case 'autopilot':
      return autopilot(rest[0], rest[1])
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
  pnpm agent autopilot on  <handle>      let this account send by itself
  pnpm agent autopilot off <handle>      require a human to press send
  pnpm agent pause  <handle>             stop using this account entirely
  pnpm agent resume <handle>             resume (also clears an Instagram lock)
`)
  process.exit(1)
}

async function status() {
  const senders = await prisma.senderAccount.findMany({
    include: { pairs: { include: { target: true } } },
    orderBy: { handle: 'asc' },
  })

  console.log(`\n  Global autopilot switch (.env AUTOPILOT_ENABLED): ${env.AUTOPILOT_ENABLED ? 'ON' : 'OFF'}`)
  console.log(`  Practice mode (.env DRY_RUN):                     ${env.DRY_RUN ? 'ON — nothing sends' : 'off'}\n`)

  for (const s of senders) {
    const problems = validatePersona(s)
    const blockers: string[] = []
    if (s.status !== 'ACTIVE') blockers.push(s.status.toLowerCase())
    if (problems.length > 0) blockers.push('invalid contact details')
    if (!s.sessionPath) blockers.push('not logged in')
    if (!s.autoSendEnabled) blockers.push('autopilot off')
    if (!env.AUTOPILOT_ENABLED) blockers.push('global switch off')
    if (env.DRY_RUN) blockers.push('practice mode')

    const willSend = blockers.length === 0
    console.log(`  ${willSend ? '✓' : '·'} @${s.handle.padEnd(22)} ${willSend ? 'SENDS AUTOMATICALLY' : `blocked: ${blockers.join(', ')}`}`)
    console.log(`      → ${s.pairs.map((p) => `@${p.target.handle}`).join(', ') || 'no targets'}`)
  }
  console.log()
  await prisma.$disconnect()
}

async function autopilot(mode: string | undefined, handle: string | undefined) {
  if ((mode !== 'on' && mode !== 'off') || !handle) usage()
  const sender = await prisma.senderAccount.findUnique({ where: { handle } })
  if (!sender) {
    console.error(`  no account @${handle}`)
    process.exit(1)
  }

  const enabling = mode === 'on'

  // Refuse to arm an account that cannot actually send — otherwise the flag reads
  // as "on" while every attempt fails.
  if (enabling) {
    const problems = validatePersona(sender)
    if (problems.length > 0) {
      console.error(`  cannot enable: ${problems.join('; ')}`)
      process.exit(1)
    }
    if (!sender.sessionPath) {
      console.error(`  cannot enable: @${handle} is not logged in. Run: pnpm session:add --sender=${handle}`)
      process.exit(1)
    }
    if (sender.status !== 'ACTIVE') {
      console.error(`  cannot enable: @${handle} is ${sender.status}. Run: pnpm agent resume ${handle}`)
      process.exit(1)
    }
  }

  await prisma.senderAccount.update({ where: { id: sender.id }, data: { autoSendEnabled: enabling } })
  await prisma.auditLog.create({
    data: { actor: 'operator', action: 'sender.autoSend', entity: `SenderAccount:${sender.id}`, detail: mode },
  })

  console.log(`  @${handle} autopilot ${mode}`)
  if (enabling && !env.AUTOPILOT_ENABLED) {
    console.log(`  note: AUTOPILOT_ENABLED=false in .env, so nothing sends until that is turned on too.`)
  }
  if (enabling && env.DRY_RUN) {
    console.log(`  note: DRY_RUN=1 in .env, so nothing sends until practice mode is off.`)
  }
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
