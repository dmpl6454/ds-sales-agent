import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * `pnpm ig:probe` (src/detection/feedProbe.ts, 15 Oct 2026) — ask Instagram once per identity,
 * from this host, and SAY what came back without speaking for the detection pass.
 *
 * What carries the weight, each driven both ways and each mutation applied by hand, seen red,
 * and restored:
 *
 *   1. THE PROBE CLOSES NO GATE AND WRITES NO ROW. A 401, a 200 login wall and a 429 leave the
 *      anonymous gate open with zero strikes and the Setting table empty — beside a CONTROL that
 *      drives fetchFeed with the same 401 and sees both change, so the assertion cannot pass on a
 *      harness that never writes. MUTATION: adding `anonGateRecordThrottle('feed', res.status)`
 *      after the classification in `probeIdentities` fails "a refused probe closes no gate";
 *      adding `void recordFeedAnswer({...})` there fails "… and writes no evidence row".
 *   2. `--graph` READS WITH `record: false`. MUTATION: removing `record: false` from
 *      `probeOfficialRead` in graphFeed.ts fails "--graph writes no evidence row either".
 *   3. THE IN-USE CANDIDATE IS fetchFeed's REQUEST, byte for byte — URL, headers, timeout —
 *      captured from both through `setIgTransportForTests`. MUTATION: giving the in-use entry
 *      `{ ...FEED_HEADERS }` plus one extra header in feed.ts fails it.
 *   4. EXACTLY N REQUESTS, N−1 SPACINGS, the spacing injected (no test sleeps six seconds), and
 *      `--offline` makes none. MUTATION: dropping the `if (plan.offline) return []` guard in
 *      `probeIdentities` fails "--offline makes zero requests" (runProbe returns before it, but
 *      the direct call is asserted too).
 *   5. No candidate carries a credential (decision 4) — asserted over every entry, the --ua one too.
 *   6. The line formatter and the reading are PURE tables.
 *   7. A token never reaches the terminal, even when the transport echoes it. Each of runProbe's own
 *      two scrubs is pinned on its own (review, 15 Oct 2026) with a token none of the generic shapes
 *      catch, so no other guard can mask its removal. MUTATION (applied by hand, saw red, restored):
 *      printing `g.sentence` unscrubbed fails "the official sentence is scrubbed by runProbe itself";
 *      building `clean` with an empty token fails "a stored head carrying the bare token…".
 *   8. (review) the reading never says "the identity is the fix" when the identity in use got NO
 *      ANSWER or a 5xx — a blip on the first request is not a verdict. MUTATION (applied by hand, saw
 *      red, restored): dropping `&& !inconclusive` from the otherApps branch fails both rows.
 *
 * No network: every request goes through `setIgTransportForTests`.
 */

const dir = mkdtempSync(join(tmpdir(), 'ds-probe-'))
const dbPath = join(dir, 'probe.db')
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
const feed = await import('@/detection/feed')
const p = await import('@/detection/feedProbe')
const { anonGateCheck, anonGateSnapshot, resetAnonGate } = await import('@/detection/anonGate')
const { setIgTransportForTests } = await import('@/detection/igHttp')
type IgResponse = import('@/detection/igHttp').IgResponse
const fe = await import('@/detection/feedEvidence')
const g = await import('@/detection/graphFeed')
type ProbePlan = import('@/detection/feedProbe').ProbePlan
type IdentityProbeResult = import('@/detection/feedProbe').IdentityProbeResult

afterAll(async () => {
  await fe.feedAnswersSettled()
  await prisma.$disconnect()
  rmSync(dir, { recursive: true, force: true })
  if (savedDevice === undefined) delete process.env.DS_DEVICE_NAME
  else process.env.DS_DEVICE_NAME = savedDevice
})

const WALL = '{"message":"Please wait a few minutes before you try again.","require_login":true,"status":"fail"}'
const HTML = '<!DOCTYPE html><html lang="en"><head><title>Instagram</title></head><body></body></html>'
const PAGE = JSON.stringify({ items: [{ code: 'AAAAAAA', taken_at: 1_760_000_000, caption: { text: 'hi' } }], more_available: false })
const TOKEN = 'tok_SECRET_value_9'
const IG_USER_ID = '17841400000000999'

const respond = (status: number, body: string, contentType: string | null = 'application/json; charset=utf-8'): IgResponse => ({
  status,
  ok: status >= 200 && status < 300,
  contentType,
  text: async () => body,
  json: async () => JSON.parse(body) as unknown,
})

type Call = { url: string; headers: Record<string, string>; timeoutMs: number }
let calls: Call[] = []
function useTransport(answer: (url: string, i: number) => IgResponse | Error) {
  setIgTransportForTests(async (url, init) => {
    const i = calls.length
    calls.push({ url, headers: { ...init.headers }, timeoutMs: init.timeoutMs })
    const a = answer(url, i)
    if (a instanceof Error) throw a
    return a
  })
}

const noSleep = vi.fn(async (_ms: number) => {})
const plan = (over: Partial<ProbePlan> = {}): ProbePlan => ({
  handle: 'viralbhayani',
  offline: false,
  candidates: feed.FEED_IDENTITY_PROBES,
  graph: false,
  ...over,
})
const settingRows = () => prisma.setting.findMany({ orderBy: { key: 'asc' } })

beforeEach(async () => {
  // A pass's evidence write is fire-and-forget; one landing after this cleanup would be blamed on the next test.
  await fe.feedAnswersSettled()
  calls = []
  noSleep.mockClear()
  resetAnonGate()
  fe.resetFeedEvidenceForTests()
  g.resetGraphStateForTests()
  await prisma.setting.deleteMany({})
})
afterEach(() => {
  setIgTransportForTests()
  vi.unstubAllEnvs()
})

const CREDENTIAL_HEADER = /cookie|authorization|session|csrf|claim|ds-user|^x-mid$|rur|^ig-u-|x-ig-set|token/i

describe('the identity candidates (feed.ts FEED_IDENTITY_PROBES)', () => {
  it('are the three named in order, each reading the handle asked for', () => {
    expect(feed.FEED_IDENTITY_PROBES.map((c) => c.name)).toEqual([
      'android-app (in use)',
      'android-app, newer version',
      'web (walled since 4 Sept — control)',
    ])
    for (const c of feed.FEED_IDENTITY_PROBES) {
      const url = new URL(c.url('viralbhayani'))
      expect(url.protocol).toBe('https:')
      expect(url.pathname).toBe('/api/v1/feed/user/viralbhayani/username/')
      expect(c.note.length).toBeGreaterThan(10)
    }
  })

  it('carry no Cookie, Authorization or session header of any kind — every entry, and the --ua one (decision 4)', () => {
    const all = [...feed.FEED_IDENTITY_PROBES, p.customUaProbe('Instagram 999.0.0.0.0 Android (34/14; 480dpi)')]
    for (const c of all) {
      for (const [k, v] of Object.entries(c.headers)) {
        expect(k, `${c.name}: ${k}`).not.toMatch(CREDENTIAL_HEADER)
        expect(v, `${c.name}: ${k}`).not.toMatch(/sessionid=|ds_user_id=|csrftoken=|bearer /i)
      }
    }
  })

  it('the in-use entry IS FEED_HEADERS and feedPageUrl, by reference', () => {
    const inUse = feed.FEED_IDENTITY_PROBES[0]!
    expect(inUse.headers).toBe(feed.FEED_HEADERS)
    expect(inUse.url('some.handle_1')).toBe(feed.feedPageUrl('some.handle_1'))
  })

  it('the newer version changes ONLY the app version and build number — same host, app id, device', () => {
    const [inUse, newer] = feed.FEED_IDENTITY_PROBES
    expect(newer!.url('x')).toBe(inUse!.url('x'))
    const { 'User-Agent': ua, ...rest } = newer!.headers
    const { 'User-Agent': inUseUa, ...inUseRest } = inUse!.headers
    expect(rest).toEqual(inUseRest)
    const device = (s: string) => s.replace(/^Instagram [\d.]+ Android \(/, '').replace(/; \d+\)$/, '')
    expect(device(ua!)).toBe(device(inUseUa!))
    expect(ua).not.toBe(inUseUa)
    expect(newer!.note).toMatch(/^UNVERIFIED/)
  })

  it('the web control is the retired web identity on the web host', () => {
    const web = feed.FEED_IDENTITY_PROBES[2]!
    expect(new URL(web.url('x')).host).toBe('www.instagram.com')
    expect(web.headers['x-ig-app-id']).toBe('936619743392459')
    expect(web.headers['User-Agent']).toMatch(/^Mozilla\/5\.0/)
  })
})

describe('probeIdentities — one request each, spaced, and nothing recorded', () => {
  it('the in-use candidate is fetchFeed’s exact first request — URL, headers, timeout', async () => {
    useTransport(() => respond(200, PAGE))
    await feed.fetchFeed('viralbhayani', { maxPages: 1 })
    await p.probeIdentities(plan({ candidates: [feed.FEED_IDENTITY_PROBES[0]!] }), { sleep: noSleep })
    expect(calls).toHaveLength(2)
    expect(calls[1]).toEqual(calls[0])
    expect(calls[0]!.timeoutMs).toBe(feed.REQUEST_TIMEOUT_MS)
  })

  it('makes exactly N requests with N−1 spacings, and the spacing is injectable', async () => {
    useTransport(() => respond(200, PAGE))
    const r = await p.probeIdentities(plan(), { sleep: noSleep })
    expect(calls).toHaveLength(3)
    expect(r).toHaveLength(3)
    expect(noSleep.mock.calls).toEqual([[p.PROBE_SPACING_MS], [p.PROBE_SPACING_MS]])
    expect(p.PROBE_SPACING_MS).toBe(6_000)

    calls = []
    noSleep.mockClear()
    const parsed = p.parseProbeArgs(['--ua', 'Instagram 999.1.0.0.1 Android (34/14; 480dpi; 1080x2400; Google; Pixel 8)'])
    if (parsed.kind !== 'run') throw new Error('expected a plan')
    await p.probeIdentities(parsed.plan, { sleep: noSleep, spacingMs: 10 })
    expect(calls).toHaveLength(4)
    expect(calls[2]!.headers['User-Agent']).toMatch(/^Instagram 999\.1/)
    expect(new URL(calls[3]!.url).host).toBe('www.instagram.com') // the control stays last
    expect(noSleep.mock.calls).toEqual([[10], [10], [10]])
  })

  it('--offline makes zero requests', async () => {
    useTransport(() => respond(200, PAGE))
    expect(await p.probeIdentities(plan({ offline: true }), { sleep: noSleep })).toEqual([])
    const parsed = p.parseProbeArgs(['--offline', '--ua', 'Instagram 999.1.0.0.1 Android (34/14)', '--graph'])
    if (parsed.kind !== 'run') throw new Error('expected a plan')
    const out: string[] = []
    const code = await p.runProbe(parsed.plan, { out: (l) => out.push(l), sleep: noSleep, graphReady: () => true, probeGraph: async () => { throw new Error('asked') } })
    expect(calls).toHaveLength(0)
    expect(code).toBe(0)
    expect(out).toContain('--offline: no request made.')
    expect(out.join('\n')).toMatch(/What the detection passes last recorded/)
    expect(p.probeRequestCount(parsed.plan, true)).toEqual({ anonymous: 0, graph: 0, total: 0 })
  })

  it('CONTROL: fetchFeed refused with a 401 DOES close the gate and write a row — so the harness can see both', async () => {
    useTransport(() => respond(401, WALL))
    await feed.fetchFeed('viralbhayani', { maxPages: 1 }).catch(() => {})
    await fe.feedAnswersSettled()
    expect(anonGateCheck().ok).toBe(false)
    // Both writes landed — the gate's own row too, which is persisted on its own timer.
    await vi.waitFor(async () => {
      const keys = (await settingRows()).map((r) => r.key)
      expect(keys).toContain('detectFeedAnswer:linode-detect')
      expect(keys).toContain('anonThrottle:linode-detect')
    })
  })

  it('a refused probe closes no gate — 401, a 200 login wall and a 429', async () => {
    const answers = [respond(401, WALL), respond(200, WALL), respond(429, '{"message":"rate limited"}')]
    useTransport((_u, i) => answers[i]!)
    const r = await p.probeIdentities(plan(), { sleep: noSleep })
    expect(r.map((x) => x.kind)).toEqual(['throttle', 'login-wall', 'throttle'])
    expect(anonGateCheck()).toEqual({ ok: true })
    expect(anonGateSnapshot('feed').strikes).toBe(0)
    expect(anonGateSnapshot('profile').strikes).toBe(0)
  })

  it('… and writes no evidence row, nor any Setting row at all', async () => {
    const answers = [respond(401, WALL), respond(200, HTML, 'text/html'), new Error('getaddrinfo ENOTFOUND www.instagram.com')]
    useTransport((_u, i) => answers[i]!)
    await p.runProbe(plan(), { out: () => {}, sleep: noSleep, graphReady: () => false })
    await fe.feedAnswersSettled()
    expect(await settingRows()).toEqual([])
  })

  it('--graph writes no evidence row either (the official read runs with record: false)', async () => {
    vi.stubEnv('META_GRAPH_TOKEN', TOKEN)
    vi.stubEnv('META_IG_USER_ID', IG_USER_ID)
    const graphPage = {
      business_discovery: {
        username: 'viralbhayani',
        media: {
          data: [{ id: '1', caption: 'x', timestamp: '2026-10-15T08:01:02+0000', permalink: 'https://www.instagram.com/p/DcAAAAAAAA1/', media_type: 'IMAGE', media_product_type: 'FEED' }],
          paging: { cursors: { before: 'b' } },
        },
        id: '17841400000000001',
      },
      id: IG_USER_ID,
    }
    useTransport((url) => (url.startsWith('https://graph.facebook.com') ? respond(200, JSON.stringify(graphPage)) : respond(200, PAGE)))
    const parsed = p.parseProbeArgs(['--graph'])
    if (parsed.kind !== 'run') throw new Error('expected a plan')
    const out: string[] = []
    const code = await p.runProbe(parsed.plan, { out: (l) => out.push(l), sleep: noSleep })
    await fe.feedAnswersSettled()
    expect(calls.filter((c) => c.url.startsWith('https://graph.facebook.com'))).toHaveLength(1)
    expect(calls).toHaveLength(4)
    expect(code).toBe(0)
    expect(out.join('\n')).toMatch(/This makes 4 requests: 3 to Instagram's anonymous feed for @viralbhayani, one per identity, 6 s apart, and 1 to the official API\./)
    expect(out.join('\n')).toMatch(/The official API read 1 post\(s\) from @viralbhayani/)
    expect(await settingRows()).toEqual([])
  })

  it('a token never reaches the terminal, even when the transport echoes it', async () => {
    vi.stubEnv('META_GRAPH_TOKEN', TOKEN)
    vi.stubEnv('META_IG_USER_ID', IG_USER_ID)
    useTransport((url) => (url.startsWith('https://graph.facebook.com') ? new Error(`connect ECONNREFUSED ${url}`) : respond(200, PAGE)))
    const out: string[] = []
    await p.runProbe(plan({ graph: true }), { out: (l) => out.push(l), sleep: noSleep })
    const text = out.join('\n')
    expect(text).toMatch(/The official API did not read @viralbhayani/)
    expect(text).not.toContain(TOKEN)
    expect(text).not.toContain(encodeURIComponent(TOKEN))
    // The probe announced ONE official request; a failed one is NOT retried (graphFeed.ts transportRetries: 0).
    expect(calls.filter((c) => c.url.startsWith('https://graph.facebook.com'))).toHaveLength(1)
  })

  it('the official sentence is scrubbed by runProbe itself — a probe that echoes the bare token', async () => {
    vi.stubEnv('META_GRAPH_TOKEN', TOKEN)
    vi.stubEnv('META_IG_USER_ID', IG_USER_ID)
    useTransport(() => respond(200, PAGE))
    const out: string[] = []
    await p.runProbe(plan({ graph: true }), {
      out: (l) => out.push(l),
      sleep: noSleep,
      graphReady: () => true,
      // Not graphFeed's own scrubbed message: a sentence carrying the token as it is.
      probeGraph: async () => ({ ok: false, sentence: `The official API did not read @viralbhayani: echoed ${TOKEN} back` }),
    })
    const text = out.join('\n')
    expect(text).toMatch(/echoed \[redacted\] back/)
    expect(text).not.toContain(TOKEN)
  })

  it('a stored head carrying the bare token is scrubbed before it reaches the terminal', async () => {
    vi.stubEnv('META_GRAPH_TOKEN', TOKEN)
    vi.stubEnv('META_IG_USER_ID', IG_USER_ID)
    const leaky = {
      at: '2026-10-15T08:45:00.000Z',
      host: 'linode-detect',
      source: 'graph' as const,
      handle: 'viralbhayani',
      kind: 'graph-error' as const,
      status: 400,
      contentType: 'application/json',
      head: `(#100) bad request near ${TOKEN}`,
      items: null,
    }
    const out: string[] = []
    await p.runProbe(plan({ offline: true }), {
      out: (l) => out.push(l),
      sleep: noSleep,
      graphReady: () => true,
      readStored: async () => ({ feedAnswers: [{ host: 'linode-detect', last: leaky, lastFailure: leaky, lastOkAt: null }], gates: [], feedOkAt: null, throttledUntil: null }),
    })
    const text = out.join('\n')
    expect(text).toContain('bad request near [redacted]')
    expect(text).not.toContain(TOKEN)
  })
})

describe('parseProbeArgs and the announcement (PURE)', () => {
  it('defaults, flags, and the forms a person types', () => {
    const d = p.parseProbeArgs([])
    expect(d.kind === 'run' && d.plan).toEqual({ handle: 'viralbhayani', offline: false, candidates: feed.FEED_IDENTITY_PROBES, graph: false })
    const h = p.parseProbeArgs(['--handle=@madovermarketing_mom', '--graph'])
    expect(h.kind === 'run' && [h.plan.handle, h.plan.graph]).toEqual(['madovermarketing_mom', true])
    expect(p.parseProbeArgs(['--help']).kind).toBe('help')
  })

  it.each([
    [['--handle'], /--handle needs an Instagram username/],
    [['--handle', 'bad handle!'], /--handle needs an Instagram username.*"bad handle!"/],
    [['--ua', 'Mozilla/5.0 (Macintosh)'], /--ua needs one Instagram for Android User-Agent/],
    [['--ua', 'Instagram 1.0 Android\r\nCookie: sessionid=x'], /--ua needs one Instagram for Android User-Agent/],
    // An iPhone User-Agent beside the Android app id is the contradiction the check exists to stop.
    [['--ua', 'Instagram 300.0.0.1 (iPhone14,2; iOS 17_0; en_US; scale=3.00)'], /--ua needs one Instagram for Android User-Agent/],
    [['--fast'], /"--fast" is not something ig:probe understands/],
  ])('refuses %j with a reason', (argv, why) => {
    const r = p.parseProbeArgs(argv)
    expect(r.kind).toBe('refused')
    expect(r.kind === 'refused' && r.why).toMatch(why)
  })

  it.each([
    [{}, true, { anonymous: 3, graph: 0, total: 3 }, "This makes 3 requests: 3 to Instagram's anonymous feed for @viralbhayani, one per identity, 6 s apart. It records nothing"],
    [{ graph: true }, true, { anonymous: 3, graph: 1, total: 4 }, 'and 1 to the official API.'],
    [{ graph: true }, false, { anonymous: 3, graph: 0, total: 3 }, '6 s apart. It records nothing'],
    [{ candidates: [feed.FEED_IDENTITY_PROBES[0]!] }, false, { anonymous: 1, graph: 0, total: 1 }, 'This makes 1 request: 1 to Instagram\'s anonymous feed for @viralbhayani, one per identity. It'],
    [{ offline: true, graph: true }, true, { anonymous: 0, graph: 0, total: 0 }, 'This makes no request.'],
  ] as const)('counts %j (graph ready %s)', (over, ready, count, sentence) => {
    const pl = plan(over as Partial<ProbePlan>)
    const c = p.probeRequestCount(pl, ready)
    expect(c).toEqual(count)
    expect(p.describeRequestCount(pl, c)).toContain(sentence)
  })
})

const result = (over: Partial<IdentityProbeResult>): IdentityProbeResult => ({
  name: 'android-app (in use)',
  note: 'exactly what every detection pass sends',
  host: 'i.instagram.com',
  isApp: true,
  status: 200,
  contentType: 'application/json',
  kind: 'ok',
  items: 12,
  head: null,
  ...over,
})

describe('formatProbeResult — the printed lines (PURE)', () => {
  it.each([
    ['served', result({}), 0, ['  1. android-app (in use) — i.instagram.com', '     exactly what every detection pass sends', '     HTTP 200 · application/json · 12 items · served — the feed reader accepts it']],
    [
      'a 401',
      result({ status: 401, kind: 'throttle', items: null, head: WALL }),
      0,
      ['  1. android-app (in use) — i.instagram.com', '     exactly what every detection pass sends', '     HTTP 401 · application/json · refused — Instagram said stop', `     body: ${WALL}`],
    ],
    [
      'a 200 wall',
      result({ kind: 'login-wall', items: null, head: '{"status":"fail","require_login":true}' }),
      1,
      ['  2. android-app (in use) — i.instagram.com', '     exactly what every detection pass sends', '     HTTP 200 · application/json · refused — the login wall', '     body: {"status":"fail","require_login":true}'],
    ],
    [
      'a 400 SecFetch',
      result({ status: 400, kind: 'http-error', items: null, head: '{"message":"SecFetch Policy violation."}' }),
      0,
      ['  1. android-app (in use) — i.instagram.com', '     exactly what every detection pass sends', '     HTTP 400 · application/json · an error status', '     body: {"message":"SecFetch Policy violation."}'],
    ],
    [
      'a web page',
      result({ contentType: 'text/html', kind: 'not-json', items: null, head: '<!DOCTYPE html>' }),
      0,
      ['  1. android-app (in use) — i.instagram.com', '     exactly what every detection pass sends', '     HTTP 200 · text/html · a web page, not feed data', '     body: <!DOCTYPE html>'],
    ],
    [
      'JSON with items the reader refuses',
      result({ kind: 'shape', items: 3 }),
      0,
      ['  1. android-app (in use) — i.instagram.com', '     exactly what every detection pass sends', '     HTTP 200 · application/json · 3 items · JSON, but not in the shape the feed reader accepts'],
    ],
    [
      'no answer',
      result({ status: null, contentType: null, kind: 'transport', items: null, head: 'getaddrinfo ENOTFOUND i.instagram.com' }),
      0,
      ['  1. android-app (in use) — i.instagram.com', '     exactly what every detection pass sends', '     no HTTP status · no answer — the request did not reach Instagram', '     body: getaddrinfo ENOTFOUND i.instagram.com'],
    ],
  ])('%s', (_name, r, i, lines) => {
    expect(p.formatProbeResult(r, i)).toEqual(lines)
  })

  it('every kind has a label', () => {
    for (const k of fe.FEED_ANSWER_KINDS) expect(p.PROBE_KIND_LABEL[k]).toMatch(/\w/)
  })
})

describe('readProbeResults — what one host’s answers say (PURE)', () => {
  const newer = (o: Partial<IdentityProbeResult>) => result({ name: 'android-app, newer version', ...o })
  const web = (o: Partial<IdentityProbeResult>) => result({ name: 'web (walled since 4 Sept — control)', host: 'www.instagram.com', isApp: false, ...o })
  const refusedAll = [result({ status: 401, kind: 'throttle' }), newer({ status: 401, kind: 'throttle' }), web({ status: 401, kind: 'throttle' })]
  it.each([
    ['in use served', [result({}), newer({}), web({ status: 401, kind: 'throttle' })], /^The identity in use is served from this host/],
    ['only a newer app identity served', [result({ status: 400, kind: 'http-error', head: 'update required' }), newer({}), web({ status: 401, kind: 'throttle' })], /^"android-app, newer version" was served and the identity in use was not: the identity is the fix/],
    ['every identity refused', refusedAll, /^Every identity was refused from this host\. Run the same probe on the other host/],
    ['in use 400 "update"', [result({ status: 400, kind: 'http-error', head: '{"message":"Please update your app"}' }), newer({ status: 400, kind: 'http-error' }), web({ status: 401, kind: 'throttle' })], /^Instagram rejected how the request presents itself \(HTTP 400\) — an identity problem, not a rate limit/],
    ['in use 503', [result({ status: 503, kind: 'http-error' }), newer({ status: 503, kind: 'http-error' }), web({ status: 503, kind: 'http-error' })], /^Instagram's own servers failed the identity in use \(HTTP 503\)/],
    ['in use a web page', [result({ kind: 'not-json', contentType: 'text/html' }), newer({ kind: 'not-json' }), web({ status: 401, kind: 'throttle' })], /^Instagram answered the identity in use, but not with feed data \(a web page, not feed data\)/],
    ['no answers at all', [result({ status: null, kind: 'transport' }), newer({ status: null, kind: 'transport' }), web({ status: null, kind: 'transport' })], /^No identity got an answer: this host cannot reach Instagram at all/],
    ['only the web control served', [result({ status: 401, kind: 'throttle' }), newer({ status: 401, kind: 'throttle' }), web({})], /^Only the retired web identity was served — the reverse of 8 Sept/],
    ['in use got no answer, a newer one served — inconclusive', [result({ status: null, kind: 'transport' }), newer({}), web({ status: 401, kind: 'throttle' })], /^The identity in use got no answer while another candidate did\. Probe again/],
    ['in use 503, a newer one served — inconclusive', [result({ status: 503, kind: 'http-error' }), newer({}), web({ status: 401, kind: 'throttle' })], /^Instagram's own servers failed the identity in use \(HTTP 503\).*does not show the identity is the problem/],
  ])('%s', (_name, rs, first) => {
    const lines = p.readProbeResults(rs)
    expect(lines[0]).toMatch(first)
  })

  it('a blip or a 5xx on the identity in use never says the identity is the fix, whatever else was served', () => {
    for (const inUse of [result({ status: null, kind: 'transport' }), result({ status: 503, kind: 'http-error' })]) {
      for (const others of [[newer({}), web({ status: 401, kind: 'throttle' })], [newer({ status: 401, kind: 'throttle' }), web({})]]) {
        const text = p.readProbeResults([inUse, ...others]).join(' ')
        expect(text).not.toMatch(/the identity is the fix/)
        expect(text).not.toMatch(/Instagram is refusing the app identity/)
      }
    }
  })

  it('a refusal on every identity never claims the identity is the fix', () => {
    expect(p.readProbeResults(refusedAll).join(' ')).not.toMatch(/the identity is the fix/)
  })
})

describe('the stored evidence — read in one query, printed first', () => {
  const now = new Date('2026-10-15T09:00:00.000Z')
  const failure = {
    at: '2026-10-15T08:45:00.000Z',
    host: 'linode-detect',
    source: 'anonymous-app' as const,
    handle: 'viralbhayani',
    kind: 'login-wall' as const,
    status: 200,
    contentType: 'application/json',
    head: WALL,
    items: null,
    until: '2026-10-15T09:15:00.000Z',
  }

  it('reads every detectFeedAnswer and anonThrottle row and both stamps from the real database', async () => {
    const record = { last: failure, lastFailure: failure, lastOkAt: '2026-10-14T10:30:00.000Z' }
    await prisma.setting.createMany({
      data: [
        { key: 'detectFeedAnswer:linode-detect', value: JSON.stringify(record) },
        { key: 'detectFeedAnswer:DMPLs Mac Studio', value: 'not json' },
        {
          key: 'anonThrottle:linode-detect',
          value: JSON.stringify({
            feed: { throttledUntil: Date.parse('2026-10-15T09:15:00.000Z'), strikes: 2, lastOkAt: null, lastThrottleAt: Date.parse('2026-10-15T08:45:00.000Z'), lastThrottleSource: 'feed' },
            profile: { throttledUntil: null, strikes: 0, lastOkAt: Date.parse('2026-10-15T08:00:00.000Z'), lastThrottleAt: null, lastThrottleSource: null },
          }),
        },
        { key: 'anonThrottle:old-mac', value: JSON.stringify({ throttledUntil: Date.parse('2026-10-15T09:30:00.000Z'), strikes: 1, lastThrottleSource: 'profile' }) },
        { key: 'detectFeedOkAt', value: '2026-10-14T10:30:00.000Z' },
        { key: 'detectThrottledUntil', value: '2026-10-15T09:15:00.000Z' },
        { key: 'autopilotEnabled', value: 'true' },
      ],
    })
    const ev = await p.readStoredEvidence()
    expect(ev.feedAnswers.map((r) => r.host)).toEqual(['linode-detect']) // the unreadable row is skipped, not guessed
    expect(ev.gates.map((x) => x.host).sort()).toEqual(['linode-detect', 'old-mac'])
    expect(ev.gates.find((x) => x.host === 'old-mac')!.scopes.profile?.strikes).toBe(1) // legacy row lands in its source's scope
    expect(ev.feedOkAt?.toISOString()).toBe('2026-10-14T10:30:00.000Z')
    expect(ev.throttledUntil?.toISOString()).toBe('2026-10-15T09:15:00.000Z')

    const lines = p.formatStoredEvidence(ev, { now, thisHost: 'linode-detect' })
    expect(lines).toContain('    linode-detect (this host)')
    expect(lines).toContain('      last answer    refused — the login wall · HTTP 200 · @viralbhayani · 15 Oct 2026, 14:15 IST (15 min ago)')
    expect(lines).toContain(`                     body: ${WALL}`)
    expect(lines).toContain('      last success   14 Oct 2026, 16:00 IST (22h ago)')
    expect(lines).toContain('      feed: CLOSED until 15 Oct 2026, 14:45 IST (in 15 min), 2 strikes, last refused 15 Oct 2026, 14:15 IST (15 min ago)')
    expect(lines).toContain('      profile: open, last success 15 Oct 2026, 13:30 IST (1h ago)')
    expect(lines).toContain('    last feed page read     14 Oct 2026, 16:00 IST (22h ago)')
    expect(lines).toContain('    server cooldown until   15 Oct 2026, 14:45 IST (in 15 min)')
    expect(lines.join('\n')).not.toMatch(/last failure/) // the same answer is not printed twice
  })

  it('says "none on record" rather than printing nothing', () => {
    const lines = p.formatStoredEvidence({ feedAnswers: [], gates: [], feedOkAt: null, throttledUntil: null }, { now, thisHost: 'linode-detect' })
    expect(lines).toContain('    none on record — no host running this build has asked Instagram since it was deployed')
    expect(lines).toContain('    last feed page read     never recorded')
  })

  it('a head carrying a token from an older build is redacted again before it is printed', () => {
    const leaky = { ...failure, head: '{"message":"bad","access_token":"x","u":"https://g/?access_token=EAAB12345abc"}' }
    const lines = p.formatStoredEvidence(
      { feedAnswers: [{ host: 'linode-detect', last: leaky, lastFailure: leaky, lastOkAt: null }], gates: [], feedOkAt: null, throttledUntil: null },
      { now, thisHost: 'linode-detect' },
    )
    expect(lines.join('\n')).not.toContain('EAAB12345abc')
  })

  it('a database that cannot be read is SAID, and the requests still run', async () => {
    useTransport(() => respond(200, PAGE))
    const out: string[] = []
    const code = await p.runProbe(plan(), { out: (l) => out.push(l), sleep: noSleep, graphReady: () => false, readStored: async () => { throw new Error("Can't reach database server at 127.0.0.1:15432") } })
    expect(out).toContain("Could not read the stored evidence: Can't reach database server at 127.0.0.1:15432.")
    expect(calls).toHaveLength(3)
    expect(code).toBe(0)
  })

  it('a Prisma code frame is reduced to its cause — the last line, without a doubled full stop', () => {
    const frame = new Error('\nInvalid `prisma.setting.findMany()` invocation in\n/opt/ds/src/detection/feedProbe.ts:429:37\n\n  428 export async function\n→ 429   const rows = await prisma.setting.findMany(\nThe table `main.Setting` does not exist in the current database.')
    expect(p.lastLineOf(frame)).toBe('The table `main.Setting` does not exist in the current database')
    expect(p.lastLineOf(new Error("Can't reach database server at 127.0.0.1:15432"))).toBe("Can't reach database server at 127.0.0.1:15432")
    expect(p.lastLineOf('plain words.')).toBe('plain words')
  })

  it('warns that this host’s gate is closed, and asks anyway without closing anything further', async () => {
    useTransport(() => respond(401, WALL))
    const out: string[] = []
    const code = await p.runProbe(plan(), {
      out: (l) => out.push(l),
      now: () => now,
      sleep: noSleep,
      graphReady: () => false,
      readStored: async () => ({
        feedAnswers: [],
        gates: [{ host: 'linode-detect', scopes: { feed: { throttledUntil: Date.parse('2026-10-15T09:15:00.000Z'), strikes: 2, lastOkAt: null, lastThrottleAt: null, lastThrottleSource: 'feed' } } }],
        feedOkAt: null,
        throttledUntil: null,
      }),
    })
    expect(out.join('\n')).toMatch(/This host's anonymous feed gate is closed until 15 Oct 2026, 14:45 IST \(in 15 min\)\. The probe asks anyway, once, and closes nothing/)
    expect(code).toBe(1)
    expect(anonGateCheck()).toEqual({ ok: true })
  })
})
