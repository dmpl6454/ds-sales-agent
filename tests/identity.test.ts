import { describe, expect, it } from 'vitest'
import { readIdentityResponse } from '@/outreach/browser/session'

/**
 * The identity lookup, and the bug this file exists to keep fixed.
 *
 * MEASURED 2026-08-06 against the live @tabishmukaddam1 profile, signed in, page title
 * "(1) Instagram" (an unread-DM badge only a logged-in session renders):
 *
 *   GET www.instagram.com/api/v1/users/2871102548/info/
 *     → HTTP 200, content-type text/html, 627,698 bytes (the SPA shell)
 *
 * `identify()` read that as `{ kind: 'logged-out' }`, because its one check was
 * `if (!res.ok() || !contentType.includes('json')) return { kind: 'logged-out' }`.
 * A DEAD ENDPOINT became a positive claim about the account, and the claim travelled:
 * Connect polled forever, every send threw NotLoggedInError, and §3.5 RECORDED the live
 * session as dead (`sessionInvalidAt`, 2026-08-06 09:58) — which halts the account
 * through the gate's `no-session` stop and tells the operator to perform the single
 * riskiest act in this design, a re-login, on evidence nobody ever gathered.
 *
 * Same family as `/api/v1/accounts/current_user/` (CLAUDE.md), one endpoint over, and the
 * same shape as `resolveBrand` reading one broken handle as a run-wide rate limit:
 * **"I could not ask" collapsing into "the answer is no".**
 *
 * So `logged-out` is now claimed ONLY from positive evidence, and everything else is
 * `no-answer` — which the caller turns into `unknown`, never into a verdict.
 */
describe('readIdentityResponse', () => {
  const HTML = '<!DOCTYPE html><html class="_9dls" lang="en"><head><meta charset="utf-8" />'

  it('reads the username out of the endpoint that actually works', () => {
    // Real body prefix, www.instagram.com/api/v1/accounts/edit/web_form_data/
    const body = JSON.stringify({
      form_data: { first_name: 'Tabish Mukaddam', email: 'x@y.com', username: 'tabishmukaddam1' },
      status: 'ok',
    })
    expect(readIdentityResponse(200, 'application/json; charset=utf-8', body)).toEqual({
      kind: 'logged-in',
      username: 'tabishmukaddam1',
    })
  })

  it('reads the username from users/<id>/info/ too, if it ever answers again', () => {
    const body = JSON.stringify({ user: { username: 'BollywoodSocietyy' }, status: 'ok' })
    expect(readIdentityResponse(200, 'application/json', body)).toEqual({
      kind: 'logged-in',
      username: 'bollywoodsocietyy',
    })
  })

  /** THE REGRESSION. This exact response marked a live session dead. */
  it('does NOT read 200-with-HTML as logged out — that is a dead endpoint, not a verdict', () => {
    const r = readIdentityResponse(200, 'text/html; charset="utf-8"', HTML)
    expect(r.kind).toBe('no-answer')
  })

  /**
   * i.instagram.com/api/v1/users/<id>/info/ returned HTTP 200 with
   * {"message":"…something went wrong…","status_code":"200","status":"fail"} — JSON, and
   * an OK status, carrying no answer. A content-type check alone waves this through.
   */
  it('does NOT read a JSON body with status:fail as logged out', () => {
    const body = JSON.stringify({ message: 'something went wrong', status_code: '200', status: 'fail' })
    expect(readIdentityResponse(200, 'application/json; charset=utf-8', body).kind).toBe('no-answer')
  })

  it('does NOT read well-formed JSON with no username as logged out', () => {
    expect(readIdentityResponse(200, 'application/json', JSON.stringify({ user: {} })).kind).toBe('no-answer')
  })

  it('does NOT read unparseable JSON as logged out', () => {
    expect(readIdentityResponse(200, 'application/json', '{ truncated').kind).toBe('no-answer')
  })

  /**
   * Being told to slow down says nothing about who is signed in. Reading it as logged-out
   * would mark the session dead and send the operator to re-login mid-throttle.
   */
  it('does NOT read a throttle as logged out', () => {
    expect(readIdentityResponse(429, 'application/json', '{"message":"rate limited"}').kind).toBe('no-answer')
    expect(readIdentityResponse(500, 'text/html', HTML).kind).toBe('no-answer')
  })

  /**
   * The ONE positive logged-out answer available from a response: Instagram saying the
   * request is not authenticated. 401/403 is a statement about the session; HTML is not.
   */
  it('DOES read an explicit 401 as logged out', () => {
    expect(readIdentityResponse(401, 'application/json', '{"message":"login_required"}').kind).toBe('logged-out')
  })

  it('DOES read a login_required body as logged out', () => {
    const body = JSON.stringify({ message: 'login_required', status: 'fail' })
    expect(readIdentityResponse(400, 'application/json', body).kind).toBe('logged-out')
  })

  /** Usernames are compared against a handle, so case must never decide identity. */
  it('lowercases the username it returns', () => {
    const body = JSON.stringify({ form_data: { username: 'TabishMukaddam1' } })
    expect(readIdentityResponse(200, 'application/json', body)).toEqual({
      kind: 'logged-in',
      username: 'tabishmukaddam1',
    })
  })
})

/**
 * The DOM check that gives `logged-out` positive evidence when no endpoint answers.
 *
 * Needed because a REVOKED session keeps its `sessionid` on disk, so "cookie present but
 * no endpoint answered" is ambiguous between a dead session and a dead endpoint. §3.5
 * must keep catching the first without inventing the second.
 *
 * MEASURED 2026-08-06 at https://www.instagram.com/ on both profiles:
 *   signed in  → input[type=password] 0,  title "(1) Instagram"
 *   logged out → input[type=password] 1,  title "Instagram"
 * and, worth keeping because it would have been the obvious guess:
 *   input[name=password] and form#loginForm are 0 in BOTH states — the classic selectors
 *   never fire on Instagram's current DOM, so a check built on them could not work.
 */
describe('looksLoggedOut', () => {
  it('a password field on instagram.com means logged out', async () => {
    const { looksLoggedOut } = await import('@/outreach/browser/session')
    expect(looksLoggedOut(1)).toBe(true)
  })

  it('no password field is NOT evidence of anything', async () => {
    const { looksLoggedOut } = await import('@/outreach/browser/session')
    expect(looksLoggedOut(0)).toBe(false)
  })
})
