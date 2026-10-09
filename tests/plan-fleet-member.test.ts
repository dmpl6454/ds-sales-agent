import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * THE PLANNER RE-ASKS WHETHER A PAGE IS STILL IN THE ROTATION BEFORE IT WRITES (2026-10-09).
 *
 * `runOutreach` reads its pairs ONCE, filtered on `fleetMember: true`, then spends minutes
 * evaluating them. `removeSender` flips `fleetMember: false` and hands the leaving page's queue
 * off — but a planning pass that started before the flip still holds that page's pairs, and
 * could write it a fresh draft AFTER the hand-off had read and released its queue. Nothing
 * would ever release that one: it would sit READY on a retired account, holding its post claim.
 *
 * The planner already re-reads the sender's STATUS immediately before writing, for the same
 * reason (a snapshot cannot see a CHALLENGED written meanwhile). This pins that the same read
 * carries `fleetMember` and that a page out of the rotation is skipped, not written for.
 * A source grep, because a behavioural test would need the whole planner and its race window.
 */

const PLAN = readFileSync(join(process.cwd(), 'src/outreach/plan.ts'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')

describe('the planner skips a page taken out of the rotation mid-pass', () => {
  it('the live sender re-read selects fleetMember, and a false one is skipped before any draft is written', () => {
    const read = PLAN.search(/const liveSender = await prisma\.senderAccount\.findUnique\(/)
    expect(read, 'the live sender re-read is gone').toBeGreaterThan(-1)
    const write = PLAN.indexOf('createAndDispatch(', read)
    expect(write, 'no draft is written after the re-read').toBeGreaterThan(read)

    const between = PLAN.slice(read, write)
    expect(between, 'the re-read must select fleetMember').toMatch(/select:\s*\{[^}]*\bfleetMember:\s*true/)
    expect(between, 'a page out of the rotation must be skipped').toMatch(
      /if\s*\(\s*liveSender\s*&&\s*!liveSender\.fleetMember\s*\)\s*\{[\s\S]*?\bcontinue\b/,
    )
  })
})
