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
 * sentence, status or touch number. Regenerate only DELIBERATELY —
 * `REGENERATE_PLANNER_GOLDEN=1 pnpm exec vitest run tests/planner-golden.test.ts` — and read
 * the fixture diff before committing it. The `queryCount` in the fixture is RECORDED and never
 * asserted: it is the baseline Stage 3 measures its loader against, and a number that must not
 * rise, not a number that must not change.
 *
 * What would fail it, concretely: `splitParks` starting to pass `unreadable` to the governor
 * (two pairs flip from rotation reasons to `parked-failure-unsettled`); `crossSpacingVerdict`
 * counting a page outside the recipient's fleet (hdfcbank stops resting); the H5 sweep being
 * dropped (society→maybelline reports `pending-attempt-exists`); `freshCampaignsFor` forgetting
 * the SKIPPED exclusion (zee5's chronicle pair loses a fresh post); the brand cap counting this
 * run's drafts differently (the later first touches flip between written and capped).
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

await openOutreachDb('planner-golden')

/** 12:00 IST on 15 October 2026. Every seeded date is relative to this, and the clock is frozen on it. */
const ANCHOR = new Date('2026-10-15T06:30:00.000Z')
vi.setSystemTime(ANCHOR)

const { prisma } = await import('@/lib/db')
const { runOutreach, ensureFleetPairs } = await import('@/outreach/plan')
const { evaluatePair, SKIP_REASONS } = await import('@/outreach/governor')
const { recheckBeforeSend, evaluateResend } = await import('@/outreach/gate')
const { getSettings } = await import('@/lib/settings')
const { SINGLE_TEMPLATE_MIDDLE } = await import('@/outreach/fleetTemplate')
const { renderFollowUp, followUpPostReference } = await import('@/outreach/followUpTemplate')
const { BRAND_BLOCKS } = await import('@/outreach/brandGuards')
const { FAILURE_CODES } = await import('@/lib/constants')
const { legacyRunContext, legacyPairFacts, legacySendFacts } = await import('./helpers/legacy-facts')

afterAll(() => {
  vi.useRealTimers()
})

const h = (hours: number) => new Date(ANCHOR.getTime() - hours * 3_600_000)
const d = (days: number) => h(days * 24)

const FOLLOW_UP_BODY = `Hi,Following up on {{post}} — we can put the same campaign in front of a much larger audience. Let's talk tomorrow.`
const MARKETING_TEMPLATE = `Hi,We’re the Mad About Marketing network, reaching 300M+ marketers and buyers every day across our pages. Let’s connect - +916000189766 - Kapil`

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
  /* Small enough that this run's own first touches reach it near the END of the handle order:
     most eligible pairs are written (their touch numbers and claims are pinned), and the last
     few meet the cap, which pins `brandFirstTouchesThisRun` counting this run's own drafts. */
  await setSetting(prisma, 'maxWaitingNewBrandDrafts', '20')

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

  /* The claim ledger: Z1 claimed by this pair, Z2 by the other page, Z3 by a DISCARDED draft
     (released), Z4 unclaimed — and both pages delivered inside the window: ring-complete. */
  await seedTarget(prisma, { handle: 'zee5', displayName: 'ZEE5' })
  for (const [code, hours] of [['Z1', 10], ['Z2', 20], ['Z3', 30], ['Z4', 40]] as const) {
    await seedPost(prisma, { shortcode: code, channelId: WATCH, postedAt: h(hours), caption: `streaming on @zee5`, brands: JSON.stringify(['ZEE5 Originals']) })
  }
  await seedPair(prisma, CHRONICLE, targetId('zee5'))
  await seedPair(prisma, SOCIETY, targetId('zee5'))
  await seedDelivery(prisma, { pairId: pairId(CHRONICLE, targetId('zee5')), sentAt: d(1), touchNumber: 1, body: SINGLE_TEMPLATE_MIDDLE, campaignId: 'c_Z1' })
  await seedDelivery(prisma, { pairId: pairId(SOCIETY, targetId('zee5')), sentAt: d(1.5), touchNumber: 1, body: SINGLE_TEMPLATE_MIDDLE, campaignId: 'c_Z2' })
  await seedDraft(prisma, { pairId: pairId(CHRONICLE, targetId('zee5')), status: 'SKIPPED', touchNumber: 2, body: 'a discarded follow-up', campaignId: 'c_Z3', queuedAt: h(20) })

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

const outcomes: Record<string, PairOutcome> = {}
for (const o of summary.outcomes) {
  const entry: PairOutcome = { eligible: o.eligible }
  if (o.skipReason !== undefined) entry.skipReason = o.skipReason
  if (o.skipDetail !== undefined) entry.skipDetail = o.skipDetail
  if (o.error !== undefined) entry.error = o.error
  if (o.attemptId !== undefined) {
    const a = await prisma.outreachAttempt.findUniqueOrThrow({
      where: { id: o.attemptId },
      select: { status: true, touchNumber: true, campaignId: true },
    })
    entry.status = a.status
    entry.touchNumber = a.touchNumber
    entry.claimedCampaign = a.campaignId
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
    expect(Object.values(outcomes).some((o) => o.error !== undefined)).toBe(false)
  })

  it('never lists the burner, and the swept introduction left society free to write', () => {
    expect(Object.keys(outcomes).some((k) => k.startsWith('tabishmukaddam1→'))).toBe(false)
    expect(outcomes['bollywoodsocietyy→maybelline']?.skipReason).not.toBe(SKIP_REASONS.PENDING_ATTEMPT)
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

  it('legacyPairFacts reproduces the governor verdict the planner recorded, for every fleet pair', async () => {
    /* Put the rows back to what the governor saw: the planner's own drafts are the only thing it
       added (the H5 sweep's SKIPPED row is exactly the state the governor read after it). */
    await prisma.outreachAttempt.deleteMany({
      where: { id: { in: summary.outcomes.map((o) => o.attemptId).filter((id): id is string => id !== undefined) } },
    })
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
    for (const pair of pairs) {
      const facts = await legacyPairFacts(prisma, pair, settings, ANCHOR, ctx)
      const decision = evaluatePair(facts)
      const recorded = outcomes[`${pair.sender.handle}→${pair.target.handle}`]!
      const recordedGovernorOk = recorded.eligible || POST_GOVERNOR_REASONS.has(recorded.skipReason ?? '')
      if (decision.eligible !== recordedGovernorOk || (!decision.eligible && decision.reason !== recorded.skipReason)) {
        disagreements.push(`${pair.sender.handle}→${pair.target.handle}: oracle ${JSON.stringify(decision)} vs planner ${JSON.stringify(recorded)}`)
      }
    }
    expect(disagreements).toEqual([])
  })
})
