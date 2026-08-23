/**
 * RE-READ WHO EVERY LIVE PROSPECT ACTUALLY IS, AND RETIRE ANYONE ADMITTED ON THE WRONG BADGE.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────────
 *
 * Until 2026-08-23 `enrichHandle` read identity from `body.items[0].user` in preference to
 * `body.user`. `items[0]` is the NEWEST POST in the feed, and on a co-authored post its
 * `user` is the COLLABORATOR. MEASURED live on the day:
 *
 *   asked @yamigautam  → items[0].user = @amazonmgmstudiosin, is_verified=true
 *   asked @akshaykumar → items[0].user = @jiohotstar,         is_verified=true
 *
 * So a prospect's `isVerified`, `displayName` and `followerCount` could all belong to a
 * different account. Two consequences, and the first is a safety one:
 *
 *   1. VERIFIED ONLY could be satisfied by SOMEBODY ELSE'S badge. An unverified account
 *      whose newest post is a collab with a verified brand would be admitted.
 *   2. The wrong name reaches message copy — 26 display names were shared between
 *      prospects, "Netflix India" across three different actors.
 *
 * The reader is fixed. This repairs the rows it already wrote.
 *
 * DRY RUN BY DEFAULT, like every other command here that changes real rows. Nothing is ever
 * deleted: an account that turns out unverified is RETIRED (`optedOut`), because it may
 * already hold delivered history and `optedOut` is the promise that survives every feature.
 *
 * An UNREACHABLE lookup changes NOTHING. Not-reachable is never a verdict — the whole
 * defect above came from treating one payload as authoritative about identity, and the fix
 * must not repeat that in the opposite direction.
 */
import { prisma } from '@/lib/db'
import { enrichHandle } from '@/detection/enrichHandle'

/**
 * 6s is the standing politeness for this endpoint. This command accepts `--spacing` because
 * the FIRST run of it was closing an active VERIFIED ONLY breach — unverified accounts in
 * the live list being messaged at one a minute — and halving the window mattered more than
 * the convention for that one run. Detection already makes ~5,000 anonymous feed requests a
 * day; a few hundred more at 3s is not what puts this at risk.
 */
const DEFAULT_SPACING_MS = 6_000

async function main() {
  const run = process.argv.includes('--run')
  const limitArg = process.argv.indexOf('--limit')
  const limit = limitArg >= 0 ? Number(process.argv[limitArg + 1]) : Infinity
  const spacingArg = process.argv.indexOf('--spacing')
  const spacingMs = spacingArg >= 0 ? Number(process.argv[spacingArg + 1]) : DEFAULT_SPACING_MS
  const actor = `cli:${process.env.OPERATOR_NAME ?? 'operator'}`

  const prospects = await prisma.targetAccount.findMany({
    where: { role: 'PROSPECT', optedOut: false },
    select: { id: true, handle: true, displayName: true, isVerified: true, followerCount: true },
    orderBy: { createdAt: 'desc' },
  })

  const work = prospects.slice(0, Number.isFinite(limit) ? limit : undefined)
  console.log(`${work.length} live prospect(s) to re-read${run ? '' : '  (DRY RUN)'}\n`)

  let renamed = 0, unverified = 0, unreachable = 0, confirmed = 0

  for (const p of work) {
    const e = await enrichHandle(p.handle)
    await new Promise((r) => setTimeout(r, spacingMs))

    if (!e.reachable) {
      unreachable++
      console.log(`  ?  @${p.handle} — could not read (${e.reason ?? 'unknown'}); left exactly as it was`)
      continue
    }

    const nameWrong = e.fullName != null && e.fullName !== p.displayName
    const badgeWrong = e.isVerified === false && p.isVerified === true

    if (badgeWrong) {
      unverified++
      console.log(`  ✗  @${p.handle} is NOT verified — stored ${JSON.stringify(p.displayName)}, really ${JSON.stringify(e.fullName)}. RETIRE`)
      if (run) {
        await prisma.targetAccount.update({
          where: { id: p.id },
          data: { optedOut: true, isVerified: false, displayName: e.fullName ?? p.displayName ?? undefined, followerCount: e.followers ?? p.followerCount },
        })
        await prisma.auditLog.create({
          data: {
            actor,
            action: 'target.retired',
            entity: `TargetAccount:${p.id}`,
            detail: `@${p.handle} retired: re-read identity says isVerified=false (VERIFIED ONLY). Stored name was ${JSON.stringify(p.displayName)}, real name ${JSON.stringify(e.fullName)} — the old row's identity came from a collaborator.`,
          },
        })
      }
      continue
    }

    if (nameWrong) {
      renamed++
      console.log(`  ~  @${p.handle} name ${JSON.stringify(p.displayName)} → ${JSON.stringify(e.fullName)}`)
      if (run) {
        await prisma.targetAccount.update({
          where: { id: p.id },
          data: { displayName: e.fullName ?? undefined, isVerified: e.isVerified ?? p.isVerified, followerCount: e.followers ?? p.followerCount },
        })
        await prisma.auditLog.create({
          data: {
            actor,
            action: 'target.identity.corrected',
            entity: `TargetAccount:${p.id}`,
            detail: `@${p.handle} displayName ${JSON.stringify(p.displayName)} → ${JSON.stringify(e.fullName)} (previous value came from a collaborator's user object)`,
          },
        })
      }
      continue
    }

    confirmed++
  }

  console.log(`\nconfirmed=${confirmed} renamed=${renamed} retiredUnverified=${unverified} unreachable=${unreachable}`)
  if (!run) console.log('DRY RUN — re-run with --run to apply. Nothing is ever deleted.')
}

main().finally(() => prisma.$disconnect())
