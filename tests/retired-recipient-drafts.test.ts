import { describe, it, expect, vi, afterAll, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  openOutreachDb,
  seedSender,
  seedTarget,
  seedPair,
  seedVariants,
  seedDraft,
  seedPark,
  seedDelivery,
  setSetting,
  senderId,
  targetId,
} from './helpers/outreach-db'

/**
 * DRAFTS TO A RETIRED RECIPIENT ARE DISCARDED — by the planner's sweep and by every retirement
 * path (26 Oct 2026), against a real database and the real `runOutreach`.
 *
 * Measured on the Mac Studio, 19–22 Oct: ~7,000 "waiting message held back … this recipient is
 * retired" lines a day — drafts to companies retired weeks earlier (@hemantpandeyji, 9 Sept),
 * re-asked of the gate every 30 seconds, never removed, and each touch-1 brand draft holding a
 * slot of the fleet-wide waiting depth. This file proves the sweep discards exactly that class
 * (READY and QUEUED to an `optedOut` recipient) and nothing else, that the planner runs it BEFORE
 * the depth is read (so the freed slot is written in the same pass), and that each retirement
 * path calls it.
 */

vi.mock('@/detection/igHttp', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/detection/igHttp')>()),
  igGet: async () => {
    throw new Error('retired-drafts: igGet reached the network')
  },
}))
vi.mock('@/detection/enrichHandle', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/detection/enrichHandle')>()),
  enrichHandle: async () => {
    throw new Error('retired-drafts: enrichHandle reached the network')
  },
}))
vi.mock('@/outreach/generate', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/outreach/generate')>()),
  generateMessageBody: async () => {
    throw new Error('retired-drafts: generateMessageBody reached the network')
  },
}))
vi.mock('@/outreach/browser/profile', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/outreach/browser/profile')>()),
  profileStatus: (handle: string) => ({ handle, dir: `/tmp/profiles/${handle}`, initialised: true, hasSession: true }),
}))
vi.stubGlobal('fetch', () => {
  throw new Error('retired-drafts: global fetch reached the network')
})

process.env.DRY_RUN = 'false'
process.env.MAX_TOTAL_SENDS = 'unlimited'
process.env.DEFAULT_COOLDOWN_DAYS = '7'
process.env.HOOK_MAX_AGE_HOURS = '72'
process.env.MAX_PER_PAIR_PER_DAY = '5'
process.env.AUTOPILOT_ENABLED = 'false'
process.env.SEND_ENABLED = 'true'
process.env.DETECTION_CUTOFF = ''

const db = await openOutreachDb('retired-drafts')
const ANCHOR = new Date('2026-10-26T06:00:00.000Z')
vi.setSystemTime(ANCHOR)

const { prisma } = await import('@/lib/db')
const { runOutreach } = await import('@/outreach/plan')
const { SINGLE_TEMPLATE_MIDDLE } = await import('@/outreach/fleetTemplate')
const { discardWaitingDraftsToRetiredRecipients, RETIRED_RECIPIENT_DISCARD_REASON } = await import(
  '@/outreach/retiredRecipientDrafts'
)
const { removeTargetResult } = await import('@/app/remove-target-message')

afterAll(async () => {
  vi.useRealTimers()
  await db.close(prisma)
})

const h = (hours: number) => new Date(ANCHOR.getTime() - hours * 3_600_000)
const ALPHA = senderId('alpha')

async function wipe(): Promise<void> {
  await prisma.auditLog.deleteMany({})
  await prisma.dailyReservation.deleteMany({})
  await prisma.outreachAttempt.deleteMany({})
  await prisma.outreachPair.deleteMany({})
  await prisma.messageVariant.deleteMany({})
  await prisma.targetAccount.deleteMany({})
  await prisma.senderAccount.deleteMany({})
  await prisma.setting.deleteMany({})
}

const statusOf = async (id: string) => (await prisma.outreachAttempt.findUniqueOrThrow({ where: { id } })).status

describe('discardWaitingDraftsToRetiredRecipients — what it touches', () => {
  type Row = 'ready' | 'queued' | 'sending' | 'nit' | 'parked' | 'sent' | 'gone2' | 'live'
  const ids = {} as Record<Row, string>

  beforeEach(async () => {
    await wipe()
    await seedSender(prisma, { handle: 'alpha' })
    await seedVariants(prisma, ALPHA)
    await seedTarget(prisma, { handle: 'gone', optedOut: true })
    await seedTarget(prisma, { handle: 'gone2', optedOut: true })
    await seedTarget(prisma, { handle: 'live' })
    const gone = (await seedPair(prisma, ALPHA, targetId('gone'))).id
    const gone2 = (await seedPair(prisma, ALPHA, targetId('gone2'))).id
    const live = (await seedPair(prisma, ALPHA, targetId('live'))).id

    ids.ready = (await seedDraft(prisma, { pairId: gone, status: 'READY', touchNumber: 1, body: SINGLE_TEMPLATE_MIDDLE, queuedAt: h(900) })).id
    ids.queued = (await seedDraft(prisma, { pairId: gone, status: 'QUEUED', touchNumber: 2, body: 'a follow-up', queuedAt: h(800) })).id
    ids.sending = (await seedDraft(prisma, { pairId: gone, status: 'SENDING', touchNumber: 1, body: 'mid-paste', queuedAt: h(700) })).id
    ids.nit = (await seedPark(prisma, { pairId: gone, failureCode: 'not-in-thread', queuedAt: h(600) })).id
    ids.parked = (await seedPark(prisma, { pairId: gone, failureCode: 'no-composer', queuedAt: h(500) })).id
    ids.sent = (await seedDelivery(prisma, { pairId: gone, sentAt: h(400), touchNumber: 1, body: 'delivered once' })).id
    ids.gone2 = (await seedDraft(prisma, { pairId: gone2, status: 'READY', touchNumber: 1, body: SINGLE_TEMPLATE_MIDDLE, queuedAt: h(300) })).id
    ids.live = (await seedDraft(prisma, { pairId: live, status: 'READY', touchNumber: 1, body: SINGLE_TEMPLATE_MIDDLE, queuedAt: h(200) })).id
  })

  it('discards READY and QUEUED drafts to retired recipients, each with an audit row naming why', async () => {
    const r = await discardWaitingDraftsToRetiredRecipients({ actor: 'planner' })
    expect(r.discarded).toBe(3)
    expect(r.byRecipient.sort((a, b) => a.handle.localeCompare(b.handle))).toEqual([
      { handle: 'gone', count: 2 },
      { handle: 'gone2', count: 1 },
    ])
    for (const k of ['ready', 'queued', 'gone2'] as const) expect(await statusOf(ids[k])).toBe('SKIPPED')
    const audits = await prisma.auditLog.findMany({ where: { action: 'attempt.skipped' } })
    expect(audits.map((a) => a.entity).sort()).toEqual(
      [ids.ready, ids.queued, ids.gone2].map((id) => `OutreachAttempt:${id}`).sort(),
    )
    for (const a of audits) {
      expect(a.actor).toBe('planner')
      expect(a.detail).toBe(RETIRED_RECIPIENT_DISCARD_REASON)
    }
    /* The body stays on the row: discarding is not erasing. */
    expect((await prisma.outreachAttempt.findUniqueOrThrow({ where: { id: ids.ready } })).renderedBody).toBe(SINGLE_TEMPLATE_MIDDLE)
  })

  it('never touches a send in flight, a parked failure, a delivery, or a draft to a recipient who is not retired', async () => {
    await discardWaitingDraftsToRetiredRecipients({ actor: 'planner' })
    expect(await statusOf(ids.sending)).toBe('SENDING')
    expect(await statusOf(ids.nit)).toBe('FAILED')
    expect(await statusOf(ids.parked)).toBe('FAILED')
    expect(await statusOf(ids.sent)).toBe('SENT')
    expect(await statusOf(ids.live)).toBe('READY')
  })

  it('narrowed to the recipients a retirement path just retired, it leaves every other one alone', async () => {
    const r = await discardWaitingDraftsToRetiredRecipients({ actor: 'cli:Tabish', targetIds: [targetId('gone2')] })
    expect(r.discarded).toBe(1)
    expect(await statusOf(ids.gone2)).toBe('SKIPPED')
    expect(await statusOf(ids.ready)).toBe('READY')
    expect(await statusOf(ids.queued)).toBe('QUEUED')
  })

  it('narrowed to a recipient who is NOT retired, it discards nothing — retirement is read from the row, never assumed', async () => {
    const r = await discardWaitingDraftsToRetiredRecipients({ actor: 'cli:Tabish', targetIds: [targetId('live')] })
    expect(r.discarded).toBe(0)
    expect(await statusOf(ids.live)).toBe('READY')
  })

  it('an empty narrowing is a no-op, not "every recipient"', async () => {
    const r = await discardWaitingDraftsToRetiredRecipients({ actor: 'planner', targetIds: [] })
    expect(r.discarded).toBe(0)
    expect(await statusOf(ids.ready)).toBe('READY')
  })

  it('is idempotent: a second sweep finds nothing', async () => {
    await discardWaitingDraftsToRetiredRecipients({ actor: 'planner' })
    const again = await discardWaitingDraftsToRetiredRecipients({ actor: 'planner' })
    expect(again.discarded).toBe(0)
    expect(await prisma.auditLog.count({ where: { action: 'attempt.skipped' } })).toBe(3)
  })
})

describe('the planner sweeps them BEFORE it reads the waiting depth', () => {
  it('a stale draft to a retired brand that fills the depth is discarded, and the same pass writes the live recipient', async () => {
    await wipe()
    await seedSender(prisma, { handle: 'alpha' })
    await seedVariants(prisma, ALPHA)
    /* Depth 1, and it is full — of a draft that can never be sent. */
    await setSetting(prisma, 'maxWaitingNewBrandDrafts', '1')
    await seedTarget(prisma, { handle: 'aaa_retired', optedOut: true })
    await seedTarget(prisma, { handle: 'zzz_live' })
    const stale = (
      await seedDraft(prisma, {
        pairId: (await seedPair(prisma, ALPHA, targetId('aaa_retired'))).id,
        status: 'READY',
        touchNumber: 1,
        body: SINGLE_TEMPLATE_MIDDLE,
        queuedAt: h(24 * 47),
      })
    ).id

    const summary = await runOutreach()

    expect(await statusOf(stale)).toBe('SKIPPED')
    /* By sender and recipient: `ensureFleetPairs` creates this route itself, under its own id. */
    const written = await prisma.outreachAttempt.findMany({
      where: { senderId: ALPHA, targetId: targetId('zzz_live'), status: { in: ['READY', 'QUEUED'] } },
    })
    expect(written).toHaveLength(1)
    expect(summary.queued).toBe(1)
    /* Never re-drafted to the retired recipient. */
    expect(
      await prisma.outreachAttempt.count({
        where: { targetId: targetId('aaa_retired'), status: { in: ['READY', 'QUEUED'] } },
      }),
    ).toBe(0)
  })
})

describe('the guard is inside the statement, not only in the read', () => {
  it('discardAttempt with onlyIfRecipientRetired refuses a draft whose recipient is NOT retired at the moment of the write', async () => {
    await wipe()
    await seedSender(prisma, { handle: 'alpha' })
    await seedVariants(prisma, ALPHA)
    await seedTarget(prisma, { handle: 'back' })
    const id = (
      await seedDraft(prisma, {
        pairId: (await seedPair(prisma, ALPHA, targetId('back'))).id,
        status: 'READY',
        touchNumber: 1,
        body: SINGLE_TEMPLATE_MIDDLE,
        queuedAt: h(5),
      })
    ).id
    const { discardAttempt } = await import('@/outreach/discard')
    /* What a sweep that read "retired" a moment ago would ask, after `ig:unretire-target` landed. */
    const r = await discardAttempt({ attemptId: id, reason: 'x', actor: 'planner', onlyWaiting: true, onlyIfRecipientRetired: true })
    expect(r.ok).toBe(false)
    expect(await statusOf(id)).toBe('READY')
    expect(await prisma.auditLog.count()).toBe(0)
    /* And once it IS retired, the same call discards. */
    await prisma.targetAccount.update({ where: { id: targetId('back') }, data: { optedOut: true } })
    const r2 = await discardAttempt({ attemptId: id, reason: 'x', actor: 'planner', onlyWaiting: true, onlyIfRecipientRetired: true })
    expect(r2.ok).toBe(true)
    expect(await statusOf(id)).toBe('SKIPPED')
  })
})

describe('every retirement path discards what it just retired', () => {
  /** Source with comments removed, so a commented-out call can never satisfy a check. */
  const code = (p: string) =>
    readFileSync(join(process.cwd(), p), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')

  /** The body of `export async function <name>(` up to the next top-level `export `. */
  const fnBody = (src: string, name: string) => {
    const start = src.indexOf(`export async function ${name}(`)
    expect(start, `${name} not found`).toBeGreaterThanOrEqual(0)
    const next = src.indexOf('\nexport ', start + 1)
    return src.slice(start, next === -1 ? undefined : next)
  }

  const CALL = 'await discardWaitingDraftsToRetiredRecipients('

  /** The call exists, comes AFTER the retirement write, names the row retired, and is inside a try. */
  const assertWired = (label: string, body: string, idExpr: string) => {
    const retire = body.search(/data:[^\n]*optedOut: true/)
    expect(retire, `${label}: its retirement write was not found — re-anchor this test`).toBeGreaterThanOrEqual(0)
    const call = body.indexOf(CALL)
    expect(call, `${label}: no longer calls the discard`).toBeGreaterThanOrEqual(0)
    /* Before the write, `pair.target.optedOut` is still false and the call discards nothing. */
    expect(call, `${label}: the discard must come after the row is retired`).toBeGreaterThan(retire)
    expect(body.slice(call, call + 200), label).toContain(`targetIds: [${idExpr}]`)
    /* Best effort: the retirement is already written, so a failed discard must not throw past it. */
    const tryAt = body.lastIndexOf('try {', call)
    expect(tryAt, `${label}: the discard is not inside a try`).toBeGreaterThan(retire)
    expect(body.slice(tryAt, call), `${label}: the try closes before the call`).not.toContain('}')
    expect(body.indexOf('} catch', call), label).toBeGreaterThan(call)
  }

  it('removeTarget (the dashboard Remove button)', () => {
    assertWired('removeTarget', fnBody(code('src/app/actions.ts'), 'removeTarget'), 'target.id')
  })

  it('pnpm ig:retire-target', () => {
    assertWired('retire-target', code('src/scripts/retire-target.ts'), 'target.id')
  })

  it('pnpm ig:reverify-identity', () => {
    assertWired('reverify-identity', code('src/scripts/reverify-identity.ts'), 'p.id')
  })

  it('the planner runs the sweep inside a try, before it reads the waiting depth', () => {
    const body = fnBody(code('src/outreach/plan.ts'), 'runOutreach')
    const call = body.indexOf(CALL)
    const depth = body.indexOf('readNewBrandTouchCounts(')
    expect(call, 'runOutreach no longer calls the sweep').toBeGreaterThan(0)
    expect(depth, 'the depth read moved — re-check this test').toBeGreaterThan(0)
    expect(call).toBeLessThan(depth)
    const tryAt = body.lastIndexOf('try {', call)
    expect(tryAt, 'the sweep is not inside a try — a failure would fail the planning pass').toBeGreaterThan(0)
    expect(body.slice(tryAt, call)).not.toContain('}')
    expect(body.indexOf('} catch', call)).toBeGreaterThan(call)
  })

  it('the sweep re-asks "retired?" inside each discard, and pnpm ig:discard-retired-drafts has no rule of its own', () => {
    const sweep = code('src/outreach/retiredRecipientDrafts.ts')
    expect(sweep).toContain('onlyIfRecipientRetired: true')
    expect(sweep).toContain('onlyWaiting: true')
    const script = code('src/scripts/discard-retired-drafts.ts')
    expect(script).toContain(CALL)
    expect(script).not.toContain('discardAttempt(')
    /* Its preview asks the gate's field, never the denormalised `attempt.target`. */
    expect(script).toContain('pair: { target: { optedOut: true } }')
  })

  it('ig:retire-target no longer points at a command that never looks at the recipient', () => {
    expect(readFileSync(join(process.cwd(), 'src/scripts/retire-target.ts'), 'utf8')).not.toMatch(
      /clear (them|it) with|named as the way to clear it/,
    )
  })
})

describe('the Remove button says how many drafts went', () => {
  it('words the discarded drafts as part of the history it keeps, and says nothing when none went', () => {
    const with2 = removeTargetResult({ handle: 'x', outcome: 'retired', posts: 0, attempts: 3, delivered: 1, discardedDrafts: 2 })
    expect(with2).toContain('Its 3 recorded messages (1 delivered) are kept')
    expect(with2).toContain('Of those, the 2 still waiting were discarded — they can no longer be sent.')
    const with1 = removeTargetResult({ handle: 'x', outcome: 'retired', posts: 0, attempts: 2, delivered: 1, discardedDrafts: 1 })
    expect(with1).toContain('Of those, the 1 still waiting was discarded — it can no longer be sent.')
    for (const none of [
      removeTargetResult({ handle: 'x', outcome: 'retired', posts: 0, attempts: 3, delivered: 1, discardedDrafts: 0 }),
      removeTargetResult({ handle: 'x', outcome: 'retired', posts: 0, attempts: 3, delivered: 1 }),
    ]) {
      expect(none).not.toContain('discarded')
      expect(none).not.toContain('still waiting')
    }
  })

  it('a failed discard says the planner will finish it — never silence, never a claim that they went', () => {
    const m = removeTargetResult({ handle: 'x', outcome: 'retired', posts: 0, attempts: 3, delivered: 1, sweepFailed: true })
    expect(m).toContain('Retired @x: it will never be messaged.')
    expect(m).toContain('the planner discards them within 15 minutes')
    expect(m).not.toContain('still waiting were discarded')
  })
})
