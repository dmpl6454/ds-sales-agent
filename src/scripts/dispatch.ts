import 'dotenv/config'
import { dispatchTick, dispatchStatus } from '@/outreach/dispatcher'
import { describeCap } from '@/lib/settings'
import { istStamp } from '@/lib/time'

/**
 * `pnpm ig:dispatch` — run one dispatcher tick now, or just report what it would do.
 *
 * The same function the scheduler calls every fifteen minutes. One implementation, two
 * callers — the pattern `pnpm ig:replies` already follows for reply checking, and for the
 * same reason: a command that reimplements the scheduled behaviour can only tell you about
 * itself.
 *
 * **`--status` is the default and it sends nothing.** Every pacing rule is visible from it,
 * so the ordinary question ("why has nothing gone out?") is answered without driving a
 * browser. `--run` is the deliberate act. That is the same shape as `ig:classify` and
 * `ig:brands`, where the default costs nothing because the volume is unbounded by
 * construction — here the cost is not money but an Instagram request from a revenue
 * account, which is worth more.
 */

const args = process.argv.slice(2)
const run = args.includes('--run')

function show(label: string, value: string): void {
  console.log(`  ${label.padEnd(24)} ${value}`)
}

async function main(): Promise<void> {
  const status = await dispatchStatus()

  console.log(`\nFleet dispatcher — ${istStamp()} IST\n`)

  show('waiting to be sent', String(status.waiting))
  show('sent this hour', `${status.usage.thisHour} / ${describeCap(status.limits.perHour)}`)
  show('sent today', `${status.usage.today} / ${describeCap(status.limits.perDay)}`)
  show('minimum gap', `${status.limits.minGapMinutes} minutes`)
  show('per tick', String(status.limits.perTick))

  if (status.breaker.tripped) {
    console.log(`\n  ⛔ SENDING IS HALTED — ${status.breaker.reason}`)
    console.log(`     ${status.breaker.detail}`)
  } else {
    console.log('\n  ✓ no halt in force')
  }

  if (status.state) {
    console.log(`\n  last tick ${status.state.atIst} — ${status.state.action}: ${status.state.reason}`)
    console.log(`     ${status.state.detail}`)
  } else {
    console.log('\n  no tick has run yet')
  }

  if (!run) {
    console.log('\nNothing was sent. Add --run to deliver one message now.\n')
    return
  }

  console.log('\nRunning a tick…\n')
  const result = await dispatchTick('cli')

  if (result.verdict.action === 'hold') {
    console.log(`  held: ${result.verdict.reason}`)
    console.log(`  ${result.verdict.detail}\n`)
    return
  }

  const sent = result.delivered?.sent ?? 0
  const failed = result.delivered?.failed ?? 0
  console.log(`  sent ${sent}, failed ${failed}`)
  for (const o of result.delivered?.outcomes ?? []) {
    console.log(`  ${o.pairKey.padEnd(48)} ${o.result}`)
  }
  console.log()
}

main()
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
  // A CLI script must not hang on an open SQLite handle.
  .finally(() => process.exit(0))
