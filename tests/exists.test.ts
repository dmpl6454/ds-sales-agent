import { describe, it, expect } from 'vitest'
import { interpretExistence } from '@/detection/exists'

/**
 * "Does this handle exist?" — a guard that could not fail until 2026-08-05.
 *
 * It fetched `instagram.com/<handle>/` and read the HTTP status. **Instagram returns 200
 * for a handle that does not exist**: it serves the SPA shell and renders "Sorry, this page
 * isn't available" client-side. MEASURED — `@instagram` and `@qqqq_nope_nope_12345` came
 * back 200 with bodies of 609,393 and 609,403 bytes, ten bytes apart.
 *
 * So `'missing'` was unreachable, `addTarget`'s "does not exist on Instagram" came from a
 * branch no input could reach, and the import built on it would have created a row for
 * every typo. The same trap CLAUDE.md already records for `/api/v1/accounts/current_user/`:
 * a www path answering 200 with the shell instead of the JSON its caller assumed.
 *
 * The decision is pure so BOTH directions are testable without the network — which is
 * exactly what the previous version never had.
 */

describe('interpretExistence', () => {
  it('200 means the account is there', () => {
    expect(interpretExistence(200, '')).toBe('exists')
  })

  /** The direction that was unreachable for the entire life of this function. */
  it('404 means it is not — MEASURED against web_profile_info', () => {
    expect(interpretExistence(404, '<!DOCTYPE html>')).toBe('missing')
  })

  /**
   * Meta's own deleted business-category schema. The account EXISTS and Instagram cannot
   * serialise its category — documented at length in `resolveBrand.ts`, where it is known
   * to break on precisely the accounts most likely to be brands (`@netflix_in`,
   * `@tseries.official`). Reading it as absence would discard real prospects permanently.
   *
   * MEASURED: `madovermarketing_mom` returns exactly this.
   */
  it('400 with the deleted-schema message means the account EXISTS', () => {
    const body =
      '{"message":"Asset asset://laser.provider/ig_business_category_subvertical has been deleted. You cannot use this schema","status":"fail"}'
    expect(interpretExistence(400, body)).toBe('exists')
  })

  /**
   * A 400 for any OTHER reason is something we do not understand, and answering "exists"
   * to it would be guessing in the permissive direction — which is how a typo becomes a
   * permanent row nobody can explain.
   */
  it('an unrecognised 400 is unknown, not exists', () => {
    expect(interpretExistence(400, '{"message":"something else entirely"}')).toBe('unknown')
  })

  /**
   * Throttling is not absence. Reporting "that account does not exist" because we were
   * rate-limited is absence-of-data hardening into a negative verdict — the failure mode
   * `resolveBrand` has a five-outcome table to prevent.
   */
  it('429 is unknown', () => expect(interpretExistence(429, '')).toBe('unknown'))
  it('401 is unknown', () => expect(interpretExistence(401, '')).toBe('unknown'))
  it('403 is unknown', () => expect(interpretExistence(403, '')).toBe('unknown'))
  it('500 is unknown', () => expect(interpretExistence(500, '')).toBe('unknown'))

  it('never confuses unknown with missing', () => {
    for (const status of [401, 403, 429, 500, 502, 503]) {
      expect(interpretExistence(status, ''), `status ${status}`).not.toBe('missing')
    }
  })
})

/**
 * The identity facts a 200 carries — the half `handleExists` used to THROW AWAY.
 *
 * The measurement that forced this (2026-08-20): "filmigyan" EXISTS — a 219-follower fan
 * page reading "4K FOLLOWERS ON MAIN PAGE" — while the page Tabish meant is @filmygyan,
 * 31,619,942 followers, verified. A yes/no existence check passes both identically, so the
 * wrong watch channel would have entered the corpus silently and its CAMPAIGN verdicts
 * would mint real prospects that get real DMs. The fixture bodies are the REAL payload
 * shape from web_profile_info, trimmed.
 */
import { parseHandleFacts } from '@/detection/exists'
import { addTargetMessage } from '@/app/add-target-message'

describe('parseHandleFacts', () => {
  const body = (user: unknown) => JSON.stringify({ data: { user } })

  it('pulls name, badge and followers from the real payload shape', () => {
    expect(
      parseHandleFacts(
        body({
          full_name: 'F I L M Y G Y A N',
          is_verified: true,
          edge_followed_by: { count: 31_619_942 },
        }),
      ),
    ).toEqual({ name: 'F I L M Y G Y A N', verified: true, followers: 31_619_942 })
  })

  /** Absent fields are null facts, never inventions — absence of data is not a verdict. */
  it('missing fields become null, not guesses', () => {
    expect(parseHandleFacts(body({ full_name: '  ' }))).toEqual({
      name: null,
      verified: null,
      followers: null,
    })
  })

  it('an unreadable body is null facts, never a throw', () => {
    expect(parseHandleFacts('<!DOCTYPE html>')).toBeNull()
    expect(parseHandleFacts(JSON.stringify({ data: {} }))).toBeNull()
  })
})

describe('addTargetMessage', () => {
  const filmygyan = { name: 'F I L M Y G Y A N', verified: true, followers: 31_619_942 }
  const fanPage = { name: 'BOLLYWOOD | NEWS | PAPARAZZI', verified: false, followers: 219 }

  /**
   * THE SENTENCE MUST MATCH THE ROLE. The old copy promised "The fleet will write to them"
   * for every add — false for a WATCH page, whose definition is that it is never written
   * to. The negative assertion is the one carrying weight.
   */
  it('a WATCH add never claims the fleet will write to them', () => {
    const msg = addTargetMessage('WATCH', 'filmygyan', 'exists', filmygyan)
    expect(msg).toContain('never messaged')
    expect(msg).not.toContain('will write to them')
  })

  it('a PROSPECT add says exactly that', () => {
    const msg = addTargetMessage('PROSPECT', 'crocsindia', 'exists', {
      name: 'Crocs India',
      verified: true,
      followers: 100_000,
    })
    expect(msg).toContain('will write to them while Autopilot is on')
  })

  /** The identity line is the point: the wrong account must be visible at the moment of the add. */
  it('carries who Instagram says it is, including NOT verified', () => {
    const msg = addTargetMessage('WATCH', 'filmigyan', 'exists', fanPage)
    expect(msg).toContain('“BOLLYWOOD | NEWS | PAPARAZZI”')
    expect(msg).toContain('219 followers')
    expect(msg).toContain('NOT verified')
  })

  it('null facts render as "could not read who this is", never silently', () => {
    const msg = addTargetMessage('WATCH', 'rvcjinsta', 'exists', null)
    expect(msg).toContain('could not say who this is')
  })

  it('an unreached Instagram says so and points at the spelling', () => {
    const msg = addTargetMessage('WATCH', 'sacrasm', 'unknown', null)
    expect(msg).toContain('could not be reached')
    expect(msg).toContain('spelling')
  })
})
