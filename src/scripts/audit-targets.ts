/**
 * `pnpm ig:audit-targets` — re-verify every live prospect against Instagram and flag the
 * faulty. DRY RUN BY DEFAULT; `--run` persists the verification facts it gathered.
 *
 * ── WHY (Tabish, 2026-08-19) ────────────────────────────────────────────────
 *
 * "targets identified should not be faulty … remove targets that are undesired and
 * faulty (detected wrongfully)." The target list has accumulated from three sources
 * (caption mentions, media tags, imports) and two measured failure classes live in it:
 * people misfiled as brands (the category-enumeration gap — @ananyapanday was a BRAND on
 * "Private Investigator"), and thin/dead handles that resolve but represent nobody.
 *
 * ── WHAT IT DOES, AND DELIBERATELY DOES NOT ────────────────────────────────
 *
 *   - Re-reads each live PROSPECT's profile (anonymous feed endpoint, home IP — the
 *     Linode is 429'd on profile lookups; run this from the Mac).
 *   - Records `isVerified` / `followerCount` on the row (`--run`), so the dashboard can
 *     show legitimacy instead of asserting it.
 *   - FLAGS suspect rows and prints them with the evidence. It NEVER retires anything
 *     itself: the `usableName` lesson is that a plausible predicate over the real
 *     population refuses rows it must not, so retirement stays a person's act —
 *     `pnpm ig:retire-target <handle> --run`, the existing audited path.
 *
 * A throttle (429) halts the run — continuing after being told to stop is what turns
 * throttling into an IP block. A dead handle is that ROW's fact and never halts the run.
 */
import { prisma } from '@/lib/db'
import { enrichHandle } from '@/detection/enrichHandle'
import { auditTarget, auditIsJudgeable, AUDIT_WHY_SENTENCE as WHY_SENTENCE } from '@/outreach/targetAudit'

const LOOKUP_SPACING_MS = 6_000

async function main(): Promise<void> {
  const run = process.argv.includes('--run')
  const limitArg = process.argv.indexOf('--limit')
  const limit = limitArg > -1 ? Number(process.argv[limitArg + 1]) || 25 : Number.POSITIVE_INFINITY

  /**
   * FOLLOWER COUNTS COME FROM `BrandLookup`, NOT FROM ENRICHMENT.
   *
   * MEASURED 2026-08-20 by probing three handles live: the anonymous FEED endpoint
   * `enrichHandle` uses returns `is_verified` and `full_name` but NO follower count, ever.
   * Follower data exists only where the PROFILE endpoint answered during discovery — 55
   * rows of 438 — so reading it from there is the difference between the two
   * follower-based flags working at all and being dead code that reports success.
   */
  const followersByHandle = new Map(
    (await prisma.brandLookup.findMany({ where: { followers: { not: null } }, select: { handle: true, followers: true } })).map(
      (b) => [b.handle.toLowerCase(), b.followers],
    ),
  )

  const targets = await prisma.targetAccount.findMany({
    where: { role: 'PROSPECT', optedOut: false },
    select: {
      id: true,
      handle: true,
      displayName: true,
      brandCategory: true,
      campaignTalent: true,
      isVerified: true,
      followerCount: true,
    },
    orderBy: { handle: 'asc' },
  })

  console.log(`${run ? 'RUN' : 'DRY RUN'} — auditing ${Math.min(targets.length, limit)} of ${targets.length} live prospects (6s per lookup, home IP)`)

  const flagged: Array<{ handle: string; why: string; detail: string }> = []
  let looked = 0
  let unjudgeable = 0
  for (const t of targets) {
    if (looked >= limit) break
    const e = await enrichHandle(t.handle)
    looked += 1
    if (!e.reachable && (e.reason ?? '').includes('429')) {
      console.log(`HALT: throttled after ${looked} lookups (${t.handle}) — re-run later; nothing is lost`)
      break
    }
    // `e.followers` is always null (see above); the lookup cache is the only real source.
    const followers = followersByHandle.get(t.handle.toLowerCase()) ?? t.followerCount ?? null
    if (run && e.reachable) {
      await prisma.targetAccount.update({
        where: { id: t.id },
        data: { isVerified: e.isVerified, followerCount: followers },
      })
    }
    const facts = {
      brandCategory: t.brandCategory,
      isVerified: e.reachable ? e.isVerified : t.isVerified,
      followerCount: followers,
      exists: e.reachable,
      campaignTalent: t.campaignTalent,
    }
    if (e.reachable && !auditIsJudgeable(facts)) unjudgeable += 1
    const verdict = auditTarget(facts)
    if (verdict.flag) {
      flagged.push({
        handle: t.handle,
        why: verdict.why,
        detail: `${WHY_SENTENCE[verdict.why]} (category=${t.brandCategory ?? '—'} verified=${e.isVerified ?? '?'} followers=${followers ?? 'unknown'})`,
      })
    }
    await new Promise((r) => setTimeout(r, LOOKUP_SPACING_MS))
  }

  if (flagged.length === 0) {
    console.log(`No suspect prospects among the ${looked} checked.`)
  } else {
    console.log(`\n${flagged.length} suspect — READ EACH before retiring (the rule flags, a person decides):`)
    for (const f of flagged) console.log(`  @${f.handle}  ${f.why}\n    ${f.detail}\n    retire with: pnpm ig:retire-target ${f.handle} --run`)
  }
  /**
   * "No flags" and "no facts to judge with" are different answers and must not render as
   * one — the five-states lesson from `framesRead`. A silent all-clear over rows nobody
   * could assess is the failure this whole command exists to prevent.
   */
  if (unjudgeable > 0) {
    console.log(
      `\n${unjudgeable} of the ${looked} checked could not be judged at all — no badge answer and no category. ` +
        `That is missing evidence, NOT an all-clear.`,
    )
  }
  if (!run) console.log('\nDry run wrote nothing. Re-run with --run to persist verified/follower facts.')
  await prisma.$disconnect()
}

main().catch(async (err) => {
  console.error(err)
  await prisma.$disconnect()
  process.exit(1)
})
