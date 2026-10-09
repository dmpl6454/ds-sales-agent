import 'dotenv/config'
import { prisma } from '@/lib/db'
import { env } from '@/lib/env'
import { enrichHandle } from '@/detection/enrichHandle'
import { admitsAsTalent } from '@/outreach/targetAudit'
import { getSettings } from '@/lib/settings'

/**
 * `pnpm ig:unretire-target <handle> [<handle>...]` — put a retired prospect back in the
 * rotation, but ONLY on a badge we just looked at. DRY RUN BY DEFAULT.
 *
 * ── WHY THIS EXISTS, AND WHY IT IS NOT JUST `optedOut = false` ─────────────
 *
 * Tabish, 2026-08-25: *"unretire them and add them to queue or prioritised whatever is
 * safest and quickest."*
 *
 * MEASURED that morning: **13 retired prospects carry `isVerified: null`** — retired on
 * evidence nobody ever gathered. Eleven of them were retired on 17 August with the reason
 * *"a person, not a company"*, and that reason was SUPERSEDED THREE DAYS LATER by the
 * talent door (2026-08-20, his instruction: *"send messages to celebrities as well if they
 * are part of the paid campaign … legitimate and verified"*). @deepakmukut — the producer
 * who actually bought the Gunmaaster G9 campaign — is one of them, and Instagram shows him
 * verified.
 *
 * ── THE BADGE IS RE-READ, NEVER ASSUMED ───────────────────────────────────
 *
 * VERIFIED ONLY is the permanent admission rule and it is explicit that **`isVerified: null`
 * IS REFUSED, AND THAT IS THE DESIGN** — "we never looked" is not "verified". Every row this
 * command can act on is NULL by definition, so flipping `optedOut` alone would take the one
 * population the rule names and admit it on no evidence at all: absence of data hardening
 * into a positive verdict, in the command written to fix the opposite mistake.
 *
 * So each handle is ENRICHED first, from this machine, and the answer is persisted whatever
 * it says. Then exactly one question decides: `admitsAsTalent`, the SAME predicate the
 * detection-side doors ask — imported, never restated, because a second copy of an admission
 * bar is how the @lego.mybrickhouse send happened.
 *
 *   verified === true   → un-retired, `campaignTalent: true`, audit row
 *   verified === false  → STAYS retired, and now says why on the row
 *   unreachable / null  → STAYS retired. A timeout is never a verdict
 *
 * ── `campaignTalent` IS SET, AND IT IS NOT A LOOSENING ────────────────────
 *
 * `checkRecipientIsNotAPerson` refuses a person-role category unless `campaignTalent` is
 * true — @ananyapanday's "Private Investigator" and @acharyavinodkumar's "Astrologist" are
 * both in that list. Un-retiring without it would produce a live row the planner silently
 * refuses forever, which is the "a guard nobody can trigger" shape wearing the opposite
 * costume: a lead that looks re-acquired and can never be written to. Setting it reproduces
 * exactly the admission `createBrandTarget` would make about the same account today.
 *
 * ── THE QUEUE NEEDS NO HELP, WHICH IS WHY THIS DOES NOT TOUCH IT ──────────
 *
 * Nothing here writes a draft or a pair. `ensureFleetPairs` recreates every allowed route at
 * the top of each planner pass (every 15 minutes), `routes.ts` refuses an `optedOut` target
 * and stops refusing the moment this clears it, and the gate re-asks every rule at delivery.
 * So the safest path and the quickest path are the same path: clear the flag and let the
 * ordinary machinery pick them up. Hand-writing drafts here would bypass the material
 * allowance, the ring rule and the verified bar — every one of which this command exists to
 * respect.
 *
 * Lookups are spaced like every other use of this endpoint (politeness against an
 * undocumented API), and a 429 HALTS the run rather than continuing after being told to
 * stop — the `resolveBrand` lesson, which cost three consecutive zero-progress runs.
 */

const LOOKUP_SPACING_MS = 6_000

const args = process.argv.slice(2)
const run = args.includes('--run')

const reasonArg = args.indexOf('--reason')
const reason = reasonArg >= 0 ? (args[reasonArg + 1] ?? '') : 'retired under a rule that has since changed'

/* A flag's VALUE is not a handle — see the same note in retire-target.ts, where the first
   version went looking for a target named after the reason string. */
const skip = new Set<number>()
args.forEach((a, i) => {
  if (a.startsWith('--')) {
    skip.add(i)
    if (a === '--reason') skip.add(i + 1)
  }
})
const handles = args
  .filter((_, i) => !skip.has(i))
  .map((h) => h.trim().replace(/^@/, '').toLowerCase())
  .filter(Boolean)
const actor = `cli:${env.OPERATOR_NAME}`

async function main(): Promise<void> {
  if (handles.length === 0) {
    console.error('Usage: pnpm ig:unretire-target <handle> [<handle>...] [--reason "..."] [--run]')
    console.error('Run it from a HOME IP — the profile endpoint 429s the server.')
    process.exitCode = 1
    return
  }

  const settings = await getSettings()
  let restored = 0
  let refused = 0
  let unreachable = 0
  let first = true

  for (const handle of handles) {
    const target = await prisma.targetAccount.findUnique({
      where: { handle },
      select: { id: true, handle: true, displayName: true, role: true, optedOut: true, brandCategory: true },
    })

    if (!target) {
      console.log(`  @${handle} — no such target. Nothing done.`)
      continue
    }
    /**
     * A WATCHED PAGE IS NOT UN-RETIRED HERE (2026-10-09). This command re-reads a recipient's
     * badge and sets `campaignTalent` — both meaningless for a page we only read, and clearing
     * its `optedOut` would leave it unread. Reading a removed page again is the dashboard's Add,
     * which re-checks the handle still exists and still posts.
     */
    if (target.role === 'WATCH') {
      console.log(`  @${handle} — a page we WATCH, not a company we message. Nothing done: add it again on /targets to read it.`)
      continue
    }
    if (!target.optedOut) {
      console.log(`  @${handle} — already live. Nothing to do.`)
      continue
    }

    if (!first) await new Promise((r) => setTimeout(r, LOOKUP_SPACING_MS))
    first = false
    const e = await enrichHandle(handle)

    if (!e.reachable) {
      unreachable++
      console.log(`  @${handle} — could not be read (${e.reason ?? 'no reason given'}). STAYS RETIRED; a timeout is never a verdict.`)
      /* Being told to stop is the one signal that ends the run. Continuing after a 429 is
         what turns throttling into an IP block. */
      if ((e.reason ?? '').includes('429')) {
        console.log('\n  429 from Instagram — halting the run rather than hammering the endpoint.')
        break
      }
      continue
    }

    const admits = admitsAsTalent(
      { isVerified: e.isVerified, followerCount: e.followers },
      settings.celebrityMinFollowers,
    )
    const badge = e.isVerified === true ? 'verified' : e.isVerified === false ? 'UNVERIFIED' : 'no badge answer'
    const name = e.fullName ?? target.displayName

    console.log(
      `  @${target.handle}  "${name}"  ${badge}` +
        `  cat=${JSON.stringify(target.brandCategory ?? '(none)')}` +
        `  → ${admits ? 'UN-RETIRE' : 'stays retired'}${run ? '' : '   [dry run]'}`,
    )

    if (!run) {
      if (!admits) refused++
      continue
    }

    /**
     * The facts are persisted EITHER WAY. A refusal recorded is a refusal a person can see
     * and a later pass need not re-spend a lookup on; a NULL left in place is the state
     * this whole command exists because of.
     */
    await prisma.targetAccount.update({
      where: { id: target.id },
      data: {
        isVerified: e.isVerified,
        followerCount: e.followers ?? undefined,
        /* Only correct the stored name when Instagram gave us one — `body.user` identity,
           2026-08-23. Never blank a name we already hold. */
        ...(e.fullName ? { displayName: e.fullName } : {}),
        ...(admits ? { optedOut: false, campaignTalent: true } : {}),
      },
    })
    await prisma.auditLog.create({
      data: {
        actor,
        action: admits ? 'target.unretired' : 'target.unretire.refused',
        entity: `TargetAccount:${target.id}`,
        detail: admits
          ? `@${target.handle} back in the rotation: ${reason} — badge re-read now and it is VERIFIED (${name}); campaignTalent set, so the person guard admits them the way the talent door would today`
          : `@${target.handle} STAYS retired: badge re-read now and it is ${badge} — VERIFIED ONLY refuses anything but a confirmed badge`,
      },
    })
    if (admits) restored++
    else refused++
  }

  if (!run) {
    console.log(`\nDRY RUN. Re-run with --run to apply. ${refused} of these would stay retired.`)
    console.log('Badges were still read live — the answers above are real, only the writes are withheld.')
    return
  }
  console.log(
    `\nRestored ${restored} target(s); ${refused} stayed retired on the badge; ${unreachable} unreadable.`,
  )
  console.log('No draft or pair was written here. The planner creates routes on its next pass')
  console.log('(every 15 minutes) and every rule — verified, allowance, ring, reply halt — still applies.')
}

main()
  .catch((e) => {
    console.error(e)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
