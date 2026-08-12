import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * TWO SCHEMAS, ONE DATA MODEL — and this test is what stops them becoming two data models.
 *
 * Prisma's `provider` must be a literal (it is needed at parse time to validate types), so
 * running SQLite on a laptop and Postgres on the server genuinely requires two schema
 * files. The only question is whether the second is WRITTEN or DERIVED.
 *
 * Written is how this codebase's most repeated bug happens: `gate.ts` (deliverWaiting
 * checked eight conditions, sendNow three), `readThread.ts` (a private copy under a
 * docblock claiming "one implementation, two callers"), the two Connect buttons (one never
 * polled), and the frame check (166 frames saved, none read). Every time, one rule had two
 * copies and a fix landed in one of them.
 *
 * With the DATA MODEL as the subject, that failure is worse than usual: a column added to
 * one schema and not the other is a migration that works on a laptop and fails in
 * production — or succeeds and silently drops a field.
 */

const REPO = process.cwd()
const SQLITE = readFileSync(join(REPO, 'prisma/schema.prisma'), 'utf8')
const POSTGRES = readFileSync(join(REPO, 'prisma/schema.postgres.prisma'), 'utf8')

/**
 * Everything from the FIRST MODEL onward — the data model itself.
 *
 * Sliced at the first `model` rather than at `generator client {`, which is where the
 * first version of this cut and which put the datasource block — the one thing that is
 * SUPPOSED to differ — inside the comparison. It failed on correct code. A test that
 * includes the intended difference in its "must be identical" region is measuring the
 * wrong region, and loosening it to pass would have removed the assertion that matters.
 */
function modelBody(schema: string): string {
  const at = schema.search(/^\/{3}[^\n]*\nmodel |^model /m)
  return at === -1 ? schema : schema.slice(at)
}

describe('the Postgres schema is derived, not maintained', () => {
  it('declares itself generated, so nobody edits it by hand', () => {
    expect(POSTGRES).toMatch(/GENERATED FILE — DO NOT EDIT/)
    expect(POSTGRES).toMatch(/make-postgres-schema\.sh/)
  })

  it('uses the postgresql provider and keeps no sqlite provider', () => {
    expect(POSTGRES).toMatch(/provider = "postgresql"/)
    // The load-bearing negative: if `sed` matched nothing, the file would be a SQLite
    // schema wearing a Postgres filename, and `prisma migrate` would emit SQLite DDL
    // against Postgres. Silent, and catastrophic at exactly the wrong moment.
    expect(POSTGRES).not.toMatch(/provider = "sqlite"/)
    expect(SQLITE).toMatch(/provider = "sqlite"/)
  })

  /**
   * THE ASSERTION THAT MATTERS. Everything from `generator client {` onward — every model,
   * field, index, relation and default — must be byte-identical. A drift here is a data
   * model that differs by host.
   */
  it('has a byte-identical model body', () => {
    const a = modelBody(SQLITE)
    const b = modelBody(POSTGRES)
    // Prove the slice found the models at all — comparing two empty strings would pass
    // vacuously and assert nothing, which is the failure mode of every text-based test.
    expect(a).toMatch(/^\/{3}|^model /)
    expect(a.length).toBeGreaterThan(5000)
    expect(b).toBe(a)
  })

  it('carries every model, counted rather than sampled', () => {
    const models = (s: string) => [...s.matchAll(/^model (\w+)/gm)].map((m) => m[1]!).sort()
    const a = models(SQLITE)
    const b = models(POSTGRES)

    // A regex matching nothing would make this vacuously true, so assert it found something
    // first — the same trap as the action-authorisation test.
    expect(a.length).toBeGreaterThan(15)
    expect(b).toEqual(a)
  })

  /**
   * The JSON-string columns and String unions exist because SQLite has no arrays or enums.
   * On Postgres they would idiomatically be `text[]` and enums — and converting them
   * DURING a host migration means a failure could be either change. `readStringArray` and
   * `readRecord` already isolate the difference. This asserts the temptation was resisted.
   */
  it('did not quietly upgrade the SQLite-shaped columns to Postgres-native ones', () => {
    expect(POSTGRES).not.toMatch(/String\[\]/)
    expect(POSTGRES).not.toMatch(/^enum /m)
    expect(POSTGRES).not.toMatch(/@db\.\w+/)
  })
})
