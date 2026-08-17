import { describe, expect, it } from 'vitest'
import { brandFirstTouch, describeRecency, publisherDisplayName, possessive } from '@/outreach/brandPitch'
import { BRAND_MESSAGE_VARIANTS } from '../prisma/brandVariants'
import { MESSAGE_VARIANTS } from '../prisma/variants'

const NOW = new Date('2026-08-03T12:00:00Z')

describe('describeRecency', () => {
  it('bands recent posts without naming a date', () => {
    // A precise date reads like surveillance rather than attention, and is embarrassing
    // when the timestamp is off by a day.
    expect(describeRecency(new Date('2026-08-02T12:00:00Z'), NOW)).toBe('this week')
    expect(describeRecency(new Date('2026-07-28T12:00:00Z'), NOW)).toBe('last week')
    expect(describeRecency(new Date('2026-07-10T12:00:00Z'), NOW)).toBe('recently')
    expect(describeRecency(new Date('2026-06-05T12:00:00Z'), NOW)).toBe('a couple of months ago')
  })

  it('says nothing about a stale placement rather than dating it', () => {
    // "that was ages ago" is an invitation to dismiss the message.
    expect(describeRecency(new Date('2025-11-01T12:00:00Z'), NOW)).toBeNull()
  })

  it('says nothing when there is no date at all', () => {
    expect(describeRecency(null, NOW)).toBeNull()
  })

  it('says nothing for a FUTURE timestamp rather than something false', () => {
    // Bad data must not become a confident claim.
    expect(describeRecency(new Date('2026-09-01T12:00:00Z'), NOW)).toBeNull()
  })
})

describe('brandFirstTouch', () => {
  const full = {
    brandName: 'Royal Canin',
    // The handle travels with the name so the guard can compare them. See `usableName.ts`.
    handle: 'royalcanin.india',
    publisherName: 'Mad Over Marketing',
    postedAt: new Date('2026-07-28T12:00:00Z'),
    now: NOW,
  }

  it('names the real brand, the real publisher and when', () => {
    const body = brandFirstTouch(full)
    expect(body).toContain('Royal Canin')
    expect(body).toContain('Mad Over Marketing')
    expect(body).toContain('last week')
  })

  it('is genuinely different per recipient — the whole point of decision 3', () => {
    const a = brandFirstTouch(full)
    const b = brandFirstTouch({ ...full, brandName: 'Amazon', handle: 'amazondotin', publisherName: 'Viral Bhayani' })
    expect(a).not.toBe(b)
    // Not merely a substituted token: the observable claim differs.
    expect(a).not.toContain('Amazon')
    expect(b).not.toContain('Royal Canin')
  })

  it('NEVER invents a placement when the publisher is unknown', () => {
    /**
     * The load-bearing negative. An invented hook is worse than none — the recipient can
     * tell, and a false claim about their own marketing is the fastest route to a report.
     */
    const body = brandFirstTouch({ ...full, publisherName: null })
    expect(body).not.toContain('placement with')
    expect(body).not.toContain('I saw')
    expect(body).not.toContain('nicely done')
    // Still a usable message, and still names the recipient.
    expect(body).toContain('Royal Canin')
    expect(body.length).toBeGreaterThan(200)
  })

  it('omits the timing clause but keeps the claim when the date is missing', () => {
    const body = brandFirstTouch({ ...full, postedAt: null })
    expect(body).toContain('Mad Over Marketing')
    expect(body).not.toContain('undefined')
    expect(body).not.toContain('null')
  })

  it('contains no handles — a raw @handle reads like scraped output', () => {
    expect(brandFirstTouch(full)).not.toContain('@')
  })

  it('never leaves an unsubstituted placeholder', () => {
    for (const publisherName of ['Mad Over Marketing', null]) {
      for (const postedAt of [full.postedAt, null]) {
        const body = brandFirstTouch({ ...full, publisherName, postedAt })
        expect(body).not.toMatch(/\{\{|\}\}/)
        expect(body).not.toMatch(/\bundefined\b|\bnull\b|NaN/)
      }
    }
  })

  it('has no triple newlines, so it renders as clean paragraphs', () => {
    // The no-publisher path inserts an empty bridge; without care that leaves a gap.
    for (const publisherName of ['Mad Over Marketing', null]) {
      expect(brandFirstTouch({ ...full, publisherName })).not.toMatch(/\n{3,}/)
    }
  })
})

describe('publisherDisplayName', () => {
  it('maps known publisher handles to their real names', () => {
    expect(publisherDisplayName('madovermarketing_mom')).toBe('Mad Over Marketing')
    expect(publisherDisplayName('@viralbhayani')).toBe('Viral Bhayani')
    expect(publisherDisplayName('MADOVERMARKETING_MOM')).toBe('Mad Over Marketing')
  })

  it('returns null for an unknown handle rather than mangling it', () => {
    // Deriving a name would produce "Madovermarketing Mom" in a live message.
    expect(publisherDisplayName('some_new_channel')).toBeNull()
    expect(publisherDisplayName(null)).toBeNull()
    expect(publisherDisplayName(undefined)).toBeNull()
    expect(publisherDisplayName('')).toBeNull()
  })
})

describe('the brand pool is a DIFFERENT proposition, not reworded channel copy', () => {
  it('shares no body with the channel pool', () => {
    const channel = new Set(MESSAGE_VARIANTS.map((v) => v.body))
    for (const v of BRAND_MESSAGE_VARIANTS) expect(channel.has(v.body)).toBe(false)
  })

  it('pitches buying, not partnership', () => {
    // A brand is a buyer that has proved it has budget, not a fellow publisher. Every
    // body must make the media-buying ask rather than the peer partnership one.
    for (const v of BRAND_MESSAGE_VARIANTS) {
      expect(v.body.toLowerCase()).toMatch(/rate|buying|pricing|numbers|plan/)
    }
  })

  it('never offers a "strategic partnership" — that is the channel pitch', () => {
    for (const v of BRAND_MESSAGE_VARIANTS) {
      expect(v.body.toLowerCase()).not.toContain('strategic partnership')
    }
  })

  it('has unique labels and non-trivial bodies', () => {
    const labels = BRAND_MESSAGE_VARIANTS.map((v) => v.label)
    expect(new Set(labels).size).toBe(labels.length)
    for (const v of BRAND_MESSAGE_VARIANTS) expect(v.body.length).toBeGreaterThan(200)
  })

  it('leaves no unsubstituted placeholder other than the documented ones', () => {
    for (const v of BRAND_MESSAGE_VARIANTS) {
      const tokens = v.body.match(/\{\{\s*(\w+)\s*\}\}/g) ?? []
      for (const t of tokens) expect(t).toMatch(/\{\{\s*(brand|channel)\s*\}\}/)
    }
  })
})

/**
 * ── THE POSSESSIVE, FOUND BY READING A REAL DRAFT (2026-08-17) ────────────────────────
 *
 * A live waiting draft opened *"I saw Asshna Developers's placement with Viral Bhayani last
 * week"* — the first sentence a prospect reads. Names ending in `s` are the normal case among
 * the live BRAND rows, not an edge one: Asshna Developers, Amazon MGM Studios, Sach
 * Developers, Excel Music Records.
 */
describe('possessive', () => {
  it("adds 's to an ordinary name", () => {
    expect(possessive('Crocs India')).toBe("Crocs India's")
    expect(possessive('Philips India')).toBe("Philips India's")
  })

  it("adds only an apostrophe to a name already ending in s", () => {
    expect(possessive('Asshna Developers')).toBe("Asshna Developers'")
    expect(possessive('Amazon MGM Studios')).toBe("Amazon MGM Studios'")
    expect(possessive('Excel Music Records')).toBe("Excel Music Records'")
  })

  it('never produces the double possessive that was shipping', () => {
    for (const n of ['Asshna Developers', 'Amazon MGM Studios', 'Sach Developers', 'Crocs India']) {
      expect(possessive(n)).not.toContain("s's")
    }
  })

  it('is case-insensitive about the final s, and trims', () => {
    expect(possessive('ACME RECORDS')).toBe("ACME RECORDS'")
    expect(possessive('  Crocs India  ')).toBe("Crocs India's")
  })

  /** The real sentence, end to end, so the fix is asserted where it is actually read. */
  it('reads correctly in the real opening line', () => {
    const body = brandFirstTouch({
      handle: 'asshnadevelopers',
      brandName: 'Asshna Developers',
      publisherName: 'Viral Bhayani',
      postedAt: new Date('2026-08-10'),
      now: new Date('2026-08-17'),
    })
    expect(body).toContain("I saw Asshna Developers' placement with Viral Bhayani")
    expect(body).not.toContain("Developers's")
  })
})
