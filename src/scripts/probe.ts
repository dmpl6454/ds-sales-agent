/**
 *   pnpm ig:probe                       stored evidence, then one request per identity (@viralbhayani)
 *   pnpm ig:probe --handle <username>   ask about another account
 *   pnpm ig:probe --ua "Instagram …"    add one candidate: the app identity with this User-Agent
 *   pnpm ig:probe --graph               add one request through the official API, if configured
 *   pnpm ig:probe --offline             the stored evidence only, no request at all
 *
 * Run it on the Mac AND on the box (`ssh -n linode "cd /opt/ds-sales-agent && pnpm ig:probe"` —
 * `-n`, rule 42) and read the two outputs side by side; docs/DEPLOY.md, "Detection reads nothing",
 * says how. Everything it does is in src/detection/feedProbe.ts, where it is tested; this file
 * only reads the command line and prints. It records nothing and closes no gate.
 *
 * Exit 0: the identity in use was served (or nothing was asked). 1: it was not. 2: the command
 * line was refused.
 */
import { prisma } from '@/lib/db'
import { PROBE_USAGE, parseProbeArgs, runProbe } from '@/detection/feedProbe'

const args = parseProbeArgs(process.argv.slice(2))
if (args.kind === 'help') {
  console.log(PROBE_USAGE)
  process.exit(0)
}
if (args.kind === 'refused') {
  console.error(args.why)
  process.exit(2)
}

const code = await runProbe(args.plan, { out: (line) => console.log(line) })
await prisma.$disconnect().catch(() => {})
process.exit(code)
