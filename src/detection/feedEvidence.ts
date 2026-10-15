/**
 * feedEvidence.ts — WHAT INSTAGRAM ACTUALLY ANSWERED, kept where a screen can read it.
 *
 * ── WHY THIS EXISTS (15 Oct 2026) ──────────────────────────────────────────────────────
 *
 * The operator's landing page read "Instagram is refusing anonymous reads — no paid posts are
 * being found since 1348 min ago" and "Last check read 0 posts · 0 new". Both the Linode
 * worker and the Mac's detection failover had read nothing for ~22.5 hours. MEASURED from the
 * screenshot; and the database could not say WHY, which is the defect this module closes:
 *
 *   - `fetchFeed` recorded a throttle in anonGate for 401/429/403-with-login-wall, and nothing
 *     else. Any OTHER refusal — a 400 ("update required", "SecFetch Policy violation."), a 200
 *     carrying a web page or `{"status":"fail"}`, a transport error — was one `channel failed`
 *     log line on whichever host ran the pass, and the body was thrown away;
 *   - `detectionBlind` rendered the SAME "refusing anonymous reads" headline whenever the feed
 *     stamp was stale, whether or not a refusal had ever been recorded. A sentence asserting a
 *     cause nobody measured is the shape this project keeps paying for (CLAUDE.md, the
 *     `noFrameHere` counter: "a number that names a reason must be true about that reason").
 *
 * On 4 Sept the same banner had the opposite cause from the obvious one — Instagram walled the
 * WEB identity, not our address — and it took a day to find because the evidence was not kept.
 * So every exit of `fetchFeed` now classifies the answer (PURE, `classifyFeedAnswer`) and the
 * newest answer per host is written to `Setting['detectFeedAnswer:<host>']`, beside the last
 * failure and the last success. The dashboard reads those rows and says which it is.
 *
 * NOT MEASURED, stated: what Instagram is answering right now. The machine this was written on
 * cannot reach Instagram. This module does not diagnose the 15 Oct outage; it makes the next
 * pass on the real hosts put the answer on screen.
 *
 * THREE RULES THAT MUST NOT BE LOOSENED:
 *
 *  1. A body is EVIDENCE, and evidence can carry a credential. `head` is redacted before it is
 *     cut (a token straddling the cut must not leak half of itself) and before it is stored or
 *     put in an error message. Instagram's error bodies are short JSON sentences, which is what
 *     an operator needs to read; nothing longer than 240 characters is kept.
 *  2. Recording never fails a read and never throws — the anonGate `persist()` contract. A
 *     dashboard sentence is worth less than a feed page.
 *  3. A 200 that IS the login wall is a REFUSAL, not a shape change. Before this, a 200
 *     `{"status":"fail","require_login":true}` failed the schema, was filed as "feed shape
 *     changed — detection is blind until fixed", and the pass moved on and spent a request on
 *     every remaining channel. `isLoginWallBody` makes it close the gate like a 401 does, which
 *     halts the pass. Fewer requests, never more.
 */
import { prisma } from '@/lib/db'
import { anonGateHost, isThrottleResponse } from './anonGate'

/** The Setting key family. One row per host — the server and every Mac that reads in its place. */
export const FEED_ANSWER_KEY_PREFIX = 'detectFeedAnswer:'

export function feedAnswerKey(host: string = anonGateHost()): string {
  return `${FEED_ANSWER_KEY_PREFIX}${host}`
}

/**
 * Every kind an answer can be. A const array rather than only a union, so the row parser and
 * the type cannot disagree — a kind the parser does not know is an unreadable row, skipped.
 *
 * Room is left for an official (Graph API) source to append its own kinds — 'graph-token',
 * 'graph-rate-limit', 'graph-not-professional', 'graph-error' — without touching the
 * anonymous ones, which is why `source` exists on the answer.
 */
export const FEED_ANSWER_KINDS = [
  'ok',
  /** Status says stop: 401, 429, or 403 carrying the wall (anonGate's `isThrottleResponse`). */
  'throttle',
  /** Any other status whose BODY is the wall — the 200 case is the one that hid. */
  'login-wall',
  /** A non-2xx status that is not a throttle: 400 "SecFetch Policy violation.", 404, 5xx. */
  'http-error',
  /** A 2xx whose body is not JSON — the SPA shell, an interstitial page. */
  'not-json',
  /** JSON, but not the feed's shape (`FeedResponseSchema` failed). */
  'shape',
  /** The transport failed after its retries — DNS, TLS, a reset, a timeout. No status. */
  'transport',
  /** A 2xx feed with zero items on the first page. */
  'empty',
  /**
   * THE OFFICIAL SOURCE'S OWN KINDS (src/detection/graphFeed.ts), recorded with `source:
   * 'graph'`. Its transport failures, empty pages and changed shapes reuse the kinds above;
   * these four are the Graph error codes that mean different things to a person:
   */
  /** Code 190 — the read token is invalid or expired; a person must mint a new one. */
  'graph-token',
  /** Codes 4 / 17 / 32 / 613 / 80000-80014 — the API asked us to slow down. */
  'graph-rate-limit',
  /** The account is not a Business/Creator account, or no such username (code 110 and kin). */
  'graph-not-professional',
  /** Any other Graph refusal — a permission, a wrong account id, an unknown error. */
  'graph-error',
] as const
export type FeedAnswerKind = (typeof FEED_ANSWER_KINDS)[number]

export type FeedAnswerSource = 'anonymous-app' | 'graph'

export interface FeedAnswer {
  /** ISO time the answer arrived. */
  at: string
  /** `anonGateHost()` of the machine that asked. */
  host: string
  source: FeedAnswerSource
  handle: string
  kind: FeedAnswerKind
  status: number | null
  contentType: string | null
  /** The first 240 characters of the body (or a transport error), control characters collapsed and tokens redacted. */
  head: string | null
  /** Items on the page, when one parsed. */
  items: number | null
  /** When this host's anonymous gate reopens — set for a throttle or a login wall. */
  until?: string | null
}

/** What one host's Setting row holds. */
export interface FeedAnswerRecord {
  last: FeedAnswer
  lastFailure: FeedAnswer | null
  lastOkAt: string | null
  /**
   * THE OFFICIAL FALLBACK'S OWN FACTS (15 Oct 2026), so the page can say "reading through the
   * official API since 09:40" truthfully. Optional on purpose: a row written by a build before
   * the fallback existed reads as "never served by it", which is what it was.
   *
   * `lastAnonymousFailure` is kept apart from `lastFailure` because the newest failure of ANY
   * source may be a Graph answer, and the sentence about WHY the server left the anonymous feed
   * ("refusing" versus "answering differently") must come from an anonymous answer — saying
   * "refusing" about a 400 is the very defect this module was written to end.
   */
  lastAnonymousFailure?: FeedAnswer | null
  /** When the official API began serving this host, cleared the moment the anonymous feed reads again. */
  graphSince?: string | null
  /** The newest page the official API served. */
  graphOkAt?: string | null
}

/** A parsed row, newest first from `readFeedAnswers`. `host` comes from the KEY, which names the row. */
export interface FeedAnswerRow extends FeedAnswerRecord {
  host: string
}

export const FEED_ANSWER_HEAD_MAX = 240

/** A refusal closes the gate and halts the pass; every other failure is per channel. */
export function isRefusalKind(kind: FeedAnswerKind): boolean {
  return kind === 'throttle' || kind === 'login-wall'
}

export function isFailureKind(kind: FeedAnswerKind): boolean {
  return kind !== 'ok'
}

// ── Redaction ──────────────────────────────────────────────────────────────────────────

/**
 * Anything shaped like a credential, replaced. Deliberately greedy: a redacted word in an
 * error message costs nothing, a leaked token in a Setting row every dashboard can read costs
 * the token. Ordered so the specific shapes run before the generic long-run rule.
 */
const REDACTIONS: ReadonlyArray<[RegExp, string]> = [
  [/access_token=[^&\s"'<>]+/gi, 'access_token=[redacted]'],
  [/sessionid=[^;&\s"'<>]+/gi, 'sessionid=[redacted]'],
  [/\bbearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]'],
  // A Meta access token begins EAA. Matched at any length — a short one is still a token.
  [/\bEAA[A-Za-z0-9]+/g, '[redacted]'],
  // 32+ characters of hex or base64-ish with no break: a key, a token, a cookie value.
  [/[A-Za-z0-9+/_-]{32,}={0,2}/g, '[redacted]'],
]

/**
 * How much of a body is ever examined — a 600 KB SPA shell must not be regex-scanned whole. The
 * RAW bound is generous because whitespace is collapsed before the scan window is taken; the SCAN
 * bound is the window the redaction rules run over, in collapsed characters.
 */
const RAW_MAX = 16_000
const SCAN_MAX = 2_000

/** The characters a token is made of — what the long-run rule matches, and what a cut can split. */
const TOKEN_CHAR = /[A-Za-z0-9+/_=-]/
const TRAILING_TOKEN_RUN = /[A-Za-z0-9+/_=-]+$/

/**
 * Undo the encodings a token can hide behind, so the rules see it whole: JSON's `\/` (which
 * breaks a base64 run in two, each half under the 32-character rule) and `\uXXXX`, and the
 * percent-encodings of `=`, `&`, `/` and `+` (`access_token%3D…` evaded the `access_token=` rule,
 * and `\bEAA` cannot match after `3D`). An escaped quote or backslash is left as it is, so the
 * JSON-ish text a sentence later quotes from keeps its shape.
 */
function decodeHidingPlaces(s: string): string {
  return s
    .replace(/\\\//g, '/')
    .replace(/\\u([0-9a-fA-F]{4})/g, (whole, hex: string) => {
      const c = String.fromCharCode(Number.parseInt(hex, 16))
      return c === '"' || c === '\\' ? whole : c
    })
    .replace(/%3D/gi, '=')
    .replace(/%26/g, '&')
    .replace(/%2F/gi, '/')
    .replace(/%2B/gi, '+')
}

/**
 * PURE. The part of a body worth storing.
 *
 * Decode, then COLLAPSE, then take the scan window, then redact, then cut — and that order is what
 * makes the claim true IN THE POSITIONS THAT ARE STORED: a token that begins before character 240
 * of the collapsed text has at least 1,760 characters of itself inside the 2,000-character window,
 * so it is matched whole. (The first version took the window from the RAW text and collapsed after,
 * so 1,730 whitespace characters before a token pulled a truncated stub of it inside the head.)
 *
 * Two edges are trimmed rather than trusted, because a stub under 32 characters is invisible to the
 * long-run rule: a run of token characters touching the END of a truncated window, and one the final
 * cut splits. Dropping an ordinary word that happens to sit there costs nothing.
 */
export function evidenceHead(text: string | null | undefined, max: number = FEED_ANSWER_HEAD_MAX): string | null {
  if (!text) return null
  const collapsed = decodeHidingPlaces(text.slice(0, RAW_MAX))
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  let s = collapsed.slice(0, SCAN_MAX)
  if (text.length > RAW_MAX || collapsed.length > SCAN_MAX) s = s.replace(TRAILING_TOKEN_RUN, '')
  for (const [re, to] of REDACTIONS) s = s.replace(re, to)
  s = s.trim()
  if (!s) return null
  if (s.length <= max) return s
  let cut = s.slice(0, max)
  if (TOKEN_CHAR.test(s[max]!) && TOKEN_CHAR.test(s[max - 1]!)) cut = cut.replace(TRAILING_TOKEN_RUN, '')
  return cut.trimEnd() || null
}

// ── Classification ─────────────────────────────────────────────────────────────────────

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body) as unknown
  } catch {
    return undefined
  }
}

/**
 * PURE. Is this body Instagram's login wall, whatever status it arrived with?
 *
 * The wall is `{"message":"Please wait a few minutes before you try again.","require_login":true}`
 * (measured 4-8 Sept with a 401). `require_login: true` alone settles it; so does
 * `status: "fail"` with the wall's own measured words, "please wait a few minutes". A non-JSON
 * body is never the wall here — an HTML login page is `not-json`, a different fact with a
 * different remedy.
 *
 * NARROWED ON REVIEW (15 Oct 2026). The first version also matched any fail message containing
 * "login" or "log in", unanchored — words never measured in a wall, and matching "catalog in" as
 * readily as a plausible 400 "update the app to log in". Since this test now decides at ANY status
 * and a wall halts the whole pass on a 15→30→60-minute ladder, an over-wide match is the very
 * misfiling this module exists to end: a per-handle or per-client answer read as "Instagram said
 * wait". So only the measured shape and words count; `login_required` and kin, unmeasured on this
 * endpoint, stay ordinary per-channel failures (`http-error`, or `shape` on a 200).
 *
 * `{"status":"fail"}` with no message (the 404 for a missing handle) and "SecFetch Policy
 * violation." are not walls, and must not close the gate: a per-handle answer that halted the
 * whole pass would blind every other channel.
 */
export function isLoginWallBody(body: string): boolean {
  const parsed = parseJson(body)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false
  const o = parsed as Record<string, unknown>
  if (o.require_login === true) return true
  return o.status === 'fail' && typeof o.message === 'string' && /\bplease wait a few minutes\b/i.test(o.message)
}

/**
 * PURE. What kind of answer a response was.
 *
 * `parsedItems` is the number of items the caller's schema accepted, `null` when the schema
 * REJECTED a parsed JSON body, and `undefined` when the caller did not try (a non-2xx). The
 * function decides JSON-vs-not itself, so `not-json` and `shape` cannot be confused by a caller.
 *
 * Order matters and is the safety argument: a refusal is recognised BEFORE the status is read as
 * success, so a 200 wall can never be filed as a feed page or a shape change.
 */
export function classifyFeedAnswer(input: {
  status: number
  contentType?: string | null
  body: string
  parsedItems?: number | null
}): { kind: FeedAnswerKind; head: string | null } {
  const head = evidenceHead(input.body)
  if (isThrottleResponse(input.status, input.body)) return { kind: 'throttle', head }
  if (isLoginWallBody(input.body)) return { kind: 'login-wall', head }
  if (input.status < 200 || input.status >= 300) return { kind: 'http-error', head }
  if (parseJson(input.body) === undefined) return { kind: 'not-json', head }
  if (input.parsedItems === null || input.parsedItems === undefined) return { kind: 'shape', head }
  if (input.parsedItems === 0) return { kind: 'empty', head }
  // A good page's body is not evidence of anything worth keeping, and it is large.
  return { kind: 'ok', head: null }
}

// ── The record, and when to write it ────────────────────────────────────────────────────

/** An identical answer is written at most this often — a pass reads ~19 channels every 15 minutes. */
export const FEED_ANSWER_DEDUPE_MS = 10 * 60_000

/**
 * PURE. Should this answer be written, given the last one written from this process?
 *
 * Skipped only when it repeats the last written answer's kind, status and source within ten
 * minutes — so a pass whose every channel answers 200 costs one write, not nineteen. A change
 * of kind always writes, and an `ok` after a failure always writes: recovery is the one event
 * the screen must not learn about late.
 */
export function shouldWriteFeedAnswer(prev: { last: FeedAnswer; writtenAt: string } | null, next: FeedAnswer): boolean {
  if (!prev) return true
  if (next.kind === 'ok' && prev.last.kind !== 'ok') return true
  const same = prev.last.kind === next.kind && prev.last.status === next.status && prev.last.source === next.source
  if (!same) return true
  const gap = Date.parse(next.at) - Date.parse(prev.writtenAt)
  return !(Number.isFinite(gap) && gap >= 0 && gap < FEED_ANSWER_DEDUPE_MS)
}

/**
 * A Graph answer that stops the WHOLE fallback, not one channel: the token, or the rate limit.
 * A per-channel answer (one account is not a business account) must not reset `graphSince`,
 * or one personal account on the watch list would restart the clock every pass.
 */
function stopsTheFallback(kind: FeedAnswerKind): boolean {
  return kind === 'graph-token' || kind === 'graph-rate-limit'
}

/**
 * PURE. The row after this answer: a failure replaces `lastFailure`, an `ok` moves `lastOkAt`.
 *
 * And the fallback's three facts: an anonymous failure is kept in `lastAnonymousFailure`; a
 * Graph `ok` starts `graphSince` (if it is not already running) and moves `graphOkAt`; a Graph
 * token or rate-limit answer ends `graphSince`; an anonymous `ok` ends it too — the anonymous
 * feed is reading again, so the page must stop saying the server reads through the API.
 */
export function mergeFeedAnswer(prev: FeedAnswerRecord | null, next: FeedAnswer): FeedAnswerRecord {
  const isGraph = next.source === 'graph'
  const graphSince =
    isGraph && next.kind === 'ok'
      ? (prev?.graphSince ?? next.at)
      : (isGraph && stopsTheFallback(next.kind)) || (!isGraph && next.kind === 'ok')
        ? null
        : (prev?.graphSince ?? null)
  return {
    last: next,
    lastFailure: isFailureKind(next.kind) ? next : (prev?.lastFailure ?? null),
    lastOkAt: next.kind === 'ok' ? next.at : (prev?.lastOkAt ?? null),
    lastAnonymousFailure: !isGraph && isFailureKind(next.kind) ? next : (prev?.lastAnonymousFailure ?? null),
    graphSince,
    graphOkAt: isGraph && next.kind === 'ok' ? next.at : (prev?.graphOkAt ?? null),
  }
}

function asAnswer(v: unknown): FeedAnswer | null {
  if (!v || typeof v !== 'object') return null
  const a = v as Record<string, unknown>
  if (typeof a.at !== 'string' || Number.isNaN(Date.parse(a.at))) return null
  if (typeof a.host !== 'string' || typeof a.handle !== 'string') return null
  if (typeof a.kind !== 'string' || !(FEED_ANSWER_KINDS as readonly string[]).includes(a.kind)) return null
  if (a.source !== 'anonymous-app' && a.source !== 'graph') return null
  return {
    at: a.at,
    host: a.host,
    source: a.source,
    handle: a.handle,
    kind: a.kind as FeedAnswerKind,
    status: typeof a.status === 'number' ? a.status : null,
    contentType: typeof a.contentType === 'string' ? a.contentType : null,
    head: typeof a.head === 'string' ? a.head : null,
    items: typeof a.items === 'number' ? a.items : null,
    until: typeof a.until === 'string' ? a.until : null,
  }
}

/** PURE. One stored row, or null when it is not one. An unreadable row is not evidence. */
export function parseFeedAnswerRecord(value: string | null | undefined): FeedAnswerRecord | null {
  if (!value) return null
  const parsed = parseJson(value)
  if (!parsed || typeof parsed !== 'object') return null
  const r = parsed as Record<string, unknown>
  const last = asAnswer(r.last)
  if (!last) return null
  const lastFailure = r.lastFailure === null || r.lastFailure === undefined ? null : asAnswer(r.lastFailure)
  if (r.lastFailure && !lastFailure) return null
  const iso = (v: unknown): string | null => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? v : null)
  const lastOkAt = iso(r.lastOkAt)
  // The fallback's fields are OPTIONAL and forgiving: a row from an older build has none, and an
  // unreadable one is "never served by the fallback" rather than an unreadable row.
  const lastAnonymousFailure = r.lastAnonymousFailure ? asAnswer(r.lastAnonymousFailure) : null
  return { last, lastFailure, lastOkAt, lastAnonymousFailure, graphSince: iso(r.graphSince), graphOkAt: iso(r.graphOkAt) }
}

/** PURE. Rows → parsed answers, newest first; unreadable rows skipped. Shared by `readPassHealth`. */
export function parseFeedAnswerRows(rows: ReadonlyArray<{ key: string; value: string }>): FeedAnswerRow[] {
  const out: FeedAnswerRow[] = []
  for (const row of rows) {
    if (!row.key.startsWith(FEED_ANSWER_KEY_PREFIX)) continue
    const rec = parseFeedAnswerRecord(row.value)
    if (!rec) continue
    out.push({ host: row.key.slice(FEED_ANSWER_KEY_PREFIX.length), ...rec })
  }
  return out.sort((a, b) => Date.parse(b.last.at) - Date.parse(a.last.at))
}

// ── The process-wide writer ───────────────────────────────────────────────────────────

/**
 * What this process last wrote, per host — used ONLY when the stored row cannot be read. Keyed
 * by host, so a test recording for two hosts cannot dedupe one against the other.
 */
let memos = new Map<string, FeedAnswerRecord>()
/** Writes are serialised so each dedupe decision sees the one before it. */
let chain: Promise<void> = Promise.resolve()

/**
 * ── THE STORED ROW IS RE-READ BEFORE EVERY DECISION (review, 15 Oct 2026) ─────────────────
 *
 * The first version read the row once per process and then merged against its own memory. But
 * more than one process writes the same `detectFeedAnswer:<host>` key — the worker, `pnpm detect`
 * and the dashboard all run on the box under one `anonGateHost()` — so a process with a stale
 * memory could overwrite a newer `lastFailure` or `lastOkAt` another process had just written,
 * and dedupe against an answer that was no longer the newest on record. One `findUnique` per
 * recorded answer (about one per channel per pass) buys a merge against what is actually stored.
 * Not a transaction: two processes recording in the same millisecond can still interleave, and
 * that window is accepted — the next answer re-reads and corrects it.
 *
 * The dedupe now compares against the STORED `last` (its own `at` is when it was written, since a
 * skipped answer is never stored), so it also holds across processes and across a restart.
 */
async function writeOne(answer: FeedAnswer): Promise<void> {
  const key = feedAnswerKey(answer.host)
  const row = await prisma.setting.findUnique({ where: { key } }).then(
    (r) => ({ ok: true as const, value: r?.value ?? null }),
    () => ({ ok: false as const, value: null }),
  )
  // A failed read must not become "no history": merging into null would erase the last failure
  // and the last success the screen is explaining. This process's own last write stands in.
  const stored = row.ok ? parseFeedAnswerRecord(row.value) : (memos.get(answer.host) ?? null)
  const prev = stored ? { last: stored.last, writtenAt: stored.last.at } : null
  if (!shouldWriteFeedAnswer(prev, answer)) return
  const record = mergeFeedAnswer(stored, answer)
  const value = JSON.stringify(record)
  await prisma.setting.upsert({ where: { key }, update: { value }, create: { key, value } })
  memos.set(answer.host, record)
}

/**
 * Record one answer for this host. Best-effort: never throws, never makes a read wait — the
 * feed path calls it with `void`. The promise exists for tests (and `feedAnswersSettled`).
 */
export function recordFeedAnswer(answer: FeedAnswer): Promise<void> {
  chain = chain.then(
    () =>
      writeOne(answer).catch(() => {
        // Deliberately silent, like anonGate persist(): a test that mocks the database without a
        // `setting` table, or a Postgres blip, must cost a sentence, never a feed page.
      }),
  )
  return chain
}

/** Resolves when every answer recorded so far has been written or dropped. */
export function feedAnswersSettled(): Promise<void> {
  return chain
}

/** Tests only: forget what this process has written. */
export function resetFeedEvidenceForTests(): void {
  memos = new Map()
  chain = Promise.resolve()
}

/** Every host's row, newest first. Unreadable rows are skipped; a database error reads as none. */
export async function readFeedAnswers(): Promise<FeedAnswerRow[]> {
  const rows = await prisma.setting
    .findMany({ where: { key: { startsWith: FEED_ANSWER_KEY_PREFIX } }, select: { key: true, value: true } })
    .catch(() => [] as { key: string; value: string }[])
  return parseFeedAnswerRows(rows)
}
