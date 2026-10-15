/**
 * detection-outage.ts — the landing page's sentence for "no paid posts are being found", built
 * from what Instagram actually ANSWERED (src/detection/feedEvidence.ts), never from the stale
 * stamp alone.
 *
 * ── WHY (15 Oct 2026) ──────────────────────────────────────────────────────────────────
 *
 * The headline read "Instagram is refusing anonymous reads — no paid posts are being found since
 * 1348 min ago" on a day when nothing on record said Instagram had refused anything: the branch
 * fired on `feedStale`, and the word "refusing" was a guess written as a fact. The four causes
 * on record have four different remedies and must never share a sentence:
 *
 *   a refusal (401/429, or a 200 carrying the login wall)  → it lifts by itself; say when
 *   Instagram answering differently (400, a web page, a   → waiting will NOT fix it; say so,
 *     changed shape, an empty feed)                          because "wait" is the wrong advice
 *   the host cannot reach Instagram at all                 → a network problem on that host
 *   no current answer row, but the server's cooldown is    → a refusal the gate recorded; say
 *     recorded (`throttledUntil`)                             when it asks again
 *   nothing on record at all                               → the worker may not be running this
 *                                                            build — never the word "refusing"
 *
 * PURE: the page's query (`readPassHealth`) carries the rows; this only phrases them, so every
 * branch is a row in `tests/feed-evidence.test.ts`. "The server" is the machine the scheduler
 * heartbeat names — the host that runs the primary pass. When no beat is readable, every host is
 * named by its own name: guessing which one is the server is a claim nobody measured.
 *
 * WHICH ANSWER IS CURRENT. A host's last failure explains the outage only when nothing READ after
 * it — neither that host (`lastOkAt`) nor any host (`feedOkAt`). An `ok` after a failure is always
 * written (feedEvidence's dedupe never delays a recovery), so the comparison cannot be fooled by
 * the ten-minute write throttle.
 */
import type { PassHealth } from '@/worker/scheduler'
import type { FeedAnswer, FeedAnswerRow } from '@/detection/feedEvidence'
import { istDateKey, istDayMonth, istTimeKey } from '@/lib/time'

export type OutagePasses = Pick<PassHealth, 'feedOkAt' | 'throttledUntil' | 'feedAnswers' | 'detectionHost'>

/**
 * An answer older than this is evidence about the past: a refused host asks again at most an hour
 * later (anonGate's cap) and an unrefused one every fifteen minutes, so ninety minutes of nothing
 * new means the pass stopped asking, and the page says so rather than presenting old words as now.
 */
export const EVIDENCE_STALE_MS = 90 * 60_000

const QUOTE_MAX = 80

const t = (iso: string | null | undefined): number => (iso ? Date.parse(iso) : Number.NaN)

/** PURE. "14:30" when it is today in IST, "14 Oct, 14:30" otherwise — HH:MM alone across midnight lies. */
export function whenLabel(at: Date, now: number): string {
  const time = istTimeKey(at)
  return istDateKey(at) === istDateKey(new Date(now)) ? time : `${istDayMonth(at)}, ${time}`
}

/**
 * PURE. The words worth quoting from an answer's head: Instagram's own `message` when the body is
 * its usual JSON, the head itself when it is short prose, and NOTHING for a web page — an HTML
 * fragment in a sentence is noise, and the kind already says it was a page.
 */
export function quoteOf(answer: Pick<FeedAnswer, 'head' | 'kind'>): string | null {
  // The FeedFetchError prefix names a handle, not a cause — and starts with "[", which would
  // otherwise read as a JSON array below.
  const head = answer.head?.replace(/^\[@[^\]]+\]\s*/, '').trim()
  if (!head || answer.kind === 'not-json' || head.startsWith('<')) return null
  const m = head.match(/"message"\s*:\s*"((?:[^"\\]|\\.)*)"/)
  let text = head
  if (m) {
    try {
      text = JSON.parse(`"${m[1]}"`) as string
    } catch {
      text = m[1]!
    }
  } else if (head.startsWith('{') || head.startsWith('[')) {
    return null // JSON with no message: the status says more than a brace soup would
  }
  text = text.trim()
  if (!text) return null
  return text.length > QUOTE_MAX ? `${text.slice(0, QUOTE_MAX - 1).trimEnd()}…` : text
}

type Evidence =
  | { kind: 'failure'; row: FeedAnswerRow; failure: FeedAnswer; alsoRefused: string[] }
  | { kind: 'ok'; at: Date }
  | { kind: 'none' }

/** A row's last failure, when nothing has been READ since it — by that host or by any host. */
function currentFailure(row: FeedAnswerRow, feedOkAt: Date | null): FeedAnswer | null {
  const f = row.lastFailure
  if (!f) return null
  const at = t(f.at)
  if (!Number.isFinite(at)) return null
  const ownOk = t(row.lastOkAt)
  if (Number.isFinite(ownOk) && ownOk > at) return null
  if (feedOkAt && feedOkAt.getTime() > at) return null
  return f
}

/** PURE. What the record says is going on, preferring the server's own row. */
export function currentEvidence(passes: OutagePasses): Evidence {
  const rows = passes.feedAnswers ?? []
  const failing = rows
    .map((row) => ({ row, failure: currentFailure(row, passes.feedOkAt) }))
    .filter((x): x is { row: FeedAnswerRow; failure: FeedAnswer } => x.failure !== null)
  if (failing.length > 0) {
    const pick =
      failing.find((x) => passes.detectionHost !== null && x.row.host === passes.detectionHost) ??
      [...failing].sort((a, b) => t(b.failure.at) - t(a.failure.at))[0]!
    const alsoRefused = failing
      .filter((x) => x !== pick && (x.failure.kind === 'throttle' || x.failure.kind === 'login-wall'))
      .map((x) => x.row.host)
    return { kind: 'failure', row: pick.row, failure: pick.failure, alsoRefused }
  }
  // No row at all is NO EVIDENCE, whatever `feedOkAt` says: the stamp proves a read happened
  // once, not that any host running this build has answered since — which is the sentence the
  // operator needs ("the worker may not be running this build"), never an inferred cause.
  if (rows.length === 0) return { kind: 'none' }
  const oks = [passes.feedOkAt?.getTime() ?? Number.NaN, ...rows.map((r) => t(r.lastOkAt))].filter(Number.isFinite)
  if (oks.length > 0) return { kind: 'ok', at: new Date(Math.max(...oks)) }
  return { kind: 'none' }
}

function isServer(host: string, passes: OutagePasses): boolean {
  return passes.detectionHost !== null && host === passes.detectionHost
}

/** "HTTP 400: "SecFetch Policy violation."" — the status, and Instagram's words when there are any. */
function causeOf(f: FeedAnswer): string {
  const q = quoteOf(f)
  const status = f.status ?? 0
  switch (f.kind) {
    case 'not-json':
      // An EMPTY body is also not JSON, and calling it "a web page" would name a page nobody sent
      // (`evidenceHead` returns null only for an empty or blank body).
      return f.head ? `HTTP ${status}, a web page instead of feed data` : `HTTP ${status}, an empty answer instead of feed data`
    case 'shape':
      return `HTTP ${status}, but not in the shape the feed reader expects${q ? `: "${q}"` : ''}`
    case 'empty':
      return `HTTP ${status} with no posts in it`
    case 'login-wall':
      // The status alone ("HTTP 200") reads as success; the wall is what made it a refusal.
      return `HTTP ${status}, the login wall${q ? `: "${q}"` : ''}`
    default:
      return `HTTP ${status}${q ? `: "${q}"` : ''}`
  }
}

/**
 * PURE. The headline for a blind detection, naming the cause on record. Exported and tested as a
 * table; the health ladder in `view-model.ts` calls it only when `detectionBlind` is true, and the
 * boolean's meaning is unchanged — this changes what the page SAYS, never when it alarms.
 */
export function describeDetectionOutage(passes: OutagePasses, now: number = Date.now()): string {
  const minutes = passes.feedOkAt ? Math.max(0, Math.round((now - passes.feedOkAt.getTime()) / 60_000)) : null
  const found = minutes !== null ? `no paid posts found for ${minutes} min` : 'no paid posts are being found'
  const ev = currentEvidence(passes)

  /**
   * THE SERVER'S RECORDED COOLDOWN IS A REFUSAL ON RECORD, EVEN WITH NO ANSWER ROW BESIDE IT
   * (review, 15 Oct 2026). `detectionBlind` fires on `throttledUntil` alone, and that stamp is
   * written by the primary pass from the anonymous gate — which closes only on a refusal. Two
   * real states reach here with it set and no CURRENT failure row:
   *
   *   - the first passes after this build is deployed: `hydrateAnonGate` adopts the cooldown the
   *     old build persisted, every channel is skipped without a request, so no answer row is
   *     written — and the page would have said "may not be running this build", which is false;
   *   - a Mac read after the server was refused and then stopped: its read makes the server's
   *     row history, and the page would have said "the last feed read succeeded", hiding a
   *     cooldown that is still running.
   *
   * So the cooldown is said first. "Refused" here is evidence, not a guess: the gate recorded it.
   * MUTATION (applied by hand, saw red, restored): deleting this branch fails "a recorded
   * cooldown is never 'may not be running this build'" in tests/feed-evidence.test.ts.
   */
  if (ev.kind !== 'failure' && passes.throttledUntil) {
    return `Instagram refused the server's anonymous reads, and the server is waiting until ${whenLabel(passes.throttledUntil, now)} before it asks again — ${found}.`
  }

  if (ev.kind === 'none') {
    return minutes !== null
      ? `No feed page has been read for ${minutes} min and no answer from Instagram is on record yet — the detection worker may not be running this build.`
      : 'No feed page has been read yet and no answer from Instagram is on record — the detection worker may not be running this build.'
  }
  if (ev.kind === 'ok') {
    return `The last feed read succeeded at ${whenLabel(ev.at, now)} and nothing has been read since — ${found}, and no answer from Instagram is on record after it.`
  }

  const { row, failure: f } = ev
  const server = isServer(row.host, passes)
  const who = server ? 'the server' : row.host
  const fAt = t(f.at)
  const stale =
    Number.isFinite(fAt) && now - fAt > EVIDENCE_STALE_MS
      ? ` The last answer on record is from ${whenLabel(new Date(fAt), now)}, so the detection pass may have stopped asking.`
      : ''

  // The newest failure is the OFFICIAL API's: it was only asked because the anonymous feed had
  // already failed, so the sentence leads with what stopped the fallback and adds the anonymous
  // cause after it — never an anonymous-feed sentence about an answer the Graph API gave.
  if (f.source === 'graph') return describeOfficialFailure(row, f, who, found, now) + stale

  switch (f.kind) {
    case 'throttle':
    case 'login-wall': {
      const others = ev.alsoRefused.map((h) => ` and from ${isServer(h, passes) ? 'the server' : h}`).join('')
      const serverUntil = server ? passes.throttledUntil : null
      const own = f.until ? new Date(f.until) : null
      const until = serverUntil ?? (own && own.getTime() > now ? own : null)
      const retry = until ? `at ${whenLabel(until, now)}` : 'on its next pass'
      return `Instagram is refusing anonymous reads from ${who} (${causeOf(f)})${others} — ${found}; it retries by itself ${retry}.${stale}`
    }
    case 'transport': {
      const msg = quoteOf({ head: f.head, kind: 'transport' }) ?? 'no answer at all'
      return `${server ? 'The server' : row.host} cannot reach Instagram (${msg}) — ${found}.${stale}`
    }
    default: {
      const whose = server ? "the server's" : `${row.host}'s`
      if (f.kind === 'http-error' && (f.status ?? 0) >= 500) {
        return `Instagram's own servers are failing ${whose} feed reads (HTTP ${f.status}) — this is on Instagram's side and usually passes by itself; ${found}.${stale}`
      }
      return `Instagram stopped answering ${whose} feed reads the way it used to (${causeOf(f)}) — this is not a rate limit, so waiting will not fix it; ${found}.${stale}`
    }
  }
}

// ── The official read fallback (src/detection/graphFeed.ts) ─────────────────────────────

const possessive = (who: string): string => `${who}'s`
const capitalised = (s: string): string => (s ? s[0]!.toUpperCase() + s.slice(1) : s)

/** "HTTP 400: "(#100) …"" — the status and Meta's own words, already redacted when recorded. */
function officialCause(f: FeedAnswer): string {
  const q = quoteOf({ head: f.head, kind: 'graph-error' })
  return `HTTP ${f.status ?? 0}${q ? `: "${q}"` : ''}`
}

/**
 * The anonymous half, as its own sentence, from the ANONYMOUS failure on record (never from the
 * newest failure of any source — that is the Graph answer this sentence follows). "Refusing" only
 * for a recorded refusal; empty when nothing anonymous is on record.
 */
function anonymousSentence(row: FeedAnswerRow, who: string): string {
  const a = row.lastAnonymousFailure
  if (!a) return ''
  if (a.kind === 'throttle' || a.kind === 'login-wall') return ` Instagram is refusing anonymous reads from ${who} (${causeOf(a)}).`
  if (a.kind === 'transport') return ` ${capitalised(who)} could not reach Instagram's anonymous feed either.`
  return ` Instagram stopped answering ${possessive(who)} anonymous feed reads the way it used to (${causeOf(a)}).`
}

/** The blind-page sentence when the newest failure on record came from the official API. */
function describeOfficialFailure(row: FeedAnswerRow, f: FeedAnswer, who: string, found: string, now: number): string {
  const anon = anonymousSentence(row, who)
  switch (f.kind) {
    case 'graph-token':
      // A person's step, and the page says it as a sentence — no command (rule: never a shell command on a page).
      return `The official read token is invalid or expired — reading has stopped until it is replaced; ${found}.${anon}`
    case 'graph-rate-limit': {
      const own = f.until ? new Date(f.until) : null
      const retry = own && own.getTime() > now ? `at ${whenLabel(own, now)}` : 'on its next pass'
      return `The official API asked ${who} to slow down (${officialCause(f)}) — ${found}; it retries by itself ${retry}.${anon}`
    }
    case 'graph-not-professional':
      return `The official API cannot read @${f.handle}: it is not a Business or Creator account, or no such username exists (${officialCause(f)}) — ${found}.${anon}`
    case 'transport': {
      const msg = quoteOf({ head: f.head, kind: 'transport' }) ?? 'no answer at all'
      return `${capitalised(who)} cannot reach the official API either (${msg}) — ${found}.${anon}`
    }
    case 'graph-error':
      return `The official API refused ${possessive(who)} reads too (${officialCause(f)}) — ${found}.${anon}`
    default:
      return `The official API did not answer ${possessive(who)} reads the way the reader expects either (${causeOf(f)}) — ${found}.${anon}`
  }
}

/**
 * PURE. The ATTENTION sentence while the official API is serving: detection is NOT blind (a page
 * it serves stamps `detectFeedOkAt`), but the operator must know two things — the anonymous feed
 * is not serving, and what the API serves carries no tag data, so prospects are not being minted
 * from tags. Null unless a host's row says the fallback is serving NOW (`graphSince`, with a page
 * inside the last ninety minutes — an old run of the fallback is history, not the present).
 *
 * The lead is the ANONYMOUS cause on record: "refusing" only for a recorded refusal (or the
 * server's recorded anonymous cooldown), never for a 400 — the defect this page was rewritten for.
 */
export function describeOfficialRead(passes: OutagePasses, now: number = Date.now()): string | null {
  const serving = (passes.feedAnswers ?? []).filter(
    (r) => r.graphSince && r.graphOkAt && Number.isFinite(t(r.graphOkAt)) && now - t(r.graphOkAt) <= EVIDENCE_STALE_MS,
  )
  if (serving.length === 0) return null
  const row = serving.find((r) => isServer(r.host, passes)) ?? serving[0]!
  const who = isServer(row.host, passes) ? 'the server' : row.host
  const since = whenLabel(new Date(t(row.graphSince)), now)
  const a = row.lastAnonymousFailure ?? null
  const lead = a
    ? a.kind === 'throttle' || a.kind === 'login-wall'
      ? 'Instagram is refusing anonymous reads'
      : `Instagram stopped answering ${possessive(who)} anonymous feed reads the way it used to (${causeOf(a)})`
    : passes.throttledUntil
      ? 'Instagram is refusing anonymous reads'
      : 'The anonymous feed is not serving channels'
  return `${lead}, so ${who} is reading channels through the official API (since ${since}); posts read this way carry no tag data.`
}

/**
 * PURE. A few words to append to "Last check read 0 posts · 0 new", or null.
 *
 * Only for a FINISHED check that read nothing, and only when the current failure on record arrived
 * during it (or in the ten minutes before it started — an identical answer is written at most
 * every ten minutes, so the one that explains this check may predate its row). A cause from
 * yesterday must not be pinned to today's check.
 */
export function lastCheckCause(
  passes: OutagePasses,
  run: { startedAt: Date; finishedAt: Date | null; postsSeen: number } | null,
): string | null {
  if (!run || run.finishedAt === null || run.postsSeen > 0) return null
  const ev = currentEvidence(passes)
  if (ev.kind !== 'failure') return null
  if (t(ev.failure.at) < run.startedAt.getTime() - 10 * 60_000) return null
  const f = ev.failure
  if (f.source === 'graph') {
    switch (f.kind) {
      case 'graph-token':
        return 'the official read token is invalid or expired'
      case 'graph-rate-limit':
        return 'the official API asked to slow down'
      case 'transport':
        return 'the official API could not be reached'
      default:
        return `the official API answered HTTP ${f.status ?? 0}`
    }
  }
  switch (f.kind) {
    case 'transport':
      return 'Instagram could not be reached'
    case 'not-json':
      return f.head ? `Instagram answered HTTP ${f.status ?? 0} with a web page` : `Instagram answered HTTP ${f.status ?? 0} with an empty answer`
    case 'empty':
      return `Instagram answered HTTP ${f.status ?? 0} with no posts`
    // A bare "answered HTTP 200" reads as success; the wall, or the changed shape, is what made it fail.
    case 'login-wall':
      return `Instagram answered HTTP ${f.status ?? 0} with the login wall`
    case 'shape':
      return `Instagram answered HTTP ${f.status ?? 0} in an unexpected shape`
    default:
      return `Instagram answered HTTP ${f.status ?? 0}`
  }
}
