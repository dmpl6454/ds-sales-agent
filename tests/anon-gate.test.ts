/**
 * The host-wide anonymous-access gate (src/detection/anonGate.ts), in both directions.
 *
 * Why it exists is measured in its docblock: from 4 Sept 2026 Instagram answered every
 * anonymous read with 401 "Please wait a few minutes", the code treated that as a
 * per-channel failure and kept hammering, and detection was ~99% blind for three days
 * while its health stamp stayed fresh. Three things must therefore hold, and each is
 * asserted so that deleting it fails a test:
 *
 *   1. a 401 or 429 IS a throttle, and opens a cooldown that grows on repeat and resets on
 *      one success (the pure core);
 *   2. `fetchFeed` makes NO request while the gate is closed, and a throttle response
 *      closes it (the feed contract, against a stubbed global fetch);
 *   3. every anonymous Instagram caller in src/detection consults the gate — a source
 *      grep, because the failure mode is a caller nobody has written yet.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  ANON_THROTTLE_STEPS_MS,
  EMPTY_ANON_STATE,
  anonGateCheck,
  anonGateRecordSuccess,
  anonGateRecordThrottle,
  anonGateSnapshot,
  isThrottleResponse,
  isThrottled,
  noteSuccess,
  noteThrottle,
  resetAnonGate,
  setAnonGateClock,
} from '@/detection/anonGate'
import { fetchFeed, FeedFetchError } from '@/detection/feed'
import { setIgTransportForTests, type IgResponse } from '@/detection/igHttp'

const MIN = 60_000

describe('isThrottleResponse — what counts as Instagram saying stop', () => {
  const wall = '{"message":"Please wait a few minutes before you try again.","require_login":true}'
  it('429 always, 401 always (there is no legitimate per-handle 401 on these endpoints)', () => {
    expect(isThrottleResponse(429, '')).toBe(true)
    expect(isThrottleResponse(401, '')).toBe(true)
    expect(isThrottleResponse(401, wall)).toBe(true)
  })
  it('403 only when the body says so — a gated account can also 403', () => {
    expect(isThrottleResponse(403, wall)).toBe(true)
    expect(isThrottleResponse(403, '{"status":"fail"}')).toBe(false)
  })
  it('never for the answers that are facts about a handle or the server', () => {
    for (const status of [200, 400, 404, 500, 502]) expect(isThrottleResponse(status, wall)).toBe(false)
  })
})

describe('the pure ladder', () => {
  it('opens a 15-minute cooldown on the first strike and doubles on each repeat, capped at an hour', () => {
    let s = noteThrottle(EMPTY_ANON_STATE, 1_000, 'feed')
    expect(s.strikes).toBe(1)
    expect(s.throttledUntil).toBe(1_000 + 15 * MIN)
    s = noteThrottle(s, 2_000, 'feed')
    expect(s.throttledUntil).toBe(2_000 + 30 * MIN)
    s = noteThrottle(s, 3_000, 'profile')
    expect(s.throttledUntil).toBe(3_000 + 60 * MIN)
    s = noteThrottle(s, 4_000, 'feed')
    expect(s.throttledUntil).toBe(4_000 + 60 * MIN) // capped at an hour: a retry costs one request
    s = noteThrottle(s, 5_000, 'feed')
    expect(s.throttledUntil).toBe(5_000 + ANON_THROTTLE_STEPS_MS[ANON_THROTTLE_STEPS_MS.length - 1]!)
    expect(s.lastThrottleSource).toBe('feed')
  })
  it('one success resets the ladder entirely — the next throttle is a first strike again', () => {
    const throttled = noteThrottle(noteThrottle(EMPTY_ANON_STATE, 0, 'feed'), 1, 'feed')
    const ok = noteSuccess(throttled, 2)
    expect(ok.strikes).toBe(0)
    expect(ok.throttledUntil).toBeNull()
    expect(ok.lastOkAt).toBe(2)
    expect(noteThrottle(ok, 3, 'feed').throttledUntil).toBe(3 + 15 * MIN)
  })
  it('isThrottled is exclusive at the boundary', () => {
    const s = noteThrottle(EMPTY_ANON_STATE, 0, 'feed')
    expect(isThrottled(s, 15 * MIN - 1)).toBe(true)
    expect(isThrottled(s, 15 * MIN)).toBe(false)
    expect(isThrottled(EMPTY_ANON_STATE, 0)).toBe(false)
  })
})

describe('the process-wide gate and the feed contract', () => {
  let now = 1_700_000_000_000
  beforeEach(() => {
    resetAnonGate()
    setAnonGateClock(() => now)
  })
  afterEach(() => {
    setAnonGateClock()
    resetAnonGate()
    setIgTransportForTests()
  })

  const respond = (status: number, body: string) =>
    vi.fn(
      async (): Promise<IgResponse> => ({
        status,
        ok: status >= 200 && status < 300,
        text: async () => body,
        json: async () => JSON.parse(body) as unknown,
      }),
    )
  const useTransport = (fn: ReturnType<typeof respond>) => setIgTransportForTests(fn as unknown as Parameters<typeof setIgTransportForTests>[0])

  it('a 401 from the feed closes the gate, and the error names the reopening time', async () => {
    const fetchMock = respond(401, '{"message":"Please wait a few minutes before you try again.","require_login":true}')
    useTransport(fetchMock)
    await expect(fetchFeed('viralbhayani', { maxPages: 1 })).rejects.toMatchObject({
      name: 'FeedFetchError',
      isThrottle: true,
      until: new Date(now + 15 * MIN),
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(anonGateCheck()).toEqual({ ok: false, until: new Date(now + 15 * MIN), strikes: 1 })
  })

  it('while the gate is closed fetchFeed makes NO request at all', async () => {
    anonGateRecordThrottle('exists', 429) // a throttle earned by a DIFFERENT profile-scope module binds only profile reads
    expect(anonGateCheck('profile').ok).toBe(false)
    expect(anonGateCheck('feed')).toEqual({ ok: true }) // the feed scope is untouched — the Linode's permanent profile 429 must not blind it
    anonGateRecordThrottle('feed', 401)
    const fetchMock = respond(200, '{"items":[],"more_available":false,"status":"ok"}')
    useTransport(fetchMock)
    const err = await fetchFeed('viralbhayani', { maxPages: 1 }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(FeedFetchError)
    expect((err as FeedFetchError).isThrottle).toBe(true)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('the gate reopens by itself when the cooldown lapses, and a success resets the strikes', async () => {
    anonGateRecordThrottle('feed', 401)
    now += 15 * MIN
    expect(anonGateCheck()).toEqual({ ok: true })
    const fetchMock = respond(200, '{"items":[],"more_available":false,"status":"ok"}')
    useTransport(fetchMock)
    const result = await fetchFeed('viralbhayani', { maxPages: 1 })
    expect(result.pagesFetched).toBe(1)
    expect(anonGateSnapshot().strikes).toBe(0)
    expect(anonGateSnapshot().lastOkAt).toBe(now)
  })

  it('a repeat throttle straight after a lapsed cooldown waits twice as long', () => {
    anonGateRecordThrottle('feed', 401)
    now += 15 * MIN
    anonGateRecordThrottle('feed', 401)
    expect(anonGateCheck()).toEqual({ ok: false, until: new Date(now + 30 * MIN), strikes: 2 })
    anonGateRecordSuccess('feed')
    expect(anonGateCheck()).toEqual({ ok: true })
  })

  it('a plain 404 is a fact about the handle, not a throttle — the gate stays open', async () => {
    useTransport(respond(404, '{"status":"fail"}'))
    const err = await fetchFeed('nobody_here_xyz', { maxPages: 1 }).catch((e: unknown) => e)
    expect((err as FeedFetchError).isThrottle).toBe(false)
    expect(anonGateCheck()).toEqual({ ok: true })
  })
})

describe('every anonymous Instagram caller consults the gate (source grep)', () => {
  const root = join(process.cwd(), 'src', 'detection')
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const full = join(dir, name)
      return statSync(full).isDirectory() ? walk(full) : full.endsWith('.ts') ? [full] : []
    })
  /**
   * Not Instagram's ANONYMOUS API: CDN thumbnails, the two DeepSeek callers — and, since
   * 15 Oct 2026, graphFeed.ts, which calls Meta's authenticated Graph API with a token. The
   * anonymous gate is about this host's IP being refused by the anonymous endpoints; the
   * official path has its own pause (graphFeed.ts `graphCooldown`) and must NEVER close or
   * open the anonymous gate — asserted separately below, so the exemption cannot hide a call.
   */
  const NOT_INSTAGRAM_API = new Set(['media.ts', 'decideBrand.ts', 'semantic.ts', 'graphFeed.ts'])
  /**
   * Files allowed a bare `fetch()` — NOT the same set (review, 15 Oct 2026): graphFeed.ts is exempt
   * from the anonymous gate, never from igGet. A `fetch()` there would send undici's own headers to
   * graph.facebook.com and bypass the one transport tests can replace, so it stays under the scan.
   */
  const BARE_FETCH_ALLOWED = new Set(['media.ts', 'decideBrand.ts', 'semantic.ts'])
  /**
   * A PERSON'S PROBE (15 Oct 2026, `pnpm ig:probe`). It IS an anonymous Instagram read, and it is
   * exempt from "every caller records" for the opposite reason to the rule: its whole contract is
   * that it records NOTHING — a person's one-off 401 must not close this host's gate on the
   * detection pass. The reverse is asserted below, so the exemption cannot hide a write.
   */
  const PERSON_PROBES = new Set(['feedProbe.ts'])

  it('a file that calls fetch() against Instagram must check the gate before and classify the answer after', () => {
    // Every Instagram read goes through igGet (igHttp.ts); a bare fetch() against Instagram is itself a defect.
    const callers = walk(root).filter((f) => /igGet\(/.test(readFileSync(f, 'utf8')) && !f.endsWith('igHttp.ts'))
    const relevant = callers.filter((f) => !NOT_INSTAGRAM_API.has(f.split('/').pop()!) && !PERSON_PROBES.has(f.split('/').pop()!))
    // Comments stripped first: a docblock that MENTIONS `await fetch()` is not a call (that grep
    // trap is recorded in CLAUDE.md for every-send-path-asks-the-gate).
    const code = (f: string) => readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    const bareFetchers = walk(root).filter((f) => /await fetch\(/.test(code(f)) && !BARE_FETCH_ALLOWED.has(f.split('/').pop()!))
    expect(bareFetchers, 'an Instagram read using Node fetch gets 400 SecFetch Policy violation — use igGet').toEqual([])
    expect(relevant.map((f) => f.split('/').pop()).sort()).toEqual(
      ['enrichHandle.ts', 'exists.ts', 'feed.ts', 'resolveBrand.ts'].sort(),
    )
    for (const file of relevant) {
      const src = readFileSync(file, 'utf8')
      expect(src, `${file} must ask anonGateCheck() before spending a request`).toMatch(/anonGateCheck\(/)
      expect(src, `${file} must record a throttle response`).toMatch(/anonGateRecordThrottle\(/)
      expect(src, `${file} must record a success so the ladder resets`).toMatch(/anonGateRecordSuccess\(/)
    }
  })

  it('the pipeline checks the gate per channel BEFORE fetching, and rehydrates it per pass', () => {
    const src = readFileSync(join(root, 'pipeline.ts'), 'utf8')
    const body = src.slice(src.indexOf('export async function runDetection('))
    // a cooldown ending just after the cron fires must be WAITED for, not skipped for 15 minutes
    expect(body).toMatch(/waitMs <= GATE_REOPEN_WAIT_MAX_MS/)
    const check = body.indexOf('anonGateCheck(')
    // The pipeline reads through ONE selector since 15 Oct 2026 (feedSource.ts), which calls
    // fetchFeed — and fetchFeed asks the gate itself before every request.
    const fetch = body.indexOf('await fetchChannelFeed(')
    expect(check).toBeGreaterThan(-1)
    expect(check).toBeLessThan(fetch)
    expect(body).toMatch(/await hydrateAnonGate\(\)/)
    expect(body).toMatch(/skipped = 'throttled'/)
  })

  it('a person\'s probe reads the gate\'s row only to SAY it is closed — it never records a throttle, a success or an answer', () => {
    const code = (f: string) => readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    for (const name of PERSON_PROBES) {
      const probe = code(join(root, name))
      // It IS an Instagram read, through the one transport — so the exemption is about recording, not about igGet.
      expect(probe).toMatch(/igGet\(/)
      expect(probe).not.toMatch(/anonGate(Check|RecordThrottle|RecordSuccess)\(/)
      expect(probe).not.toMatch(/recordFeedAnswer\(/)
      expect(probe).not.toMatch(/prisma\.setting\.(upsert|create|createMany|update|updateMany|delete|deleteMany)\(/)
    }
  })

  it('the official read path never touches the anonymous gate, and never sends the anonymous identity', () => {
    const code = (f: string) => readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    const graph = code(join(root, 'graphFeed.ts'))
    expect(graph).not.toMatch(/anonGate(Check|RecordThrottle|RecordSuccess)\(/)
    expect(graph).not.toMatch(/FEED_HEADERS/)
    // Exempt from the GATE, not from the transport: every official request goes through igGet.
    expect(graph).toMatch(/igGet\(/)
    expect(graph).not.toMatch(/\bfetch\(/)
    // The selector consults the gate BEFORE any anonymous request, so a closed gate is never spent.
    const source = code(join(root, 'feedSource.ts'))
    const fn = source.slice(source.indexOf('export async function fetchChannelFeed('))
    expect(fn.indexOf('anonGateCheck(')).toBeGreaterThan(-1)
    expect(fn.indexOf('anonGateCheck(')).toBeLessThan(fn.indexOf('anon = await fetchFeed('))
  })
})
