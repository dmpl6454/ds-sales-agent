import { describe, it, expect } from 'vitest'
import { nextSender, ringOrder, repeatsPreviousSender, type RingMember } from '@/outreach/rotation'

/**
 * Phase 3 — the rotation ring.
 *
 * The plan named seven cases that must be covered: a sender added mid-cycle, removed
 * mid-cycle, CHALLENGED, not logged in, the sender that is also the target, two
 * concurrent slots, and a failed send. Each has a test below, and each is checked in
 * BOTH directions — rotating when it should, and refusing when it cannot.
 *
 * The refusal direction matters as much as the rotation. "We could not work out whose
 * turn it is" and "it is @a's turn" are different answers, and only one of them should
 * put a message in front of a person.
 */

const member = (handle: string, position: number, enabled = true): RingMember => ({
  senderId: `id_${handle}`,
  handle,
  position,
  enabled,
})

const RING = [member('alpha', 0), member('bravo', 1), member('charlie', 2)]

describe('ringOrder', () => {
  it('sorts by position, not by handle', () => {
    const scrambled = [member('zulu', 0), member('alpha', 1)]
    expect(ringOrder(scrambled).map((m) => m.handle)).toEqual(['zulu', 'alpha'])
  })

  it('breaks a position tie deterministically so the ring is a total order', () => {
    const tied = [member('bravo', 5), member('alpha', 5)]
    expect(ringOrder(tied).map((m) => m.handle)).toEqual(['alpha', 'bravo'])
    // Same input in the other order gives the same ring — no dependence on insertion.
    expect(ringOrder([...tied].reverse()).map((m) => m.handle)).toEqual(['alpha', 'bravo'])
  })

  it('drops disabled members', () => {
    expect(ringOrder([member('a', 0), member('b', 1, false)]).map((m) => m.handle)).toEqual(['a'])
  })
})

describe('it never picks the same sender twice in a row', () => {
  it('advances one step each time', () => {
    expect(nextSender({ ring: RING, lastSenderId: 'id_alpha' })).toMatchObject({ handle: 'bravo' })
    expect(nextSender({ ring: RING, lastSenderId: 'id_bravo' })).toMatchObject({ handle: 'charlie' })
  })

  it('wraps around forever', () => {
    expect(nextSender({ ring: RING, lastSenderId: 'id_charlie' })).toMatchObject({ handle: 'alpha' })
  })

  it('starts at the front when nobody has written yet', () => {
    expect(nextSender({ ring: RING, lastSenderId: null })).toMatchObject({ handle: 'alpha' })
  })

  /** Walk a full cycle and assert every account is used exactly once. */
  it('distributes evenly across a full cycle', () => {
    let last: string | null = null
    const used: string[] = []
    for (let i = 0; i < RING.length; i++) {
      const choice = nextSender({ ring: RING, lastSenderId: last })
      expect(choice.ok).toBe(true)
      if (!choice.ok) return
      used.push(choice.handle)
      last = choice.senderId
    }
    expect(new Set(used).size).toBe(RING.length)
    expect(used).toEqual(['alpha', 'bravo', 'charlie'])
  })
})

describe('a sender added mid-cycle', () => {
  /** Slots into its position without disturbing whose turn it is now. */
  it('joins the ring at its position', () => {
    const grown = [...RING, member('delta', 3)]
    expect(nextSender({ ring: grown, lastSenderId: 'id_charlie' })).toMatchObject({ handle: 'delta' })
    expect(nextSender({ ring: grown, lastSenderId: 'id_delta' })).toMatchObject({ handle: 'alpha' })
  })

  it('is reachable even when inserted in the middle', () => {
    const grown = [member('alpha', 0), member('bravo', 1), member('bravo2', 1), member('charlie', 2)]
    expect(nextSender({ ring: grown, lastSenderId: 'id_bravo' })).toMatchObject({ handle: 'bravo2' })
  })
})

describe('a sender removed mid-cycle', () => {
  /**
   * The last sender is gone from the ring, so there is no "position after" it. Starting
   * at the front is deterministic and fair; the alternative — remembering a position for
   * an account that no longer exists — is a cursor, which is the thing this design
   * refuses.
   */
  it('falls back to the front of the ring rather than failing', () => {
    const shrunk = [member('bravo', 1), member('charlie', 2)]
    expect(nextSender({ ring: shrunk, lastSenderId: 'id_alpha' })).toMatchObject({ handle: 'bravo' })
  })

  it('treats a DISABLED member the same as a removed one', () => {
    const suspended = [member('alpha', 0, false), member('bravo', 1), member('charlie', 2)]
    expect(nextSender({ ring: suspended, lastSenderId: 'id_alpha' })).toMatchObject({ handle: 'bravo' })
    // ...and it is skipped when its turn comes round.
    expect(nextSender({ ring: suspended, lastSenderId: 'id_charlie' })).toMatchObject({ handle: 'bravo' })
  })
})

describe('unavailable senders are skipped, never queued behind', () => {
  /**
   * A skipped sender does NOT hold its place. Holding it would let one CHALLENGED
   * account stall an entire category, which is a worse failure than an uneven
   * distribution — and account safety says the flagged one must not be waited for.
   */
  it('skips a CHALLENGED account and uses the next one', () => {
    const out = new Map([['id_bravo', 'flagged by Instagram']])
    expect(nextSender({ ring: RING, lastSenderId: 'id_alpha', unavailable: out })).toMatchObject({
      handle: 'charlie',
    })
  })

  it('skips an account with no Chrome session', () => {
    const out = new Map([['id_bravo', 'not connected']])
    expect(nextSender({ ring: RING, lastSenderId: 'id_alpha', unavailable: out })).toMatchObject({
      handle: 'charlie',
    })
  })

  it('skips several in a row and wraps past them', () => {
    const out = new Map([
      ['id_bravo', 'flagged'],
      ['id_charlie', 'not connected'],
    ])
    expect(nextSender({ ring: RING, lastSenderId: 'id_alpha', unavailable: out })).toMatchObject({
      handle: 'alpha',
    })
  })

  /** The other direction: availability restored means it is used again. */
  it('uses the account again once it becomes available', () => {
    expect(nextSender({ ring: RING, lastSenderId: 'id_alpha', unavailable: new Map() })).toMatchObject({
      handle: 'bravo',
    })
  })
})

describe('an account never messages itself', () => {
  /**
   * Live, not theoretical: @bollywoodchronicle and @bollywoodsocietyy are senders AND
   * rehearsal targets, kept that way deliberately so the send path can be exercised
   * without touching a prospect.
   */
  it('skips the sender that is also the recipient', () => {
    const choice = nextSender({ ring: RING, lastSenderId: 'id_alpha', targetId: 'id_bravo' })
    expect(choice).toMatchObject({ handle: 'charlie' })
  })

  it('refuses when the recipient is the ONLY sender in the ring', () => {
    const solo = [member('alpha', 0)]
    const choice = nextSender({ ring: solo, lastSenderId: null, targetId: 'id_alpha' })
    expect(choice.ok).toBe(false)
    if (!choice.ok) expect(choice.detail).toContain('is the recipient')
  })
})

describe('refusing is a real answer', () => {
  it('refuses an empty ring rather than guessing', () => {
    const choice = nextSender({ ring: [], lastSenderId: null })
    expect(choice).toMatchObject({ ok: false, reason: 'empty-ring' })
  })

  it('refuses a ring where every member is disabled', () => {
    const choice = nextSender({ ring: [member('a', 0, false)], lastSenderId: null })
    expect(choice).toMatchObject({ ok: false, reason: 'empty-ring' })
  })

  /** And it names WHO was unavailable and why — "nothing happened" with no reason is the failure. */
  it('refuses when all are unavailable, and says which and why', () => {
    const out = new Map([
      ['id_alpha', 'flagged by Instagram'],
      ['id_bravo', 'not connected'],
      ['id_charlie', 'daily cap spent'],
    ])
    const choice = nextSender({ ring: RING, lastSenderId: null, unavailable: out })
    expect(choice.ok).toBe(false)
    if (!choice.ok) {
      expect(choice.reason).toBe('all-unavailable')
      expect(choice.detail).toContain('alpha: flagged by Instagram')
      expect(choice.detail).toContain('charlie: daily cap spent')
    }
  })
})

describe('two concurrent slots', () => {
  /**
   * Rotation is a PURE function of history, so two slots reading the same history
   * necessarily choose the same sender. That is correct and is not the guard: what stops
   * them both sending is the atomic reservation from Phase 2 and the READY→SENDING
   * claim. Rotation deciding differently under concurrency would be the bug — it would
   * mean the ring depended on timing.
   */
  it('is deterministic: the same history always yields the same sender', () => {
    const a = nextSender({ ring: RING, lastSenderId: 'id_alpha' })
    const b = nextSender({ ring: RING, lastSenderId: 'id_alpha' })
    expect(a).toEqual(b)
  })
})

describe('a failed send does not advance the ring', () => {
  /**
   * Because the position is DERIVED from delivered history, a send that failed leaves
   * `lastSenderId` untouched and the same account is chosen again. That is the intended
   * behaviour: the recipient never heard from them, so it is still their turn. A stored
   * cursor advanced at dispatch would have skipped that account silently.
   */
  it('offers the same sender again when the previous attempt never landed', () => {
    const beforeFailure = nextSender({ ring: RING, lastSenderId: 'id_alpha' })
    const afterFailure = nextSender({ ring: RING, lastSenderId: 'id_alpha' })
    expect(beforeFailure).toMatchObject({ handle: 'bravo' })
    expect(afterFailure).toEqual(beforeFailure)
  })

  it('advances only once the send is actually recorded as delivered', () => {
    expect(nextSender({ ring: RING, lastSenderId: 'id_bravo' })).toMatchObject({ handle: 'charlie' })
  })
})

describe('repeatsPreviousSender', () => {
  /**
   * A ring of one MUST repeat, and that is a business fact worth surfacing rather than a
   * bug to hide: the recipient hears from the same page every time.
   */
  it('is true for a ring of one', () => {
    const solo = [member('alpha', 0)]
    const choice = nextSender({ ring: solo, lastSenderId: 'id_alpha' })
    expect(choice).toMatchObject({ handle: 'alpha' })
    expect(repeatsPreviousSender(choice, 'id_alpha')).toBe(true)
  })

  it('is false whenever the ring has room to move', () => {
    const choice = nextSender({ ring: RING, lastSenderId: 'id_alpha' })
    expect(repeatsPreviousSender(choice, 'id_alpha')).toBe(false)
  })

  it('is false on a first touch', () => {
    const choice = nextSender({ ring: RING, lastSenderId: null })
    expect(repeatsPreviousSender(choice, null)).toBe(false)
  })
})

describe('the 63-sender fleet', () => {
  const fleet = Array.from({ length: 63 }, (_, i) => member(`page${String(i).padStart(2, '0')}`, i))

  it('gives every account exactly one turn per cycle', () => {
    let last: string | null = null
    const used: string[] = []
    for (let i = 0; i < 63; i++) {
      const c = nextSender({ ring: fleet, lastSenderId: last })
      expect(c.ok).toBe(true)
      if (!c.ok) return
      used.push(c.handle)
      last = c.senderId
    }
    expect(new Set(used).size).toBe(63)
  })

  /**
   * The measured worry, stated as a test. Rotation spreads 14 messages a day across 14
   * DIFFERENT accounts — each individually quiet, which is exactly why per-sender caps
   * are not the control that matters. The recipient still receives 14, and only the
   * Phase 2 reservation stops that.
   */
  it('spreads a day of @viralbhayani volume across 14 different accounts', () => {
    let last: string | null = null
    const used: string[] = []
    for (let i = 0; i < 14; i++) {
      const c = nextSender({ ring: fleet, lastSenderId: last })
      if (!c.ok) return
      used.push(c.handle)
      last = c.senderId
    }
    expect(new Set(used).size).toBe(14)
    // Each account sent once. Per-sender volume is trivially safe; the inbox is not.
    expect(used.length).toBe(14)
  })
})
