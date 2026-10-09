import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { queueMotion, motionHoldReason, motionWaitsFor } from '../src/app/view-model/queue-motion'

/**
 * ONE DERIVATION OF "WILL THE QUEUE MOVE" — audit H8, 2026-10-09.
 *
 * The switch card, the "what is stopping it" summary and the queue each decided whether the fleet
 * was on for themselves, from two different values — and on the hosted landing page the card said
 * "Autopilot is ON — the Studio sends by itself" while the queue below it said "Autopilot is off,
 * so none of these are going out". `queueMotion` is the card's own branch order, lifted out so all
 * three read it.
 *
 * The pure half pins the ORDER (it is the card's, and the card's title is the thing a person reads
 * first); the source half pins that all three consumers actually ask it — a predicate nobody calls
 * is a guard nobody can trigger.
 */

type Input = Parameters<typeof queueMotion>[0]
const base: Input = { on: true, sendingMac: { selected: 'Studio', online: true }, readyHandles: ['a'] }

describe('queueMotion — the switch card’s branch order', () => {
  it('moving: on, a Mac chosen, beating, and an account ready', () => {
    expect(queueMotion(base)).toEqual({ kind: 'moving', mac: 'Studio' })
  })

  it('switch-off wins over everything else', () => {
    expect(queueMotion({ ...base, on: false, sendingMac: { selected: null, online: false }, readyHandles: [] })).toEqual({
      kind: 'switch-off',
    })
  })

  /**
   * The one ordering a careless rewrite gets wrong: with no Mac chosen, `online` is false too, and
   * "<null> — the sending Mac — is not online" is not a sentence. The card says "no Mac is selected".
   */
  it('no Mac chosen is "no-mac", not "mac-offline", even though online is false', () => {
    expect(queueMotion({ ...base, sendingMac: { selected: null, online: false } })).toEqual({ kind: 'no-mac' })
  })

  it('a chosen Mac that is not beating is "mac-offline" and names it', () => {
    expect(queueMotion({ ...base, sendingMac: { selected: 'Studio', online: false } })).toEqual({
      kind: 'mac-offline',
      mac: 'Studio',
    })
  })

  it('no account able to send is "no-account-ready", never "moving"', () => {
    expect(queueMotion({ ...base, readyHandles: [] })).toEqual({ kind: 'no-account-ready', mac: 'Studio' })
  })

  it('only "moving" has nothing to wait for and no hold reason', () => {
    expect(motionWaitsFor({ kind: 'moving', mac: 'Studio' })).toBeNull()
    expect(motionHoldReason({ kind: 'moving', mac: 'Studio' })).toBeNull()
    for (const m of [
      { kind: 'switch-off' } as const,
      { kind: 'no-mac' } as const,
      { kind: 'mac-offline', mac: 'Studio' } as const,
      { kind: 'no-account-ready', mac: 'Studio' } as const,
    ]) {
      expect(motionWaitsFor(m), m.kind).not.toBeNull()
      expect(motionHoldReason(m), m.kind).not.toBeNull()
    }
    expect(motionWaitsFor({ kind: 'mac-offline', mac: 'Studio' })!.eta).toMatch(/Studio is back online/)
  })
})

describe('queueMotion — who asks it', () => {
  const repo = join(__dirname, '..')
  const read = (f: string) => readFileSync(join(repo, f), 'utf8')
  /* Comments out, so a mention in a docblock cannot satisfy an assertion about CODE. */
  const code = (f: string) =>
    read(f)
      .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
      .replace(/(^|[^:])\/\/.*$/gm, '$1')

  /**
   * The 'use client' switch imports this module, so a runtime import from it of anything that
   * reaches the database is the `waiting.tsx -> gate.ts -> better-sqlite3` trap that returned HTTP
   * 500 on every route. `import type` is erased at compile time and is the only kind allowed.
   */
  it('imports nothing at runtime', () => {
    const src = read('src/app/view-model/queue-motion.ts')
    const imports = src.split('\n').filter((l) => /^\s*import\s/.test(l))
    expect(imports.length, 'queue-motion.ts should import the AutopilotState type').toBeGreaterThan(0)
    for (const line of imports) expect(line, 'only `import type` is allowed here').toMatch(/^\s*import type /)
  })

  it('the switch card and the landing page both derive it', () => {
    expect(code('src/app/autopilot.tsx')).toMatch(/queueMotion\(state\)/)
    expect(code('src/app/page.tsx')).toMatch(/queueMotion\(/)
  })

  /**
   * From `v.autopilot` — the card's own state — and from nothing else. Deriving it from `m` (the
   * queue's builder) or from `settings` is the two-derivations defect this exists to end.
   */
  it('the landing page derives it from the switch card’s own state, once, and hands it to both readers', () => {
    const page = code('src/app/page.tsx')
    expect(page).toMatch(/const motion = queueMotion\(v\.autopilot\)/)
    expect(page.match(/queueMotion\(/g)?.length, 'derived once').toBe(1)
    expect(page).toMatch(/motion=\{motion\}/)
    expect(page).toMatch(/blockersSummary\(blockers, motion\)/)
  })

  /** The switch card's four ON branches are `queueMotion`'s kinds, not its own re-derivation. */
  it('the switch card no longer re-derives the states inline', () => {
    const card = code('src/app/autopilot.tsx')
    expect(card).not.toMatch(/!state\.sendingMac\.selected/)
    expect(card).not.toMatch(/!state\.sendingMac\.online/)
  })
})
