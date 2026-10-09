import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * `whoseTurn` WHEN THE RECIPIENT IS IN NO GROUP — against a real database.
 *
 * ── WHY THIS FILE EXISTS ──────────────────────────────────────────────────
 *
 * `tests/rotation.test.ts` covers `nextSender` thoroughly and in both directions, and it
 * can, because that function is pure: it is handed a ring as a fixture. So the whole suite
 * asserted what rotation DOES with a ring, and nothing at all asserted that anything ever
 * BUILDS one.
 *
 * Nothing did. MEASURED on the live database 2026-08-13: `Category` 0 rows,
 * `CategorySender` 0, `CategoryTarget` 0, and 0 of 72 targets in a group — from the day the
 * table was created. `whoseTurn` returned `null` for every recipient there has ever been,
 * both branches at its one call site read `if (turn && …)`, and the result was that every
 * sender drafted to every recipient: 8 recipients holding a draft from more than one
 * sender, 7 of them from all three, near-identical bodies under one phone number and one
 * email. Every rotation test passed the whole time.
 *
 * That is this codebase's recurring shape — a well-tested consumer and an untested producer
 * — so the producer is driven directly here, against a database, for the same reason
 * `tests/cohorts-live.test.ts` exists: the answer is assembled from Prisma `select`s, where
 * a stale column name fails at RUNTIME while typecheck passes.
 *
 * ── WHAT IS DELIBERATELY *NOT* MOCKED ─────────────────────────────────────
 *
 * `profileStatus`. Rotation must not consult it, and the last test in this file is the
 * assertion of that: availability is built by the CALLER from database facts, because the
 * machine that drafts is the Linode and it has no Chrome profiles at all. A test that
 * mocked the filesystem would quietly permit a future change to start reading it again.
 *
 * DDL is transcribed from `prisma/migrations`, never from a reading of the schema.
 */

const dir = mkdtempSync(join(tmpdir(), 'ds-rotation-fleet-'))
const dbPath = join(dir, 'rotation.db')

const bootstrap = new Database(dbPath)
bootstrap.exec(`
  CREATE TABLE "SenderAccount" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "handle" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "personaName" TEXT NOT NULL,
    "personaRole" TEXT NOT NULL,
    "personaBrand" TEXT NOT NULL,
    "personaPhone" TEXT NOT NULL,
    "personaEmail" TEXT NOT NULL,
    "autoSendEnabled" BOOLEAN NOT NULL DEFAULT false,
    "fleetMember" BOOLEAN NOT NULL DEFAULT true,
    "dailyCap" INTEGER NOT NULL DEFAULT 5,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "challengedAt" DATETIME,
    "cohort" INTEGER NOT NULL DEFAULT 1,
    "sessionPath" TEXT,
    "sessionSavedAt" DATETIME,
    "sessionInvalidAt" DATETIME,
    "sessionInvalidReason" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE UNIQUE INDEX "SenderAccount_handle_key" ON "SenderAccount"("handle");

  CREATE TABLE "TargetAccount" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "handle" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "contactFirstName" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'CHANNEL',
    "role" TEXT NOT NULL DEFAULT 'PROSPECT',
    "detectorKey" TEXT NOT NULL DEFAULT 'passthrough',
    "optedOut" BOOLEAN NOT NULL DEFAULT false,
    "watchEnabled" BOOLEAN NOT NULL DEFAULT true,
    "importNote" TEXT,
    "discoveredFromCampaignId" TEXT,
    "brandCategory" TEXT,
    "isVerified" BOOLEAN,
    "followerCount" INTEGER,
    "campaignTalent" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE UNIQUE INDEX "TargetAccount_handle_key" ON "TargetAccount"("handle");

  CREATE TABLE "OutreachPair" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "senderId" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "cooldownDays" INTEGER NOT NULL DEFAULT 7,
    "maxUnansweredTouches" INTEGER NOT NULL DEFAULT 3,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "bespokeBody" TEXT,
    "bespokeNote" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE UNIQUE INDEX "OutreachPair_senderId_targetId_key"
    ON "OutreachPair"("senderId", "targetId");

  CREATE TABLE "OutreachAttempt" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "pairId" TEXT NOT NULL,
    "senderId" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "campaignId" TEXT,
    "variantId" TEXT NOT NULL,
    "touchNumber" INTEGER NOT NULL,
    "hookLine" TEXT,
    "renderedBody" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "queuedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" DATETIME,
    "sentBy" TEXT,
    "threadUrl" TEXT,
    "error" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "failureCode" TEXT,
    "repliedAt" DATETIME,
    "replyPostedAt" DATETIME,
    "replyText" TEXT,
    "replyCheckedAt" DATETIME,
    "replyHandledAt" DATETIME,
    "replyHandledBy" TEXT
  );

  /* readBlockedRoutes reads the reply halt's scope and window from settings, so a temp
     database without this table throws before any assertion runs. Left EMPTY: every setting
     takes its default, and the default scope is 'pair' — the shipping configuration. */
  CREATE TABLE "Setting" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "value" TEXT NOT NULL,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE "Category" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "note" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE UNIQUE INDEX "Category_slug_key" ON "Category"("slug");

  CREATE TABLE "CategorySender" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "categoryId" TEXT NOT NULL,
    "senderId" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE UNIQUE INDEX "CategorySender_categoryId_senderId_key"
    ON "CategorySender"("categoryId", "senderId");

  CREATE TABLE "CategoryTarget" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "categoryId" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE UNIQUE INDEX "CategoryTarget_categoryId_targetId_key"
    ON "CategoryTarget"("categoryId", "targetId");
`)
bootstrap.close()

process.env.DATABASE_URL = `file:${dbPath}`
process.env.TZ = 'Asia/Kolkata'

const { whoseTurn, describeRing, fleetRingFor } = await import('@/outreach/categories')
const { fleetRingOrder, stableIndex } = await import('@/outreach/rotation')
const { sessionRecorded } = await import('@/outreach/sessionHealth')
const { prisma } = await import('@/lib/db')

const persona = {
  personaName: 'Kapil Jain',
  personaRole: 'Co-founder',
  personaBrand: 'Bollywood Society',
  personaPhone: '+91 60000 189766',
  personaEmail: 'kapil@digitalsukoon.com',
}

const TARGET = 't_brand'

async function addSender(
  handle: string,
  opts: { cohort?: number; fleetMember?: boolean; pairTo?: string } = {},
) {
  const { cohort = 1, fleetMember = true, pairTo = TARGET } = opts
  await prisma.senderAccount.create({
    data: { id: `s_${handle}`, handle, displayName: handle, cohort, fleetMember, ...persona },
  })
  if (pairTo !== '') {
    await prisma.outreachPair.create({
      data: { id: `p_${handle}`, senderId: `s_${handle}`, targetId: pairTo },
    })
  }
}

/** A DELIVERED message — the whole of rotation's stored state. */
async function addDelivered(handle: string, sentAt: Date, status = 'SENT') {
  await prisma.outreachAttempt.create({
    data: {
      id: `a_${handle}_${sentAt.getTime()}`,
      pairId: `p_${handle}`,
      senderId: `s_${handle}`,
      targetId: TARGET,
      variantId: 'v_1',
      touchNumber: 1,
      renderedBody: 'body',
      status,
      sentAt,
    },
  })
}

beforeEach(async () => {
  await prisma.setting.deleteMany()
  await prisma.categoryTarget.deleteMany()
  await prisma.categorySender.deleteMany()
  await prisma.category.deleteMany()
  await prisma.outreachAttempt.deleteMany()
  await prisma.outreachPair.deleteMany()
  await prisma.senderAccount.deleteMany()
  await prisma.targetAccount.deleteMany()
  await prisma.targetAccount.create({
    data: { id: TARGET, handle: 'crocsindia', displayName: 'Crocs India', kind: 'BRAND' },
  })
})

/**
 * ── THE TURN PASSES TO THE NEXT PAGE WHOSE ROUTE IS CLEAR (2026-09-04, Tabish) ──
 *
 * Until now the turn advanced only on a DELIVERY, so a page that COULD not deliver held the
 * recipient: a reply from them halts that page for seven days and the other pages sat idle for
 * the whole of it. MEASURED 2026-09-04: 116 recipients have replied to some page.
 *
 * These drive the REAL `whoseTurn` against a real database, because the fact being asserted is
 * that `readBlockedRoutes` actually queries the reply — a grep proves the name is mentioned,
 * only running it proves it gates.
 *
 * The exposure is stated plainly and is the intended trade, not a side effect: a recipient
 * mid-conversation with page A now hears from page B in the same week. That is the logical
 * content of scoping the reply halt to the PAIR (1 Sept), which this only makes reachable.
 */
describe('a reply halts one page, and the ring moves past it', () => {
  /** A reply on THIS page's pair, written `hoursAgo` ago and not yet handled. */
  async function addReply(handle: string, hoursAgo: number, handled: Date | null = null) {
    await prisma.outreachAttempt.create({
      data: {
        id: `r_${handle}_${hoursAgo}`,
        pairId: `p_${handle}`,
        senderId: `s_${handle}`,
        targetId: TARGET,
        variantId: 'v_1',
        touchNumber: 1,
        renderedBody: 'body',
        status: 'REPLIED',
        sentAt: new Date(Date.now() - (hoursAgo + 1) * 3_600_000),
        replyPostedAt: new Date(Date.now() - hoursAgo * 3_600_000),
        replyHandledAt: handled,
      },
    })
  }

  it('elects the NEXT page when the one whose turn it is has been replied to', async () => {
    await addSender('alpha')
    await addSender('bravo')
    await addSender('charlie')
    /* charlie wrote last, so the walk starts at alpha — and alpha has been replied to. */
    await addDelivered('charlie', new Date(Date.now() - 2 * 3_600_000))
    await addReply('alpha', 2)

    const turn = await whoseTurn({ targetId: TARGET })

    expect(turn.choice.ok).toBe(true)
    if (turn.choice.ok) expect(turn.choice.handle).toBe('bravo')
  })

  it('elects the replied-to page again once the halt has been handled', async () => {
    await addSender('alpha')
    await addSender('bravo')
    await addSender('charlie')
    await addDelivered('charlie', new Date(Date.now() - 2 * 3_600_000))
    await addReply('alpha', 2, new Date())

    const turn = await whoseTurn({ targetId: TARGET })

    expect(turn.choice.ok).toBe(true)
    if (turn.choice.ok) expect(turn.choice.handle).toBe('alpha')
  })

  it('elects the replied-to page again once the window has expired', async () => {
    await addSender('alpha')
    await addSender('bravo')
    await addSender('charlie')
    await addDelivered('charlie', new Date(Date.now() - 200 * 3_600_000))
    /* REPLY_RESUME_HOURS_DEFAULT is 168; 200 hours ago is outside it. */
    await addReply('alpha', 200)

    const turn = await whoseTurn({ targetId: TARGET })

    expect(turn.choice.ok).toBe(true)
    if (turn.choice.ok) expect(turn.choice.handle).toBe('alpha')
  })

  it('holds the WHOLE ring under replyHaltScope=target, where no page is clear', async () => {
    /* The fleet-wide halt is one Setting row, and under it there is no clear page to pass the
       turn to — skipping to another page would be exactly the widening that scope refuses. */
    await prisma.setting.create({ data: { key: 'replyHaltScope', value: 'target' } })
    await addSender('alpha')
    await addSender('bravo')
    await addSender('charlie')
    await addDelivered('charlie', new Date(Date.now() - 2 * 3_600_000))
    await addReply('alpha', 2)

    const turn = await whoseTurn({ targetId: TARGET })

    /* alpha is still elected: rotation does not route around a halt that covers everyone, and
       the GATE is what refuses the send. */
    expect(turn.choice.ok).toBe(true)
    if (turn.choice.ok) expect(turn.choice.handle).toBe('alpha')
  })

  it('refuses with a named reason when EVERY page has been replied to', async () => {
    await addSender('alpha')
    await addSender('bravo')
    await addReply('alpha', 2)
    await addReply('bravo', 3)

    const turn = await whoseTurn({ targetId: TARGET })

    expect(turn.choice.ok).toBe(false)
    if (!turn.choice.ok) {
      expect(turn.choice.reason).toBe('all-unavailable')
      expect(turn.choice.detail).toContain('replied')
    }
  })
})

describe('whoseTurn on the fleet ring — a recipient in no group', () => {
  it('CHOOSES ONE SENDER when all three are able (it used to choose none, so all three wrote)', async () => {
    await addSender('alpha')
    await addSender('bravo')
    await addSender('charlie')

    const turn = await whoseTurn({ targetId: TARGET })

    expect(turn.ring).toBe('fleet')
    expect(turn.categoryId).toBeNull()
    expect(turn.choice.ok).toBe(true)
    // Deterministic: the cohort-then-handle ring, entered at the recipient's stable hash
    // (2026-08-18 — fresh recipients spread across the fleet instead of all electing the
    // ring front). Not "whichever row came back first".
    const sorted = ['alpha', 'bravo', 'charlie']
    expect(turn.choice.ok && turn.choice.handle).toBe(sorted[stableIndex(TARGET, 3)])
  })

  it('never returns null, which is the whole fix — null meant "everybody writes"', async () => {
    await addSender('alpha')
    const turn = await whoseTurn({ targetId: TARGET })
    // Typed non-nullable; asserted at runtime too, because the old call sites were
    // `if (turn && …)` and a null slipping back would silently restore the defect.
    expect(turn).not.toBeNull()
    expect(turn.choice.ok).toBe(true)
  })

  it('PASSES THE TURN ON when the elected sender is unavailable', async () => {
    await addSender('alpha')
    await addSender('bravo')
    await addSender('charlie')

    // Whoever the hash elects for this fresh recipient is marked unavailable, so the walk
    // must continue to the NEXT ring member rather than refuse or restart.
    const sorted = ['alpha', 'bravo', 'charlie']
    const idx = stableIndex(TARGET, 3)
    const turn = await whoseTurn({
      targetId: TARGET,
      unavailable: new Map([[`s_${sorted[idx]}`, 'never signed in']]),
    })

    expect(turn.choice.ok && turn.choice.handle).toBe(sorted[(idx + 1) % 3])
  })

  it('REFUSES with all-unavailable when nobody can write, naming each reason', async () => {
    await addSender('alpha')
    await addSender('bravo')

    const turn = await whoseTurn({
      targetId: TARGET,
      unavailable: new Map([
        ['s_alpha', 'flagged by Instagram'],
        ['s_bravo', 'never signed in'],
      ]),
    })

    expect(turn.choice.ok).toBe(false)
    expect(turn.choice.ok === false && turn.choice.reason).toBe('all-unavailable')
    // The detail is what an operator reads. Both accounts, both reasons.
    expect(turn.choice.ok === false && turn.choice.detail).toContain('alpha: flagged by Instagram')
    expect(turn.choice.ok === false && turn.choice.detail).toContain('bravo: never signed in')
  })

  it('walks on from whoever DELIVERED last, so no recipient hears from one page twice running', async () => {
    await addSender('alpha')
    await addSender('bravo')
    await addSender('charlie')
    await addDelivered('alpha', new Date('2026-08-10T09:00:00Z'))

    const turn = await whoseTurn({ targetId: TARGET })
    expect(turn.choice.ok && turn.choice.handle).toBe('bravo')
  })

  it('a draft that was never DELIVERED does not advance the ring', async () => {
    await addSender('alpha')
    await addSender('bravo')
    await addSender('charlie')

    // The recipient has heard nothing, so the fresh-recipient election stands. A READY
    // draft FROM that very account must not move the turn on — only delivery does.
    const sorted = ['alpha', 'bravo', 'charlie']
    const fresh = sorted[stableIndex(TARGET, 3)]!
    await addDelivered(fresh, new Date('2026-08-10T09:00:00Z'), 'READY')

    const turn = await whoseTurn({ targetId: TARGET })
    expect(turn.choice.ok && turn.choice.handle).toBe(fresh)
  })

  it('a REPLIED message still counts as delivered — a reply must not rewind the ring', async () => {
    await addSender('alpha')
    await addSender('bravo')
    await addDelivered('alpha', new Date('2026-08-10T09:00:00Z'), 'REPLIED')

    const turn = await whoseTurn({ targetId: TARGET })
    expect(turn.choice.ok && turn.choice.handle).toBe('bravo')
  })

  /**
   * BOTH of these insert in the OPPOSITE order to the answer they expect.
   *
   * The first draft did not, and mutation testing caught it: deleting the sort from
   * `fleetRingOrder` entirely left all nineteen tests green, because positions were then
   * assigned in insertion order and insertion order happened to match. `fleetRingFor` runs
   * a `findMany` with no `orderBy`, so without the sort the ring is whatever order the
   * database felt like — a rotation that is deterministic only by luck.
   */
  it('orders by COHORT before handle, so the proven baseline sits at the front of the ring', async () => {
    await addSender('alpha', { cohort: 2 })
    await addSender('zulu', { cohort: 1 })

    // The RING ORDER is asserted directly — the hash start decides where a fresh
    // recipient ENTERS the ring, never how the ring is ordered.
    const ring = await fleetRingFor(TARGET)
    expect(ring.map((m) => m.handle)).toEqual(['zulu', 'alpha'])

    // And the election is the hash start over that sorted ring.
    const turn = await whoseTurn({ targetId: TARGET })
    expect(turn.choice.ok && turn.choice.handle).toBe(['zulu', 'alpha'][stableIndex(TARGET, 2)])
  })

  it('breaks a cohort tie on handle, inserted in the opposite order', async () => {
    await addSender('zulu', { cohort: 1 })
    await addSender('alpha', { cohort: 1 })

    const ring = await fleetRingFor(TARGET)
    expect(ring.map((m) => m.handle)).toEqual(['alpha', 'zulu'])

    const turn = await whoseTurn({ targetId: TARGET })
    expect(turn.choice.ok && turn.choice.handle).toBe(['alpha', 'zulu'][stableIndex(TARGET, 2)])
  })

  it('EXCLUDES a non-fleet sender — the burner has 70 pair rows and must never be elected', async () => {
    await addSender('tabishmukaddam1', { fleetMember: false })
    await addSender('alpha')

    const ring = await fleetRingFor(TARGET)
    expect(ring.map((m) => m.handle)).toEqual(['alpha'])
  })

  it('EXCLUDES a fleet sender with no route to this recipient', async () => {
    await addSender('alpha')
    // Paired to nothing: `routes.ts` refuses some routes outright, and a ring built from
    // "all fleet accounts" would elect this one, skip every real pair, and write nothing.
    await addSender('bravo', { pairTo: '' })

    const ring = await fleetRingFor(TARGET)
    expect(ring.map((m) => m.handle)).toEqual(['alpha'])
  })

  it('refuses with empty-ring rather than choosing anyone when no route exists at all', async () => {
    await addSender('alpha', { pairTo: '' })
    const turn = await whoseTurn({ targetId: TARGET })
    expect(turn.choice.ok).toBe(false)
    expect(turn.choice.ok === false && turn.choice.reason).toBe('empty-ring')
  })

  it('a pre-loaded ring is an optimisation, never a different verdict', async () => {
    await addSender('alpha')
    await addSender('bravo')

    const loaded = await fleetRingFor(TARGET)
    const withRing = await whoseTurn({ targetId: TARGET, fleet: loaded })
    const withoutRing = await whoseTurn({ targetId: TARGET })

    expect(withRing.choice).toEqual(withoutRing.choice)
    expect(withRing.ring).toBe(withoutRing.ring)
  })
})

describe('fleetRingOrder — the pure half, driven with scrambled input', () => {
  it('is a total order independent of the order it was handed', () => {
    const rows = [
      { id: 's_zulu', handle: 'zulu', cohort: 1 },
      { id: 's_alpha', handle: 'alpha', cohort: 2 },
      { id: 's_bravo', handle: 'bravo', cohort: 1 },
    ]
    expect(fleetRingOrder(rows).map((m) => m.handle)).toEqual(['bravo', 'zulu', 'alpha'])
    // Same set, shuffled in: same ring. This is what "deterministic" has to mean when the
    // producer is a findMany with no orderBy.
    expect(fleetRingOrder([...rows].reverse()).map((m) => m.handle)).toEqual(['bravo', 'zulu', 'alpha'])
  })

  it('numbers positions densely from zero, so ringOrder cannot re-sort them apart', () => {
    const ring = fleetRingOrder([
      { id: 's_b', handle: 'bravo', cohort: 1 },
      { id: 's_a', handle: 'alpha', cohort: 1 },
    ])
    expect(ring.map((m) => m.position)).toEqual([0, 1])
    expect(ring.map((m) => m.handle)).toEqual(['alpha', 'bravo'])
  })

  it('marks every member enabled — a pair row IS a live route since 2026-08-08', () => {
    const ring = fleetRingOrder([{ id: 's_a', handle: 'alpha', cohort: 1 }])
    expect(ring[0]!.enabled).toBe(true)
  })
})

describe('whoseTurn on a GROUP ring — unchanged by the fleet fallback', () => {
  async function putInGroup(senderHandles: string[]) {
    await prisma.category.create({ data: { id: 'c_1', name: 'Bollywood', slug: 'bollywood' } })
    await prisma.categoryTarget.create({ data: { id: 'ct_1', categoryId: 'c_1', targetId: TARGET } })
    for (const [i, h] of senderHandles.entries()) {
      await prisma.categorySender.create({
        data: { id: `cs_${h}`, categoryId: 'c_1', senderId: `s_${h}`, position: i },
      })
    }
  }

  it('uses the GROUP order, not the fleet order, and says which ring decided', async () => {
    await addSender('alpha')
    await addSender('bravo')
    await addSender('charlie')
    // Group order deliberately disagrees with alphabetical AT EVERY POSITION, so a fleet
    // fallback leaking in is visible whichever slot the hash start lands on.
    await putInGroup(['charlie', 'alpha', 'bravo'])

    const groupOrder = ['charlie', 'alpha', 'bravo']
    const fleetOrder = ['alpha', 'bravo', 'charlie']
    const idx = stableIndex(TARGET, 3)
    expect(groupOrder[idx], 'the fixture no longer distinguishes the two rings').not.toBe(fleetOrder[idx])

    const turn = await whoseTurn({ targetId: TARGET })
    expect(turn.ring).toBe('group')
    expect(turn.categoryName).toBe('Bollywood')
    expect(turn.choice.ok && turn.choice.handle).toBe(groupOrder[idx])
    expect(describeRing(turn)).toBe('Bollywood')
  })

  it('a sender OUTSIDE the group is not offered a turn, even though it is in the fleet', async () => {
    await addSender('alpha')
    await addSender('bravo')
    await putInGroup(['bravo'])

    const turn = await whoseTurn({ targetId: TARGET })
    expect(turn.choice.ok && turn.choice.handle).toBe('bravo')
  })

  it('a DISABLED membership is skipped — suspended, not removed', async () => {
    await addSender('alpha')
    await addSender('bravo')
    await putInGroup(['alpha', 'bravo'])
    await prisma.categorySender.update({ where: { id: 'cs_alpha' }, data: { enabled: false } })

    const turn = await whoseTurn({ targetId: TARGET })
    expect(turn.choice.ok && turn.choice.handle).toBe('bravo')
  })

  it('an empty group refuses rather than falling back to the fleet', async () => {
    // The fallback is for a target in NO group. A target in an EMPTY group is a
    // configuration someone made, and quietly widening it to the whole fleet would
    // message people from accounts nobody put in that ring.
    await addSender('alpha')
    await putInGroup([])

    const turn = await whoseTurn({ targetId: TARGET })
    expect(turn.ring).toBe('group')
    expect(turn.choice.ok).toBe(false)
    expect(turn.choice.ok === false && turn.choice.reason).toBe('empty-ring')
  })

  it('describeRing names the fleet when no group decided', () => {
    expect(describeRing({ ring: 'fleet', categoryName: null })).toBe('the fleet rotation')
  })
})

describe('availability fed to rotation is machine-independent', () => {
  /**
   * THE REGRESSION THIS GUARDS, measured 2026-08-13.
   *
   * The planner runs on the Linode; that host has no `~/.ds-sales-agent` directory at all,
   * because Chrome profiles live on each operator's own device and the server may never
   * send. So `profileStatus(h).hasSession` — which `sessionUsable` needs — is false for
   * EVERY account on the one machine that drafts. Had the binding rotation been fed that
   * answer, every recipient would have resolved to `all-unavailable` and drafting would
   * have stopped fleet-wide, silently.
   */
  it('sessionRecorded reads the DATABASE, so the server and a laptop agree', () => {
    const signedIn = { sessionPath: 'profiles/alpha', sessionInvalidAt: null }
    const neverSignedIn = { sessionPath: null, sessionInvalidAt: null }
    const provedDead = { sessionPath: 'profiles/charlie', sessionInvalidAt: new Date('2026-08-06T09:58:00Z') }

    expect(sessionRecorded(signedIn)).toBe(true)
    expect(sessionRecorded(neverSignedIn)).toBe(false)
    expect(sessionRecorded(provedDead)).toBe(false)
  })

  /**
   * A SOURCE GREP, because no behavioural test can fail for a line nobody has written yet,
   * and the failure mode is a future edit "restoring" the filesystem check — which would
   * look like a correctness improvement and would stop drafting on the server.
   */
  it('the availability rotation is fed never reads the filesystem', async () => {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync(new URL('../src/outreach/availability.ts', import.meta.url), 'utf8')
    const code = src.slice(src.indexOf('export async function readSenderAvailability'))

    expect(code).toContain('sessionRecorded')
    expect(code).not.toContain('profileStatus')
    expect(code).not.toContain('hasSessionOnDisk')
    expect(code).not.toContain('sessionUsable')
  })

  /**
   * THE BURNER HAS 70 LIVE PAIR ROWS, AND TWO INDEPENDENT THINGS KEEP IT OUT.
   *
   * MEASURED 2026-08-13: `@tabishmukaddam1` is `fleetMember: false` and has 70 `OutreachPair`
   * rows — and since 2026-08-08 a pair row IS a live route. It is inert because `runOutreach`
   * scopes its query to fleet members and `fleetRingFor` scopes the ring the same way. Both
   * are one word each, and losing either would put the rehearsal account into automatic
   * outreach to 70 real companies.
   *
   * The rows themselves are deliberately NOT deleted here. `OutreachAttempt.pairId` is
   * `ON DELETE CASCADE`, so removing a pair removes the record of every message that pair
   * ever sent — and that record is what spacing, the unanswered-touch cap and the
   * new-material rule are derived from. 0 of the 70 carry attempts today, so a delete would
   * be safe today; a delete PATH that can reach a pair with history would not be.
   */
  it('the planner scopes its pairs to the fleet — the burner has 70 live routes', async () => {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync(new URL('../src/outreach/plan.ts', import.meta.url), 'utf8')
    const query = src.slice(src.indexOf('const pairs = await prisma.outreachPair.findMany('))
    expect(query.slice(0, 200)).toContain('fleetMember: true')
  })

  it('every caller of rotation asks that ONE reader, so a page cannot disagree with the planner', async () => {
    const { readFileSync } = await import('node:fs')
    // messages-page.ts left this list on 2026-08-18: the cap restructure removed its
    // rotation preview entirely, so it no longer consumes availability at all.
    const callers = [
      '../src/outreach/plan.ts',
      '../src/scripts/dedupe-drafts.ts',
      '../src/app/view-model/prospects-page.ts',
    ]
    for (const rel of callers) {
      const src = readFileSync(new URL(rel, import.meta.url), 'utf8')
      expect(src, `${rel} must build rotation availability from the shared reader`).toContain(
        'readSenderAvailability',
      )
      // None of them may hand-roll the map — that is how `gate.ts` drifted twice.
      expect(src, `${rel} must not rebuild the availability map inline`).not.toContain(
        "unavailable.set(s.id, 'never signed in')",
      )
    }
  })
})

/**
 * ── THE GROUP RING, WHICH THE MARKETING FLEET ACTUALLY USES ──────────────────
 *
 * A recipient carrying a `CategoryTarget` row rotates through that CATEGORY's ring
 * (`ringFor`), not the fleet ring — so every one of the 145 live marketing prospects takes
 * this path. `fleetRingFor` has filtered on `fleetMember` since it was written and `ringFor`
 * never did, and the difference was invisible while the only `CategorySender` row belonged to
 * an account in the rotation. The 2026-09-04 migration takes that ring from one page to five.
 */
describe('whoseTurn on a group ring', () => {
  async function addToCategory(handle: string, categoryId: string, position: number) {
    await prisma.categorySender.create({
      data: { categoryId, senderId: `s_${handle}`, position, enabled: true },
    })
  }

  async function marketingCategory() {
    const c = await prisma.category.create({
      data: { id: 'c_marketing', slug: 'marketing', name: 'Marketing & advertising trade' },
    })
    await prisma.categoryTarget.create({ data: { categoryId: c.id, targetId: TARGET, enabled: true } })
    return c
  }

  it('rotates through the CATEGORY ring, not the fleet ring', async () => {
    const c = await marketingCategory()
    await addSender('alpha')
    await addSender('bravo')
    await addToCategory('alpha', c.id, 0)
    await addToCategory('bravo', c.id, 1)
    await addDelivered('alpha', new Date(Date.now() - 3_600_000))

    const turn = await whoseTurn({ targetId: TARGET })

    expect(turn.ring).toBe('group')
    expect(turn.choice.ok).toBe(true)
    if (turn.choice.ok) expect(turn.choice.handle).toBe('bravo')
  })

  it('NEVER elects a page outside the rotation, even with a live membership row', async () => {
    /* `removeSender` writes `fleetMember: false` and does NOT disable the membership, so a
       retired page keeps its `CategorySender` row. Electing it would stall the recipient
       forever: the turn only advances on a delivery it can never make. That is the 26 August
       self-locking stall, and this is the assertion that makes the filter real rather than a
       line nothing can fail for. */
    const c = await marketingCategory()
    await addSender('retired', { fleetMember: false })
    await addSender('bravo')
    await addToCategory('retired', c.id, 0)
    await addToCategory('bravo', c.id, 1)

    const turn = await whoseTurn({ targetId: TARGET })

    expect(turn.choice.ok).toBe(true)
    if (turn.choice.ok) expect(turn.choice.handle).toBe('bravo')
  })

  it('answers empty-ring when every member of the group has left the rotation', async () => {
    const c = await marketingCategory()
    await addSender('retired', { fleetMember: false })
    await addToCategory('retired', c.id, 0)

    const turn = await whoseTurn({ targetId: TARGET })

    expect(turn.choice.ok).toBe(false)
    if (!turn.choice.ok) expect(turn.choice.reason).toBe('empty-ring')
  })
})

/**
 * ── THE PLANNER'S RING WAS UNFILTERED, AND `unreadable` BLOCKED A ROUTE (2026-10-09) ──
 *
 * The 9 October audit found two ways rotation could still elect a page the enforcers refuse,
 * and both are the self-locking stall: the turn only advances on a DELIVERY, so an elected page
 * that can never deliver holds the recipient forever.
 *
 *  1. `plan.ts` built its pre-loaded ring from raw pair rows and `whoseTurn` uses a pre-loaded
 *     ring verbatim. Only `fleetRingFor`, `whoseTurnForMany` and the hand-off applied the
 *     26 August fleet filter. The old parity test here passed `fleetRingFor`'s ring — already
 *     filtered — so it could never see the difference.
 *  2. `readBlockedRoutes` counted an `unreadable` park as a blocked route, while the gate and
 *     the governor both ignore it (it is a READ that could not vouch for a thread, not a send).
 */
describe('rotation never elects a page the enforcers refuse', () => {
  async function marketingPage(handle: string) {
    await prisma.category.upsert({
      where: { slug: 'marketing' },
      update: {},
      create: { id: 'c_mkt', name: 'Marketing', slug: 'marketing' },
    })
    await prisma.categorySender.create({
      data: { id: `cs_${handle}`, categoryId: 'c_mkt', senderId: `s_${handle}`, position: 0 },
    })
  }

  it('a page of the OTHER fleet that still holds a pair row is not in the ring', async () => {
    // Every rotation start position must be tried, so the test cannot pass by the hash
    // happening to start somewhere else: one page of each kind, the marketing page first
    // alphabetically, so an unfiltered ring would put it at the front.
    await addSender('aaa_marketing')
    await addSender('bravo')
    await marketingPage('aaa_marketing')

    const ring = await fleetRingFor(TARGET)
    expect(ring.map((r) => r.handle)).toEqual(['bravo'])

    const turn = await whoseTurn({ targetId: TARGET })
    expect(turn.choice.ok && turn.choice.handle).toBe('bravo')
  })

  it('every builder of a fleet ring outside rotation.ts passes it through ringMembersFor', async () => {
    // A SOURCE CHECK, because the failure mode is a ring builder nobody has written yet — the
    // planner's was exactly that. It asserts the call shape, not a mention: the argument of every
    // `fleetRingOrder(` must open with `ringMembersFor(`.
    const { readFileSync, readdirSync, statSync } = await import('node:fs')
    const { join: j } = await import('node:path')
    const walk = (d: string): string[] =>
      readdirSync(d).flatMap((n) => {
        const p = j(d, n)
        return statSync(p).isDirectory() ? (n === 'generated' ? [] : walk(p)) : /\.tsx?$/.test(n) ? [p] : []
      })
    const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    const calls: string[] = []
    for (const file of walk(join(process.cwd(), 'src'))) {
      if (file.endsWith('outreach/rotation.ts')) continue
      const src = strip(readFileSync(file, 'utf8'))
      for (const m of src.matchAll(/fleetRingOrder\(\s*([\s\S]{0,40})/g)) calls.push(`${file}: ${m[1]}`)
    }
    expect(calls.length, 'found no ring builders at all — the walk is broken').toBeGreaterThanOrEqual(4)
    for (const c of calls) expect(c, `unfiltered fleet ring: ${c}`).toMatch(/:\s*ringMembersFor\(/)
  })

  it('an unreadable park does not take a page out of the ring; a failed send still does', async () => {
    await addSender('alpha')
    await addSender('bravo')
    const park = (handle: string, failureCode: string) =>
      prisma.outreachAttempt.create({
        data: {
          id: `a_park_${handle}`,
          pairId: `p_${handle}`,
          senderId: `s_${handle}`,
          targetId: TARGET,
          variantId: 'v_1',
          touchNumber: 2,
          renderedBody: 'body',
          status: 'FAILED',
          failureCode,
        },
      })

    // Both pages carry an `unreadable` park: the enforcers would let either write, so rotation
    // must still elect one rather than answering all-unavailable.
    await park('alpha', 'unreadable')
    await park('bravo', 'unreadable')
    const clear = await whoseTurn({ targetId: TARGET })
    expect(clear.choice.ok).toBe(true)

    // A real parked SEND (not-in-thread) on one page still routes around it.
    await prisma.outreachAttempt.update({ where: { id: 'a_park_alpha' }, data: { failureCode: 'not-in-thread' } })
    const around = await whoseTurn({ targetId: TARGET })
    expect(around.choice.ok && around.choice.handle).toBe('bravo')
  })
})
