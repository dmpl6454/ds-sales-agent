import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { provenanceFor, provenanceLabel, type ProvenancePost } from '@/outreach/messageProvenance'

/**
 * "Why was this message sent, and for which paid post?" (Tabish, 2026-08-31).
 *
 * The rule is a LOOKUP over two stored columns, and the property that carries the weight
 * is the one about what it must NOT do: when neither column answers it says so, rather
 * than searching the corpus for a paid post that plausibly names the recipient. That set
 * is what the ALLOWANCE counts; naming a member of it as "the reason" would put a specific
 * claim on screen that no stored fact supports — in the one place a plausible-looking
 * guess would never be questioned.
 */

const claimed: ProvenancePost = {
  shortcode: 'DcnUhAMKUO8',
  channelHandle: 'viralbhayani',
  postedAt: new Date('2026-08-29T06:44:13Z'),
}
const discovered: ProvenancePost = {
  shortcode: 'DcWEJ_-ML96',
  channelHandle: 'varindertchawla',
  postedAt: new Date('2026-08-24T11:00:00Z'),
}

describe('provenanceFor', () => {
  it('names the CLAIMED post when the message claimed one', () => {
    const v = provenanceFor({ claimed, discovered: null })
    expect(v.basis).toBe('claimed')
    expect(v.post).toEqual(claimed)
    expect(v.sentence).toContain('@viralbhayani')
  })

  it('falls back to the post the company was DISCOVERED from', () => {
    const v = provenanceFor({ claimed: null, discovered })
    expect(v.basis).toBe('discovered')
    expect(v.post).toEqual(discovered)
    expect(v.sentence).toContain('@varindertchawla')
  })

  /**
   * The claim is about THIS message; discovery is about the recipient's existence. A
   * follow-up that claimed a fresh post must not be described by the post that found the
   * company months earlier — that would make every message look like a first touch.
   */
  it('prefers the claim over discovery when both exist', () => {
    const v = provenanceFor({ claimed, discovered })
    expect(v.basis).toBe('claimed')
    expect(v.post).toEqual(claimed)
  })

  /** THE LOAD-BEARING CASE: no stored fact, no sentence, no invented post. */
  it('answers "unknown" with NO post and NO prose when neither column is set', () => {
    const v = provenanceFor({ claimed: null, discovered: null })
    expect(v.basis).toBe('unknown')
    expect(v.post).toBeNull()
    expect(v.sentence).toBe('')
  })

  /** The two bases must not read as the same statement — they are different facts. */
  it('says something different for a claim than for a discovery', () => {
    const a = provenanceFor({ claimed, discovered: null }).sentence
    const b = provenanceFor({ claimed: null, discovered }).sentence
    expect(a).not.toBe(b)
    expect(a.length).toBeGreaterThan(20)
    expect(b.length).toBeGreaterThan(20)
  })

  it('labels a post by channel and date, never by shortcode', () => {
    const label = provenanceLabel(claimed, '2026-08-29')
    expect(label).toContain('@viralbhayani')
    expect(label).toContain('2026-08-29')
    // A reader recognises the channel and the day; nobody recognises "DcnUhAMKUO8".
    expect(label).not.toContain(claimed.shortcode)
  })
})

/**
 * A SOURCE GREP, because the failure mode is a call site nobody has written yet: the
 * moment someone "improves" this by searching for a naming post, the screen starts
 * asserting a reason the database does not hold. No behavioural test can fail for a
 * reconstruction that has not been added.
 */
describe('the resolver reads stored columns only', () => {
  const src = readFileSync(join(process.cwd(), 'src/outreach/messageProvenance.ts'), 'utf8')
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')

  it('never queries, and never reaches for the naming/allowance linkage', () => {
    expect(code).not.toMatch(/prisma\./)
    expect(code).not.toMatch(/campaignsNamingHandle/)
    expect(code).not.toMatch(/mentionsHandleExactly/)
    expect(code).not.toMatch(/brandStringsNameProspect/)
  })

  it('is pure — no await, no clock', () => {
    expect(code).not.toMatch(/\bawait\b/)
    expect(code).not.toMatch(/Date\.now\(\)/)
  })
})
