import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * ── ONE SPACING RULE, THREE CALL SITES (the ring rule, 2026-08-19) ─────────
 *
 * A SOURCE GREP, because the failure mode is a call site nobody has written yet and no
 * behavioural test can fail for a shape that reads perfectly.
 *
 * Cross-page spacing is `crossSpacingVerdict` (crossSpacing.ts): hold only when EVERY
 * eligible page has written to the recipient inside the window, plus the
 * `crossPageGapHours` gap between different pages. Tabish's instruction — "the 7 day
 * constraint … only if target has been contacted by all targets" — replaced the
 * any-other-page rule that halted the whole fleet on 2026-08-19 (MEASURED: 33/33
 * waiting drafts held, first clear five days out, 76 recipients locked by ONE page).
 *
 * Three sites must share the ONE predicate — the gate (delivery), the planner
 * (drafting) and the messages page (the screen). A rule fixed on one path and not the
 * others is this codebase's most repeated defect, and the UI mirroring the rule by
 * hand is exactly how the old shape drifted.
 */
const read = (rel: string): string => readFileSync(join(process.cwd(), rel), 'utf8')

/** Comments are stripped: this must pass on the CODE, never on a docblock quoting it. */
function codeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

const CALL_SITES = [
  ['the gate, at delivery', 'src/outreach/gate.ts'],
  ['the planner, at drafting', 'src/outreach/plan.ts'],
  ['the screen, in Up next', 'src/app/view-model/messages-page.ts'],
] as const

describe('the ring rule has ONE implementation and every enforcer calls it', () => {
  it.each(CALL_SITES)('%s calls crossSpacingVerdict', (_label, file) => {
    const src = codeOnly(read(file))
    // A grep that matches nothing reports success — assert the POSITIVE presence.
    expect(
      src.includes('crossSpacingVerdict'),
      `${file}: no longer calls the shared spacing predicate — a private copy here is how ` +
        `the gate, the planner and the screen come to disagree about who may be messaged`,
    ).toBe(true)
  })

  /**
   * The OLD rule's query shape must not come back in any enforcement path.
   * `senderId: { not: … }` was the any-other-page lookup; reintroducing it inline
   * reinstates the fleet-halting rule beside the new one, and whichever site holds it
   * wins quietly.
   */
  it.each(CALL_SITES)('%s does not rebuild the old any-other-page query inline', (_label, file) => {
    const src = codeOnly(read(file))
    expect(
      /senderId:\s*\{\s*not:/.test(src),
      `${file}: an inline senderId-exclusion spacing query has come back — the pre-2026-08-19 ` +
        `rule that held 33/33 drafts, living beside the ring rule and quietly overruling it`,
    ).toBe(false)
  })

  /**
   * The predicate itself must keep asking "did EVERY eligible page write" — `some` is
   * the deleted rule wearing the new one's name. `tests/cross-spacing.test.ts` catches
   * it behaviourally; this catches it structurally with a readable failure.
   */
  it('crossSpacing.ts holds ring-complete on every(), never some()', () => {
    const src = codeOnly(read('src/outreach/crossSpacing.ts'))
    expect(src).toContain('.every((id) => inWindow.has(id))')
  })

  /**
   * And the window and the gap come from SETTINGS, not literals. A number typed at a
   * call site would be a second copy of a rule the dashboard also states — the drift
   * `/rules` exists to prevent by importing every value from the module that enforces
   * it.
   */
  it.each([['src/outreach/gate.ts'], ['src/outreach/plan.ts']])(
    '%s takes the window and the gap from settings',
    (file) => {
      const src = codeOnly(read(file))
      expect(src).toContain('settings.defaultCooldownDays')
      expect(src).toContain('settings.crossPageGapHours')
    },
  )
})
