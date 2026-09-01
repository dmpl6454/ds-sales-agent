import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import {
  FOLLOW_UP_DEFAULT_KEY,
  FOLLOW_UP_POST_TOKEN,
  SHORTEST_POST_REFERENCE,
  followUpForRoute,
  followUpForSettings,
  followUpPostReference,
  followUpTemplateKey,
  renderFollowUp,
} from '@/outreach/followUpTemplate'
import { checkFollowUpBody, checkTemplateBody } from '@/outreach/templateGuard'
import { distinctiveSlice } from '@/outreach/matching'
import { DEFAULT_CATEGORY_SLUG, MARKETING_CATEGORY_SLUG } from '@/outreach/senderCategories'

/**
 * ── THE SECOND MESSAGE (2026-09-01, Tabish) ───────────────────────────────────
 *
 * Every message this fleet sends is one standard template, so a SECOND message from one
 * page to one recipient is a verbatim repeat — which Instagram accepts and never delivers
 * (measured 2026-08-26: touch 1 fails 5%, touch 2 fails 83%, and six of six parked threads
 * read back showed the second message simply absent). `IDENTICAL_TO_A_SENT_MESSAGE` stopped
 * the waste and could only lift when something said something different: MEASURED
 * 2026-09-01, the planner's dominant skip was `identical-to-a-message-they-already-have`
 * at 1,808, about half of every skip in the fleet.
 *
 * This is that something different, and the two properties that matter most are both about
 * ABSENCE: an unwritten follow-up refuses instead of falling back, and a follow-up with no
 * `{{post}}` is refused at the textarea because it would rebuild the wall one storey up.
 */

const ROOT_DIR = resolve(__dirname, '..')
const read = (p: string) => readFileSync(join(ROOT_DIR, p), 'utf8')
/** Comments stripped: a rule quoted in a docblock is not a rule being applied. */
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

/** Copy shaped the way Tabish's spec asks: continuous, one token, "let's talk tomorrow". */
const GOOD = `Hi,Following up on ${FOLLOW_UP_POST_TOKEN} — we can put that same campaign in front of 300M+ daily views across our network. Let's talk tomorrow. +916000189766 - Kapil`

describe('an unwritten follow-up REFUSES — for every fleet, including the default', () => {
  /**
   * THE ASYMMETRY WITH `fleetTemplate`, asserted rather than described. That module has a
   * SHIPPED default-fleet body, so its default fleet can never be "not set". There is no
   * shipped follow-up copy and there must not be one: what a second message says to a
   * company already pitched once is Tabish's to write.
   */
  it('the DEFAULT fleet has no shipped copy to fall back on', () => {
    const t = followUpForSettings({ followUpBody: null, followUpBodies: new Map() }, [], [])
    expect(t.ok, 'a follow-up went out with copy nobody wrote').toBe(false)
    if (!t.ok) {
      expect(t.reason).toBe('not-set')
      expect(t.slug).toBe(DEFAULT_CATEGORY_SLUG)
    }
  })

  it('a whitespace-only body is not a written follow-up', () => {
    const t = followUpForSettings({ followUpBody: '   \n  ', followUpBodies: new Map() }, [], [])
    expect(t.ok).toBe(false)
  })

  it('a SECOND fleet refuses on its own copy, never on the default fleet’s', () => {
    const settings = { followUpBody: GOOD, followUpBodies: new Map<string, string>() }
    const marketing = followUpForSettings(settings, [MARKETING_CATEGORY_SLUG], [MARKETING_CATEGORY_SLUG])
    expect(marketing.ok, 'the marketing fleet borrowed the bollywood follow-up').toBe(false)
    if (!marketing.ok) expect(marketing.slug).toBe(MARKETING_CATEGORY_SLUG)

    /* And the default fleet is unaffected by the second fleet's emptiness. */
    expect(followUpForSettings(settings, [], []).ok).toBe(true)
  })

  /** Not vacuous: written copy resolves, per fleet, to that fleet's own bytes. */
  it('written copy resolves to exactly that fleet’s bytes', () => {
    const settings = {
      followUpBody: GOOD,
      followUpBodies: new Map([[MARKETING_CATEGORY_SLUG, `Hi,About ${FOLLOW_UP_POST_TOKEN} — the marketing fleet's own second message, long enough to quote.`]]),
    }
    const bollywood = followUpForSettings(settings, [], [])
    const marketing = followUpForSettings(settings, [MARKETING_CATEGORY_SLUG], [MARKETING_CATEGORY_SLUG])
    expect(bollywood.ok && bollywood.body).toBe(GOOD)
    expect(marketing.ok && marketing.body).toContain("marketing fleet's own second message")
  })

  /** The two refusals that are NOT "nobody wrote it" — the same pair `fleetTemplate` names. */
  it('a cross-fleet route and an ambiguous sender are told apart from an unwritten one', () => {
    const bodies = new Map<string, string>([[DEFAULT_CATEGORY_SLUG, GOOD], [MARKETING_CATEGORY_SLUG, GOOD]])
    const cross = followUpForRoute({ senderCategories: [MARKETING_CATEGORY_SLUG], targetCategories: [], bodies })
    expect(cross.ok).toBe(false)
    if (!cross.ok) expect(cross.reason).toBe('different-fleet')

    const ambiguous = followUpForRoute({
      senderCategories: [DEFAULT_CATEGORY_SLUG, MARKETING_CATEGORY_SLUG],
      targetCategories: [DEFAULT_CATEGORY_SLUG, MARKETING_CATEGORY_SLUG],
      bodies,
    })
    expect(ambiguous.ok).toBe(false)
    if (!ambiguous.ok) expect(ambiguous.reason).toBe('ambiguous')
  })

  /**
   * The key shapes. `followUpBody` and `followUpBody:<slug>` must never collide, or the
   * default fleet's row would be swept into the per-slug map and read as a fleet called ''.
   */
  it('the default key is not a prefix match for a per-fleet key', () => {
    expect(followUpTemplateKey(MARKETING_CATEGORY_SLUG)).toBe(`${FOLLOW_UP_DEFAULT_KEY}:marketing`)
    expect(FOLLOW_UP_DEFAULT_KEY.startsWith(followUpTemplateKey(''))).toBe(false)
  })
})

describe('what the follow-up says about the post it is for', () => {
  /**
   * ── AND IT NEVER NAMES THE PUBLISHER (2026-09-01, Tabish) ────────────────
   *
   * The first version read "your placement with @instantbollywood on 31 Aug", and one such
   * message reached a real prospect before it was caught: **every channel we watch is a
   * COMPETITOR**, so that sentence advertises one by name inside a pitch for our own
   * inventory, and tells the recipient where we watch. Tabish: *"Never mention our
   * competitors in this way never mention their names."*
   *
   * The date alone is what is left, and it is enough: it identifies the post, it varies per
   * post — which is what keeps two follow-ups from being byte-identical — and it reveals
   * nothing. The real defence is that `followUpPostReference` no longer TAKES a handle, so
   * the second assertion here is about a shape rather than a value.
   */
  it('names the day and NOTHING about the publisher, in IST', () => {
    /* 30 Aug 22:00 UTC is 31 Aug in IST — the reason this goes through the one formatter. */
    const ref = followUpPostReference({ postedAt: new Date('2026-08-30T22:00:00.000Z') })
    expect(ref).toBe('your placement on 31 Aug')
    expect(ref, 'a watched publisher reached a real recipient once; never again').not.toMatch(/@/)
  })

  /**
   * A SOURCE GREP, because the failure mode is a call site nobody has written yet and no
   * behavioural test can fail for that. Nothing on the path from a claimed post to a
   * rendered body may carry the publishing channel.
   */
  it('no publisher identity travels with a claimed post', () => {
    const linkage = code(read('src/outreach/materialAllowance.ts'))
    const at = linkage.indexOf('export interface NamingCampaign')
    expect(at).toBeGreaterThan(-1)
    expect(
      linkage.slice(at, linkage.indexOf('}', at)),
      'NamingCampaign carries the publishing channel again — that is how the competitor got named',
    ).not.toMatch(/channelId|targetId|channelHandle/)

    const composer = code(read('src/outreach/compose.ts'))
    const pick = composer.indexOf('async function pickHook')
    expect(
      composer.slice(pick, pick + 600),
      'pickHook joins the publishing channel again — the follow-up must name the date alone',
    ).not.toMatch(/include:\s*\{\s*target/)
  })

  it('substitutes every occurrence and touches nothing else', () => {
    expect(renderFollowUp(`a ${FOLLOW_UP_POST_TOKEN} b ${FOLLOW_UP_POST_TOKEN}`, 'X')).toBe('a X b X')
  })

  /**
   * `$&` and `$'` are replacement patterns to `String.replace`, and this string is built
   * from a handle. `split`/`join` has no such vocabulary — driven rather than trusted.
   */
  it('a reference containing $ is inserted literally', () => {
    expect(renderFollowUp(`x ${FOLLOW_UP_POST_TOKEN} y`, "$& and $'")).toBe("x $& and $' y")
  })
})

describe('checkFollowUpBody — the floor that keeps a textarea from stopping the fleet', () => {
  it('accepts copy shaped the way the spec asks', () => {
    expect(checkFollowUpBody(GOOD)).toEqual({ ok: true })
  })

  it('refuses an empty box', () => {
    expect(checkFollowUpBody('   ').ok).toBe(false)
  })

  /**
   * THE ONE REFUSAL THAT IS NOT OBVIOUS. A follow-up with no `{{post}}` renders identical
   * bytes every time, so follow-up #2 would be held by `IDENTICAL_TO_A_SENT_MESSAGE` — the
   * wall this whole feature exists to remove, rebuilt one storey up and discovered weeks
   * later as a queue that stopped draining.
   */
  it('refuses a body that never names the post', () => {
    const r = checkFollowUpBody('Hi,Just following up on our last note about working together. Let us talk tomorrow.')
    expect(r.ok, 'a follow-up with no {{post}} is byte-identical every time').toBe(false)
    if (!r.ok) expect(r.reason).toContain(FOLLOW_UP_POST_TOKEN)
  })

  it('refuses any OTHER placeholder — nothing else is substituted', () => {
    const r = checkFollowUpBody(`Hi {{brand}},Following up on ${FOLLOW_UP_POST_TOKEN}, we would love to talk tomorrow about this.`)
    expect(r.ok, 'literal braces would reach a real person as typed').toBe(false)
  })

  /**
   * The mechanical floor, and it is validated on the RENDERED text at the WORST case: the
   * needle fails by having no 40+ character line LEFT, so the shortest substitution is the
   * conservative bound. Null from `distinctiveSlice` refuses EVERY send in the system.
   */
  it('refuses copy too short to quote once the post is named', () => {
    const short = `Hi,${FOLLOW_UP_POST_TOKEN}?`
    expect(distinctiveSlice(renderFollowUp(short, SHORTEST_POST_REFERENCE)), 'fixture assumption').toBeNull()
    const r = checkFollowUpBody(short)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('40')
  })

  /** And the standard-message guard still refuses the token — the two boxes are not the same. */
  it('the STANDARD message still refuses {{post}}', () => {
    expect(checkTemplateBody(`Hi,We work with ${FOLLOW_UP_POST_TOKEN} and would love to talk about your campaigns.`).ok).toBe(
      false,
    )
  })
})

/**
 * ── AND BOTH ENFORCERS ASK THE SAME RULE ──────────────────────────────────────
 *
 * A source grep, because the failure mode is a call site nobody has written yet and no
 * behavioural test can fail for that. `tests/stopInventory.test.ts` proves both stops are
 * reachable and explain themselves; this proves they are reachable from the real code paths
 * rather than only from a fixture.
 */
describe('the follow-up rule is enforced at both ends, from one implementation', () => {
  it.each([
    ['src/outreach/plan.ts', 'the planner refuses to WRITE one'],
    ['src/outreach/gate.ts', 'the gate refuses to SEND one'],
    ['src/outreach/onDemand.ts', 'the on-demand dialog refuses to offer one'],
  ])('%s asks followUpForSettings — %s', (file) => {
    expect(code(read(file)), `${file} resolves the follow-up copy some other way`).toMatch(/followUpForSettings\(/)
  })

  it('nothing falls back to the first-touch template for a second message', () => {
    const src = code(read('src/outreach/compose.ts'))
    const at = src.indexOf('if (touchNumber > 1)')
    expect(at, 'the follow-up branch is gone — every second message is a verbatim repeat again').toBeGreaterThan(-1)
    const branch = src.slice(at, at + 700)
    expect(branch, 'a follow-up must throw rather than borrow the standard message').toMatch(
      /FollowUpTemplateNotSetError/,
    )
    expect(branch, 'a follow-up with nothing to cite must throw rather than render an empty reference').toMatch(
      /NoMaterialForFollowUpError/,
    )
  })
})

// ───────────────────────────────────────────────────────────────────────────
// And the composer itself: what a second message actually looks like.
// ───────────────────────────────────────────────────────────────────────────

const campaignFindUnique = vi.fn()
const campaignFindMany = vi.fn()
const variantFindMany = vi.fn()
const usedCampaignRows = vi.fn<() => Array<{ campaignId: string | null }>>(() => [])
const usedVariantRows = vi.fn<() => Array<{ variantId: string }>>(() => [])

vi.mock('@/lib/db', () => ({
  prisma: {
    detectedCampaign: {
      findUnique: (...a: unknown[]) => campaignFindUnique(...a),
      findMany: (...a: unknown[]) => campaignFindMany(...a),
      findFirst: () => Promise.resolve(null),
      count: () => Promise.resolve(0),
    },
    messageVariant: { findMany: (...a: unknown[]) => variantFindMany(...a) },
    outreachAttempt: {
      findMany: (args: { select?: Record<string, boolean> }) =>
        Promise.resolve(args?.select?.variantId ? usedVariantRows() : usedCampaignRows()),
    },
    /* No Setting rows: every runtime setting takes its default, and `singleTemplate`
       defaults TRUE — this describes the shipping configuration. */
    setting: { findMany: () => Promise.resolve([]) },
  },
}))

const { composeForPair, FollowUpTemplateNotSetError, NoMaterialForFollowUpError } = await import('@/outreach/compose')
const { templateForSettings } = await import('@/outreach/fleetTemplate')

const FLEET_TEMPLATE = templateForSettings({ singleTemplateBody: null, fleetTemplateBodies: new Map() }, [], [])
const WRITTEN = followUpForSettings({ followUpBody: GOOD, followUpBodies: new Map() }, [], [])
const UNWRITTEN = followUpForSettings({ followUpBody: null, followUpBodies: new Map() }, [], [])

const NOW = new Date('2026-08-30T06:00:00.000Z')

const PAIR = {
  id: 'pair_1',
  senderId: 'send_1',
  targetId: 'targ_1',
  bespokeBody: null,
  sender: {
    personaName: 'Kapil Jain',
    personaRole: 'Co-founder',
    personaBrand: 'Bollywood Society',
    personaPhone: '+91 60000 189766',
    personaEmail: 'kapil@digitalsukoon.com',
  },
  target: {
    handle: 'dorothy',
    displayName: 'Dorothy',
    contactFirstName: null,
    kind: 'BRAND',
    discoveredFromCampaignId: null,
  },
} as Parameters<typeof composeForPair>[0]['pair']

beforeEach(() => {
  campaignFindMany.mockReset().mockReturnValue([
    {
      id: 'camp_1',
      postedAt: new Date('2026-08-29T05:19:00.000Z'),
      targetId: 'chan_1',
      caption: 'a paid placement with @dorothy',
      taggedAccounts: '[]',
      brands: '[]',
    },
  ])
  campaignFindUnique.mockReset().mockResolvedValue({
    id: 'camp_1',
    postedAt: new Date('2026-08-29T05:19:00.000Z'),
    brands: '[]',
    target: { handle: 'instantbollywood' },
  })
  variantFindMany.mockReset().mockResolvedValue([{ id: 'var_1', body: 'never used while the template is on' }])
  usedCampaignRows.mockReset().mockReturnValue([])
  usedVariantRows.mockReset().mockReturnValue([])
})

describe('composing the second message', () => {
  it('a FIRST touch is the standard template, untouched by any of this', async () => {
    const r = await composeForPair({
      pair: PAIR,
      senderHandle: 'bollywoodsocietyy',
      touchNumber: 1,
      fleetTemplate: FLEET_TEMPLATE,
      /* Unwritten, deliberately: a missing follow-up must leave first-touch sending
         byte-for-byte as it was. This is the whole "ships inert" claim, driven. */
      followUpTemplate: UNWRITTEN,
      now: NOW,
    })
    expect(r.body).toBe(FLEET_TEMPLATE.ok ? FLEET_TEMPLATE.body : '')
  })

  it('a SECOND message is the follow-up copy, naming the post it claimed', async () => {
    const r = await composeForPair({
      pair: PAIR,
      senderHandle: 'bollywoodsocietyy',
      touchNumber: 2,
      fleetTemplate: FLEET_TEMPLATE,
      followUpTemplate: WRITTEN,
      now: NOW,
    })
    expect(r.body).toContain('your placement on 29 Aug')
    /* And NOT the publisher. The mock's campaign is on @instantbollywood; one such message
       reached a real recipient on 1 September before this was caught. */
    expect(r.body, 'a watched competitor is named in a pitch to a prospect').not.toContain('instantbollywood')
    expect(r.body, 'no handle of ours or theirs belongs in a follow-up').not.toMatch(/@[a-z0-9_.]+/i)
    expect(r.body, 'the token reached a real recipient').not.toContain(FOLLOW_UP_POST_TOKEN)
    /* And it is genuinely different bytes from the first touch, which is the release. */
    expect(r.body).not.toBe(FLEET_TEMPLATE.ok ? FLEET_TEMPLATE.body : '')
    /* The claim it records and the post it names are the same post, by construction. */
    expect(r.campaignId).toBe('camp_1')
    /* The send guards can still quote it. */
    expect(distinctiveSlice(r.body)).not.toBeNull()
  })

  it('refuses rather than repeating the first message when no follow-up is written', async () => {
    await expect(
      composeForPair({
        pair: PAIR,
        senderHandle: 'bollywoodsocietyy',
        touchNumber: 2,
        fleetTemplate: FLEET_TEMPLATE,
        followUpTemplate: UNWRITTEN,
        now: NOW,
      }),
    ).rejects.toBeInstanceOf(FollowUpTemplateNotSetError)
  })

  it('refuses rather than naming nothing when every post is already claimed', async () => {
    campaignFindMany.mockReturnValue([])
    await expect(
      composeForPair({
        pair: PAIR,
        senderHandle: 'bollywoodsocietyy',
        touchNumber: 2,
        fleetTemplate: FLEET_TEMPLATE,
        followUpTemplate: WRITTEN,
        now: NOW,
      }),
    ).rejects.toBeInstanceOf(NoMaterialForFollowUpError)
  })
})
