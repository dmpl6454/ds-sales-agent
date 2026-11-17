import { describe, it, expect } from 'vitest'
import { nextSender, type RingMember, type TurnPass } from '@/outreach/rotation'
import { turnPassFor } from '@/outreach/categories'

/**
 * ── THE TURN PASS, PURE (17 Nov 2026) ──────────────────────────────────────
 *
 * When the page rotation elects has already written to a recipient and has nothing new to say,
 * the turn passes to a page in the ring that has never written to them — see `TurnPass` in
 * rotation.ts for the measurement (5,408 routes skipped "no new material", 73 introductions
 * waiting behind them) and whose decision it was.
 *
 * Every case is asserted in BOTH directions, because both failures are real: a pass that does
 * not fire leaves the fleet silent, and a pass that fires where it must not puts a second
 * page's introduction in front of someone who answered us, or elects a page that cannot send.
 */

const member = (handle: string, position: number): RingMember => ({
  senderId: `id_${handle}`,
  handle,
  position,
  enabled: true,
})
const RING = [member('alpha', 0), member('bravo', 1), member('charlie', 2), member('delta', 3)]

const pass = (over: Partial<TurnPass> = {}): TurnPass => ({
  wroteBefore: new Set(['id_alpha', 'id_bravo']),
  holdsDraft: new Set(),
  everReplied: false,
  nothingNewToSay: true,
  ...over,
})

describe('the pass fires: an elected page with nothing new hands the turn on', () => {
  it('to the first page AFTER the elected one that never wrote', () => {
    // alpha wrote last, so bravo is elected; bravo wrote before and has nothing new → charlie.
    const choice = nextSender({ ring: RING, lastSenderId: 'id_alpha', pass: pass() })
    expect(choice).toMatchObject({ ok: true, handle: 'charlie', passedFrom: { handle: 'bravo' } })
  })

  it('wraps round the ring to find one', () => {
    // delta wrote last → alpha elected (wrote) → bravo wrote → charlie never wrote.
    const p = pass({ wroteBefore: new Set(['id_alpha', 'id_bravo', 'id_delta']) })
    expect(nextSender({ ring: RING, lastSenderId: 'id_delta', pass: p })).toMatchObject({ handle: 'charlie' })
    // charlie wrote last → delta elected (wrote) → alpha, bravo wrote → wraps to… nobody but
    // charlie itself, who wrote: no candidate, so the ordinary choice stands.
    const all = pass({ wroteBefore: new Set(['id_alpha', 'id_bravo', 'id_charlie', 'id_delta']) })
    expect(nextSender({ ring: RING, lastSenderId: 'id_charlie', pass: all })).toMatchObject({ handle: 'delta' })
  })

  it('skips an unavailable never-wrote page and takes the next one', () => {
    const unavailable = new Map([['id_charlie', 'signed in on no Mac that has been online']])
    const choice = nextSender({ ring: RING, lastSenderId: 'id_alpha', unavailable, pass: pass() })
    expect(choice).toMatchObject({ handle: 'delta', passedFrom: { handle: 'bravo' } })
  })

  it('never elects the recipient itself', () => {
    const choice = nextSender({ ring: RING, lastSenderId: 'id_alpha', targetId: 'id_charlie', pass: pass() })
    expect(choice).toMatchObject({ handle: 'delta' })
  })
})

describe('the pass does NOT fire, and the ordinary choice stands', () => {
  it('with no pass facts at all (switch off, or the material is not known)', () => {
    const choice = nextSender({ ring: RING, lastSenderId: 'id_alpha' })
    expect(choice).toMatchObject({ handle: 'bravo' })
    expect(choice.ok && choice.passedFrom).toBeFalsy()
  })

  it('when there IS something new to say — the elected page writes its follow-up', () => {
    expect(nextSender({ ring: RING, lastSenderId: 'id_alpha', pass: pass({ nothingNewToSay: false }) })).toMatchObject({
      handle: 'bravo',
    })
  })

  it('when the recipient ever replied to any page — nobody may introduce themselves to them', () => {
    expect(nextSender({ ring: RING, lastSenderId: 'id_alpha', pass: pass({ everReplied: true }) })).toMatchObject({
      handle: 'bravo',
    })
  })

  it('when the elected page never wrote — its message is already an introduction', () => {
    const p = pass({ wroteBefore: new Set(['id_alpha']) })
    expect(nextSender({ ring: RING, lastSenderId: 'id_alpha', pass: p })).toMatchObject({ handle: 'bravo' })
  })

  it('when the elected page holds a waiting draft — its message is in the queue', () => {
    const p = pass({ holdsDraft: new Set(['id_bravo']) })
    expect(nextSender({ ring: RING, lastSenderId: 'id_alpha', pass: p })).toMatchObject({ handle: 'bravo' })
  })

  it('when every page has written — NOT a refusal, which the screens would file as "rotation stuck"', () => {
    const p = pass({ wroteBefore: new Set(RING.map((m) => m.senderId)) })
    const choice = nextSender({ ring: RING, lastSenderId: 'id_alpha', pass: p })
    expect(choice).toMatchObject({ ok: true, handle: 'bravo' })
    expect(choice.ok && choice.passedFrom).toBeFalsy()
  })

  it('when every never-wrote page is unavailable — the ordinary choice, not all-unavailable', () => {
    const unavailable = new Map([
      ['id_charlie', 'flagged'],
      ['id_delta', 'parked'],
    ])
    const choice = nextSender({ ring: RING, lastSenderId: 'id_alpha', unavailable, pass: pass() })
    expect(choice).toMatchObject({ ok: true, handle: 'bravo' })
  })

  it('does not rescue a refusal: a ring with nobody available stays a refusal', () => {
    const unavailable = new Map(RING.map((m) => [m.senderId, 'flagged'] as const))
    expect(nextSender({ ring: RING, lastSenderId: 'id_alpha', unavailable, pass: pass() })).toMatchObject({
      ok: false,
      reason: 'all-unavailable',
    })
  })
})

describe('a turn already passed stays passed while its draft waits (no fan-out)', () => {
  it('a never-wrote page holding a draft keeps the turn, even if it is not the first after the elected one', () => {
    // charlie would be first; delta already holds the passed introduction.
    const p = pass({ holdsDraft: new Set(['id_delta']) })
    expect(nextSender({ ring: RING, lastSenderId: 'id_alpha', pass: p })).toMatchObject({
      handle: 'delta',
      passedFrom: { handle: 'bravo' },
    })
  })

  it('…and keeps it even after new material appears, so the elected page does not draft beside it', () => {
    const p = pass({ holdsDraft: new Set(['id_delta']), nothingNewToSay: false })
    expect(nextSender({ ring: RING, lastSenderId: 'id_alpha', pass: p })).toMatchObject({ handle: 'delta' })
  })

  it('…but not once that page is unavailable: the ordinary walk takes over', () => {
    const p = pass({ holdsDraft: new Set(['id_delta']), nothingNewToSay: false })
    const unavailable = new Map([['id_delta', 'signed in on no Mac']])
    expect(nextSender({ ring: RING, lastSenderId: 'id_alpha', unavailable, pass: p })).toMatchObject({ handle: 'bravo' })
  })

  it('is deterministic: the same facts elect the same page every time', () => {
    const a = nextSender({ ring: RING, lastSenderId: 'id_alpha', pass: pass() })
    const b = nextSender({ ring: [...RING].reverse(), lastSenderId: 'id_alpha', pass: pass() })
    expect(a).toEqual(b)
  })
})

describe('turnPassFor — the switch and an unknown material fact both mean NO pass', () => {
  const history = {
    lastSenderId: 'id_alpha',
    wroteBefore: new Set(['id_alpha']),
    holdsDraft: new Set<string>(),
    everReplied: false,
  }
  it('switched off → no pass facts', () => {
    expect(turnPassFor(history, { enabled: false, nothingNewToSay: true })).toBeUndefined()
  })
  it('material not known → no pass facts, never a guess', () => {
    expect(turnPassFor(history, { enabled: true, nothingNewToSay: undefined })).toBeUndefined()
  })
  it('switched on and known → the history, carried through', () => {
    expect(turnPassFor(history, { enabled: true, nothingNewToSay: true })).toEqual({
      wroteBefore: history.wroteBefore,
      holdsDraft: history.holdsDraft,
      everReplied: false,
      nothingNewToSay: true,
    })
  })
  it('no history at all → nobody wrote, so the pass can never fire', () => {
    const p = turnPassFor(undefined, { enabled: true, nothingNewToSay: true })!
    expect(nextSender({ ring: RING, lastSenderId: null, targetId: 't', pass: p }).ok).toBe(true)
    expect(p.wroteBefore.size).toBe(0)
  })
})
