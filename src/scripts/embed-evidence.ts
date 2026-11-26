/**
 * `pnpm ig:embed-evidence` — the post-embed step, by hand. DRY RUN BY DEFAULT.
 *
 * It is `postEmbedPass` — the same function the device agent runs at the front of its brand pass — behind a
 * preview: for the newest official-read paid posts whose embed page has not been read, it asks Instagram's embed
 * page and prints the @mentions it would put back on each. Run it on the SENDING MAC: the server is refused on
 * these pages and this refuses there.
 *
 *   pnpm ig:embed-evidence              preview 10 posts, write nothing (works with embed reads switched off:
 *                                       this is how a person reads what the switch would do before deciding)
 *   pnpm ig:embed-evidence --limit 20   preview more (at most 40 — the hourly ceiling)
 *   pnpm ig:embed-evidence --run        write them. Needs `embedReads` ON: writing is what the switch decides.
 *
 * Every request goes through the gated door (embedDoor.ts): no login, no cookie, 4 s apart, a refusal stops the
 * run and closes the door for 15-60 minutes.
 */
import { prisma } from '@/lib/db'
import { env } from '@/lib/env'
import { getSettings } from '@/lib/settings'
import { hydrateAnonGate } from '@/detection/anonGate'
import { readPostEmbed } from '@/detection/embedDoor'
import { postEmbedPass } from '@/detection/embedEvidence'

async function main(): Promise<number> {
  const argv = process.argv.slice(2)
  const run = argv.includes('--run')
  const limitAt = argv.indexOf('--limit')
  const limitRaw = limitAt >= 0 ? Number(argv[limitAt + 1]) : 10
  if (!Number.isInteger(limitRaw) || limitRaw < 1 || limitRaw > 40) {
    console.log('-- STOPPED: --limit takes a whole number from 1 to 40.')
    return 2
  }
  for (const a of argv) {
    if (a.startsWith('--') && a !== '--run' && a !== '--limit') {
      console.log(`-- STOPPED: unknown option ${a}`)
      return 2
    }
  }
  if (!env.SEND_ENABLED) {
    console.log('-- STOPPED: this machine does not send (SEND_ENABLED is false), so it does not ask Instagram\'s embed pages.')
    console.log('   Instagram refuses them from the server. Run this on the sending Mac.')
    return 2
  }
  const settings = await getSettings()
  if (run && !settings.embedReads) {
    console.log('-- STOPPED: embed reads are switched off, and --run writes. Run it without --run to preview,')
    console.log('   or switch `embedReads` on first. Nothing was asked and nothing was written.')
    return 2
  }
  await hydrateAnonGate()
  console.log(run ? '-- embed-evidence — WRITING' : '-- embed-evidence — DRY RUN: nothing is written')
  const summary = await postEmbedPass({
    maxReads: limitRaw,
    dryRun: !run,
    // A preview is a person asking to see; it may run while the switch is off. A write never does (checked above).
    read: (shortcode) => readPostEmbed(shortcode, { person: !run }),
  })
  console.log(`   waiting to be read: ${summary.waiting} official-read paid posts in the last 7 days (${summary.coolingOff} resting after a failed read)`)
  console.log(`   asked: ${summary.asked}${summary.stopped ? ` — stopped: ${summary.stopped}` : ''}`)
  console.log(`   ${run ? 'restored' : 'would restore'}: ${summary.mentionsRestored} mention(s) on ${summary.restored} post(s)`)
  console.log(`   read and linking no account: ${summary.nothingToRestore} · not this post's caption: ${summary.notThisPost} · said nothing usable: ${summary.unreadable} · changed while we read: ${summary.changedUnderUs}`)
  for (const p of summary.preview) {
    console.log(`   p/${p.shortcode} by @${p.publisher}: ${p.mentions.map((m) => `@${m}`).join(' ')}`)
  }
  if (!run && summary.preview.length > 0) console.log('   To write these: switch embedReads on, then run it again with --run (or leave it to the agent\'s next pass).')
  return 0
}

main()
  .then(async (code) => {
    await prisma.$disconnect().catch(() => undefined)
    process.exit(code)
  })
  .catch(async (err: unknown) => {
    console.log(`-- STOPPED: ${err instanceof Error ? err.message : String(err)}`)
    await prisma.$disconnect().catch(() => undefined)
    process.exit(1)
  })
