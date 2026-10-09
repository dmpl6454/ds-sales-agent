import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

/**
 * ── ONE SPACING RULE, FOUR CALL SITES (the ring rule, 2026-08-19) ──────────
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
 * Four sites must share the ONE predicate — the gate (delivery), the planner
 * (drafting), the messages page (Up next) and the rest tally (why a recipient is
 * resting). A rule fixed on one path and not the others is this codebase's most
 * repeated defect, and the UI mirroring the rule by hand is exactly how the old shape
 * drifted. The rest tally was a fourth caller missing from this list (M12): the list was
 * hand-kept, so the discovery walk below finds the callers instead of trusting it.
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
  ['the screen, why a recipient is resting', 'src/app/view-model/rest-tally.ts'],
] as const

/** Every .ts/.tsx under src/, generated code excluded. */
function walkSrc(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) {
      if (name === 'generated' || name === 'node_modules') continue
      walkSrc(full, out)
    } else if (/\.(ts|tsx)$/.test(name)) out.push(full)
  }
  return out
}

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
   * DISCOVERY, not a hand-kept list — the list above missed rest-tally.ts for weeks. Every
   * file that calls the predicate must be one of the named call sites (so each new caller
   * is looked at, and inherits the assertions on this page), and at least four calls must
   * be found: a walk that matched nothing would otherwise report success.
   */
  it('every caller of crossSpacingVerdict is a named call site, and there are at least four', () => {
    const root = process.cwd()
    const callers: string[] = []
    for (const file of walkSrc(join(root, 'src'))) {
      const rel = relative(root, file)
      if (rel === join('src', 'outreach', 'crossSpacing.ts')) continue
      const calls = codeOnly(readFileSync(file, 'utf8')).match(/crossSpacingVerdict\(/g) ?? []
      for (let i = 0; i < calls.length; i++) callers.push(rel)
    }
    expect(callers.length, 'found fewer callers of the ring rule than the four enforcers').toBeGreaterThanOrEqual(4)
    const named = new Set<string>(CALL_SITES.map(([, f]) => f))
    for (const c of callers) {
      expect(named.has(c), `${c} calls crossSpacingVerdict but is not a named call site — add it above`).toBe(true)
    }
  })

  /**
   * The unfiltered id-list producer must not come back (M12). It handed every caller the
   * WHOLE fleet as "all our pages", and the ring rule then counted a marketing-only page
   * for every bollywood recipient — a rest that could never fire.
   */
  it('the fleet-wide id-list producer is gone from src/', () => {
    const offenders = walkSrc(join(process.cwd(), 'src')).filter((f) =>
      codeOnly(readFileSync(f, 'utf8')).includes('eligibleFleetSenderIds'),
    )
    expect(offenders).toEqual([])
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
