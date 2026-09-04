import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import {
  FOLLOW_UP_DEFAULT_KEY,
  FOLLOW_UP_POST_TOKEN,
  MIN_SUBJECT_LENGTH,
  RETIRED_DATE_ONLY_MARK,
  SHORTEST_POST_REFERENCE,
  citesOnlyADate,
  followUpForRoute,
  followUpForSettings,
  followUpPostReference,
  followUpSubject,
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
   * The subject and the date are what is left: the subject is what the post was ABOUT and
   * the date identifies which post, varying per post — which is what keeps two follow-ups
   * from being byte-identical. The real defence is that `followUpPostReference` no longer
   * TAKES a handle, so the second assertion here is about a shape rather than a value.
   */
  it('names the subject and the day and NOTHING about the publisher, in IST', () => {
    /* 30 Aug 22:00 UTC is 31 Aug in IST — the reason this goes through the one formatter. */
    const ref = followUpPostReference({ postedAt: new Date('2026-08-30T22:00:00.000Z'), subject: 'Toxic' })
    expect(ref).toBe('your Toxic placement on 31 Aug')
    expect(ref, 'a watched publisher reached a real recipient once; never again').not.toMatch(/@/)
  })

  /**
   * ── THE DATE-ONLY FALLBACK IS DELETED (2026-09-01, Tabish) ────────────────
   *
   * *"This message is mentioning nothing but date and placement. This is an amateur message
   * with no context to the paid posts."* — said of a DELIVERED "Hi,We saw your placement on
   * 31 Aug…". The builder now REQUIRES a subject (a type, not a rule), and `citesOnlyADate`
   * is how the gate recognises a draft written before that — over the retired fallback's
   * exact bytes, which the current builder is structurally unable to emit.
   */
  it('the retired date-only reference is recognised, and the current builder cannot produce it', () => {
    expect(citesOnlyADate('Hi,We saw your placement on 31 Aug — we can put that same campaign…')).toBe(true)
    expect(citesOnlyADate(RETIRED_DATE_ONLY_MARK)).toBe(true)
    /* Every reference the builder can emit carries a subject between "your " and " placement". */
    expect(citesOnlyADate(followUpPostReference({ postedAt: new Date('2026-08-31T05:00:00Z'), subject: 'Toxic' }))).toBe(false)
    expect(citesOnlyADate(followUpPostReference({ postedAt: new Date('2026-01-01T12:00:00Z'), subject: 'Ace' }))).toBe(false)
    expect(citesOnlyADate('Hi,We saw your Love Lottery placement on 31 Aug — …')).toBe(false)
  })

  it('the validation worst case uses the shortest subject the filter admits', () => {
    /* MIN_SUBJECT_LENGTH is the filter's floor; the worst case must not be looser or stricter. */
    expect(SHORTEST_POST_REFERENCE).toBe(
      followUpPostReference({ postedAt: new Date(Date.UTC(2026, 0, 1, 12, 0, 0)), subject: 'x'.repeat(MIN_SUBJECT_LENGTH) })
        .replace('xxx', 'Ace'),
    )
  })

  /**
   * ── WHAT THE POST WAS ABOUT (2026-09-01, Tabish) ─────────────────────────
   *
   * *"refer what the post was about … if the paid post references a movie mention that
   * movie etc."* Every fixture below is a REAL `brands` array from the live corpus, because
   * the filters exist for things the measurement actually found — `"fyp"` really came back
   * as a post's only subject, and `"@primevideoIN"` really sits in a brands list.
   */
  const PUBLISHER = { handle: 'filmygyan', displayName: 'F I L M Y G Y A N' }
  /**
   * The pages we WATCH — every one a competitor, and a round-up by one can name another.
   * Real rows: @officialsocialsamosa really is a watched channel and its display name really
   * is its own handle, which is why "Social Samosa" needed the reverse containment.
   */
  const WATCH = [
    PUBLISHER,
    { handle: 'officialsocialsamosa', displayName: 'officialsocialsamosa' },
    { handle: 'madovermarketing_mom', displayName: 'Mad Over Marketing (M.O.M)' },
    { handle: 'viralbhayani', displayName: 'Viral Bhayani' },
  ]
  const RECIPIENT = { handle: 'primevideoin', displayName: 'Prime Video IN', isPerson: false }
  /** A person on a paid campaign post — the film IS what they were in. */
  const TALENT = { handle: 'tarasutaria', displayName: 'Tara Sutaria', isPerson: true }

  it('names the one subject for TALENT — the film is what they were in', () => {
    expect(followUpSubject(['Toxic'], PUBLISHER, TALENT, WATCH)).toBe('Toxic')
    expect(followUpSubject(['Toxic: A Fairy Tale for Grown-Ups'], PUBLISHER, TALENT, WATCH)).toBe(
      'Toxic: A Fairy Tale for Grown-Ups',
    )
  })

  it('names a company’s own product line', () => {
    const titan = { handle: 'titanwatchesindia', displayName: 'Titan', isPerson: false }
    expect(followUpSubject(['Titan Raga'], PUBLISHER, titan, WATCH)).toBe('Titan Raga')
  })

  /**
   * ── THE ONE CAUGHT BY RENDERING IT, NOT BY READING IT ────────────────────
   *
   * A live post naming @jiohotstar carried exactly one surviving subject, "Amazon Prime", so
   * every other filter passed and the sentence read *"We saw your Amazon Prime placement"*
   * to a rival streaming platform. One SUBJECT is not one ADVERTISER.
   */
  it('never tells a company about somebody else’s campaign', () => {
    const jio = { handle: 'jiohotstar', displayName: 'JioHotstar', isPerson: false }
    expect(followUpSubject(['Amazon Prime'], PUBLISHER, jio, WATCH)).toBeNull()
    expect(followUpSubject(['TECNO'], PUBLISHER, RECIPIENT, WATCH)).toBeNull()
    expect(followUpSubject(['Green Soul'], PUBLISHER, RECIPIENT, WATCH)).toBeNull()
  })

  /**
   * ── CAUGHT BY RENDERING AGAINST LIVE PAIRS, SECOND PASS (2026-09-01) ───────
   *
   * The real #Daayra trailer names TWO studios — ["Junglee Pictures","Pen Studios"] — and
   * the first version DROPPED the recipient's own name before the exactly-one test, so the
   * co-producer's name survived alone and "your Pen Studios placement" was about to be said
   * to @jungleepictures. `campaignTalent` is true on 555 live prospects (the badge door sets
   * it on admission), so the flag alone could not stop it — the @tips vacuous-test lesson.
   * The recipient's own name in the brands list now means CO-ADVERTISER, which blocks the
   * talent arm outright.
   */
  it('a co-advertiser on their own joint post is never given the other company’s name', () => {
    /* isPerson TRUE deliberately: the PARTITION is what must block this, not the person gate. */
    const junglee = { handle: 'jungleepictures', displayName: 'Junglee Pictures', isPerson: true }
    expect(
      followUpSubject(['Junglee Pictures', 'Pen Studios', '@kareenakapoorkhan'], PUBLISHER, junglee, WATCH),
    ).toBeNull()
  })

  /** The other live catch: a box-office hashtag ("Onam") beside their own film's name. */
  it('a hashtag beside their own exact name is not their subject either', () => {
    const toxic = { handle: 'toxic_themovie', displayName: 'TOXIC', isPerson: true }
    expect(followUpSubject(['Toxic', 'Onam'], PUBLISHER, toxic, WATCH)).toBeNull()
  })

  /** A stem-match is theirs by construction, so it survives other names on the post. */
  it('their own product line is nameable even beside another advertiser', () => {
    const titan = { handle: 'titanwatchesindia', displayName: 'Titan', isPerson: false }
    expect(followUpSubject(['Titan Raga', 'Tanishq'], PUBLISHER, titan, WATCH)).toBe('Titan Raga')
    /* Two of their own lines is ambiguous — refusal, never a guess. */
    expect(followUpSubject(['Titan Raga', 'Titan Eye+'], PUBLISHER, titan, WATCH)).toBeNull()
  })

  /**
   * ── THE 2 SEPTEMBER DEFECT, ON THE POST THAT CAUSED IT ────────────────────
   *
   * `DcyE65LPYMj`, published by @officialsocialsamosa — a WATCHED channel, i.e. a competitor.
   * Its real `brands` array is below verbatim. Fourteen follow-ups went to five companies
   * saying *"your Social Samosa placement"*, *"your Festive Marketing Camp placement"* and
   * *"your Realize placement"* — the publisher's own name, its own event, and that event's
   * sponsor, each presented to a gifting partner as THEIR placement.
   *
   * Three independent causes, and each of the three cases below fails if its fix is reverted:
   *   1. the all-lowercase filter ran BEFORE the partition and deleted the four bare handles,
   *      so a five-advertiser round-up read as a one-subject post;
   *   2. only the PUBLISHER's marks were stripped, and only in the containing direction, so
   *      "Social Samosa" survived a post by @officialsocialsamosa;
   *   3. `campaignTalent` was the talent gate, and it is TRUE on 189 live COMPANIES.
   */
  const SS_PUBLISHER = { handle: 'officialsocialsamosa', displayName: 'officialsocialsamosa' }
  const SS_BRANDS = ['@socialsamosaevents', 'Realize', 'itsbevygood', 'plumbodylovin', 'supersox_india', 'farmleyin']

  it('never gives a gifting partner the event sponsor’s name (DcyE65LPYMj, delivered 14×)', () => {
    const farmley = { handle: 'farmleyin', displayName: 'Farmley', isPerson: false }
    expect(followUpSubject(SS_BRANDS, SS_PUBLISHER, farmley, WATCH)).toBeNull()
  })

  it('counts a lowercase co-advertiser it can never speak', () => {
    /* isPerson TRUE isolates cause 1: the post names @farmleyin as an advertiser through a
       BARE HANDLE, and that entry must reach the partition even though it is unspeakable —
       a co-advertiser's presence is what makes another advertiser's name not their subject. */
    const farmley = { handle: 'farmleyin', displayName: 'Farmley', isPerson: true }
    expect(followUpSubject(SS_BRANDS, SS_PUBLISHER, farmley, WATCH)).toBeNull()
  })

  it('a lowercase token is never SPOKEN, even when it is the only thing left', () => {
    const someone = { handle: 'someone', displayName: 'Someone', isPerson: true }
    expect(followUpSubject(['supersox_india'], PUBLISHER, someone, WATCH)).toBeNull()
    expect(followUpSubject(['fyp'], PUBLISHER, someone, WATCH)).toBeNull()
  })

  it('never speaks a watched channel’s own name, whichever of them published the post', () => {
    const titan = { handle: 'titanwatchesindia', displayName: 'Titan', isPerson: false }
    const mom = { handle: 'madovermarketing_mom', displayName: 'Mad Over Marketing (M.O.M)' }
    /* "Social Samosa" is @officialsocialsamosa's own name and the handle CONTAINS it, so the
       containment runs the reverse way to the affix rule `isOwnMark` already had. Stripping it
       must not cost the recipient their own product line, which is why this asserts a NAME and
       not merely a refusal. */
    expect(followUpSubject(['Social Samosa', 'Titan Raga'], mom, titan, WATCH)).toBe('Titan Raga')
    const person = { handle: 'someactor', displayName: 'Some Actor', isPerson: true }
    expect(followUpSubject(['Social Samosa'], mom, person, WATCH)).toBeNull()
    expect(followUpSubject(['Mad Over Marketing'], SS_PUBLISHER, person, WATCH)).toBeNull()
  })

  it('a company carrying campaignTalent is not talent — 189 live rows do', () => {
    /* @hkvitals is one of the five that received a wrong subject: campaignTalent true,
       BrandLookup UNRESOLVED. "Not known" never admits. */
    const hk = { handle: 'hkvitals', displayName: 'HK Vitals', isPerson: false }
    expect(followUpSubject(['Toxic'], PUBLISHER, hk, WATCH)).toBeNull()
  })

  it('renders it into the reference', () => {
    expect(followUpPostReference({ postedAt: new Date('2026-08-29T05:00:00Z'), subject: 'Toxic' })).toBe(
      'your Toxic placement on 29 Aug',
    )
  })

  /**
   * THE DIRECTION THAT MATTERS MOST. The publisher is a FILTER input and must never be an
   * output — this drives its own name and its own series code through `brands` and asserts
   * neither survives. One competitor-naming message reached a real prospect on 1 September;
   * this is the assertion that says never again.
   */
  it('the publisher cannot survive as a subject, by name or by series code', () => {
    expect(followUpSubject(['Filmygyan'], PUBLISHER, TALENT, WATCH)).toBeNull()
    expect(followUpSubject(['fg6'], PUBLISHER, TALENT, WATCH)).toBeNull()
    expect(followUpSubject(['FG17'], PUBLISHER, TALENT, WATCH)).toBeNull()
    /* And with a real subject beside it, the real subject survives and the mark does not. */
    expect(followUpSubject(['fg6', 'Toxic'], PUBLISHER, TALENT, WATCH)).toBe('Toxic')
  })

  it('never lets a raw handle through — brands really contains them', () => {
    expect(followUpSubject(['@primevideoIN'], PUBLISHER, RECIPIENT, WATCH)).toBeNull()
    expect(followUpSubject(['Prime Video', '@primevideoIN'], PUBLISHER, RECIPIENT, WATCH)).toBe('Prime Video')
    /* Kept because 'Prime Video' stems into 'Prime Video IN' — it is their own name for a
       product line, not a third party's. */
  })

  it('drops a hashtag artefact rather than putting it in a DM', () => {
    /* MEASURED: "fyp" came back as a whole post's only subject. */
    expect(followUpSubject(['fyp'], PUBLISHER, TALENT, WATCH)).toBeNull()
    expect(followUpSubject(['ad'], PUBLISHER, TALENT, WATCH)).toBeNull()
  })

  it('does not read the recipient their own name', () => {
    expect(followUpSubject(['Prime Video IN'], PUBLISHER, RECIPIENT, WATCH)).toBeNull()
    expect(followUpSubject(['primevideoin'], PUBLISHER, RECIPIENT, WATCH)).toBeNull()
  })

  /**
   * SEVERAL SUBJECTS MEANS NONE. MEASURED: 385 of 681 in-window paid posts carry more than
   * one, and `["Google India","Kerala Tourism"]` is two unrelated advertisers on one
   * round-up — a first-wins rule would tell Kerala Tourism about Google India, naming a
   * third party in a pitch. The date alone is the honest answer.
   */
  it('refuses to guess which of several subjects a post was about', () => {
    expect(followUpSubject(['Google India', 'Kerala Tourism'], PUBLISHER, TALENT, WATCH)).toBeNull()
    expect(followUpSubject(['Pralay', 'Ranveer Singh', 'Birla Studios'], PUBLISHER, TALENT, WATCH)).toBeNull()
  })

  it('an empty brands list is the date alone, not a crash', () => {
    expect(followUpSubject([], PUBLISHER, TALENT, WATCH)).toBeNull()
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

    /**
     * And the RENDERER cannot take one. `pickHook` does fetch the publisher — it is what
     * `followUpSubject` strips with — so the structural guarantee is one layer in: the
     * function that produces the sentence accepts a date and an already-vetted subject, and
     * nothing else.
     */
    const src = code(read('src/outreach/followUpTemplate.ts'))
    const at2 = src.indexOf('export function followUpPostReference')
    expect(at2).toBeGreaterThan(-1)
    expect(
      src.slice(at2, src.indexOf(')', at2)),
      'the reference builder accepts publisher identity again',
    ).not.toMatch(/handle|publisher|channel/i)
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

/**
 * `BrandLookup` rows whose kind is PERSON, for the talent arm. Default: @dorothy IS a person —
 * the delivered live example this fixture is built from (@akshay0beroi × "Love Lottery").
 * A test that wants a COMPANY sets this to `[]`, which is the 2026-09-04 defect's shape.
 */
let personRows: () => { handle: string }[] = () => [{ handle: 'dorothy' }]
const personFindMany = vi.fn(async (..._a: unknown[]) => personRows())

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
    /* The WATCH rows `followUpSubject` strips, and the PERSON verdicts its talent arm reads
       (2026-09-04). @dorothy is a real person on a campaign post, so the lookup says PERSON —
       which is the fact that used to be `campaignTalent` and was true of 189 companies. */
    targetAccount: {
      findMany: () =>
        Promise.resolve([
          { handle: 'instantbollywood', displayName: 'Instant Bollywood' },
          { handle: 'filmygyan', displayName: 'F I L M Y G Y A N' },
        ]),
    },
    brandLookup: { findMany: (...a: unknown[]) => personFindMany(...a) },
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
    /* TALENT, like the live delivered example (@akshay0beroi × "Love Lottery"): a person on
       a paid campaign post is there because of the thing promoted, which is what makes the
       subject speakable to them. The refusal direction drives campaignTalent: false. */
    campaignTalent: true,
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
      /* Exactly one subject, so the follow-up can say what the post was ABOUT — required
         since 2026-09-01; a post with no subject is not citable at all. */
      brands: '["Love Lottery"]',
      /* The PUBLISHER — followUpSubject's filter input, never an output. */
      target: { handle: 'instantbollywood', displayName: 'Instant Bollywood' },
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
    expect(r.body).toContain('your Love Lottery placement on 29 Aug')
    expect(r.body, 'the date-only reference is retired — a follow-up says what the post was about').not.toContain(
      'your placement on ',
    )
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

  /**
   * ── THE DATE-ONLY REFUSAL, DRIVEN (2026-09-01, Tabish) ──────────────────
   *
   * An unclaimed post EXISTS and its subject cannot be attributed to this recipient — a
   * multi-advertiser round-up here, `brands` naming two unrelated companies. The old code
   * rendered "your placement on 29 Aug" for exactly this input and one such message was
   * DELIVERED; it must now refuse instead. Deleting the `describableCampaignCount` check
   * or resurrecting the date-only fallback fails this case.
   */
  it('refuses rather than citing only a date when no post can be described to them', async () => {
    campaignFindMany.mockReturnValue([
      {
        id: 'camp_2',
        postedAt: new Date('2026-08-29T05:19:00.000Z'),
        targetId: 'chan_1',
        caption: 'a round-up naming @dorothy among others',
        taggedAccounts: '[]',
        /* Two unrelated advertisers — the measured 57% case. Not describable to anyone. */
        brands: '["Google India","Kerala Tourism"]',
        target: { handle: 'instantbollywood', displayName: 'Instant Bollywood' },
      },
    ])
    await expect(
      composeForPair({
        pair: { ...PAIR, target: { ...PAIR.target, campaignTalent: false } },
        senderHandle: 'bollywoodsocietyy',
        touchNumber: 2,
        fleetTemplate: FLEET_TEMPLATE,
        followUpTemplate: WRITTEN,
        now: NOW,
      }),
    ).rejects.toBeInstanceOf(NoMaterialForFollowUpError)
  })
})
