import { prisma } from '@/lib/db'
import { env } from '@/lib/env'
import { daysAgo, istDateKey } from '@/lib/time'
import { detectionCutoff } from '@/lib/cutoff'
import { visibleChannelFilter } from '@/detection/visibleChannels'
import { DELIVERED_STATUSES, IN_FLIGHT_STATUSES } from '@/lib/constants'
import { readHeartbeat } from '@/worker/scheduler'
import {
  assessWatch,
  FEED_DEPTH_POSTS,
  BUSIEST_CHANNEL_POSTS_PER_DAY,
  HOURS_UNTIL_LOSS,
} from '@/detection/watchHealth'
import type { Bucket, RunOutcome } from '../charts'

/**
 * The data behind the charts, and nothing else.
 *
 * ── WHY THE BUCKETING HAPPENS IN JAVASCRIPT ─────────────────────────────────
 *
 * Grouping by day is the obvious thing to push into SQL, and it is the one thing that must
 * not be: `date_trunc` is Postgres and `strftime` is SQLite, and this codebase genuinely
 * runs both — the server on Postgres, a laptop on SQLite, one schema generated from the
 * other. A raw query here would typecheck on both and be wrong on one.
 *
 * It also would not fix the harder half. Every date boundary in this system is IST, not
 * UTC, because that is the day a person in Mumbai means when they say "today" — and a
 * database `date()` would silently bucket by the server's zone. `istDateKey` is the one
 * function that decides what day something happened on, so the grouping goes where it
 * lives. The volumes are small (a month of detections is a few hundred rows) and the
 * queries select only the columns the buckets need.
 */

const DAY_LABEL = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' })

/** Every IST day in the window, oldest first, INCLUDING the ones with nothing in them. */
function emptyDays(days: number): Array<{ key: string; label: string; at: Date }> {
  const out: Array<{ key: string; label: string; at: Date }> = []
  for (let i = days - 1; i >= 0; i--) {
    const at = daysAgo(i)
    out.push({ key: istDateKey(at), label: DAY_LABEL.format(at), at })
  }
  return out
}

export interface VerdictChart {
  buckets: Bucket[]
  /** Whether anything at all landed in the window — an empty chart must say so, not draw zero. */
  any: boolean
}

/**
 * Posts per day, split by what we decided about them.
 *
 * `UNCLASSIFIED` is carried as its own series and drawn as an OUTLINE rather than a fill.
 * It means NOT JUDGED and has never meant organic — a post nobody classified and a post
 * classified as ordinary are different facts, and stacking them as two solid colours
 * invites exactly the addition this system spent a fortnight undoing. The free hashtag
 * filter once recorded 76 never-read posts as `ORGANIC`, a positive claim that a publisher
 * was not paid, about posts nothing had looked at.
 *
 * Scoped to the detection cutoff, because the corpus before it is deliberately never judged
 * and would otherwise render as a permanent unclearable backlog.
 */
export async function buildVerdictChart(days = 30): Promise<VerdictChart> {
  const since = new Date(Math.max(daysAgo(days).getTime(), detectionCutoff().getTime()))

  /**
   * OUR OWN PAGES ARE EXCLUDED (2026-08-26). This chart sits directly under a tile that
   * computes its figure WITH `visibleChannelFilter()`, so the bars were counting ~37
   * own-page CAMPAIGN rows the number above them left out — two channel scopes on one page.
   * Same missing-grep cause as the sidebar badge; `tests/visible-channels.test.ts` now walks
   * this directory.
   */
  const rows = await prisma.detectedCampaign.findMany({
    where: { postedAt: { gte: since }, ...(await visibleChannelFilter()) },
    select: { postedAt: true, verdict: true },
  })

  const order = ['CAMPAIGN', 'ORGANIC', 'REVIEW', 'UNCLASSIFIED']
  const byDay = new Map<string, number[]>()
  for (const r of rows) {
    const key = istDateKey(r.postedAt)
    const slot = order.indexOf(r.verdict)
    if (slot < 0) continue
    const arr = byDay.get(key) ?? [0, 0, 0, 0]
    arr[slot] = (arr[slot] ?? 0) + 1
    byDay.set(key, arr)
  }

  return {
    any: rows.length > 0,
    buckets: emptyDays(days).map((d) => ({
      key: d.key,
      label: d.label,
      values: byDay.get(d.key) ?? [0, 0, 0, 0],
    })),
  }
}

export interface SpendChart {
  buckets: Bucket[]
  any: boolean
}

/**
 * Spend per day by what the call was FOR.
 *
 * Failed calls are included in the count and cost. They are recorded deliberately — a
 * rising failure rate is exactly what a cost table hides by leaving it out — and a failed
 * call is never recorded as a verdict, so the two facts have to be visible separately.
 */
/**
 * ── AGGREGATE IN THE DATABASE ON POSTGRES (2026-09-02) ───────────────────────
 *
 * Both charts below pulled EVERY ModelCall row in the window into JS and grouped there —
 * 51,766 rows, twice, on every /cost render. The database answered in 14ms; materialising
 * 100k Prisma objects on the Linode's single core is what pushed /cost past Cloudflare's
 * origin ceiling even after `buildCostView` was fixed (found live: /cost still 502/524).
 * The IST day key is computed in SQL (`at` holds UTC instants; IST is a fixed +05:30, no
 * DST) so one row per (day, purpose) comes back. The JS path is KEPT for SQLite — the
 * date-function dialects differ, and `pnpm local offline` and the suite run there; the
 * two-provider trap is real, so the branch is on the URL, never on a guess.
 */
const onPostgres = (): boolean => env.DATABASE_URL.startsWith('postgres')

export async function buildSpendChart(days = 30): Promise<SpendChart> {
  const order = ['classify', 'resolve', 'generate']
  const byDay = new Map<string, number[]>()
  const fold = (key: string, purpose: string, usd: number): void => {
    const slot = order.indexOf(purpose)
    const arr = byDay.get(key) ?? [0, 0, 0]
    // An unrecognised purpose is folded into the first bucket rather than dropped: money
    // that was spent must appear somewhere, and a silently missing column is worse than a
    // slightly wrong one.
    const at = slot < 0 ? 0 : slot
    arr[at] = (arr[at] ?? 0) + usd
    byDay.set(key, arr)
  }

  let any = false
  if (onPostgres()) {
    const rows = await prisma.$queryRaw<Array<{ day: string; purpose: string; usd: number }>>`
      SELECT to_char("at" + interval '330 minutes', 'YYYY-MM-DD') AS day, "purpose", SUM("costUsd") AS usd
      FROM "ModelCall" WHERE "at" >= ${daysAgo(days)}
      GROUP BY 1, 2`
    any = rows.length > 0
    for (const r of rows) fold(r.day, r.purpose, Number(r.usd))
  } else {
    const rows = await prisma.modelCall.findMany({
      where: { at: { gte: daysAgo(days) } },
      select: { at: true, purpose: true, costUsd: true },
    })
    any = rows.length > 0
    for (const r of rows) fold(istDateKey(r.at), r.purpose, r.costUsd)
  }

  return {
    any,
    buckets: emptyDays(days).map((d) => ({
      key: d.key,
      label: d.label,
      values: byDay.get(d.key) ?? [0, 0, 0],
    })),
  }
}

/**
 * One cell per detection run, oldest first.
 *
 * PARTIAL is its own outcome and must stay one: a run that read some channels and not
 * others is neither a success nor an outage, and folding it into either is how eight
 * failing slots out of twelve went unreported for two days.
 */
export async function buildRunStrip(limit = 48): Promise<Array<{ key: string; outcome: RunOutcome; title: string }>> {
  const runs = await prisma.scrapeRun.findMany({
    orderBy: { startedAt: 'desc' },
    take: limit,
    select: { id: true, slot: true, startedAt: true, finishedAt: true, status: true, postsSeen: true, error: true },
  })

  return runs.reverse().map((r) => {
    /**
     * A RUN IN PROGRESS IS NOT A FINISHED RUN. `ScrapeRun` is created with zeros and
     * updated at the end, so reading counts off an unfinished row reports "0 posts
     * parsed" — and zero parsed is defined as an ALARM here, while 60 parsed and 0 paid
     * is a quiet day. For the ~60 seconds a slot takes, that made the one number that must
     * never appear falsely appear four times a day.
     */
    if (r.finishedAt === null) {
      return { key: r.id, outcome: 'ok' as const, title: `${r.slot} — still running` }
    }
    const outcome: RunOutcome = r.status === 'OK' ? 'ok' : r.status === 'PARTIAL' ? 'partial' : 'failed'
    const when = DAY_LABEL.format(r.startedAt)
    const detail = r.error ? ` — ${r.error}` : ''
    return { key: r.id, outcome, title: `${when} ${r.slot} · ${r.postsSeen} posts parsed${detail}` }
  })
}

export interface SendFunnel {
  steps: Array<{ key: string; label: string; n: number; drop: string | null }>
  /** True when nothing has ever been delivered — the page says that in words rather than drawing an empty funnel. */
  neverDelivered: boolean
}

/**
 * Drafted → ready → sent → replied, with what was lost at each step NAMED.
 *
 * The drop-off sentence is the point. On this system the interesting number is almost
 * never how many were sent — it is which rule held the rest, because that is the only part
 * an operator can act on.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO is re-derive why each waiting draft is held. That
 * verdict belongs to `recheckBeforeSend`, it is rendered verbatim on Autopilot beside the
 * draft it refuses, and a reporting page computing its own version is exactly how
 * `/messages` came to render "Clear to send" over a draft the dispatcher then held forever.
 * So this counts, and points at the page that explains.
 */
export async function buildSendFunnel(days = 30): Promise<SendFunnel> {
  const since = daysAgo(days)

  const [drafted, ready, delivered, replied, everDelivered] = await Promise.all([
    prisma.outreachAttempt.count({ where: { queuedAt: { gte: since } } }),
    prisma.outreachAttempt.count({ where: { queuedAt: { gte: since }, status: 'READY' } }),
    // REPLIED REPLACES SENT, it does not add to it — any count of delivered messages must
    // be `{ in: [...] }`, or the best outcome silently reduces the total.
    prisma.outreachAttempt.count({ where: { queuedAt: { gte: since }, status: { in: [...DELIVERED_STATUSES] } } }),
    prisma.outreachAttempt.count({ where: { queuedAt: { gte: since }, status: 'REPLIED' } }),
    prisma.outreachAttempt.count({ where: { status: { in: [...DELIVERED_STATUSES] } } }),
  ])

  const settled = drafted - ready - delivered

  return {
    neverDelivered: everDelivered === 0,
    steps: [
      { key: 'drafted', label: 'Written', n: drafted, drop: null },
      {
        key: 'ready',
        label: 'Waiting to send',
        n: ready,
        drop:
          settled > 0
            ? `${settled} were written and then set aside — a rule refused them, or the material went stale.`
            : null,
      },
      {
        key: 'sent',
        label: 'Delivered',
        n: delivered,
        drop: ready > 0 ? `${ready} are still waiting. Autopilot names the reason for each one.` : null,
      },
      {
        key: 'replied',
        label: 'Replied to us',
        n: replied,
        drop:
          delivered > replied
            ? `${delivered - replied} have had no reply. Some of those threads have never been read.`
            : null,
      },
    ],
  }
}

export interface WatchChart {
  survivalHours: number
  downtimeHours: number
  postsLost: number
  feedDepth: number
  postsPerDay: number
  severity: 'ok' | 'at-risk' | 'losing-posts'
  /**
   * The watch has NEVER run, so nothing about loss has been counted.
   *
   * This flag exists because `estimatedPostsLost` is 0 in that case, and 0 renders as
   * "nothing lost" — good news — when the truth is "we cannot say". `assessWatch`'s own
   * docblock is explicit that zero there means NOT COUNTED, and collapsing the two would
   * be the absence-of-data-becomes-a-verdict bug this project has now produced five times.
   */
  neverRun: boolean
}

/**
 * The watch window, from the SAME pure function the health ladder uses.
 *
 * `assessWatch` derives the boundary from the measured feed depth and posting rate, and
 * separates at-risk (recoverable — one pass gets it all back) from losing-posts (gone).
 * The page must not work any of that out again: a screen computing a safety boundary its
 * own way can disagree with the thing enforcing it, and this codebase has already paid for
 * that twice.
 */
export async function buildWatchChart(): Promise<WatchChart> {
  const heartbeat = await readHeartbeat()
  const health = assessWatch({
    lastBeatAt: heartbeat ? new Date(heartbeat.beat.at) : null,
    fresh: heartbeat?.fresh ?? false,
    now: new Date(),
  })

  return {
    survivalHours: Math.round(HOURS_UNTIL_LOSS),
    downtimeHours: health.downMinutes === null ? 0 : Math.round((health.downMinutes / 60) * 10) / 10,
    postsLost: health.estimatedPostsLost,
    feedDepth: FEED_DEPTH_POSTS,
    postsPerDay: BUSIEST_CHANNEL_POSTS_PER_DAY,
    severity: health.severity,
    neverRun: heartbeat === null,
  }
}

/** Everything the analytics page's charts need, in ONE round of parallel queries. */
export async function buildAnalyticsCharts(days = 30) {
  const [verdicts, runs, funnel, watch] = await Promise.all([
    buildVerdictChart(days),
    buildRunStrip(48),
    buildSendFunnel(days),
    buildWatchChart(),
  ])
  return { verdicts, runs, funnel, watch, days }
}

/** Kept beside the others so a future caller does not reach for `IN_FLIGHT_STATUSES` here by accident. */
export const _inFlight = IN_FLIGHT_STATUSES

export interface CacheChart {
  points: Array<{ key: string; label: string; value: number | null }>
  any: boolean
  /** How many days in the window fell below the expected band. */
  outOfBand: number
  bandLow: number
  bandHigh: number
}

/**
 * THE CACHE-HIT RATE, against the band it is expected to sit in.
 *
 * This is the one number on the cost page that is not about money. The classifier's system
 * prompt is a module-level constant with nothing interpolated into it, and cached input is
 * billed at roughly a FIFTIETH of fresh input — so a sustained drop below the band does not
 * mean "spending is up", it means somebody put a variable into that constant and destroyed
 * the prefix match. That failure is silent, permanent, and invisible in every other view.
 *
 * The band (95–98%) is the MEASURED steady state of this system, not an aspiration.
 *
 * A day with no calls yields `null`, never 0. Zero would draw a cliff to the floor and read
 * as a catastrophic cache miss on a day when nothing was asked at all — the same
 * absence-becomes-a-verdict mistake this codebase keeps finding.
 */
export const CACHE_BAND_LOW = 0.95
export const CACHE_BAND_HIGH = 0.98

export async function buildCacheChart(days = 30): Promise<CacheChart> {
  const byDay = new Map<string, { input: number; cached: number }>()
  let any = false
  if (onPostgres()) {
    const rows = await prisma.$queryRaw<Array<{ day: string; input: bigint | number; cached: bigint | number }>>`
      SELECT to_char("at" + interval '330 minutes', 'YYYY-MM-DD') AS day,
             SUM("inputTokens") AS input, SUM("cachedInputTokens") AS cached
      FROM "ModelCall" WHERE "at" >= ${daysAgo(days)} AND "ok" = true
      GROUP BY 1`
    any = rows.length > 0
    for (const r of rows) byDay.set(r.day, { input: Number(r.input), cached: Number(r.cached) })
  } else {
    const rows = await prisma.modelCall.findMany({
      where: { at: { gte: daysAgo(days) }, ok: true },
      select: { at: true, inputTokens: true, cachedInputTokens: true },
    })
    any = rows.length > 0
    for (const r of rows) {
      const key = istDateKey(r.at)
      const acc = byDay.get(key) ?? { input: 0, cached: 0 }
      acc.input += r.inputTokens
      acc.cached += r.cachedInputTokens
      byDay.set(key, acc)
    }
  }

  let outOfBand = 0
  const points = emptyDays(days).map((d) => {
    const acc = byDay.get(d.key)
    if (!acc || acc.input === 0) return { key: d.key, label: d.label, value: null }
    const value = acc.cached / acc.input
    if (value < CACHE_BAND_LOW) outOfBand += 1
    return { key: d.key, label: d.label, value }
  })

  return { points, any, outOfBand, bandLow: CACHE_BAND_LOW, bandHigh: CACHE_BAND_HIGH }
}

/** Everything `/cost` charts, in one round of parallel queries. */
export async function buildCostCharts(days = 30) {
  const [spend, cache] = await Promise.all([buildSpendChart(days), buildCacheChart(days)])
  return { spend, cache, days }
}
