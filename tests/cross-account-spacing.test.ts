import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * ── THE SPACING QUERY MUST EXCLUDE THE SENDER ITSELF ──────────────────────
 *
 * A SOURCE GREP, because the failure mode is a query nobody has written yet and no
 * behavioural test can fail for a shape that reads perfectly.
 *
 * Cross-account spacing asks "has a DIFFERENT page of ours written to this person
 * recently". Before 2026-08-18 it was sender-BLIND including self, which was correct then
 * because a 7-day per-pair cooldown said the same thing anyway. That cooldown is gone and
 * Tabish's rule is FIVE A DAY from one account to one recipient — so dropping
 * `senderId: { not: … }` would silently reinstate a seven-day pair cooldown and contradict
 * the number he chose, while every test here and every page still read as healthy. It
 * would present as "the queue stopped draining", days later, pointing at nothing.
 *
 * Both halves are checked: the planner refuses to WRITE the duplicate, the gate refuses to
 * SEND it. One without the other is the gap `gate.ts` itself was extracted to close.
 */
const read = (rel: string): string => readFileSync(join(process.cwd(), rel), 'utf8')

/** Comments are stripped: this must pass on the CODE, never on a docblock quoting it. */
function codeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

describe('cross-account spacing asks about OTHER pages, not this one', () => {
  it.each([
    ['the gate, at delivery', 'src/outreach/gate.ts'],
    ['the planner, at drafting', 'src/outreach/plan.ts'],
  ])('%s excludes this sender from the spacing lookup', (_label, file) => {
    const src = codeOnly(read(file))

    /*
      The spacing query is the one that reads DELIVERED attempts for a target while naming
      a senderId exclusion. Matched loosely on purpose — formatting drifts, the property
      does not.
    */
    const excludesSelf = /senderId:\s*\{\s*not:/.test(src)
    expect(
      excludesSelf,
      `${file}: the recipient-spacing lookup no longer excludes this sender, so one account's own ` +
        `delivery now blocks it for the whole window — a per-pair cooldown reinstated by accident, ` +
        `contradicting the five-a-day rule`,
    ).toBe(true)
  })

  /**
   * And the window itself comes from the SETTING, not a literal. A number typed here would
   * be a second copy of a rule the dashboard also states — the drift `/rules` exists to
   * prevent by importing every value from the module that enforces it.
   */
  it('takes the window from settings rather than a hardcoded number of days', () => {
    const gate = codeOnly(read('src/outreach/gate.ts'))
    expect(gate).toContain('settings.defaultCooldownDays')
  })
})
