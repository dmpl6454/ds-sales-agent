import { describe, it, expect } from 'vitest'
import { nextSender, threadsUnreadSinceWrote, REPLY_READS_TRUSTED_SINCE, type RingMember, type TurnPass } from '@/outreach/rotation'
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
  unreadSinceWrote: [],
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
    const choice = nextSender({ ring: RING, lastSenderId: 'id_alpha', pass: p })
    // KEPT, not passed again: labelled apart so the log does not count it twice and the reason
    // is not "nothing new to say" (review 3).
    expect(choice).toMatchObject({ handle: 'delta', passKeptFor: { handle: 'bravo' } })
    expect(choice.ok && choice.passedFrom).toBeFalsy()
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

  it('…and an unavailable holder does NOT free the turn for a SECOND introduction (review of 3e03c67)', () => {
    // delta holds the passed introduction and has gone unavailable; there is still nothing new to
    // say. The first version filtered delta out before looking for a holder and handed the turn to
    // charlie — a second introduction while delta's still waits, delivered when delta returns.
    const p = pass({ holdsDraft: new Set(['id_delta']) })
    const unavailable = new Map([['id_delta', 'signed in on no Mac']])
    const choice = nextSender({ ring: RING, lastSenderId: 'id_alpha', unavailable, pass: p })
    expect(choice).toMatchObject({ ok: true, handle: 'bravo' })
    expect(choice.ok && choice.passedFrom).toBeFalsy()
  })

  it('…but an elected page that never wrote keeps the ordinary walk, even beside a waiting one', () => {
    // Pre-existing and pinned by planner-golden (pending_draft, midsend): hasPendingAttempt is per
    // pair, and a recipient-level pending check is its own decision. The pass does not change it.
    const p = pass({ wroteBefore: new Set(['id_alpha']), holdsDraft: new Set(['id_delta']) })
    const choice = nextSender({ ring: RING, lastSenderId: 'id_alpha', pass: p })
    expect(choice).toMatchObject({ ok: true, handle: 'bravo' })
    expect(choice.ok && choice.passedFrom).toBeFalsy()
  })

  it('…while an AVAILABLE holder keeps the turn even when an earlier one is unavailable', () => {
    const p = pass({ holdsDraft: new Set(['id_charlie', 'id_delta']) })
    const unavailable = new Map([['id_charlie', 'flagged']])
    expect(nextSender({ ring: RING, lastSenderId: 'id_alpha', unavailable, pass: p })).toMatchObject({
      handle: 'delta',
      passKeptFor: { handle: 'bravo' },
    })
  })

  it('no pass while a page OUTSIDE the ring has a message out to them (review 3)', () => {
    // A retired page, or one out of their fleet, with a waiting draft or a maybe-delivered park.
    const choice = nextSender({ ring: RING, lastSenderId: 'id_alpha', pass: pass({ holdsDraft: new Set(['id_gone']) }) })
    expect(choice).toMatchObject({ ok: true, handle: 'bravo' })
    expect(choice.ok && (choice.passedFrom || choice.passKeptFor)).toBeFalsy()
  })

  it('no pass while a page that HAS written has a message out to them — its waiting or parked follow-up (review 3)', () => {
    const choice = nextSender({ ring: RING, lastSenderId: 'id_alpha', pass: pass({ holdsDraft: new Set(['id_alpha']) }) })
    expect(choice).toMatchObject({ ok: true, handle: 'bravo' })
    expect(choice.ok && choice.passedFrom).toBeFalsy()
  })

  it('walks the whole ring: the page just BEFORE the elected one is a candidate too', () => {
    // The last writer left the ring, so the walk starts at the front: alpha is elected (wrote),
    // and the only page that never wrote is delta — the member immediately before alpha.
    const p = pass({ wroteBefore: new Set(['id_alpha', 'id_bravo', 'id_charlie', 'id_gone']) })
    expect(nextSender({ ring: RING, lastSenderId: 'id_gone', pass: p })).toMatchObject({
      handle: 'delta',
      passedFrom: { handle: 'alpha' },
    })
  })

  it('is deterministic: the same facts elect the same page every time', () => {
    const a = nextSender({ ring: RING, lastSenderId: 'id_alpha', pass: pass() })
    const b = nextSender({ ring: [...RING].reverse(), lastSenderId: 'id_alpha', pass: pass() })
    expect(a).toEqual(b)
  })
})

describe('a page whose conversation nobody has read since it wrote holds the pass (rule 5)', () => {
  it('holds it, and says which conversation the recipient is waiting on', () => {
    // bravo is elected, has nothing new, charlie never wrote and is available — everything the
    // pass needs — but alpha's conversation has not been read since alpha wrote. A reply could be
    // sitting there; a second introduction must wait until somebody has looked.
    const choice = nextSender({ ring: RING, lastSenderId: 'id_alpha', pass: pass({ unreadSinceWrote: ['alpha'] }) })
    expect(choice).toMatchObject({ ok: true, handle: 'bravo', passWaitsForRead: ['alpha'] })
    expect(choice.ok && choice.passedFrom).toBeFalsy()
  })

  it('says nothing about a read when the pass was never going to fire anyway', () => {
    for (const over of [{ nothingNewToSay: false }, { everReplied: true }, { holdsDraft: new Set(['id_bravo']) }]) {
      const choice = nextSender({ ring: RING, lastSenderId: 'id_alpha', pass: pass({ unreadSinceWrote: ['alpha'], ...over }) })
      expect(choice).toMatchObject({ handle: 'bravo' })
      expect(choice.ok && choice.passWaitsForRead).toBeFalsy()
    }
    const allUnavailable = new Map([['id_charlie', 'x'], ['id_delta', 'x']])
    const choice = nextSender({ ring: RING, lastSenderId: 'id_alpha', unavailable: allUnavailable, pass: pass({ unreadSinceWrote: ['alpha'] }) })
    expect(choice.ok && choice.passWaitsForRead).toBeFalsy()
  })

  it('does not unpin a turn already passed: the waiting introduction is still the next message', () => {
    const p = pass({ unreadSinceWrote: ['alpha'], holdsDraft: new Set(['id_delta']) })
    expect(nextSender({ ring: RING, lastSenderId: 'id_alpha', pass: p })).toMatchObject({ handle: 'delta' })
  })
})

describe('threadsUnreadSinceWrote — silence counts only from a read after the page last wrote', () => {
  const floor = REPLY_READS_TRUSTED_SINCE
  const at = (offsetHours: number) => new Date(floor.getTime() + offsetHours * 3_600_000)
  it('never read → unread', () => {
    expect(threadsUnreadSinceWrote([{ handle: 'a', lastWroteAt: at(-400), lastReadAt: null }])).toEqual(['a'])
  })
  it('read before the window fix → unread, however long after the message', () => {
    expect(threadsUnreadSinceWrote([{ handle: 'a', lastWroteAt: at(-400), lastReadAt: at(-1) }])).toEqual(['a'])
  })
  it('read after the fix → read', () => {
    expect(threadsUnreadSinceWrote([{ handle: 'a', lastWroteAt: at(-400), lastReadAt: at(1) }])).toEqual([])
  })
  it('read after the fix but BEFORE the page wrote again → unread', () => {
    expect(threadsUnreadSinceWrote([{ handle: 'a', lastWroteAt: at(5), lastReadAt: at(2) }])).toEqual(['a'])
    expect(threadsUnreadSinceWrote([{ handle: 'a', lastWroteAt: at(5), lastReadAt: at(5) }])).toEqual([])
  })
  it('a delivery with no time still needs a read after the fix', () => {
    expect(threadsUnreadSinceWrote([{ handle: 'a', lastWroteAt: null, lastReadAt: at(-1) }])).toEqual(['a'])
    expect(threadsUnreadSinceWrote([{ handle: 'a', lastWroteAt: null, lastReadAt: at(1) }])).toEqual([])
  })
  it('names them in a stable order', () => {
    const pages = [
      { handle: 'zeta', lastWroteAt: at(-9), lastReadAt: null },
      { handle: 'beta', lastWroteAt: at(-9), lastReadAt: null },
      { handle: 'mid', lastWroteAt: at(-9), lastReadAt: at(3) },
    ]
    expect(threadsUnreadSinceWrote(pages)).toEqual(['beta', 'zeta'])
  })
})

describe('turnPassFor — the switch and an unknown material fact both mean NO pass', () => {
  const read = new Date(REPLY_READS_TRUSTED_SINCE.getTime() + 3_600_000)
  const history = {
    lastSenderId: 'id_alpha',
    wroteBefore: new Set(['id_alpha', 'id_bravo']),
    holdsDraft: new Set<string>(),
    everReplied: false,
    writers: new Map([
      ['id_alpha', { handle: 'alpha', lastWroteAt: new Date('2026-10-20T10:00:00Z'), lastReadAt: read }],
      ['id_bravo', { handle: 'bravo', lastWroteAt: new Date('2026-10-21T10:00:00Z'), lastReadAt: null }],
    ]),
  }
  it('switched off → no pass facts', () => {
    expect(turnPassFor(history, { enabled: false, nothingNewToSay: true, onlyAfterRead: true })).toBeUndefined()
  })
  it('material not known → no pass facts, never a guess', () => {
    expect(turnPassFor(history, { enabled: true, nothingNewToSay: undefined, onlyAfterRead: true })).toBeUndefined()
  })
  it('switched on and known → the history, carried through, with the unread conversations named', () => {
    expect(turnPassFor(history, { enabled: true, nothingNewToSay: true, onlyAfterRead: true })).toEqual({
      wroteBefore: history.wroteBefore,
      holdsDraft: history.holdsDraft,
      everReplied: false,
      nothingNewToSay: true,
      unreadSinceWrote: ['bravo'],
    })
  })
  it('the read requirement switched off → nothing counts as unread', () => {
    expect(turnPassFor(history, { enabled: true, nothingNewToSay: true, onlyAfterRead: false })!.unreadSinceWrote).toEqual([])
  })
  it('no history at all → nobody wrote, so the pass can never fire', () => {
    const p = turnPassFor(undefined, { enabled: true, nothingNewToSay: true, onlyAfterRead: true })!
    expect(nextSender({ ring: RING, lastSenderId: null, targetId: 't', pass: p }).ok).toBe(true)
    expect(p.wroteBefore.size).toBe(0)
    expect(p.unreadSinceWrote).toEqual([])
  })
})
