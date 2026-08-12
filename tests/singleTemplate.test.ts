import { describe, it, expect } from 'vitest'
import { SINGLE_TEMPLATE_MIDDLE } from '@/outreach/compose'
import { APPROVED_FIGURES } from '@/outreach/qualityGate'
import { renderMessage } from '@/outreach/render'

/**
 * ── STEP 10: the single template, OFF by default ────────────────────────────
 *
 * One template, one variable line (the paid post we actually saw). Turning it on is
 * Tabish's decision because it partially reverses decision 3; these tests pin the
 * properties that make it SAFE to turn on at all:
 *
 *   - every figure it claims is already in the quality gate's allowlist
 *   - the hook line is the only thing that varies, and it varies — two touches to one
 *     recipient must not be byte-identical, or `distinctiveSlice`/`bodyAppearedSince`
 *     lose their needle
 *   - no observation means the line is OMITTED, never invented
 */

const persona = {
  personaName: 'Kapil Jain',
  personaRole: 'Co-founder',
  personaBrand: 'Bollywood Society',
  personaPhone: '+91 60000 189766',
  personaEmail: 'kapil@digitalsukoon.com',
}

const channel = {
  handle: 'viralbhayani',
  displayName: 'Viral Bhayani',
  contactFirstName: 'Viral',
  kind: 'CHANNEL' as const,
}

function render(hook: { brands: string; postedAt: Date; verdict: string } | null) {
  return renderMessage({ persona, target: channel, variantBody: SINGLE_TEMPLATE_MIDDLE, hook })
}

describe('the single template', () => {
  it('claims only figures the quality gate already approves', () => {
    // The same claim-shaped tokens the gate hunts for: anything with a scale marker.
    const claims = SINGLE_TEMPLATE_MIDDLE.toLowerCase().match(/\d[\d,.]*\s*(?:%|\+|m\b|k\b|million|billion|crore|lakh)/gi) ?? []
    expect(claims.length).toBeGreaterThan(0) // the check must actually see the figures
    for (const c of claims) {
      const normalised = c.trim().toLowerCase().replace(/\s+/g, ' ')
      expect(
        APPROVED_FIGURES.some((f) => normalised.startsWith(f) || f.startsWith(normalised.replace(/\s.*$/, ''))),
        `figure "${c}" is not in APPROVED_FIGURES`,
      ).toBe(true)
    }
    // And the bare page count is an approved figure too.
    expect(SINGLE_TEMPLATE_MIDDLE).toContain('200 ')
    expect(APPROVED_FIGURES).toContain('200')
  })

  it('varies by exactly the hook line — two hooks give two different bodies', () => {
    const now = new Date()
    const a = render({ brands: JSON.stringify(['Crocs']), postedAt: now, verdict: 'CAMPAIGN' })
    const b = render({ brands: JSON.stringify(['Nutella']), postedAt: now, verdict: 'CAMPAIGN' })
    // Guard the guard: the hook lines must actually exist, or the comparison is vacuous.
    expect(a.hookLine).toContain('Crocs')
    expect(b.hookLine).toContain('Nutella')
    expect(a.body).not.toBe(b.body)
    // And removing the hook lines makes them identical: nothing else varies.
    expect(a.body.replace(a.hookLine!, '')).toBe(b.body.replace(b.hookLine!, ''))
  })

  it('OMITS the line with no observation, and still renders a complete message', () => {
    const r = render(null)
    expect(r.hookLine).toBeNull()
    expect(r.body).toContain('Hi Viral,')
    // Signs off as the page alone — the personal intro was retired 2026-08-07.
    expect(r.body).toContain('Bollywood Society\n+91 60000 189766')
    expect(r.body).not.toContain('Kapil Jain')
    expect(r.body).toContain('169.2M followers')
    expect(r.body).toContain('kapil@digitalsukoon.com')
    // No placeholder survives rendering.
    expect(r.body).not.toMatch(/\{\{.*\}\}/)
  })
})
