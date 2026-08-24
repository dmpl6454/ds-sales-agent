import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { MAX_DELIVERY_ATTEMPTS } from '@/lib/constants'
import { RESEND_BLOCKS } from '@/outreach/gate'
import { remedyFor } from '@/app/messages/remedy'

/**
 * ONLY FAILURES THE RETRY CAP GAVE UP ON REACH THE SCREEN (2026-08-24, Tabish).
 *
 * *"the 'Check Conversation' section must not exist, only failures after '3' attempts must be
 * displayed. Certain ones have '0' attempts and have been displayed in the UI. Remove this."*
 *
 * Two halves, and each fails a different way if it drifts back:
 *
 *   the CAP     — the list must select on the constant the ENFORCER parks on, never on a
 *                 literal 3. MEASURED before the change: 3 of the 18 live FAILED rows carried
 *                 `attempts: 0`, because a zombie SENDING row parked by hand never runs the
 *                 counter — so a section headed "gave up after repeated failures" was showing
 *                 drafts that had not failed once.
 *   the SECTION — the "Check the conversation" list is gone, and so is everything that pointed
 *                 at it: the ranked blocker, the nav badge, the remedy's href.
 *
 * A SOURCE GREP for most of it, deliberately. The failure mode is a query or a caller somebody
 * writes later, and no behavioural test can fail for a component nobody has re-added — the same
 * reasoning as `tests/naming-linkage.test.ts` and `tests/pool-bounds.test.ts`.
 *
 * ── AND IT MAY NOT IMPORT `deliver.ts`, WHICH THE FIRST VERSION DID ────────
 *
 * Importing the enforcer to read its number CONSTRUCTS a Prisma client at module load
 * (`deliver.ts` → `db.ts`), so a test about which number the screen shows opened a database
 * connection to ask — and failed outright on a machine whose client is baked for the server's
 * Postgres. That is `tests/pool-bounds.test.ts`'s lesson exactly: a value you want to READ must
 * cost nothing to read. Hence the constant lives in the leaf module and the agreement between
 * the two modules is asserted as a grep over `deliver.ts`'s source instead.
 */

const repo = join(__dirname, '..')
const read = (p: string) => readFileSync(join(repo, p), 'utf8')

/**
 * The parked query itself, isolated from the prose around it.
 *
 * Anchored on the CODE (`status: 'FAILED',` inside a where clause), not on a phrase — the first
 * version anchored on `failureCode: { not: 'not-in-thread' }` and matched the DOCBLOCK that
 * explains the query, several hundred characters above it, so the assertions ran against a
 * comment. A grep that matches the explanation instead of the code passes for the wrong reason.
 */
function parkedQuery(): string {
  const src = read('src/app/view-model/messages-page.ts')
  const i = src.indexOf("status: 'FAILED',")
  expect(i, 'the parked query must still select FAILED rows').toBeGreaterThan(-1)
  const q = src.slice(i, i + 300)
  expect(q, 'and must still exclude the may-have-arrived class').toMatch(/failureCode: \{ not: 'not-in-thread' \}/)
  return q
}

describe('the failures list shows only what the retry cap gave up on', () => {
  it('is the same number the enforcer parks on, and the enforcer keeps no second copy', () => {
    expect(MAX_DELIVERY_ATTEMPTS).toBeGreaterThan(1)

    const deliver = read('src/outreach/deliver.ts')
    // It takes the value from the leaf module...
    expect(deliver).toMatch(/import \{ MAX_DELIVERY_ATTEMPTS \} from '@\/lib\/constants'/)
    // ...and does not define one of its own, which is how two numbers start disagreeing.
    expect(deliver).not.toMatch(/const MAX_DELIVERY_ATTEMPTS\s*=/)
    // The park is still measured against it rather than against a literal.
    expect(deliver).toMatch(/totalAttempts >= MAX_DELIVERY_ATTEMPTS/)
  })

  it('selects on the constant, not on a literal', () => {
    const q = parkedQuery()
    expect(q).toMatch(/attempts:\s*\{\s*gte:\s*MAX_DELIVERY_ATTEMPTS\s*\}/)
    expect(q).not.toMatch(/attempts:\s*\{\s*gte:\s*\d+\s*\}/)
  })

  it('imports that constant from the leaf module, so reading it costs no browser stack', () => {
    const src = read('src/app/view-model/messages-page.ts')
    expect(src).toMatch(/import \{[^}]*MAX_DELIVERY_ATTEMPTS[^}]*\} from '@\/lib\/constants'/)
    expect(src).not.toMatch(/MAX_DELIVERY_ATTEMPTS[^\n]*from '@\/outreach\/deliver'/)
  })

  it('no longer selects the may-have-arrived class for display anywhere in the app', () => {
    // `failureCode: 'not-in-thread'` (equality) is the removed list's query. The parked query
    // uses `{ not: ... }`, which this pattern deliberately does not match.
    const files: string[] = []
    const walk = (dir: string) => {
      for (const e of readdirSync(join(repo, dir), { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name.startsWith('.')) continue
        const rel = `${dir}/${e.name}`
        if (e.isDirectory()) walk(rel)
        else if (/\.tsx?$/.test(e.name)) files.push(rel)
      }
    }
    walk('src/app')
    const offenders = files.filter((f) => /failureCode:\s*'not-in-thread'/.test(read(f)))
    expect(offenders, 'a display query on not-in-thread is the removed section coming back').toEqual([])
  })

  it('the component, the blocker and the nav badge are all gone together', () => {
    expect(existsSync(join(repo, 'src/app/messages/uncertain.tsx'))).toBe(false)

    const page = read('src/app/page.tsx')
    expect(page).not.toMatch(/UncertainList/)
    expect(page).not.toMatch(/uncertain:\s*m\.uncertain/)

    const blockers = read('src/app/view-model/blockers.ts')
    expect(blockers).not.toMatch(/key: 'uncertain'/)
    expect(blockers).not.toMatch(/^\s*uncertain: number/m)

    const nav = read('src/app/nav.tsx')
    expect(nav).not.toMatch(/repliesToHandle \+ uncertain/)
  })

  it('the stop that survives no longer names a screen that cannot answer it', () => {
    // The rule is unchanged and still refuses; only its REMEDY changed, because the control
    // it used to name does not exist. `href: null` is a real answer here, as it is for
    // MATERIAL_EXHAUSTED — "there is nothing to press" beats pointing at an empty page.
    const remedy = remedyFor(RESEND_BLOCKS.UNCERTAIN_DELIVERY)
    expect(remedy?.href ?? null).toBeNull()
    expect(remedy?.label ?? '').not.toMatch(/check the conversation/i)

    // And the capped-failure stop still points at a list that genuinely has rows in it.
    expect(remedyFor(RESEND_BLOCKS.PARKED_FAILURE)?.href).toBe('/')
  })
})
