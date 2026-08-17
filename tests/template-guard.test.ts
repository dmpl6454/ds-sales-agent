import { describe, expect, it } from 'vitest'
import { checkTemplateBody } from '@/outreach/templateGuard'
import { SINGLE_TEMPLATE_MIDDLE } from '@/outreach/compose'

/**
 * The floor a textarea can now reach. `SINGLE_TEMPLATE_MIDDLE`'s docblock documents the
 * shapes that return a null needle and thereby refuse EVERY send; the /settings editor
 * makes those shapes one Save away, so the guard must refuse them AT SAVE — with the
 * fixtures below taken from that documented table, not invented.
 */
describe('checkTemplateBody', () => {
  it('accepts the shipping template — a gate no good copy can satisfy is an outage', () => {
    expect(checkTemplateBody(SINGLE_TEMPLATE_MIDDLE)).toEqual({ ok: true })
  })

  it('accepts one LONG paragraph — the property is length, not paragraph count', () => {
    const one =
      'We run a Bollywood and paparazzi network doing over 30 crore views a day and would like to explore an annual collaboration.'
    expect(checkTemplateBody(one).ok).toBe(true)
  })

  it('refuses one SHORT paragraph — the documented every-send-refused shape', () => {
    const verdict = checkTemplateBody('Quick chat about a collab?')
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.reason).toContain('refuse every send')
  })

  it('refuses two SHORT paragraphs — the other every-send-refused shape', () => {
    expect(checkTemplateBody('Quick chat?\n\nWe do views.').ok).toBe(false)
  })

  it('refuses empty and whitespace-only text', () => {
    expect(checkTemplateBody('').ok).toBe(false)
    expect(checkTemplateBody('  \n\n  ').ok).toBe(false)
  })

  /**
   * The single template is plain text by contract — the renderer adds the two things
   * that vary. A {{token}} typed here would reach a real inbox as literal braces: the
   * placeholder check in qualityGate guards GENERATED copy, not this path.
   */
  it('refuses {{placeholders}} — they would be sent to a person as-is', () => {
    const verdict = checkTemplateBody(
      'We are a Bollywood network doing over 30 crore views a day for {{brand}} and friends.',
    )
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.reason).toContain('braces')
  })
})
