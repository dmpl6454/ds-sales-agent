import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * `pnpm ig:brands --stuck` — the one-off backfill for handles cached BEFORE the model existed.
 *
 * ── WHY THIS IS TESTED AGAINST A REAL DATABASE ────────────────────────────
 *
 * The whole command is a Prisma `where` clause plus a filter, and the `where` clause is the
 * part that decides what a scarce model call is spent on. A pure test could not see it at all
 * — the same reasoning as `tests/auto-resolve.test.ts`, where a real harness immediately
 * caught `createMany({ skipDuplicates })` being Postgres-only while `pnpm typecheck` was
 * perfectly happy.
 *
 * WHAT IS ACTUALLY ASSERTED is the SELECTION rule, not the printing: which rows the backfill
 * considers stuck. Getting that wrong in the permissive direction re-asks the model the same
 * question about the same evidence on every run (the starvation `autoResolve.ts` warned
 * about); getting it wrong in the strict direction leaves @adidas stuck forever, which is the
 * bug this whole change exists to fix.
 *
 * MEASURED against the live Postgres 2026-08-11: 30 UNRESOLVED rows, all `checkedAt`
 * 2026-08-06, none ever offered to the model. The fixture below is that shape.
 */

const dir = mkdtempSync(join(tmpdir(), 'ds-stuck-'))
const dbPath = join(dir, 'stuck.db')

const bootstrap = new Database(dbPath)
bootstrap.exec(`
  CREATE TABLE "BrandLookup" (
    "handle" TEXT NOT NULL PRIMARY KEY,
    "kind" TEXT NOT NULL,
    "category" TEXT,
    "displayName" TEXT,
    "followers" INTEGER,
    "isVerified" BOOLEAN,
    "enrichment" TEXT,
    "reachable" BOOLEAN,
    "decidedBy" TEXT,
    "modelConfidence" INTEGER,
    "modelReason" TEXT,
    "checkedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`)
bootstrap.close()

process.env.DATABASE_URL = `file:${dbPath}`
process.env.TZ = 'Asia/Kolkata'

const { prisma } = await import('@/lib/db')
const { modelHasRun } = await import('@/detection/resolveBrand')

/**
 * THE QUERY THE COMMAND RUNS, copied deliberately so this test fails if the two disagree.
 *
 * `runStuck` filters in the DATABASE (so the count it prints before spending anything is the
 * real one) and then re-tests each row with `modelHasRun`, which is the rule of record. Two
 * expressions of one rule is exactly the drift this repo has paid for five times, so the
 * agreement between them is asserted rather than assumed.
 *
 * THE `null` BRANCH IS NOT DECORATION. The first version of this was a bare
 * `{ notIn: ['model', 'model-declined'] }`, which selects NOTHING: `NULL NOT IN (...)` is NULL
 * in SQL, so every row with a null `decidedBy` — all 30 of the live backlog — was filtered
 * out, and the command would have reported an all-clear about a queue it never read. The
 * agreement test at the bottom of this file is what caught it.
 */
const STUCK_WHERE = {
  kind: 'UNRESOLVED',
  OR: [{ decidedBy: null }, { decidedBy: { notIn: ['model', 'model-declined'] } }],
}

async function stuckHandles(): Promise<string[]> {
  const rows = await prisma.brandLookup.findMany({ where: STUCK_WHERE, orderBy: { handle: 'asc' } })
  return rows.filter((r) => !modelHasRun(r)).map((r) => r.handle)
}

beforeEach(async () => {
  await prisma.brandLookup.deleteMany({})
})

afterAll(async () => {
  await prisma.$disconnect().catch(() => undefined)
  rmSync(dir, { recursive: true, force: true })
})

describe('which rows the backfill considers stuck', () => {
  it('lists an UNRESOLVED row the model has never been offered — the live backlog shape', async () => {
    // Cached 2026-08-06, days before decideBrand shipped. The founding case.
    await prisma.brandLookup.create({
      data: {
        handle: 'adidas',
        kind: 'UNRESOLVED',
        decidedBy: null,
        enrichment: '30.0M followers · professional account · verified',
        reachable: true,
        checkedAt: new Date('2026-08-06T10:00:00Z'),
      },
    })

    expect(await stuckHandles()).toEqual(['adidas'])
  })

  it('does NOT list a row the model already DECLINED — this is the anti-starvation rule', async () => {
    /**
     * Without this the command re-asks the model the same question about the same evidence
     * every time anyone runs it, which is the objection `autoResolve.ts` raised against the
     * whole approach. `modelReason` cannot carry this fact — a FAILED call writes null there
     * too — which is why `decidedBy` is what is filtered on.
     */
    await prisma.brandLookup.create({
      data: { handle: 'somelocalshop', kind: 'UNRESOLVED', decidedBy: 'model-declined' },
    })

    expect(await stuckHandles()).toEqual([])
  })

  it('does NOT list a row the model DECIDED and left UNRESOLVED', async () => {
    await prisma.brandLookup.create({
      data: { handle: 'obscureshop', kind: 'UNRESOLVED', decidedBy: 'model', modelConfidence: 40 },
    })

    expect(await stuckHandles()).toEqual([])
  })

  it.each([
    ['BRAND', 'endpoint'],
    ['PERSON', 'endpoint'],
    ['MISSING', null],
    ['UNKNOWN', null],
  ])('never lists a %s row — this mode is only for the endpoint blind spot', async (kind, decidedBy) => {
    /**
     * BRAND, PERSON and MISSING are ANSWERS: Instagram's category data is a fact and a
     * judgement does not overrule a fact. UNKNOWN is excluded for the opposite reason — it
     * means the lookup never happened, so it belongs to a fresh `ig:brands` run that will
     * actually ask the endpoint, not to a model that would guess with no profile facts.
     */
    await prisma.brandLookup.create({ data: { handle: 'x.handle', kind, decidedBy } })

    expect(await stuckHandles()).toEqual([])
  })

  it('a FAILED model call leaves the row stuck, so it is retried rather than silenced', async () => {
    /**
     * The direction that keeps "absence of data never hardens into a verdict" true. A network
     * blip or a missing API key writes no `decidedBy`, so the handle is offered again — a real
     * prospect must never be permanently silenced by one bad call.
     */
    await prisma.brandLookup.create({
      data: { handle: 'kfcindia', kind: 'UNRESOLVED', decidedBy: null, modelReason: null },
    })

    expect(await stuckHandles()).toEqual(['kfcindia'])
  })

  it('the DB filter and modelHasRun agree on every value either can see', async () => {
    /**
     * The drift guard. `runStuck` narrows in SQL and then re-tests in JS; if those two ever
     * disagree the command either spends calls it reported it would not, or reports a count it
     * does not act on. Both are the "one rule, two callers" failure this repo names five times.
     */
    for (const decidedBy of [null, 'endpoint', 'human', 'model', 'model-declined']) {
      await prisma.brandLookup.deleteMany({})
      await prisma.brandLookup.create({ data: { handle: 'probe', kind: 'UNRESOLVED', decidedBy } })

      const rows = await prisma.brandLookup.findMany({ where: STUCK_WHERE })
      const passedSql = rows.length === 1
      const passedRule = !modelHasRun({ decidedBy })
      expect(passedSql).toBe(passedRule)
    }
  })
})
