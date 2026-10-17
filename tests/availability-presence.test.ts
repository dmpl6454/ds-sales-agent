import { describe, it, expect, afterAll } from 'vitest'
import { openOutreachDb, seedSender, senderId, setSetting } from './helpers/outreach-db'

/**
 * AN ACCOUNT NO ONLINE MAC HOLDS IS NOT ELECTABLE (17 October 2026).
 *
 * The live wedge: @bollywoodchronicle's only Chrome profile was on a Mac that no longer exists,
 * its row still read ACTIVE with a recorded session, and rotation went on electing it — 147
 * undeliverable first touches filled the fleet-wide waiting depth and nothing sent for a day.
 * `readSenderAvailability` now asks the shared `devicePresence` row which accounts a Mac seen in
 * the last 72 hours holds. These pin the rule in both directions, and above all the one that
 * keeps the rule from becoming an outage: NO WITNESS MEANS NO CHANGE.
 */

const db = await openOutreachDb('availability-presence')
const { prisma } = await import('@/lib/db')
const {
  readSenderAvailability,
  eligibleFleetSenders,
  onlineSessionHolders,
  sessionHolderVerdict,
  SESSION_HOLDER_WINDOW_MS,
  NOT_HELD_BY_AN_ONLINE_MAC,
  mergeHolderHistory,
  parseHolderHistory,
  recordSessionHolderHistory,
} = await import('@/outreach/availability')

afterAll(async () => {
  await db.close(prisma)
})

const NOW = Date.parse('2026-10-17T00:10:00.000Z')
const ago = (ms: number) => new Date(NOW - ms).toISOString()
const HOUR = 3_600_000

describe('sessionHolderVerdict — PURE', () => {
  const studio = { device: 'DMPLs Mac Studio', at: ago(60_000), handles: ['bollywoodpaparazzii', 'totalfilmii'] }
  const gone = { device: 'tabish-mac', at: ago(30 * 24 * HOUR), handles: ['bollywoodchronicle', 'totalfilmii'] }

  it('an entry within the window that lists the handle → held', () => {
    expect(sessionHolderVerdict([studio, gone], 'totalfilmii', NOW)).toBe('held')
  })

  it('listed only by an entry older than the window → not held', () => {
    expect(sessionHolderVerdict([studio, gone], 'bollywoodchronicle', NOW)).toBe('not-held')
  })

  it('listed by no entry → not held', () => {
    expect(sessionHolderVerdict([studio], 'madaboutmarketingg', NOW)).toBe('not-held')
  })

  it('the window edge: exactly 72 h is still held, a millisecond past it is not', () => {
    const edge = (ms: number) => [{ device: 'm', at: ago(ms), handles: ['x'] }]
    expect(sessionHolderVerdict(edge(SESSION_HOLDER_WINDOW_MS), 'x', NOW)).toBe('held')
    expect(sessionHolderVerdict(edge(SESSION_HOLDER_WINDOW_MS + 1), 'x', NOW)).toBe('not-held')
  })

  it('a row with no usable entry is NO WITNESS — the rule is inert, never "nobody holds anything"', () => {
    expect(sessionHolderVerdict([], 'x', NOW)).toBe('no-witness')
    expect(sessionHolderVerdict([null, 7, 'x', { device: 'm', at: ago(0) }], 'x', NOW)).toBe('no-witness')
    expect(onlineSessionHolders([{ device: 'm', at: ago(0), handles: 'x' }], NOW)).toBeNull()
  })

  it('a witness whose every entry is stale is still a witness — every account is then not held', () => {
    expect(sessionHolderVerdict([gone], 'totalfilmii', NOW)).toBe('not-held')
  })

  it('is case-insensitive both ways', () => {
    const e = [{ device: 'm', at: ago(0), handles: ['TotalFilmii'] }]
    expect(sessionHolderVerdict(e, 'totalfilmii', NOW)).toBe('held')
    expect(sessionHolderVerdict(e, 'TOTALFILMII', NOW)).toBe('held')
  })

  it('an entry missing handles is ignored; an entry beside it still witnesses', () => {
    const entries = [{ device: 'old-agent', at: ago(0) }, { device: 'm', at: ago(0), handles: ['a'] }]
    expect(sessionHolderVerdict(entries, 'a', NOW)).toBe('held')
    expect(sessionHolderVerdict(entries, 'b', NOW)).toBe('not-held')
  })

  it('an unparseable date is not recent; non-string handles are skipped', () => {
    expect(sessionHolderVerdict([{ device: 'm', at: 'yesterday-ish', handles: ['a'] }], 'a', NOW)).toBe('not-held')
    expect(sessionHolderVerdict([{ device: 'm', at: ago(0), handles: [null, 3, 'a'] }], 'a', NOW)).toBe('held')
  })
})

/**
 * THE WINDOW IS PER HANDLE (review, 17 Oct). A live Mac rewrites its own entry every 30 s, so an
 * entry's `at` is always fresh and its `handles` carries no history — keyed on the entry alone, ONE
 * beat listing fewer handles (a fail-closed cookie read on a full disk) or a twin's entry pruned by
 * `mergePresence` removed accounts at once, and the planner released their queue on that snapshot.
 */
describe('the per-handle history — PURE', () => {
  it('a FRESH entry that briefly lists no handles does not un-hold what the history saw an hour ago', () => {
    const blip = [{ device: 'DMPLs Mac Studio', at: ago(10_000), handles: [] }]
    const history = { bollywoodpaparazzii: ago(HOUR), totalfilmii: ago(15 * 60_000) }
    expect(sessionHolderVerdict(blip, 'bollywoodpaparazzii', NOW, history)).toBe('held')
    expect(sessionHolderVerdict(blip, 'totalfilmii', NOW, history)).toBe('held')
    /* …and without the history it is exactly the defect the review found. */
    expect(sessionHolderVerdict(blip, 'bollywoodpaparazzii', NOW)).toBe('not-held')
  })

  it('a shrunken list keeps the dropped handle held while the history is inside the window', () => {
    const partial = [{ device: 'm', at: ago(5_000), handles: ['a'] }]
    expect(sessionHolderVerdict(partial, 'b', NOW, { b: ago(SESSION_HOLDER_WINDOW_MS - 1) })).toBe('held')
    expect(sessionHolderVerdict(partial, 'b', NOW, { b: ago(SESSION_HOLDER_WINDOW_MS + 1) })).toBe('not-held')
  })

  it('a same-name twin whose entry mergePresence pruned stays held from the history', async () => {
    const { mergePresence } = await import('@/outreach/devicePresence')
    const twinB = { device: 'Studio', host: 'host-b', at: ago(3 * 60_000), handles: ['twinb_page'] }
    const twinA = { device: 'Studio', host: 'host-a', at: ago(0), handles: ['twina_page'] }
    const merged = mergePresence([twinB], twinA, NOW)
    expect(merged.some((d) => d.host === 'host-b')).toBe(false) // pruned, as designed
    const history = mergeHolderHistory(null, [twinB], NOW - 60_000) // the planner saw B a pass ago
    expect(sessionHolderVerdict(merged, 'twinb_page', NOW, history)).toBe('held')
    expect(sessionHolderVerdict(merged, 'twinb_page', NOW)).toBe('not-held')
  })

  it('merge keeps the LATEST time per handle, lower-cases, clamps a future date, and prunes past the window', () => {
    const out = mergeHolderHistory(
      { a: ago(2 * HOUR), old: ago(SESSION_HOLDER_WINDOW_MS + HOUR) },
      [
        { device: 'm', at: ago(HOUR), handles: ['A', 'b'] },
        { device: 'fast-clock', at: new Date(NOW + 10 * HOUR).toISOString(), handles: ['c'] },
        { device: 'm2', at: ago(3 * HOUR), handles: ['a'] },
      ],
      NOW,
    )
    expect(out).toEqual({ a: ago(HOUR), b: ago(HOUR), c: ago(0) })
  })

  it('the history never makes the rule fire where the presence row is no witness', () => {
    expect(sessionHolderVerdict([], 'a', NOW, { b: ago(0) })).toBe('no-witness')
  })

  it('parse: absent or unreadable is null — never a guess', () => {
    expect(parseHolderHistory(undefined)).toBeNull()
    expect(parseHolderHistory('{nope')).toBeNull()
    expect(parseHolderHistory('[]')).toBeNull()
    expect(parseHolderHistory(JSON.stringify({ A: ago(0), b: 7, c: 'not a date' }))).toEqual({ a: ago(0) })
  })
})

describe('readSenderAvailability — against a real database', () => {
  it('seeds three accounts, every one ACTIVE with a recorded hand login', async () => {
    for (const handle of ['alpha', 'bravo', 'charlie']) await seedSender(prisma, { handle })
  })

  it('with NO presence row nothing changes — the legacy deployment, and every other test in the suite', async () => {
    const unavailable = await readSenderAvailability(NOW)
    expect(unavailable.size).toBe(0)
    expect((await eligibleFleetSenders()).map((s) => s.handle).sort()).toEqual(['alpha', 'bravo', 'charlie'])
  })

  it('an unparseable presence row is no witness either', async () => {
    await setSetting(prisma, 'devicePresence', '{not json')
    expect((await readSenderAvailability(NOW)).size).toBe(0)
  })

  it('the Studio lists alpha and bravo; charlie is held only by a Mac gone for a month → unavailable, with the sentence', async () => {
    await setSetting(
      prisma,
      'devicePresence',
      JSON.stringify([
        { device: 'tabish-mac', at: ago(30 * 24 * HOUR), handles: ['alpha', 'bravo', 'charlie'] },
        { device: 'DMPLs Mac Studio', at: ago(45_000), handles: ['alpha', 'BRAVO'] },
      ]),
    )
    const unavailable = await readSenderAvailability(NOW)
    expect(unavailable.get(senderId('charlie'))).toBe(NOT_HELD_BY_AN_ONLINE_MAC)
    expect(unavailable.has(senderId('alpha'))).toBe(false)
    expect(unavailable.has(senderId('bravo'))).toBe(false)
  })

  it('the ring rule counts only pages a live Mac holds', async () => {
    const real = Date.now
    Date.now = () => NOW
    try {
      expect((await eligibleFleetSenders()).map((s) => s.handle).sort()).toEqual(['alpha', 'bravo'])
    } finally {
      Date.now = real
    }
  })

  it('a more specific cause is named first — a signed-out account no Mac holds reads "logged out", not the presence sentence', async () => {
    await prisma.senderAccount.update({ where: { id: senderId('charlie') }, data: { sessionInvalidAt: new Date(NOW) } })
    expect((await readSenderAvailability(NOW)).get(senderId('charlie'))).toBe('logged out — needs signing in again')
  })
})

describe('recordSessionHolderHistory — the planner, once a pass', () => {
  it('reports hadHistory=false on the first read, writes the seed, and true thereafter', async () => {
    await prisma.senderAccount.update({ where: { id: senderId('charlie') }, data: { sessionInvalidAt: null } })
    await prisma.setting.deleteMany({ where: { key: 'sessionHolderSeen' } })
    await setSetting(prisma, 'devicePresence', JSON.stringify([{ device: 'DMPLs Mac Studio', at: ago(30_000), handles: ['alpha', 'bravo'] }]))
    expect(await recordSessionHolderHistory(NOW)).toEqual({ hadHistory: false })
    const seeded = JSON.parse((await prisma.setting.findUniqueOrThrow({ where: { key: 'sessionHolderSeen' } })).value)
    expect(Object.keys(seeded).sort()).toEqual(['alpha', 'bravo'])
    expect(await recordSessionHolderHistory(NOW + 60_000)).toEqual({ hadHistory: true })
  })

  it('a later beat that lists nothing does not un-hold an account the history saw', async () => {
    await setSetting(prisma, 'devicePresence', JSON.stringify([{ device: 'DMPLs Mac Studio', at: ago(-120_000), handles: [] }]))
    const unavailable = await readSenderAvailability(NOW + 120_000)
    expect(unavailable.has(senderId('alpha'))).toBe(false)
    expect(unavailable.has(senderId('bravo'))).toBe(false)
    expect(unavailable.get(senderId('charlie'))).toBe(NOT_HELD_BY_AN_ONLINE_MAC)
  })

  it('writes nothing when the presence row is no witness', async () => {
    await prisma.setting.deleteMany({ where: { key: { in: ['sessionHolderSeen', 'devicePresence'] } } })
    expect(await recordSessionHolderHistory(NOW)).toEqual({ hadHistory: false })
    expect(await prisma.setting.findUnique({ where: { key: 'sessionHolderSeen' } })).toBeNull()
  })
})
