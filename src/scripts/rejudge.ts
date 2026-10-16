import 'dotenv/config'
import { prisma } from '@/lib/db'
import { runRejudge } from '@/detection/rejudgeCommand'

/**
 * `pnpm ig:rejudge` — drain the backlog of posts whose footage was read and never reached a
 * verdict, and (16 Oct 2026) of posts judged with no frame whose frame is on this machine now —
 * the official read's shrunk frames, or ones `pnpm ig:frames --capture` fetched. DRY RUN BY
 * DEFAULT, because `--run` spends money.
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
 * `skipped` in the report below tells you which is happening, and the reasons are separated
 * because they have different remedies — including (16 Oct 2026) a post whose frame IS here and
 * whose reading gave no verdict, which is never told its frame is elsewhere, and a post a person
 * labelled while it was being judged, whose answer stands (the write is conditional on it).
 *
 * ── AND NEVER BESIDE THE WORKER (16 Oct 2026) ─────────────────────────────
 *
 * On the box it refuses while the detection worker runs there — dry run included, because the
 * dry run does the same OCR reads and classifier calls — and prints the detached line that stops
 * the worker, runs it, and starts the worker again. The reasoning and the logic are in
 * src/detection/rejudgeCommand.ts, so the tests drive the real thing.
 *
 * ── WHAT THE BACKLOG ACTUALLY WAS, MEASURED 2026-08-17 ────────────────────
 *
 * All 83 rows carrying `frame:call-failed` had a caption under 15 characters, and all 83
 * carried frame text. NOT ONE was a failed call: `classifyCaption`'s caption-length floor
 * vetoed a call whose input was the caption AND the footage, returned null, and the caller
 * wrote that null down as a failure. The floor now asks whether there is any evidence at
 * all, which is what its own docblock always said it meant.
 */

async function main(): Promise<void> {
  process.exitCode = await runRejudge(process.argv.slice(2), { out: (line) => console.log(line) })
}

main()
  .catch((e) => {
    console.error(e)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
