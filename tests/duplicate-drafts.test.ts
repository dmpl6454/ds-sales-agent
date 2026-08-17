import { describe, it, expect } from 'vitest'
import { chooseDraftToKeep, type DraftRef } from '@/outreach/duplicateDrafts'
import type { RingMember } from '@/outreach/rotation'

/**
 * `chooseDraftToKeep` — which of several drafts to one recipient survives.
 *
 * This function throws away real messages that were written to real prospects, so both
 * directions matter and the NEGATIVE one matters more: the cases asserted hardest below are
 * the ones where it must NOT discard — a single draft, and a fleet where nobody can send.
 *
 * The live state it was written for, MEASURED 2026-08-13: 7 recipients holding a draft from
 * all three fleet accounts, 1 holding two, 15 surplus in total.
 */

const member = (handle: string, position: number, enabled = true): RingMember => ({
  senderId: `s_${handle}`,
  handle,
  position,
  enabled,
})

const draft = (handle: string, minutesAgo: number): DraftRef => ({
  attemptId: `a_${handle}`,
  senderId: `s_${handle}`,
  handle,
  queuedAt: new Date(Date.UTC(2026, 7, 13, 9, 0) - minutesAgo * 60_000),
})

const RING = [member('alpha', 0), member('bravo', 1), member('charlie', 2)]

describe('chooseDraftToKeep — the ordinary path', () => {
  it("keeps the sender rotation would have chosen, and discards the rest", () => {
    const d = chooseDraftToKeep({
      drafts: [draft('alpha', 30), draft('bravo', 20), draft('charlie', 10)],
      ring: RING,
      lastSenderId: null,
    })!
    expect(d.keep.handle).toBe('alpha')
    expect(d.discard.map((x) => x.handle).sort()).toEqual(['bravo', 'charlie'])
    expect(d.why).toContain('alpha')
  })

  it('walks on from whoever delivered last, so the keeper is not the page that just wrote', () => {
    const d = chooseDraftToKeep({
      drafts: [draft('alpha', 30), draft('bravo', 20), draft('charlie', 10)],
      ring: RING,
      lastSenderId: 's_alpha',
    })!
    expect(d.keep.handle).toBe('bravo')
  })

  it('skips an unavailable sender rather than keeping a draft that cannot go out', () => {
    const d = chooseDraftToKeep({
      drafts: [draft('alpha', 30), draft('bravo', 20)],
      ring: RING,
      lastSenderId: null,
      unavailable: new Map([['s_alpha', 'flagged by Instagram']]),
    })!
    expect(d.keep.handle).toBe('bravo')
  })

  it('never elects a sender that holds no draft — the ring is narrowed first', () => {
    // `charlie` is first after `bravo` in the full ring but wrote nothing. Asking the
    // unnarrowed ring would name charlie, and there would be no draft to keep.
    const d = chooseDraftToKeep({
      drafts: [draft('alpha', 30), draft('bravo', 20)],
      ring: RING,
      lastSenderId: 's_bravo',
    })!
    expect(['alpha', 'bravo']).toContain(d.keep.handle)
    expect(d.keep.handle).toBe('alpha')
  })
})

describe('chooseDraftToKeep — the directions where it must NOT discard', () => {
  it('discards nothing when there is one draft', () => {
    const d = chooseDraftToKeep({ drafts: [draft('alpha', 5)], ring: RING, lastSenderId: null })!
    expect(d.keep.handle).toBe('alpha')
    expect(d.discard).toEqual([])
  })

  it('returns null for no drafts at all rather than inventing a keeper', () => {
    expect(chooseDraftToKeep({ drafts: [], ring: RING, lastSenderId: null })).toBeNull()
  })

  it('STILL KEEPS ONE when every account is unavailable', () => {
    /**
     * The whole fleet being signed out is a fact about SENDING. These rows are waiting, with
     * their refusal shown on /messages. Discarding all of them because none can go out today
     * would empty the queue at exactly the moment the queue is the only record of what was
     * going to be said.
     */
    const d = chooseDraftToKeep({
      drafts: [draft('alpha', 30), draft('bravo', 20)],
      ring: RING,
      lastSenderId: null,
      unavailable: new Map([
        ['s_alpha', 'never signed in'],
        ['s_bravo', 'never signed in'],
      ]),
    })!
    expect(d.keep.handle).toBe('alpha')
    expect(d.discard.map((x) => x.handle)).toEqual(['bravo'])
    expect(d.why).toContain('no account can write today')
  })

  it('keeps the OLDEST when no draft-holder is still in the ring', () => {
    // A route withdrawn, or an account that left the fleet, after these were written.
    const d = chooseDraftToKeep({
      drafts: [draft('delta', 60), draft('echo', 10)],
      ring: RING,
      lastSenderId: null,
    })!
    expect(d.keep.handle).toBe('delta')
    expect(d.why).toContain('oldest')
  })

  it('an empty ring still keeps one draft rather than clearing the recipient', () => {
    const d = chooseDraftToKeep({ drafts: [draft('alpha', 30), draft('bravo', 10)], ring: [], lastSenderId: null })!
    expect(d.keep.handle).toBe('alpha')
    expect(d.discard).toHaveLength(1)
  })

  it('every input keeps exactly one draft and loses none — the count is conserved', () => {
    const cases: DraftRef[][] = [
      [draft('alpha', 3)],
      [draft('alpha', 3), draft('bravo', 2)],
      [draft('alpha', 3), draft('bravo', 2), draft('charlie', 1)],
      [draft('delta', 3), draft('echo', 1)],
    ]
    for (const drafts of cases) {
      for (const lastSenderId of [null, 's_alpha', 's_charlie', 's_gone']) {
        const d = chooseDraftToKeep({ drafts, ring: RING, lastSenderId })!
        expect(d.discard).toHaveLength(drafts.length - 1)
        expect([d.keep, ...d.discard].map((x) => x.attemptId).sort()).toEqual(
          drafts.map((x) => x.attemptId).sort(),
        )
        expect(d.discard.some((x) => x.attemptId === d.keep.attemptId)).toBe(false)
      }
    }
  })
})
