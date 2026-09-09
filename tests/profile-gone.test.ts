import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { splitParks, PROFILE_GONE_RECHECK_DAYS } from '../src/outreach/parkedRows'
import { FAILURE_CODES } from '../src/lib/constants'
import { shouldReleaseOnFailure } from '../src/outreach/reservations'

/**
 * @hemantpandeyji (9 Sept 2026): a verified prospect whose page vanished; four senders each drove
 * Chrome at it three times. A gone page is a fact about the RECIPIENT, so it must stop every pair,
 * be recognised before a drive, and be parked on first sight rather than retried.
 */
const day = 86_400_000
const now = new Date('2026-09-09T07:00:00Z')
const row = (senderId: string, failureCode: string, agoMs: number) => ({ failureCode, queuedAt: new Date(now.getTime() - agoMs), pair: { senderId } })

describe('splitParks — one query, two facts', () => {
  it("a profile-gone park from ANOTHER sender stops this pair too", () => {
    const r = splitParks([row('b', 'profile-gone', 2 * day)], 'a', now)
    expect(r.targetProfileGoneAt).toEqual(new Date(now.getTime() - 2 * day))
    expect(r.parkedFailureCode).toBeNull()
  })
  it('the pair-level park is still only this pair\'s, in the old order (failureCode asc, newest first)', () => {
    const r = splitParks([row('b', 'no-composer', day), row('a', 'not-in-thread', day), row('a', 'no-composer', 3 * day)], 'a', now)
    expect(r.parkedFailureCode).toBe('no-composer')
    expect(r.targetProfileGoneAt).toBeNull()
  })
  it('a profile-gone park older than the window has expired — the recipient is asked about again', () => {
    const r = splitParks([row('b', 'profile-gone', (PROFILE_GONE_RECHECK_DAYS + 1) * day)], 'a', now)
    expect(r.targetProfileGoneAt).toBeNull()
  })
  it('an unreadable read never counts as a park', () => {
    expect(splitParks([row('a', 'unreadable', day)], 'a', now).parkedFailureCode).toBeNull()
  })
})

describe('profile-gone is a failure code that releases its reservation', () => {
  it('is in the vocabulary and definitely not delivered', () => {
    expect(FAILURE_CODES).toContain('profile-gone')
    expect(shouldReleaseOnFailure('profile-gone')).toBe(true)
  })
})

describe('the delivery path asks before it drives, and parks on first sight', () => {
  const src = readFileSync('src/outreach/deliver.ts', 'utf8')
  it('probeHandle runs BEFORE browserSender.send', () => {
    const probe = src.indexOf('await probeHandle(target.handle)')
    const drive = src.indexOf('await browserSender.send({')
    expect(probe).toBeGreaterThan(0)
    expect(drive).toBeGreaterThan(probe)
  })
  it("a 'profile-gone' outcome parks FAILED without a retry", () => {
    const branch = src.indexOf("if (failureCode === 'profile-gone')")
    const park = src.indexOf("status: 'FAILED'", branch)
    const next = src.indexOf("if (failureCode === 'not-in-thread')")
    expect(branch).toBeGreaterThan(0)
    expect(park).toBeGreaterThan(branch)
    expect(park).toBeLessThan(next)
  })
  it('the drive recognises the dead page before trying the inbox route', () => {
    const dm = readFileSync('src/outreach/browser/sendDm.ts', 'utf8')
    const gone = dm.indexOf("Sorry, this page isn't available")
    const inbox = dm.indexOf('await openThreadViaInbox(page, targetHandle)')
    expect(gone).toBeGreaterThan(0)
    expect(inbox).toBeGreaterThan(gone)
  })
})
