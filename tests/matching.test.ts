import { describe, it, expect } from 'vitest'
import {
  distinctiveSlice,
  messageMatchesOurs,
  matchesAnyOfOurs,
  isOneOfOurs,
  normalise,
  proseLines,
  countOccurrences,
  bodyAppearedSince,
} from '@/outreach/matching'
import { renderMessage, isEnvelopeLine } from '@/outreach/render'
import { MESSAGE_VARIANTS } from '../prisma/variants'

/**
 * These two functions decide whether a send is recorded and whether outreach
 * halts. Both failure directions are expensive:
 *
 *   false positive on "this is ours"  → a real reply is missed, and we keep
 *                                       pitching someone who already answered
 *   false negative on "this is ours"  → our own message is read as a reply, and
 *                                       outreach halts for no reason
 *
 * The second is the safer way to be wrong, and the design leans that way.
 */

const PERSONA = {
  personaName: 'Kapil Jain',
  personaRole: 'Co-founder',
  personaBrand: 'Bollywood Society',
  personaPhone: '+91 60000 189766',
  personaEmail: 'kapil@digitalsukoon.com',
}
const MOM = {
  handle: 'madovermarketing_mom',
  displayName: 'Mad Over Marketing (M.O.M)',
  contactFirstName: 'Mad Over Marketing',
  kind: 'CHANNEL',
}

const realMessage = renderMessage({
  persona: PERSONA,
  target: MOM,
  variantBody: MESSAGE_VARIANTS[0]!.body,
  hook: null,
}).body

describe('distinctiveSlice', () => {
  it('avoids the greeting, which also appears in the thread header', () => {
    const slice = distinctiveSlice(realMessage)!
    expect(slice).not.toContain('Hi Mad Over Marketing')
  })

  it('avoids the signature, which contains contact details rendered elsewhere', () => {
    const slice = distinctiveSlice(realMessage)!
    expect(slice).not.toContain('+91')
    expect(slice).not.toContain('digitalsukoon')
  })

  it('returns a substantial chunk of real body text', () => {
    const slice = distinctiveSlice(realMessage)!
    expect(slice.length).toBeGreaterThan(30)
    expect(realMessage).toContain(slice)
  })

  it('produces something usable for every variant', () => {
    for (const v of MESSAGE_VARIANTS) {
      const body = renderMessage({ persona: PERSONA, target: MOM, variantBody: v.body, hook: null }).body
      const slice = distinctiveSlice(body)
      expect(slice, v.label).not.toBeNull()
      expect(body, v.label).toContain(slice!)
    }
  })

  it('returns null when there is nothing to match on', () => {
    expect(distinctiveSlice('')).toBeNull()
    expect(distinctiveSlice('ok')).toBeNull()
  })

  /**
   * A short body is now UNVERIFIABLE rather than verified against something generic.
   *
   * This replaces "falls back gracefully on a short message", which asserted that a
   * 31-character single-line body returned itself. Graceful was the wrong goal: whatever
   * comes back is what both send guards will search the page for, so returning something
   * weak is worse than returning nothing. Null means the send is refused, and
   * `editAttemptBody` refuses to save such a body in the first place.
   */
  it('refuses a body with no prose line long enough to prove anything', () => {
    expect(distinctiveSlice('Hi there, following up on this.')).toBeNull()
    expect(distinctiveSlice('Hi Bollywood Chronicle,\n\nThis is a test message.')).toBeNull()
    expect(distinctiveSlice('Hi Priyanshu,\n\nShort note about the campaign.\n\nThanks')).toBeNull()
    expect(distinctiveSlice('Hi Bollywood Chronicle,\n\nok')).toBeNull()
  })

  /** ...and the other direction: one long prose line is enough, and it is the one chosen. */
  it('accepts a short body the moment one prose line is substantial', () => {
    const body = 'Hi Bollywood Chronicle,\n\nThis is a test message that is long enough to identify.'
    const needle = distinctiveSlice(body)
    expect(needle).toBe('This is a test message that is long enough to identify.')
    expect(needle).not.toContain('Hi Bollywood Chronicle')
  })

  it('never returns the greeting, whatever else is available', () => {
    for (const body of [
      'Hi Bollywood Chronicle,\n\nThis is a test message.',
      'Hi Priyanshu,\n\nShort note.\n\nThanks',
      'Hi a very very long recipient display name indeed team,\n\nshort',
    ]) {
      const needle = distinctiveSlice(body)
      if (needle !== null) expect(needle.toLowerCase()).not.toContain('hi ')
    }
  })

  /**
   * ── THE ASSERTION THAT WOULD HAVE CAUGHT BOTH INSTANCES OF THIS BUG ──
   *
   * A needle is only evidence if it identifies THIS message. Both send guards search a
   * page for it: the composer read-back before Enter, and the thread confirmation after.
   * If the needle also occurs in a different message from the same sender, neither guard
   * can fail — and both keep returning true on the happy path, so nothing looks wrong.
   *
   * VERIFIED BY EXECUTION 2026-08-04 before the fix, and both of these produced a
   * cross-match:
   *
   *   short prose, no hook  → "I'm Kapil Jain, Co-founder of Bollywood Society." (48 ch)
   *   short prose, hooked   → "I noticed your recent branded collaboration with …" (60)
   *
   * CLAUDE.md recorded this as fixed FOR THE GREETING with a 20-character minimum. The
   * intro is 48 characters. A minimum cannot fix it, because envelope lines are not
   * short — they are shared.
   */
  const HOOK = { brands: JSON.stringify(['RoyalCanin']), postedAt: new Date('2026-08-02'), verdict: 'CAMPAIGN' }

  it('never picks a needle that also matches a DIFFERENT body from the same sender', () => {
    const bodies = [
      // Short prose — the case that produced the persona intro as a needle.
      { label: 'short/no-hook', variantBody: 'Quick note about your recent post.\n\nWorth a chat?', hook: null },
      { label: 'short/hook', variantBody: 'Following up on my last note.\n\nAny interest?', hook: HOOK },
      // Real prose — the case that always worked, kept as the control.
      { label: 'variant-0', variantBody: MESSAGE_VARIANTS[0]!.body, hook: HOOK },
      { label: 'variant-5', variantBody: MESSAGE_VARIANTS[5]!.body, hook: HOOK },
      { label: 'variant-9', variantBody: MESSAGE_VARIANTS[9]!.body, hook: null },
    ].map((b) => ({
      label: b.label,
      body: renderMessage({ persona: PERSONA, target: MOM, variantBody: b.variantBody, hook: b.hook }).body,
    }))

    for (const a of bodies) {
      for (const b of bodies) {
        if (a.label === b.label) continue
        expect(messageMatchesOurs(b.body, a.body), `needle(${a.label}) must not match ${b.label}`).toBe(false)
      }
    }
  })

  /**
   * The signature block is identical in every message this sender writes, so no line of
   * it may ever become the needle — a needle from the envelope proves nothing. The intro
   * line this test used to render was retired 2026-08-07 (the persona is the channel name
   * alone); a LEGACY body still carrying it must ALSO never yield it as a needle, because
   * delivered messages keep the old shape forever.
   */
  it('never picks the signature block, which is identical in every message this sender writes', () => {
    const body = renderMessage({
      persona: PERSONA,
      target: MOM,
      variantBody: 'Quick note.\n\nWorth a chat?',
      hook: null,
    }).body
    expect(body).toContain('Bollywood Society\n+91 60000 189766')
    expect(distinctiveSlice(body)).toBeNull()
  })

  it('never picks the RETIRED intro line out of a legacy body', () => {
    const legacy = [
      'Hi Mad Over Marketing team,',
      '',
      "I'm Kapil Jain, Co-founder of Bollywood Society.",
      '',
      'Quick note.',
      '',
      'Worth a chat?',
    ].join('\n')
    expect(distinctiveSlice(legacy)).not.toBe("I'm Kapil Jain, Co-founder of Bollywood Society.")
  })

  it('never picks the hook line, which is identical in every message about one campaign', () => {
    const body = renderMessage({
      persona: PERSONA,
      target: MOM,
      variantBody: 'Quick note.\n\nWorth a chat?',
      hook: HOOK,
    }).body
    expect(body).toContain('I noticed your recent branded collaboration with Royal Canin')
    expect(distinctiveSlice(body)).toBeNull()
  })

  /**
   * THE SYNC TEST. Add a line to `renderMessage` without teaching this module about it
   * and this fails — rather than the guard quietly weakening the next time a body is
   * short, which is how the same bug shipped twice.
   *
   * Asserted on `proseLines`, the composite, rather than on `isEnvelopeLine` alone: two
   * rules exclude envelope (position for the greeting and the signature block, shape for
   * the intro, hook and closing line) and a line only has to be caught by one of them.
   * Testing the patterns alone would fail on "Kapil Jain" — a bare name has no shape to
   * match — and would say nothing about whether it can reach a needle, which is the
   * question that matters.
   */
  it('leaves ONLY the prose after stripping the envelope', () => {
    const rendered = renderMessage({
      persona: PERSONA,
      target: MOM,
      variantBody: 'THE ONLY PROSE LINE IN THIS ENTIRE MESSAGE, AND IT IS LONG.',
      hook: HOOK,
    }).body
    // Nine lines go in; one is prose.
    expect(rendered.split('\n').filter((l) => l.trim().length > 0).length).toBeGreaterThan(6)
    expect(proseLines(rendered)).toEqual(['THE ONLY PROSE LINE IN THIS ENTIRE MESSAGE, AND IT IS LONG.'])
  })

  it('leaves only the prose for a multi-line variant too', () => {
    const rendered = renderMessage({
      persona: PERSONA,
      target: MOM,
      variantBody: MESSAGE_VARIANTS[0]!.body,
      hook: HOOK,
    }).body
    const prose = proseLines(rendered)
    const expected = MESSAGE_VARIANTS[0]!.body.split('\n').map((l) => l.trim()).filter((l) => l.length > 0)
    expect(prose).toEqual(expected)
  })

  it('recognises the shaped envelope lines by pattern', () => {
    expect(isEnvelopeLine('Hi Mad Over Marketing,')).toBe(true)
    expect(isEnvelopeLine("I'm Kapil Jain, Co-founder of Bollywood Society.")).toBe(true)
    expect(isEnvelopeLine('I noticed your recent branded collaboration with Royal Canin — nicely executed.')).toBe(true)
    expect(isEnvelopeLine('Looking forward to connecting.')).toBe(true)
    expect(isEnvelopeLine('+91 60000 189766')).toBe(true)
    expect(isEnvelopeLine('kapil@digitalsukoon.com')).toBe(true)
  })

  /** ...and the other direction, or the patterns could just return true for everything. */
  it('does NOT treat real prose as envelope', () => {
    for (const v of MESSAGE_VARIANTS) {
      for (const line of v.body.split('\n').map((l) => l.trim()).filter((l) => l.length > 0)) {
        expect(isEnvelopeLine(line), `prose wrongly classed as envelope: ${JSON.stringify(line)}`).toBe(false)
      }
    }
  })

  /**
   * The opening line of variant 1 is "I'm reaching out to explore a long-term strategic
   * partnership...". The persona-intro pattern is anchored on a comma AND " of ", so it
   * does not swallow it — a real risk, since a greedy `/^I'm /` would have.
   */
  it('leaves a prose line that merely starts with "I\'m" alone', () => {
    expect(isEnvelopeLine("I'm reaching out to explore a long-term strategic partnership rather than a one-off campaign.")).toBe(false)
    expect(isEnvelopeLine("I'm Kapil Jain, Co-founder of Bollywood Society.")).toBe(true)
  })
})

describe('messageMatchesOurs', () => {
  it('recognises our own message read back verbatim', () => {
    expect(messageMatchesOurs(realMessage, realMessage)).toBe(true)
  })

  it('survives the whitespace collapsing Instagram applies', () => {
    // The DOM yields one run-on string with newlines flattened to spaces.
    const flattened = realMessage.replace(/\s+/g, ' ')
    expect(messageMatchesOurs(flattened, realMessage)).toBe(true)
  })

  it('survives surrounding chrome in the message row', () => {
    const withChrome = `Kapil Jain 14:22 ${realMessage.replace(/\s+/g, ' ')} Seen`
    expect(messageMatchesOurs(withChrome, realMessage)).toBe(true)
  })

  /**
   * With the needle taken from the greeting, a page holding only thread chrome
   * satisfied the post-send check - so the guard could not fail - and a paste that
   * lost everything after the greeting satisfied the composer read-back.
   */
  it('does NOT report a short edited message as delivered from thread chrome alone', () => {
    const body = 'Hi Bollywood Chronicle,\n\nThis is a test message.'
    const chromeOnly = 'Bollywood Chronicle  bollywoodchronicle  Active now  Hi Bollywood Chronicle,  Message'
    expect(messageMatchesOurs(chromeOnly, body)).toBe(false)
  })

  it('does NOT accept a paste that lost everything after the greeting', () => {
    const body = 'Hi Bollywood Chronicle,\n\nThis is a test message.'
    expect(messageMatchesOurs('Hi Bollywood Chronicle,', body)).toBe(false)
  })

  /**
   * The positive direction for a short-but-verifiable body.
   *
   * The previous version of this used a 23-character prose line, which is now refused
   * outright — so the assertion would have passed for the wrong reason had it been left
   * alone. The prose is one character over the minimum here, deliberately: it proves the
   * boundary admits as well as refuses.
   */
  it('still matches when the real short body IS present', () => {
    const body = 'Hi Bollywood Chronicle,\n\nThis is a test message that is long enough to identify.'
    const delivered =
      'Bollywood Chronicle  Hi Bollywood Chronicle, This is a test message that is long enough to identify.  Message'
    expect(messageMatchesOurs(delivered, body)).toBe(true)
  })

  /** ...and the same body is NOT confirmed by thread chrome alone. */
  it('does not confirm that same body from thread chrome alone', () => {
    const body = 'Hi Bollywood Chronicle,\n\nThis is a test message that is long enough to identify.'
    expect(messageMatchesOurs('Bollywood Chronicle  bollywoodchronicle  Active now  Message', body)).toBe(false)
  })

  it('is case-insensitive', () => {
    expect(messageMatchesOurs(realMessage.toUpperCase(), realMessage)).toBe(true)
  })

  it('does NOT match a genuine reply', () => {
    // The case that matters most: this is what triggers the halt.
    const reply = 'Hi Kapil, thanks for reaching out. Can you share a deck and rates?'
    expect(messageMatchesOurs(reply, realMessage)).toBe(false)
  })

  it('does not match a reply that quotes our signature', () => {
    // Someone replying may quote the contact block. That is still their message,
    // and slicing from mid-body rather than the signature is what protects us.
    const reply = 'Thanks Kapil Jain, Co-founder, Bollywood Society — will revert.'
    expect(messageMatchesOurs(reply, realMessage)).toBe(false)
  })

  it('does not match a short pleasantry', () => {
    expect(messageMatchesOurs('Sure', realMessage)).toBe(false)
    expect(messageMatchesOurs('👍', realMessage)).toBe(false)
  })
})

describe('matchesAnyOfOurs', () => {
  const variantA = renderMessage({
    persona: PERSONA,
    target: MOM,
    variantBody: MESSAGE_VARIANTS[0]!.body,
    hook: null,
  }).body
  const variantB = renderMessage({
    persona: PERSONA,
    target: MOM,
    variantBody: MESSAGE_VARIANTS[5]!.body,
    hook: null,
  }).body

  it('recognises any prior message on the thread, not just the latest', () => {
    // Variants rotate, so the last message we sent may be any of them.
    expect(matchesAnyOfOurs(variantA, [variantA, variantB])).toBe(true)
    expect(matchesAnyOfOurs(variantB, [variantA, variantB])).toBe(true)
  })

  it('still identifies a reply when several of ours precede it', () => {
    expect(matchesAnyOfOurs('Interested — what are your rates?', [variantA, variantB])).toBe(false)
  })

  it('treats an empty history as "not ours"', () => {
    // Fails toward halting rather than toward continuing to message.
    expect(matchesAnyOfOurs('anything at all', [])).toBe(false)
  })
})

describe('normalise', () => {
  it('collapses whitespace and lowercases', () => {
    expect(normalise('  Hello   \n  World ')).toBe('hello world')
  })
})

// ── isOneOfOurs: reading a thread, where "no match" means "they said it" ────

describe('isOneOfOurs — our own message must never read as a reply', () => {
  /**
   * OBSERVED IN PRODUCTION 2026-08-05, not imagined.
   *
   * The automatic reply check read a real thread and recorded this as the recipient's
   * reply — byte-identical to our own `renderedBody` on the attempt it then marked
   * REPLIED, halting every sender to that target.
   *
   * `distinctiveSlice` returns null for it: two lines, both ends excluded, 40-char
   * minimum. So `messageMatchesOurs(body, body)` is FALSE — a message did not match
   * itself. That is the correct default for the send guards (refuse what you cannot
   * verify) and exactly backwards for reading a thread.
   */
  const SHORT = 'Hi Bollywood Chronicle,\n\nThis is a test message.'

  it('the exact failure: a short body has no needle at all', () => {
    expect(distinctiveSlice(SHORT)).toBeNull()
    expect(messageMatchesOurs(SHORT, SHORT)).toBe(false)
  })

  it('and isOneOfOurs recognises it anyway', () => {
    expect(isOneOfOurs(SHORT, [SHORT])).toBe(true)
  })

  it('recognises it among several of our bodies', () => {
    expect(isOneOfOurs(SHORT, ['something else entirely we sent', SHORT])).toBe(true)
  })

  it('survives the whitespace collapsing Instagram applies', () => {
    expect(isOneOfOurs('Hi Bollywood Chronicle,   This is a test message.', [SHORT])).toBe(true)
  })

  it('recognises a bubble carrying our body plus surrounding chrome', () => {
    expect(isOneOfOurs(`${SHORT}\nSent 2 hours ago`, [SHORT])).toBe(true)
  })

  it('recognises a body truncated behind "see more"', () => {
    const long =
      'Hi there, I run a network of Bollywood pages and wanted to ask about a partnership on your recent campaign.'
    expect(isOneOfOurs(long.slice(0, 60), [long])).toBe(true)
  })

  /**
   * THE OTHER DIRECTION, which is the one that matters most: a real reply must still be
   * recognised as theirs. A matcher that answered "ours" to everything would silently
   * disable the hardest guard in the system, and it would look perfectly healthy.
   */
  it('a genuine reply is NOT ours', () => {
    expect(isOneOfOurs('sure, send me the deck', [SHORT])).toBe(false)
  })

  it('a short reply is NOT ours', () => {
    expect(isOneOfOurs('hi', [SHORT])).toBe(false)
  })

  it('an empty bubble is not ours', () => {
    expect(isOneOfOurs('   ', [SHORT])).toBe(false)
  })

  it('nothing is ours when we have sent nothing', () => {
    expect(isOneOfOurs('anything at all', [])).toBe(false)
  })

  /**
   * The greeting must NOT count. It renders in the thread header whether anything was
   * delivered or not — the tautology that made both send guards unfalsifiable once, and
   * which would here make every reply look like our own message.
   */
  it('the greeting alone is not one of our messages', () => {
    expect(isOneOfOurs('Hi Bollywood Chronicle,', [SHORT])).toBe(false)
  })

  it('a short prefix of our body is not enough', () => {
    expect(isOneOfOurs('Hi Bolly', [SHORT])).toBe(false)
  })
})

describe('countOccurrences', () => {
  it('counts a single hit', () => {
    expect(countOccurrences('alpha beta gamma', 'beta')).toBe(1)
  })

  it('counts repeats', () => {
    expect(countOccurrences('beta and beta and beta', 'beta')).toBe(3)
  })

  it('counts zero when absent', () => {
    expect(countOccurrences('alpha gamma', 'beta')).toBe(0)
  })

  it('is whitespace and case insensitive, like every other comparison here', () => {
    expect(countOccurrences('Alpha   BETA\n\ngamma', 'alpha beta')).toBe(1)
  })

  /** An empty needle would otherwise match infinitely often at every position. */
  it('returns 0 for an empty needle rather than looping', () => {
    expect(countOccurrences('anything at all', '')).toBe(0)
    expect(countOccurrences('anything at all', '   \n ')).toBe(0)
  })

  /** Non-overlapping. 'aa' occurs twice in 'aaaa', not three times. */
  it('advances past each match', () => {
    expect(countOccurrences('aaaa', 'aa')).toBe(2)
  })
})

/**
 * ── the post-send confirmation must ask for a DELTA, not for presence ──────
 *
 * `messageMatchesOurs(wholePage, body)` asks *is the needle present*. The thread already
 * holds every message we sent before, so an EARLIER message of ours carrying the same
 * needle satisfies it on its own — and the guard cannot fail.
 *
 * VERIFIED BY EXECUTION 2026-08-05 against the live database. Variants are chosen by an
 * LRU scoped to the SENDER, so nothing stopped one pair being handed the same variant
 * twice: 8 of 11 pairs had already reused one, one of them five times. Building a thread
 * out of an earlier attempt alone and asking the old guard about a LATER attempt returned
 * `true` — a confirmed delivery for a message that was not there. The bodies were not even
 * identical (different hook lines); a shared needle is enough.
 *
 * Latent rather than live today: 0 delivered messages yet share a needle with a later one
 * on the same pair, because only 6 have ever been delivered. It goes live on the first
 * follow-up that repeats a needle.
 */
describe('bodyAppearedSince — an earlier bubble must not confirm a new send', () => {
  const OURS = [
    'Hi Mad Over Marketing,',
    '',
    'We run a network of 200 entertainment pages with a combined reach north of sixty million.',
    '',
    'Would a short call next week be useful to compare notes on rate cards?',
    '',
    'Best,',
    'Kapil Jain',
    'Co-founder, Bollywood Society',
  ].join('\n')

  const needle = distinctiveSlice(OURS)!

  it('has a needle to work with at all — the trigger state is reachable', () => {
    expect(needle).toBeTruthy()
    expect(needle.length).toBeGreaterThanOrEqual(40)
  })

  it('confirms a genuine send: the needle count went up', () => {
    const before = 'Thread header. An unrelated earlier message.'
    const after = `${before} ${OURS} 12:04`
    expect(bodyAppearedSince(before, after, OURS)).toBe(true)
  })

  it('refuses when nothing changed', () => {
    const before = 'Thread header. An unrelated earlier message.'
    expect(bodyAppearedSince(before, before, OURS)).toBe(false)
  })

  /**
   * THE ONE THAT WOULD HAVE CAUGHT THE LIVE DEFECT. The thread already contains a message
   * with this needle and pressing Enter added nothing. The old guard said "delivered".
   */
  it('refuses when the needle was ALREADY in the thread and no new copy appeared', () => {
    const threadWithOurEarlierMessage = `Thread header. ${OURS} yesterday`
    // The old guard's answer, kept as an executable record of what was wrong.
    expect(messageMatchesOurs(threadWithOurEarlierMessage, OURS)).toBe(true)
    // The new one.
    expect(bodyAppearedSince(threadWithOurEarlierMessage, threadWithOurEarlierMessage, OURS)).toBe(false)
  })

  it('still confirms a real follow-up when an earlier copy is present', () => {
    const before = `Thread header. ${OURS} yesterday`
    const after = `${before} ${OURS} today`
    expect(bodyAppearedSince(before, after, OURS)).toBe(true)
  })

  /** A body with no distinctive line is refused, exactly as the send guards refuse it. */
  it('refuses a body it cannot pick a needle from', () => {
    const unverifiable = 'Hi there,\n\nThanks.'
    expect(distinctiveSlice(unverifiable)).toBeNull()
    expect(bodyAppearedSince('', `whatever ${unverifiable}`, unverifiable)).toBe(false)
  })

  /**
   * If the composer already held a stale draft when the baseline was read, `before` is one
   * too high and this refuses. Fail-closed: the send parks as `not-in-thread`, which is
   * visible on /messages with the two buttons that settle it, rather than recorded as
   * delivered.
   */
  it('fails closed when the baseline already counted our staged text', () => {
    const beforeWithStagedDraft = `Thread header. ${OURS}` // our text in the composer
    const afterSend = `Thread header. ${OURS} 12:04` // composer cleared, bubble added
    expect(bodyAppearedSince(beforeWithStagedDraft, afterSend, OURS)).toBe(false)
  })
})
