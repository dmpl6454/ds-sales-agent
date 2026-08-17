import 'dotenv/config'
import { prisma } from '@/lib/db'
import { rejudgeUnusedEvidence, REJUDGE_PER_PASS } from '@/detection/rejudge'

/**
 * `pnpm ig:rejudge` — drain the backlog of posts whose footage was read and never reached a
 * verdict. DRY RUN BY DEFAULT, because `--run` spends money.
 *
 * ── WHY A DELIBERATE COMMAND AND NOT JUST A BIGGER BOUND ──────────────────
 *
 * `rejudgeUnusedEvidence` runs at the end of every detection pass, bounded at
 * REJUDGE_PER_PASS so a detection pass stays cheap. A person draining a backlog on purpose
 * is a different act with a different budget — the same split as `ig:brands --run` against
 * the bounded automatic resolve pass, and the same reason `ig:classify` exists beside the
 * pipeline that classifies.
 *
 * ── RUN IT WHERE THE FRAMES ARE ───────────────────────────────────────────
 *
 * Frame stores are PER MACHINE and this writes to a database BOTH hosts share. A pass run
 * from a laptop cannot read frames that live on the server, and `rejudgeUnusedEvidence`
 * correctly leaves those rows alone rather than recording a fact about the wrong disk.
 * `skipped` in the report below tells you which is happening, and the two reasons are
 * separated because they have different remedies.
 *
 * ── WHAT THE BACKLOG ACTUALLY WAS, MEASURED 2026-08-17 ────────────────────
 *
 * All 83 rows carrying `frame:call-failed` had a caption under 15 characters, and all 83
 * carried frame text. NOT ONE was a failed call: `classifyCaption`'s caption-length floor
 * vetoed a call whose input was the caption AND the footage, returned null, and the caller
 * wrote that null down as a failure. The floor now asks whether there is any evidence at
 * all, which is what its own docblock always said it meant.
 */

const args = process.argv.slice(2)
const run = args.includes('--run')
const limitArg = args.indexOf('--limit')
const limit = limitArg >= 0 ? Number(args[limitArg + 1]) : 200

async function main(): Promise<void> {
  if (!Number.isFinite(limit) || limit <= 0) {
    console.error('--limit must be a positive whole number')
    process.exitCode = 1
    return
  }

  const summary = await rejudgeUnusedEvidence({ limit, dryRun: !run })

  console.log(`\nExamined ${summary.examined} post(s) carrying frame:call-failed (bound ${limit}; a detection pass uses ${REJUDGE_PER_PASS}).\n`)

  if (summary.skippedNoEvidence > 0) {
    console.log(`  ${summary.skippedNoEvidence} left alone — the frame is not on THIS machine. Run this where the frames are.`)
  }
  if (summary.skippedCallFailed > 0) {
    console.log(`  ${summary.skippedCallFailed} left alone — the frame was read here and the classifier did not answer.`)
  }

  if (!run) {
    const moved = summary.proposals.filter((p) => p.to !== p.from)
    console.log(`\nWOULD CHANGE ${moved.length} of ${summary.proposals.length} judged:\n`)
    for (const p of moved) {
      console.log(`  ${p.shortcode}  ${p.from} → ${p.to}   [${p.signals.join(' ')}]`)
      if (p.frameText) console.log(`      footage: ${JSON.stringify(p.frameText.slice(0, 120))}`)
    }
    if (moved.length === 0) console.log('  (none — the footage agreed with the caption everywhere)')

    /**
     * The UNCHANGED ones are printed too, and deliberately. A report listing only what it
     * would alter cannot be checked: "the footage agreed" and "the footage was never read"
     * look identical when only changes are shown, and that is the distinction this whole
     * backlog turned out to be about.
     */
    const same = summary.proposals.filter((p) => p.to === p.from)
    if (same.length > 0) {
      console.log(`\n  ...and ${same.length} judged with no change. Signals seen: ${[...new Set(same.flatMap((s) => s.signals))].join(', ')}`)
    }

    console.log(`\nDRY RUN. Re-run with --run to write these. Roughly $${(summary.proposals.length * 0.00002).toFixed(4)} was spent deciding.`)
    console.log(`Still carrying frame:call-failed: ${summary.remaining}.`)
    return
  }

  console.log(`Changed ${summary.changed} verdict(s). Still carrying frame:call-failed: ${summary.remaining}.`)
}

main()
  .catch((e) => {
    console.error(e)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
