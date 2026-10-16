import { REJUDGE_PER_PASS, rejudgeBacklog, rejudgeUnusedEvidence, type RejudgeBacklog, type RejudgeOptions, type RejudgeSummary } from './rejudge'
import { machineId, pidAliveHere, readSchedulerHeartbeat, workerRunningHere, type SchedulerHeartbeat } from '@/worker/heartbeat'

/**
 * `pnpm ig:rejudge`, as a function the tests can drive (src/scripts/rejudge.ts is the thin CLI).
 *
 * ── IT REFUSES TO JUDGE BESIDE A RUNNING WORKER (review, 16 Oct 2026) ─────────────────────
 *
 * A re-judge is the worker's own heavy work: every post is an OCR read (a RapidOCR child on the box)
 * plus one or two classifier calls (judge.ts — the second look on a rule detector, then the footage).
 * The worker's own pass does exactly this at the end of every detection pass, newest first, 10 at a
 * time — and this command also goes newest first. So beside a running worker it would be a SECOND
 * OCR child on the 961 MB box (CLAUDE.md rule 16: one OCR child at a time; OCR runs measured dying
 * under this kind of load, 8 Sept, leaving `frame:ocr-failed`) and would judge the same newest posts
 * twice, paying for each twice. The first version of DEPLOY.md told a person to run it with the
 * worker up, and nothing stopped them. Now it refuses — the dry run TOO, because the dry run DECIDES
 * exactly as `--run` does (rejudge.ts) and so costs exactly the same; only the write is withheld —
 * and hands back the one DETACHED line that stops the worker, runs it, and starts the worker again,
 * the same shape as `ig:backfill`'s (`setsid`, so a closing console cannot strand the worker stopped).
 * Before refusing it still prints what is waiting, counted without judging anything (`rejudgeBacklog`:
 * a query and a stat per row — no child, no model call).
 *
 * "Running on this host" is `workerRunningHere` (worker/heartbeat.ts), the same check `ig:backfill`
 * asks. A laptop reading the server's database sees the SERVER's beat, names another machine, and
 * runs — where it will leave every row whose frame is not on the laptop alone, as rejudge.ts records.
 *
 * NOT GUARDED HERE: a detached `ig:backfill --run` already in progress (the worker is stopped then,
 * so the heartbeat says nothing). docs/DEPLOY.md opens its frames section with the check for that,
 * and `deploy-worker-on-box.sh` refuses while one runs.
 *
 * ── AND IT SAYS WHAT IT LEFT BEHIND ─────────────────────────────────────────────────────────
 *
 * The detection pass reaches only the newest 1,000 `frame:not-saved` rows (rejudge.ts,
 * `RECOVERY_SCAN_PER_PASS`), and the cutoff is a fixed date, so an older post whose frame a person
 * fetched with `ig:frames --capture` may never be reached by a pass. This command scans the whole
 * population and prints how many such posts it did not reach, so "repeat until it reads 0" is a
 * number on screen rather than a guess.
 */

export const REJUDGE_DEFAULT_LIMIT = 200
/** A person draining on purpose scans the whole `frame:not-saved` population, not the pass's window. */
export const REJUDGE_FULL_SCAN = 100_000
export const REJUDGE_LOG = '/tmp/ig-rejudge.log'

export interface RejudgeArgs {
  run: boolean
  limit: number
}

/** PURE. `--run`, `--limit N` (default 200). A limit that is not a positive whole number is refused. */
export function parseRejudgeArgs(argv: readonly string[]): RejudgeArgs | { refused: string } {
  const run = argv.includes('--run')
  const at = argv.indexOf('--limit')
  const limit = at >= 0 ? Number(argv[at + 1]) : REJUDGE_DEFAULT_LIMIT
  if (!Number.isInteger(limit) || limit <= 0) return { refused: '--limit must be a positive whole number' }
  return { run, limit }
}

/** The command for these arguments, as a person would type it. */
export function rejudgeCommandLine(args: RejudgeArgs): string {
  return `pnpm ig:rejudge${args.run ? ' --run' : ''} --limit ${args.limit}`
}

/**
 * The line to run instead, on ONE line (the box's console mangles multi-line pastes), DETACHED for
 * the reason `stopRunStartLine` in backfill.ts records: a hangup measured killing the run and the
 * shell before `pm2 start` ran. `;` before the start, so the worker comes back however the run ends.
 */
export function rejudgeStopRunStartLine(args: RejudgeArgs): string {
  return (
    `setsid sh -c 'pm2 stop ds-sales-worker && ${rejudgeCommandLine(args)}; pm2 start ds-sales-worker' ` +
    `> ${REJUDGE_LOG} 2>&1 < /dev/null & tail -F ${REJUDGE_LOG}`
  )
}

const DETACHED_NOTE =
  'It runs detached — closing this console does not stop it or leave the worker stopped; Ctrl-C stops only the tail. ' +
  'While it runs the worker is stopped: no detection, no drafting, no slots. Then check the worker came back: pm2 describe ds-sales-worker'

/**
 * NOT MEASURED for a re-judge. A backfilled post — which does strictly more per post (a feed read
 * and a frame download as well) — was measured at ~7 s on the box (8 Sept), so this is a ceiling a
 * person can plan the worker's downtime by, stated as an estimate.
 */
const SECONDS_PER_POST_CEILING = 7

export interface RejudgeIo {
  out: (line: string) => void
  readHeartbeat?: () => Promise<SchedulerHeartbeat | null>
  machine?: () => string
  alive?: (pid: number) => boolean
  now?: () => number
  rejudge?: (opts: RejudgeOptions) => Promise<RejudgeSummary>
  backlog?: (opts: { recoveryScan?: number }) => Promise<RejudgeBacklog>
}

function backlogLine(b: RejudgeBacklog): string {
  return (
    `Waiting: ${b.failedCalls} post(s) carrying frame:call-failed or frame:ocr-failed; ` +
    `${b.scanComplete ? '' : 'at least '}${b.recoverableHere} judged with no frame whose frame is on this machine now.`
  )
}

/** Exit codes: 0 done; 1 bad arguments; 2 refused before judging anything. */
export async function runRejudge(argv: readonly string[], io: RejudgeIo): Promise<number> {
  const out = io.out
  const parsed = parseRejudgeArgs(argv)
  if ('refused' in parsed) {
    out(parsed.refused)
    return 1
  }
  const args = parsed

  const refuse = async (why: string): Promise<number> => {
    try {
      out(backlogLine(await (io.backlog ?? rejudgeBacklog)({ recoveryScan: REJUDGE_FULL_SCAN })))
    } catch (err) {
      out(`(could not count what is waiting: ${err instanceof Error ? err.message : String(err)})`)
    }
    out(why)
    out(`Nothing was judged and nothing was written. Run this instead, as one line (about ${Math.ceil((args.limit * SECONDS_PER_POST_CEILING) / 60)} minutes or less for --limit ${args.limit} — not measured; ~${SECONDS_PER_POST_CEILING} s a post is the backfill's figure, which does more per post):`)
    out(rejudgeStopRunStartLine(args))
    out(DETACHED_NOTE)
    return 2
  }

  let beat: SchedulerHeartbeat | null
  try {
    beat = await (io.readHeartbeat ?? readSchedulerHeartbeat)()
  } catch (err) {
    const why = err instanceof Error ? err.message.split('\n').map((l) => l.trim()).filter(Boolean).pop() ?? err.name : String(err)
    return refuse(`Refusing: the scheduler heartbeat could not be read (${why}), so a worker running on this host cannot be ruled out.`)
  }
  // MUTATION (applied once, seen red, restored): deleting this refusal fails
  // tests/rejudge-command.test.ts "refuses beside a worker running on this host…".
  const worker = workerRunningHere({ beat, nowMs: (io.now ?? Date.now)(), machine: (io.machine ?? machineId)(), alive: io.alive ?? pidAliveHere })
  if (worker) {
    return refuse(
      worker.kind === 'unnamed'
        ? `A detection worker that names no machine beat ${worker.ago} (pid ${worker.pid}) — it may be on this host, and its pid cannot be checked from here. Refusing; the beat goes stale three minutes after it stops.`
        : `The detection worker is running on this host (pid ${worker.pid}, last heartbeat ${worker.ago}). Its own pass re-judges these, newest first, ${REJUDGE_PER_PASS} at a time; judging beside it would be a second OCR child on a 961 MB box and would judge — and pay for — the same newest posts twice. Refusing.`,
    )
  }

  const summary = await (io.rejudge ?? rejudgeUnusedEvidence)({ limit: args.limit, dryRun: !args.run, recoveryScan: REJUDGE_FULL_SCAN })

  out('')
  out(
    `Examined ${summary.examined} post(s) (bound ${args.limit}; a detection pass uses ${REJUDGE_PER_PASS}): ` +
      `${summary.examined - summary.recoveredFrames} carrying frame:call-failed or frame:ocr-failed, ` +
      `${summary.recoveredFrames} judged with no frame whose frame is on this machine now.`,
  )
  out('')
  /**
   * One sentence per reason a row was left alone, each true about its reason (rejudge.ts). A
   * RECOVERED row was selected because its frame IS on this machine, so it never gets the "not on
   * THIS machine" sentence (review, 16 Oct 2026). MUTATION (applied once, seen red, restored):
   * folding `skippedFrameHereNoVerdict` back into the first line fails tests/rejudge-command.test.ts
   * "a recovered row that produced no verdict is never told its frame is elsewhere".
   */
  if (summary.skippedNoEvidence > 0) out(`  ${summary.skippedNoEvidence} left alone — the frame is not on THIS machine. Run this where the frames are.`)
  if (summary.skippedCallFailed > 0) out(`  ${summary.skippedCallFailed} left alone — the frame was read here and the classifier did not answer.`)
  if (summary.skippedFrameHereNoVerdict > 0) {
    out(`  ${summary.skippedFrameHereNoVerdict} left alone — frame on disk here, but the reading or the classifier produced no verdict — retried next pass.`)
  }
  if (summary.skippedHumanAnswered > 0) {
    out(`  ${summary.skippedHumanAnswered} not written — a person answered the post on the dashboard while it was being judged; their answer stands.`)
  }
  // `count: 0` is not always a person (rejudge.ts, `skippedRowRemoved`): each other cause has its sentence.
  if (summary.skippedRowRemoved > 0) out(`  ${summary.skippedRowRemoved} not written — the post was removed while it was being judged.`)
  if (summary.skippedWriteUnmatched > 0) {
    out(`  ${summary.skippedWriteUnmatched} not written — the write matched no row, and the post now reads unlabelled; it is offered again next pass.`)
  }

  if (!args.run) {
    const moved = summary.proposals.filter((p) => p.to !== p.from)
    out('')
    out(`WOULD CHANGE ${moved.length} of ${summary.proposals.length} judged:`)
    out('')
    for (const p of moved) {
      out(`  ${p.shortcode}  ${p.from} → ${p.to}   [${p.signals.join(' ')}]`)
      if (p.frameText) out(`      footage: ${JSON.stringify(p.frameText.slice(0, 120))}`)
    }
    if (moved.length === 0) out('  (none — the footage agreed with the caption everywhere)')
    /**
     * The UNCHANGED ones are printed too, and deliberately. A report listing only what it would
     * alter cannot be checked: "the footage agreed" and "the footage was never read" look identical
     * when only changes are shown, and that is the distinction this whole backlog turned out to be about.
     */
    const same = summary.proposals.filter((p) => p.to === p.from)
    if (same.length > 0) out(`\n  ...and ${same.length} judged with no change. Signals seen: ${[...new Set(same.flatMap((s) => s.signals))].join(', ')}`)
    out('')
    out(`DRY RUN. Nothing was written. Roughly $${(summary.proposals.length * 0.00002).toFixed(4)} was spent deciding.`)
  } else {
    out(`Changed ${summary.changed} verdict(s).`)
  }
  out(`Still carrying frame:call-failed or frame:ocr-failed: ${summary.remaining}.`)
  if (summary.recoverableNotReached > 0) {
    out(
      `${summary.recoveryScanComplete ? '' : 'At least '}${summary.recoverableNotReached} more post(s) judged with no frame have their frame on this machine and were not reached — ` +
        `this run judges at most ${args.limit}. The detection pass reaches only the newest 1,000 such rows, so for older ones repeat ` +
        `${args.run ? 'this run' : 'with --run'} until this line is gone.`,
    )
  }
  return 0
}
