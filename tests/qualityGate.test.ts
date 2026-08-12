import { describe, it, expect } from 'vitest'
import { checkGeneratedMessage, APPROVED_FIGURES } from '@/outreach/qualityGate'
import { renderMessage } from '@/outreach/render'
import { MESSAGE_VARIANTS } from '../prisma/variants'
import { BRAND_MESSAGE_VARIANTS } from '../prisma/brandVariants'
import { BESPOKE_DRAFTS } from '../prisma/bespoke'

/**
 * The gate is the half of Phase 8 that decides whether a MODEL-WRITTEN message may reach a
 * real prospect, so both directions matter equally:
 *
 *   too strict  every generated body falls back to a hand-written variant, generation is
 *               dead weight, and nobody notices because the fallback works
 *   too loose   an invented claim about our own reach goes to a company that buys media
 *
 * The first test is therefore that the copy which ALREADY SHIPS passes. A gate no good copy
 * can satisfy is not a gate, it is an outage — and it would look like caution.
 */

const PERSONA = {
  personaName: 'Kapil Jain',
  personaRole: 'Co-founder',
  personaBrand: 'Bollywood Society',
  personaPhone: '+91 60000 189766',
  personaEmail: 'kapil@digitalsukoon.com',
}
const CHANNEL = {
  handle: 'madovermarketing_mom',
  displayName: 'Mad Over Marketing',
  contactFirstName: 'Mad Over Marketing' as string | null,
  kind: 'CHANNEL',
}
const BRAND = {
  handle: 'royalcanin.india',
  displayName: 'Royal Canin India',
  contactFirstName: null as string | null,
  kind: 'BRAND',
}

/**
 * Run the gate the way the generator will: render the middle, then check both.
 *
 * `hasObservation` defaults FALSE, the strict setting, so every negative case below is checked
 * against a body that was given nothing to reference.
 */
function check(generated: string, target = CHANNEL, priorBodies: string[] = [], hasObservation = false) {
  const rendered = renderMessage({ persona: PERSONA, target, variantBody: generated, hook: null }).body
  return checkGeneratedMessage({ generated, rendered, persona: PERSONA, target, priorBodies, hasObservation })
}

/** A body that passes everything, used as the control for each negative case. */
const GOOD = [
  'We own the inventory rather than broker it: 200+ pages across Instagram, Facebook, YouTube and Snapchat, 169.2M followers combined, and over 30 crore views a day.',
  '',
  'For a publisher running placements at your frequency that usually means a better rate per view and one calendar instead of a series of separate negotiations.',
  '',
  'Would 20 minutes next week be useful to compare notes on rate cards?',
].join('\n')

describe('the copy that already ships passes', () => {
  it('accepts all 12 channel variants', () => {
    for (const v of MESSAGE_VARIANTS) {
      const r = check(v.body)
      expect(r.problems.map((p) => `${p.code}: ${p.detail}`), v.label).toEqual([])
    }
  })

  /**
   * `hasObservation: true` for the brand pool, and it is not a fudge. Every one of these opens
   * by asserting the recipient already buys placement — "You are already investing in placement
   * on entertainment publishers" — and that is true BY CONSTRUCTION: an account only becomes a
   * BRAND target because `ig:brands` found it inside a paid post we detected. The observation
   * exists; `describeDiscovery` is what hands it to the model.
   */
  it('accepts all 6 brand variants', () => {
    for (const v of BRAND_MESSAGE_VARIANTS) {
      const r = check(v.body, BRAND, [], true)
      expect(r.problems.map((p) => `${p.code}: ${p.detail}`), v.label).toEqual([])
    }
  })

  /** Bespoke bodies are hand-written ABOUT one named recipient, so they reference them freely. */
  it('accepts all 4 bespoke first touches', () => {
    for (const b of BESPOKE_DRAFTS) {
      const r = check(b.body, CHANNEL, [], true)
      expect(r.problems.map((p) => `${p.code}: ${p.detail}`), b.target).toEqual([])
    }
  })

  it('accepts the control body used by the negative cases below', () => {
    expect(check(GOOD).ok).toBe(true)
  })
})

describe('shape', () => {
  it('refuses a body far shorter than any we write', () => {
    const r = check('Quick note — worth a chat?')
    expect(r.ok).toBe(false)
    expect(r.problems.map((p) => p.code)).toContain('too-short')
  })

  it('refuses a body far longer than any we write', () => {
    // Four paragraphs, so the SHAPE is fine and only the length is wrong — the two checks
    // must be separable or "too long" could never be observed on its own.
    const para = (n: number) =>
      `Point ${n}: we own the inventory rather than broker it across 200+ pages, which removes an intermediary margin, and at 300M views a day that margin is the whole negotiation rather than a rounding error on it. Buying directly also means one calendar, one rate card and one team who plans, books and reports, instead of a separate arrangement with every publisher you would otherwise approach one at a time.`
    const long = [para(1), '', para(2), '', para(3), '', para(4)].join('\n')
    expect(long.length).toBeGreaterThan(1400)
    const r = check(long)
    expect(r.ok).toBe(false)
    expect(r.problems.map((p) => p.code)).toContain('too-long')
    expect(r.problems.map((p) => p.code)).not.toContain('bad-shape')
  })

  it('refuses a wall of paragraphs', () => {
    const r = check(Array.from({ length: 12 }, (_, i) => `Paragraph ${i} with enough words in it to be a real sentence about media.`).join('\n\n'))
    expect(r.problems.map((p) => p.code)).toContain('bad-shape')
  })
})

/**
 * Checked on the RENDERED message, and that distinction is the point. `{{brand}}` and
 * `{{channel}}` are legitimate — `renderMessage` substitutes them, so they never reach a
 * recipient, and rejecting them would reject all 18 shipping variants. What must be caught is
 * a placeholder NO substitution knows about, which sails through rendering into an inbox.
 */
describe('nothing unfilled reaches a prospect', () => {
  it('allows the placeholders renderMessage actually substitutes', () => {
    const body = 'A rolling calendar for {{channel}} across 200+ pages and 300M views a day, planned around your launches rather than ours.\n\nWould 20 minutes next week be a useful place to start on rate cards?'
    const r = check(body)
    expect(r.problems.map((p) => p.code)).not.toContain('placeholder')
  })

  it.each([
    ['{{company}}', 'A plan for {{company}} across the network, with 200+ pages and 300M views a day, planned around your launches rather than ours.'],
    ['{name}', 'A plan for {name} across the network, with 200+ pages and 300M views a day, planned around your launches rather than ours.'],
    ['[INSERT BRAND]', 'A plan for [INSERT BRAND] across the network, with 200+ pages and 300M views a day, planned around your launches rather than ours.'],
    ['<placeholder>', 'A plan for <placeholder> across the network, with 200+ pages and 300M views a day, planned around your launches rather than ours.'],
    ['TODO', 'A plan for you across the network, with 200+ pages and 300M views a day. TODO: add the rate card detail here before sending it out.'],
  ])('refuses %s', (_label, body) => {
    const r = check(body)
    expect(r.problems.map((p) => p.code)).toContain('placeholder')
  })
})

describe('it must be a message, not a chat reply about one', () => {
  it.each([
    'Sure! Here is a draft message for you.',
    "Here's the DM you asked for.",
    'Certainly. Below is the outreach message.',
    'Message: we own the inventory rather than broker it.',
  ])('refuses a preamble: %s', (opener) => {
    const r = check(`${opener}\n\n${GOOD}`)
    expect(r.problems.map((p) => p.code)).toContain('preamble')
  })

  /** The other direction: "here is" mid-sentence is ordinary English and must pass. */
  it('allows "here is" inside the prose', () => {
    const body = GOOD.replace('For a publisher', 'Here is the part that matters: for a publisher')
    expect(check(body).problems.map((p) => p.code)).not.toContain('preamble')
  })
})

describe('the persona is ours, exactly once', () => {
  it('refuses a body that writes its own phone number', () => {
    const r = check(`${GOOD}\n\nReach me on +91 60000 189766.`)
    expect(r.problems.map((p) => p.code)).toContain('body-has-phone')
  })

  it('refuses a body that writes its own email', () => {
    const r = check(`${GOOD}\n\nMail me at kapil@digitalsukoon.com.`)
    expect(r.problems.map((p) => p.code)).toContain('body-has-email')
  })

  it('refuses a body that writes its own sign-off', () => {
    const r = check(`${GOOD}\n\nBest,\nKapil`)
    expect(r.problems.map((p) => p.code)).toContain('body-has-signoff')
  })

  it('refuses a body that writes its own closing line', () => {
    const r = check(`${GOOD}\n\nLooking forward to connecting.`)
    expect(r.problems.map((p) => p.code)).toContain('body-has-closing')
  })

  it('refuses a body that introduces the sender again', () => {
    const r = check(`I'm Kapil Jain, Co-founder of Bollywood Society.\n\n${GOOD}`)
    expect(r.problems.map((p) => p.code)).toContain('body-has-intro')
  })

  /**
   * A DIFFERENT person's contact details is the worst version of this: it would send a real
   * prospect a phone number that is not ours, under our name.
   */
  it('refuses a body carrying a contact detail that is not the persona', () => {
    const r = check(`${GOOD}\n\nOr reach my colleague on +91 98765 43210 or at sales@example.com.`)
    const codes = r.problems.map((p) => p.code)
    expect(r.ok).toBe(false)
    // Caught as an unapproved figure — a phone number is not one of our figures.
    expect(codes).toContain('unapproved-figure')
  })
})

/**
 * The persona block must be OURS and appear exactly once. Driven by tampering with the
 * rendered string, because `renderMessage` cannot produce these states — which is precisely
 * why they need asserting: a check no input can fail is not a check, and mutation testing
 * showed these four could be deleted without breaking a single test.
 */
describe('the persona block appears exactly once in what would be sent', () => {
  const rendered = () => renderMessage({ persona: PERSONA, target: CHANNEL, variantBody: GOOD, hook: null }).body

  it('refuses a message carrying the phone number twice', () => {
    const tampered = rendered().replace(PERSONA.personaPhone, `${PERSONA.personaPhone}\n${PERSONA.personaPhone}`)
    const r = checkGeneratedMessage({ generated: GOOD, rendered: tampered, persona: PERSONA, target: CHANNEL })
    expect(r.problems.map((p) => p.code)).toContain('persona-phone')
  })

  it('refuses a message with the phone number missing', () => {
    const tampered = rendered().replace(PERSONA.personaPhone, '')
    const r = checkGeneratedMessage({ generated: GOOD, rendered: tampered, persona: PERSONA, target: CHANNEL })
    expect(r.problems.map((p) => p.code)).toContain('persona-phone')
  })

  it('refuses a message with the email missing', () => {
    const tampered = rendered().replace(PERSONA.personaEmail, '')
    const r = checkGeneratedMessage({ generated: GOOD, rendered: tampered, persona: PERSONA, target: CHANNEL })
    expect(r.problems.map((p) => p.code)).toContain('persona-email')
  })

  /**
   * The signature is the channel name + contacts since 2026-08-07, and it is checked as
   * ONE block against `signatureBlock(persona)` — so tampering with any line of it, or
   * signing as a different page, must refuse.
   */
  it('refuses a message whose signature names a different page', () => {
    const tampered = rendered().replace('Bollywood Society\n+91 60000 189766', 'Some Other Brand\n+91 60000 189766')
    const r = checkGeneratedMessage({ generated: GOOD, rendered: tampered, persona: PERSONA, target: CHANNEL })
    expect(r.problems.map((p) => p.code)).toContain('persona-signature')
  })

  it('refuses a message where a model wrote its own personal intro line', () => {
    const withIntro = "I'm Someone Else, Head of Growth of Another Company.\n\n" + GOOD
    const r = checkGeneratedMessage({ generated: withIntro, rendered: rendered(), persona: PERSONA, target: CHANNEL })
    expect(r.problems.map((p) => p.code)).toContain('body-has-intro')
  })

  /** And the permitting direction: the real render has each exactly once. */
  it('accepts the real render, where each appears exactly once', () => {
    const r = checkGeneratedMessage({ generated: GOOD, rendered: rendered(), persona: PERSONA, target: CHANNEL })
    expect(r.problems.map((p) => p.code)).not.toContain('persona-phone')
    expect(r.problems.map((p) => p.code)).not.toContain('persona-email')
    expect(r.problems.map((p) => p.code)).not.toContain('body-has-intro')
    expect(r.problems.map((p) => p.code)).not.toContain('persona-signature')
  })
})

describe('the greeting comes from buildGreeting', () => {
  it('refuses a body that writes its own greeting', () => {
    const r = check(`Hi there,\n\n${GOOD}`)
    expect(r.problems.map((p) => p.code)).toContain('body-has-greeting')
  })

  it('addresses a company as a team, and the gate confirms it', () => {
    const rendered = renderMessage({ persona: PERSONA, target: BRAND, variantBody: GOOD, hook: null }).body
    expect(rendered.startsWith('Hi Royal Canin India team,')).toBe(true)
    expect(checkGeneratedMessage({ generated: GOOD, rendered, persona: PERSONA, target: BRAND }).ok).toBe(true)
  })

  /** A rendered message whose greeting is not the expected one is refused outright. */
  it('refuses a rendered message that does not open with the expected greeting', () => {
    const rendered = renderMessage({ persona: PERSONA, target: CHANNEL, variantBody: GOOD, hook: null }).body
    const tampered = rendered.replace('Hi Mad Over Marketing,', 'Hey MOM!')
    const r = checkGeneratedMessage({ generated: GOOD, rendered: tampered, persona: PERSONA, target: CHANNEL })
    expect(r.problems.map((p) => p.code)).toContain('greeting')
  })
})

/**
 * ── THE CHECK THAT MATTERS MOST ───────────────────────────────────────────
 *
 * An invented figure reads perfectly and is a lie told to a company that buys media for a
 * living. No length or placeholder rule touches it.
 */
describe('every figure claimed is one we actually claim', () => {
  it.each(['500+ pages', '80M followers', '1 billion views a day', '2 crore views', '45% cheaper', '5000 creators'])(
    'refuses the invented claim %s',
    (claim) => {
      const r = check(`We own the inventory rather than broker it: ${claim} across the network, bought directly rather than through an intermediary.\n\nWould 20 minutes next week be useful to compare notes?`)
      expect(r.problems.map((p) => p.code), claim).toContain('unapproved-figure')
    },
  )

  it('allows every approved figure', () => {
    for (const figure of APPROVED_FIGURES) {
      const body = `We own the inventory rather than broker it, and the network is ${figure} strong across Instagram, Facebook, YouTube and Snapchat.\n\nWould 20 minutes next week be useful to compare notes on rate cards?`
      expect(check(body).problems.map((p) => p.code), figure).not.toContain('unapproved-figure')
    }
  })

  /** Durations and small counts are not reach claims and must not be blocked. */
  it.each(['20 minutes', '15 minutes', '4 campaigns', '3 launches', '2 weeks'])('allows the ordinary number %s', (phrase) => {
    const body = `We own the inventory rather than broker it: 200+ pages and 300M views a day, bought directly.\n\nWould ${phrase} be a useful place to start comparing notes on rate cards?`
    expect(check(body).problems.map((p) => p.code), phrase).not.toContain('unapproved-figure')
  })

  it('catches a figure that is close to a real one but wrong', () => {
    const r = check(`We own the inventory rather than broker it: 200+ pages, 169.3M followers combined, and 300M views a day.\n\nWould 20 minutes next week be useful?`)
    expect(r.problems.map((p) => p.detail).join(' ')).toContain('169.3M')
  })
})

describe('the send guards must be able to verify it', () => {
  /**
   * No needle means the composer read-back and the thread confirmation cannot fail, so the
   * message must not exist. This is the tautology this codebase has now fixed twice.
   */
  /**
   * Long enough and well-shaped, but every prose line is under the 40-character needle
   * minimum. The previous version of this test asserted only `ok === false`, which passed
   * because the body was ALSO too short — so the check under test was never exercised. A test
   * that passes for the wrong reason is the thing this suite exists to prevent.
   */
  it('refuses a body of the right length whose every line is too short to verify', () => {
    const body = [
      'Quick note about your feed.',
      '',
      'We run a lot of pages here.',
      '',
      'The rates are good, I think.',
      '',
      'Worth twenty minutes maybe?',
      '',
      'Let me know either way soon.',
      '',
      'Happy to send more detail on.',
      '',
      'Thanks for reading this far ok.',
      '',
      'Speak soon about all of this.',
    ].join('\n')
    const r = check(body)
    expect(body.length).toBeGreaterThan(200)
    expect(r.problems.map((p) => p.code)).not.toContain('too-short')
    expect(r.problems.map((p) => p.code)).toContain('unverifiable')
  })

  it('accepts a body with a substantial distinctive line', () => {
    expect(check(GOOD).problems.map((p) => p.code)).not.toContain('unverifiable')
  })

  /**
   * The defect measured and fixed on 2026-08-05: two messages sharing a needle make the
   * post-send thread confirmation unable to tell the new one from the old. Checked here so
   * generation cannot reintroduce what variant selection was just fixed to prevent.
   */
  it('refuses a body whose needle also appears in a message this recipient already has', () => {
    const priorRendered = renderMessage({ persona: PERSONA, target: CHANNEL, variantBody: GOOD, hook: null }).body
    const r = check(GOOD, CHANNEL, [priorRendered])
    expect(r.problems.map((p) => p.code)).toContain('needle-collides')
  })

  /** And the permitting direction: a genuinely different body is fine beside the old one. */
  it('accepts a body that shares no distinctive line with the prior one', () => {
    const priorRendered = renderMessage({ persona: PERSONA, target: CHANNEL, variantBody: GOOD, hook: null }).body
    const different = [
      'Most publishers we speak to are already selling placement one campaign at a time, which is the expensive way to do it for both sides.',
      '',
      'An annual arrangement across the whole owned network gives you a predictable calendar and gives us something to plan inventory against.',
      '',
      'If that is worth 20 minutes, I can bring the rate card.',
    ].join('\n')
    const r = check(different, CHANNEL, [priorRendered])
    expect(r.problems.map((p) => p.code)).not.toContain('needle-collides')
  })
})

describe('the verdict reports everything, not just the first thing', () => {
  it('lists every problem it found', () => {
    const r = check('Sure! Here is the draft for {{company}}.')
    const codes = r.problems.map((p) => p.code)
    expect(codes).toContain('preamble')
    expect(codes).toContain('placeholder')
    expect(codes).toContain('too-short')
    expect(r.problems.length).toBeGreaterThanOrEqual(3)
  })
})

/**
 * ── the same claim, spelled in WORDS ──────────────────────────────────────
 *
 * FOUND BY READING THE REAL GENERATED OUTPUT, 2026-08-05, and confirmed by execution: every
 * figure rule matched DIGITS, so all four of these passed the gate that exists to stop exactly
 * them. What made it visible was a generated message saying "under fifteen minutes" — harmless
 * in itself, and the reason to check whether the rule could see words at all. It could not.
 */
describe('a figure spelled in words is still a figure', () => {
  it.each(['five hundred pages', 'eighty million followers', 'two billion views a day', 'fifty crore views'])(
    'refuses %s',
    (claim) => {
      const body = `We own the inventory rather than broker it: ${claim} across the network, bought directly rather than through any intermediary at all.\n\nWould 20 minutes next week be useful to compare notes on rate cards?`
      expect(check(body).problems.map((p) => p.code), claim).toContain('unapproved-figure')
    },
  )

  /** The two approved figures that ARE spelled with a scale word must still pass. */
  it.each(['30 crore', '10 billion'])('allows the approved figure %s', (figure) => {
    const body = `We own the inventory rather than broker it, and the network sees ${figure} views across Instagram, Facebook, YouTube and Snapchat.\n\nWould 20 minutes next week be useful to compare notes on rate cards?`
    expect(check(body).problems.map((p) => p.code), figure).not.toContain('unapproved-figure')
  })

  /** A scale word with no figure attached is still a claim we did not authorise. */
  it('refuses a vague scale claim', () => {
    const body = `We own the inventory rather than broker it, and the network reaches many million people every single day across four platforms.\n\nWould 20 minutes next week be useful to compare notes on rate cards?`
    expect(check(body).problems.map((p) => p.code)).toContain('unapproved-figure')
  })

  /** And the hand-written copy, which uses "30 crore" and "10 billion", must still pass. */
  it('does not break the copy that already ships', () => {
    for (const v of MESSAGE_VARIANTS) {
      expect(check(v.body).problems.map((p) => p.code), v.label).not.toContain('unapproved-figure')
    }
    for (const v of BRAND_MESSAGE_VARIANTS) {
      expect(check(v.body, BRAND, [], true).problems.map((p) => p.code), v.label).not.toContain('unapproved-figure')
    }
  })
})

/**
 * ── it must not claim to know things it was not told ──────────────────────
 *
 * FOUND BY READING A REAL GENERATED MESSAGE. Told `Observation: none. Do not reference anything
 * specific about them.`, the model wrote Royal Canin: *"Your team already buys placement across
 * pet-focused pages and lifestyle feeds to reach owners."* Plausible, fluent, invented, and sent
 * to the people who would know. No figure rule touches it — there is no number in it.
 */
describe('a claim of prior knowledge needs an observation behind it', () => {
  const CLAIMS = [
    'Your team already buys placement across pet-focused pages and lifestyle feeds to reach owners.',
    'You are already investing in placement on entertainment publishers, so I will be brief.',
    'I noticed you have been running a lot of launch activity across the entertainment pages.',
    'Your recent campaign work suggests placement is already part of how you go to market.',
  ]

  it.each(CLAIMS)('refuses %s when nothing was observed', (claim) => {
    const body = `${claim}\n\nWe own the inventory rather than broker it: 200+ pages and 300M views a day, bought directly from the owner.\n\nWould 20 minutes next week be useful?`
    expect(check(body).problems.map((p) => p.code), claim).toContain('unsupported-claim')
  })

  /** The permitting direction, and the one that matters: with an observation, it is grounded. */
  it.each(CLAIMS)('allows %s when there IS an observation', (claim) => {
    const body = `${claim}\n\nWe own the inventory rather than broker it: 200+ pages and 300M views a day, bought directly from the owner.\n\nWould 20 minutes next week be useful?`
    expect(check(body, CHANNEL, [], true).problems.map((p) => p.code), claim).not.toContain('unsupported-claim')
  })

  /** A body that claims nothing about them passes either way. */
  it('allows a body that asserts nothing about the recipient', () => {
    expect(check(GOOD).problems.map((p) => p.code)).not.toContain('unsupported-claim')
    expect(check(GOOD, CHANNEL, [], true).problems.map((p) => p.code)).not.toContain('unsupported-claim')
  })

  /** Defaults to the STRICT setting, so a caller that forgets gets the safe direction. */
  it('defaults to refusing when hasObservation is not passed at all', () => {
    const body = `You are already investing in placement on entertainment publishers, so I will be brief.\n\nWe own the inventory rather than broker it: 200+ pages and 300M views a day.\n\nWould 20 minutes be useful?`
    const rendered = renderMessage({ persona: PERSONA, target: CHANNEL, variantBody: body, hook: null }).body
    const r = checkGeneratedMessage({ generated: body, rendered, persona: PERSONA, target: CHANNEL })
    expect(r.problems.map((p) => p.code)).toContain('unsupported-claim')
  })
})
