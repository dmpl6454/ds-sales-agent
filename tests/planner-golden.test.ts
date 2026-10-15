import { describe, it, expect, vi, afterAll } from 'vitest'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  openOutreachDb,
  seedSender,
  seedTarget,
  seedPair,
  seedVariants,
  seedDelivery,
  seedReply,
  seedPark,
  seedDraft,
  seedPost,
  seedCategory,
  setSetting,
  countQueries,
  senderId,
  targetId,
  pairId,
} from './helpers/outreach-db'

/**
 * ── THE PLANNER GOLDEN: ONE SEEDED SCENARIO, THE REAL `runOutreach`, EVERY OUTCOME PINNED ──
 *
 * Stage 0 of the outreach redesign (2026-10-15). Stage 3 replaces the planner's per-pair
 * `Promise.all` of nine reads with one bulk fact loader, and Stage 2 collapses the governor and
 * the gate into one evaluator. Neither may change WHAT the planner decides for any pair — only
 * how many statements it spends deciding it. This file is the proof: a scenario rich enough to
 * reach every stop the planner can report, the real `runOutreach()` run against it on a frozen
 * clock, and every pair's outcome recorded in `tests/fixtures/planner-golden.json`.
 *
 * WHAT IT PINS, by production file:
 *
 *   src/outreach/plan.ts            `ensureFleetPairs` (which routes exist), the H5 sweep call,
 *                                   the per-pair fact reads, the GovernorInput assembly, the
 *                                   `repeatsADeliveredBody` render, rotation (`whoseTurn`), the two
 *                                   brand guards and the write (`createAndDispatch` → READY)
 *   src/outreach/governor.ts        every `SKIP_REASONS` verdict reachable from real rows, in the
 *                                   order the stops are asked
 *   src/outreach/compose.ts         `freshCampaignsFor` (the claim ledger), `composeForPair` under
 *                                   `singleTemplate`, the follow-up pick and its subject
 *   src/outreach/materialAllowance.ts  which posts NAME a recipient (tag, caption, brand string)
 *   src/outreach/followUpTemplate.ts   `followUpSubject`, `isFollowUp`, the H5 predicate
 *   src/outreach/crossSpacing.ts    the ring-complete rest, including the one-page-ring self-hold
 *   src/outreach/parkedRows.ts      which parks the governor sees and which only rotation sees
 *   src/outreach/categories.ts      `whoseTurn`, `readBlockedRoutes`, the fleet ring filter
 *   src/outreach/rotation.ts        `nextSender`, `stableIndex` (ids here are DERIVED, so the
 *                                   hash spread is stable)
 *   src/outreach/staleIntroductions.ts  the waiting introduction discarded at the top of the pass
 *   src/outreach/brandGuards.ts     the person refusal and the waiting-drafts cap
 *   src/outreach/replyHalt.ts       the pair-scoped seven-day halt, dated / expired / undated
 *
 * THIS FILE GOES RED THE MOMENT ANY PAIR'S OUTCOME CHANGES — eligibility, reason, detail
 * sentence, status, touch number, the claimed post, or THE BYTES WRITTEN. Every draft's
 * `body`, `hookLine` and `bodyKind` are in the fixture, because the composer's two largest
 * decisions — introduction or follow-up, and which fleet's copy — are invisible to a status and a
 * touch number: society→maybelline is `{READY, touch 1, c_MB2}` whether it carries the follow-up
 * (a recipient who has replied is never sent the introduction, H5) or the standard message, and
 * only the body tells them apart. Regenerate only DELIBERATELY —
 * `REGENERATE_PLANNER_GOLDEN=1 pnpm exec vitest run tests/planner-golden.test.ts` — and read
 * the fixture diff before committing it. The `queryCount` in the fixture is RECORDED and never
 * asserted: it is the baseline Stage 3 measures its loader against, and a number that must not
 * rise, not a number that must not change.
 *
 * What would fail it, concretely — EACH of these was applied to the production code by hand,
 * run against the fixture, seen red and restored before being written here. (The first version
 * of this list carried two that did not fail it: "`splitParks` passing `unreadable`" — the parks
 * query already excludes it, so the pure function never sees one — and "`freshCampaignsFor`
 * forgetting the SKIPPED exclusion" — zee5 was resting on the ring rule, which masked the ledger.)
 *   - the parks query in plan.ts dropping its `notIn: ['unreadable']` filter AND `splitParks`
 *     passing `unreadable` (chronicle→parked_unreadable flips from a rotation reason to
 *     `parked-failure-unsettled`; either half alone changes nothing, because each filters it);
 *   - `crossSpacingVerdict` counting a page outside the recipient's fleet (hdfcbank stops
 *     resting and reads `no-follow-up-message-written`);
 *   - the H5 sweep being dropped (society→maybelline reports `pending-attempt-exists`);
 *   - `claimedCampaignIds` counting SKIPPED as a claim (society→zee5 claims c_Z4, not the
 *     released c_Z3), or the recipient-wide ledger dropped (it claims c_Z1, chronicle's own);
 *   - a loader that stops seeing drafts written EARLIER IN THE SAME PASS — simulated by dropping
 *     READY/QUEUED from `claimedCampaignIds`' status set (society→dabur and society→boroplus flip
 *     from `no-new-material-to-reference` to `not-this-senders-turn`);
 *   - the brand cap not counting this run's own drafts (`brandFirstTouchesThisRun` dropped: the
 *     four `zz_cap_*` fillers are written instead of refused);
 *   - `composeForPair` no longer told `targetHasEverReplied` (society→maybelline's `bodyKind`
 *     flips from `follow-up` to `standard` — an introduction to a company already talking to us);
 *   - `parkBlocksRoute` resting an `unreadable` route forever again (allunreadable_old flips from
 *     a written first touch to `all-unavailable`);
 *   - the brand-string arm of `campaignsNamingHandleRows` removed (5 outcomes move:
 *     society→brandfunded flips from a written first touch to `material-exhausted`,
 *     chronicle→primevideoin from a written follow-up to `no-new-material-to-reference`,
 *     chronicle→brandfunded from `no-post-we-can-describe` to `material-exhausted`, myntra's
 *     first touch claims nothing instead of c_MY1, and the first cap filler is written in the
 *     freed slot); its exact-name test loosened to a prefix (4 move: society→brandnearmiss is
 *     written claiming c_BN2, chronicle→brandnearmiss passes to `not-this-senders-turn`, myntra
 *     claims the newer c_MY2, and titan is pushed over the cap by the extra first touch); or —
 *     the Stage 3 shape — the ALLOWANCE count alone dropping the arm while the claim keeps it
 *     (3 move: both brandfunded pairs read `material-exhausted` and a filler is written; myntra
 *     and primevideoin do NOT move, which is why neither could catch this). myntra alone catches
 *     only the first two, and only through the claim: with no delivery its allowance is
 *     `max(1, …)` = 1 whatever the arm counts, and a first touch is exempt from the new-material
 *     stops, so no funding there ever depended on a brand-only post.
 *
 * ── NOTHING REACHES THE NETWORK ────────────────────────────────────────────
 *
 * `runOutreach` drives no browser and makes no request, but its import graph reaches modules
 * that can: `brandGuards` → `resolveBrand` → `igGet`/`enrichHandle` (the anonymous profile
 * endpoint), `compose` → `generate` (the DeepSeek API, behind `generateMessages`, off), and
 * `createAndDispatch` → `profileStatus` (this machine's `~/.ds-sales-agent`, behind
 * `autopilotEnabled`, off). Every one is mocked below to THROW rather than answer, so a future
 * change that reaches one fails loudly here instead of phoning Instagram from the suite — the
 * `tests/auto-resolve.test.ts` finding of 2026-08-22. `fetch` itself is stubbed the same way.
 */

/* The anonymous Instagram transport. Nothing in a planning pass may call it. */
vi.mock('@/detection/igHttp', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/detection/igHttp')>()),
  igGet: async () => {
    throw new Error('planner-golden: igGet reached the network')
  },
}))
/* The per-handle profile enrichment — an anonymous Instagram request. */
vi.mock('@/detection/enrichHandle', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/detection/enrichHandle')>()),
  enrichHandle: async () => {
    throw new Error('planner-golden: enrichHandle reached the network')
  },
}))
/* The existence probe — an anonymous Instagram request. Not in the planner's graph today; mocked
   so that if it ever is, the test says so rather than resolving a fixture handle for real. */
vi.mock('@/detection/exists', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/detection/exists')>()),
  probeHandle: async () => {
    throw new Error('planner-golden: probeHandle reached the network')
  },
  handleExists: async () => {
    throw new Error('planner-golden: handleExists reached the network')
  },
}))
/* The model that writes message bodies — a paid HTTP call, off by setting (`generateMessages`). */
vi.mock('@/outreach/generate', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/outreach/generate')>()),
  generateMessageBody: async () => {
    throw new Error('planner-golden: generateMessageBody reached the network')
  },
}))
/* This machine's Chrome profiles. A deterministic "signed in" so the oracle's `senderHasSession`
   does not depend on whose Mac runs the suite. */
vi.mock('@/outreach/browser/profile', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/outreach/browser/profile')>()),
  profileStatus: (handle: string) => ({ handle, dir: `/tmp/profiles/${handle}`, initialised: true, hasSession: true }),
}))

vi.stubGlobal('fetch', () => {
  throw new Error('planner-golden: global fetch reached the network')
})

/**
 * The planner's environment, pinned BEFORE `@/lib/env` is first imported (dotenv never overrides
 * a variable already set). Each is a fact the golden depends on and this machine's `.env` must
 * not be allowed to vary: the writing switch, the ceiling, the three windows, and the two hard
 * floors. `DETECTION_CUTOFF` blank falls to the code default (1 August).
 */
process.env.DRY_RUN = 'false'
process.env.MAX_TOTAL_SENDS = 'unlimited'
process.env.DEFAULT_COOLDOWN_DAYS = '7'
process.env.HOOK_MAX_AGE_HOURS = '72'
process.env.MAX_PER_PAIR_PER_DAY = '5'
process.env.AUTOPILOT_ENABLED = 'false'
process.env.SEND_ENABLED = 'true'
process.env.DETECTION_CUTOFF = ''

const db = await openOutreachDb('planner-golden')

/** 12:00 IST on 15 October 2026. Every seeded date is relative to this, and the clock is frozen on it. */
const ANCHOR = new Date('2026-10-15T06:30:00.000Z')
vi.setSystemTime(ANCHOR)

const { prisma } = await import('@/lib/db')
const { runOutreach, ensureFleetPairs } = await import('@/outreach/plan')
const { evaluatePair, SKIP_REASONS } = await import('@/outreach/governor')
const { recheckBeforeSend, evaluateResend } = await import('@/outreach/gate')
const { getSettings } = await import('@/lib/settings')
const { SINGLE_TEMPLATE_MIDDLE, isStandardMessageBody } = await import('@/outreach/fleetTemplate')
const { renderFollowUp, followUpPostReference } = await import('@/outreach/followUpTemplate')
const { BRAND_BLOCKS } = await import('@/outreach/brandGuards')
const { FAILURE_CODES } = await import('@/lib/constants')
const { legacyRunContext, legacyPairFacts, legacySendFacts } = await import('./helpers/legacy-facts')

afterAll(async () => {
  vi.useRealTimers()
  /* The client holds the SQLite file open; disconnect, then remove the directory. Six leaked
     `/tmp/ds-planner-golden-*` directories were the review's finding against the first version. */
  await db.close(prisma)
})

const h = (hours: number) => new Date(ANCHOR.getTime() - hours * 3_600_000)
const d = (days: number) => h(days * 24)

const FOLLOW_UP_BODY = `Hi,Following up on {{post}} — we can put the same campaign in front of a much larger audience. Let's talk tomorrow.`
const MARKETING_TEMPLATE = `Hi,We’re the Mad About Marketing network, reaching 300M+ marketers and buyers every day across our pages. Let’s connect - +916000189766 - Kapil`

/**
 * THE NEW-BRAND QUEUE CAP, sized so it meets ONLY the four `zz_cap_*` fillers (which sort last
 * in the handle order the planner walks). It is the BRAND first touches already waiting plus the
 * ones the required cases write, plus one: `pending_draft`'s seeded READY draft (1) and the 31
 * first touches below (channelprospect is a CHANNEL and counts for neither side). The first
 * filler then finds `waitingFirstTouches` at the cap and is refused, and so are the three after
 * it — which is what pins `brandFirstTouchesThisRun` counting this run's own drafts. A required
 * case carrying the cap is asserted AGAINST below: the first version set the cap at 20, in the
 * middle of the order, and it swallowed eight real cases, two of them the ones meant to pin
 * "they know us never expires" and the undated reply. Measured, not derived: a cap of 29 refused
 * sugarcosmetics and titan, which is how the count of 30 was confirmed; society→brandfunded then
 * made it 31, and the filler test below is what re-confirms the arithmetic on every run.
 */
const MAX_WAITING_NEW_BRAND_DRAFTS = 32

const CHRONICLE = senderId('bollywoodchronicle')
const SOCIETY = senderId('bollywoodsocietyy')
const PAPARAZZII = senderId('bollywoodpaparazzii')
const MADABOUT = senderId('madaboutmarketingg')
const BURNER = senderId('tabishmukaddam1')
const WATCH = targetId('viralbhayani')

/** A tagged-post helper: Instagram-asserted evidence naming the recipient. */
function tagged(handle: string): string {
  return JSON.stringify([handle])
}

/**
 * THE SCENARIO. Every target is a BRAND prospect carrying the verified badge unless stated;
 * handles are what the golden is keyed on, so they are chosen to read as what they exercise.
 */
async function seed(): Promise<void> {
  // ── the fleet ────────────────────────────────────────────────────────────
  for (const handle of ['bollywoodchronicle', 'bollywoodsocietyy', 'madaboutmarketingg']) {
    await seedSender(prisma, { handle })
    await seedVariants(prisma, senderId(handle))
  }
  /* Flagged by Instagram: every pair of its reads `sender-not-active`, and rotation skips it. */
  await seedSender(prisma, { handle: 'bollywoodpaparazzii', status: 'CHALLENGED', challengedAt: d(1) })
  await seedVariants(prisma, PAPARAZZII)
  /* Out of the rotation: its pairs never reach the planner, but its DELIVERIES still count
     against a recipient's allowance (any page's delivery does). */
  await seedSender(prisma, { handle: 'tabishmukaddam1', fleetMember: false })
  await seedVariants(prisma, BURNER)

  await seedTarget(prisma, { handle: 'viralbhayani', role: 'WATCH', kind: 'CHANNEL', displayName: 'Viral Bhayani' })

  // ── settings ─────────────────────────────────────────────────────────────
  await setSetting(prisma, 'followUpBody', FOLLOW_UP_BODY)
  await setSetting(prisma, 'templateBody:marketing', MARKETING_TEMPLATE)
  await setSetting(prisma, 'maxWaitingNewBrandDrafts', String(MAX_WAITING_NEW_BRAND_DRAFTS))

  // ── bollywood recipients (no membership = the default fleet) ─────────────
  await seedTarget(prisma, { handle: 'crocsindia', displayName: 'Crocs India' })
  await seedPost(prisma, { shortcode: 'CR1', channelId: WATCH, postedAt: h(10), caption: 'Crocs x Bollywood', taggedAccounts: tagged('crocsindia') })
  /* The burner's delivery spends crocsindia's one-post allowance for every fleet page. */
  await seedPair(prisma, BURNER, targetId('crocsindia'))
  await seedDelivery(prisma, { pairId: pairId(BURNER, targetId('crocsindia')), sentAt: d(2), touchNumber: 1, body: SINGLE_TEMPLATE_MIDDLE, campaignId: 'c_CR1' })
  /* A cross-fleet route that `ensureFleetPairs` would never create: the marketing page to a bollywood company. */
  await seedPair(prisma, MADABOUT, targetId('crocsindia'))

  /* No paid post at all — the `max(1, …)` allowance floor is what lets a first touch through. */
  await seedTarget(prisma, { handle: 'nykaa', displayName: 'Nykaa' })

  /* Delivered TODAY by chronicle, with a fresh describable post: the same-day follow-up rule. */
  await seedTarget(prisma, { handle: 'luxindia', displayName: 'Lux India' })
  await seedPost(prisma, { shortcode: 'L1', channelId: WATCH, postedAt: h(20), caption: 'a placement with @luxindia' })
  await seedPost(prisma, { shortcode: 'L2', channelId: WATCH, postedAt: h(5), caption: 'another with @luxindia', brands: JSON.stringify(['Lux India Velvet']) })
  await seedPair(prisma, CHRONICLE, targetId('luxindia'))
  await seedDelivery(prisma, { pairId: pairId(CHRONICLE, targetId('luxindia')), sentAt: h(3), touchNumber: 1, body: SINGLE_TEMPLATE_MIDDLE, campaignId: 'c_L1' })

  /* Delivered inside the window against one post: the allowance is spent for every page. */
  await seedTarget(prisma, { handle: 'mamaearth', displayName: 'Mamaearth' })
  await seedPost(prisma, { shortcode: 'M1', channelId: WATCH, postedAt: d(3.5), caption: 'with @mamaearth' })
  await seedPair(prisma, CHRONICLE, targetId('mamaearth'))
  await seedDelivery(prisma, { pairId: pairId(CHRONICLE, targetId('mamaearth')), sentAt: d(3), touchNumber: 1, body: SINGLE_TEMPLATE_MIDDLE, campaignId: 'c_M1' })

  /* Delivered OUTSIDE the window: the old delivery counts for the touch, not for the allowance. */
  await seedTarget(prisma, { handle: 'boat.nirvana', displayName: 'boAt' })
  await seedPost(prisma, { shortcode: 'B1', channelId: WATCH, postedAt: d(10.5), caption: 'with @boat.nirvana' })
  await seedPost(prisma, { shortcode: 'B2', channelId: WATCH, postedAt: d(2), caption: 'again with @boat.nirvana', brands: JSON.stringify(['boAt Airdopes']) })
  await seedPair(prisma, CHRONICLE, targetId('boat.nirvana'))
  await seedDelivery(prisma, { pairId: pairId(CHRONICLE, targetId('boat.nirvana')), sentAt: d(10), touchNumber: 1, body: SINGLE_TEMPLATE_MIDDLE, campaignId: 'c_B1' })

  /* BOTH pages wrote outside the window, society last, and a fresh describable post names them:
     the ring wraps to chronicle, which writes its SECOND message — the one touch-2 follow-up in
     this scenario (`pickFollowUpHook`, `renderFollowUp` with a subject, the claim it names).
     society's pair is evaluated after that draft exists and finds the post claimed. */
  await seedTarget(prisma, { handle: 'boroplus', displayName: 'BoroPlus' })
  await seedPost(prisma, { shortcode: 'BP1', channelId: WATCH, postedAt: h(12), caption: 'with @boroplus', brands: JSON.stringify(['BoroPlus Cream']) })
  await seedPair(prisma, CHRONICLE, targetId('boroplus'))
  await seedPair(prisma, SOCIETY, targetId('boroplus'))
  await seedDelivery(prisma, { pairId: pairId(CHRONICLE, targetId('boroplus')), sentAt: d(20), touchNumber: 1, body: SINGLE_TEMPLATE_MIDDLE })
  await seedDelivery(prisma, { pairId: pairId(SOCIETY, targetId('boroplus')), sentAt: d(10), touchNumber: 1, body: SINGLE_TEMPLATE_MIDDLE })

  /* THE IN-RUN DEPENDENCY. society wrote outside the window, so chronicle is next and writes a
     FIRST touch claiming the only post; society's pair is evaluated AFTER that draft exists and
     reads `no-new-material-to-reference`. A loader that preloaded every pair's fresh posts once,
     at the top of the pass, would let society reach rotation and read `not-this-senders-turn`.
     The oracle test below replays the run's drafts in pair order for the same reason. */
  await seedTarget(prisma, { handle: 'dabur', displayName: 'Dabur' })
  await seedPost(prisma, { shortcode: 'D1', channelId: WATCH, postedAt: h(10), caption: 'with @dabur', brands: JSON.stringify(['Dabur Red']) })
  await seedPair(prisma, SOCIETY, targetId('dabur'))
  await seedDelivery(prisma, { pairId: pairId(SOCIETY, targetId('dabur')), sentAt: d(9), touchNumber: 1, body: SINGLE_TEMPLATE_MIDDLE })

  /* Named ONLY by a brand string — no tag, no @mention — so the first touch's claim comes from
     the brand-string arm of `campaignsNamingHandleRows`. MY2 is the near-miss, and the NEWER
     post: a brand string that merely begins with their name is not their name, and the claim
     must land on MY1. */
  await seedTarget(prisma, { handle: 'myntra', displayName: 'Myntra' })
  await seedPost(prisma, { shortcode: 'MY1', channelId: WATCH, postedAt: h(9), caption: 'fashion week round-up', brands: JSON.stringify(['Myntra']) })
  await seedPost(prisma, { shortcode: 'MY2', channelId: WATCH, postedAt: h(8), caption: 'street style edit', brands: JSON.stringify(['Myntra Fashion Week Special']) })

  /* FUNDED BY A BRAND STRING — what myntra cannot show. chronicle delivered INSIDE the window
     claiming the tagged post, so the recipient's allowance is spent unless a second post names
     them, and the only other post names them by brand string alone (exact equality with their
     own name — the first of the arm's two matches). With the arm the allowance is 2 against 1
     delivered and the next page, society, writes a first touch that claims the brand-only post;
     without it the allowance is 1 and society reads `material-exhausted`. chronicle's own pair
     passes the allowance too and stops one rule later — a follow-up cannot SPEAK a recipient's
     own name as its subject (`followUpSubject`'s partition), so it reads
     `no-post-we-can-describe` rather than `material-exhausted`. */
  await seedTarget(prisma, { handle: 'brandfunded', displayName: 'Brand Funded' })
  await seedPost(prisma, { shortcode: 'BF1', channelId: WATCH, postedAt: d(3.5), caption: 'with @brandfunded' })
  await seedPost(prisma, { shortcode: 'BF2', channelId: WATCH, postedAt: h(9), caption: 'festive edit', brands: JSON.stringify(['Brand Funded']) })
  await seedPair(prisma, CHRONICLE, targetId('brandfunded'))
  await seedDelivery(prisma, { pairId: pairId(CHRONICLE, targetId('brandfunded')), sentAt: d(3), touchNumber: 1, body: SINGLE_TEMPLATE_MIDDLE, campaignId: 'c_BF1' })

  /* THE NEAR-MISS TWIN: identical, except the brand string merely BEGINS with their name. The
     exact-name test refuses it, the allowance stays 1 against 1 delivered, and BOTH pages read
     `material-exhausted` — a prefix test would fund society's message here. */
  await seedTarget(prisma, { handle: 'brandnearmiss', displayName: 'Brand Near Miss' })
  await seedPost(prisma, { shortcode: 'BN1', channelId: WATCH, postedAt: d(3.5), caption: 'with @brandnearmiss' })
  await seedPost(prisma, { shortcode: 'BN2', channelId: WATCH, postedAt: h(9), caption: 'festive edit', brands: JSON.stringify(['Brand Near Miss Fashion Week Special']) })
  await seedPair(prisma, CHRONICLE, targetId('brandnearmiss'))
  await seedDelivery(prisma, { pairId: pairId(CHRONICLE, targetId('brandnearmiss')), sentAt: d(3), touchNumber: 1, body: SINGLE_TEMPLATE_MIDDLE, campaignId: 'c_BN1' })

  /* A FOLLOW-UP whose only fresh post is brand-only. Both pages wrote OUTSIDE the window, society
     last, so the ring wraps to chronicle; the one post naming them carries "Prime Video" — the
     prospect's name less its regional suffix, which the arm's SECOND match credits (the
     @primevideoin measurement of 2026-08-23) and `followUpSubject`'s stem arm can speak. chronicle
     writes its second message naming it; society then finds the post claimed. Without the arm
     `freshCampaignsFor` is empty for both and chronicle reads `no-new-material-to-reference`. */
  await seedTarget(prisma, { handle: 'primevideoin', displayName: 'Prime Video India' })
  await seedPost(prisma, { shortcode: 'PV1', channelId: WATCH, postedAt: h(9), caption: 'streaming this weekend', brands: JSON.stringify(['Prime Video']) })
  await seedPair(prisma, CHRONICLE, targetId('primevideoin'))
  await seedPair(prisma, SOCIETY, targetId('primevideoin'))
  await seedDelivery(prisma, { pairId: pairId(CHRONICLE, targetId('primevideoin')), sentAt: d(20), touchNumber: 1, body: SINGLE_TEMPLATE_MIDDLE })
  await seedDelivery(prisma, { pairId: pairId(SOCIETY, targetId('primevideoin')), sentAt: d(10), touchNumber: 1, body: SINGLE_TEMPLATE_MIDDLE })

  /* A DATED reply inside the halt on chronicle's pair; society holds a waiting INTRODUCTION
     the H5 sweep must discard before it is counted as pending. */
  await seedTarget(prisma, { handle: 'maybelline', displayName: 'Maybelline' })
  await seedPost(prisma, { shortcode: 'MB1', channelId: WATCH, postedAt: d(4.5), caption: 'with @maybelline' })
  await seedPost(prisma, { shortcode: 'MB2', channelId: WATCH, postedAt: h(8), caption: 'and @maybelline', brands: JSON.stringify(['Maybelline Fit Me']) })
  await seedPair(prisma, CHRONICLE, targetId('maybelline'))
  const mb = await seedDelivery(prisma, { pairId: pairId(CHRONICLE, targetId('maybelline')), sentAt: d(4), touchNumber: 1, body: SINGLE_TEMPLATE_MIDDLE, campaignId: 'c_MB1' })
  await seedReply(prisma, { attemptId: mb.id, repliedAt: d(1.9), replyPostedAt: d(2), replyText: 'Hi, who is this?' })
  await seedPair(prisma, SOCIETY, targetId('maybelline'))
  await seedDraft(prisma, { pairId: pairId(SOCIETY, targetId('maybelline')), status: 'READY', touchNumber: 1, body: SINGLE_TEMPLATE_MIDDLE, queuedAt: h(30) })

  /* An EIGHT-day-old reply: the halt has released, but "they know us" never expires. */
  await seedTarget(prisma, { handle: 'sugarcosmetics', displayName: 'SUGAR Cosmetics' })
  await seedPost(prisma, { shortcode: 'S1', channelId: WATCH, postedAt: h(30), caption: 'with @sugarcosmetics', brands: JSON.stringify(['SUGAR Cosmetics Matte']) })
  await seedPair(prisma, CHRONICLE, targetId('sugarcosmetics'))
  const sc = await seedDelivery(prisma, { pairId: pairId(CHRONICLE, targetId('sugarcosmetics')), sentAt: d(9), touchNumber: 1, body: SINGLE_TEMPLATE_MIDDLE })
  await seedReply(prisma, { attemptId: sc.id, repliedAt: d(8), replyPostedAt: d(8), replyText: 'Send us a deck.' })

  /* An UNDATED reply: listed, never halts, never counts as "they have replied". */
  await seedTarget(prisma, { handle: 'plumgoodness', displayName: 'Plum' })
  await seedPost(prisma, { shortcode: 'P1', channelId: WATCH, postedAt: d(3.2), caption: 'with @plumgoodness' })
  await seedPost(prisma, { shortcode: 'P2', channelId: WATCH, postedAt: h(6), caption: 'and @plumgoodness', brands: JSON.stringify(['Plum BodyLovin']) })
  await seedPair(prisma, CHRONICLE, targetId('plumgoodness'))
  const pg = await seedDelivery(prisma, { pairId: pairId(CHRONICLE, targetId('plumgoodness')), sentAt: d(3), touchNumber: 1, body: SINGLE_TEMPLATE_MIDDLE, campaignId: 'c_P1' })
  await seedReply(prisma, { attemptId: pg.id, repliedAt: d(2), replyPostedAt: null, replyText: 'sent an attachment' })

  // ── one park per failure code, on chronicle's pair; the two windowed codes twice ──
  const PARKS: Array<[string, string, Date]> = [
    ...FAILURE_CODES.map((code): [string, string, Date] => [`parked_${code.replace(/-/g, '_')}`, code, code === 'profile-gone' ? d(3) : d(2)]),
    ['parked_profile_gone_old', 'profile-gone', d(10)],
    ['parked_unreadable_old', 'unreadable', d(9)],
  ]
  for (const [handle, code, at] of PARKS) {
    await seedTarget(prisma, { handle, displayName: handle })
    await seedPair(prisma, CHRONICLE, targetId(handle))
    await seedPark(prisma, { pairId: pairId(CHRONICLE, targetId(handle)), failureCode: code, queuedAt: at })
  }

  /* THE CLAIM LEDGER, pinned by a WRITE: Z1 claimed by chronicle's delivery, Z2 by society's own
     (eight days old, so society's route is open and it is next after chronicle), Z3 by a
     DISCARDED draft — released, because SKIPPED is not in flight — and Z4 unclaimed but older.
     society's follow-up must claim Z3: Z4 if a SKIPPED draft still held its claim, Z1 if the
     ledger shrank back to this pair's own claims. (The first version delivered both pages inside
     the week, so the ring rule fired first and no outcome depended on the ledger at all.) */
  await seedTarget(prisma, { handle: 'zee5', displayName: 'ZEE5' })
  for (const [code, hours] of [['Z1', 10], ['Z2', 20], ['Z3', 30], ['Z4', 40]] as const) {
    await seedPost(prisma, { shortcode: code, channelId: WATCH, postedAt: h(hours), caption: `streaming on @zee5`, brands: JSON.stringify(['ZEE5 Originals']) })
  }
  await seedPair(prisma, CHRONICLE, targetId('zee5'))
  await seedPair(prisma, SOCIETY, targetId('zee5'))
  await seedDelivery(prisma, { pairId: pairId(CHRONICLE, targetId('zee5')), sentAt: d(1), touchNumber: 1, body: SINGLE_TEMPLATE_MIDDLE, campaignId: 'c_Z1' })
  await seedDelivery(prisma, { pairId: pairId(SOCIETY, targetId('zee5')), sentAt: d(8), touchNumber: 1, body: SINGLE_TEMPLATE_MIDDLE, campaignId: 'c_Z2' })
  await seedDraft(prisma, { pairId: pairId(CHRONICLE, targetId('zee5')), status: 'SKIPPED', touchNumber: 2, body: 'a discarded follow-up', campaignId: 'c_Z3', queuedAt: h(20) })

  /* Both bollywood pages delivered INSIDE the week, one claim each, and a third post unclaimed and
     describable: every stop before the ring rule passes, so what both pairs record is the
     seven-day rest and the day it lifts. */
  await seedTarget(prisma, { handle: 'ringcomplete', displayName: 'Ring Complete' })
  await seedPost(prisma, { shortcode: 'R1', channelId: WATCH, postedAt: d(3.5), caption: 'with @ringcomplete' })
  await seedPost(prisma, { shortcode: 'R2', channelId: WATCH, postedAt: d(2.5), caption: 'again @ringcomplete' })
  await seedPost(prisma, { shortcode: 'R3', channelId: WATCH, postedAt: h(10), caption: 'and @ringcomplete', brands: JSON.stringify(['Ring Complete Deluxe']) })
  await seedPair(prisma, CHRONICLE, targetId('ringcomplete'))
  await seedPair(prisma, SOCIETY, targetId('ringcomplete'))
  await seedDelivery(prisma, { pairId: pairId(CHRONICLE, targetId('ringcomplete')), sentAt: d(3), touchNumber: 1, body: SINGLE_TEMPLATE_MIDDLE, campaignId: 'c_R1' })
  await seedDelivery(prisma, { pairId: pairId(SOCIETY, targetId('ringcomplete')), sentAt: d(2), touchNumber: 1, body: SINGLE_TEMPLATE_MIDDLE, campaignId: 'c_R2' })

  await seedTarget(prisma, { handle: 'unverified_null', displayName: 'Never Looked', isVerified: null })
  await seedTarget(prisma, { handle: 'fanpage_unverified', displayName: 'Fan Page', isVerified: false })

  /* Retired: `ensureFleetPairs` creates nothing for it, so one route is seeded to reach the stop. */
  await seedTarget(prisma, { handle: 'retired_brand', displayName: 'Retired Brand', optedOut: true })
  await seedPair(prisma, CHRONICLE, targetId('retired_brand'))

  /* A READY draft already waiting on chronicle's pair; also one of the waiting first touches the brand cap counts. */
  await seedTarget(prisma, { handle: 'pending_draft', displayName: 'Pending Draft' })
  await seedPair(prisma, CHRONICLE, targetId('pending_draft'))
  await seedDraft(prisma, { pairId: pairId(CHRONICLE, targetId('pending_draft')), status: 'READY', touchNumber: 1, body: SINGLE_TEMPLATE_MIDDLE, queuedAt: h(2) })

  /* A browser mid-send counts as pending. */
  await seedTarget(prisma, { handle: 'midsend', displayName: 'Mid Send' })
  await seedPair(prisma, CHRONICLE, targetId('midsend'))
  await seedDraft(prisma, { pairId: pairId(CHRONICLE, targetId('midsend')), status: 'SENDING', touchNumber: 1, body: SINGLE_TEMPLATE_MIDDLE, queuedAt: h(1) })

  /* A person by Instagram's own category — refused by the brand guard after the governor and rotation. */
  await seedTarget(prisma, { handle: 'karanjohar', displayName: 'Karan Johar', brandCategory: 'Film Director' })
  await seedPost(prisma, { shortcode: 'KJ', channelId: WATCH, postedAt: h(9), caption: 'spotted', taggedAccounts: tagged('karanjohar') })
  /* Campaign talent: the one exemption the person guard honours. */
  await seedTarget(prisma, { handle: 'aliaabhatt', displayName: 'Alia Bhatt', brandCategory: 'Actor', campaignTalent: true })
  await seedPost(prisma, { shortcode: 'AB', channelId: WATCH, postedAt: h(9), caption: 'on set', taggedAccounts: tagged('aliaabhatt') })

  /* Two posts inside the allowance window and none inside the 72-hour hook window: nothing new to cite. */
  await seedTarget(prisma, { handle: 'fastrack', displayName: 'Fastrack' })
  await seedPost(prisma, { shortcode: 'F1', channelId: WATCH, postedAt: d(5), caption: 'with @fastrack' })
  await seedPost(prisma, { shortcode: 'F2', channelId: WATCH, postedAt: d(6), caption: 'again @fastrack' })
  await seedPair(prisma, CHRONICLE, targetId('fastrack'))
  await seedDelivery(prisma, { pairId: pairId(CHRONICLE, targetId('fastrack')), sentAt: d(4), touchNumber: 1, body: SINGLE_TEMPLATE_MIDDLE, campaignId: 'c_F1' })

  /* A fresh post naming them whose subject belongs to two OTHER advertisers: unclaimed, undescribable. */
  await seedTarget(prisma, { handle: 'kalkifashion', displayName: 'Kalki Fashion' })
  await seedPost(prisma, { shortcode: 'K1', channelId: WATCH, postedAt: d(2.5), caption: 'with @kalkifashion' })
  await seedPost(prisma, { shortcode: 'K2', channelId: WATCH, postedAt: h(6), caption: 'round-up @kalkifashion', brands: JSON.stringify(['Google India', 'Kerala Tourism']) })
  await seedPair(prisma, CHRONICLE, targetId('kalkifashion'))
  await seedDelivery(prisma, { pairId: pairId(CHRONICLE, targetId('kalkifashion')), sentAt: d(2), touchNumber: 1, body: SINGLE_TEMPLATE_MIDDLE, campaignId: 'c_K1' })

  /* Two SYNDICATED copies of one campaign on the same IST day produce the same follow-up bytes;
     chronicle already delivered exactly those bytes (claiming nothing), so the next follow-up
     would repeat them word for word. */
  await seedTarget(prisma, { handle: 'titan', displayName: 'Titan' })
  await seedPost(prisma, { shortcode: 'T1', channelId: WATCH, postedAt: h(8), caption: 'with @titan', brands: JSON.stringify(['Titan Raga']) })
  await seedPost(prisma, { shortcode: 'T2', channelId: WATCH, postedAt: h(9), caption: 'with @titan', brands: JSON.stringify(['Titan Raga']) })
  await seedPost(prisma, { shortcode: 'T3', channelId: WATCH, postedAt: d(1), caption: 'with @titan' })
  await seedPair(prisma, CHRONICLE, targetId('titan'))
  await seedDelivery(prisma, { pairId: pairId(CHRONICLE, targetId('titan')), sentAt: d(5), touchNumber: 1, body: SINGLE_TEMPLATE_MIDDLE, campaignId: 'c_T3' })
  await seedDelivery(prisma, {
    pairId: pairId(CHRONICLE, targetId('titan')),
    sentAt: d(1.5),
    touchNumber: 2,
    body: renderFollowUp(FOLLOW_UP_BODY, followUpPostReference({ postedAt: h(8), subject: 'Titan Raga' })),
  })

  /* Both bollywood pages hold an `unreadable` park inside the week: the governor ignores both,
     rotation blocks both routes, and the flagged page is unavailable — nobody can be elected. */
  await seedTarget(prisma, { handle: 'allunreadable', displayName: 'All Unreadable' })
  await seedPair(prisma, CHRONICLE, targetId('allunreadable'))
  await seedPair(prisma, SOCIETY, targetId('allunreadable'))
  await seedPark(prisma, { pairId: pairId(CHRONICLE, targetId('allunreadable')), failureCode: 'unreadable', queuedAt: d(1) })
  await seedPark(prisma, { pairId: pairId(SOCIETY, targetId('allunreadable')), failureCode: 'unreadable', queuedAt: d(2) })

  /* The same two parks, both OLDER than a week: `parkBlocksRoute` rests an unreadable route for
     `UNREADABLE_RECHECK_DAYS` only, so a page is elected here and writes. The inside-the-week
     twin above reads `all-unavailable`; the two must DIFFER, or the window is not pinned and the
     permanent block (the regression parkedRows.ts records) would pass. */
  await seedTarget(prisma, { handle: 'allunreadable_old', displayName: 'All Unreadable Old' })
  await seedPair(prisma, CHRONICLE, targetId('allunreadable_old'))
  await seedPair(prisma, SOCIETY, targetId('allunreadable_old'))
  await seedPark(prisma, { pairId: pairId(CHRONICLE, targetId('allunreadable_old')), failureCode: 'unreadable', queuedAt: d(8) })
  await seedPark(prisma, { pairId: pairId(SOCIETY, targetId('allunreadable_old')), failureCode: 'unreadable', queuedAt: d(9) })

  /* A CHANNEL-kind prospect: neither brand guard applies to it. */
  await seedTarget(prisma, { handle: 'channelprospect', displayName: 'Channel Prospect', kind: 'CHANNEL' })
  await seedPost(prisma, { shortcode: 'CP', channelId: WATCH, postedAt: h(9), caption: 'collab', taggedAccounts: tagged('channelprospect') })

  // ── the marketing fleet: one page, its own template, NO follow-up copy ───
  await seedTarget(prisma, { handle: 'amazonindia', displayName: 'Amazon India' })
  await seedPost(prisma, { shortcode: 'A1', channelId: WATCH, postedAt: h(4), caption: 'with @amazonindia' })
  /* One page writes to it and has written inside the window: the one-page ring rests on itself (M12, the literal reading). */
  await seedTarget(prisma, { handle: 'hdfcbank', displayName: 'HDFC Bank' })
  await seedPost(prisma, { shortcode: 'H1', channelId: WATCH, postedAt: d(3.5), caption: 'with @hdfcbank' })
  await seedPost(prisma, { shortcode: 'H2', channelId: WATCH, postedAt: h(7), caption: 'and @hdfcbank', brands: JSON.stringify(['HDFC Bank Regalia']) })
  await seedPair(prisma, MADABOUT, targetId('hdfcbank'))
  await seedDelivery(prisma, { pairId: pairId(MADABOUT, targetId('hdfcbank')), sentAt: d(3), touchNumber: 1, body: MARKETING_TEMPLATE, campaignId: 'c_H1' })
  /* Written to outside the window with a fresh describable post, and the fleet's follow-up copy unwritten. */
  await seedTarget(prisma, { handle: 'zomato', displayName: 'Zomato' })
  await seedPost(prisma, { shortcode: 'ZO1', channelId: WATCH, postedAt: h(10), caption: 'with @zomato', brands: JSON.stringify(['Zomato Gold']) })
  await seedPair(prisma, MADABOUT, targetId('zomato'))
  await seedDelivery(prisma, { pairId: pairId(MADABOUT, targetId('zomato')), sentAt: d(9), touchNumber: 1, body: MARKETING_TEMPLATE })

  // ── a third fleet with no template at all, and a recipient in two fleets ──
  await seedTarget(prisma, { handle: 'ikeaindia', displayName: 'IKEA India' })
  await seedPost(prisma, { shortcode: 'IK', channelId: WATCH, postedAt: h(5), caption: 'furniture', taggedAccounts: tagged('ikeaindia') })
  await seedTarget(prisma, { handle: 'tatacliq', displayName: 'Tata CLiQ' })

  await seedCategory(prisma, 'marketing', {
    senders: [MADABOUT],
    targets: [targetId('amazonindia'), targetId('hdfcbank'), targetId('zomato'), targetId('tatacliq')],
  })
  await seedCategory(prisma, 'lifestyle', { senders: [MADABOUT], targets: [targetId('ikeaindia'), targetId('tatacliq')] })

  // ── the new-brand queue cap: fillers that sort LAST, so the cap meets only them ──
  /* No posts: the `max(1, …)` allowance floor lets each first touch through to rotation, the
     elected page meets the cap, and the other reads `not-this-senders-turn`. See
     `MAX_WAITING_NEW_BRAND_DRAFTS` for the arithmetic. */
  for (const n of [1, 2, 3, 4]) {
    await seedTarget(prisma, { handle: `zz_cap_0${n}`, displayName: `Cap Filler ${n}` })
  }
}

const GOLDEN_PATH = join(__dirname, 'fixtures', 'planner-golden.json')
const REGENERATE = process.env.REGENERATE_PLANNER_GOLDEN === '1'

interface PairOutcome {
  eligible: boolean
  skipReason?: string
  skipDetail?: string
  status?: string
  touchNumber?: number
  claimedCampaign?: string | null
  /** The bytes written, verbatim. Twenty-odd drafts of one line each; the diff is the review. */
  body?: string
  hookLine?: string | null
  /**
   * `standard` when the body is one of the fleet's standard messages by the gate's own predicate
   * (`isStandardMessageBody`), else `follow-up`. A label beside the bytes so a fixture diff reads
   * at a glance which decision moved; the body is what is compared.
   */
  bodyKind?: 'standard' | 'follow-up'
  error?: string
}
interface PlannerGolden {
  anchor: string
  summary: { queued: number; sent: number; failed: number; skipped: number }
  /** RECORDED, NEVER ASSERTED — the Stage 3 baseline. */
  queryCount: number
  outcomes: Record<string, PairOutcome>
}

function serialise(g: PlannerGolden): string {
  const keys = Object.keys(g.outcomes).sort()
  const lines = keys.map((k) => `    ${JSON.stringify(k)}: ${JSON.stringify(g.outcomes[k])}`)
  return `{\n  "anchor": ${JSON.stringify(g.anchor)},\n  "summary": ${JSON.stringify(g.summary)},\n  "queryCount": ${g.queryCount},\n  "outcomes": {\n${lines.join(',\n')}\n  }\n}\n`
}

/** Reasons that come AFTER the governor said yes: rotation's, and the two brand guards'. */
const POST_GOVERNOR_REASONS = new Set<string>(['not-this-senders-turn', 'empty-ring', 'all-unavailable', ...Object.values(BRAND_BLOCKS)])

await seed()
const { result: summary, queries } = await countQueries(() => runOutreach())
const settingsAfterRun = await getSettings()

const outcomes: Record<string, PairOutcome> = {}
for (const o of summary.outcomes) {
  const entry: PairOutcome = { eligible: o.eligible }
  if (o.skipReason !== undefined) entry.skipReason = o.skipReason
  if (o.skipDetail !== undefined) entry.skipDetail = o.skipDetail
  if (o.error !== undefined) entry.error = o.error
  if (o.attemptId !== undefined) {
    const a = await prisma.outreachAttempt.findUniqueOrThrow({
      where: { id: o.attemptId },
      select: { status: true, touchNumber: true, campaignId: true, renderedBody: true, hookLine: true },
    })
    entry.status = a.status
    entry.touchNumber = a.touchNumber
    entry.claimedCampaign = a.campaignId
    entry.body = a.renderedBody
    entry.hookLine = a.hookLine
    entry.bodyKind = isStandardMessageBody(a.renderedBody, settingsAfterRun) ? 'standard' : 'follow-up'
  }
  outcomes[o.pairKey] = entry
}
const actual: PlannerGolden = {
  anchor: ANCHOR.toISOString(),
  summary: { queued: summary.queued, sent: summary.sent, failed: summary.failed, skipped: summary.skipped },
  queryCount: queries,
  outcomes,
}

describe('the scenario reaches what it was built to reach', () => {
  it('reports every governor stop the planner can produce from rows, plus rotation and the brand guards', () => {
    const reasons = new Set(Object.values(outcomes).map((o) => o.skipReason).filter((r): r is string => r !== undefined))
    /* LIFETIME_CAP needs a ceiling (unlimited here) and PAIR_DAILY_CAP is shadowed in the
       planner by FOLLOW_UP_SAME_DAY (a delivery today makes the pair a follow-up first) — both
       are pinned by the pure-function golden instead. */
    const expectedGovernor = Object.values(SKIP_REASONS).filter(
      (r) => r !== SKIP_REASONS.LIFETIME_CAP && r !== SKIP_REASONS.PAIR_DAILY_CAP,
    )
    expect(expectedGovernor.filter((r) => !reasons.has(r))).toEqual([])
    expect(reasons.has('not-this-senders-turn')).toBe(true)
    expect(reasons.has('all-unavailable')).toBe(true)
    expect(reasons.has(BRAND_BLOCKS.RECIPIENT_IS_A_PERSON)).toBe(true)
    expect(reasons.has(BRAND_BLOCKS.NEW_BRAND_DAILY_CAP)).toBe(true)
    expect(Object.values(outcomes).some((o) => o.eligible && o.status === 'READY')).toBe(true)
    /* A SECOND message on an existing conversation is written somewhere — the composer's
       follow-up path is exercised as a write, not only predicted by the governor. */
    expect(Object.values(outcomes).some((o) => o.status === 'READY' && (o.touchNumber ?? 0) >= 2)).toBe(true)
    expect(Object.values(outcomes).some((o) => o.error !== undefined)).toBe(false)
  })

  it('never lists the burner, and the swept introduction left society free to write', () => {
    expect(Object.keys(outcomes).some((k) => k.startsWith('tabishmukaddam1→'))).toBe(false)
    expect(outcomes['bollywoodsocietyy→maybelline']?.skipReason).not.toBe(SKIP_REASONS.PENDING_ATTEMPT)
  })
})

/**
 * THE CASES THE REVIEW ASKED FOR, each pinned BY NAME beside the fixture. The fixture pins every
 * outcome byte for byte; these say in prose which outcome carries which rule, so a regeneration
 * that moved one of them is caught by a sentence and not only by a diff line.
 */
describe('the cases the review asked for, pinned by name', () => {
  const readyTo = (handle: string) =>
    Object.entries(outcomes).filter(([k, o]) => k.endsWith(`→${handle}`) && o.status === 'READY')

  it('writes the follow-up to a recipient who already replied, and each fleet its own standard message', () => {
    /* society has never written to maybelline (touch 1), but maybelline answered chronicle —
       `isFollowUp` with `targetHasEverReplied`, so the bytes are the follow-up naming MB2. */
    const maybelline = outcomes['bollywoodsocietyy→maybelline']!
    expect(maybelline).toMatchObject({ status: 'READY', touchNumber: 1, claimedCampaign: 'c_MB2', bodyKind: 'follow-up', hookLine: null })
    expect(maybelline.body).toBe(renderFollowUp(FOLLOW_UP_BODY, followUpPostReference({ postedAt: h(8), subject: 'Maybelline Fit Me' })))
    expect(outcomes['madaboutmarketingg→amazonindia']).toMatchObject({ status: 'READY', bodyKind: 'standard', body: MARKETING_TEMPLATE.trim() })
    expect(outcomes['bollywoodchronicle→nykaa']).toMatchObject({ status: 'READY', bodyKind: 'standard', body: SINGLE_TEMPLATE_MIDDLE.trim() })
  })

  it('writes a second message on an existing conversation (boroplus), and the other page then finds the post claimed', () => {
    const chronicle = outcomes['bollywoodchronicle→boroplus']!
    expect(chronicle).toMatchObject({ status: 'READY', touchNumber: 2, claimedCampaign: 'c_BP1', bodyKind: 'follow-up' })
    expect(chronicle.body).toBe(renderFollowUp(FOLLOW_UP_BODY, followUpPostReference({ postedAt: h(12), subject: 'BoroPlus Cream' })))
    expect(outcomes['bollywoodsocietyy→boroplus']?.skipReason).toBe(SKIP_REASONS.NO_NEW_MATERIAL)
  })

  it('a draft written earlier in the same pass is a claim the next pair sees (dabur)', () => {
    expect(outcomes['bollywoodchronicle→dabur']).toMatchObject({ status: 'READY', touchNumber: 1, claimedCampaign: 'c_D1', bodyKind: 'standard' })
    expect(outcomes['bollywoodsocietyy→dabur']?.skipReason).toBe(SKIP_REASONS.NO_NEW_MATERIAL)
  })

  it('the claim ledger: a SKIPPED draft releases its post and another page’s delivery holds its own (zee5)', () => {
    expect(outcomes['bollywoodchronicle→zee5']?.skipReason).toBe('not-this-senders-turn')
    expect(outcomes['bollywoodsocietyy→zee5']).toMatchObject({ status: 'READY', touchNumber: 2, claimedCampaign: 'c_Z3', bodyKind: 'follow-up' })
  })

  it('two pages that both wrote inside the week rest the recipient (ringcomplete)', () => {
    for (const page of ['bollywoodchronicle', 'bollywoodsocietyy']) {
      expect(outcomes[`${page}→ringcomplete`]?.skipReason).toBe(SKIP_REASONS.TARGET_RECENTLY_CONTACTED)
    }
  })

  it('the queue cap meets only the fillers that sort last, never a required case', () => {
    for (const [key, o] of Object.entries(outcomes)) {
      if (!key.includes('→zz_cap_')) expect(o.skipReason, key).not.toBe(BRAND_BLOCKS.NEW_BRAND_DAILY_CAP)
    }
    for (const n of [1, 2, 3, 4]) {
      const capped = Object.entries(outcomes).filter(([k, o]) => k.endsWith(`→zz_cap_0${n}`) && o.skipReason === BRAND_BLOCKS.NEW_BRAND_DAILY_CAP)
      expect(capped.length, `zz_cap_0${n}`).toBe(1)
    }
  })

  it('an unreadable park rests a route for a week, not forever', () => {
    for (const page of ['bollywoodchronicle', 'bollywoodsocietyy']) {
      expect(outcomes[`${page}→allunreadable`]?.skipReason).toBe('all-unavailable')
    }
    expect(readyTo('allunreadable_old').length).toBe(1)
  })

  it('a post naming a recipient only by brand string FUNDS the next message and is what it claims; a near-miss funds nothing (brandfunded, brandnearmiss)', () => {
    /* FUNDING: chronicle wrote inside the window against the tagged post, so only the brand-only
       post can raise the allowance to 2 — society's first touch exists because of it, and claims
       it. Its sibling pair stops at the describable-subject rule, one rule PAST the allowance. */
    expect(outcomes['bollywoodsocietyy→brandfunded']).toMatchObject({ status: 'READY', touchNumber: 1, claimedCampaign: 'c_BF2', bodyKind: 'standard' })
    expect(outcomes['bollywoodchronicle→brandfunded']?.skipReason).toBe(SKIP_REASONS.NO_DESCRIBABLE_POST)
    /* The twin whose brand string merely begins with their name: allowance 1, delivered 1. */
    for (const page of ['bollywoodchronicle', 'bollywoodsocietyy']) {
      expect(outcomes[`${page}→brandnearmiss`]?.skipReason).toBe(SKIP_REASONS.MATERIAL_EXHAUSTED)
    }
  })

  it('a follow-up whose only fresh post is brand-only is written and names it (primevideoin)', () => {
    const chronicle = outcomes['bollywoodchronicle→primevideoin']!
    expect(chronicle).toMatchObject({ status: 'READY', touchNumber: 2, claimedCampaign: 'c_PV1', bodyKind: 'follow-up' })
    expect(chronicle.body).toBe(renderFollowUp(FOLLOW_UP_BODY, followUpPostReference({ postedAt: h(9), subject: 'Prime Video' })))
    expect(outcomes['bollywoodsocietyy→primevideoin']?.skipReason).toBe(SKIP_REASONS.NO_NEW_MATERIAL)
  })

  it('the CLAIM alone depends on the brand-string arm where nothing was delivered (myntra)', () => {
    /* myntra has no delivery, so its allowance is `max(1, …)` = 1 whatever the arm counts, and a
       first touch is exempt from the new-material stops: the only thing the arm decides here is
       WHICH post is claimed — MY1, named by their exact name, over the newer near-miss MY2. */
    const [written] = readyTo('myntra')
    expect(written?.[1]).toMatchObject({ touchNumber: 1, claimedCampaign: 'c_MY1' })
  })
})

describe('planner-golden.json pins every pair outcome of runOutreach', () => {
  it('matches, pair by pair', () => {
    if (REGENERATE) writeFileSync(GOLDEN_PATH, serialise(actual))

    expect(existsSync(GOLDEN_PATH), 'no golden on disk — run once with REGENERATE_PLANNER_GOLDEN=1').toBe(true)
    const golden = JSON.parse(readFileSync(GOLDEN_PATH, 'utf8')) as PlannerGolden

    expect(golden.anchor).toBe(actual.anchor)
    const mismatches: string[] = []
    for (const key of new Set([...Object.keys(golden.outcomes), ...Object.keys(actual.outcomes)])) {
      const want = golden.outcomes[key]
      const got = actual.outcomes[key]
      if (JSON.stringify(want) !== JSON.stringify(got)) {
        mismatches.push(`${key}\n    golden: ${JSON.stringify(want)}\n    now:    ${JSON.stringify(got)}`)
      }
    }
    expect(
      mismatches,
      `${mismatches.length} pair outcome(s) differ from tests/fixtures/planner-golden.json:\n${mismatches.slice(0, 12).join('\n')}`,
    ).toEqual([])
    expect(actual.summary).toEqual(golden.summary)
    /* queryCount is deliberately NOT compared — see the docblock. */
  })
})

describe('the frozen oracle (tests/helpers/legacy-facts.ts) still runs on this scenario', () => {
  it('legacySendFacts assembles what recheckBeforeSend assembles, for every waiting draft', async () => {
    const waiting = await prisma.outreachAttempt.findMany({
      where: { status: { in: ['READY', 'QUEUED'] } },
      include: { pair: { include: { sender: true, target: true } } },
    })
    expect(waiting.length).toBeGreaterThan(1)
    for (const a of waiting) {
      const shaped = {
        id: a.id,
        status: a.status,
        pair: {
          senderId: a.pair.senderId,
          targetId: a.pair.targetId,
          sender: { handle: a.pair.sender.handle, status: a.pair.sender.status },
          target: {
            handle: a.pair.target.handle,
            displayName: a.pair.target.displayName,
            optedOut: a.pair.target.optedOut,
            role: a.pair.target.role,
            kind: a.pair.target.kind,
            isVerified: a.pair.target.isVerified,
          },
        },
      }
      const facts = await legacySendFacts(shaped, { unattended: true })
      expect(evaluateResend(facts)).toEqual(await recheckBeforeSend(shaped, { unattended: true }))
    }
  })

  /**
   * The planner re-reads each pair's facts AFTER the pairs before it have written — a draft
   * written for chronicle→dabur is a claim society→dabur then sees. So the oracle is NOT run
   * against one snapshot: the run's drafts are taken out, and each one is put back the moment its
   * own pair has been evaluated, in the planner's own pair order. The comparison is the whole
   * decision — eligibility, reason, DETAIL and, for a written draft, the touch number — because a
   * fact that moved only a date in a sentence (`replyPostedAt` read instead of `repliedAt`, say)
   * passed the first version, which compared the reason alone.
   */
  it('legacyPairFacts reproduces the verdict, detail and touch number the planner recorded, replaying its drafts in order', async () => {
    const writtenIds = summary.outcomes.map((o) => o.attemptId).filter((id): id is string => id !== undefined)
    const writtenRows = await prisma.outreachAttempt.findMany({ where: { id: { in: writtenIds } } })
    const writtenByPairKey = new Map<string, (typeof writtenRows)[number]>()
    for (const o of summary.outcomes) {
      const row = o.attemptId === undefined ? undefined : writtenRows.find((w) => w.id === o.attemptId)
      if (row) writtenByPairKey.set(o.pairKey, row)
    }
    /* Back to what the governor saw at the top of the pass: the planner's own drafts are the only
       thing it added (the H5 sweep's SKIPPED row is exactly the state the governor read after it). */
    await prisma.outreachAttempt.deleteMany({ where: { id: { in: writtenIds } } })
    await ensureFleetPairs()
    const settings = await getSettings()
    const pairs = await prisma.outreachPair.findMany({
      where: { sender: { fleetMember: true } },
      include: { sender: true, target: true },
      orderBy: [{ target: { handle: 'asc' } }, { sender: { handle: 'asc' } }],
    })
    expect(pairs.length).toBe(Object.keys(outcomes).length)
    const ctx = await legacyRunContext(prisma, settings, ANCHOR, pairs)
    const disagreements: string[] = []
    let replayed = 0
    for (const pair of pairs) {
      const key = `${pair.sender.handle}→${pair.target.handle}`
      /* `totalSentEver` is the one run-level number the planner advances inside its loop. */
      const facts = await legacyPairFacts(prisma, pair, settings, ANCHOR, { ...ctx, totalSentEver: ctx.totalSentEver + replayed })
      const decision = evaluatePair(facts)
      const recorded = outcomes[key]!
      const recordedGovernorOk = recorded.eligible || POST_GOVERNOR_REASONS.has(recorded.skipReason ?? '')
      let differs: string | null = null
      if (decision.eligible !== recordedGovernorOk) differs = 'eligibility'
      else if (!decision.eligible && decision.reason !== recorded.skipReason) differs = 'reason'
      else if (!decision.eligible && decision.detail !== recorded.skipDetail) differs = 'detail'
      else if (decision.eligible && recorded.status === 'READY' && decision.touchNumber !== recorded.touchNumber) differs = 'touch number'
      if (differs !== null) {
        disagreements.push(`${key} (${differs}): oracle ${JSON.stringify(decision)} vs planner ${JSON.stringify(recorded)}`)
      }
      const row = writtenByPairKey.get(key)
      if (row) {
        await prisma.outreachAttempt.create({ data: row })
        if (row.status === 'READY' || row.status === 'QUEUED') replayed += 1
      }
    }
    expect(disagreements).toEqual([])
    /* Every draft the planner wrote went back, so the replay was the planner's own sequence. */
    expect(replayed).toBe(summary.queued)
  })
})
