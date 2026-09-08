/**
 * anonGate.ts — ONE gate for every anonymous Instagram request this host makes.
 *
 * WHY THIS EXISTS (measured 7 Sept 2026). From 4 Sept 03:00 IST Instagram answered the
 * anonymous feed endpoint with `HTTP 401 {"message":"Please wait a few minutes before you
 * try again.","require_login":true}` — from the Linode AND from the home Mac, on the feed
 * endpoint AND the profile endpoint. `feed.ts` treated a 401 as an ordinary per-channel
 * failure (only 429 was named a rate limit), `pipeline.ts` logged `channel failed` and moved
 * on to the next channel, so every 15-minute pass fired ~19 requests at an IP Instagram had
 * just told to wait. The IP never got its "few minutes": successful feed pages went
 * 3,388/day → 6/day, posts stored 730 → 8, prospects minted 0, drafts written 0, and the
 * pass still stamped `detectLastOkAt` fresh because it did not THROW. Three days, no alarm.
 *
 * The throttle is PER IP, not per client (curl and Node both 401 from the same address; one
 * request after ~14 minutes of silence returned 200; five quick probes re-tripped it) and it
 * is shared by every endpoint we touch anonymously. So the gate is HOST-WIDE, not per module:
 * a throttle seen by the feed fetch stops the badge door, brand discovery and the existence
 * probe too, and vice versa. A per-module latch (`resolveBrand.ts` had one) cannot see a
 * throttle another module earned a second earlier.
 *
 * THE SHAPE: a throttle response opens a cooldown; while it is open EVERY caller refuses
 * WITHOUT a network request; a repeat throttle straight after a cooldown doubles the next
 * one (15 → 30 → 60 → 120 minutes, capped); one successful response resets the ladder.
 * That is the shortest halt Instagram's own message permits, and nothing longer — the
 * remedy for "wait a few minutes" is exactly that, not a stop that needs a person.
 *
 * NEVER a verdict. A throttled call is "we could not ask" — it must land as UNKNOWN /
 * unreachable / `skipped`, never as "no posts", "not a brand" or "does not exist".
 * Decision 4 stands: no cookie, no session, no proxy. The lever is volume and patience.
 */
import { hostname } from 'node:os'
import { prisma } from '@/lib/db'
import { log } from '@/lib/logger'

/** Setting keys the pipeline stamps and `readPassHealth` reads — output, not liveness. */
export const DETECT_FEED_OK_KEY = 'detectFeedOkAt'
export const DETECT_THROTTLED_KEY = 'detectThrottledUntil'

/**
 * Cooldown per consecutive throttle. Index = strikes - 1, clamped to the last entry. Capped
 * at an hour on purpose: each retry costs ONE request, and the cost of a longer cap is an
 * extra hour of blindness after Instagram has already relented.
 */
export const ANON_THROTTLE_STEPS_MS: readonly number[] = [15, 30, 60].map((m) => m * 60_000)

export interface AnonGateState {
  throttledUntil: number | null
  /** Consecutive throttles with no successful response between them. */
  strikes: number
  lastOkAt: number | null
  lastThrottleAt: number | null
  lastThrottleSource: string | null
}

export const EMPTY_ANON_STATE: AnonGateState = {
  throttledUntil: null,
  strikes: 0,
  lastOkAt: null,
  lastThrottleAt: null,
  lastThrottleSource: null,
}

/**
 * Is this response Instagram telling us to stop? 429 always. 401 always — there is no
 * legitimate per-handle 401 on these anonymous endpoints; the only one Instagram sends is
 * the login wall ("Please wait a few minutes…", `require_login: true`), and a 401 read as a
 * per-channel failure is precisely the bug this module exists to end. 403 only when the
 * body says so, because a gated account can also 403.
 */
export function isThrottleResponse(status: number, body: string): boolean {
  if (status === 429 || status === 401) return true
  if (status === 403) return /require_login|wait a few minutes/i.test(body)
  return false
}

export function isThrottled(state: AnonGateState, now: number): boolean {
  return state.throttledUntil !== null && now < state.throttledUntil
}

export function noteThrottle(state: AnonGateState, now: number, source: string): AnonGateState {
  const strikes = state.strikes + 1
  const step = ANON_THROTTLE_STEPS_MS[Math.min(strikes, ANON_THROTTLE_STEPS_MS.length) - 1]!
  return { ...state, strikes, throttledUntil: now + step, lastThrottleAt: now, lastThrottleSource: source }
}

export function noteSuccess(state: AnonGateState, now: number): AnonGateState {
  return { ...state, strikes: 0, throttledUntil: null, lastOkAt: now }
}

// ── The process-wide instance ──────────────────────────────────────────────────────────

/**
 * TWO SCOPES, NOT ONE (8 Sept 2026). The feed endpoint and the profile endpoint are throttled
 * SEPARATELY by Instagram: the Linode has answered 429 on every profile lookup for weeks while
 * its feed reads were served the same minute. A host-wide gate turned that permanent 429 into a
 * 15→30→60-minute feed blackout on every pass — the pass ended by asking one profile, was told
 * no, and closed the door the feed had just walked through. A throttle on one scope binds only
 * that scope. Both are still per HOST, because Instagram counts the address within a scope.
 */
export type AnonScope = 'feed' | 'profile'
export function scopeOf(source: string): AnonScope {
  return source === 'feed' ? 'feed' : 'profile'
}

let states: Record<AnonScope, AnonGateState> = { feed: { ...EMPTY_ANON_STATE }, profile: { ...EMPTY_ANON_STATE } }
let clock: () => number = () => Date.now()

/** Tests inject a clock; production never calls this. */
export function setAnonGateClock(fn?: () => number): void {
  clock = fn ?? (() => Date.now())
}

/**
 * Forget the cooldown. Production caller: `resetBrandResolverLimit`, i.e. a PERSON typing
 * `ig:brands --run` has decided to try — the same decision that clears the module latch.
 */
export function resetAnonGate(): void {
  states = { feed: { ...EMPTY_ANON_STATE }, profile: { ...EMPTY_ANON_STATE } }
}

export function anonGateSnapshot(scope: AnonScope = 'feed'): AnonGateState {
  return { ...states[scope] }
}

export type AnonGateVerdict = { ok: true } | { ok: false; until: Date; strikes: number }

/** Ask BEFORE spending a request. `ok: false` means make no network call at all. */
export function anonGateCheck(scope: AnonScope = 'feed'): AnonGateVerdict {
  const now = clock()
  const state = states[scope]
  if (isThrottled(state, now)) {
    return { ok: false, until: new Date(state.throttledUntil!), strikes: state.strikes }
  }
  return { ok: true }
}

/** Record a throttle response. Returns when the cooldown ends. Logs once per throttle. */
export function anonGateRecordThrottle(source: string, status: number): Date {
  const now = clock()
  const scope = scopeOf(source)
  const state = (states[scope] = noteThrottle(states[scope], now, source))
  const until = new Date(state.throttledUntil!)
  log.alarm(`Instagram is refusing anonymous ${scope} reads from this host — halting ${scope} lookups`, {
    source,
    status,
    strikes: state.strikes,
    cooldownMinutes: Math.round((state.throttledUntil! - now) / 60_000),
    until: until.toISOString(),
  })
  void persist()
  return until
}

/** Record a successful anonymous response — resets the ladder. */
export function anonGateRecordSuccess(source: string): void {
  const scope = scopeOf(source)
  const before = states[scope]
  const hadTrouble = before.strikes > 0 || before.throttledUntil !== null
  states[scope] = noteSuccess(before, clock())
  if (hadTrouble) {
    log.info('anonymous reads recovered', { source, scope })
    void persist()
  }
}

// ── Persistence: survives a process restart, and is what the dashboard reads ──────────

export function anonGateHost(): string {
  return process.env.DS_DEVICE_NAME ?? hostname()
}

export function anonGateSettingKey(host: string = anonGateHost()): string {
  return `anonThrottle:${host}`
}

async function persist(): Promise<void> {
  // Recording the state must never fail the lookup that caused it — nor a test that mocks
  // the database without a `setting` table, which throws BEFORE any promise exists.
  try {
    const key = anonGateSettingKey()
    const value = JSON.stringify(states)
    await prisma.setting.upsert({ where: { key }, update: { value }, create: { key, value } })
  } catch {
    // deliberately silent
  }
}

/**
 * Adopt a persisted cooldown after a restart. Without this, pm2 recycling the worker
 * mid-cooldown (it happens — memory ceilings) would forget the throttle and resume
 * hammering, which is exactly the self-perpetuating state this module ends. Only a
 * FUTURE cooldown is adopted; stale rows are ignored rather than trusted.
 */
export async function hydrateAnonGate(): Promise<void> {
  const row = await prisma.setting.findUnique({ where: { key: anonGateSettingKey() } }).catch(() => null)
  if (!row) return
  try {
    const parsed = JSON.parse(row.value) as Record<string, Partial<AnonGateState>>
    // Rows written before the split carried ONE host-wide state. It lands in the scope its
    // source names — MEASURED 8 Sept 13:30: a legacy row earned by the Linode's permanent
    // profile 429s was read as a FEED cooldown and skipped a whole pass while a direct feed
    // probe from the same host returned 12 items. Absence of a source means profile, the
    // scope that has actually been refused on the server for weeks; the feed is never blamed
    // on evidence that does not name it.
    const legacy = !('feed' in parsed) && !('profile' in parsed)
    const legacyState = parsed as unknown as Partial<AnonGateState>
    const perScope: Partial<Record<AnonScope, Partial<AnonGateState>>> = legacy
      ? { [legacyState.lastThrottleSource === 'feed' ? 'feed' : 'profile']: legacyState }
      : (parsed as Partial<Record<AnonScope, Partial<AnonGateState>>>)
    for (const scope of ['feed', 'profile'] as AnonScope[]) {
      const saved = perScope[scope]
      if (!saved) continue
      const state = states[scope]
      const until = typeof saved.throttledUntil === 'number' ? saved.throttledUntil : null
      if (until !== null && until > clock() && (state.throttledUntil === null || until > state.throttledUntil)) {
        states[scope] = {
          ...state,
          throttledUntil: until,
          strikes: Math.max(state.strikes, typeof saved.strikes === 'number' ? saved.strikes : 1),
          lastThrottleAt: typeof saved.lastThrottleAt === 'number' ? saved.lastThrottleAt : state.lastThrottleAt,
          lastThrottleSource: typeof saved.lastThrottleSource === 'string' ? saved.lastThrottleSource : state.lastThrottleSource,
        }
        log.step('resuming a cooldown recorded before this process started', {
          scope,
          until: new Date(until).toISOString(),
          strikes: states[scope].strikes,
        })
      }
    }
  } catch {
    // an unreadable row is not a cooldown
  }
}
