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

const render = (motion: QueueMotion, rows = upNext) =>
  renderToStaticMarkup(
    createElement(WaitingList, { upNext: rows, heldWaiting: 1, heldUpNext, total: rows.length + 1, motion, resting: null }),
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
