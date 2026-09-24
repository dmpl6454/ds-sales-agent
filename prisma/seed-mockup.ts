import 'dotenv/config'
import { PrismaClient } from '../src/generated/prisma/client.js'
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3'

/**
 * DEMO DATA FOR LOOKING AT THE DESIGN, and nothing else.
 *
 * ── WHY THIS IS A SEPARATE FILE FROM `seed.ts` ──────────────────────────────
 *
 * `prisma/seed.ts` sets up a real deployment: the accounts that actually send, the channels
 * actually watched, the hand-written copy. Everything in THIS file is invented to fill the
 * seven pages so a person can see the layout at a realistic density — 477 companies, a
 * fortnight of deliveries, replies mid-conversation, a fleet at three different states of
 * health. None of it describes anything that happened.
 *
 * Keeping them apart is the whole safety argument. `db:seed` must never silently become the
 * thing that fabricates 184 delivered messages, because a delivered row is the record this
 * system uses to decide who has already been written to — and `/analytics` will render these
 * as history with no way for a reader to tell them from real sends.
 *
 * ── IT REFUSES A DATABASE THAT LOOKS REAL ───────────────────────────────────
 *
 * The guard is `sentBy`: every attempt written here is stamped `demo:` and the script
 * refuses outright if it finds a delivered row that is not. So pointing it at a live
 * database stops at the first query rather than burying real history under invented rows,
 * and re-running it is idempotent — it clears its OWN rows and writes them again.
 *
 * Run with `pnpm db:seed:mockup`. It is dry by default in the sense that matters: it writes
 * only to the database `DATABASE_URL` names, and it prints that name before it starts.
 */

const adapter = new PrismaBetterSqlite3({ url: process.env.DATABASE_URL ?? 'file:./prisma/dev.db' })
const prisma = new PrismaClient({ adapter })

const DEMO = 'demo:'

/** IST is a fixed +05:30, so a day boundary is a subtraction rather than a timezone library. */
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000
const now = new Date()
const hoursAgo = (h: number) => new Date(now.getTime() - h * 60 * 60 * 1000)
const daysAgo = (d: number) => hoursAgo(d * 24)

/** Deterministic, so two runs produce the same screen and a screenshot stays comparable. */
let seed = 20260918
const rand = () => {
  seed = (seed * 1103515245 + 12345) % 2147483648
  return seed / 2147483648
}
const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!

const SENDERS = [
  { handle: 'maraboutmarketing', displayName: 'Mad About Marketing', cohort: 1, status: 'ACTIVE', signedIn: true },
  { handle: 'bollywoodsociety', displayName: 'Bollywood Society', cohort: 1, status: 'ACTIVE', signedIn: true },
  { handle: 'bollywoodchronicle', displayName: 'Bollywood Chronicle', cohort: 1, status: 'ACTIVE', signedIn: false },
] as const

const WATCHED = [
  {
    handle: 'madovermarketing_mom',
    displayName: 'Mad Over Marketing',
    followerCount: 1_200_000,
    detectorKey: 'mom',
    postsLogged: 412,
  },
  {
    handle: 'viralbhayani',
    displayName: 'Viral Bhayani',
    followerCount: 4_800_000,
    detectorKey: 'semantic',
    postsLogged: 1_840,
  },
] as const

/** The named companies from the mockup, then filler to reach a realistic list length. */
const NAMED_COMPANIES = [
  ['royalcanin.india', 'Royal Canin'],
  ['theleela', 'The Leela'],
  ['tilara.india', 'Tilara'],
  ['crocsindia', 'Crocs India'],
  ['keshavamband', 'Keshav Amband'],
  ['stylewithmira', 'Mira Style'],
  ['nykaa', 'Nykaa'],
  ['tanishqjewellery', 'Tanishq'],
  ['primevideoin', 'Prime Video India'],
  ['netflix_in', 'Netflix India'],
  ['zee5', 'ZEE5'],
  ['jiohotstar', 'JioHotstar'],
  ['sonylivindia', 'Sony LIV'],
  ['amazondotin', 'Amazon India'],
  ['philipsindia', 'Philips India'],
  ['lavamobiles', 'Lava Mobiles'],
  ['mtr_foods', 'MTR Foods'],
  ['kamaayurveda', 'Kama Ayurveda'],
  ['titanwatchesindia', 'Titan Watches'],
  ['luxindia', 'LUX India'],
] as const

const FILLER_PREFIX = [
  'urban', 'metro', 'daily', 'fresh', 'prime', 'royal', 'craft', 'nova', 'bright', 'first',
  'green', 'blue', 'swift', 'grand', 'clear', 'true', 'pure', 'bold', 'smart', 'vivid',
]
const FILLER_SUFFIX = [
  'foods', 'living', 'studio', 'labs', 'wear', 'care', 'works', 'india', 'house', 'co',
  'digital', 'goods', 'beauty', 'motors', 'realty', 'travel', 'fitness', 'coffee', 'decor', 'media',
]

const CAPTIONS_PAID = [
  'Partnering with the team to bring you this one. #Collaboration',
  'Our new campaign is live across the country — swipe to see it. #ad',
  'Introducing the festive range, out now. Paid partnership.',
  'The collection drops this Friday. #Collaboration',
  'Proud to work with a brand doing this properly. #sponsored',
]
const CAPTIONS_ORGANIC = [
  'Spotted at the airport this morning.',
  'The way this whole cast showed up tonight.',
  'A quiet Sunday in the city.',
  'Behind the scenes from yesterday.',
  'This look has everyone talking.',
]

async function refuseIfLive(): Promise<void> {
  const realDelivered = await prisma.outreachAttempt.count({
    where: { sentAt: { not: null }, NOT: { sentBy: { startsWith: DEMO } } },
  })
  if (realDelivered > 0) {
    throw new Error(
      `REFUSING: this database holds ${realDelivered} delivered message(s) that were not written by this script. ` +
        `Demo data is never mixed with real send history — point DATABASE_URL at a scratch database.`,
    )
  }
}

/** Clears only what a previous run of THIS script wrote, so re-running is idempotent. */
async function clearDemo(): Promise<void> {
  await prisma.outreachAttempt.deleteMany({ where: { sentBy: { startsWith: DEMO } } })
  await prisma.outreachAttempt.deleteMany({ where: { sentBy: null } })
  await prisma.modelCall.deleteMany({})
  await prisma.detectedCampaign.deleteMany({})
  await prisma.outreachPair.deleteMany({})
  await prisma.messageVariant.deleteMany({})
  await prisma.targetAccount.deleteMany({})
  await prisma.senderAccount.deleteMany({})
}

async function main(): Promise<void> {
  console.log(`database: ${process.env.DATABASE_URL}`)
  await refuseIfLive()
  await clearDemo()

  // ── senders ───────────────────────────────────────────────────────────────
  const senderRows = []
  for (const s of SENDERS) {
    const row = await prisma.senderAccount.create({
      data: {
        handle: s.handle,
        displayName: s.displayName,
        personaName: 'Kapil',
        personaRole: 'Partnerships',
        personaBrand: s.displayName,
        personaPhone: '+91 60000 189766',
        personaEmail: 'kapil@digitalsukoon.com',
        cohort: s.cohort,
        status: s.status,
        fleetMember: true,
        dailyCap: 5,
        sessionPath: s.signedIn ? `~/.ds-sales-agent/chrome-profiles/${s.handle}` : null,
        sessionSavedAt: s.signedIn ? daysAgo(9) : null,
        sessionInvalidAt: s.signedIn ? null : hoursAgo(3),
        sessionInvalidReason: s.signedIn ? null : 'a real send found it logged out',
      },
    })
    senderRows.push(row)
    await prisma.messageVariant.create({
      data: {
        senderId: row.id,
        label: 'standard',
        targetKind: 'CHANNEL',
        body: `Hi,We're an Entertainment & Pop Culture Media Network with pages including ${s.displayName}, delivering 300M+ daily views. Happy to share numbers if useful. +916000189766 - Kapil`,
      },
    })
  }

  // ── watched channels ──────────────────────────────────────────────────────
  const watchRows = []
  for (const w of WATCHED) {
    watchRows.push(
      await prisma.targetAccount.create({
        data: {
          handle: w.handle,
          displayName: w.displayName,
          kind: 'CHANNEL',
          role: 'WATCH',
          detectorKey: w.detectorKey,
          watchEnabled: true,
          isVerified: true,
          followerCount: w.followerCount,
        },
      }),
    )
  }

  // ── companies we message ──────────────────────────────────────────────────
  const companies: Array<{ id: string; handle: string }> = []
  for (const [handle, displayName] of NAMED_COMPANIES) {
    const row = await prisma.targetAccount.create({
      data: {
        handle,
        displayName,
        kind: 'BRAND',
        role: 'PROSPECT',
        detectorKey: 'passthrough',
        watchEnabled: false,
        isVerified: true,
        followerCount: Math.floor(40_000 + rand() * 900_000),
      },
    })
    companies.push({ id: row.id, handle })
  }
  const TOTAL_COMPANIES = 477
  for (let i = companies.length; i < TOTAL_COMPANIES; i++) {
    const handle = `${pick(FILLER_PREFIX)}${pick(FILLER_SUFFIX)}${i}`
    const row = await prisma.targetAccount.create({
      data: {
        handle,
        displayName: handle.replace(/\d+$/, '').replace(/^(.)/, (c) => c.toUpperCase()),
        kind: 'BRAND',
        role: 'PROSPECT',
        detectorKey: 'passthrough',
        watchEnabled: false,
        isVerified: true,
        followerCount: Math.floor(5_000 + rand() * 400_000),
      },
    })
    companies.push({ id: row.id, handle })
  }
  console.log(`  ${watchRows.length} watched · ${companies.length} companies`)

  // ── paid posts, across both watched channels ──────────────────────────────
  const campaigns: Array<{ id: string; targetId: string }> = []
  let shortcodeN = 0
  for (const w of watchRows) {
    const total = w.handle === 'viralbhayani' ? 240 : 116
    for (let i = 0; i < total; i++) {
      const paid = rand() < (w.handle === 'madovermarketing_mom' ? 0.42 : 0.2)
      const unjudged = !paid && rand() < 0.12
      const postedAt = hoursAgo(rand() * 24 * 30)
      const code = `DEMO${(shortcodeN++).toString(36).padStart(6, '0')}`
      const row = await prisma.detectedCampaign.create({
        data: {
          targetId: w.id,
          shortcode: code,
          permalink: `https://www.instagram.com/p/${code}/`,
          postedAt,
          detectedAt: new Date(postedAt.getTime() + 9 * 60 * 1000),
          caption: paid ? pick(CAPTIONS_PAID) : pick(CAPTIONS_ORGANIC),
          verdict: unjudged ? 'UNCLASSIFIED' : paid ? 'CAMPAIGN' : 'ORGANIC',
          verdictSource: unjudged ? 'none' : w.detectorKey === 'mom' ? 'rules' : 'semantic',
          confidence: unjudged ? 0 : Math.floor(85 + rand() * 15),
          classifierModel: w.detectorKey === 'mom' ? null : 'deepseek-v4-flash',
          classifierReason: paid ? 'Names a product and a launch date; reads as a placement.' : null,
          brands: paid ? JSON.stringify([pick(NAMED_COMPANIES.map((c) => c[1]))]) : '[]',
          taggedAccounts: paid ? JSON.stringify([pick(NAMED_COMPANIES.map((c) => c[0]))]) : '[]',
        },
      })
      if (!unjudged && paid) campaigns.push({ id: row.id, targetId: w.id })
    }
  }
  console.log(`  ${shortcodeN} posts stored · ${campaigns.length} paid`)

  // ── routes ────────────────────────────────────────────────────────────────
  const pairs: Array<{ id: string; senderId: string; targetId: string }> = []
  for (const s of senderRows) {
    for (const c of companies) {
      const row = await prisma.outreachPair.create({ data: { senderId: s.id, targetId: c.id } })
      pairs.push({ id: row.id, senderId: s.id, targetId: c.id })
    }
  }

  const variantBySender = new Map<string, string>()
  for (const s of senderRows) {
    const v = await prisma.messageVariant.findFirst({ where: { senderId: s.id } })
    if (v) variantBySender.set(s.id, v.id)
  }

  // ── delivered history, replies, and a queue that is waiting ───────────────
  let delivered = 0
  let replied = 0
  const usedTargets = new Set<string>()
  /* Recipients who answered. A draft aimed at one of these is held by the reply halt, which
     is how the resting table below gets rows that a reader can check against the rule. */
  const repliedTargets = new Set<string>()

  /* 184 delivered over a fortnight — the mockup's figure, spread so the 14-day trend and
     the per-sender bars both have a shape rather than a flat line. */
  for (let i = 0; i < 184; i++) {
    const pair = pairs[Math.floor(rand() * pairs.length)]!
    if (usedTargets.has(`${pair.senderId}:${pair.targetId}`)) continue
    usedTargets.add(`${pair.senderId}:${pair.targetId}`)
    const sentAt = hoursAgo(rand() * 24 * 14)
    const didReply = rand() < 0.05
    /*
      WHETHER ANYONE HAS READ THE THREAD, and it has to be seeded or the reply rate is
      nonsense. That rate divides replies by conversations CHECKED, not by messages sent
      (2026-08-21) — so leaving `replyCheckedAt` null on every row made a handful of
      replies divide by a denominator of four and render as 125%. A reply is by definition
      something we read, so a replied row is always checked; the rest are the documented
      partial coverage, which is also what makes the "read as an upper bound" note on
      /analytics fire with something true behind it.
    */
    const wasChecked = didReply || rand() < 0.7
    await prisma.outreachAttempt.create({
      data: {
        pairId: pair.id,
        senderId: pair.senderId,
        targetId: pair.targetId,
        variantId: variantBySender.get(pair.senderId)!,
        campaignId: campaigns.length > 0 ? pick(campaigns).id : null,
        touchNumber: 1,
        renderedBody: 'Hi,We are an Entertainment & Pop Culture Media Network — happy to share numbers. - Kapil',
        status: didReply ? 'REPLIED' : 'SENT',
        sentAt,
        sentBy: `${DEMO}autopilot`,
        threadUrl: `https://www.instagram.com/direct/t/${Math.floor(rand() * 1e15)}`,
        repliedAt: didReply ? new Date(sentAt.getTime() + 3 * 60 * 60 * 1000) : null,
        replyPostedAt: didReply ? new Date(sentAt.getTime() + 3 * 60 * 60 * 1000) : null,
        replyText: didReply ? 'hey thanks for reaching out, can you send more info on the collab?' : null,
        replyCheckedAt: wasChecked ? new Date(sentAt.getTime() + 5 * 60 * 60 * 1000) : null,
      },
    })
    delivered++
    if (didReply) {
      replied++
      repliedTargets.add(pair.targetId)
    }
  }

  /*
    THE QUEUE, IN BOTH OF ITS HALVES — three that can go out, and some that cannot.

    Three sendable drafts alone left the design's RESTING table with no rows at all, because
    that table lists drafts the gate is HOLDING and every demo draft passed. So a few are
    aimed at recipients who replied: the reply halt is target-scoped, so the gate holds them
    by name and the table renders the enforcer's own sentence and release date. Nothing here
    fakes the hold — the rows are ordinary drafts and the real rule refuses them.
  */
  const writeDraft = async (pair: (typeof pairs)[number]) => {
    await prisma.outreachAttempt.create({
      data: {
        pairId: pair.id,
        senderId: pair.senderId,
        targetId: pair.targetId,
        variantId: variantBySender.get(pair.senderId)!,
        campaignId: campaigns.length > 0 ? pick(campaigns).id : null,
        touchNumber: 1,
        renderedBody: 'Hi,We are an Entertainment & Pop Culture Media Network — happy to share numbers. - Kapil',
        status: 'READY',
        queuedAt: hoursAgo(rand() * 3),
        sentBy: null,
      },
    })
  }

  let queued = 0
  let held = 0
  for (const pair of pairs) {
    if (queued >= 3) break
    if (repliedTargets.has(pair.targetId)) continue
    if (usedTargets.has(`${pair.senderId}:${pair.targetId}`)) continue
    usedTargets.add(`${pair.senderId}:${pair.targetId}`)
    await writeDraft(pair)
    queued++
  }
  for (const pair of pairs) {
    if (held >= 4) break
    if (!repliedTargets.has(pair.targetId)) continue
    if (usedTargets.has(`${pair.senderId}:${pair.targetId}`)) continue
    usedTargets.add(`${pair.senderId}:${pair.targetId}`)
    await writeDraft(pair)
    held++
  }

  /*
    ── THE MODEL LEDGER, so /cost has something to draw ──────────────────────
    One `classify` call per judged post plus a `resolve` call for a fraction of the paid
    ones, which is the real shape: classification is one call per post and brand resolution
    only runs when a caption's disclosure needs a name pulled out of it. `generate` is
    written at zero deliberately — it exists in code and is switched off, and the By purpose
    card says so, so a row claiming otherwise would make that card lie.
  */
  const judgedPosts = await prisma.detectedCampaign.findMany({
    where: { verdict: { not: 'UNCLASSIFIED' } },
    select: { shortcode: true, detectedAt: true },
  })
  let calls = 0
  for (const p of judgedPosts) {
    const cached = rand() < 0.94
    await prisma.modelCall.create({
      data: {
        at: p.detectedAt,
        purpose: 'classify',
        model: 'deepseek-v4-flash',
        subject: p.shortcode,
        inputTokens: cached ? 40 : 720,
        cachedInputTokens: cached ? 680 : 0,
        outputTokens: 28,
        costUsd: cached ? 0.0000094 : 0.000108,
        ms: Math.floor(300 + rand() * 900),
        ok: rand() > 0.015,
        error: null,
      },
    })
    calls++
  }
  for (let i = 0; i < Math.floor(judgedPosts.length * 0.16); i++) {
    const p = pick(judgedPosts)
    await prisma.modelCall.create({
      data: {
        at: p.detectedAt,
        purpose: 'resolve',
        model: 'deepseek-v4-flash',
        subject: p.shortcode,
        inputTokens: 210,
        cachedInputTokens: 0,
        outputTokens: 24,
        costUsd: 0.000036,
        ms: Math.floor(400 + rand() * 700),
        ok: true,
      },
    })
    calls++
  }
  console.log(`  ${calls} model calls`)

  // ── settings the pages read ───────────────────────────────────────────────
  /*
    The watch's own health stamps, set FRESH.

    Without these the landing page correctly opens with "Detection has stopped … posts are
    being missed right now", which is the watch-health ladder doing exactly its job about a
    database whose newest stamp is whenever the seed last ran. That alarm is right and it is
    not what this data is for: the point is to see the design at a healthy steady state, so
    the stamps say the watch ran a moment ago — which is true of the pass this script is
    standing in for.
  */
  for (const [key, value] of [
    ['autopilotEnabled', 'true'],
    ['singleTemplate', 'true'],
    ['schedulerHeartbeat', JSON.stringify({ at: now.toISOString(), host: 'dashboard', machine: 'demo' })],
    ['detectFeedOkAt', now.toISOString()],
    ['detectLastOkAt', now.toISOString()],
    ['planLastOkAt', now.toISOString()],
  ] as const) {
    await prisma.setting.upsert({ where: { key }, update: { value }, create: { key, value } })
  }

  console.log(`  ${delivered} delivered · ${replied} replied · ${queued} waiting · ${held} held by a rule`)
  console.log('\ndemo data written. Every attempt is stamped `demo:` and none of it describes a real send.')

  /*
    -- `--beat`: KEEP THE DEMO STAMPS FRESH WHILE SOMEBODY IS LOOKING --------
    The heartbeat goes stale in three minutes, and the moment it does the landing page
    opens with "Detection has stopped -- posts are being missed right now". That alarm is
    CORRECT: no watch process runs on a demo box, and the page saying so is the watch-health
    ladder working. It also means the hero card can never be seen in the state the design
    shows it in.

    So this is opt-in and it runs in the FOREGROUND: the freshness lasts exactly as long as
    somebody holds the window open, and it cannot be left running to quietly keep a dead
    watch green. It writes `machine: 'demo'`, the same word every other row here carries,
    and it touches nothing but these four stamps.
  */
  if (process.argv.includes('--beat')) {
    console.log('')
    console.log('holding the demo stamps fresh - Ctrl-C to stop. Nothing is read from Instagram.')
    for (;;) {
      const at = new Date()
      for (const [key, value] of [
        ['schedulerHeartbeat', JSON.stringify({ at: at.toISOString(), host: 'dashboard', machine: 'demo' })],
        ['detectFeedOkAt', at.toISOString()],
        ['detectLastOkAt', at.toISOString()],
        ['planLastOkAt', at.toISOString()],
      ] as const) {
        await prisma.setting.upsert({ where: { key }, update: { value }, create: { key, value } })
      }
      await new Promise((r) => setTimeout(r, 30_000))
    }
  }
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
