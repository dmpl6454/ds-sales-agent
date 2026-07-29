import { describe, it, expect } from 'vitest'
import {
  parseOgDescription,
  parseCount,
  decodeEntities,
  extractOgDescription,
  EnrichParseError,
} from '@/detection/enrich'
import { ALL_POSTS, MOM_POSTS } from './fixtures/posts'

/**
 * The parser is the seam between us and Instagram. If they change the
 * og:description shape, these tests are the alarm — which is why they run
 * against real captured strings rather than invented ones.
 */

describe('parseCount', () => {
  it('parses comma-grouped integers', () => {
    expect(parseCount('1,856')).toBe(1856)
    expect(parseCount('520')).toBe(520)
    expect(parseCount('0')).toBe(0)
  })

  it('parses abbreviated counts, which appear on high-engagement posts', () => {
    expect(parseCount('56K')).toBe(56_000)
    expect(parseCount('173K')).toBe(173_000)
    expect(parseCount('1.2M')).toBe(1_200_000)
    expect(parseCount('2B')).toBe(2_000_000_000)
  })

  it('returns null rather than NaN on garbage', () => {
    expect(parseCount('many')).toBeNull()
    expect(parseCount('')).toBeNull()
  })
})

describe('decodeEntities', () => {
  it('decodes the hex entities Instagram emits for emoji', () => {
    expect(decodeEntities('&#x2764;')).toBe('❤')
    expect(decodeEntities('&#x1f970;')).toBe('\u{1f970}')
  })

  it('decodes ampersand last so escaped entities do not double-decode', () => {
    // "&amp;#x2764;" is a literal "&#x2764;", not a heart.
    expect(decodeEntities('&amp;#x2764;')).toBe('&#x2764;')
  })

  it('handles quotes and decimal entities', () => {
    expect(decodeEntities('&quot;hi&quot;')).toBe('"hi"')
    expect(decodeEntities('&#8217;')).toBe('’')
  })
})

describe('extractOgDescription', () => {
  it('finds the tag regardless of attribute order', () => {
    expect(
      extractOgDescription('<meta property="og:description" content="hello world" />'),
    ).toBe('hello world')
    expect(
      extractOgDescription('<meta content="hello world" property="og:description" />'),
    ).toBe('hello world')
  })

  it('falls back to the plain description meta tag', () => {
    expect(extractOgDescription('<meta name="description" content="fallback" />')).toBe('fallback')
  })

  it('returns null when absent, so the caller can alarm', () => {
    expect(extractOgDescription('<html><body>login wall</body></html>')).toBeNull()
  })
})

describe('parseOgDescription against real captured posts', () => {
  it.each(ALL_POSTS)('parses $shortcode', (fixture) => {
    const post = parseOgDescription(fixture.shortcode, fixture.og, 0)
    expect(post.shortcode).toBe(fixture.shortcode)
    expect(post.caption.length).toBeGreaterThan(0)
    expect(post.likeCount).not.toBeNull()
    expect(post.commentCount).not.toBeNull()
    expect(post.postedAt.getTime()).not.toBeNaN()
    expect(post.permalink).toBe(`https://www.instagram.com/p/${fixture.shortcode}/`)
  })

  it('extracts owner, counts and date exactly', () => {
    const post = parseOgDescription('DbXt6aCTWir', ALL_POSTS.find((p) => p.shortcode === 'DbXt6aCTWir')!.og, 3)
    expect(post.ownerHandle).toBe('viralbhayani')
    expect(post.likeCount).toBe(1856)
    expect(post.commentCount).toBe(46)
    expect(post.postedAt.toISOString().slice(0, 10)).toBe('2026-07-29')
    expect(post.gridIndex).toBe(3)
    expect(post.caption).toBe('The ageless diva #malaikaarora spotted with her mystery friend')
  })

  it('keeps multi-line captions intact, including trailing hashtag blocks', () => {
    const f = MOM_POSTS.find((p) => p.shortcode === 'DbVMqWgTOOg')!
    const post = parseOgDescription(f.shortcode, f.og, 0)
    expect(post.caption).toContain('\n')
    expect(post.caption).toContain('#Collaboration')
    expect(post.caption).toContain('#RoyalCanin')
    // The trailing SEO keyword block must survive too — it is part of the caption.
    expect(post.caption).toContain('storytelling]')
  })

  it('handles the K-suffix on a high-engagement post', () => {
    const f = MOM_POSTS.find((p) => p.shortcode === 'Cvg0aZ9ST-P')!
    const post = parseOgDescription(f.shortcode, f.og, 0)
    expect(post.likeCount).toBe(173_000)
    expect(post.commentCount).toBe(824)
    expect(post.postedAt.toISOString().slice(0, 10)).toBe('2023-08-03')
  })

  it('throws EnrichParseError — not a silent null — when the shape changes', () => {
    expect(() => parseOgDescription('XXXX', 'Instagram photos and videos', 0)).toThrow(EnrichParseError)
    expect(() => parseOgDescription('XXXX', '', 0)).toThrow(EnrichParseError)
  })
})
