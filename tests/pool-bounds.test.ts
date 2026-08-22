import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// From `dbPool.ts`, never from `db.ts`: importing `db.ts` CONSTRUCTS a PrismaClient at module
// load. The first version of this file did exactly that and broke `tests/auto-resolve.test.ts`,
// which owns its own temporary database — a test about connection budgets opening a stray
// connection to ask what the budget is.
import { POSTGRES_POOL_IDLE_MS, POSTGRES_POOL_MAX } from '../src/lib/dbPool'

/**
 * THE POSTGRES POOL IS BOUNDED, AND NOTHING BEHAVIOURAL CAN FAIL WHEN IT IS NOT.
 *
 * On 2026-08-22 the live server ran out of connections: 98 of 100 slots used, 83 held against
 * this database, 82 of them idle. The scheduler then threw at the top level on every
 * 15-minute pass — detection, the dispatcher and the slot — and the planner wrote no draft
 * for 158 minutes while the fleet sat quiet behind hold reasons that were all individually
 * true.
 *
 * The cause was a DEFAULT: `PrismaPg` forwards its config to `new pg.Pool(...)`, whose `max`
 * is 10, and production builds one PrismaClient — so one pool — PER NEXT ROUTE BUNDLE.
 *
 * A unit test cannot watch a pool exhaust a server it is not connected to, and by the time
 * one could, the fleet is already down. So this is a SOURCE GREP over the single construction
 * site plus bounds on the constants: the shape this repo uses whenever the failure mode is a
 * value somebody deletes rather than a branch somebody breaks.
 */
describe('the postgres pool is bounded', () => {
  const source = readFileSync(join(__dirname, '..', 'src', 'lib', 'db.ts'), 'utf8')

  it('passes both bounds to the one PrismaPg construction', () => {
    // Match the whole `new PrismaPg({...})` call, so a SECOND construction site added later
    // without bounds fails this rather than hiding behind the first one.
    const constructions = source.match(/new PrismaPg\(\{[\s\S]*?\}\)/g) ?? []
    expect(constructions).toHaveLength(1)

    const [only] = constructions
    expect(only).toContain('max: POSTGRES_POOL_MAX')
    expect(only).toContain('idleTimeoutMillis: POSTGRES_POOL_IDLE_MS')
  })

  it('keeps a whole production build inside the server budget', () => {
    // `max` is per BUNDLE, not per process. The live incident was ~8 bundles; 12 is the
    // headroom this assertion buys. The server is max_connections=100 and is SHARED with six
    // other pm2 apps, so this application's worst case has to leave most of the table free.
    const BUNDLES_A_BUILD_MAY_REASONABLY_HAVE = 12
    expect(POSTGRES_POOL_MAX * BUNDLES_A_BUILD_MAY_REASONABLY_HAVE).toBeLessThanOrEqual(60)
  })

  it('leaves enough connections to serve a page', () => {
    // The other direction, and the reason this is not simply 1: a pool of one serialises every
    // statement and, if a connection is ever checked out and not returned, DEADLOCKS the
    // bundle instead of erroring. A guard that turns an outage into a hang is not an
    // improvement — the hang is the harder of the two to diagnose.
    expect(POSTGRES_POOL_MAX).toBeGreaterThanOrEqual(3)
  })

  it('gives idle connections back rather than holding them for the process lifetime', () => {
    expect(POSTGRES_POOL_IDLE_MS).toBeGreaterThan(0)
    expect(POSTGRES_POOL_IDLE_MS).toBeLessThanOrEqual(60_000)
  })
})
