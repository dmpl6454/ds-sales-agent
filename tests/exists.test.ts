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
