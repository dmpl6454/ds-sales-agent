import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { unavailableForTarget } from '@/outreach/categories'
import { fleetRingOrder, nextSender } from '@/outreach/rotation'

/**
 * ROTATION SKIPS A ROUTE THE RECIPIENT'S OWN RULES ALREADY FORBID — it must not stall on it.
 *
 * ── THE SELF-LOCKING STALL, MEASURED ──────────────────────────────────────
 *
 * An unsettled `not-in-thread` park refuses its PAIR at the governor and the gate, correctly
 * and permanently: the recipient may already hold that page's message. But `unavailable`
 * carried ACCOUNT facts only, so rotation kept electing the parked page, the planner refused it
 * with `uncertain-delivery-unsettled`, and every other pair — eligible on every rule — was
 * skipped as `not-this-senders-turn`. Nothing was drafted. And the turn only advances on a
 * DELIVERY, which a parked pair can never produce, so it could never unstick itself.
 *
 * MEASURED 2026-08-24: 18 parked rows over 14 recipients; for 10 of them the parked page was
 * the elected one; NINE were otherwise writable, each with four clean routes and no draft, and
 * @sabazad and @zeemarathiofficial had been minted on 21 August and never received anything.
 * VERIFIED after the fix by executing the real `whoseTurn` on all nine: every one elects an
 * unparked page.
 *
 * ── WHAT MUST NOT BE WEAKENED, AND IS NOT ─────────────────────────────────
 *
 * The pair is STILL refused at both enforcers — that page never writes to that recipient again.
 * All that changed is that rotation stops electing a page which is already forbidden. The
 * safety property is untouched; only the deadlock is gone. The negative direction is asserted
 * below, because a "fix" that let the parked page send would be far worse than the stall.
 */

const repo = join(__dirname, '..')

/* Built through `fleetRingOrder`, the same producer the planner and the dashboard use — a
   hand-rolled `RingMember[]` would let this test pass against a ring shape nothing produces. */
const ring = fleetRingOrder([
  { id: 's1', handle: 'alpha', cohort: 1 },
  { id: 's2', handle: 'bravo', cohort: 1 },
  { id: 's3', handle: 'charlie', cohort: 1 },
])

describe('unavailableForTarget', () => {
  it('adds this recipient\'s blocked routes to the account facts', () => {
    const fleet = new Map([['s3', 'never signed in']])
    const blocked = new Map([['t1', new Map([['s1', 'they may already have it']])]])
    const merged = unavailableForTarget(fleet, blocked, 't1')
    expect(merged.get('s1')).toBe('they may already have it')
    expect(merged.get('s3')).toBe('never signed in')
    expect(merged.has('s2')).toBe(false)
  })

  it('returns the account facts untouched for a recipient with no blocked route', () => {
    const fleet = new Map([['s3', 'never signed in']])
    const merged = unavailableForTarget(fleet, new Map(), 't1')
    // Same object, not a copy: the overwhelming majority of recipients have no parked route and
    // must not each allocate a map.
    expect(merged).toBe(fleet)
  })

  it('never MUTATES the shared fleet-wide map', () => {
    // It is built once per planner run and read for every recipient. Writing a recipient's
    // route into it would make one company's park silence that page fleet-wide, for every
    // recipient considered after it — a far worse bug than the one being fixed.
    const fleet = new Map([['s3', 'never signed in']])
    const blocked = new Map([['t1', new Map([['s1', 'they may already have it']])]])
    unavailableForTarget(fleet, blocked, 't1')
    expect([...fleet.keys()]).toEqual(['s3'])
  })

  it('lets the ROUTE reason win where an account is unavailable for both reasons', () => {
    // "signed out" and "they may already have our message" are different facts; the second is
    // specific to this recipient and is the one worth showing.
    const merged = unavailableForTarget(
      new Map([['s1', 'never signed in']]),
      new Map([['t1', new Map([['s1', 'they may already have it']])]]),
      't1',
    )
    expect(merged.get('s1')).toBe('they may already have it')
  })
})

describe('the elected page', () => {
  it('is the next unparked one, not the parked one', () => {
    const blocked = new Map([['t1', new Map([['s1', 'they may already have it']])]])
    // lastSenderId s3 → the walk starts at s1, which is parked, so it must land on s2.
    const choice = nextSender({
      ring,
      lastSenderId: 's3',
      unavailable: unavailableForTarget(undefined, blocked, 't1'),
      targetId: 't1',
    })
    expect(choice.ok && choice.senderId).toBe('s2')
  })

  it('refuses with a NAMED reason when every page is parked, rather than electing one', () => {
    // Fail-closed and visible. Electing a parked page "because something must be chosen" is
    // how a guard turns into a duplicate DM to a company that may already hold the message.
    const allParked = new Map([
      ['t1', new Map([['s1', 'x'], ['s2', 'x'], ['s3', 'x']])],
    ])
    const choice = nextSender({
      ring,
      lastSenderId: null,
      unavailable: unavailableForTarget(undefined, allParked, 't1'),
      targetId: 't1',
    })
    expect(choice.ok).toBe(false)
    if (!choice.ok) expect(choice.reason).toBe('all-unavailable')
  })
})

describe('the plumbing', () => {
  it('is loaded inside rotation, so no caller can forget it', () => {
    // The planner, the /targets "next message comes from @x" line, ig:dedupe-drafts and the
    // hand-off broom all ask rotation. A fact merged in at one caller and not the others is the
    // drift gate.ts and messageEntry.ts were extracted to stop.
    const cat = readFileSync(join(repo, 'src/outreach/categories.ts'), 'utf8')
    expect(cat).toMatch(/export async function readBlockedRoutes/)
    // Both loaders — the single-target one and the batch one — must merge it.
    const single = cat.slice(cat.indexOf('export async function whoseTurn('), cat.indexOf('function decideTurn'))
    expect(single).toMatch(/readBlockedRoutes\(\{ targetIds: \[args\.targetId\] \}\)/)
    expect(single).toMatch(/unavailableForTarget\(args\.unavailable, blocked, args\.targetId\)/)
    const many = cat.slice(cat.indexOf('export async function whoseTurnForMany'))
    expect(many).toMatch(/readBlockedRoutes\(\{ targetIds: ids \}\)/)
    expect(many).toMatch(/unavailableForTarget\(unavailable, blocked, targetId\)/)
  })

  it('routes around a REPLY as well as a park, and honours the scope', () => {
    // The parked half has been here since 2026-08-24; the reply half is 2026-09-04. Both are
    // per-(target, sender) facts that stop ONE page delivering, and neither is a reason to
    // make the recipient wait. The scope check is what keeps a fleet-wide halt fleet-wide.
    const cat = readFileSync(join(repo, 'src/outreach/categories.ts'), 'utf8')
    const fn = cat.slice(cat.indexOf('export async function readBlockedRoutes'), cat.indexOf('export function unavailableForTarget'))
    expect(fn).toMatch(/replyPostedAt: \{ gte: replyHaltFloor\(/)
    expect(fn).toMatch(/replyHandledAt: null/)
    expect(fn).toMatch(/replyHalt\.scope === 'pair'/)
  })

  it('does not weaken either enforcer', () => {
    // The pair stays refused. If these ever stop refusing, the parked page could write again.
    const gov = readFileSync(join(repo, 'src/outreach/governor.ts'), 'utf8')
    const gate = readFileSync(join(repo, 'src/outreach/gate.ts'), 'utf8')
    expect(gov).toMatch(/if \(input\.parkedFailureCode !== null\)/)
    expect(gate).toMatch(/if \(input\.parkedFailureCode !== null\)/)
    // And neither stop became overridable.
    expect(gate).not.toMatch(/OVERRIDABLE_BLOCKS[\s\S]{0,200}UNCERTAIN_DELIVERY/)
  })

  it('is what the resting figure reads too, so the page cannot claim a hold the planner dropped', () => {
    const tally = readFileSync(join(repo, 'src/app/view-model/rest-tally.ts'), 'utf8')
    expect(tally).toMatch(/unavailableForTarget\(unavailable, blockedRoutes, p\.id\)/)
    // And it no longer counts a parked route as a per-recipient hold, because it is not one.
    expect(tally).not.toMatch(/bump\(\s*SKIP_REASONS\.UNCERTAIN_DELIVERY/)
    // And it routes around a reply the same way, or the panel names a page the planner skips.
    expect(tally).toMatch(/settings\.replyHaltScope === 'pair'/)
    // …with the planner's own sentence: both ask `replyRouteReason`, which reads the window from
    // the Setting rather than saying "a week" (audit H9).
    expect(tally).toMatch(/blockRoute\(r\.pair\.targetId, r\.pair\.senderId, replyRouteReason\(settings\.replyResumeHours\)\)/)
    const cat = readFileSync(join(repo, 'src/outreach/categories.ts'), 'utf8')
    expect(cat).toMatch(/put\(r\.pair\.targetId, r\.pair\.senderId, replyRouteReason\(replyHalt\.resumeHours\)\)/)
  })
})
