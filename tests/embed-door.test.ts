import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * THE EMBED DOOR: THE SWITCH, THE GATE, THE PROOF, THE CEILING — AND WHOSE FAILURE A FAILURE IS. 26 Nov 2026.
 *
 * `embedDoor.ts` stands between a caller and Instagram's embed pages, and it is the new source of the verified
 * badge. What is pinned here, each in the direction that would hurt:
 *
 *   - with the switch off, or on the server, NOTHING is requested;
 *   - a badge is believed only after the door has read "verified" on an account we hold as verified AND "not
 *     verified" on one we hold as not — and a control reading the OPPOSITE fails the proof (review, 26 Nov);
 *   - a failed proof and our own ceiling are REFUSALS (`byUs`), so callers stop their pass and bench nobody;
 *   - a 429/401 closes the door at once; a login page, no answer or a 5xx for ONE key is checked against a control
 *     first, and closes the door only if the control fails too (review: one gated key wedged every pass);
 *   - an embed page that answers never reopens the profile door Instagram is still refusing;
 *   - the hourly ceiling and the spacing are this MAC's — two processes share them through a file.
 *
 * The database, the environment and the settings are stand-ins; the gate is the real `anonGate` on a test clock.
 */

const envBox = { SEND_ENABLED: true }
const settingsBox: { value: Record<string, unknown> | Error } = { value: { embedReads: true, embedTransport: 'curl', embedMaxPerHour: 40 } }

vi.mock('@/lib/db', () => ({
  prisma: { setting: { upsert: async () => ({}), findUnique: async () => null, findMany: async () => [] } },
}))
vi.mock('@/lib/env', () => ({ env: envBox }))
vi.mock('@/lib/settings', () => ({
  getSettings: async () => {
    if (settingsBox.value instanceof Error) throw settingsBox.value
    return settingsBox.value
  },
}))

const door = await import('@/detection/embedDoor')
const { readProfileEmbed, readPostEmbed, setEmbedDoorForTests, embedRequestsMade, EMBED_PROOF_MAX_AGE_MS, EMBED_PROOF_RETRY_MS, EMBED_SPACING_MS } = door
const { anonGateCheck, anonGateRecordThrottle, resetAnonGate, setAnonGateClock } = await import('@/detection/anonGate')
type EmbedAnswer = import('@/detection/embedFetch').EmbedAnswer

let clock = 1_800_000_000_000
const asked: string[] = []
const slept: number[] = []
/** What each handle or shortcode's page says. Anything not listed is a 200 with no data for it. */
let world: Record<string, EmbedAnswer | 'verified' | 'unverified' | 'shell'> = {}

const profilePage = (handle: string, verified: boolean): string =>
  `<html><head><title>Instagram</title></head><body><script type="application/json">${JSON.stringify({
    user: { username: handle, full_name: `Name of ${handle}`, is_verified: verified, follower_count: 1234 },
  })}</script></body></html>`
const shell = '<html><head><title>Instagram</title></head><body><div id="app"></div></body></html>'
const loginPage = '<html><head><title>Login • Instagram</title></head><body><input type="password"></body></html>'
const page = (body: string): EmbedAnswer => ({ kind: 'page', status: 200, body, contentType: 'text/html', hops: 0, capped: false })
const LOGIN: EmbedAnswer = { kind: 'login-redirect', status: 302, location: 'https://www.instagram.com/accounts/login/' }

async function fetchStub(url: string): Promise<EmbedAnswer> {
  const profile = /instagram\.com\/([a-z0-9._]+)\/embed\/$/.exec(url)
  const post = /instagram\.com\/p\/([A-Za-z0-9_-]+)\/embed\/captioned\/$/.exec(url)
  const key = profile?.[1] ?? post?.[1] ?? url
  asked.push(key)
  const w = world[key]
  if (w === undefined || w === 'shell') return page(shell)
  if (w === 'verified') return page(profilePage(key, true))
  if (w === 'unverified') return page(profilePage(key, false))
  return w
}

const honestControls = { netflix_in: 'verified', sonytvofficial: 'verified', marketingmentalist: 'unverified', chumbak_official: 'unverified' } as const

function useDoor(extra: Parameters<typeof setEmbedDoorForTests>[0] = {}): void {
  setEmbedDoorForTests({ fetch: fetchStub, now: () => clock, sleep: async (ms) => void (slept.push(ms), (clock += ms)), userAgent: 'test-agent', ...extra })
}

beforeEach(() => {
  clock = 1_800_000_000_000
  asked.length = 0
  slept.length = 0
  world = { ...honestControls }
  envBox.SEND_ENABLED = true
  settingsBox.value = { embedReads: true, embedTransport: 'curl', embedMaxPerHour: 40 }
  resetAnonGate()
  setAnonGateClock(() => clock)
  useDoor()
})

/** Make the proof once, so a case can be about one account. */
async function prove(): Promise<void> {
  world['warmup'] = 'verified'
  await readProfileEmbed('warmup')
  asked.length = 0
}

describe('the switch and the machine', () => {
  it('asks nothing while embed reads are switched off', async () => {
    settingsBox.value = { embedReads: false, embedTransport: 'curl', embedMaxPerHour: 40 }
    expect(await readProfileEmbed('somebrand')).toEqual({ kind: 'not-asked', why: 'switched-off' })
    expect(await readPostEmbed('Dcc4pQ8sX0N')).toEqual({ kind: 'not-asked', why: 'switched-off' })
    expect(asked).toEqual([])
  })

  it('asks nothing when the setting is absent — an old settings object must not switch it on', async () => {
    settingsBox.value = {}
    expect(await readProfileEmbed('somebrand')).toMatchObject({ kind: 'not-asked', why: 'switched-off' })
    expect(asked).toEqual([])
  })

  it('a switch that cannot be read is a switch that is off', async () => {
    settingsBox.value = new Error('database unreachable')
    expect(await readProfileEmbed('somebrand')).toMatchObject({ kind: 'not-asked', why: 'switched-off' })
    expect(asked).toEqual([])
  })

  it('never asks from a machine that may not send (the server), whatever the switch says', async () => {
    envBox.SEND_ENABLED = false
    expect(await readProfileEmbed('somebrand')).toEqual({ kind: 'not-asked', why: 'not-a-sending-machine' })
    expect(await readPostEmbed('Dcc4pQ8sX0N', { person: true })).toEqual({ kind: 'not-asked', why: 'not-a-sending-machine' })
    expect(asked).toEqual([])
  })

  it('a person previewing a post may ask with the switch off — and only that', async () => {
    settingsBox.value = { embedReads: false, embedTransport: 'curl', embedMaxPerHour: 40 }
    world['Dcc4pQ8sX0N'] = page('<div class="Caption"><a class="CaptionUsername" href="/pub/">pub</a> hi <a href="/brand_one/">@brand_one</a></div>')
    expect(await readPostEmbed('Dcc4pQ8sX0N', { person: true })).toMatchObject({ kind: 'read', mentions: ['brand_one'] })
    expect(await readProfileEmbed('somebrand')).toMatchObject({ kind: 'not-asked' })
  })
})

describe('the handle as written', () => {
  /** THE REVIEW'S ONE CONFIRMED HIGH: "@netflix_in..." gave the candidate "netflix_in..", read as @netflix_in. */
  it('a handle with trailing dots is not read as the handle without them — and nothing is asked', async () => {
    world['netflix_in'] = 'verified'
    for (const h of ['netflix_in..', 'netflix_in.', 'viralbhayani..', ' netflix_in. ']) {
      expect(await readProfileEmbed(h), h).toEqual({ kind: 'nothing', reason: 'not an Instagram handle as written', status: null })
    }
    expect(asked).toEqual([])
  })

  it('"@Name" in another letter case is the same handle as written', async () => {
    world['a_brand'] = 'verified'
    expect(await readProfileEmbed('@A_Brand')).toMatchObject({ kind: 'read', isVerified: true })
  })

  it('not a handle at all is nothing, with no request', async () => {
    expect(await readProfileEmbed('not a handle')).toMatchObject({ kind: 'nothing', reason: 'not an Instagram handle as written' })
    expect(asked).toEqual([])
  })
})

describe('the proof, before any badge is believed', () => {
  it('reads a verified control and an unverified control first, then the account asked', async () => {
    world['somebrand'] = 'verified'
    const r = await readProfileEmbed('@SomeBrand')
    expect(r).toMatchObject({ kind: 'read', isVerified: true, fullName: 'Name of somebrand', followers: 1234 })
    expect(asked).toEqual(['netflix_in', 'marketingmentalist', 'somebrand'])
  })

  it('a proof stands for twelve hours and is made again after that', async () => {
    world['a_brand'] = 'unverified'
    await readProfileEmbed('a_brand')
    asked.length = 0
    clock += EMBED_PROOF_MAX_AGE_MS - 60_000
    await readProfileEmbed('a_brand')
    expect(asked).toEqual(['a_brand'])
    asked.length = 0
    clock += 2 * 60_000
    await readProfileEmbed('a_brand')
    expect(asked).toEqual(['netflix_in', 'marketingmentalist', 'a_brand'])
  })

  /** THE DANGEROUS ONE: a page that says "verified" about every account would admit every candidate. */
  it('a door that reads verified for everybody fails the proof on the first unverified control, and asks nobody else', async () => {
    world = { netflix_in: 'verified', sonytvofficial: 'verified', marketingmentalist: 'verified', chumbak_official: 'verified', unverified_shop: 'verified' }
    const r = await readProfileEmbed('unverified_shop')
    expect(r).toMatchObject({ kind: 'refused', byUs: true, status: 429 })
    expect(r).not.toMatchObject({ kind: 'read' })
    if (r.kind === 'refused') expect(r.reason).toMatch(/marketingmentalist is held as NOT verified and read verified/)
    expect(asked).toEqual(['netflix_in', 'marketingmentalist'])
  })

  /** And its mirror: "not verified" about everybody would write a permanent refusal against every real lead. */
  it('a door that reads not-verified for everybody fails on the first verified control', async () => {
    world = { netflix_in: 'unverified', sonytvofficial: 'unverified', marketingmentalist: 'unverified', chumbak_official: 'unverified', real_brand: 'unverified' }
    const r = await readProfileEmbed('real_brand')
    expect(r).toMatchObject({ kind: 'refused', byUs: true })
    expect(asked).toEqual(['netflix_in'])
  })

  /** Review, 26 Nov: a contradiction is evidence of a broken reader before it is evidence of a stale label. */
  it('ONE control reading the opposite of what we hold fails the proof, even when the other of its kind reads right', async () => {
    world = { netflix_in: 'verified', sonytvofficial: 'verified', marketingmentalist: 'verified', chumbak_official: 'unverified', a_brand: 'verified' }
    expect(await readProfileEmbed('a_brand')).toMatchObject({ kind: 'refused', byUs: true })
    expect(asked).not.toContain('a_brand')
  })

  it('verified controls alone are not a proof: with no unverified control readable, nothing is believed', async () => {
    world = { netflix_in: 'verified', sonytvofficial: 'verified', a_brand: 'verified' }
    const r = await readProfileEmbed('a_brand')
    expect(r).toMatchObject({ kind: 'refused', byUs: true })
    expect(asked).not.toContain('a_brand')
  })

  it('a control that cannot be read is tolerated: the second of its kind is asked', async () => {
    world = { netflix_in: 'shell', sonytvofficial: 'verified', marketingmentalist: 'shell', chumbak_official: 'unverified', a_brand: 'verified' }
    expect(await readProfileEmbed('a_brand')).toMatchObject({ kind: 'read', isVerified: true })
    expect(asked).toEqual(['netflix_in', 'sonytvofficial', 'marketingmentalist', 'chumbak_official', 'a_brand'])
  })

  it('a door that serves empty shells proves nothing, and the account is never asked', async () => {
    world = {}
    expect(await readProfileEmbed('real_brand')).toMatchObject({ kind: 'refused', byUs: true })
    expect(asked).not.toContain('real_brand')
  })

  it('a failed proof is not retried for half an hour, costs no request meanwhile, and is still a refusal', async () => {
    world = {}
    await readProfileEmbed('real_brand')
    asked.length = 0
    clock += EMBED_PROOF_RETRY_MS - 60_000
    const meanwhile = await readProfileEmbed('real_brand')
    expect(meanwhile).toMatchObject({ kind: 'refused', byUs: true })
    expect(asked).toEqual([])
    clock += 2 * 60_000
    world = { ...honestControls, real_brand: 'verified' }
    expect(await readProfileEmbed('real_brand')).toMatchObject({ kind: 'read', isVerified: true })
  })

  it('a failed proof records nothing on Instagram’s gate — Instagram said nothing', async () => {
    world = {}
    await readProfileEmbed('real_brand')
    expect(anonGateCheck('embed').ok).toBe(true)
  })

  it('Instagram refusing during the proof is a refusal by Instagram, and closes the door', async () => {
    world['netflix_in'] = { kind: 'page', status: 429, body: '{"message":"Please wait"}', contentType: 'application/json', hops: 0, capped: false }
    const r = await readProfileEmbed('a_brand')
    expect(r).toMatchObject({ kind: 'refused', status: 429, byUs: false })
    expect(anonGateCheck('embed').ok).toBe(false)
    expect(asked).toEqual(['netflix_in'])
  })

  it('a control sent to the login page closes the door — a control is never confirmed against itself', async () => {
    world['netflix_in'] = LOGIN
    const r = await readProfileEmbed('a_brand')
    expect(r).toMatchObject({ kind: 'refused', status: 302, byUs: false })
    expect(anonGateCheck('embed').ok).toBe(false)
    expect(asked).toEqual(['netflix_in'])
  })
})

describe('what is never a verdict', () => {
  beforeEach(prove)

  it('a page with no data for the handle is nothing — a missing, gated or shell page look alike', async () => {
    const r = await readProfileEmbed('qqqq_nope_nope_12345')
    expect(r).toMatchObject({ kind: 'nothing', status: null })
    expect(anonGateCheck('embed').ok).toBe(true)
  })

  it('a page whose own data says both is nothing', async () => {
    world['mixed'] = page(`<script type="application/json">${JSON.stringify([{ username: 'mixed', is_verified: true }, { username: 'mixed', is_verified: false }])}</script>`)
    expect((await readProfileEmbed('mixed')).kind).toBe('nothing')
  })

  it('an odd status and an off-site redirect are nothing, and do not close the door', async () => {
    world['a'] = { kind: 'page', status: 404, body: 'nope', contentType: 'text/html', hops: 0, capped: false }
    world['c'] = { kind: 'redirect-refused', status: 302, location: 'https://evil.example/' }
    expect(await readProfileEmbed('a')).toMatchObject({ kind: 'nothing', status: 404 })
    expect(await readProfileEmbed('c')).toMatchObject({ kind: 'nothing' })
    expect(anonGateCheck('embed').ok).toBe(true)
  })

  it('a page longer than the cap is nothing — a cut page can lose the object the verdict needs', async () => {
    world['big'] = { kind: 'page', status: 200, body: profilePage('big', true), contentType: 'text/html', hops: 0, capped: true }
    expect(await readProfileEmbed('big')).toMatchObject({ kind: 'nothing' })
  })
})

describe('one key is not the host (point 4)', () => {
  beforeEach(prove)

  const keyFailures: Array<[string, EmbedAnswer]> = [
    ['sent to the login page', LOGIN],
    ['a login page served as a 200', page(loginPage)],
    ['no answer', { kind: 'no-answer', error: 'timed out after 25000 ms' }],
    ['a 503', { kind: 'page', status: 503, body: 'busy', contentType: 'text/html', hops: 0, capped: false }],
  ]

  it.each(keyFailures)('%s for ONE account while a control answers is that account’s, and the door stays open', async (_n, answer) => {
    world['gatedco'] = answer
    world['nextco'] = 'verified'
    const r = await readProfileEmbed('gatedco')
    expect(r.kind).toBe('nothing')
    if (r.kind === 'nothing') expect(r.reason).toMatch(/for this one only/)
    // the control was asked to tell the two apart
    expect(asked).toEqual(['gatedco', 'netflix_in'])
    expect(anonGateCheck('embed').ok).toBe(true)
    // and the next account is read at once: nothing is wedged
    expect(await readProfileEmbed('nextco')).toMatchObject({ kind: 'read', isVerified: true })
  })

  it('a login page for an account, with the control refused too, is the door: it closes', async () => {
    world['gatedco'] = LOGIN
    world['netflix_in'] = LOGIN
    const r = await readProfileEmbed('gatedco')
    expect(r).toMatchObject({ kind: 'refused', byUs: false })
    expect(anonGateCheck('embed').ok).toBe(false)
  })

  it('no answer for an account, with no answer from the control either, halts without blaming either', async () => {
    world['slowco'] = { kind: 'no-answer', error: 'timed out' }
    world['netflix_in'] = { kind: 'no-answer', error: 'timed out' }
    const r = await readProfileEmbed('slowco')
    expect(r).toMatchObject({ kind: 'refused', byUs: true, status: 429 })
    // Instagram said nothing: the gate is not closed, and the next pass simply asks again
    expect(anonGateCheck('embed').ok).toBe(true)
  })

  it('a key failure with a control that cannot be read halts — nobody is blamed', async () => {
    world['gatedco'] = LOGIN
    world['netflix_in'] = 'shell'
    expect(await readProfileEmbed('gatedco')).toMatchObject({ kind: 'refused', byUs: true })
    expect(anonGateCheck('embed').ok).toBe(true)
  })

  it('a 429 or 401 is never confirmed: being told to stop is not asked about twice', async () => {
    for (const status of [429, 401]) {
      resetAnonGate()
      asked.length = 0
      world['k'] = { kind: 'page', status, body: '', contentType: null, hops: 0, capped: false }
      expect(await readProfileEmbed('k')).toMatchObject({ kind: 'refused', status, byUs: false })
      expect(asked).toEqual(['k'])
      expect(anonGateCheck('embed').ok).toBe(false)
    }
  })

  it('a 403 saying require_login is the door; one that does not is that account’s answer', async () => {
    world['gated'] = { kind: 'page', status: 403, body: 'forbidden', contentType: 'text/html', hops: 0, capped: false }
    expect(await readProfileEmbed('gated')).toMatchObject({ kind: 'nothing', status: 403 })
    expect(anonGateCheck('embed').ok).toBe(true)
    world['walled'] = { kind: 'page', status: 403, body: '{"require_login":true}', contentType: 'application/json', hops: 0, capped: false }
    expect(await readProfileEmbed('walled')).toMatchObject({ kind: 'refused', byUs: false })
    expect(anonGateCheck('embed').ok).toBe(false)
  })

  it('while the door is closed nothing is asked, and it reopens after the cooldown', async () => {
    world['k'] = { kind: 'page', status: 429, body: '', contentType: null, hops: 0, capped: false }
    world['next_one'] = 'verified'
    await readProfileEmbed('k')
    asked.length = 0
    expect(await readProfileEmbed('next_one')).toMatchObject({ kind: 'refused', status: 429, byUs: false })
    expect(asked).toEqual([])
    clock += 16 * 60_000
    expect(await readProfileEmbed('next_one')).toMatchObject({ kind: 'read', isVerified: true })
  })

  it('a refused embed door leaves the feed and profile doors alone', async () => {
    world['victim'] = { kind: 'page', status: 429, body: '', contentType: null, hops: 0, capped: false }
    await readProfileEmbed('victim')
    expect(anonGateCheck('embed').ok).toBe(false)
    expect(anonGateCheck('feed').ok).toBe(true)
    expect(anonGateCheck('profile').ok).toBe(true)
  })

  /** The direction that matters: the profile endpoint is STILL refusing; a served embed page must not reopen it. */
  it('an embed page that answers never reopens a profile door Instagram is refusing', async () => {
    anonGateRecordThrottle('profile', 401)
    anonGateRecordThrottle('feed', 401)
    world['a_brand'] = 'verified'
    expect(await readProfileEmbed('a_brand')).toMatchObject({ kind: 'read' })
    expect(anonGateCheck('profile').ok).toBe(false)
    expect(anonGateCheck('feed').ok).toBe(false)
  })
})

describe('the hourly ceiling and the spacing are this Mac’s (point 5)', () => {
  it('stops at the ceiling without asking, says it is OURS, and says when it lifts', async () => {
    useDoor({ maxPerHour: 5 })
    for (const h of ['a', 'b', 'c']) world[h] = 'verified'
    const first = clock
    expect((await readProfileEmbed('a')).kind).toBe('read') // 2 proof + 1
    expect((await readProfileEmbed('b')).kind).toBe('read') // 4
    expect((await readProfileEmbed('c')).kind).toBe('read') // 5
    const full = await readProfileEmbed('a')
    expect(full).toMatchObject({ kind: 'refused', status: 429, byUs: true })
    if (full.kind === 'refused') {
      expect(full.reason).toMatch(/our own ceiling/)
      expect(full.until.getTime()).toBeGreaterThanOrEqual(first + 60 * 60_000)
    }
    expect(embedRequestsMade()).toBe(5)
    // Our own ceiling is not Instagram refusing: the gate stays open.
    expect(anonGateCheck('embed').ok).toBe(true)
    clock += 61 * 60_000
    expect((await readProfileEmbed('a')).kind).toBe('read')
  })

  it('reads the ceiling from the setting', async () => {
    settingsBox.value = { embedReads: true, embedTransport: 'curl', embedMaxPerHour: 3 }
    world['a'] = 'verified'
    expect((await readProfileEmbed('a')).kind).toBe('read') // 3 requests
    expect(await readProfileEmbed('a')).toMatchObject({ kind: 'refused', byUs: true })
    expect(embedRequestsMade()).toBe(3)
  })

  it('never makes two requests closer than the spacing', async () => {
    world['a'] = 'verified'
    await readProfileEmbed('a')
    expect(slept.length).toBe(2)
    for (const ms of slept) expect(ms).toBe(EMBED_SPACING_MS)
  })

  /**
   * Review, 26 Nov: the ceiling was per PROCESS, so the agent and a person's command beside it each had 40 an hour
   * from one home address. Two separate module instances — the agent and a CLI — now share one file.
   */
  it('two processes on one Mac share one ceiling and one spacing through the ledger file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ds-embed-ledger-'))
    const file = join(dir, 'embed-requests.json')
    try {
      vi.resetModules()
      const agentDoor = await import('@/detection/embedDoor')
      vi.resetModules()
      const cliDoor = await import('@/detection/embedDoor')
      expect(agentDoor).not.toBe(cliDoor)
      const stubSleeps: number[] = []
      const common = { fetch: fetchStub, now: () => clock, sleep: async (ms: number) => void (stubSleeps.push(ms), (clock += ms)), userAgent: 'test-agent', maxPerHour: 6 }
      agentDoor.setEmbedDoorForTests({ ...common, ledger: agentDoor.embedFileLedgerForTests(file) })
      cliDoor.setEmbedDoorForTests({ ...common, ledger: cliDoor.embedFileLedgerForTests(file) })
      world['DcPOSTone01'] = page('<div class="Caption"><a class="CaptionUsername" href="/pub/">pub</a> launch day for the new range</div>')
      for (let i = 0; i < 4; i++) expect((await agentDoor.readPostEmbed('DcPOSTone01')).kind).toBe('read')
      // the CLI sees the agent's four: it may make two more, and its first waits out the agent's last
      stubSleeps.length = 0
      expect((await cliDoor.readPostEmbed('DcPOSTone01')).kind).toBe('read')
      expect(stubSleeps).toEqual([EMBED_SPACING_MS])
      expect((await cliDoor.readPostEmbed('DcPOSTone01')).kind).toBe('read')
      expect(await cliDoor.readPostEmbed('DcPOSTone01')).toMatchObject({ kind: 'refused', byUs: true })
      expect(await agentDoor.readPostEmbed('DcPOSTone01')).toMatchObject({ kind: 'refused', byUs: true })
      const saved = JSON.parse(readFileSync(file, 'utf8')) as { at: number[] }
      expect(saved.at).toHaveLength(6)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('a ledger file that cannot be read never stops a read: this process’s own memory stands in', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ds-embed-ledger-'))
    try {
      // a DIRECTORY where the file should be: unreadable as a file, unwritable as one
      useDoor({ maxPerHour: 4, ledger: door.embedFileLedgerForTests(dir) })
      world['a'] = 'verified'
      expect((await readProfileEmbed('a')).kind).toBe('read') // 3
      expect((await readProfileEmbed('a')).kind).toBe('read') // 4
      expect(await readProfileEmbed('a')).toMatchObject({ kind: 'refused', byUs: true })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('a time in the ledger far in the future is a clock that moved, not a request', async () => {
    const ledger = { at: [clock + 10 * 60 * 60_000, clock + 10 * 60 * 60_000], read() { return this.at }, write(v: number[]) { this.at = v } }
    useDoor({ maxPerHour: 2, ledger })
    world['DcPOSTone01'] = page('<div class="Caption"><a class="CaptionUsername" href="/pub/">pub</a> launch day for the new range</div>')
    expect((await readPostEmbed('DcPOSTone01')).kind).toBe('read')
  })

  it('re-reads the gate’s recorded cooldown at most every five minutes, so another process’s refusal is seen', async () => {
    const hydrate = vi.fn(async () => undefined)
    useDoor({ hydrate })
    world['DcPOSTone01'] = page('<div class="Caption"><a class="CaptionUsername" href="/pub/">pub</a> launch day for the new range</div>')
    await readPostEmbed('DcPOSTone01')
    await readPostEmbed('DcPOSTone01')
    expect(hydrate).toHaveBeenCalledTimes(1)
    clock += 5 * 60_000 + 1
    await readPostEmbed('DcPOSTone01')
    expect(hydrate).toHaveBeenCalledTimes(2)
  })
})

describe('the post door', () => {
  const caption = '<div class="Caption"><a class="CaptionUsername" href="https://www.instagram.com/publisher_one/">publisher_one</a> Launch with <a href="https://www.instagram.com/brand.one/">@brand.one</a> today</div>'

  it('returns the linked mentions, the owner, the caption text and whether the read was whole — with no proof needed', async () => {
    world['DcyE65LPYMj'] = page(caption)
    const r = await readPostEmbed('DcyE65LPYMj')
    expect(r).toMatchObject({ kind: 'read', owner: 'publisher_one', mentions: ['brand.one'], unlinkedAt: [], closed: true })
    if (r.kind === 'read') expect(r.captionText).toContain('Launch with @brand.one today')
    expect(asked).toEqual(['DcyE65LPYMj'])
  })

  it('a page with no caption is nothing and leaves the door open', async () => {
    world['PNOCAP01'] = page('<div class="Embed">This post is unavailable</div>')
    expect(await readPostEmbed('PNOCAP01')).toMatchObject({ kind: 'nothing' })
    expect(anonGateCheck('embed').ok).toBe(true)
  })

  it('a login page for one post, with a control answering, is that post’s; with the control refused too, the door’s', async () => {
    world['PWALL001'] = page(loginPage)
    expect(await readPostEmbed('PWALL001')).toMatchObject({ kind: 'nothing' })
    expect(anonGateCheck('embed').ok).toBe(true)
    world['netflix_in'] = page(loginPage)
    expect(await readPostEmbed('PWALL001')).toMatchObject({ kind: 'refused', byUs: false })
    expect(anonGateCheck('embed').ok).toBe(false)
  })

  it('refuses something that is not a shortcode without asking', async () => {
    expect(await readPostEmbed('../etc')).toMatchObject({ kind: 'nothing', reason: 'not a post shortcode' })
    expect(asked).toEqual([])
  })
})
