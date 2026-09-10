import { describe, it, expect } from 'vitest'
import { resolveConnectTarget, connectTargetProblem } from '@/outreach/connectRelay'

/**
 * Which Mac opens a sign-in window is which home IP an Instagram account is signed in from,
 * so it is never resolved by heartbeat order (2026-09-10 — the first Connect a new operator
 * pressed went to the Mac that already held the account). Both directions, because the
 * permissive one is the bug.
 */
describe('resolveConnectTarget', () => {
  it('one Mac online and none named: that Mac', () => {
    expect(resolveConnectTarget(undefined, ['tabish-mac'])).toEqual({ ok: true, device: 'tabish-mac' })
  })

  it('two Macs online and none named: REFUSED, never the freshest', () => {
    expect(resolveConnectTarget(undefined, ['DMPLs Mac Studio', 'tabish-mac'])).toEqual({ ok: false, reason: 'ambiguous' })
    expect(resolveConnectTarget('', ['DMPLs Mac Studio', 'tabish-mac'])).toEqual({ ok: false, reason: 'ambiguous' })
  })

  it('a named Mac that is online wins, whatever else is online', () => {
    expect(resolveConnectTarget('DMPLs Mac Studio', ['tabish-mac', 'DMPLs Mac Studio'])).toEqual({ ok: true, device: 'DMPLs Mac Studio' })
  })

  it('a named Mac that is not beating is refused rather than queued for nobody', () => {
    expect(resolveConnectTarget('DMPLs Mac Studio', ['tabish-mac'])).toEqual({ ok: false, reason: 'named-offline' })
  })

  it('nobody online is its own answer', () => {
    expect(resolveConnectTarget(undefined, [])).toEqual({ ok: false, reason: 'none-online' })
  })

  it('the refusal names the Macs so the fix is one click', () => {
    const text = connectTargetProblem({ ok: false, reason: 'ambiguous' }, undefined, ['A', 'B'])
    expect(text).toContain('A, B')
    expect(text).toMatch(/choose/)
    expect(connectTargetProblem({ ok: false, reason: 'named-offline' }, 'B', ['A'])).toContain('B is not online')
  })
})
