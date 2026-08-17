import { describe, it, expect } from 'vitest'
import { classifyOpener } from '@/outreach/staleTemplate'
import { buildGreeting, introLine, renderMessage } from '@/outreach/render'

/**
 * The predicate behind `pnpm ig:discard-stale-drafts`.
 *
 * The direction that carries the weight is NOT "does it spot the old shape" — that is one
 * string comparison. It is "what does it say about a body it does not recognise", because
 * the caller DISCARDS on `stale`, so every unreadable case must land somewhere else.
 */

const PERSONA = {
  personaName: 'Kapil Jain',
  personaRole: 'Co-founder',
  personaBrand: 'Bollywood Chronicle',
  personaPhone: '+91 60000 189766',
  personaEmail: 'kapil@digitalsukoon.com',
}

const BRAND_TARGET = {
  handle: 'crocsindia',
  displayName: 'Crocs India',
  contactFirstName: null,
  kind: 'BRAND',
}

describe('classifyOpener — the shape the current renderer produces', () => {
  /**
   * THE ANCHOR TEST. Everything else is a claim about strings; this one asserts the
   * predicate against a body the REAL renderer just produced. If `renderMessage` ever goes
   * back to a standalone greeting, this fails — which is the whole point, because the
   * command would otherwise start discarding freshly-written drafts.
   */
  it('calls a body the real renderMessage just produced "current"', () => {
    const rendered = renderMessage({
      persona: PERSONA,
      target: BRAND_TARGET,
      variantBody: 'You are already buying reach on entertainment publishers, and we own that inventory rather than broker it.',
      hook: null,
    })

    const verdict = classifyOpener({
      renderedBody: rendered.body,
      greetingNow: buildGreeting(BRAND_TARGET),
    })

    expect(verdict.shape).toBe('current')
  })

  /**
   * WHY THE PREDICATE READS LINE 0 AND NOT "IS LINE 1 BLANK".
   *
   * The obvious test for the 2026-08-17 change is "the old shape has a blank second line".
   * It is WRONG, and it was measured wrong against the live database before this test
   * caught it: BOTH shapes have a blank line 1, because the array is
   * `[opener, '', body, …]` and always was — the blank is the paragraph break between the
   * opener and the body, not the thing that changed.
   *
   * What changed is what sits on line 0: the greeting ALONE before, the greeting and the
   * introduction together after. So a predicate on line 1 cannot separate them and would
   * report every draft ever written as stale, including one rendered a second ago. Asserted
   * here so the cheaper rule cannot come back.
   */
  it('both shapes have a blank line 1, so only line 0 separates them', () => {
    const rendered = renderMessage({
      persona: PERSONA,
      target: BRAND_TARGET,
      variantBody: 'A body long enough to survive the needle floor, comfortably over forty characters.',
      hook: null,
    })
    const lines = rendered.body.split('\n')

    expect(lines[0]).toBe(`${buildGreeting(BRAND_TARGET)} ${introLine(PERSONA)}`)
    expect(lines[1]).toBe('') // the CURRENT shape has it too — this is the trap
    expect(lines[0]).not.toBe(buildGreeting(BRAND_TARGET)) // ...and this is the real difference
  })

  /**
   * The exact bytes of a real waiting draft, measured from the live database on
   * 2026-08-17 — the `[greeting, '', body]` join, with the blank line that cost every
   * message its inbox preview.
   */
  it('calls the pre-2026-08-17 two-element join "stale"', () => {
    const old = [
      'Hi Crocs India team,',
      '',
      'You are investing in placement on entertainment publishers, and we own that inventory.',
      '',
      'Looking forward to connecting.',
      '',
      'Bollywood Chronicle',
    ].join('\n')

    const verdict = classifyOpener({ renderedBody: old, greetingNow: 'Hi Crocs India team,' })
    expect(verdict.shape).toBe('stale')
    expect(verdict.detail).toContain('line 1')
  })
})

describe('classifyOpener — what it refuses to call stale', () => {
  /**
   * THE ONE THAT MATTERS. A hand-edited opener is indistinguishable from a rendering we do
   * not recognise, and the caller DISCARDS on `stale`. Filing this as stale would throw away
   * an operator's own words; filing it as `current` would claim it is up to date, which is
   * also a lie. It has to be its own answer.
   */
  it('leaves a hand-edited opener alone rather than discarding it', () => {
    const edited = [
      'Hey Crocs team — quick one from us at Bollywood Chronicle.',
      '',
      'We own the inventory rather than broker it.',
    ].join('\n')

    const verdict = classifyOpener({ renderedBody: edited, greetingNow: 'Hi Crocs India team,' })
    expect(verdict.shape).toBe('unknown')
    expect(verdict.shape).not.toBe('stale')
  })

  it('an empty body is unknown, never stale', () => {
    expect(classifyOpener({ renderedBody: '', greetingNow: 'Hi Crocs India team,' }).shape).toBe('unknown')
    expect(classifyOpener({ renderedBody: '   \n  ', greetingNow: 'Hi Crocs India team,' }).shape).toBe('unknown')
    expect(classifyOpener({ renderedBody: null, greetingNow: 'Hi Crocs India team,' }).shape).toBe('unknown')
  })

  it('a greeting we could not build is unknown, never stale', () => {
    const body = 'Hi Crocs India team,\n\nsomething'
    expect(classifyOpener({ renderedBody: body, greetingNow: '' }).shape).toBe('unknown')
    expect(classifyOpener({ renderedBody: body, greetingNow: '   ' }).shape).toBe('unknown')
  })

  /**
   * A greeting for a DIFFERENT recipient must not make a healthy body look stale. This is
   * reachable: `displayName` is editable, so the greeting can change under a frozen body.
   * The safe answer is "we cannot tell", not "delete it".
   */
  it('does not call a body stale using another recipient\'s greeting', () => {
    const current = `Hi Crocs India team, ${introLine(PERSONA)}\n\nbody text here that is long enough.`
    const verdict = classifyOpener({ renderedBody: current, greetingNow: 'Hi Royal Canin India team,' })
    expect(verdict.shape).toBe('unknown')
  })

  /**
   * FOUND BY RUNNING THIS AGAINST THE LIVE QUEUE, and it is why the predicate is a pattern
   * and not an equality.
   *
   * `usableBrandName` refuses a display name that is a raw handle, so @agoracitycentre — whose
   * frozen body opens "Hi agoracitycentre team," — now greets as "Hi there,". Under an
   * equality test all five such drafts were reported as "probably edited by hand" and left in
   * place, when in fact they carry the WORST copy in the queue: the raw-handle greeting.
   *
   * MEASURED: 5 of 16 waiting drafts were in this state.
   */
  it('catches a stale body whose greeting has ALSO changed since it was written', () => {
    const frozen = 'Hi agoracitycentre team,\n\nWe own the inventory rather than broker it.'

    const verdict = classifyOpener({ renderedBody: frozen, greetingNow: 'Hi there,' })

    expect(verdict.shape).toBe('stale')
    expect(verdict.detail).toContain('doubly out of date')
  })

  it('a stale body whose greeting is unchanged does not claim the greeting moved', () => {
    const verdict = classifyOpener({
      renderedBody: 'Hi Crocs India team,\n\nbody text',
      greetingNow: 'Hi Crocs India team,',
    })
    expect(verdict.shape).toBe('stale')
    expect(verdict.detail).not.toContain('doubly out of date')
  })

  /**
   * The pattern must not be so greedy it swallows prose. A first line that merely BEGINS
   * like a greeting but carries a sentence is not the old join.
   */
  it('does not treat prose that opens with a greeting word as the old join', () => {
    const prose = 'Hi — we noticed you are buying placement on entertainment publishers.'
    expect(classifyOpener({ renderedBody: prose + '\n\nmore', greetingNow: 'Hi there,' }).shape).toBe('unknown')
  })

  /**
   * MUTATION TEST. The predicate is an equality on line 1, and the obvious "simplification"
   * is `first.includes(greeting)` or a bare `startsWith`. Both would call the CURRENT shape
   * stale, because the merged opener begins with the greeting — and the command would then
   * discard every draft it was pointed at, including ones written minutes earlier.
   */
  it('a merged opener is not stale merely because it CONTAINS the greeting', () => {
    const greeting = 'Hi Crocs India team,'
    const merged = `${greeting} ${introLine(PERSONA)}\n\nbody text that is long enough to matter.`

    expect(merged.startsWith(greeting)).toBe(true) // the naive rule would fire here
    expect(classifyOpener({ renderedBody: merged, greetingNow: greeting }).shape).toBe('current')
  })

  it('trailing whitespace on line 1 does not hide the old shape', () => {
    const old = 'Hi Crocs India team,   \n\nbody'
    expect(classifyOpener({ renderedBody: old, greetingNow: 'Hi Crocs India team,' }).shape).toBe('stale')
  })

  it('every verdict carries prose, so a CLI line is never a bare code', () => {
    const inputs = [
      { renderedBody: 'Hi X,\n\nbody', greetingNow: 'Hi X,' },
      { renderedBody: `Hi X, ${introLine(PERSONA)}\n\nbody`, greetingNow: 'Hi X,' },
      { renderedBody: '', greetingNow: 'Hi X,' },
    ]
    for (const i of inputs) {
      const v = classifyOpener(i)
      expect(v.detail.length).toBeGreaterThan(20)
    }
  })
})
