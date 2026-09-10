import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { decideRefresh } from '../src/app/refresh-decision'
import { composeStamp, PULSE_IGNORED_SETTING_KEYS, type PulseParts } from '../src/app/api/pulse/stamp'

/**
 * THE DASHBOARD RE-RENDERS ON CHANGE, NOT ON A CLOCK.
 *
 * On 2026-09-04 the hosted web process was OOM-killed twice (773 MB and 607 MB anon-rss) on
 * a box where one render costs +22..32 MB of heap. The memory was a pile-up: a starved render
 * took over 60 s, tabs kept firing `router.refresh()` every 30-45 s regardless, and ten-plus
 * renders were alive at once. The fix has two halves and both are pinned here:
 *
 *   1. `decideRefresh` — PURE — says when a poll may re-render, and it never says so for an
 *      unchanged stamp, for a first stamp, for a hidden tab, or while a refresh is still
 *      running. Each answer is driven in BOTH directions below, because a decision function
 *      that only ever says `skip` would pass a one-sided test and silently stop the page
 *      updating at all — the opposite failure, and the one Tabish reported on 2026-08-19.
 *   2. `composeStamp` — PURE — must move when any input moves and stay still when none does,
 *      or the detector is either blind or a blind timer.
 *
 * And two SOURCE GREPS, because their failure modes are a line somebody re-adds rather than
 * a branch somebody breaks: the old shape (`router.refresh()` called unconditionally on the
 * tick) and a server-only import reaching a `'use client'` file — the `waiting.tsx →
 * gate.ts → better-sqlite3` trap that returned HTTP 500 on every route.
 */

const root = join(__dirname, '..')
const read = (rel: string) => readFileSync(join(root, rel), 'utf8')

describe('decideRefresh — when a poll may re-render the page', () => {
  it('the FIRST stamp is a baseline, never a refresh', () => {
    // The page was server-rendered a moment ago; a refresh on mount is a render for nothing.
    expect(decideRefresh({ prev: null, next: 'a', pending: false, hidden: false })).toBe('baseline')
  })

  it('the same stamp is a skip — an idle dashboard renders nothing', () => {
    expect(decideRefresh({ prev: 'a', next: 'a', pending: false, hidden: false })).toBe('skip')
  })

  it('a changed stamp while a refresh is in flight is a skip — a slow refresh never stacks', () => {
    expect(decideRefresh({ prev: 'a', next: 'b', pending: true, hidden: false })).toBe('skip')
  })

  it('a changed stamp with nothing in flight REFRESHES — the direction a one-sided test would miss', () => {
    expect(decideRefresh({ prev: 'a', next: 'b', pending: false, hidden: false })).toBe('refresh')
  })

  it('a hidden tab is a skip whatever else is true', () => {
    expect(decideRefresh({ prev: 'a', next: 'b', pending: false, hidden: true })).toBe('skip')
    // Hidden outranks baseline too: nothing is recorded for a tab nobody is looking at, so the
    // first poll after it returns sets the baseline afresh.
    expect(decideRefresh({ prev: null, next: 'a', pending: false, hidden: true })).toBe('skip')
  })

  it('an unchanged stamp is a skip even with nothing pending — pending is not what gates the common case', () => {
    expect(decideRefresh({ prev: 'a', next: 'a', pending: true, hidden: false })).toBe('skip')
  })
})

describe('composeStamp — the change detector', () => {
  const base: PulseParts = {
    lastSentAt: new Date('2026-09-04T10:00:00Z'),
    lastQueuedAt: new Date('2026-09-04T09:59:00Z'),
    lastRepliedAt: new Date('2026-09-03T18:00:00Z'),
    inFlight: 12,
    lastDetectedAt: new Date('2026-09-04T10:01:00Z'),
    postCount: 4321,
    settingsUpdatedAt: new Date('2026-09-04T08:00:00Z'),
    settingCount: 19,
    senderUpdatedAt: new Date('2026-09-02T12:00:00Z'),
  }

  it('equal inputs give equal strings — including fresh Date objects for the same instant', () => {
    const copy: PulseParts = { ...base, lastSentAt: new Date(base.lastSentAt!.getTime()) }
    expect(composeStamp(copy)).toBe(composeStamp(base))
  })

  it('moving ANY single part moves the string', () => {
    // Every field, one at a time, against the same baseline — a stamp blind to one column is
    // a page that never refreshes for that kind of change.
    const variants: Array<Partial<PulseParts>> = [
      { lastSentAt: new Date(base.lastSentAt!.getTime() + 1) },
      { lastQueuedAt: new Date(base.lastQueuedAt!.getTime() + 1) },
      { lastRepliedAt: new Date(base.lastRepliedAt!.getTime() + 1) },
      { inFlight: base.inFlight + 1 },
      { lastDetectedAt: new Date(base.lastDetectedAt!.getTime() + 1) },
      { postCount: base.postCount + 1 },
      { settingsUpdatedAt: new Date(base.settingsUpdatedAt!.getTime() + 1) },
      { settingCount: base.settingCount + 1 },
      { senderUpdatedAt: new Date(base.senderUpdatedAt!.getTime() + 1) },
    ]
    expect(variants).toHaveLength(Object.keys(base).length)
    const seen = new Set<string>([composeStamp(base)])
    for (const v of variants) {
      const s = composeStamp({ ...base, ...v })
      expect(s, `unchanged for ${Object.keys(v)[0]}`).not.toBe(composeStamp(base))
      seen.add(s)
    }
    expect(seen.size).toBe(variants.length + 1)
  })

  it('handles null and undefined dates — an empty table has a stable stamp', () => {
    const empty: PulseParts = {
      lastSentAt: null,
      lastQueuedAt: undefined,
      lastRepliedAt: null,
      inFlight: 0,
      lastDetectedAt: undefined,
      postCount: 0,
      settingsUpdatedAt: null,
      settingCount: 0,
      senderUpdatedAt: undefined,
    }
    expect(() => composeStamp(empty)).not.toThrow()
    expect(composeStamp(empty)).toBe(composeStamp({ ...empty }))
    // null and undefined mean the same thing — no row — and must not read as a change.
    expect(composeStamp({ ...empty, lastSentAt: undefined })).toBe(composeStamp(empty))
    // …but a date appearing where there was none IS a change.
    expect(composeStamp({ ...empty, lastSentAt: new Date(0) })).not.toBe(composeStamp(empty))
    expect(composeStamp({ ...empty, lastSentAt: new Date(0) })).not.toContain('null')
  })

  it('cannot collide by concatenation', () => {
    expect(composeStamp({ ...base, inFlight: 1, postCount: 23 })).not.toBe(
      composeStamp({ ...base, inFlight: 12, postCount: 3 }),
    )
  })
})

describe('the excluded Setting keys name what their owners actually write', () => {
  /**
   * The literals live in `stamp.ts` because the route must not import the owning modules
   * (`agent/index.ts` reaches the browser stack, `scheduler.ts` reaches node-cron). A literal
   * can drift from its constant silently — a renamed key would quietly START moving the
   * stamp every 30-60 s and change-detection would become the blind timer again. So each
   * literal is checked against the OWNER'S SOURCE, matching the exact `= '<value>'` shape.
   */
  const owners: Array<[string, string, string]> = [
    ['schedulerHeartbeat', 'src/worker/scheduler.ts', 'HEARTBEAT_KEY'],
    ['devicePresence', 'src/outreach/devicePresence.ts', 'DEVICE_PRESENCE_KEY'],
    ['dispatchState', 'src/outreach/dispatcher.ts', 'DISPATCH_STATE_KEY'],
    ['sendLock', 'src/outreach/dispatcher.ts', 'SEND_LOCK_KEY'],
    ['fleetLastSendStartedAt', 'src/outreach/paceClock.ts', 'LAST_SEND_STARTED_KEY'],
  ]

  it('covers every excluded key exactly once', () => {
    expect([...PULSE_IGNORED_SETTING_KEYS].sort()).toEqual(owners.map((o) => o[0]).sort())
  })

  it.each(owners)('%s is what %s exports as %s', (literal, file, constant) => {
    const src = read(file)
    const declared = src.match(new RegExp(`const ${constant} = '([^']+)'`))?.[1]
    expect(declared, `${constant} not found in ${file}`).toBeDefined()
    expect(declared).toBe(literal)
  })
})

describe('a tab reloads itself after a deploy (2026-09-10)', () => {
  it('the pulse carries the build the server is running', () => {
    expect(read('src/app/api/pulse/route.ts')).toMatch(/build: buildVersion\(\)/)
  })
  it('decideReload: a different live build reloads; same, unknown or hidden skip', async () => {
    const { decideReload } = await import('@/app/refresh-decision')
    expect(decideReload({ rendered: 'abc', live: 'def', hidden: false })).toBe('reload')
    expect(decideReload({ rendered: 'abc', live: 'abc', hidden: false })).toBe('skip')
    expect(decideReload({ rendered: 'abc', live: null, hidden: false })).toBe('skip')
    expect(decideReload({ rendered: 'abc', live: 'unknown', hidden: false })).toBe('skip')
    expect(decideReload({ rendered: 'unknown', live: 'def', hidden: false })).toBe('skip')
    expect(decideReload({ rendered: 'abc', live: 'def', hidden: true })).toBe('skip')
  })
  it('build-watch is a client component that reloads exactly once through the pure decision', () => {
    const src = read('src/app/build-watch.tsx').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    expect(src.trimStart().startsWith("'use client'")).toBe(true)
    expect(src).toMatch(/decideReload\(/)
    expect(src.match(/window\.location\.reload\(\)/g) ?? []).toHaveLength(1)
    expect(src).not.toMatch(/@\/lib\/db|@\/lib\/session|prisma/)
  })
  it('the sidebar mounts it with the build the page was rendered by — on every authenticated page', () => {
    expect(read('src/app/nav.tsx')).toMatch(/<BuildWatch rendered=\{buildVersion\(\)\}/)
  })
  it('the sending-Mac switch and the autopilot toggle catch a stale action and reload', () => {
    for (const f of ['src/app/senders/active-device.tsx', 'src/app/autopilot.tsx']) {
      const src = read(f)
      expect(src, f).toMatch(/isStaleServerAction\(err\)/)
      expect(src, f).toMatch(/reloadForStaleBuild\(\)/)
    }
  })
})

describe('auto-refresh.tsx — the wiring, by source', () => {
  const stripped = read('src/app/auto-refresh.tsx')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')

  it('is a client component', () => {
    expect(stripped.trimStart().startsWith("'use client'")).toBe(true)
  })

  it('calls router.refresh() exactly once, inside the refresh branch and inside a transition', () => {
    const calls = stripped.match(/router\.refresh\(\)/g) ?? []
    expect(calls, 'a second router.refresh() is the old blind shape coming back').toHaveLength(1)

    // The one call is wrapped in startTransition so `isPending` can gate the next tick…
    expect(stripped).toMatch(/startTransition\(\(\) => router\.refresh\(\)\)/)

    // …and it sits inside the `decision === 'refresh'` branch: the check must come BEFORE the
    // call, within the same handful of lines, and nothing else may guard a refresh.
    const branch = stripped.indexOf("decision === 'refresh'")
    const call = stripped.indexOf('router.refresh()')
    expect(branch).toBeGreaterThan(-1)
    expect(call).toBeGreaterThan(branch)
    expect(call - branch).toBeLessThan(200)
  })

  it('has lost the old shape — a refresh guarded only by document.hidden on the tick', () => {
    expect(stripped).not.toMatch(/document\.hidden\)\s*router\.refresh/)
    expect(stripped).not.toMatch(/setInterval\([^)]*router\.refresh/)
  })

  it('asks decideRefresh rather than re-deriving the rule inline', () => {
    expect(stripped).toMatch(/decideRefresh\(/)
    expect(stripped).toMatch(/from '\.\/refresh-decision'/)
  })

  it('polls with no-store and an abort signal', () => {
    expect(stripped).toMatch(/cache: 'no-store'/)
    expect(stripped).toMatch(/AbortController/)
    expect(stripped).toMatch(/controller\.abort\(\)/)
  })

  it('imports nothing server-only into the browser bundle', () => {
    // The `waiting.tsx → gate.ts → better-sqlite3` trap: a 'use client' file that imports a
    // guard pulls the database into the client chunk and 500s every route.
    for (const file of ['src/app/auto-refresh.tsx', 'src/app/refresh-decision.ts']) {
      const src = read(file)
      expect(src, `${file} imports a view model`).not.toMatch(/from ['"][^'"]*view-model/)
      expect(src, `${file} imports the gate`).not.toMatch(/from ['"][^'"]*\/gate['"]/)
      expect(src, `${file} imports the database`).not.toMatch(/from ['"][^'"]*lib\/db['"]/)
      expect(src, `${file} imports prisma`).not.toMatch(/@prisma\/client|src\/generated/)
    }
    // refresh-decision.ts must import NOTHING at all — it is the pure half.
    expect(read('src/app/refresh-decision.ts')).not.toMatch(/^\s*import /m)
  })
})

describe('the pulse route — the reader, by source', () => {
  const src = read('src/app/api/pulse/route.ts')

  it('is force-dynamic and never cached', () => {
    expect(src).toMatch(/export const dynamic = 'force-dynamic'/)
    expect(src).toMatch(/'Cache-Control': 'no-store'/)
  })

  it('checks the session itself, before any query — middleware is a router filter, this is an endpoint', () => {
    const stripped = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    const auth = stripped.indexOf('await currentUser()')
    const firstQuery = stripped.indexOf('prisma.')
    expect(auth).toBeGreaterThan(-1)
    expect(firstQuery).toBeGreaterThan(auth)
  })

  it('excludes the hot Setting keys from the aggregate', () => {
    expect(src).toMatch(/notIn: \[\.\.\.PULSE_IGNORED_SETTING_KEYS\]/)
  })

  it('composes through the pure function rather than inline', () => {
    expect(src).toMatch(/composeStamp\(/)
  })
})