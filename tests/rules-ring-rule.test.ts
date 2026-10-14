import { describe, it, expect, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

/**
 * /rules STATES THE RING RULE THE ENFORCER HOLDS — per fleet (M12), RENDERED rather than grepped.
 *
 * M12 (2026-10-09) narrowed "every page has written" in `crossSpacingVerdict` to the pages of the
 * RECIPIENT'S OWN FLEET that are able to send: a marketing page can never deliver to a bollywood
 * company, so counting it made the seven-day rest unreachable for the fleet that sends most. The
 * page's STOP_LABELS line was updated with it; the Volume prose was not, and went on saying
 * "Every one of our pages may write to a recipient. Once ALL of them have, that recipient rests…"
 * — under a heading that promises every rule on the page is the one the module enforces.
 *
 * The page is an async server component with database reads, so everything it reads is mocked
 * and the returned tree is rendered. Nav is replaced (it is an async component with its own reads,
 * and none of this test is about it).
 */

vi.mock('@/lib/session', () => ({ currentUser: async () => ({ id: 'u', email: 'op@example.com', role: 'operator' }) }))
vi.mock('@/lib/db', () => ({
  prisma: {
    setting: { findMany: async () => [], findUnique: async () => null },
    senderAccount: {
      aggregate: async () => ({ _min: { dailyCap: 5 }, _max: { dailyCap: 5 }, _sum: { dailyCap: 25 }, _count: 5 }),
    },
  },
}))
vi.mock('@/outreach/cohorts', () => ({ cohortSize: async () => 5, cohortSoakDays: async () => 14 }))
vi.mock('@/outreach/brandTouchCounts', () => ({ readNewBrandTouchCounts: async () => ({ waiting: 0, delivered: 0 }) }))
vi.mock('../src/app/nav', () => ({ Nav: () => null }))

const { default: RulesPage } = await import('../src/app/rules/page')

const rendered = async () =>
  renderToStaticMarkup(await RulesPage())
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;|&#39;/g, '’')
    .replace(/\s+/g, ' ')

describe('/rules states the ring rule per fleet, as crossSpacingVerdict enforces it', () => {
  it('no longer says the rest needs ALL of our pages', async () => {
    const t = await rendered()
    expect(t, 'the guard must be reading the Volume group at all').toContain('messages per day from one account to one recipient')
    expect(t).not.toMatch(/Once ALL of them have/i)
    expect(t).not.toMatch(/Every one of our pages may write to a recipient/i)
  })

  it('says the rest comes once every page of the recipient’s own fleet able to send has written, with the window from the Setting', async () => {
    const t = await rendered()
    /* One sentence, so a phrase elsewhere on the page cannot satisfy it; the number is
       `defaultCooldownDays`, read from the Setting, never retyped. */
    expect(t).toMatch(
      /Every page of a recipient’s own fleet may write to them\. Once every one of those pages that is able to send has written, the recipient rests until the oldest of those messages is \d+ days old/,
    )
  })
})
