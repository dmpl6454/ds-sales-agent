import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { canAct, parseRole, inviteCodeAccepted, DEFAULT_ROLE, NOT_AN_OPERATOR } from '@/lib/roles'

/**
 * WHO MAY CHANGE ANYTHING — asserted structurally, because the failure it prevents has
 * already happened here once at full scale.
 *
 * Before `middleware.ts` existed there were **18 exported server actions and nothing in
 * front of them** — `sendNow`, `setAutopilot`, `connectAccount`, `removeSender`. Every
 * one callable with no password by anything that could reach the port. The fix then was
 * "every action calls requireUser() as its first statement", and that is a convention: it
 * holds exactly as long as everyone adding an action remembers it.
 *
 * Hosting raises the stakes. On 127.0.0.1 a missed check was reachable by whoever was at
 * the keyboard; on a public URL it is reachable by whoever finds the hostname, and the
 * thing behind it sends DMs from revenue accounts. So the convention is now a test.
 */

const ACTIONS = readFileSync(join(process.cwd(), 'src/app/actions.ts'), 'utf8')

/** Names of every exported server action, read from the file rather than maintained by hand. */
function exportedActions(source: string): string[] {
  return [...source.matchAll(/^export async function (\w+)/gm)].map((m) => m[1]!)
}

describe('every server action requires an operator', () => {
  it('finds the actions at all — a regex that matches nothing would pass everything', () => {
    const names = exportedActions(ACTIONS)
    expect(names.length).toBeGreaterThan(20)
    // Spot-check the ones that would hurt most, so a refactor that renames them is noticed.
    expect(names).toContain('sendNow')
    expect(names).toContain('setAutopilot')
    expect(names).toContain('connectAccount')
    expect(names).toContain('removeSender')
  })

  it('never downgrades an action to requireUser', () => {
    /**
     * `requireUser` answers "is someone signed in"; `requireOperator` answers "may they
     * change anything". A viewer passes the first and must fail the second. An action
     * calling the weaker one is the whole bug.
     */
    const callsWeaker = /const\s+user\s*=\s*await\s+requireUser\(\)/.test(ACTIONS)
    expect(callsWeaker, 'an action in actions.ts calls requireUser — it must call requireOperator').toBe(false)
  })

  it('guards every exported action, counted rather than sampled', () => {
    const names = exportedActions(ACTIONS)
    const guards = [...ACTIONS.matchAll(/await\s+requireOperator\(\)/g)].length

    // One guard per action. Fewer means one was added without a check — the exact
    // omission that left 18 actions unprotected.
    expect(guards).toBeGreaterThanOrEqual(names.length)
  })

  it('puts the guard FIRST, before any argument is read', () => {
    /**
     * Placement is load-bearing, not stylistic. Several actions mutate and then audit, so
     * a check deferred into `audit()` would let the write land and fail afterwards.
     */
    /**
     * ── COMMENTS ARE STRIPPED FIRST, AND THAT IS STRICTER, NOT LOOSER ────────
     *
     * This scanned a fixed 900-character window from the function keyword. That window is a
     * proxy for "near the top" measured in BYTES, and in a codebase that documents a
     * parameter with twenty lines of reasoning it measures the docblock, not the code:
     * `rejoinFleet` failed here the day its `confirmed` argument was explained, with the
     * guard correctly first in EXECUTION order.
     *
     * Removing comments and asserting the guard is the first STATEMENT says what the test
     * has always meant, and it cannot be defeated by prose. Same correction as
     * `tests/every-send-path-asks-the-gate.test.ts`, which passed its own mutation twice
     * because it was matching a name inside a docblock rather than a call in the code.
     */
    const stripComments = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')

    for (const name of exportedActions(ACTIONS)) {
      const start = ACTIONS.indexOf(`export async function ${name}`)
      const body = stripComments(ACTIONS.slice(start, start + 4000))
      const guardAt = body.indexOf('requireOperator()')
      expect(guardAt, `${name} has no requireOperator() near its top`).toBeGreaterThan(-1)

      /**
       * Nothing but the signature may precede it — no awaits, no prisma calls, no argument
       * parsing. With comments gone this is a statement about CODE, so the byte distance is
       * now a real bound rather than a budget for documentation.
       */
      /* The guard's OWN `const user = await ` is not something running before it. */
      const before = body.slice(0, guardAt).replace(/(const\s+\w+\s*=\s*)?await\s*$/, '')
      expect(before.includes('prisma.'), `${name} touches the database before checking the role`).toBe(false)
      expect(before.includes('await '), `${name} awaits something before checking the role`).toBe(false)
      expect(
        before.length,
        `${name}: too much code runs before the role check — it must be the first statement`,
      ).toBeLessThan(400)
    }
  })
})

describe('roles', () => {
  it('a new account cannot change anything', () => {
    expect(DEFAULT_ROLE).toBe('viewer')
    expect(canAct(DEFAULT_ROLE)).toBe(false)
    expect(canAct('operator')).toBe(true)
  })

  /**
   * `role` is a String because SQLite has no enums, so the column can hold anything. This
   * codebase's signature failure is absence-of-data hardening into a permissive claim — a
   * dead endpoint read as "logged out", an unreadable thread read as "no reply". The same
   * shape with a PERMISSION attached would be worse.
   */
  it.each([null, undefined, '', 'Operator', 'admin', 'OPERATOR', 'viewer '])(
    'treats %o as a viewer, never an operator',
    (raw) => {
      expect(canAct(parseRole(raw as string | null | undefined))).toBe(false)
    },
  )

  it('parses exactly the one value that grants power', () => {
    expect(parseRole('operator')).toBe('operator')
    expect(canAct(parseRole('operator'))).toBe(true)
  })

  it('tells a refused viewer how to get unblocked', () => {
    // A hard stop with no stated way out is a bug wearing a safety feature's clothes.
    expect(NOT_AN_OPERATOR).toMatch(/approve/i)
  })
})

describe('the invite gate', () => {
  it('refuses everything when no code is configured', () => {
    // "No secret set" must never mean "no gate" — that is the fail-open direction, and
    // it is exactly what `identify()` and `sessionUsable` were rewritten to avoid.
    expect(inviteCodeAccepted('anything', '')).toBe(false)
    expect(inviteCodeAccepted('anything', undefined)).toBe(false)
    expect(inviteCodeAccepted('anything', '   ')).toBe(false)
    expect(inviteCodeAccepted(undefined, undefined)).toBe(false)
  })

  it('accepts only the configured code', () => {
    expect(inviteCodeAccepted('s3cret', 's3cret')).toBe(true)
    expect(inviteCodeAccepted('  s3cret  ', 's3cret')).toBe(true) // pasted with whitespace
    expect(inviteCodeAccepted('S3CRET', 's3cret')).toBe(false) // case matters
    expect(inviteCodeAccepted('', 's3cret')).toBe(false)
    expect(inviteCodeAccepted(null, 's3cret')).toBe(false)
  })
})
