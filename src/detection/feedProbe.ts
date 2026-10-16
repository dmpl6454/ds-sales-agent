/**
 * feedProbe.ts — `pnpm ig:probe`: ASK INSTAGRAM, FROM THIS HOST, UNDER EACH IDENTITY, ONCE.
 *
 * ── WHY (15 Oct 2026) ──────────────────────────────────────────────────────────────────
 *
 * The landing page read "no paid posts are being found since 1348 min ago": the Linode worker and
 * the Mac's failover had both read nothing for ~22.5 hours, and nothing on record said why. Task A
 * (feedEvidence.ts) makes the NEXT pass put Instagram's answer on screen. This answers the
 * question that comes before any fix, and that cost a day on 4 Sept: is it THIS ADDRESS, THIS
 * IDENTITY, or EVERYONE? CLAUDE.md's lesson — "vary the CLIENT before blaming the ADDRESS; a control
 * probe under a different identity costs one request" — is a command now, run on the Mac and on
 * the box, and the two outputs side by side settle it:
 *
 *   served on one candidate and not another   → the identity is the fix (FEED_HEADERS, one edit)
 *   refused (401/429/login wall) everywhere,  → this address is refused; it lifts by itself
 *     served on the other host
 *   refused everywhere, on both hosts          → a platform wall; the official fallback is what is left
 *   400 "update" / "SecFetch"                  → how the request presents itself, not a rate limit
 *
 * ── WHAT IT MUST NOT DO, AND WHY EACH IS ASSERTED ─────────────────────────────────────
 *
 *  - It never closes the gate. A person's probe answered 401 must not halt the detection pass on
 *    this host for 15→60 minutes: the probe runs in its own process, never calls
 *    `anonGateRecordThrottle`/`anonGateRecordSuccess`, and reads the stored gate only to SAY it is
 *    closed. tests/probe.test.ts drives a 401 and a 200 login wall and asserts the gate untouched;
 *    tests/anon-gate.test.ts exempts this file from "every caller records" and asserts the reverse.
 *  - It writes no evidence row. The `detectFeedAnswer:<host>` row is the pass's statement of what
 *    the server got; a one-off probe overwriting it would show the operator a person's single
 *    request as the server's answer. No `recordFeedAnswer`, no Setting write of any kind, and
 *    `--graph` calls the official read with `record: false`.
 *  - It sends no credential. Every candidate is from FEED_IDENTITY_PROBES (feed.ts), where a test
 *    asserts no Cookie/Authorization/session header on any of them — decision 4.
 *  - It makes exactly the requests it announces, one per candidate, 6 s apart, with no retry:
 *    it is a measurement, and a retry would be a second measurement wearing the first one's name.
 *
 * NOT MEASURED, stated: what Instagram answers today. The machine this was written on cannot
 * reach Instagram; every answer this module handles was driven through `setIgTransportForTests`.
 */
import { igGet, type IgResponse } from './igHttp'
import { FEED_IDENTITY_PROBES, FEED_HEADERS, IG_APP_ID, REQUEST_TIMEOUT_MS, acceptedFeedItems, anonymousCutAnswer, type FeedIdentityProbe } from './feed'
import {
  FEED_ANSWER_KEY_PREFIX,
  classifyFeedAnswer,
  evidenceHead,
  parseFeedAnswerRows,
  type FeedAnswer,
  type FeedAnswerKind,
  type FeedAnswerRow,
} from './feedEvidence'
import { DETECT_FEED_OK_KEY, DETECT_THROTTLED_KEY, anonGateHost, anonGateSettingKey } from './anonGate'
import { graphConfig, graphConfigured, probeOfficialRead, scrub } from './graphFeed'
import { prisma } from '@/lib/db'
import { istStamp, relativeLabel } from '@/lib/time'

/** Between two anonymous requests. A burst is what earns a throttle; six seconds matches `ig:brands`. */
export const PROBE_SPACING_MS = 6_000
export const DEFAULT_PROBE_HANDLE = 'viralbhayani'

/** `anonThrottle:` — derived from anonGate's own key builder, never retyped. */
const GATE_KEY_PREFIX = anonGateSettingKey('')

const USERNAME = /^[A-Za-z0-9._]{1,30}$/
/**
 * An Instagram for Android User-Agent: "Instagram <version> Android (", then printable ASCII on one
 * line. "Android" is REQUIRED (review, 15 Oct 2026): an iPhone User-Agent would go out beside the
 * Android app id — the contradiction the refusal sentence says this check exists to stop.
 */
const ANDROID_UA = /^Instagram \d[\d.]* Android \([\x20-\x7e]{0,380}$/

const IN_USE = FEED_IDENTITY_PROBES[0]!

export const PROBE_USAGE = [
  'pnpm ig:probe [--handle <username>] [--ua "<Instagram Android User-Agent>"] [--graph] [--offline]',
  '',
  '  Prints what the detection passes last recorded, then asks Instagram once per identity, 6 s apart.',
  `  --handle   the account to read (default @${DEFAULT_PROBE_HANDLE})`,
  '  --ua       adds one more candidate: the app identity with this User-Agent',
  '  --graph    adds one request through the official API, when this host is configured for it',
  '  --offline  prints the stored evidence and makes no request at all',
].join('\n')

// ── The plan (PURE) ──────────────────────────────────────────────────────────────────

export interface ProbePlan {
  handle: string
  offline: boolean
  candidates: readonly FeedIdentityProbe[]
  graph: boolean
}

export type ProbeArgs = { kind: 'run'; plan: ProbePlan } | { kind: 'help' } | { kind: 'refused'; why: string }

/**
 * The app identity with a person's User-Agent — the in-use URL and headers, one header changed.
 * Built from FEED_HEADERS rather than declared, so this file declares no identity of its own.
 */
export function customUaProbe(ua: string): FeedIdentityProbe {
  return {
    name: 'android-app, your User-Agent',
    url: IN_USE.url,
    headers: { ...FEED_HEADERS, 'User-Agent': ua },
    note: 'the identity in use with the User-Agent you passed in --ua',
  }
}

/** PURE. The command line, read. Every refusal says why, in a sentence. */
export function parseProbeArgs(argv: readonly string[]): ProbeArgs {
  let handle = DEFAULT_PROBE_HANDLE
  let offline = false
  let graph = false
  let ua: string | null = null
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    const [flag, inline] = arg.startsWith('--') && arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, null]
    const value = (): string | null => {
      if (inline !== null) return inline
      const next = argv[i + 1]
      if (next === undefined || next.startsWith('--')) return null
      i++
      return next
    }
    switch (flag) {
      case '--help':
      case '-h':
        return { kind: 'help' }
      case '--offline':
        offline = true
        break
      case '--graph':
        graph = true
        break
      case '--handle': {
        const v = value()?.replace(/^@/, '') ?? null
        if (!v || !USERNAME.test(v)) {
          return { kind: 'refused', why: `--handle needs an Instagram username (letters, digits, dots and underscores, at most 30); got ${v ? `"${v}"` : 'nothing'}.` }
        }
        handle = v
        break
      }
      case '--ua': {
        const v = value()
        if (!v || !ANDROID_UA.test(v)) {
          return {
            kind: 'refused',
            why: '--ua needs one Instagram for Android User-Agent, on one line, beginning "Instagram <version> Android". This candidate keeps the app\'s id and host, and any other User-Agent would contradict them.',
          }
        }
        ua = v
        break
      }
      default:
        return { kind: 'refused', why: `"${arg}" is not something ig:probe understands.\n\n${PROBE_USAGE}` }
    }
  }
  const candidates = [...FEED_IDENTITY_PROBES]
  // After the app candidates and before the web control, so the app identities are compared side by side.
  if (ua) candidates.splice(candidates.length - 1, 0, customUaProbe(ua))
  return { kind: 'run', plan: { handle, offline, candidates, graph } }
}

/** PURE. How many requests a plan makes — printed BEFORE any is made. */
export function probeRequestCount(plan: ProbePlan, graphReady: boolean): { anonymous: number; graph: number; total: number } {
  if (plan.offline) return { anonymous: 0, graph: 0, total: 0 }
  const anonymous = plan.candidates.length
  const graph = plan.graph && graphReady ? 1 : 0
  return { anonymous, graph, total: anonymous + graph }
}

/** PURE. The announcement. */
export function describeRequestCount(plan: ProbePlan, count: ReturnType<typeof probeRequestCount>, spacingMs: number = PROBE_SPACING_MS): string {
  if (count.total === 0) return 'This makes no request.'
  const s = (n: number) => (n === 1 ? '' : 's')
  const spacing = Math.round(spacingMs / 1000)
  const anon = `${count.anonymous} to Instagram's anonymous feed for @${plan.handle}, one per identity${count.anonymous > 1 ? `, ${spacing} s apart` : ''}`
  const graph = count.graph ? `, and ${count.graph} to the official API` : ''
  return (
    `This makes ${count.total} request${s(count.total)}: ${anon}${graph}. It records nothing — this host's anonymous gate ` +
    'and the evidence rows the detection pass writes are left exactly as they are. ' +
    // igHttp follows up to three redirects, as it does for the pass, so "one request" is one CALL.
    'A redirect, if Instagram answers with one, is followed the way the detection pass follows it.'
  )
}

// ── Asking ───────────────────────────────────────────────────────────────────────────

export interface IdentityProbeResult {
  name: string
  note: string
  /** The URL's host — never the URL itself, which a later candidate type might carry a secret in. */
  host: string
  /** True for the Android app identity (in use, newer, custom), false for the web control. */
  isApp: boolean
  status: number | null
  contentType: string | null
  kind: FeedAnswerKind
  /** Length of a JSON `items` array, whatever its shape — "had posts" even when the reader would refuse them. */
  items: number | null
  /** Redacted, cut — `classifyFeedAnswer`'s head, or the transport error's words. */
  head: string | null
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return 'an unreadable URL'
  }
}

/**
 * ONE request per candidate, through `igGet`, spaced, never retried. Records nothing. `onResult`
 * lets the command print each answer as it arrives rather than after the whole run.
 */
export async function probeIdentities(
  plan: ProbePlan,
  deps: { sleep?: (ms: number) => Promise<void>; spacingMs?: number; onResult?: (r: IdentityProbeResult, index: number) => void } = {},
): Promise<IdentityProbeResult[]> {
  if (plan.offline) return []
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const spacingMs = deps.spacingMs ?? PROBE_SPACING_MS
  const results: IdentityProbeResult[] = []
  for (const [i, c] of plan.candidates.entries()) {
    if (i > 0) await sleep(spacingMs)
    const url = c.url(plan.handle)
    const base = { name: c.name, note: c.note, host: hostOf(url), isApp: c.headers['X-IG-App-ID'] === IG_APP_ID }
    let result: IdentityProbeResult
    let res: IgResponse | null = null
    let transportWhy = ''
    try {
      res = await igGet(url, { headers: { ...c.headers }, timeoutMs: REQUEST_TIMEOUT_MS })
    } catch (err) {
      transportWhy = err instanceof Error ? err.message || err.name : String(err)
      // A status that arrived is an answer, judged exactly as the pass judges it (feed.ts).
      res = anonymousCutAnswer(err, transportWhy)
    }
    if (res) {
      const body = await res.text().catch(() => '')
      const contentType = res.contentType ?? null
      let json: unknown
      let jsonOk = false
      try {
        json = JSON.parse(body) as unknown
        jsonOk = true
      } catch {
        jsonOk = false
      }
      // The same `parsedItems` rule fetchFeed passes, so the probe's kind is the pass's kind.
      const parsedItems = !res.ok ? undefined : jsonOk ? acceptedFeedItems(json) : null
      const answer = classifyFeedAnswer({ status: res.status, contentType, body, parsedItems })
      const raw = jsonOk && json && typeof json === 'object' ? (json as Record<string, unknown>).items : undefined
      result = { ...base, status: res.status, contentType, kind: answer.kind, items: Array.isArray(raw) ? raw.length : null, head: answer.head }
    } else {
      result = { ...base, status: null, contentType: null, kind: 'transport', items: null, head: evidenceHead(transportWhy) }
    }
    results.push(result)
    deps.onResult?.(result, i)
  }
  return results
}

// ── Saying what came back (PURE) ─────────────────────────────────────────────────────

/** Plain words for every kind. TOTAL: a kind added to feedEvidence without a label here fails the compile. */
export const PROBE_KIND_LABEL: Record<FeedAnswerKind, string> = {
  ok: 'served — the feed reader accepts it',
  empty: 'served, with no posts in it',
  throttle: 'refused — Instagram said stop',
  'login-wall': 'refused — the login wall',
  'http-error': 'an error status',
  'not-json': 'a web page, not feed data',
  shape: 'JSON, but not in the shape the feed reader accepts',
  transport: 'no answer — the request did not reach Instagram',
  'graph-token': 'the official read token is invalid or expired',
  'graph-rate-limit': 'the official API asked this host to slow down',
  'graph-not-professional': 'not a Business or Creator account, or no such account',
  'graph-error': 'the official API refused the read',
}

/** PURE. One candidate's answer, as the lines the command prints. */
export function formatProbeResult(r: IdentityProbeResult, index: number): string[] {
  const parts = [
    r.status === null ? 'no HTTP status' : `HTTP ${r.status}`,
    ...(r.status === null ? [] : [r.contentType ?? 'no content type']),
    ...(r.items === null ? [] : [`${r.items} item${r.items === 1 ? '' : 's'}`]),
    PROBE_KIND_LABEL[r.kind],
  ]
  const lines = [`  ${index + 1}. ${r.name} — ${r.host}`, `     ${r.note}`, `     ${parts.join(' · ')}`]
  if (r.head) lines.push(`     body: ${r.head}`)
  return lines
}

const UPDATE_WORDS = /update|upgrade|secfetch|version|unsupported|client/i

/**
 * PURE. What one host's answers mean, in sentences. Deliberately about THIS host only: the
 * address-versus-wall question needs the other host's output beside it, and the sentence says so
 * rather than guessing.
 */
export function readProbeResults(results: readonly IdentityProbeResult[]): string[] {
  if (results.length === 0) return []
  const served = (r: IdentityProbeResult) => r.kind === 'ok'
  const refused = (r: IdentityProbeResult) => r.kind === 'throttle' || r.kind === 'login-wall'
  if (results.every((r) => r.kind === 'transport')) {
    return ['No identity got an answer: this host cannot reach Instagram at all (network, DNS or a firewall). Instagram has not refused anything here.']
  }
  const inUse = results.find((r) => r.name === IN_USE.name)
  if (inUse && served(inUse)) {
    return [
      'The identity in use is served from this host, so neither this address nor the identity is the problem here. If detection still reads nothing on this host, the pass itself is not running, or not running this build — check the worker.',
    ]
  }
  const lines: string[] = []
  const otherApps = results.filter((r) => r !== inUse && r.isApp && served(r))
  const web = results.find((r) => !r.isApp)
  /**
   * INCONCLUSIVE when the identity in use got NO ANSWER, or Instagram's own 5xx (review, 15 Oct
   * 2026). Another candidate being served then says nothing about the identity: one network blip
   * or one server error on the first request of the run would otherwise tell a person to edit the
   * production identity — and the switch below would add "probe again" right after, contradicting
   * it. The comparison only means something when the identity in use was actually ANSWERED.
   */
  const inconclusive =
    inUse !== undefined && (inUse.kind === 'transport' || (inUse.kind === 'http-error' && (inUse.status ?? 0) >= 500))
  if (otherApps.length > 0 && !inconclusive) {
    lines.push(
      `${otherApps.map((r) => `"${r.name}"`).join(' and ')} ${otherApps.length === 1 ? 'was' : 'were'} served and the identity in use was not: the identity is the fix. ` +
        'It is one edit (FEED_HEADERS in src/detection/feed.ts); run this probe on both hosts again before deploying it.',
    )
  } else if (web && served(web) && !inconclusive) {
    lines.push(
      'Only the retired web identity was served — the reverse of 8 Sept (its headers, sent over node:https). Instagram is refusing the app identity, not this address; try --ua with the User-Agent of a current Instagram for Android before changing anything.',
    )
  }
  if (!inUse) return lines
  switch (inUse.kind) {
    case 'throttle':
    case 'login-wall':
      if (otherApps.length === 0 && !(web && served(web))) {
        lines.push(
          results.every((r) => refused(r) || r.kind === 'transport')
            ? 'Every identity was refused from this host. Run the same probe on the other host: refused there too means Instagram has walled anonymous reads for everyone, and the official read fallback is the remaining path; served there means this address is being refused, which lifts by itself.'
            : 'The identity in use was refused from this host and no other identity was served. Run the same probe on the other host before deciding whether it is this address or everyone.',
        )
      }
      break
    case 'http-error': {
      const status = inUse.status ?? 0
      if (status >= 500) {
        lines.push(
          `Instagram's own servers failed the identity in use (HTTP ${status}) — that is on Instagram's side and usually passes by itself; probe again later.` +
            (otherApps.length > 0 || (web && served(web)) ? ' Another candidate being served in the same run does not show the identity is the problem.' : ''),
        )
      } else if (UPDATE_WORDS.test(inUse.head ?? '')) {
        lines.push(
          `Instagram rejected how the request presents itself (HTTP ${status}) — an identity problem, not a rate limit, so waiting will not fix it. Try --ua with the User-Agent of a current Instagram for Android.`,
        )
      } else {
        lines.push(`Instagram answered the identity in use with HTTP ${status} — not a rate limit, so waiting will not fix it. The body above is the evidence.`)
      }
      break
    }
    case 'not-json':
    case 'shape':
    case 'empty':
      lines.push(
        `Instagram answered the identity in use, but not with feed data (${PROBE_KIND_LABEL[inUse.kind]}) — the endpoint or its answer has changed. This is not a rate limit, so waiting will not fix it.`,
      )
      break
    case 'transport':
      lines.push('The identity in use got no answer while another candidate did. Probe again: one network failure is not a verdict.')
      break
    default:
      break
  }
  return lines
}

// ── The stored evidence ──────────────────────────────────────────────────────────────

export interface GateScopeView {
  throttledUntil: number | null
  strikes: number
  lastThrottleAt: number | null
  lastThrottleSource: string | null
  lastOkAt: number | null
}

export interface StoredEvidence {
  feedAnswers: FeedAnswerRow[]
  gates: Array<{ host: string; scopes: Partial<Record<'feed' | 'profile', GateScopeView>> }>
  feedOkAt: Date | null
  throttledUntil: Date | null
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

function gateView(v: unknown): GateScopeView | null {
  if (!v || typeof v !== 'object') return null
  const s = v as Record<string, unknown>
  return {
    throttledUntil: num(s.throttledUntil),
    strikes: num(s.strikes) ?? 0,
    lastThrottleAt: num(s.lastThrottleAt),
    lastThrottleSource: typeof s.lastThrottleSource === 'string' ? s.lastThrottleSource : null,
    lastOkAt: num(s.lastOkAt),
  }
}

/**
 * PURE. Rows → what is on record. The feed answers go through feedEvidence's own parser; an
 * `anonThrottle` row is either the two-scope shape or the legacy single state (anonGate's
 * `hydrateAnonGate` reads both), and an unreadable row is skipped rather than guessed at.
 */
export function parseStoredEvidence(rows: ReadonlyArray<{ key: string; value: string }>): StoredEvidence {
  const at = (key: string): Date | null => {
    const v = rows.find((r) => r.key === key)?.value
    const d = v ? new Date(v) : null
    return d && !Number.isNaN(d.getTime()) ? d : null
  }
  const gates: StoredEvidence['gates'] = []
  for (const row of rows) {
    if (!row.key.startsWith(GATE_KEY_PREFIX)) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(row.value)
    } catch {
      continue
    }
    if (!parsed || typeof parsed !== 'object') continue
    const o = parsed as Record<string, unknown>
    const scopes: Partial<Record<'feed' | 'profile', GateScopeView>> = {}
    if ('feed' in o || 'profile' in o) {
      const feed = gateView(o.feed)
      const profile = gateView(o.profile)
      if (feed) scopes.feed = feed
      if (profile) scopes.profile = profile
    } else {
      const legacy = gateView(o)
      if (legacy) scopes[legacy.lastThrottleSource === 'feed' ? 'feed' : 'profile'] = legacy
    }
    gates.push({ host: row.key.slice(GATE_KEY_PREFIX.length), scopes })
  }
  return { feedAnswers: parseFeedAnswerRows(rows), gates, feedOkAt: at(DETECT_FEED_OK_KEY), throttledUntil: at(DETECT_THROTTLED_KEY) }
}

/**
 * Read it, in ONE query. Not `readFeedAnswers`, deliberately: that reader turns a database error
 * into "no rows", which is right for a dashboard sentence and wrong here — a probe that printed
 * "nothing on record" because the tunnel was down would be the confident all-clear this project
 * keeps paying for. The parser underneath is the same one (`parseFeedAnswerRows`). Throws.
 */
export async function readStoredEvidence(): Promise<StoredEvidence> {
  const rows = await prisma.setting.findMany({
    where: {
      OR: [
        { key: { startsWith: FEED_ANSWER_KEY_PREFIX } },
        { key: { startsWith: GATE_KEY_PREFIX } },
        { key: { in: [DETECT_FEED_OK_KEY, DETECT_THROTTLED_KEY] } },
      ],
    },
    select: { key: true, value: true },
  })
  return parseStoredEvidence(rows)
}

/** "15 Oct 2026, 14:30 IST (12 min ago)", or "(in 18 min)" for a time still ahead. */
export function stampLabel(at: Date, now: Date): string {
  const ms = at.getTime() - now.getTime()
  if (ms <= 0) return `${istStamp(at)} IST (${relativeLabel(at, now)})`
  const mins = Math.ceil(ms / 60_000)
  return `${istStamp(at)} IST (in ${mins < 120 ? `${mins} min` : `${Math.round(mins / 60)}h`})`
}

function answerLine(a: FeedAnswer, now: Date): string {
  const parts = [
    PROBE_KIND_LABEL[a.kind],
    a.status === null ? 'no HTTP status' : `HTTP ${a.status}`,
    ...(a.kind === 'ok' && a.items !== null ? [`${a.items} item${a.items === 1 ? '' : 's'}`] : []),
    ...(a.source === 'graph' ? ['through the official API'] : []),
    `@${a.handle}`,
    stampLabel(new Date(a.at), now),
  ]
  return parts.join(' · ')
}

function sameAnswer(x: FeedAnswer | null | undefined, y: FeedAnswer | null | undefined): boolean {
  return !!x && !!y && x.at === y.at && x.kind === y.kind && x.handle === y.handle && x.source === y.source
}

function gateLine(name: 'feed' | 'profile', g: GateScopeView | undefined, now: Date): string {
  if (!g) return `${name}: nothing on record`
  if (g.throttledUntil !== null && g.throttledUntil > now.getTime()) {
    const last = g.lastThrottleAt !== null ? `, last refused ${stampLabel(new Date(g.lastThrottleAt), now)}` : ''
    return `${name}: CLOSED until ${stampLabel(new Date(g.throttledUntil), now)}, ${g.strikes} strike${g.strikes === 1 ? '' : 's'}${last}`
  }
  const ok = g.lastOkAt !== null ? `, last success ${stampLabel(new Date(g.lastOkAt), now)}` : ''
  return `${name}: open${g.strikes > 0 ? ` (${g.strikes} strike${g.strikes === 1 ? '' : 's'} on record)` : ''}${ok}`
}

/**
 * PURE. The stored evidence as lines. `clean` runs over every body head before it is printed —
 * heads are redacted when written, and re-redacting is idempotent, so a row written by an older
 * build cannot put a token on a terminal.
 */
export function formatStoredEvidence(
  ev: StoredEvidence,
  opts: { now: Date; thisHost: string; clean?: (s: string) => string | null },
): string[] {
  const clean = opts.clean ?? ((s: string) => evidenceHead(s))
  const mark = (host: string) => (host === opts.thisHost ? `${host} (this host)` : host)
  const out: string[] = [`What the detection passes last recorded (this host is ${opts.thisHost})`, '', '  Feed answers']
  if (ev.feedAnswers.length === 0) {
    out.push('    none on record — no host running this build has asked Instagram since it was deployed')
  }
  for (const row of ev.feedAnswers) {
    out.push(`    ${mark(row.host)}`)
    out.push(`      last answer    ${answerLine(row.last, opts.now)}`)
    const head = row.last.head ? clean(row.last.head) : null
    if (head) out.push(`                     body: ${head}`)
    if (row.lastFailure && !sameAnswer(row.lastFailure, row.last)) {
      out.push(`      last failure   ${answerLine(row.lastFailure, opts.now)}`)
      const fh = row.lastFailure.head ? clean(row.lastFailure.head) : null
      if (fh) out.push(`                     body: ${fh}`)
    }
    out.push(`      last success   ${row.lastOkAt ? stampLabel(new Date(row.lastOkAt), opts.now) : 'none on record'}`)
    if (row.graphSince) out.push(`      official API   serving this host since ${stampLabel(new Date(row.graphSince), opts.now)}`)
  }
  out.push('', '  Anonymous gate')
  if (ev.gates.length === 0) out.push('    no host has recorded a throttle or a recovery')
  for (const g of ev.gates) {
    out.push(`    ${mark(g.host)}`)
    out.push(`      ${gateLine('feed', g.scopes.feed, opts.now)}`)
    out.push(`      ${gateLine('profile', g.scopes.profile, opts.now)}`)
  }
  out.push(
    '',
    '  Detection stamps',
    `    last feed page read     ${ev.feedOkAt ? stampLabel(ev.feedOkAt, opts.now) : 'never recorded'}`,
    `    server cooldown until   ${ev.throttledUntil ? stampLabel(ev.throttledUntil, opts.now) : 'not set'}`,
  )
  return out
}

// ── The command ──────────────────────────────────────────────────────────────────────

/**
 * PURE. A Prisma error is a code frame — the call, the file, five numbered source lines — and its
 * LAST line is the cause ("The table `main.Setting` does not exist…", "Can't reach database
 * server at …"). Found by running the command against a database with no Setting table: the whole
 * frame was printed as one run-on line. Trailing full stops are dropped; the sentence adds its own.
 */
export function lastLineOf(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  const last = msg.split('\n').map((l) => l.trim()).filter(Boolean).pop() ?? ''
  return last.replace(/[.\s]+$/, '')
}

export interface ProbeIo {
  out: (line: string) => void
  now?: () => Date
  sleep?: (ms: number) => Promise<void>
  spacingMs?: number
  readStored?: () => Promise<StoredEvidence>
  graphReady?: () => boolean
  probeGraph?: (handle: string) => Promise<{ ok: boolean; sentence: string }>
}

/**
 * The whole command. Returns the exit code: 0 when the identity in use was served (or nothing was
 * asked), 1 when it was not — so it composes with anything that checks a status, the
 * `worker:heartbeat` rule.
 */
export async function runProbe(plan: ProbePlan, io: ProbeIo): Promise<number> {
  const now = io.now ?? (() => new Date())
  const out = io.out
  const graphReady = (io.graphReady ?? graphConfigured)()
  const token = graphConfig()?.token ?? ''
  const clean = (s: string) => scrub(s, token, 600)
  const thisHost = anonGateHost()

  out(`ig:probe — @${plan.handle}, from ${thisHost}`)
  out('')
  let stored: StoredEvidence | null = null
  try {
    stored = await (io.readStored ?? readStoredEvidence)()
    for (const line of formatStoredEvidence(stored, { now: now(), thisHost, clean })) out(line)
  } catch (err) {
    out(`Could not read the stored evidence: ${clean(lastLineOf(err)) ?? 'no reason given'}.`)
    out('The requests below still run; they do not need the database.')
  }
  out('')

  if (plan.offline) {
    out('--offline: no request made.')
    return 0
  }

  out(describeRequestCount(plan, probeRequestCount(plan, graphReady), io.spacingMs ?? PROBE_SPACING_MS))
  const ownGate = stored?.gates.find((g) => g.host === thisHost)?.scopes.feed
  if (ownGate?.throttledUntil != null && ownGate.throttledUntil > now().getTime()) {
    out(
      `This host's anonymous feed gate is closed until ${stampLabel(new Date(ownGate.throttledUntil), now())}. The probe asks anyway, once, ` +
        'and closes nothing: the detection pass keeps waiting exactly as it was.',
    )
  }
  if (plan.graph && !graphReady) {
    out(
      '--graph: the official read fallback is not configured on this host, so no official request is made. It needs META_GRAPH_TOKEN and ' +
        "META_IG_USER_ID in this host's .env and a worker restart — docs/DEPLOY.md, \"Official read fallback\". Turning it on is Tabish's decision.",
    )
  }
  out('')

  const results = await probeIdentities(plan, {
    sleep: io.sleep,
    spacingMs: io.spacingMs,
    onResult: (r, i) => {
      for (const line of formatProbeResult(r, i)) out(line)
    },
  })

  if (plan.graph && graphReady) {
    const g = await (io.probeGraph ?? probeOfficialRead)(plan.handle)
    out(`  ${plan.candidates.length + 1}. official API (Business Discovery)`)
    out(`     ${clean(g.sentence) ?? 'no answer'}`)
  }

  const reading = readProbeResults(results)
  if (reading.length > 0) {
    out('')
    out("What this host's answers say")
    for (const line of reading) out(`  ${line}`)
  }
  const inUse = results.find((r) => r.name === IN_USE.name)
  return inUse && inUse.kind === 'ok' ? 0 : results.length === 0 ? 0 : 1
}
