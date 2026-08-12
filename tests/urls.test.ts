import { describe, it, expect } from 'vitest'
import { assertSafeHandle, dmInboxUrl, profileUrl } from '@/lib/urls'

/**
 * These assertions exist because of a real defect found on 2026-07-30: the
 * dashboard's "Open Instagram" button pointed at `https://ig.me/m/<handle>`, which
 * returns HTTP 400 on desktop web, while `pnpm send` opened the profile. Two code
 * paths, one of them dead, and the symptom looked like a login problem.
 *
 * The `ig.me` assertion below is the load-bearing one. It is not testing string
 * formatting — it is pinning down a URL shape that was verified against the live
 * host, so that "let's deep-link the thread, it's fewer clicks" cannot quietly
 * come back. Deep-linking the thread is also ruled out on safety grounds
 * (CLAUDE.md decision 1): profile → Message → type is the path a person takes.
 */
describe('instagram urls', () => {
  it('opens the profile, never an ig.me deep link', () => {
    const url = profileUrl('madovermarketing_mom')
    expect(url).toBe('https://www.instagram.com/madovermarketing_mom/')
    expect(url).not.toContain('ig.me')
    expect(url).not.toContain('/direct/t/')
  })

  it('handles the full legal handle character set', () => {
    expect(profileUrl('viral.bhayani_1')).toBe('https://www.instagram.com/viral.bhayani_1/')
  })

  it('sends replies to the inbox, where the reply can actually be read', () => {
    expect(dmInboxUrl()).toBe('https://www.instagram.com/direct/inbox/')
  })

  describe('handle validation', () => {
    // A handle reaches `open <url>` via execFile. No shell is involved, so this is
    // defence in depth rather than the only barrier — but a malformed handle means
    // the database is wrong, and that should fail loudly rather than open a URL.
    for (const bad of [
      '',
      'has space',
      'has/slash',
      'has?query',
      'javascript:alert(1)',
      '../../etc/passwd',
      'a'.repeat(31),
      'semi;colon',
      'amp&ersand',
    ]) {
      it(`refuses ${JSON.stringify(bad)}`, () => {
        expect(() => assertSafeHandle(bad)).toThrow(/malformed handle/)
        expect(() => profileUrl(bad)).toThrow(/malformed handle/)
      })
    }

    it('accepts the three real targets and senders', () => {
      for (const h of [
        'madovermarketing_mom',
        'viralbhayani',
        'maraboutmarketing',
        'bollywoodsociety',
        'bollywoodchronicle',
      ]) {
        expect(() => assertSafeHandle(h)).not.toThrow()
      }
    })
  })
})
