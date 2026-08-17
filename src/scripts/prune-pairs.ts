import 'dotenv/config'
import { prisma } from '@/lib/db'
import { mayPrunePair } from '@/outreach/prunePairs'

/**
 * `pnpm ig:prune-pairs` — delete routes that belong to accounts outside the rotation.
 * **DRY RUN BY DEFAULT.**
 *
 * ── WHY THIS IS A COMMAND AND NOT A ONE-OFF SCRIPT ────────────────────────────────────
 *
 * Because a one-off script is how 21 ground-truth labels got poisoned. On 2026-08-08 a
 * bulk CLI wrote `humanLabel: false` to 21 posts — including both founding cases of the
 * footage feature — under `actor: cli:Tabish`, and **that script does not exist in this
 * repo**. There is no way to read what it did, no way to re-run it, and no test that could
 * ever have covered it. Anything that mutates rows in bulk lives here, with a dry run, a
 * pure rule, and an audit row per change.
 *
 * ── WHAT IT REMOVES, AND THE MEASUREMENT BEHIND IT ────────────────────────────────────
 *
 * MEASURED on the live Postgres 2026-08-13: `@tabishmukaddam1` (`fleetMember: false`, the
 * rehearsal account) held **72** `OutreachPair` rows — every discovered BRAND target plus
 * both watched channels. Note the number: CLAUDE.md and the repair plan both say 70, which
 * was measured before the 12 August brand discovery finished landing.
 *
 * They existed because none of the three creators filtered on fleet membership, and
 * `addTarget`'s own comment defended that as protecting "the burner's rehearsal routes".
 * Rehearsal never used them: `prepareOnDemandSend` CREATES the pair it needs when a person
 * picks a sender and a recipient. So 72 live routes existed for the one account that must
 * never do outreach, held back only by `runOutreach` scoping its query — which is exactly
 * the "a pair row IS a live route" problem the 2026-08-08 change was about.
 *
 * `routes.ts` now refuses to create them (`sender-not-in-fleet`), so this is the one-time
 * clean-up of what already exists. Running it twice is harmless and reports nothing to do.
 *
 * ── THE GUARD THAT MATTERS MORE THAN THE CLEAN-UP ─────────────────────────────────────
 *
 * `OutreachAttempt.pairId` is `ON DELETE CASCADE`. The decision to delete is `mayPrunePair`
 * (PURE, tested both ways), and it refuses any pair carrying an attempt of ANY status.
 * 0 of the 72 carry one today; the refusal is a property of the row, not of today's data.
 *
 * The count is re-read INSIDE the same transaction as the delete, not trusted from the
 * survey above it. A count and a delete in two statements is not a guard — the same
 * check-then-write shape that let `sendNow` double-send and let two slots run at once.
 */

const args = process.argv.slice(2)
const run = args.includes('--run')
const actor = `cli:${process.env.OPERATOR_NAME ?? 'operator'}`

async function main() {
  const senders = await prisma.senderAccount.findMany({
    select: { id: true, handle: true, fleetMember: true },
    orderBy: { handle: 'asc' },
  })
  const nonFleet = senders.filter((s) => !s.fleetMember)

  if (nonFleet.length === 0) {
    console.log('Every sending account is in the rotation. Nothing here to clean up.')
    return
  }

  console.log(
    `${nonFleet.length} account(s) outside the rotation: ${nonFleet.map((s) => '@' + s.handle).join(', ')}\n`,
  )

  let prunable = 0
  let deleted = 0
  const refused: string[] = []

  for (const s of nonFleet) {
    const pairs = await prisma.outreachPair.findMany({
      where: { senderId: s.id },
      select: { id: true, target: { select: { handle: true } }, _count: { select: { attempts: true } } },
      orderBy: { target: { handle: 'asc' } },
    })

    if (pairs.length === 0) {
      console.log(`@${s.handle} — no routes. Nothing to do.`)
      continue
    }

    console.log(`@${s.handle} — ${pairs.length} route(s)`)

    for (const p of pairs) {
      const verdict = mayPrunePair({
        senderIsFleetMember: s.fleetMember,
        attemptCount: p._count.attempts,
      })
      if (!verdict.prune) {
        refused.push(`@${s.handle} → @${p.target.handle}: ${verdict.detail}`)
        console.log(`  KEEP    → @${p.target.handle}  (${verdict.refusal})`)
        continue
      }
      prunable++
      if (!run) continue

      /**
       * THE COUNT IS RE-ASKED HERE, INSIDE THE DELETE.
       *
       * `deleteMany` with the attempt-absence in its own `where` makes the check and the
       * write one statement, so an attempt created between the survey and now cannot be
       * cascaded away. `count` is then the honest report of whether it actually went.
       */
      const res = await prisma.outreachPair.deleteMany({
        where: { id: p.id, attempts: { none: {} } },
      })
      if (res.count === 0) {
        refused.push(`@${s.handle} → @${p.target.handle}: an attempt appeared while this was running.`)
        console.log(`  KEEP    → @${p.target.handle}  (history appeared mid-run — left alone)`)
        continue
      }
      deleted++
      await prisma.auditLog.create({
        data: {
          actor,
          action: 'pair.pruned',
          // The pair id, not the handles: the row is gone, so the id is the only thing that
          // can be matched against anything else recorded about it.
          entity: `OutreachPair:${p.id}`,
          detail:
            `removed the route @${s.handle} → @${p.target.handle}: the account is outside the rotation ` +
            `and the route carried no messages`,
        },
      })
    }
    console.log()
  }

  for (const r of refused) console.log(`  kept: ${r}`)

  if (prunable === 0) {
    console.log('No route outside the rotation can be removed. Nothing to do.')
    return
  }

  if (!run) {
    console.log(
      `\nDRY RUN. ${prunable} route(s) would be removed, ${refused.length} kept. Re-run with --run.\n` +
        'Nothing that carries a recorded message is touched, and that refusal is not overridable:\n' +
        'the attempt rows cascade with the pair, and they are what spacing and the unanswered-message\n' +
        'cap are worked out from.\n\n' +
        'BEFORE YOU DO: the routes.ts fix (`sender-not-in-fleet`) must already be DEPLOYED to the\n' +
        'machine that discovers brands and creates targets, or its next pass recreates these rows\n' +
        'and the only lasting effect is the audit trail. Same ordering trap as ig:dedupe-drafts.',
    )
    return
  }

  console.log(`\nRemoved ${deleted} route(s). ${refused.length} kept.`)
}

main()
  .catch((e) => {
    console.error(e)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
