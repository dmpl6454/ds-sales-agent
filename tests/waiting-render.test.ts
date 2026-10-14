import { describe, it, expect } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { WaitingList } from '../src/app/messages/waiting'
import type { QueueMotion } from '../src/app/view-model/queue-motion'
import type { MessagesPageView } from '../src/app/view-model/messages-page'

/**
 * WHAT THE QUEUE SAYS, PER MOTION — audit H8, rendered rather than inferred.
 *
 * A countdown is a promise (2026-08-20). Only a MOVING queue may show "next tick" / "in ~N min" or
 * "these are the drafts that will actually go"; every other state names the switch card's own
 * reason instead. The view model now carries the pace estimate unconditionally, so this component
 * is the only thing between an estimate and a promise — which is why it is rendered here and read,
 * not asserted by a grep.
 */

const upNext: MessagesPageView['upNext'] = [
  { position: 1, senderHandle: 'a', targetHandle: 'ta', etaMinutes: 0, note: null, held: false, clear: true },
  { position: 2, senderHandle: 'c', targetHandle: 'tc', etaMinutes: 1, note: null, held: false, clear: false },
]
const heldUpNext: MessagesPageView['heldUpNext'] = [
  {
    senderHandle: 'b',
    targetHandle: 'tb',
    why: '@b is not signed in on Studio, the sending Mac — it sends only from accounts signed in there',
    resumesAt: null,
  },
]

/* The view model's own account of the sign-in holds — the ONE held row above is one of them. */
const notSignedIn: MessagesPageView['notSignedIn'] = { mac: 'Studio', macOnline: true, handles: ['b'], drafts: 1 }

const render = (motion: QueueMotion, rows = upNext) =>
  renderToStaticMarkup(
    createElement(WaitingList, {
      upNext: rows,
      heldWaiting: 1,
      heldUpNext,
      notSignedIn,
      total: rows.length + 1,
      motion,
      resting: null,
    }),
  )

describe('the queue promises a send only when the queue is moving', () => {
  it('moving: a countdown, a clear head, and "will actually go"', () => {
    const html = render({ kind: 'moving', mac: 'Studio' })
    expect(html).toContain('next tick')
    expect(html).toContain('in ~1 min')
    expect(html).toContain('clear to send on the next tick')
    expect(html).toContain('will actually go')
  })

  it('mac-offline: names the Mac and what it waits for — no countdown, no promise', () => {
    const html = render({ kind: 'mac-offline', mac: 'Studio' })
    expect(html).toContain('Studio')
    expect(html).toContain('back online')
    expect(html).not.toContain('next tick')
    expect(html).not.toMatch(/in ~\d+ min/)
    expect(html).not.toContain('will actually go')
  })

  it('no-mac: says a sending Mac must be chosen', () => {
    const html = render({ kind: 'no-mac' })
    expect(html).toContain('sending Mac is chosen')
    expect(html).not.toContain('next tick')
    expect(html).not.toContain('will actually go')
  })

  it('no-account-ready: says an account must be signed in', () => {
    const html = render({ kind: 'no-account-ready', mac: 'Studio' })
    expect(html).toContain('an account is signed in')
    expect(html).not.toContain('next tick')
  })

  it('switch-off: says Autopilot is off, and the clear head waits only for it', () => {
    const html = render({ kind: 'switch-off' })
    expect(html).toContain('Autopilot is off')
    expect(html).toContain('waiting only for Autopilot to be switched on')
    expect(html).not.toContain('next tick')
    expect(html).not.toContain('will actually go')
  })

  /** A held row with no clock is released by a person signing in, and `whenIst(null)` would throw. */
  it('a held row with no release time renders "once signed in there", not a date', () => {
    const html = render({ kind: 'moving', mac: 'Studio' })
    expect(html).toContain('once signed in there')
  })

  it('an all-held queue names its first CLOCK, never a row with none', () => {
    const html = render({ kind: 'moving', mac: 'Studio' }, [])
    expect(html).toContain('Nothing is sendable right now')
    expect(html).toContain('not signed in on the sending Mac')
    expect(html).not.toMatch(/until .* IST/)
  })
})

/**
 * AN ALL-HELD QUEUE MUST NOT PROMISE THAT A SIGN-IN HOLD CLEARS ITSELF — independent review of H8.
 *
 * With the sending Mac selected and beating but holding only some accounts, every other account's
 * draft is held with NO clock: it moves only when a person signs that account in on the sending
 * Mac. The all-held lede still said "Not a fault: Autopilot is on and the dispatcher checks every
 * minute, so each draft below sends itself when its window clears" — false for exactly those rows,
 * on the screen whose job is saying why nothing is going out. And `heldUpNext` is the first eight
 * rows with the no-clock rows sorted LAST, so the lede reads the view model's own count of them
 * (`notSignedIn`) rather than whatever happens to be on screen.
 */
describe('an all-held queue names a sign-in hold instead of calling it not a fault', () => {
  const clocked: MessagesPageView['heldUpNext'][number] = {
    senderHandle: 'c',
    targetHandle: 'tc',
    why: 'every paid post we have seen from them has already been written about',
    resumesAt: new Date('2026-10-12T06:30:00Z'),
  }
  const signIn: MessagesPageView['heldUpNext'][number] = heldUpNext[0]!
  const allHeld = (
    motion: QueueMotion,
    rows: MessagesPageView['heldUpNext'],
    held: MessagesPageView['notSignedIn'],
    heldWaiting = rows.length,
  ) =>
    renderToStaticMarkup(
      createElement(WaitingList, {
        upNext: [],
        heldWaiting,
        heldUpNext: rows,
        notSignedIn: held,
        total: heldWaiting,
        motion,
        resting: null,
      }),
    )
  const text = (html: string) => html.replace(/<[^>]+>/g, '').replace(/&mdash;/g, '—').replace(/\s+/g, ' ')

  it('moving, and the only held draft waits on a sign-in: names the account and the Mac — no "not a fault", no "sends itself"', () => {
    const t = text(allHeld({ kind: 'moving', mac: 'Studio' }, [signIn], notSignedIn))
    expect(t).not.toContain('Not a fault')
    expect(t).not.toMatch(/sends itself/)
    expect(t).toMatch(/@b is not signed in on Studio, the sending Mac/)
    expect(t).toMatch(/no clock releases/)
    expect(t).toMatch(/sign it in there/)
  })

  it('a sign-in hold hidden BEHIND eight clocked rows is still named — the lede reads the count, not the visible rows', () => {
    const eight = Array.from({ length: 8 }, (_, i) => ({ ...clocked, senderHandle: `c${i}`, targetHandle: `t${i}` }))
    const t = text(allHeld({ kind: 'moving', mac: 'Studio' }, eight, { ...notSignedIn, drafts: 3 }, 11))
    expect(t).not.toContain('Not a fault')
    expect(t).toMatch(/3 of them are from @b, which is not signed in on Studio/)
    /* The clocked rows keep their true sentence. */
    expect(t).toMatch(/the rest send themselves as their windows clear/i)
  })

  it('not moving: the sign-in AND the switch card’s reason are both named', () => {
    const t = text(allHeld({ kind: 'switch-off' }, [signIn], notSignedIn))
    expect(t).not.toContain('Not a fault')
    expect(t).toMatch(/@b is not signed in on Studio/)
    expect(t).toMatch(/nothing goes out while Autopilot is off/)
  })

  it('the sending Mac is offline: the sign-in is what it reported when it was last online', () => {
    const t = text(allHeld({ kind: 'mac-offline', mac: 'Studio' }, [signIn], { ...notSignedIn, macOnline: false }))
    expect(t).not.toContain('Not a fault')
    expect(t).toMatch(/@b was not signed in on Studio, the sending Mac, when it was last online/)
    expect(t).toMatch(/Studio — the sending Mac — is not online/)
  })

  it('no sign-in hold: a moving all-held queue is still "not a fault" and still sends itself (the other direction)', () => {
    const t = text(allHeld({ kind: 'moving', mac: 'Studio' }, [clocked], null))
    expect(t).toContain('Not a fault')
    expect(t).toMatch(/each draft below sends itself when its window clears/)
    expect(t).not.toMatch(/not signed in on Studio/)
  })
})
