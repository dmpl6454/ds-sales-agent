import { prisma } from '@/lib/db'
import { memoView, viewKey } from '@/lib/viewMemo'

/**
 * THE ACCURACY TREND, READ FROM THE RUNS THE HARNESS ALREADY STORED.
 *
 * ── WHY A RANGE AND NOT A NUMBER ──────────────────────────────────────────
 *
 * The classifier is NOT deterministic. MEASURED across three runs against an unchanged
 * corpus, unchanged prompt and unchanged code: 2 of 89 posts change verdict between
 * identical runs, and at ~22 paid posts one flip is 4.5% of recall. Every figure this
 * project has ever quoted to the percentage point — 98%, 100% recall, 92% precision — was a
 * SINGLE RUN.
 *
 * So a point estimate on a dashboard would be the same mistake with a nicer font. Each run
 * stores `recallLo`/`recallHi` across its own repeats, and this renders that span.
 *
 * ── AND A FIGURE WITH NO DATE IS THE FRESHNESS MISTAKE ────────────────────
 *
 * "Freshness is not liveness" has bitten this codebase four times. An accuracy percentage
 * with nothing saying WHEN it was measured is the same shape: it reads as current forever.
 * The date of the newest run is part of the answer, not decoration.
 *
 * ── THE COMPARABILITY BOUNDARY IS IN THE ROW, NOT IN A CAVEAT ─────────────
 *
 * `pred` changed to `final === 'CAMPAIGN'` on 2026-08-17, so frame escalations now count as
 * positive predictions and **figures either side of that change are not comparable**. That
 * fact is stored per run as `predRule`; a trend drawn straight through it would show the
 * first frame escalation as a regression. Entries recorded before the rule existed carry no
 * `predRule` and are marked rather than silently plotted alongside.
 */

const HISTORY_KEY = 'accuracyHistory'

/** The rule in force now. Runs recorded under anything else are not comparable with these. */
export const CURRENT_PRED_RULE = 'final-campaign'

export interface AccuracyChannelTrend {
  handle: string
  /** How many posts here have a known right answer. Zero means the figures are unmeasurable. */
  labels: number
  /** Null when this channel has no positives to score — never a 0% that reads as failure. */
  recall: { lo: number; hi: number } | null
  precision: { lo: number; hi: number } | null
  /** Oldest → newest recall midpoints, for a sparkline. Nulls are gaps, never zeros. */
  series: (number | null)[]
}

export interface AccuracyTrend {
  /** ISO timestamp of the newest run, or null when the harness has never run. */
  lastRunAt: string | null
  /** How many repeats the newest run took. 1 means the figures are a single sample. */
  repeats: number
  /** Runs available for the trend. */
  runs: number
  /** True when every run shown was recorded under the rule in force now. */
  comparable: boolean
  channels: AccuracyChannelTrend[]
}

interface StoredChannel {
  labels: number
  correct: number
  recall: number
  precision: number
  recallLo?: number
  recallHi?: number
  precisionLo?: number
  precisionHi?: number
}
interface StoredEntry {
  at: string
  repeats: number
  predRule?: string
  channels: Record<string, StoredChannel>
}

/**
 * `-1` is the harness's "not applicable" — a channel with no positives to find. It must never
 * render as 0%, which reads as total failure rather than as nothing to measure.
 */
function span(lo: number | undefined, hi: number | undefined, mean: number): { lo: number; hi: number } | null {
  const a = lo ?? mean
  const b = hi ?? mean
  if (a < 0 || b < 0) return null
  return { lo: Math.min(a, b), hi: Math.max(a, b) }
}

/** Memoised (single-flight, 10 s) on its inputs — see `src/lib/viewMemo.ts`. */
export async function buildAccuracyTrend(limit = 8): Promise<AccuracyTrend | null> {
  return memoView(viewKey('AccuracyTrend', [limit]), () => computeAccuracyTrend(limit))
}

async function computeAccuracyTrend(limit = 8): Promise<AccuracyTrend | null> {
  const row = await prisma.setting.findUnique({ where: { key: HISTORY_KEY } })
  if (!row) return null

  let history: StoredEntry[] = []
  try {
    const parsed: unknown = JSON.parse(row.value)
    if (Array.isArray(parsed)) history = parsed as StoredEntry[]
  } catch {
    /* A corrupt row must not take the page down. It is a log, not a ledger. */
    return null
  }
  if (history.length === 0) return null

  const recent = history.slice(-limit)
  const newest = recent[recent.length - 1]!
  const names = [...new Set(recent.flatMap((h) => Object.keys(h.channels ?? {})))].sort()

  const channels: AccuracyChannelTrend[] = names.map((handle) => {
    const latest = newest.channels?.[handle]
    return {
      handle,
      labels: latest?.labels ?? 0,
      recall: latest ? span(latest.recallLo, latest.recallHi, latest.recall) : null,
      precision: latest ? span(latest.precisionLo, latest.precisionHi, latest.precision) : null,
      /*
        A missing channel is a GAP, not a zero — it means that run did not score it, and
        drawing it at 0% would invent a collapse that never happened.
      */
      series: recent.map((h) => {
        const c = h.channels?.[handle]
        if (!c || c.recall < 0) return null
        return c.recall
      }),
    }
  })

  return {
    lastRunAt: newest.at ?? null,
    repeats: newest.repeats ?? 1,
    runs: recent.length,
    comparable: recent.every((h) => h.predRule === CURRENT_PRED_RULE),
    channels,
  }
}
