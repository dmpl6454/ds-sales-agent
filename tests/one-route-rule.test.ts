import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * THERE IS ONE RULE FOR WHICH ROUTES MAY EXIST, AND THIS TEST IS WHAT KEEPS IT THAT WAY.
 *
 * Modelled on `tests/one-judging-path.test.ts`, for the same reason and against the same
 * failure. This codebase has now had one rule with several callers drift FIVE times:
 *
 *   - `gate.ts`        — deliverWaiting re-checked eight conditions, sendNow three; the five
 *                        missing included `optedOut` and "they replied".
 *   - `readThread.ts`  — the CLI kept a private copy while the docblock claimed "one
 *                        implementation, two callers".
 *   - the Connect buttons — one never polled, so a real login went unrecorded.
 *   - `judge.ts`       — 166 frames saved in a day and none read on the automatic path.
 *   - **route creation** — MEASURED 2026-08-08: `ensureFleetPairs` excluded our own pages
 *                        and the OTHER FIVE creators did not. `addTarget('bollywoodsocietyy')`
 *                        created two live routes from one revenue page to another.
 *
 * A comment has already proved insufficient — one saying "one implementation, two callers"
 * was literally present and untrue in the readThread case. So the constraint is asserted.
 *
 * WHY A SOURCE GREP. The rule is a filter applied before a write, so there is no runtime
 * seam a mock could sit in: a NEW call site would simply not call it, and no behavioural
 * test can fail for code nobody wrote yet. Reading the source is the only check that fails
 * on ADDITION rather than on modification — which is the failure mode all five above share.
 */

const ROOT = process.cwd()

/**
 * Where a pair row may be created, and why each is allowed.
 *
 * EXPLICIT, so a NEW hand-rolled call site fails this test rather than joining a pattern.
 * Anything listed here must either apply `routeAllowed`/`mayRouteExist`, or be justified
 * below as a path the rule does not govern.
 */
const PERMITTED = {
  /** The blessed place. Creates every route the fleet is allowed to have. */
  'src/outreach/plan.ts': 'uses-the-rule',
  /** Creates routes for one new channel, across every account we own. */
  'src/app/actions.ts': 'uses-the-rule',
  /**
   * A discovered brand becomes a prospect — the ONE creator, shared by the `ig:brands` CLI
   * and by the automatic post-detection resolver (`src/detection/autoResolve.ts`).
   *
   * `src/scripts/brands.ts` used to be listed here and creates no pair rows any longer: it
   * calls `createBrandTarget`. That is the direction this test wants — one creator rather
   * than two copies of the same filter — and it is why the check below is "every governed
   * creator applies the rule" rather than "every file that mentions brands does".
   */
  'src/outreach/brandTarget.ts': 'uses-the-rule',
  /** A pasted sheet becomes prospects. */
  'src/outreach/importProspects.ts': 'uses-the-rule',
  /**
   * ON-DEMAND IS EXEMPT, DELIBERATELY, AND THE REASONING IS NARROW.
   *
   * `prepareOnDemand` creates ONE pair for a sender and target A PERSON CHOSE, both ends,
   * from a dialog that then names every rule the send would cross before anything is
   * delivered. It is not a route the scheduler discovered — the exposure the shared rule
   * governs is UNATTENDED routes appearing without anyone choosing them.
   *
   * It also keeps the self-pair refusal itself (`sender.handle === target.handle` → no pair),
   * which is the one exclusion that is about the send path failing rather than about who we
   * message: Instagram's "message yourself" thread is a different surface.
   *
   * And it must stay exempt for a REACHABILITY reason: rehearsal sending to an account we
   * own — the burner, or society/chronicle — is how every end-to-end send in this project
   * was proven, and `mayRouteExist` refuses precisely those. Routing it through the rule
   * would delete the safest test available. A person picking both ends is the difference.
   */
  'src/outreach/onDemand.ts': 'human-chose-both-ends',
  /**
   * SEED, dev-only. `ROUTING` is a hardcoded table of three senders to three channels and
   * was CHECKED against the rule: no self-pairs, and no fleet page as a target (its targets
   * are `madovermarketing_mom`, `viralbhayani` and the burner `priyanshu123321123`). It
   * would violate the rule the day somebody adds society or chronicle to another sender's
   * list, which is why it is named here rather than skipped by a glob.
   */
  'prisma/seed.ts': 'dev-seed-checked-by-hand',
} as const

/** Every .ts file under src/ and prisma/, excluding the generated client. */
function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      if (entry === 'generated' || entry === 'node_modules') continue
      sourceFiles(full, acc)
      continue
    }
    if (entry.endsWith('.ts') || entry.endsWith('.tsx')) acc.push(full)
  }
  return acc
}

const files = [...sourceFiles(join(ROOT, 'src')), ...sourceFiles(join(ROOT, 'prisma'))]

/** Anything that writes an OutreachPair row. */
const CREATES_PAIR = /prisma\.outreachPair\.(createMany|create|upsert)\s*\(/

describe('one route rule', () => {
  it('no file creates a pair row unless it is a permitted creator', () => {
    const creators = files
      .filter((f) => CREATES_PAIR.test(readFileSync(f, 'utf8')))
      .map((f) => f.slice(ROOT.length + 1))
      .sort()

    const unexpected = creators.filter((f) => !(f in PERMITTED))

    expect(
      unexpected,
      `These files create OutreachPair rows and are not permitted creators. A pair row IS a ` +
        `live route since nothing reads \`enabled\` — so a new creator must either filter ` +
        `through \`routeAllowed\` from src/outreach/routes.ts and be added to PERMITTED, or ` +
        `not create pairs at all. Five paths already drifted this way once.`,
    ).toEqual([])
  })

  it('every creator that the rule governs actually applies it', () => {
    const governed = Object.entries(PERMITTED)
      .filter(([, why]) => why === 'uses-the-rule')
      .map(([file]) => file)

    // Sanity: the list is not silently empty, which would make this test vacuous.
    expect(governed.length).toBeGreaterThanOrEqual(4)

    for (const file of governed) {
      const source = readFileSync(join(ROOT, file), 'utf8')
      expect(
        /routeAllowed|mayRouteExist/.test(source),
        `${file} creates pair rows without asking routes.ts whether the route may exist — ` +
          `that is the fifth diverging copy this test exists to prevent`,
      ).toBe(true)
    }
  })

  /**
   * The rule must stay in ONE file. A caller re-deriving `handle !== handle` or its own set
   * of our own handles is the drift itself, wearing the costume of a local check.
   */
  it('no creator re-implements the exclusions inline', () => {
    for (const file of Object.keys(PERMITTED)) {
      if (PERMITTED[file as keyof typeof PERMITTED] !== 'uses-the-rule') continue
      const source = readFileSync(join(ROOT, file), 'utf8')

      /**
       * The exact shape that was wrong in all five: filtering a sender/target list on
       * handle inequality alone, which excludes the self-pair and permits our own pages.
       */
      const inlineSelfPairFilter = /\.filter\(\s*\((?:s|t)\)\s*=>\s*(?:s|t)\.handle\s*!==\s*/
      expect(
        inlineSelfPairFilter.test(source),
        `${file} filters routes on handle inequality inline. That is the exclusion that was ` +
          `copied five times and applied fully in only one of them — ask routes.ts instead.`,
      ).toBe(false)
    }
  })

  /** `routes.ts` is pure: it must not reach for the database itself. */
  it('the rule module imports no database client', () => {
    const source = readFileSync(join(ROOT, 'src/outreach/routes.ts'), 'utf8')
    expect(source).not.toMatch(/from '@\/lib\/db'/)
    expect(source).not.toMatch(/@prisma\/client/)
  })
})
