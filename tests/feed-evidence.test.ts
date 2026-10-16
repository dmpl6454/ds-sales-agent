import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * WHAT INSTAGRAM ANSWERED IS KEPT, AND THE LANDING PAGE SAYS IT (15 Oct 2026).
 *
 * The operator's screen read "Instagram is refusing anonymous reads" for 22.5 hours while the
 * database held no refusal at all — the sentence fired on a stale stamp, and every non-throttle
 * answer (a 400, a 200 web page, a 200 carrying the login wall, a transport error) was a log line
 * with its body thrown away. These pin, each in both directions:
 *
 *   1. `classifyFeedAnswer` names every answer the real feed has given or plausibly will — the
 *      table below. MUTATION: swap the `isLoginWallBody` and `http-error` checks and the 400
 *      wall row reads http-error; drop `isLoginWallBody` and the 200 wall reads `shape`.
 *   2. a 200 login wall CLOSES THE GATE like a 401 — fetchFeed throws `isThrottle` and the next
 *      call makes no request. MUTATION (applied by hand, saw red, restored): changing
 *      `isRefusalKind(answer.kind)` in feed.ts back to `isThrottleResponse(res.status, body)`
 *      fails "a 200 login wall is a refusal" — the call throws `isParseFailure` instead.
 *   3. redaction — a token never reaches a stored head, including one straddling the 240-char cut.
 *      MUTATION: slicing to 240 BEFORE redacting fails the straddle case.
 *   4. the dedupe decision, as a pure function, both ways; and through the real database.
 *   5. `readPassHealth` carries every host's row from its one query, and the pulse's prefix
 *      exclusion behaves on a real SQLite file (Prisma's `NOT: [...]` semantics, not assumed).
 *   6. `describeDetectionOutage` as a table — and no row without a recorded refusal ever says
 *      "refusing". MUTATION: returning the old headline from the `none` branch fails that sweep.
 *   7. (review, 15 Oct 2026) the server's recorded cooldown is said even with no current answer
 *      row. MUTATION (applied by hand, saw red, restored): deleting the `throttledUntil` branch in
 *      `describeDetectionOutage` fails "a recorded cooldown is never 'may not be running this build'".
 *   8. (review) the wall is the MEASURED wall only. MUTATION (applied by hand, saw red, restored):
 *      restoring `/wait a few minutes|login|log in/` fails the "update the app to log in" row.
 *   9. (review) the stored row is re-read before every merge, so a second process's newer write is
 *      merged rather than overwritten. MUTATION (applied by hand, saw red, restored): merging
 *      against this process's memory instead of the re-read row fails "another process's write".
 *  10. (review) redaction sees through JSON and percent escapes and through whitespace padding.
 *      MUTATION (applied by hand, saw red, restored): dropping `decodeHidingPlaces` fails "a token
 *      hidden by JSON escaping or percent-encoding is still redacted"; taking the scan window from
 *      the raw text before collapsing fails "whitespace padding cannot push a truncated stub…".
 *
 * No network: every request goes through `setIgTransportForTests`.
 */

const dir = mkdtempSync(join(tmpdir(), 'ds-feed-evidence-'))
const dbPath = join(dir, 'evidence.db')
const bootstrap = new Database(dbPath)
bootstrap.exec(`
  CREATE TABLE "Setting" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "value" TEXT NOT NULL,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`)
bootstrap.close()
process.env.DATABASE_URL = `file:${dbPath}`
const savedDevice = process.env.DS_DEVICE_NAME
process.env.DS_DEVICE_NAME = 'linode-detect'

const { prisma } = await import('@/lib/db')
const { fetchFeed, FeedFetchError } = await import('@/detection/feed')
const { anonGateCheck, resetAnonGate, setAnonGateClock } = await import('@/detection/anonGate')
const { setIgTransportForTests } = await import('@/detection/igHttp')
type IgResponse = import('@/detection/igHttp').IgResponse
const fe = await import('@/detection/feedEvidence')
type FeedAnswer = import('@/detection/feedEvidence').FeedAnswer
type FeedAnswerRow = import('@/detection/feedEvidence').FeedAnswerRow
const { readPassHealth } = await import('@/worker/scheduler')
const { describeDetectionOutage, lastCheckCause, EVIDENCE_STALE_MS, quoteOf } = await import('@/app/view-model/detection-outage')
const { istTimeKey } = await import('@/lib/time')
const { PULSE_IGNORED_SETTING_KEYS, PULSE_IGNORED_SETTING_PREFIXES } = await import('@/app/api/pulse/stamp')

afterAll(async () => {
  await prisma.$disconnect()
  rmSync(dir, { recursive: true, force: true })
  if (savedDevice === undefined) delete process.env.DS_DEVICE_NAME
  else process.env.DS_DEVICE_NAME = savedDevice
})

const WALL = '{"message":"Please wait a few minutes before you try again.","require_login":true,"status":"fail"}'
const SECFETCH = '{"message":"SecFetch Policy violation."}'
const HTML = '<!DOCTYPE html><html lang="en"><head><title>Instagram</title></head><body></body></html>'
const item = (code: string) => ({ code, taken_at: 1_760_000_000, caption: { text: 'hello' } })

describe('classifyFeedAnswer — every answer has a name', () => {
  const rows: Array<[string, Parameters<typeof fe.classifyFeedAnswer>[0], string]> = [
    ['200 web page', { status: 200, contentType: 'text/html', body: HTML, parsedItems: null }, 'not-json'],
    ['200 login wall', { status: 200, body: '{"status":"fail","require_login":true}', parsedItems: null }, 'login-wall'],
    ['200 wall by its words', { status: 200, body: '{"status":"fail","message":"Please wait a few minutes"}', parsedItems: null }, 'login-wall'],
    ['200 no items', { status: 200, body: '{"status":"ok","items":[]}', parsedItems: 0 }, 'empty'],
    ['200 a real page', { status: 200, body: JSON.stringify({ items: [item('AAAAA')] }), parsedItems: 1 }, 'ok'],
    ['200 JSON in another shape', { status: 200, body: '{"data":{"user":null}}', parsedItems: null }, 'shape'],
    ['400 SecFetch', { status: 400, body: SECFETCH }, 'http-error'],
    ['400 carrying the wall', { status: 400, body: WALL }, 'login-wall'],
    // Unmeasured words are not the wall: a 400 about logging in is how the request presents itself.
    ['400 "update the app to log in"', { status: 400, body: '{"status":"fail","message":"Please update the app to log in"}' }, 'http-error'],
    ['200 fail "login_required" — unmeasured, a shape change, not a wall', { status: 200, body: '{"status":"fail","message":"login_required"}', parsedItems: null }, 'shape'],
    ['401 wait', { status: 401, body: WALL }, 'throttle'],
    ['429', { status: 429, body: '' }, 'throttle'],
    ['403 wall', { status: 403, body: WALL }, 'throttle'],
    ['403 plain — a gated account', { status: 403, body: '{"status":"fail"}' }, 'http-error'],
    ['404 missing handle', { status: 404, body: '{"status":"fail"}' }, 'http-error'],
    ['503', { status: 503, body: 'Service Unavailable' }, 'http-error'],
  ]
  it.each(rows)('%s', (_name, input, kind) => {
    expect(fe.classifyFeedAnswer(input).kind).toBe(kind)
  })

  it('keeps the head of a failure and nothing of a success', () => {
    expect(fe.classifyFeedAnswer({ status: 400, body: SECFETCH }).head).toBe(SECFETCH)
    expect(fe.classifyFeedAnswer({ status: 200, body: JSON.stringify({ items: [item('AAAAA')] }), parsedItems: 1 }).head).toBeNull()
  })

  it('isLoginWallBody: the wall in either spelling, and never a per-handle answer', () => {
    expect(fe.isLoginWallBody(WALL)).toBe(true)
    expect(fe.isLoginWallBody('{"require_login":true}')).toBe(true)
    // Narrowed on review: only the measured shape and words. These were walls in the first version.
    expect(fe.isLoginWallBody('{"status":"fail","message":"login_required"}')).toBe(false)
    expect(fe.isLoginWallBody('{"status":"fail","message":"Please update the app to log in"}')).toBe(false)
    expect(fe.isLoginWallBody('{"status":"fail","message":"catalog in maintenance"}')).toBe(false)
    expect(fe.isLoginWallBody('{"status":"fail"}')).toBe(false) // the 404 for a missing handle
    expect(fe.isLoginWallBody(SECFETCH)).toBe(false)
    expect(fe.isLoginWallBody('{"status":"ok","message":"login"}')).toBe(false) // not a failure
    expect(fe.isLoginWallBody(HTML)).toBe(false)
    expect(fe.isLoginWallBody('[]')).toBe(false)
  })
})

describe('evidenceHead — a body is evidence, and evidence can carry a credential', () => {
  const hex40 = 'a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0'

  it('redacts token shapes and collapses control characters', () => {
    const body = `{"error":"bad","access_token=EAAxyz123&x=1","tok":"${hex40}","auth":"Bearer abc.def","m":"EAAQwerty","c":"sessionid=987%3A1"}\n\t\u0000tail`
    const head = fe.evidenceHead(body)!
    expect(head).not.toContain('EAAxyz')
    expect(head).not.toContain('EAAQwerty')
    expect(head).not.toContain(hex40)
    expect(head).not.toContain('abc.def')
    expect(head).not.toContain('987%3A1')
    expect(head).toContain('[redacted]')
    expect(head).not.toMatch(/[\u0000-\u001f]/)
    expect(head.endsWith('tail')).toBe(true)
  })

  it('never stores more than 240 characters, and a token straddling the cut leaks no fragment', () => {
    const token = 'Z'.repeat(20) + 'Q9w8e7r6t5y4u3i2o1p0'.repeat(3) // 80 chars, base64-ish, no break
    const body = `${'x '.repeat(115)}${token}${' y'.repeat(200)}` // starts at 230, crosses 240
    const head = fe.evidenceHead(body)!
    expect(head.length).toBeLessThanOrEqual(fe.FEED_ANSWER_HEAD_MAX)
    expect(head).not.toMatch(/ZZZZ|Q9w8/)
  })

  it('a token hidden by JSON escaping or percent-encoding is still redacted', () => {
    // A 44-char base64 secret with "/" — JSON escapes it as "\/", which split the run in two.
    const secret = 'Ab12Cd34Ef56Gh78/Ij90Kl12Mn34Op56Qr78St90Uv'
    const escaped = `{"x":"${secret.replace('/', '\\/')}"}`
    expect(escaped).toContain('\\/')
    const h1 = fe.evidenceHead(escaped)!
    expect(h1).not.toContain('Ab12Cd34')
    expect(h1).not.toContain('Ij90Kl12')
    // access_token%3D<token>: the `access_token=` rule and `\bEAA` both missed it.
    const h2 = fe.evidenceHead('{"next":"https://x/?access_token%3DEAAshort9%26a=1"}')!
    expect(h2).not.toContain('EAAshort9')
    expect(h2).toContain('access_token=[redacted]')
  })

  it('whitespace padding cannot push a truncated stub of a token into the head', () => {
    // 1,975 spaces then a token: the first version took the window from the RAW text, cut the
    // token to a 25-char stub at 2,000, then collapsed — leaving the stub inside the head.
    const token = 'Kq7Wz3Xv9Ln2Pr5Ty8Bd4Hf6Jm1Sc0Ge5Ua2'.repeat(2)
    const head = fe.evidenceHead(`${' '.repeat(1975)}${token} end`)!
    expect(head).not.toMatch(/Kq7W|Ln2Pr/)
    expect(head).toContain('[redacted]')
  })

  it('an empty body is no head', () => {
    expect(fe.evidenceHead('')).toBeNull()
    expect(fe.evidenceHead('  \n ')).toBeNull()
  })
})

const answer = (over: Partial<FeedAnswer>): FeedAnswer => ({
  at: '2026-10-15T08:00:00.000Z',
  host: 'linode-detect',
  source: 'anonymous-app',
  handle: 'viralbhayani',
  kind: 'http-error',
  status: 400,
  contentType: 'application/json',
  head: SECFETCH,
  items: null,
  ...over,
})

describe('shouldWriteFeedAnswer / mergeFeedAnswer — pure', () => {
  const prev = { last: answer({}), writtenAt: '2026-10-15T08:00:00.000Z' }

  it('the first answer always writes', () => {
    expect(fe.shouldWriteFeedAnswer(null, answer({}))).toBe(true)
  })
  it('the same answer inside ten minutes is skipped; at ten minutes it writes again', () => {
    expect(fe.shouldWriteFeedAnswer(prev, answer({ at: '2026-10-15T08:09:59.000Z' }))).toBe(false)
    expect(fe.shouldWriteFeedAnswer(prev, answer({ at: '2026-10-15T08:10:00.000Z' }))).toBe(true)
  })
  it('a different kind, status or source writes at once', () => {
    expect(fe.shouldWriteFeedAnswer(prev, answer({ at: '2026-10-15T08:00:01.000Z', status: 404 }))).toBe(true)
    expect(fe.shouldWriteFeedAnswer(prev, answer({ at: '2026-10-15T08:00:01.000Z', kind: 'not-json' }))).toBe(true)
    expect(fe.shouldWriteFeedAnswer(prev, answer({ at: '2026-10-15T08:00:01.000Z', source: 'graph' }))).toBe(true)
  })
  it('an ok after a failure always writes — recovery is never learned late', () => {
    expect(fe.shouldWriteFeedAnswer(prev, answer({ at: '2026-10-15T08:00:01.000Z', kind: 'ok', status: 200, head: null }))).toBe(true)
    const okPrev = { last: answer({ kind: 'ok', status: 200 }), writtenAt: '2026-10-15T08:00:00.000Z' }
    expect(fe.shouldWriteFeedAnswer(okPrev, answer({ at: '2026-10-15T08:05:00.000Z', kind: 'ok', status: 200 }))).toBe(false)
  })
  it('merge: a failure replaces lastFailure and keeps lastOkAt; an ok moves lastOkAt and keeps lastFailure', () => {
    const fail = answer({})
    const r1 = fe.mergeFeedAnswer({ last: answer({ kind: 'ok' }), lastFailure: null, lastOkAt: '2026-10-15T07:00:00.000Z' }, fail)
    // The three official-fallback fields (Task C) ride along: an anonymous failure is ALSO the
    // last anonymous failure, and nothing here was served by the official API.
    const none = { graphSince: null, graphOkAt: null }
    expect(r1).toEqual({ last: fail, lastFailure: fail, lastOkAt: '2026-10-15T07:00:00.000Z', lastAnonymousFailure: fail, ...none })
    const ok = answer({ kind: 'ok', status: 200, head: null, at: '2026-10-15T09:00:00.000Z' })
    expect(fe.mergeFeedAnswer(r1, ok)).toEqual({ last: ok, lastFailure: fail, lastOkAt: ok.at, lastAnonymousFailure: fail, ...none })
  })
})

describe('parseFeedAnswerRows', () => {
  it('reads every host, newest first, names the host from the key, and skips what it cannot read', () => {
    const a = { last: answer({ at: '2026-10-15T08:00:00.000Z' }), lastFailure: answer({}), lastOkAt: null }
    const b = { last: answer({ at: '2026-10-15T09:00:00.000Z', host: 'mac' }), lastFailure: null, lastOkAt: '2026-10-15T09:00:00.000Z' }
    const rows = fe.parseFeedAnswerRows([
      { key: 'detectFeedAnswer:linode-detect', value: JSON.stringify(a) },
      { key: 'detectFeedAnswer:DMPLs Mac Studio', value: JSON.stringify(b) },
      { key: 'detectFeedAnswer:broken', value: 'not json' },
      { key: 'detectFeedAnswer:alien', value: JSON.stringify({ last: { ...answer({}), kind: 'martian' } }) },
      { key: 'somethingElse', value: JSON.stringify(a) },
    ])
    expect(rows.map((r) => r.host)).toEqual(['DMPLs Mac Studio', 'linode-detect'])
  })
})

// ── fetchFeed, end to end through the transport and the real Setting table ────────────

const respond = (status: number, body: string, contentType: string | null = 'application/json') =>
  vi.fn(
    async (): Promise<IgResponse> => ({
      status,
      ok: status >= 200 && status < 300,
      contentType,
      text: async () => body,
      json: async () => JSON.parse(body) as unknown,
    }),
  )
const useTransport = (fn: ReturnType<typeof respond>) =>
  setIgTransportForTests(fn as unknown as Parameters<typeof setIgTransportForTests>[0])

async function stored(): Promise<import('@/detection/feedEvidence').FeedAnswerRecord> {
  await fe.feedAnswersSettled()
  const row = await prisma.setting.findUnique({ where: { key: fe.feedAnswerKey() } })
  expect(row, 'no evidence row was written').not.toBeNull()
  return fe.parseFeedAnswerRecord(row!.value)!
}

describe('fetchFeed records what it was answered', () => {
  let now = Date.parse('2026-10-15T08:00:00Z')
  beforeEach(async () => {
    resetAnonGate()
    setAnonGateClock(() => now)
    fe.resetFeedEvidenceForTests()
    await prisma.setting.deleteMany()
  })
  afterEach(() => {
    setAnonGateClock()
    resetAnonGate()
    setIgTransportForTests()
  })

  it('a 200 web page is a shape alarm, not a throttle — and the page is on record', async () => {
    useTransport(respond(200, HTML, 'text/html; charset=utf-8'))
    const err = (await fetchFeed('viralbhayani', { maxPages: 1 }).catch((e: unknown) => e)) as InstanceType<typeof FeedFetchError>
    expect(err).toBeInstanceOf(FeedFetchError)
    expect(err.isParseFailure).toBe(true)
    expect(err.isThrottle).toBe(false)
    expect(anonGateCheck().ok).toBe(true)
    const rec = await stored()
    expect(rec.last).toMatchObject({ kind: 'not-json', status: 200, contentType: 'text/html; charset=utf-8', handle: 'viralbhayani', host: 'linode-detect', source: 'anonymous-app' })
    expect(rec.last.head).toContain('<!DOCTYPE html>')
    expect(rec.lastFailure?.kind).toBe('not-json')
  })

  it('a 200 login wall is a refusal: it closes the gate, halts, and the next call makes no request', async () => {
    const wall = respond(200, '{"status":"fail","require_login":true}')
    useTransport(wall)
    const err = (await fetchFeed('viralbhayani', { maxPages: 1 }).catch((e: unknown) => e)) as InstanceType<typeof FeedFetchError>
    expect(err).toBeInstanceOf(FeedFetchError)
    expect(err.isThrottle).toBe(true)
    expect(err.isParseFailure).toBe(false)
    expect(anonGateCheck().ok).toBe(false)
    const rec = await stored()
    expect(rec.last).toMatchObject({ kind: 'login-wall', status: 200 })
    expect(rec.last.until).toBe(new Date(now + 15 * 60_000).toISOString())
    const again = await fetchFeed('bollywoodpap', { maxPages: 1 }).catch((e: unknown) => e)
    expect((again as InstanceType<typeof FeedFetchError>).isThrottle).toBe(true)
    expect(wall).toHaveBeenCalledTimes(1)
  })

  it('a 200 with no items returns no posts and records "empty"', async () => {
    useTransport(respond(200, '{"status":"ok","items":[]}'))
    const r = await fetchFeed('viralbhayani', { maxPages: 1 })
    expect(r.posts).toEqual([])
    const rec = await stored()
    expect(rec.last).toMatchObject({ kind: 'empty', status: 200, items: 0 })
  })

  it('a 400 is a per-channel failure whose message and record carry Instagram\'s words', async () => {
    useTransport(respond(400, SECFETCH))
    const err = (await fetchFeed('viralbhayani', { maxPages: 1 }).catch((e: unknown) => e)) as InstanceType<typeof FeedFetchError>
    expect(err.isThrottle).toBe(false)
    expect(err.isParseFailure).toBe(false)
    expect(err.message).toContain('HTTP 400 — {"message":"SecFetch Policy violation."}')
    expect(anonGateCheck().ok).toBe(true)
    const rec = await stored()
    expect(rec.last).toMatchObject({ kind: 'http-error', status: 400, head: SECFETCH })
  })

  it('a 401 and a 429 are throttles on record with the reopening time', async () => {
    useTransport(respond(401, WALL))
    const e1 = (await fetchFeed('viralbhayani', { maxPages: 1 }).catch((e: unknown) => e)) as InstanceType<typeof FeedFetchError>
    expect(e1.isThrottle).toBe(true)
    expect((await stored()).last).toMatchObject({ kind: 'throttle', status: 401, head: WALL, until: new Date(now + 15 * 60_000).toISOString() })

    resetAnonGate()
    fe.resetFeedEvidenceForTests()
    await prisma.setting.deleteMany()
    useTransport(respond(429, ''))
    const e2 = (await fetchFeed('viralbhayani', { maxPages: 1 }).catch((e: unknown) => e)) as InstanceType<typeof FeedFetchError>
    expect(e2.isThrottle).toBe(true)
    expect((await stored()).last).toMatchObject({ kind: 'throttle', status: 429, head: null })
  })

  /**
   * A 429 WHOSE BODY WAS CUT OFF IS A THROTTLE, NOT "NO ANSWER" (16 Oct 2026, igHttp.ts `cutAnswer`):
   * it used to be retried three more times into the throttle that had just spoken. MUTATION (applied
   * once, seen red, restored): deleting the `cutAnswer` branch in fetchPageWithRetry fails this case.
   */
  it('a 429 whose body was cut off is the throttle it was — one request, not four', async () => {
    const cut = vi.fn(async (): Promise<IgResponse> => {
      throw Object.assign(new Error('aborted'), { answerStatus: 429 })
    })
    setIgTransportForTests(cut as unknown as Parameters<typeof setIgTransportForTests>[0])
    // Fake timers, so the broken shape (four tries with backoff) fails on the COUNT, not on a test timeout.
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    const pending = fetchFeed('viralbhayani', { maxPages: 1 }).catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(10_000)
    vi.useRealTimers()
    const err = (await pending) as InstanceType<typeof FeedFetchError>
    expect(cut).toHaveBeenCalledTimes(1)
    expect(err.isThrottle).toBe(true)
    expect(err.isTransport).toBe(false)
    expect((await stored()).last).toMatchObject({ kind: 'throttle', status: 429 })
  })

  it('a transport failure after every retry is on record with the error, redacted', async () => {
    const boom = vi.fn(async (): Promise<IgResponse> => {
      throw new Error('getaddrinfo ENOTFOUND i.instagram.com access_token=EAAsecret123')
    })
    setIgTransportForTests(boom as unknown as Parameters<typeof setIgTransportForTests>[0])
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    const pending = fetchFeed('viralbhayani', { maxPages: 1 }).catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(10_000)
    vi.useRealTimers()
    const err = (await pending) as InstanceType<typeof FeedFetchError>
    expect(err).toBeInstanceOf(FeedFetchError)
    expect(err.message).toContain('network error after 4 attempts')
    expect(boom).toHaveBeenCalledTimes(4)
    const rec = await stored()
    expect(rec.last).toMatchObject({ kind: 'transport', status: null })
    expect(rec.last.head).toContain('ENOTFOUND')
    expect(rec.last.head).not.toContain('EAAsecret123')
  })

  it('a good page records ok and keeps the last failure; an identical failure inside ten minutes is not rewritten', async () => {
    useTransport(respond(400, SECFETCH))
    await fetchFeed('viralbhayani', { maxPages: 1 }).catch(() => undefined)
    const first = await stored()
    await fetchFeed('viralbhayani', { maxPages: 1 }).catch(() => undefined)
    expect((await stored()).last.at).toBe(first.last.at) // deduped: the second 400 wrote nothing

    useTransport(respond(200, JSON.stringify({ items: [item('AAAAA'), item('BBBBB')], more_available: false })))
    const r = await fetchFeed('viralbhayani', { maxPages: 1 })
    expect(r.posts).toHaveLength(2)
    const rec = await stored()
    expect(rec.last).toMatchObject({ kind: 'ok', status: 200, items: 2, head: null })
    expect(rec.lastFailure).toMatchObject({ kind: 'http-error', status: 400 })
    expect(rec.lastOkAt).toBe(rec.last.at)
  })

  it("another process's write is merged, never overwritten from this process's memory", async () => {
    useTransport(respond(400, SECFETCH))
    await fetchFeed('viralbhayani', { maxPages: 1 }).catch(() => undefined)
    const first = await stored()
    // A second process on the same host (pnpm detect, the dashboard) records a success afterwards.
    const otherOkAt = new Date(Date.parse(first.last.at) + 60_000).toISOString()
    const theirs = { ...first, last: answer({ kind: 'ok', status: 200, head: null, items: 3, at: otherOkAt }), lastOkAt: otherOkAt }
    await prisma.setting.update({ where: { key: fe.feedAnswerKey() }, data: { value: JSON.stringify(theirs) } })
    // This process now records a 503. Its merge must keep the other process's lastOkAt.
    useTransport(respond(503, 'Service Unavailable'))
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    const pending = fetchFeed('viralbhayani', { maxPages: 1 }).catch(() => undefined)
    await vi.advanceTimersByTimeAsync(10_000)
    vi.useRealTimers()
    await pending
    const rec = await stored()
    expect(rec.last).toMatchObject({ kind: 'http-error', status: 503 })
    expect(rec.lastOkAt).toBe(otherOkAt)
  })

  it('record: false — a person vetting one handle writes no evidence row (the gate still learns a refusal)', async () => {
    useTransport(respond(200, '{"status":"ok","items":[]}'))
    const r = await fetchFeed('a_mistyped_handle', { maxPages: 1, record: false })
    expect(r.posts).toEqual([])
    await fe.feedAnswersSettled()
    expect(await prisma.setting.findUnique({ where: { key: fe.feedAnswerKey() } })).toBeNull()
    useTransport(respond(401, WALL))
    await fetchFeed('a_mistyped_handle', { maxPages: 1, record: false }).catch(() => undefined)
    await fe.feedAnswersSettled()
    expect(await prisma.setting.findUnique({ where: { key: fe.feedAnswerKey() } })).toBeNull()
    expect(anonGateCheck().ok).toBe(false)
  })

  it('a restarted process keeps the stored last failure when its first answer is ok', async () => {
    useTransport(respond(400, SECFETCH))
    await fetchFeed('viralbhayani', { maxPages: 1 }).catch(() => undefined)
    await fe.feedAnswersSettled()
    fe.resetFeedEvidenceForTests() // a new process: nothing in memory
    useTransport(respond(200, JSON.stringify({ items: [item('AAAAA')] })))
    await fetchFeed('viralbhayani', { maxPages: 1 })
    const rec = await stored()
    expect(rec.last.kind).toBe('ok')
    expect(rec.lastFailure?.status).toBe(400)
  })
})

describe('readPassHealth carries the evidence from its one query', () => {
  beforeEach(async () => {
    await prisma.setting.deleteMany()
  })

  it('every host, newest first, an unreadable row skipped, and the server named by the heartbeat', async () => {
    const server = { last: answer({ at: '2026-10-15T08:00:00.000Z' }), lastFailure: answer({}), lastOkAt: null }
    const mac = { last: answer({ host: 'DMPLs Mac Studio', kind: 'throttle', status: 401, at: '2026-10-15T08:30:00.000Z' }), lastFailure: null, lastOkAt: null }
    await prisma.setting.createMany({
      data: [
        { key: 'detectFeedAnswer:linode-detect', value: JSON.stringify(server) },
        { key: 'detectFeedAnswer:DMPLs Mac Studio', value: JSON.stringify(mac) },
        { key: 'detectFeedAnswer:garbled', value: '{' },
        { key: 'schedulerHeartbeat', value: JSON.stringify({ pid: 1, host: 'worker', at: '2026-10-15T08:30:00.000Z', machine: 'linode-detect' }) },
      ],
    })
    const health = await readPassHealth(new Date('2026-10-15T09:00:00Z'))
    expect(health.feedAnswers.map((r) => r.host)).toEqual(['DMPLs Mac Studio', 'linode-detect'])
    expect(health.detectionHost).toBe('linode-detect')
  })

  it('no rows: no evidence and no server name — the page then names hosts by their own names', async () => {
    const health = await readPassHealth()
    expect(health.feedAnswers).toEqual([])
    expect(health.detectionHost).toBeNull()
  })

  it('the pulse aggregate excludes the per-host family by prefix on a real database', async () => {
    await prisma.setting.createMany({
      data: [
        { key: 'detectFeedAnswer:linode-detect', value: '{}' },
        { key: 'detectFeedAnswer:DMPLs Mac Studio', value: '{}' },
        { key: 'schedulerHeartbeat', value: '{}' },
        { key: 'autopilotEnabled', value: 'true' },
      ],
    })
    // The route's exact where-clause, built from the same two lists.
    const n = await prisma.setting.count({
      where: {
        key: { notIn: [...PULSE_IGNORED_SETTING_KEYS] },
        NOT: PULSE_IGNORED_SETTING_PREFIXES.map((prefix) => ({ key: { startsWith: prefix } })),
      },
    })
    expect(n).toBe(1)
  })
})

// ── The sentence ──────────────────────────────────────────────────────────────────────

describe('describeDetectionOutage — the cause on record, as a table', () => {
  const NOW = Date.parse('2026-10-15T08:00:00Z')
  const feedOkAt = new Date(NOW - 1348 * 60_000)
  const recent = new Date(NOW - 5 * 60_000).toISOString()
  const row = (host: string, failure: Partial<FeedAnswer> | null, lastOkAt: string | null = null): FeedAnswerRow => {
    const f = failure ? answer({ host, at: recent, ...failure }) : null
    return { host, last: f ?? answer({ host, kind: 'ok', status: 200, head: null, at: lastOkAt ?? recent }), lastFailure: f, lastOkAt }
  }
  const passes = (rows: FeedAnswerRow[], over: Partial<{ throttledUntil: Date | null; detectionHost: string | null; feedOkAt: Date | null }> = {}) => ({
    feedOkAt,
    throttledUntil: null,
    detectionHost: 'linode-detect',
    feedAnswers: rows,
    ...over,
  })
  const until = new Date(NOW + 15 * 60_000)
  const HHMM = istTimeKey(until)

  const table: Array<[string, ReturnType<typeof passes>, string]> = [
    [
      'the server throttled (401) — the cooldown time comes from the server\'s own row',
      passes([row('linode-detect', { kind: 'throttle', status: 401, head: WALL })], { throttledUntil: until }),
      `Instagram is refusing anonymous reads from the server (HTTP 401: "Please wait a few minutes before you try again.") — no paid posts found for 1348 min; it retries by itself at ${HHMM}.`,
    ],
    [
      'the server and the Mac both refused',
      passes(
        [
          row('linode-detect', { kind: 'throttle', status: 401, head: WALL }),
          row('DMPLs Mac Studio', { kind: 'throttle', status: 429, head: null }),
        ],
        { throttledUntil: until },
      ),
      `Instagram is refusing anonymous reads from the server (HTTP 401: "Please wait a few minutes before you try again.") and from DMPLs Mac Studio — no paid posts found for 1348 min; it retries by itself at ${HHMM}.`,
    ],
    [
      'a 200 login wall, its own reopening time',
      passes([row('linode-detect', { kind: 'login-wall', status: 200, head: '{"status":"fail","require_login":true}', until: until.toISOString() })]),
      `Instagram is refusing anonymous reads from the server (HTTP 200, the login wall) — no paid posts found for 1348 min; it retries by itself at ${HHMM}.`,
    ],
    [
      'a throttle whose reopening has passed',
      passes([row('linode-detect', { kind: 'throttle', status: 429, head: null, until: new Date(NOW - 60_000).toISOString() })]),
      'Instagram is refusing anonymous reads from the server (HTTP 429) — no paid posts found for 1348 min; it retries by itself on its next pass.',
    ],
    [
      'a 400 — not a rate limit',
      passes([row('linode-detect', { kind: 'http-error', status: 400, head: SECFETCH })]),
      'Instagram stopped answering the server\'s feed reads the way it used to (HTTP 400: "SecFetch Policy violation.") — this is not a rate limit, so waiting will not fix it; no paid posts found for 1348 min.',
    ],
    [
      'a 200 web page',
      passes([row('linode-detect', { kind: 'not-json', status: 200, head: HTML })]),
      'Instagram stopped answering the server\'s feed reads the way it used to (HTTP 200, a web page instead of feed data) — this is not a rate limit, so waiting will not fix it; no paid posts found for 1348 min.',
    ],
    [
      'a changed shape',
      passes([row('linode-detect', { kind: 'shape', status: 200, head: '{"data":{"user":null}}' })]),
      'Instagram stopped answering the server\'s feed reads the way it used to (HTTP 200, but not in the shape the feed reader expects) — this is not a rate limit, so waiting will not fix it; no paid posts found for 1348 min.',
    ],
    [
      'an empty feed',
      passes([row('linode-detect', { kind: 'empty', status: 200, head: '{"status":"ok","items":[]}', items: 0 })]),
      'Instagram stopped answering the server\'s feed reads the way it used to (HTTP 200 with no posts in it) — this is not a rate limit, so waiting will not fix it; no paid posts found for 1348 min.',
    ],
    [
      'Instagram\'s own 5xx',
      passes([row('linode-detect', { kind: 'http-error', status: 503, head: 'Service Unavailable' })]),
      'Instagram\'s own servers are failing the server\'s feed reads (HTTP 503) — this is on Instagram\'s side and usually passes by itself; no paid posts found for 1348 min.',
    ],
    [
      'the server cannot reach Instagram',
      passes([row('linode-detect', { kind: 'transport', status: null, head: '[@viralbhayani] network error after 4 attempts: getaddrinfo ENOTFOUND i.instagram.com' })]),
      'The server cannot reach Instagram (network error after 4 attempts: getaddrinfo ENOTFOUND i.instagram.com) — no paid posts found for 1348 min.',
    ],
    [
      'nothing on record at all',
      passes([]),
      'No feed page has been read for 1348 min and no answer from Instagram is on record yet — the detection worker may not be running this build.',
    ],
    [
      'nothing on record and no read ever',
      passes([], { feedOkAt: null }),
      'No feed page has been read yet and no answer from Instagram is on record — the detection worker may not be running this build.',
    ],
    [
      'the last answer was a success, newer than the failure',
      passes([row('linode-detect', { kind: 'http-error', status: 400, at: new Date(NOW - 30 * 60_000).toISOString() }, new Date(NOW - 20 * 60_000).toISOString())]),
      `The last feed read succeeded at ${istTimeKey(new Date(NOW - 20 * 60_000))} and nothing has been read since — no paid posts found for 1348 min, and no answer from Instagram is on record after it.`,
    ],
    [
      'no heartbeat names the server — the host is named, not guessed',
      passes([row('linode-detect', { kind: 'http-error', status: 400, head: SECFETCH })], { detectionHost: null }),
      'Instagram stopped answering linode-detect\'s feed reads the way it used to (HTTP 400: "SecFetch Policy violation.") — this is not a rate limit, so waiting will not fix it; no paid posts found for 1348 min.',
    ],
    [
      'an empty 200 body is "an empty answer", not a web page',
      passes([row('linode-detect', { kind: 'not-json', status: 200, head: null })]),
      'Instagram stopped answering the server\'s feed reads the way it used to (HTTP 200, an empty answer instead of feed data) — this is not a rate limit, so waiting will not fix it; no paid posts found for 1348 min.',
    ],
    [
      'no answer row yet, but the server\'s cooldown is recorded (the first passes after this build is deployed)',
      passes([], { throttledUntil: until }),
      `Instagram refused the server's anonymous reads, and the server is waiting until ${HHMM} before it asks again — no paid posts found for 1348 min.`,
    ],
    [
      'the server\'s refusal is history (a Mac read after it), but its cooldown still runs',
      passes(
        [row('linode-detect', { kind: 'throttle', status: 401, head: WALL, at: new Date(NOW - 40 * 60_000).toISOString() })],
        { throttledUntil: until, feedOkAt: new Date(NOW - 30 * 60_000) },
      ),
      `Instagram refused the server's anonymous reads, and the server is waiting until ${HHMM} before it asks again — no paid posts found for 30 min.`,
    ],
    [
      'only the Mac has a row',
      passes([row('DMPLs Mac Studio', { kind: 'throttle', status: 401, head: WALL })]),
      'Instagram is refusing anonymous reads from DMPLs Mac Studio (HTTP 401: "Please wait a few minutes before you try again.") — no paid posts found for 1348 min; it retries by itself on its next pass.',
    ],
  ]

  it.each(table)('%s', (_name, p, expected) => {
    expect(describeDetectionOutage(p, NOW)).toBe(expected)
  })

  it('never says "refusing" without a recorded refusal — every non-refusal row of the table', () => {
    for (const [name, p] of table) {
      // A refusal is on record as an answer row, or as the cooldown the gate recorded for the server.
      const refused =
        p.throttledUntil !== null ||
        p.feedAnswers.some((r) => r.lastFailure && (r.lastFailure.kind === 'throttle' || r.lastFailure.kind === 'login-wall'))
      if (!refused) expect(describeDetectionOutage(p, NOW), name).not.toMatch(/refus/i)
    }
  })

  it("a recorded cooldown is never 'may not be running this build' — whatever the answer rows say", () => {
    const shapes: FeedAnswerRow[][] = [
      [],
      [row('linode-detect', null, new Date(NOW - 10 * 60_000).toISOString())],
      [row('linode-detect', { kind: 'http-error', status: 400, at: new Date(NOW - 50 * 60_000).toISOString() }, new Date(NOW - 45 * 60_000).toISOString())],
    ]
    for (const rows of shapes) {
      for (const feedOk of [feedOkAt, null, new Date(NOW - 30 * 60_000)]) {
        const sentence = describeDetectionOutage(passes(rows, { throttledUntil: until, feedOkAt: feedOk }), NOW)
        expect(sentence).not.toMatch(/may not be running this build/)
        expect(sentence).not.toMatch(/^The last feed read succeeded/)
        expect(sentence).toMatch(/refused the server's anonymous reads/)
      }
    }
  })

  it('a failure older than the last read anywhere is history, not the cause', () => {
    const p = passes([row('linode-detect', { kind: 'throttle', status: 401, at: new Date(feedOkAt.getTime() - 60_000).toISOString() })])
    expect(describeDetectionOutage(p, NOW)).toMatch(/^The last feed read succeeded at/)
  })

  it('an answer older than ninety minutes says the pass may have stopped asking', () => {
    const old = new Date(NOW - EVIDENCE_STALE_MS - 60_000)
    const p = passes([row('linode-detect', { kind: 'http-error', status: 400, head: SECFETCH, at: old.toISOString() })])
    expect(describeDetectionOutage(p, NOW)).toContain(`The last answer on record is from ${istTimeKey(old)}, so the detection pass may have stopped asking.`)
  })

  it('quoteOf: Instagram\'s message, short prose, and never HTML', () => {
    expect(quoteOf({ kind: 'throttle', head: WALL })).toBe('Please wait a few minutes before you try again.')
    expect(quoteOf({ kind: 'http-error', head: 'Service Unavailable' })).toBe('Service Unavailable')
    expect(quoteOf({ kind: 'http-error', head: HTML })).toBeNull()
    expect(quoteOf({ kind: 'shape', head: '{"data":{}}' })).toBeNull()
    expect(quoteOf({ kind: 'http-error', head: null })).toBeNull()
    expect(quoteOf({ kind: 'http-error', head: `{"message":"${'w'.repeat(200)}"}` })!.length).toBe(80)
  })
})

describe('lastCheckCause — a few words beside "Last check read 0 posts"', () => {
  const NOW = Date.parse('2026-10-15T08:00:00Z')
  const run = { startedAt: new Date(NOW - 10 * 60_000), finishedAt: new Date(NOW - 8 * 60_000), postsSeen: 0 }
  const p = (failure: Partial<FeedAnswer> | null) => ({
    feedOkAt: new Date(NOW - 1348 * 60_000),
    throttledUntil: null,
    detectionHost: 'linode-detect',
    feedAnswers: failure
      ? [{ host: 'linode-detect', last: answer({ at: new Date(NOW - 9 * 60_000).toISOString(), ...failure }), lastFailure: answer({ at: new Date(NOW - 9 * 60_000).toISOString(), ...failure }), lastOkAt: null }]
      : [],
  })

  it('names the answer for a finished check that read nothing', () => {
    expect(lastCheckCause(p({ kind: 'http-error', status: 400 }), run)).toBe('Instagram answered HTTP 400')
    expect(lastCheckCause(p({ kind: 'throttle', status: 401 }), run)).toBe('Instagram answered HTTP 401')
    expect(lastCheckCause(p({ kind: 'not-json', status: 200 }), run)).toBe('Instagram answered HTTP 200 with a web page')
    expect(lastCheckCause(p({ kind: 'transport', status: null }), run)).toBe('Instagram could not be reached')
    // A bare "answered HTTP 200" reads as success — the wall, the shape, the empty body are the cause.
    expect(lastCheckCause(p({ kind: 'login-wall', status: 200 }), run)).toBe('Instagram answered HTTP 200 with the login wall')
    expect(lastCheckCause(p({ kind: 'shape', status: 200 }), run)).toBe('Instagram answered HTTP 200 in an unexpected shape')
    expect(lastCheckCause(p({ kind: 'not-json', status: 200, head: null }), run)).toBe('Instagram answered HTTP 200 with an empty answer')
  })

  it('says nothing for a check that read posts, one still running, no evidence, or a cause older than the check', () => {
    expect(lastCheckCause(p({ kind: 'http-error' }), { ...run, postsSeen: 12 })).toBeNull()
    expect(lastCheckCause(p({ kind: 'http-error' }), { ...run, finishedAt: null })).toBeNull()
    expect(lastCheckCause(p(null), run)).toBeNull()
    expect(lastCheckCause(p({ kind: 'http-error' }), { ...run, startedAt: new Date(NOW + 60 * 60_000) })).toBeNull()
    expect(lastCheckCause(p({ kind: 'http-error' }), null)).toBeNull()
  })
})
