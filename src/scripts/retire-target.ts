import 'dotenv/config'
import { prisma } from '@/lib/db'
import { env } from '@/lib/env'

/**
 * `pnpm ig:retire-target <handle> [<handle>...]` — mark a target NEVER TO BE CONTACTED.
 * DRY RUN BY DEFAULT.
 *
 * ── WHY THIS EXISTS AS A COMMAND ──────────────────────────────────────────
 *
 * Retiring a target was reachable only from the dashboard (`removeTarget`, which opens with
 * `requireOperator()` and ends in `revalidatePath`, so a terminal cannot call it). The need
 * arises from a terminal: `pnpm ig:brands --run` is the command that CREATES prospects, it
 * must be run from a home IP, and it is wrong some of the time.
 *
 * MEASURED on the run of 2026-08-17: of 18 new BRAND targets, **@ananyapanday — an actress
 * with 26.3M followers — arrived with three live routes**, because Instagram reports her
 * category as "Private Investigator" and the person-role list is an enumeration over an open
 * taxonomy. A media-buying pitch to a private individual from a revenue account is the exact
 * failure `decideBrand`'s asymmetry is written around, and until now the only way to undo it
 * from a terminal was to edit the database by hand — which is how 21 ground-truth labels got
 * poisoned in August.
 *
 * ── IT RETIRES, IT NEVER DELETES ──────────────────────────────────────────
 *
 * `optedOut: true` is the hard stop `routes.ts` refuses on and `gate.ts` re-checks at
 * delivery, and it is a flag on the TARGET rather than a missing pair row on purpose:
 * `ensureFleetPairs` recreates every allowed route at the top of each pass, so a promise
 * carried by a deleted row would survive exactly one run.
 *
 * Deleting would also cascade. `OutreachAttempt.pairId` is `ON DELETE CASCADE`, so removing
 * a pair erases the record of messages real people received — which spacing, the
 * unanswered-touch cap and the new-material rule are all derived from.
 *
 * ── WAITING DRAFTS ARE REPORTED, NOT SILENTLY LEFT ────────────────────────
 *
 * Retiring blocks future sends; it does not tidy the queue. A draft already written to this
 * recipient stays READY and is refused by the gate's `target-opted-out` stop — correct, and
 * invisible unless it is said out loud, so the count is printed and `ig:discard-stale-drafts`
 * named as the way to clear it.
 */

const args = process.argv.slice(2)
const run = args.includes('--run')

const reasonArg = args.indexOf('--reason')
const reason = reasonArg >= 0 ? (args[reasonArg + 1] ?? '') : 'not a media buyer — retired by hand'

/**
 * ── A FLAG'S VALUE IS NOT A HANDLE, AND THE FIRST VERSION THOUGHT IT WAS ──
 *
 * FOUND BY RUNNING IT. Filtering on `!a.startsWith('--')` keeps the string AFTER `--reason`,
 * so the dry run went looking for a target called "not a media buyer: a person or a
 * charity...". It reported "no such target", which is the safe direction and pure luck: the
 * same parse with `--reason bollywoodchronicle` would have offered to retire a real account.
 *
 * The value's INDEX is skipped rather than its content being sniffed, because "does this
 * look like a handle" is a guess, and this repo's rule is that an unparseable handle is
 * refused rather than repaired.
 */
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
    console.error('Usage: pnpm ig:retire-target <handle> [<handle>...] [--reason "..."] [--run]')
    process.exitCode = 1
    return
  }

  let retired = 0
  for (const handle of handles) {
    const target = await prisma.targetAccount.findUnique({
      where: { handle },
      select: {
        id: true, handle: true, displayName: true, kind: true, role: true,
        optedOut: true, brandCategory: true,
        attempts: { select: { status: true } },
      },
    })

    if (!target) {
      console.log(`  @${handle} — no such target. Nothing done.`)
      continue
    }
    /**
     * A WATCHED PAGE IS NOT RETIRED FROM HERE (2026-10-09). This sets `optedOut` alone, which
     * for a page we READ leaves its feed being read with its footage skipped — the half-broken
     * state the schema warns about. The dashboard's Remove retires a watched page properly
     * (stops reading it, keeps its posts, keeps it on the competitor list).
     */
    if (target.role === 'WATCH') {
      console.log(
        `  @${handle} — a page we WATCH, not a company we message. Nothing done: use "Remove this channel" ` +
          `on /targets, which also stops reading it and keeps its posts.`,
      )
      continue
    }
    if (target.optedOut) {
      console.log(`  @${handle} — already retired. Nothing to do.`)
      continue
    }

    const waiting = target.attempts.filter((a) => a.status === 'READY' || a.status === 'QUEUED').length
    const delivered = target.attempts.filter((a) => a.status === 'SENT' || a.status === 'REPLIED').length

    console.log(
      `  @${target.handle}  ${target.kind}/${target.role}  ${JSON.stringify(target.brandCategory ?? '(no category)')}` +
        `  delivered=${delivered} waiting=${waiting}${run ? '' : '   [dry run]'}`,
    )

    /**
     * A DELIVERED MESSAGE IS THE ONE THING THAT CHANGES THE ADVICE. Retiring still works and
     * is still right, but somebody has already received a pitch, so this is a live
     * conversation being closed rather than a mistake being undone. Said out loud rather
     * than refused: the promise `optedOut` makes is exactly the one wanted here.
     */
    if (delivered > 0) {
      console.log(`      note: ${delivered} message(s) have already been DELIVERED to this recipient.`)
    }
    if (waiting > 0) {
      console.log(`      note: ${waiting} draft(s) are waiting. The gate refuses them as target-opted-out;`)
      console.log(`            clear them with pnpm ig:discard-stale-drafts, or leave them to be refused.`)
    }

    if (!run) continue

    await prisma.targetAccount.update({ where: { id: target.id }, data: { optedOut: true } })
    await prisma.auditLog.create({
      data: {
        actor,
        action: 'target.retired',
        entity: `TargetAccount:${target.id}`,
        detail: `@${target.handle} retired: ${reason} (category was ${JSON.stringify(target.brandCategory ?? null)})`,
      },
    })
    retired++
  }

  if (!run) {
    console.log(`\nDRY RUN. Re-run with --run to retire. Nothing is ever deleted — send history is kept.`)
    return
  }
  console.log(`\nRetired ${retired} target(s). They can never be contacted again by any sender.`)
}

main()
  .catch((e) => {
    console.error(e)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
