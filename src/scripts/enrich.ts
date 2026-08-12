import { prisma } from '@/lib/db'
import { enrichHandle, describeEnrichment } from '@/detection/enrichHandle'

/**
 *   pnpm ig:enrich          what we can learn about handles we could not classify
 *   pnpm ig:enrich --run    store it, so the dashboard can show it
 *
 * Turns an UNRESOLVED dead end into a decision an operator can make in one look.
 *
 * Meta deleted the schema behind `ig_business_category_subvertical`, so Instagram's
 * category endpoint returns HTTP 400 for accounts that HAVE a business category — i.e.
 * for the accounts most likely to be brands. Measured: 18 of 19 UNRESOLVED handles are
 * live professional accounts, including @tilara.india, @netflix_in and @fastrackworld.
 * Without this they are indistinguishable from dead handles and stay invisible forever.
 *
 * IT DOES NOT CLASSIFY, AND MUST NOT.
 *
 * The only field separating a buyer from talent is `category_name`, available on exactly
 * one endpoint: the broken one. Everything still readable is identical for both —
 * @tilara.india (brand) and @adityathackeray (politician) both come back "professional
 * account · verified". A rule over these fields would message the politician. So this
 * gathers facts and stops; the verdict stays a human's.
 *
 * Dry run by default, like `ig:brands` and `ig:classify`. This one spends no money, but it
 * does spend requests against an Instagram endpoint, and the volume grows with the queue.
 */

const argv = process.argv.slice(2)
const isRun = argv.includes('--run')
const limArg = argv[argv.indexOf('--limit') + 1]
const limit = argv.includes('--limit') && limArg ? Math.max(1, parseInt(limArg, 10) || 0) : null

/** Deliberately slow. Same reasoning as resolveBrand: nothing to gain, an IP block to lose. */
const DELAY_MS = 6_000
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function main(): Promise<void> {
  /**
   * Only UNRESOLVED. A BRAND or PERSON row has a real verdict from the category endpoint
   * and re-reading it would spend requests to learn less than we already know. UNKNOWN is
   * excluded too — that means "we never looked", so it belongs to `ig:brands`, not here.
   */
  const rows = await prisma.brandLookup.findMany({
    where: { kind: 'UNRESOLVED' },
    orderBy: { handle: 'asc' },
    ...(limit ? { take: limit } : {}),
  })

  console.log(
    isRun
      ? `\n  Reading ${rows.length} handle(s) and STORING what we learn.\n`
      : `\n  Dry run — nothing stored. ${rows.length} handle(s) would be read.\n`,
  )
  if (rows.length === 0) {
    console.log('  Nothing UNRESOLVED. Every discovered handle has a verdict.\n')
    return
  }
  console.log(`  At ~${DELAY_MS / 1000}s each that is about ${Math.ceil((rows.length * DELAY_MS) / 60000)} minute(s).\n`)

  if (!isRun) {
    for (const r of rows) console.log(`  @${r.handle}${r.enrichment ? `   (already: ${r.enrichment})` : ''}`)
    console.log('\n  Re-run with --run to read and store.\n')
    return
  }

  let reachable = 0
  let unreachable = 0

  for (const r of rows) {
    const e = await enrichHandle(r.handle)
    const summary = describeEnrichment(e)

    await prisma.brandLookup.update({
      where: { handle: r.handle },
      data: {
        enrichment: summary,
        reachable: e.reachable,
        // Fill the display name only when we do not already have one — the category
        // endpoint's version is better when it exists, and this must not overwrite it.
        ...(e.fullName && !r.displayName ? { displayName: e.fullName } : {}),
        ...(e.followers !== null && r.followers === null ? { followers: e.followers } : {}),
      },
    })

    if (e.reachable) reachable++
    else unreachable++
    console.log(`  @${r.handle.padEnd(30)} ${summary}`)
    await sleep(DELAY_MS)
  }

  console.log(`\n  reachable ${reachable} · could not read ${unreachable}`)
  console.log(`  ${reachable} live account(s) that Instagram's category bug was hiding.`)
  console.log(`  They stay UNRESOLVED — this records what they ARE, not what they are FOR.`)
  console.log(`  Decide each on the dashboard; enabling a pair is still a deliberate click.\n`)
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
