import { describe, it, expect } from 'vitest'
import { renderMessage, buildGreeting, signatureBlock, introLine } from '@/outreach/render'
import { SINGLE_TEMPLATE_MIDDLE } from '@/outreach/compose'
import { distinctiveSlice, proseLines, bodyAppearedSince, MIN_NEEDLE_CHARS } from '@/outreach/matching'
import { APPROVED_FIGURES } from '@/outreach/qualityGate'

/**
 * ── THE STANDARD MESSAGE, AND THE TWO THINGS THAT WOULD BREAK SILENTLY ─────
 *
 * Tabish, 2026-08-17: *"no custom message is required whatsoever. Same standard template
 * message to be sent to them … no space and new line after hi this ruins it."*
 *
 * Two properties of that change are mechanical rather than editorial, and both fail in the
 * quiet direction:
 *
 *  1. **The template must keep a paragraph longer than 40 characters.** `proseLines` drops
 *     the first line BY POSITION — the merged opener — and `distinctiveSlice` needs a
 *     survivor of at least `MIN_NEEDLE_CHARS`. MEASURED, and it corrects the obvious guess:
 *     one LONG paragraph is fine, while one short paragraph AND two short paragraphs both
 *     yield null, and null refuses every send in the system. So the hazard is shortening the
 *     copy, which is exactly the direction "make it shorter" pushes. Asserted against the
 *     REAL exported constant, not a fixture, because a fixture is what drifts from the copy
 *     somebody actually edits.
 *
 *  2. **Every message is now byte-identical apart from two names**, which puts weight on
 *     guards that were written when bodies differed. `bodyAppearedSince` is an occurrence
 *     DELTA and survives that; `assessRead` did not, and is fixed in
 *     `tests/readThread.test.ts`.
 */

const persona = {
  personaName: 'Kapil Jain',
  personaRole: 'Co-founder',
  personaBrand: 'Bollywood Chronicle',
  personaPhone: '+91 60000 189766',
  personaEmail: 'kapil@digitalsukoon.com',
}

const brand = (displayName: string, handle = 'crocsindia') => ({
  handle,
  displayName,
  contactFirstName: null,
  kind: 'BRAND',
})

const render = (target: ReturnType<typeof brand>) =>
  renderMessage({ persona, target, variantBody: SINGLE_TEMPLATE_MIDDLE, hook: null }).body

describe('the standard message', () => {
  it('opens with the greeting and the introduction on ONE line', () => {
    const first = render(brand('Crocs India')).split('\n')[0] ?? ''
    expect(first).toBe("Hi Crocs India team, I'm Kapil Jain, Co-founder of Bollywood Chronicle.")
  })

  /**
   * The defect this replaced, stated as an assertion. `parts` held a bare `''` between the
   * greeting and the body, so `join('\n')` produced a blank second line — and Instagram's
   * inbox list previews only the first line, so every recipient's preview read
   * "Hi Crocs India team," and nothing else.
   */
  it('never leaves the greeting alone on its own line', () => {
    for (const name of ['Crocs India', 'Amazon India', 'Royal Canin India']) {
      const first = render(brand(name)).split('\n')[0] ?? ''
      expect(first.endsWith(','), `"${first}" is a bare greeting`).toBe(false)
      expect(first.length, 'the first line must carry the pitch, not just a greeting').toBeGreaterThan(40)
    }
  })

  it('carries the greeting name, the page name and the signature', () => {
    const body = render(brand('Crocs India'))
    expect(body).toContain('Hi Crocs India team,')
    expect(body).toContain('Co-founder of Bollywood Chronicle.')
    expect(body.endsWith(signatureBlock(persona))).toBe(true)
  })

  /**
   * ── THE INVARIANT THAT KEEPS SENDING ALIVE ───────────────────────────────
   *
   * Mutation-tested in both directions: cutting SINGLE_TEMPLATE_MIDDLE to one SHORT
   * paragraph makes `distinctiveSlice` return null and this fails; cutting it to one LONG
   * paragraph keeps a needle and it passes. The property is length, not count — which is
   * why the assertion is on how many lines clear MIN_NEEDLE_CHARS rather than on how many
   * paragraphs there are.
   */
  it('leaves prose long enough for a needle after the opener is dropped', () => {
    const prose = proseLines(render(brand('Crocs India')))
    const usable = prose.filter((l) => l.length >= MIN_NEEDLE_CHARS)
    expect(usable.length, 'no paragraph clears the needle minimum — every send would be refused').toBeGreaterThanOrEqual(1)
    // Two is the margin this copy ships with, so a later trim has somewhere to go.
    expect(usable.length).toBeGreaterThanOrEqual(2)
  })

  it('yields a needle the send guards can search for', () => {
    for (const name of ['Crocs India', 'agoracitycentre', 'Jignesh N Khatiwala']) {
      const needle = distinctiveSlice(render(brand(name)))
      expect(needle, `no needle for "${name}" — every send to them would be refused`).not.toBeNull()
      expect(needle!.length).toBeGreaterThanOrEqual(MIN_NEEDLE_CHARS)
    }
  })

  /**
   * A handle is never put in front of a prospect. `usableBrandName` refuses a display name
   * that is just the handle, and the greeting falls back rather than inventing a company.
   */
  it('does not greet a raw handle', () => {
    expect(render(brand('agoracitycentre', 'agoracitycentre'))).toContain('Hi there,')
  })

  /**
   * The post-send confirmation, with two BYTE-IDENTICAL messages in one thread — the exact
   * situation the standard template creates on a second touch, and the one people assume
   * breaks it. It does not: the guard compares occurrence COUNTS across the read before and
   * the read after, and a count going 1→2 is a delta a thread cannot fake.
   */
  it('confirms a second identical message by delta, in both directions', () => {
    const body = render(brand('Crocs India'))
    const threadBefore = body
    const threadAfter = `${body}\n${body}`
    expect(bodyAppearedSince(threadBefore, threadAfter, body), 'the message DID appear').toBe(true)
    expect(bodyAppearedSince(threadBefore, threadBefore, body), 'the message did NOT appear').toBe(false)
  })

  /** Only two things vary across the whole fleet. This is what "no custom message" means. */
  it('differs between two recipients ONLY by the name', () => {
    const a = render(brand('Crocs India'))
    const b = render(brand('Amazon India', 'amazondotin'))
    expect(a).not.toBe(b)
    expect(a.replace('Crocs India', 'Amazon India')).toBe(b)
  })

  it('differs between two senders ONLY by the page name', () => {
    const other = { ...persona, personaBrand: 'Mad About Marketing' }
    const a = renderMessage({ persona, target: brand('Crocs India'), variantBody: SINGLE_TEMPLATE_MIDDLE, hook: null }).body
    const b = renderMessage({
      persona: other,
      target: brand('Crocs India'),
      variantBody: SINGLE_TEMPLATE_MIDDLE,
      hook: null,
    }).body
    expect(a.replaceAll('Bollywood Chronicle', 'Mad About Marketing')).toBe(b)
  })

  /**
   * Carried over from the retired `singleTemplate.test.ts`, which pinned the previous
   * template. Every number a prospect reads has to be one we actually claim — the quality
   * gate hunts for exactly these tokens, and the copy must not be the place a new figure
   * gets invented.
   */
  it('claims only figures the quality gate already approves', () => {
    const claims = SINGLE_TEMPLATE_MIDDLE.toLowerCase().match(/\d[\d,.]*\s*(?:%|\+|m\b|k\b|million|billion|crore|lakh)/gi) ?? []
    expect(claims.length, 'the check must actually see some figures, or it is vacuous').toBeGreaterThan(0)
    for (const c of claims) {
      const normalised = c.trim().toLowerCase().replace(/\s+/g, ' ')
      expect(
        APPROVED_FIGURES.some((f) => normalised.startsWith(f) || f.startsWith(normalised.replace(/\s.*$/, ''))),
        `figure "${c}" is not in APPROVED_FIGURES`,
      ).toBe(true)
    }
  })

  /** Writer and probe share bytes — the reason `signatureBlock` is the one writer. */
  it('builds the opener and the signature from the exported helpers', () => {
    const body = render(brand('Crocs India'))
    expect(body).toContain(`${buildGreeting(brand('Crocs India'))} ${introLine(persona)}`)
  })
})
