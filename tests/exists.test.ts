import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  interpretExistence,
  notFoundBelief,
  showsRealPage,
  probeHandle,
  resetExistenceWitness,
  setExistenceClock,
  CONTROL_HANDLE,
  CONTROL_RETRY_MS,
  ENDPOINT_WITNESS_MS,
} from '@/detection/exists'
import { anonGateCheck, resetAnonGate, setAnonGateClock } from '@/detection/anonGate'
import { setIgTransportForTests, type IgResponse } from '@/detection/igHttp'

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

/**
 * ── A "NOT FOUND" IS BELIEVED ONLY WHILE THE ENDPOINT IS SEEN TO SERVE REAL PAGES (18 Nov 2026) ──
 *
 * That day this lookup answered 404 for forty verified companies and the sending Mac parked a
 * message to every one of them, no browser opened. The answer was about the endpoint.
 *
 * MUTATIONS, each applied by hand to src/detection/exists.ts, seen red, restored:
 *   - the `check === 'missing' && !(await notFoundIsBelievable(handle))` line deleted → every
 *     "is unknown" case below goes red (the 18 Nov behaviour);
 *   - `notFoundBelief` made to return 'believe' always → the same cases, plus the pure table;
 *   - the `showsRealPage` test in the control replaced by `res.status === 200` → the empty-200 case;
 *   - `controlFailedAt` never written → "asks the control once per retry window" (it asks every time);
 *   - the witness never written from an ordinary probe → "a real page seen … vouches" (a control
 *     request is spent that the witness should have saved).
 */
const REAL_PAGE = JSON.stringify({ data: { user: { full_name: 'Instagram', is_verified: true, edge_followed_by: { count: 1 } } }, status: 'ok' })
const SCHEMA_400 = '{"message":"Asset asset://laser.provider/ig_business_category_subvertical has been deleted. You cannot use this schema","status":"fail"}'

describe('notFoundBelief — may a 404 be read as "the page is gone" right now?', () => {
  const T = 1_800_000_000_000
  it('with nothing seen yet, the control must be asked', () => {
    expect(notFoundBelief({ lastPositiveAt: null, controlFailedAt: null }, T)).toBe('ask-control')
  })
  it('a real page seen inside the window vouches; at the boundary it no longer does', () => {
    expect(notFoundBelief({ lastPositiveAt: T - 1, controlFailedAt: null }, T)).toBe('believe')
    expect(notFoundBelief({ lastPositiveAt: T - ENDPOINT_WITNESS_MS + 1, controlFailedAt: null }, T)).toBe('believe')
    expect(notFoundBelief({ lastPositiveAt: T - ENDPOINT_WITNESS_MS, controlFailedAt: null }, T)).toBe('ask-control')
  })
  it('a failed control means doubt, without asking again, until the retry window ends', () => {
    expect(notFoundBelief({ lastPositiveAt: null, controlFailedAt: T - 1 }, T)).toBe('doubt')
    expect(notFoundBelief({ lastPositiveAt: null, controlFailedAt: T - CONTROL_RETRY_MS }, T)).toBe('ask-control')
  })
  it('a fresh real page outranks an older failed control', () => {
    expect(notFoundBelief({ lastPositiveAt: T - 10, controlFailedAt: T - 20 }, T)).toBe('believe')
  })
  it('a timestamp in the future vouches for nothing', () => {
    expect(notFoundBelief({ lastPositiveAt: T + 60_000, controlFailedAt: null }, T)).toBe('ask-control')
    expect(notFoundBelief({ lastPositiveAt: null, controlFailedAt: T + 60_000 }, T)).toBe('ask-control')
  })
})

describe('showsRealPage — what counts as the endpoint serving a real page', () => {
  it('a 200 carrying a user does', () => expect(showsRealPage(200, REAL_PAGE)).toBe(true))
  it('the schema-bug 400 does: Instagram found the account', () => expect(showsRealPage(400, SCHEMA_400)).toBe(true))
  it('an EMPTY 200 does not — that is what a gated account returns', () => {
    expect(showsRealPage(200, '{"items":[],"status":"ok"}')).toBe(false)
    expect(showsRealPage(200, '{"data":{"user":null},"status":"ok"}')).toBe(false)
    expect(showsRealPage(200, '<html>shell</html>')).toBe(false)
    expect(showsRealPage(200, '')).toBe(false)
  })
  it('nothing else does', () => {
    for (const status of [400, 401, 403, 404, 429, 500]) expect(showsRealPage(status, 'x')).toBe(false)
  })
})

describe('probeHandle — a not-found needs a witness', () => {
  let now = 1_800_000_000_000
  let asked: string[] = []
  /** Answers per handle; anything not listed is a 404, which is what the endpoint did on 18 Nov. */
  const serve = (answers: Record<string, { status: number; body?: string }>) => {
    setIgTransportForTests(
      vi.fn(async (url: string): Promise<IgResponse> => {
        const handle = decodeURIComponent(url.split('username=')[1] ?? '')
        asked.push(handle)
        const a = answers[handle] ?? { status: 404, body: '' }
        return { status: a.status, ok: a.status >= 200 && a.status < 300, headers: {}, text: async () => a.body ?? '' } as unknown as IgResponse
      }) as never,
    )
  }
  beforeEach(() => {
    now = 1_800_000_000_000
    asked = []
    resetAnonGate()
    setAnonGateClock(() => now)
    resetExistenceWitness()
    setExistenceClock(() => now)
  })
  afterEach(() => {
    setIgTransportForTests()
    setAnonGateClock()
    resetAnonGate()
    setExistenceClock()
    resetExistenceWitness()
  })

  it('18 Nov exactly: the endpoint answers 404 for everything, the control included → unknown, never missing', async () => {
    serve({})
    expect((await probeHandle('ndtv')).check).toBe('unknown')
    expect(asked).toEqual(['ndtv', CONTROL_HANDLE])
  })
  it('and it asks the control once per retry window, not once per draft', async () => {
    serve({})
    for (const h of ['ndtv', 'chumbak', 'gilletteindia', 'lava_mobiles']) expect((await probeHandle(h)).check).toBe('unknown')
    expect(asked.filter((h) => h === CONTROL_HANDLE)).toHaveLength(1)
    now += CONTROL_RETRY_MS
    expect((await probeHandle('mtr_foods')).check).toBe('unknown')
    expect(asked.filter((h) => h === CONTROL_HANDLE)).toHaveLength(2)
  })
  it('the other direction: the control is a real page → the 404 is believed, and the witness is reused', async () => {
    serve({ [CONTROL_HANDLE]: { status: 200, body: REAL_PAGE } })
    expect((await probeHandle('hemantpandeyji')).check).toBe('missing')
    expect((await probeHandle('acearteofficial')).check).toBe('missing')
    expect(asked).toEqual(['hemantpandeyji', CONTROL_HANDLE, 'acearteofficial'])
  })
  it('a real page seen by an ORDINARY probe vouches too — no control request is spent', async () => {
    serve({ royalcanin: { status: 200, body: REAL_PAGE } })
    expect((await probeHandle('royalcanin')).check).toBe('exists')
    expect((await probeHandle('hemantpandeyji')).check).toBe('missing')
    expect(asked).toEqual(['royalcanin', 'hemantpandeyji'])
  })
  it('the schema-bug 400 vouches as well', async () => {
    serve({ netflix_in: { status: 400, body: SCHEMA_400 } })
    expect((await probeHandle('netflix_in')).check).toBe('exists')
    expect((await probeHandle('hemantpandeyji')).check).toBe('missing')
    expect(asked).not.toContain(CONTROL_HANDLE)
  })
  it('the witness expires: half an hour later the control is asked again', async () => {
    serve({ royalcanin: { status: 200, body: REAL_PAGE } })
    await probeHandle('royalcanin')
    now += ENDPOINT_WITNESS_MS
    expect((await probeHandle('hemantpandeyji')).check).toBe('unknown')
    expect(asked).toEqual(['royalcanin', 'hemantpandeyji', CONTROL_HANDLE])
  })
  it('an EMPTY 200 for the control is not a witness', async () => {
    serve({ [CONTROL_HANDLE]: { status: 200, body: '{"data":{"user":null},"status":"ok"}' } })
    expect((await probeHandle('ndtv')).check).toBe('unknown')
  })
  it('a throttled control vouches for nothing and closes the gate, so nothing is asked next time', async () => {
    serve({ [CONTROL_HANDLE]: { status: 429 } })
    expect((await probeHandle('ndtv')).check).toBe('unknown')
    expect(anonGateCheck('profile').ok).toBe(false)
    expect((await probeHandle('chumbak')).check).toBe('unknown')
    expect(asked).toEqual(['ndtv', CONTROL_HANDLE])
  })
  it('a 404 for the control handle itself is the control failing, with no second request', async () => {
    serve({})
    expect((await probeHandle(CONTROL_HANDLE)).check).toBe('unknown')
    expect(asked).toEqual([CONTROL_HANDLE])
    expect((await probeHandle('ndtv')).check).toBe('unknown')
    expect(asked).toEqual([CONTROL_HANDLE, 'ndtv'])
  })
  it('a control that cannot be reached is not recorded as a failure: the next probe asks again', async () => {
    setIgTransportForTests(
      vi.fn(async (url: string): Promise<IgResponse> => {
        const handle = decodeURIComponent(url.split('username=')[1] ?? '')
        asked.push(handle)
        if (handle === CONTROL_HANDLE) throw new Error('socket hang up')
        return { status: 404, ok: false, headers: {}, text: async () => '' } as unknown as IgResponse
      }) as never,
    )
    expect((await probeHandle('ndtv')).check).toBe('unknown')
    expect((await probeHandle('chumbak')).check).toBe('unknown')
    expect(asked.filter((h) => h === CONTROL_HANDLE)).toHaveLength(2)
  })
  it('exists and unknown are untouched by any of this', async () => {
    serve({ royalcanin: { status: 200, body: REAL_PAGE }, slow: { status: 500 } })
    expect(await probeHandle('royalcanin')).toMatchObject({ check: 'exists', facts: { name: 'Instagram', verified: true } })
    expect((await probeHandle('slow')).check).toBe('unknown')
    expect(asked).toEqual(['royalcanin', 'slow'])
  })
})
