/**
 * backfill.ts — `pnpm ig:backfill`: read a blind stretch back through the official read (16 Oct 2026).
 *
 * ── WHY IT EXISTS ─────────────────────────────────────────────────────────────────────────────
 *
 * The anonymous feed was walled for a day and more before the official fallback was deployed, so
 * the first official pass read 6 hours and every pass since has stopped at the newest stored post
 * (officialReach.ts has the measurement). The gap is now in the MIDDLE of each channel's history:
 * its newest stored post is fresh, so the automatic gap rule cannot see it, and the slot's 36-hour
 * catch-up stops at the newest stored post too. Business Discovery pages back through a channel's
 * whole history, so those posts are still readable — and a paid post missed is a message a
 * recipient is owed under the 7-day material allowance. This command reads every watched channel
 * back N hours through the official read and stores what is missing.
 *
 * ── DRY RUN BY DEFAULT, AND THE DRY RUN WRITES NOTHING — STRUCTURALLY ────────────────────────
 *
 * Like `ig:classify` and `ig:brands`: without `--run` it only reports. It reads each channel through
 * `fetchFeedViaGraph` with `record: false` (no feed-answer evidence row — that row is the detection
 * pass's), counts which shortcodes are not already stored, and prints. No `DetectedCampaign` row, no
 * Setting row, no frame, no classifier call, no anonymous request — so no anonymous gate is spent.
 * Held by construction rather than by care: THIS MODULE DOES NOT IMPORT THE DETECTION PASS
 * (`./pipeline` appears only as a type import, which is erased), nor the frame store, the judge,
 * the detectors or `setSetting`. `--run` receives the pass as an injected function, and the command
 * line (src/scripts/backfill.ts) loads `pipeline.ts` only inside it. `tests/backfill.test.ts` holds
 * both halves: the import list as a source grep, and a dry run against a real database that leaves
 * every table as it found it.
 *
 * ── `--run` IS AN ORDINARY DETECTION PASS, AND REFUSES BESIDE THE WORKER ─────────────────────
 *
 * It calls `runDetection({ officialBackfillHours: N })` — no new write path: a backfilled post is
 * judged, framed and stored with its incomplete marker exactly as any official read stores it. The
 * pass asks the official API ONLY (feedSource.ts `officialOnly`): the anonymous door is not deepened
 * and not asked, so a channel the anonymous feed would answer is still backfilled, the run reads
 * through the same door as its dry run, and no anonymous request is spent. It REFUSES while the
 * worker runs on this host: the box has 961 MB, two detection processes means two RapidOCR children
 * and two tsx heaps (CLAUDE.md rule 16: one OCR child at a time), and a long backfill overlapping the
 * 15-minute pass would judge the same new posts twice. So the refusal hands back the one line that
 * stops the worker for the run and starts it again after — DETACHED (`setsid`), because a run of an
 * hour or more with the worker stopped must survive the console going away (see `stopRunStartLine`).
 * A heartbeat from ANOTHER machine (the Mac's), a stale one, or one whose pid is dead does not block —
 * `pm2 stop` leaves a fresh beat behind for up to three minutes, and its pid is what tells a stopped
 * worker from a running one.
 *
 * ── A CAPPED RUN IS FINISHED BY NAMING ITS CHANNELS (review, 16 Oct 2026) ──────────────────
 *
 * A week of history is more than one run's 200 calls (officialReach.ts has the arithmetic), and a
 * bare re-run would read in the same handle order and spend the same calls on the same head. So
 * `--channel <handle>` (repeatable) reads just the named watched channels, and every report prints
 * the exact line that re-reads only the channels a re-run can finish — apart from the ones a re-run
 * cannot help (a personal account, a token to replace, the per-channel bound), listed on their own.
 */
import { prisma } from '@/lib/db'
import { fetchFeedViaGraph, graphConfig, graphConfigured, scrub, type GraphBudget } from './graphFeed'
import {
  BACKFILL_MAX_HOURS,
  BACKFILL_SECONDS_PER_POST,
  GRAPH_BACKFILL_CALL_CAP,
  GRAPH_BACKFILL_MAX_PAGES,
  GRAPH_BACKFILL_MAX_POSTS,
  WATCHED_CHANNEL_WHERE,
  backfillFloorFor,
  isValidBackfillHours,
  officialShortfall,
  type OfficialReach,
} from './officialReach'
import { channelSummaryLine, frameShrinkLine, passSummaryLine } from './detectionReport'
import { machineId, pidAliveHere, readSchedulerHeartbeat, workerRunningHere, type SchedulerHeartbeat } from '@/worker/heartbeat'
import type { ChannelOutcome, DetectionSummary } from './pipeline'

// ── The command line (PURE) ──────────────────────────────────────────────────────────────────

export const BACKFILL_USAGE = [
  'pnpm ig:backfill --hours N          DRY RUN: read every watched channel back N hours through the official API',
  '                                    and say how many posts are not stored. Writes nothing.',
  'pnpm ig:backfill --hours N --run    store them, through an ordinary detection pass. Refuses while the worker',
  '                                    runs on this host — it prints the one line that stops it for the run.',
  '  --channel <handle>                (repeatable) read only these watched channels — how a run the call cap',
  '                                    cut short is finished; the report prints the line.',
  '',
  `N is a whole number of hours from 1 to ${BACKFILL_MAX_HOURS} (the 7-day material window). Needs META_GRAPH_TOKEN`,
  "and META_IG_USER_ID in this host's .env (docs/DEPLOY.md, \"Official read fallback\").",
].join('\n')

export interface BackfillPlan {
  hours: number
  run: boolean
  /** Only these watched channels; empty means every watched channel. */
  channels?: string[]
}

export type BackfillArgs = { kind: 'run'; plan: BackfillPlan } | { kind: 'help' } | { kind: 'refused'; why: string }

const HOURS_SENTENCE = `--hours is required: how many hours back to read, a whole number from 1 to ${BACKFILL_MAX_HOURS} (the 7-day material window) — for example pnpm ig:backfill --hours 48.`

/** An Instagram handle as this repo stores it: lower case, letters, digits, `.` and `_`, at most 30. */
const HANDLE_RE = /^[a-z0-9._]{1,30}$/

/** PURE. `--hours N` or `--hours=N`, `--run`, `--channel H` (repeatable), `--help`. Anything else is refused with a sentence, never guessed. */
export function parseBackfillArgs(argv: readonly string[]): BackfillArgs {
  let hoursText: string | null = null
  let run = false
  const channels: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === '--help' || a === '-h') return { kind: 'help' }
    if (a === '--run') {
      run = true
      continue
    }
    if (a === '--hours' || a.startsWith('--hours=')) {
      if (hoursText !== null) return { kind: 'refused', why: '--hours was given twice; give it once.' }
      const v = a === '--hours' ? argv[++i] : a.slice('--hours='.length)
      if (v === undefined || v === '') return { kind: 'refused', why: HOURS_SENTENCE }
      hoursText = v
      continue
    }
    if (a === '--channel' || a.startsWith('--channel=')) {
      const v = a === '--channel' ? argv[++i] : a.slice('--channel='.length)
      // An @ is how a person writes a handle; it is not part of one. Never lower-cased into a
      // different account: a handle with capitals is refused, because stored handles have none.
      const handle = (v ?? '').replace(/^@/, '')
      if (!HANDLE_RE.test(handle)) {
        return { kind: 'refused', why: `--channel ${v ?? ''} is not an Instagram handle as stored here (lower case letters, digits, "." and "_") — for example --channel viralbhayani.` }
      }
      if (!channels.includes(handle)) channels.push(handle)
      continue
    }
    return { kind: 'refused', why: `${a} is not an option of ig:backfill — it takes --hours N, --channel <handle> and, to store, --run.` }
  }
  if (hoursText === null) return { kind: 'refused', why: HOURS_SENTENCE }
  // Digits only: "48h", "1e2", " 48" and "48.0" are refused rather than read as something nobody typed.
  const hours = /^\d+$/.test(hoursText) ? Number(hoursText) : NaN
  if (!isValidBackfillHours(hours)) {
    return { kind: 'refused', why: `--hours ${hoursText} is not a whole number of hours from 1 to ${BACKFILL_MAX_HOURS} (the 7-day material window).` }
  }
  return { kind: 'run', plan: { hours, run, ...(channels.length > 0 ? { channels } : {}) } }
}

/** Where the detached run writes, so a person can follow it and read it back after. */
export const BACKFILL_LOG = '/tmp/ig-backfill.log'

/** The dry-run command for these hours and channels, as a person would type it. */
export function backfillCommand(hours: number, channels: readonly string[] = [], run = false): string {
  return `pnpm ig:backfill --hours ${hours}${channels.map((c) => ` --channel ${c}`).join('')}${run ? ' --run' : ''}`
}

/**
 * The line to run instead, on ONE line: the operator's console on the box mangles multi-line pastes.
 *
 * DETACHED, because the session going away must not strand the worker (review, 16 Oct 2026). A run
 * is an hour or more of OCR and classifier calls with the worker stopped — and with it detection,
 * drafting and the four slots. The first version, `pm2 stop … && pnpm ig:backfill … ; pm2 start …`,
 * restarted the worker after a failure or a Ctrl-C, but MEASURED with an interactive bash in a pty,
 * a hangup (the console closing) killed the run AND the shell before `pm2 start` ran. `setsid sh -c`
 * puts the stop, the run and the start in a session of their own that a hangup cannot reach, with
 * the output in BACKFILL_LOG; `tail -F` follows it, and Ctrl-C stops only the tail. `;` before the
 * start, not `&&`, so the worker comes back however the run ends — and the run itself still refuses
 * if the stop did not take (the heartbeat check below).
 */
export function stopRunStartLine(hours: number, channels: readonly string[] = []): string {
  return (
    `setsid sh -c 'pm2 stop ds-sales-worker && ${backfillCommand(hours, channels, true)}; pm2 start ds-sales-worker' ` +
    `> ${BACKFILL_LOG} 2>&1 < /dev/null & tail -F ${BACKFILL_LOG}`
  )
}

/** What the person is told beside that line, every time it is printed. */
const DETACHED_NOTE = `It runs detached — closing this console does not stop it or leave the worker stopped; Ctrl-C stops only the tail. Then check the worker came back: pm2 describe ds-sales-worker`

// ── The worker check (PURE) ──────────────────────────────────────────────────────────────────

/** Moved to the heartbeat module with `workerRunningHere` (16 Oct 2026); re-exported for this file's callers. */
export { pidAliveHere }

/**
 * PURE. Why `--run` must not start, or null when it may. What "the worker is running on this host"
 * means is `workerRunningHere` (worker/heartbeat.ts) — shared with `ig:rejudge`, so the two commands
 * cannot disagree about it; its docblock carries the reasoning (a fresh beat naming this machine with
 * a live pid; a fresh beat naming no machine, on freshness alone). This adds the backfill's sentence.
 */
export function backfillRunBlocker(input: {
  beat: SchedulerHeartbeat | null
  nowMs: number
  machine: string
  alive: (pid: number) => boolean
  hours: number
}): string | null {
  const worker = workerRunningHere(input)
  if (!worker) return null
  if (worker.kind === 'unnamed') {
    return (
      `A detection worker that names no machine beat ${worker.ago} (pid ${worker.pid}) — it may be on this host, and its pid cannot be checked ` +
      'from here. Refusing; the beat goes stale three minutes after it stops. Run this instead, as one line:'
    )
  }
  return (
    `The detection worker is running on this host (pid ${worker.pid}, last heartbeat ${worker.ago}). ` +
    'A backfill beside it would be a second detection process on a 961 MB box — two OCR children, two heaps — overlapping its ' +
    '15-minute pass and judging the same posts twice. Refusing. Run this instead, as one line:'
  )
}

// ── The dry run ──────────────────────────────────────────────────────────────────────────────

export interface PreviewRow {
  handle: string
  /** Posts read that were published inside the window. */
  inWindow: number
  /** Of those, how many have no `DetectedCampaign` row — what `--run` would store. */
  notStored: number
  /** Official calls this channel cost. */
  calls: number
  /** `read`: reached the floor (or the channel's whole history). `short`: cut short — the counts are a floor. `not-read`: no answer. */
  status: 'read' | 'short' | 'not-read'
  /** Whether a re-run can finish what this row did not (`short` / `not-read`). */
  rerun?: boolean
  why?: string
}

export interface BackfillPreview {
  hours: number
  sinceUnix: number
  rows: PreviewRow[]
  calls: number
  cap: number
  channels: string[]
}

/**
 * Read every watched channel (or the named ones) back `hours` through the official API and count
 * what is not stored. Reads only: `fetchFeedViaGraph` with `record: false`, one grouped query for
 * each channel's newest stored post (so the window is the one the run will store — `backfillFloorFor`),
 * and one `findMany` of shortcodes per channel. Spends official calls — from its own budget of
 * GRAPH_BACKFILL_CALL_CAP, so a dry run predicts what a run would read — and those count against
 * Meta's hourly budget like any others, the running worker's included (said on screen).
 */
export async function previewBackfill(
  hours: number,
  deps: { nowMs: number; channels?: readonly string[]; delayMs?: number; sleep?: (ms: number) => Promise<void> },
): Promise<BackfillPreview> {
  const nowUnix = Math.floor(deps.nowMs / 1000)
  const sinceUnix = nowUnix - hours * 3600
  const budget: GraphBudget = { remaining: GRAPH_BACKFILL_CALL_CAP, used: 0, dropped: 0 }
  const token = graphConfig()?.token ?? ''
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const gap = deps.delayMs ?? 2500
  const channels = [...(deps.channels ?? [])]
  const targets = await prisma.targetAccount.findMany({
    where: channels.length > 0 ? { ...WATCHED_CHANNEL_WHERE, handle: { in: channels } } : WATCHED_CHANNEL_WHERE,
    orderBy: { handle: 'asc' },
    select: { id: true, handle: true },
  })
  const newestStored = new Map<string, number>()
  for (const row of await prisma.detectedCampaign.groupBy({ by: ['targetId'], _max: { postedAt: true } })) {
    const at = row._max.postedAt
    if (at) newestStored.set(row.targetId, Math.floor(at.getTime() / 1000))
  }

  const rows: PreviewRow[] = []
  for (const [i, t] of targets.entries()) {
    if (budget.remaining <= 0) {
      rows.push({ handle: t.handle, inWindow: 0, notStored: 0, calls: 0, status: 'not-read', rerun: true, why: `the dry run's call cap (${GRAPH_BACKFILL_CALL_CAP}) was spent before it` })
      continue
    }
    // Spaced like the pages inside one channel — politeness to an hourly budget, not a throttle.
    if (i > 0 && gap > 0) await sleep(gap)
    const before = budget.used
    // The run's own floor for this channel: `now - N h`, or deeper where the run would read deeper.
    const floor = backfillFloorFor({ newestStoredUnix: newestStored.get(t.id), nowUnix, hours })
    const reach: OfficialReach = { officialSinceUnix: floor, officialMaxPosts: GRAPH_BACKFILL_MAX_POSTS, officialMaxPages: GRAPH_BACKFILL_MAX_PAGES }
    try {
      const r = await fetchFeedViaGraph(t.handle, {
        sinceUnix: floor,
        maxPosts: GRAPH_BACKFILL_MAX_POSTS,
        maxPages: GRAPH_BACKFILL_MAX_PAGES,
        delayMs: deps.delayMs,
        budget,
        // NEVER the pass's evidence row: a person's preview reports, it does not speak for the server.
        record: false,
      })
      const window = r.posts.filter((p) => Math.floor(p.postedAt.getTime() / 1000) >= floor)
      const stored = window.length
        ? await prisma.detectedCampaign.findMany({ where: { shortcode: { in: window.map((p) => p.shortcode) } }, select: { shortcode: true } })
        : []
      const have = new Set(stored.map((s) => s.shortcode))
      const shortfall = officialShortfall(r, reach, budget.remaining)
      rows.push({
        handle: t.handle,
        inWindow: window.length,
        notStored: window.filter((p) => !have.has(p.shortcode)).length,
        calls: budget.used - before,
        status: shortfall.reached ? 'read' : 'short',
        ...(shortfall.reached
          ? {}
          : shortfall.short === 'call-cap'
            ? { rerun: true, why: `the dry run's call cap (${GRAPH_BACKFILL_CALL_CAP}) ran out before it reached ${hours} hours back` }
            : { rerun: false, why: `it reached the per-channel bound (${GRAPH_BACKFILL_MAX_POSTS} posts) before ${hours} hours back — --run reads the same ${GRAPH_BACKFILL_MAX_POSTS}` }),
      })
    } catch (err) {
      const message = err instanceof Error ? err.message.replace(/^\[@[^\]]+\]\s*/, '') : String(err)
      const kind = (err as { graphKind?: string }).graphKind
      rows.push({
        handle: t.handle,
        inWindow: 0,
        notStored: 0,
        calls: budget.used - before,
        status: 'not-read',
        rerun: kind !== 'graph-not-professional' && kind !== 'graph-token',
        why: scrub(message, token, 300) ?? 'no reason given',
      })
    }
  }
  return { hours, sinceUnix, rows, calls: budget.used, cap: GRAPH_BACKFILL_CALL_CAP, channels }
}

/** PURE. The dry run's report. */
export function formatPreview(p: BackfillPreview): string[] {
  const lines: string[] = []
  for (const r of p.rows) {
    if (r.status === 'not-read') {
      lines.push(`  @${r.handle}: not read — ${r.why ?? 'no reason given'}`)
      continue
    }
    const base = `  @${r.handle}: ${r.inWindow} in the window, ${r.notStored} not stored (${r.calls} call${r.calls === 1 ? '' : 's'})`
    lines.push(r.status === 'short' ? `${base} — cut short: ${r.why}; the counts are a floor` : base)
  }
  const inWindow = p.rows.reduce((n, r) => n + r.inWindow, 0)
  const notStored = p.rows.reduce((n, r) => n + r.notStored, 0)
  lines.push('')
  lines.push(`${p.rows.length} channel${p.rows.length === 1 ? '' : 's'}, ${inWindow} posts in the window, ${notStored} not stored.`)
  lines.push(
    `${p.calls} official call${p.calls === 1 ? '' : 's'} used of this dry run's cap of ${p.cap}. They count against the same hourly budget ` +
      "(Meta documents roughly 200 an hour) as the running worker and the run: a large dry run can push the worker's official read into " +
      'a rate limit, which pauses it for 30 minutes (posts are delayed, not lost) — and give it an hour before --run.',
  )
  if (notStored > 0) {
    const minutes = Math.max(1, Math.round((notStored * BACKFILL_SECONDS_PER_POST) / 60))
    lines.push(
      `--run would store and judge about ${notStored} post${notStored === 1 ? '' : 's'}: roughly ${minutes} minute${minutes === 1 ? '' : 's'} at ~${BACKFILL_SECONDS_PER_POST} s a post, ` +
        'with the worker stopped — detection, drafting and the four slots pause for that long. A smaller --hours, or --channel, shortens it.',
    )
  }
  const again = p.rows.filter((r) => r.status !== 'read' && r.rerun !== false).map((r) => r.handle)
  const never = p.rows.filter((r) => r.status !== 'read' && r.rerun === false).map((r) => r.handle)
  if (again.length > 0) {
    lines.push(`${again.length} channel${again.length === 1 ? ' was' : 's were'} not read to the end — named above. To read just ${again.length === 1 ? 'it' : 'those'} (a dry run): ${backfillCommand(p.hours, again)}`)
  }
  if (never.length > 0) {
    lines.push(`${never.length} channel${never.length === 1 ? '' : 's'} cannot be read further by re-running — named above: ${never.map((h) => `@${h}`).join(', ')}.`)
  }
  return lines
}

// ── The run's report (PURE) ──────────────────────────────────────────────────────────────────

/** Why a channel was not backfilled, and whether running again can finish it. */
export interface NotBackfilled {
  why: string
  /** False where a re-run reads the same thing again: a personal account, a token to replace, the per-channel bound. */
  rerun: boolean
}

/**
 * PURE. Why a channel was NOT backfilled by a `--run` pass, or null when it was. NO SILENT CAPS:
 * every channel the run did not take back the full N hours is named with the reason, and with
 * whether a re-run can help — a re-run that cannot is a person sent to repeat the same failure.
 */
export function notBackfilledReason(c: ChannelOutcome, hours: number, cap: number): NotBackfilled | null {
  if (c.parseFailure) return { why: c.error ?? 'it answered with no posts', rerun: true }
  if (c.servedBy === 'graph') {
    // Read, then storing failed part way (a database error mid-loop): the posts before the failure
    // are stored and the rest are not — and the stored ones make this channel's newest post fresh,
    // so nothing routine will read the rest. Checked before "reached", which is about the READ.
    if (c.error) return { why: `it was read, then storing failed part way: ${c.error}`, rerun: true }
    const reach = c.officialReach
    if (!reach || reach.reached) return null
    return reach.short === 'call-cap'
      ? { why: `the run's call cap (${cap}) ran out before it reached ${hours} hours back`, rerun: true }
      : { why: `it reached the per-channel bound (${GRAPH_BACKFILL_MAX_POSTS} posts) before ${hours} hours back — a re-run reads the same ${GRAPH_BACKFILL_MAX_POSTS}`, rerun: false }
  }
  if (c.servedBy === 'anonymous') {
    // A backfill reads official-only (feedSource.ts), so this is not expected; said rather than hidden.
    return { why: 'the anonymous feed served it — a backfill reads only through the official API, so this pass was not one', rerun: true }
  }
  if (c.officialFailure === 'graph-not-professional') return { why: c.error ?? 'it is not a Business or Creator account', rerun: false }
  if (c.officialFailure === 'graph-token' || c.officialPausedBy === 'graph-token') {
    return { why: 'the official read token is invalid or expired — a person must mint a new one (docs/DEPLOY.md, "Official read fallback", step 1)', rerun: false }
  }
  if (c.skipped === 'official-rate-limited') return { why: 'the official API answered with a rate limit and pauses for 30 minutes — re-run after an hour', rerun: true }
  if (c.officialUnavailable === 'cap-reached') return { why: `the run's call cap (${cap}) was spent before this channel`, rerun: true }
  if (c.officialUnavailable === 'paused') {
    return c.officialPausedBy === 'graph-rate-limit'
      ? { why: 'the official API was paused by a rate-limit answer earlier in this run — re-run after an hour', rerun: true }
      : { why: 'the official API refused this host earlier in this run and pauses for an hour — a person must look at the code it gave (the log names it)', rerun: false }
  }
  if (c.officialUnavailable === 'off') return { why: 'the official read was not available to this pass', rerun: false }
  return { why: c.error ?? 'it was not read', rerun: true }
}

// ── The command ──────────────────────────────────────────────────────────────────────────────

export interface BackfillIo {
  out: (line: string) => void
  /** The pass, `runDetection({ officialBackfillHours, onlyChannels })` — injected so this module never imports it. */
  runPass: (hours: number, channels: readonly string[]) => Promise<DetectionSummary>
  now?: () => number
  graphReady?: () => boolean
  readHeartbeat?: () => Promise<SchedulerHeartbeat | null>
  machine?: () => string
  alive?: (pid: number) => boolean
  /** Dry run only: the spacing between official calls (tests pass 0). */
  delayMs?: number
  sleep?: (ms: number) => Promise<void>
}

/**
 * The whole command. Exit code: 0 when every channel was read (dry run) or backfilled (run) back the
 * full N hours; 1 when any was not — named in the output; 2 when it refused before reading anything.
 */
export async function runBackfill(plan: BackfillPlan, io: BackfillIo): Promise<number> {
  const out = io.out
  const nowMs = (io.now ?? Date.now)()
  const channels = plan.channels ?? []
  if (!(io.graphReady ?? graphConfigured)()) {
    out(
      "Refusing: the official read is not configured on this host — META_GRAPH_TOKEN and META_IG_USER_ID must both be set in this host's .env, " +
        'and a backfill reads only through it (docs/DEPLOY.md, "Official read fallback").',
    )
    return 2
  }
  if (channels.length > 0) {
    // A name that is not a watched channel would read nothing and look like a quiet channel.
    const known = await prisma.targetAccount.findMany({ where: { ...WATCHED_CHANNEL_WHERE, handle: { in: channels } }, select: { handle: true } })
    const have = new Set(known.map((k) => k.handle))
    const unknown = channels.filter((c) => !have.has(c))
    if (unknown.length > 0) {
      out(`Refusing: ${unknown.map((h) => `@${h}`).join(', ')} ${unknown.length === 1 ? 'is not a watched channel' : 'are not watched channels'} here (a CHANNEL target with watching on) — check the handle on /targets.`)
      return 2
    }
  }
  const which = channels.length > 0 ? channels.map((c) => `@${c}`).join(', ') : 'every watched channel'

  if (!plan.run) {
    out(`ig:backfill — DRY RUN: reading ${which} back ${plan.hours} hours (since ${new Date((Math.floor(nowMs / 1000) - plan.hours * 3600) * 1000).toISOString()}) through the official API. Nothing is written.`)
    out('')
    const preview = await previewBackfill(plan.hours, { nowMs, channels, delayMs: io.delayMs, sleep: io.sleep })
    for (const line of formatPreview(preview)) out(line)
    out('')
    const missing = preview.rows.reduce((n, r) => n + r.notStored, 0)
    out(
      missing > 0 || preview.rows.some((r) => r.status !== 'read')
        ? 'Nothing was written. To store them, on the box, as one line:'
        : `Nothing is missing in the last ${plan.hours} hours. Nothing was written. If you run it anyway, on the box, as one line:`,
    )
    out(stopRunStartLine(plan.hours, channels))
    out(DETACHED_NOTE)
    return preview.rows.every((r) => r.status === 'read') ? 0 : 1
  }

  let beat: SchedulerHeartbeat | null
  try {
    beat = await (io.readHeartbeat ?? readSchedulerHeartbeat)()
  } catch (err) {
    const why = err instanceof Error ? err.message.split('\n').map((l) => l.trim()).filter(Boolean).pop() ?? err.name : String(err)
    out(`Refusing: the scheduler heartbeat could not be read (${why}), so a worker running on this host cannot be ruled out. Run this instead, as one line:`)
    out(stopRunStartLine(plan.hours, channels))
    out(DETACHED_NOTE)
    return 2
  }
  const blocked = backfillRunBlocker({
    beat,
    nowMs,
    machine: (io.machine ?? machineId)(),
    alive: io.alive ?? pidAliveHere,
    hours: plan.hours,
  })
  if (blocked) {
    out(blocked)
    out(stopRunStartLine(plan.hours, channels))
    out(DETACHED_NOTE)
    return 2
  }

  out(`ig:backfill — reading ${which} back ${plan.hours} hours through the official API only and storing what is missing (an ordinary detection pass).`)
  out('')
  const s = await io.runPass(plan.hours, channels)
  out('')
  for (const c of s.channels) out(channelSummaryLine(c))
  out('')
  const cap = s.officialCalls?.cap ?? GRAPH_BACKFILL_CALL_CAP
  out(`${passSummaryLine(s)}${s.officialCalls ? ` ${s.officialCalls.used} official call${s.officialCalls.used === 1 ? '' : 's'} used of the run's cap of ${cap}.` : ''}`)
  // What the run did with the full-size frames it read — never left only in the log (detectionReport.ts).
  const frames = frameShrinkLine(s)
  if (frames) out(frames)
  if (s.officialCalls && s.officialCalls.used >= cap * 0.9) {
    // The pause a rate limit sets lives in THIS process (graphFeed.ts); the worker restarted after
    // this run re-learns a still-active limit by spending one call, then pauses itself.
    out("This run spent most of an hour's official budget: the worker's next passes may meet a rate limit and pause their official read for 30 minutes. Posts are delayed, not lost.")
  }
  const missed = s.channels.map((c) => ({ handle: c.handle, r: notBackfilledReason(c, plan.hours, cap) })).filter((m): m is { handle: string; r: NotBackfilled } => m.r !== null)
  out(`Backfilled: ${s.channels.length - missed.length} of ${s.channels.length} channel${s.channels.length === 1 ? '' : 's'}.`)
  const again = missed.filter((m) => m.r.rerun)
  const never = missed.filter((m) => !m.r.rerun)
  if (again.length > 0) {
    out('NOT backfilled — a re-run can finish these (it reads only them, and re-reading what is stored writes nothing):')
    for (const m of again) out(`  @${m.handle}: ${m.r.why}`)
    out('To re-run just those, on the box, as one line:')
    out(stopRunStartLine(plan.hours, again.map((m) => m.handle)))
  }
  if (never.length > 0) {
    out('NOT backfilled — re-running will not help these:')
    for (const m of never) out(`  @${m.handle}: ${m.r.why}`)
  }
  return missed.length > 0 || s.hadError || s.hadParseFailure ? 1 : 0
}
