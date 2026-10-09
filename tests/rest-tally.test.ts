import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { SKIP_REASONS } from '@/outreach/governor'

/**
 * "N OF M COMPANIES ARE RESTING" MUST BE READABLE, AND EVERY ROW MUST HAVE A SENTENCE.
 *
 * Tabish, 2026-08-24: *"currently a user does not know how many targets are on hold from total
 * (which would keep on increasing and changing)."* MEASURED when the figure first existed:
 * 469 of 473.
 *
 * Three properties, and each fails a different way if it drifts:
 *
 *   TOTALITY   every reason `buildRestTally` can bump must have a sentence in `REST_RULES`.
 *              A missing one renders a bucket with an empty explanation on a page a CEO
 *              reads — the same failure `STOP_LABELS` being total over `RESEND_BLOCKS`
 *              exists to prevent, and the reason this test is shaped like that one.
 *   ARITHMETIC `byReason` must sum to `resting`, and `resting + clear` must equal `total`.
 *              Attribution is first-rule-wins in the governor's order precisely so those
 *              hold; the moment a company is counted under two rules the breakdown sums to
 *              more than the headline and the panel becomes unreadable.
 *   HONESTY    the DATE BOUND must reach the enforcer. `campaignsNamingHandleRows` tests
 *              NAMING in JS and takes `postedAt` only in its `where` clause, so a stub that
 *              ignored `args` would over-count every caller passing a narrower floor — and
 *              two different floors are in play (the 7-day allowance window, and
 *              `newMaterialFloor` at 72h for NO_NEW_MATERIAL).
 *
 * The first and third are SOURCE checks, because the failure mode is a line somebody writes
 * later — a new bump with no sentence, or a stub "simplified" to return everything — and no
 * behavioural test can fail for code that is not there yet. The arithmetic is asserted against
 * the real builder's shape via its exported types plus a source check that the totals are
 * derived from `byReason` rather than counted a second way.
 */

const repo = join(__dirname, '..')
const src = readFileSync(join(repo, 'src/app/view-model/rest-tally.ts'), 'utf8')

/**
 * The DECISION LOOP only — not the whole file.
 *
 * Scoping matters: `SKIP_REASONS.MATERIAL_EXHAUSTED` also appears in the `REST_RULES` table, so
 * a search over the file would find the sentence and conclude the rule is applied. What decides
 * a company's bucket is this loop, and it is the loop the order assertions have to read.
 */
const loop = src.slice(src.indexOf('for (const p of prospects)'), src.indexOf('/* The last rule'))

/**
 * Every reason key bumped inside the loop, whatever form the argument takes.
 *
 * It reads the FIRST ARGUMENT of each `bump(` — parsed to the comma at paren depth 0 — rather
 * than scanning a fixed window, because a window picks up ordinary prose: the first version
 * matched a capitalised word out of a nearby comment and failed on `bump(ALREA)`. A ternary is
 * still handled, since both branches sit inside that first argument.
 */
function bumpedKeys(): string[] {
  const keys: string[] = []
  for (const m of loop.matchAll(/bump\(/g)) {
    let depth = 1
    let i = m.index! + 'bump('.length
    const start = i
    for (; i < loop.length && depth > 0; i += 1) {
      const c = loop[i]
      if (c === '(') depth += 1
      else if (c === ')') depth -= 1
      else if (c === ',' && depth === 1) break
    }
    const arg = loop.slice(start, i)
    for (const k of arg.matchAll(/SKIP_REASONS\.[A-Z_]+|\b[A-Z][A-Z0-9_]*\b/g)) keys.push(k[0])
  }
  return keys
}

describe('the resting tally', () => {
  it('has a sentence for every reason it can report', () => {
    /**
     * EVERY `bump()` key, whatever kind of identifier it is.
     *
     * The first version matched `bump(SKIP_REASONS.X)` only, so a bucket keyed on a
     * module-level const — `ROTATION_STUCK`, `AWAITING_FIRST_POST` — could be added with no
     * sentence and this test would pass. That is the totality check failing at exactly the
     * thing it exists to catch, so it reads any identifier now.
     */
    const bumped = bumpedKeys()
    expect(bumped.length, 'no bump() call sites found — the grep has gone stale').toBeGreaterThan(3)

    const table = src.slice(src.indexOf('const REST_RULES'), src.indexOf('/** One rule, how many'))
    for (const key of new Set(bumped)) {
      expect(
        table,
        `bump(${key}) has no entry in REST_RULES — that bucket would render with an empty explanation`,
      ).toContain(key)
    }
    // And the two const-keyed buckets specifically, because they are the ones a SKIP_REASONS-only
    // grep used to miss entirely.
    for (const key of ['ROTATION_STUCK', 'AWAITING_FIRST_POST']) {
      expect(bumped, `${key} must still be one of the reasons this can report`).toContain(key)
    }
  })

  it('splits the material rule on whether a paid post has ever been FOUND', () => {
    /**
     * Both halves are MATERIAL_EXHAUSTED at the governor and they are opposite facts to read.
     * MEASURED when Tabish said the old sentence made no sense: of 423 companies the rule was
     * holding, 208 (49%) had ZERO paid posts naming them — so "every paid post we have seen from
     * them has already been written about" was false for half the row, and "their next one" was
     * waiting on something that had never happened once.
     */
    expect(src).toMatch(/camps\.length === 0 \? AWAITING_FIRST_POST : SKIP_REASONS\.MATERIAL_EXHAUSTED/)
    const table = src.slice(src.indexOf('const REST_RULES'), src.indexOf('/** One rule, how many'))
    // Neither sentence may claim a paid post exists for the half where none does.
    expect(table).not.toMatch(/every paid post we have seen from them/)
  })

  /**
   * A page paused because they replied to it is one of the causes of a stuck ring (audit H9) —
   * the sentence used to name signed out, flagged and parked only, so a mixed ring read as a
   * sign-in fault. A ring paused by replies ALONE is counted as replied, with its release
   * (tests/reply-halt-live.test.ts drives that against a real database).
   */
  it('the stuck-ring sentence names a reply among its causes', () => {
    const table = src.slice(src.indexOf('const REST_RULES'), src.indexOf('/** One rule, how many'))
    const stuck = table.slice(table.indexOf('[ROTATION_STUCK]'), table.indexOf('[NO_PAGE_FOR_FLEET]'))
    /* The LABEL string itself, not the docblock above it — a comment saying so is not a sentence on screen. */
    expect(stuck).toMatch(/label:\s*'[^']*paused because they replied to it'/)
  })

  it('every reason it reports is a real governor reason, not an invented one', () => {
    const known = Object.keys(SKIP_REASONS)
    for (const key of new Set(bumpedKeys())) {
      if (!key.startsWith('SKIP_REASONS.')) continue
      const name = key.slice('SKIP_REASONS.'.length)
      expect(known, `SKIP_REASONS.${name} does not exist`).toContain(name)
    }
  })

  it('derives the totals from the breakdown, so they cannot disagree with it', () => {
    // `resting` must be the SUM of the rows shown, never a second count of its own: a headline
    // counted separately from the list under it is how "40 of 40" agreed with a truncation.
    expect(src).toMatch(/const resting = byReason\.reduce\(/)
    expect(src).toMatch(/needingAPerson: byReason\.filter\(/)
  })

  it('passes the date floor through to the enforcer instead of ignoring it', () => {
    // The stub stands in for Prisma. If it ignores `args`, every caller with a narrower floor
    // silently gets the widest window — and the JS predicate does not re-check dates.
    const stub = src.slice(src.indexOf('const preloaded'), src.indexOf('const lastBySenderPerTarget'))
    expect(stub).toMatch(/args\?\.where\?\.postedAt\?\.gte/)
    expect(stub).toMatch(/posts\.filter\(/)
  })

  it('uses the enforcers rather than its own copy of their rules', () => {
    for (const fn of [
      'campaignsNamingHandleRows',
      'materialAllowance',
      'crossSpacingVerdict',
      'replyHaltFloor',
      'fleetRingOrder',
      'nextSender',
    ]) {
      expect(src, `${fn} must be imported and called, not reimplemented here`).toContain(fn)
    }
  })

  /**
   * ── THERE IS NO PER-ROW QUERY LEFT (2026-08-25) ────────────────────────────
   *
   * This used to assert the OPPOSITE shape — that the one per-row query was capped at
   * `PAIR_PRECISION_LIMIT` so it could not become an N+1. MEASURED by logging the SQL:
   * `usedCampaignIds(electedPairId)` inside the prospect loop was **50 of this builder's 62
   * queries**, and because `/` and `/targets` both load it, both sat over the ceilings
   * `ig:layout` enforces — 182/160 and 148/120.
   *
   * A cap is the right answer to a per-row query. Not being per-row is a better one, and it
   * is the move this file already makes for the allowance (`preloaded`). 62 → 16 queries.
   *
   * So the assertion is inverted and STRENGTHENED: the loop must contain no `await prisma`
   * and no `usedCampaignIds` at all. A cap can be raised; an absence cannot be raised.
   */
  it('has no per-row query inside the prospect loop at all', () => {
    /* The CALL, not the word — the docblock in that file explains why it is gone, and the
       explanation is worth more than a grep that forbids naming the thing it removed. */
    expect(src, 'usedCampaignIds is a query per pair — preload it instead').not.toMatch(
      /await usedCampaignIds\(/,
    )
    expect(src, 'it must not be imported either').not.toMatch(/import \{[^}]*usedCampaignIds/)
    /* The usage is loaded once, in the same Promise.all as everything else. */
    expect(src).toMatch(/campaignId: \{ not: null \}, status: \{ in: \[\.\.\.IN_FLIGHT_STATUSES\] \}/)
    expect(src).toMatch(/const usedByPair = new Map/)
    /* The cap is gone rather than raised, so the tally is exact at any fleet size. The
       DECLARATION, not the word: the docblock still names it to explain what it replaced. */
    expect(src).not.toMatch(/const PAIR_PRECISION_LIMIT/)
    expect(src).not.toMatch(/pairChecksDone < PAIR_PRECISION_LIMIT/)
  })

  it('attributes in the GOVERNOR\'s order, because the order changes the answer', () => {
    /**
     * MEASURED, not hypothetical: moving ONE check — ring spacing before the material allowance
     * instead of after it, contradicting governor.ts — reassigns 101 of 473 companies
     * (material-exhausted 367 → 266, target-recently-contacted up by the same). The breakdown is
     * only meaningful if each company lands under the rule the PLANNER would name, so the order
     * here has to be the order there, and a reordering has to fail rather than quietly produce a
     * different-looking chart.
     */
    /* NO_NEW_MATERIAL is in this list because leaving it out is how the inversion shipped: the
       governor asks it BEFORE the ring rule, this asked it after, and four companies were filed
       under the wrong sentence with the wrong release date. */
    const order = [
      'TARGET_NOT_VERIFIED',
      'TARGET_REPLIED',
      'MATERIAL_EXHAUSTED',
      'NO_NEW_MATERIAL',
      'TARGET_RECENTLY_CONTACTED',
    ]
    /* Positions within the DECISION LOOP, and tolerant of a ternary argument. */
    const positions = order.map((k) => loop.indexOf(`SKIP_REASONS.${k}`))
    for (const [i, at] of positions.entries()) {
      expect(at, `bump(SKIP_REASONS.${order[i]}) is missing`).toBeGreaterThan(-1)
    }
    for (let i = 1; i < positions.length; i += 1) {
      expect(
        positions[i]!,
        `${order[i]} must be attributed AFTER ${order[i - 1]!}, as governor.ts checks them`,
      ).toBeGreaterThan(positions[i - 1]!)
    }

    // And the same order in the enforcer, so this test cannot pass against a governor that moved.
    const gov = readFileSync(join(repo, 'src/outreach/governor.ts'), 'utf8')
    const govAt = order.map((k) => gov.indexOf(`SKIP_REASONS.${k}`))
    for (let i = 1; i < govAt.length; i += 1) {
      expect(govAt[i]!, `governor.ts order changed — this tally must follow it`).toBeGreaterThan(govAt[i - 1]!)
    }
  })

  it('counts a company with a draft already written as queued, never as resting', () => {
    // Not resting — next. Counting draft-holders as held read 473/473 on a fleet that was about
    // to send; excluding them read 464/473. The governor checks `hasPendingAttempt` before the
    // parked and material rules, and this follows it.
    expect(src).toMatch(/queued \+= 1/)
    expect(src).not.toMatch(/bump\(SKIP_REASONS\.PENDING_ATTEMPT/)
  })

  it('can be reconciled against the bigger total the targets page already shows', () => {
    // /targets renders `v.prospects.length` — EVERY TargetAccount row, retired and watched
    // included. Two adjacent counts of different populations with nothing saying so is the
    // contradiction this project keeps recording, so the band names both exclusions.
    const band = readFileSync(join(repo, 'src/app/rest-band.tsx'), 'utf8')
    expect(band).toMatch(/companies we write to/)
    expect(band).toMatch(/watched/)
    expect(band).toMatch(/smaller than the number in the list above/)
  })

  it('excludes retired companies from the denominator and reports them apart', () => {
    // A retired row can never be written to, so counting it as "resting" pads the share with
    // rows that are not waiting for anything.
    // The partition moved from three WHERE clauses into one query filtered in JS when `/`'s
    // query budget bound at 161/160 — the property is unchanged, so the assertion follows it
    // rather than pinning the old shape.
    expect(src).toMatch(/t\.role === 'PROSPECT' && !t\.optedOut/)
    expect(src).toMatch(/t\.role === 'PROSPECT' && t\.optedOut/)
    expect(src).toMatch(/t\.role === 'WATCH'/)
    // `total` is the live prospects only — retired must never be folded into the denominator.
    expect(src).toMatch(/total: prospects\.length/)
    const band = readFileSync(join(repo, 'src/app/rest-band.tsx'), 'utf8')
    expect(band).toMatch(/[Nn]ot counted here/)
  })

  it('does not dress the steady state as an alarm', () => {
    const band = readFileSync(join(repo, 'src/app/rest-band.tsx'), 'utf8')
    // `status-attention` is the amber box. 469 of 473 resting is the rules working; putting it
    // in the alarm container is how an operator learns to ignore the container.
    expect(band).not.toMatch(/status-attention|className="status/)
    // It must still name the one number that does want a person.
    expect(band).toMatch(/needsAPerson|needingAPerson/)
  })

  it('says when it was measured, because the figure moves all day', () => {
    const band = readFileSync(join(repo, 'src/app/rest-band.tsx'), 'utf8')
    expect(band).toMatch(/measuredAt/)
    // The shared IST label, not a second implementation of "26 Aug (14:57)".
    expect(band).toMatch(/istPostedLabel/)
  })

  /**
   * TWO SHAPES, ONE FIGURE — and the rule is about the FIGURE.
   *
   * This asserted `<RestBand` on both pages, which made the COMPONENT the invariant rather
   * than the fact it carries. `/targets` renders `<RestTile` since the mockup design landed:
   * the same tally in one line, because directly under a page title the question is "how many
   * of these can we write to today" and the per-rule breakdown is furniture there, while on
   * Autopilot — the page whose whole job is "what is stopping it" — the breakdown is the
   * point.
   *
   * What must not change is that the figure reaches BOTH pages and is loaded concurrently
   * with the other builders. A page that silently stopped rendering it would be back to
   * showing a list that looks like capacity it does not have, which is the defect this whole
   * file exists for, so the assertion is widened rather than dropped.
   */
  it('is rendered on both pages that ask the question', () => {
    for (const page of ['src/app/page.tsx', 'src/app/targets/page.tsx']) {
      const p = readFileSync(join(repo, page), 'utf8')
      expect(p, `${page} must render the tally in one of its two shapes`).toMatch(
        /<Rest(Band|Tile) tally=\{rest\}/,
      )
      expect(p, `${page} must load it concurrently, not serially`).toMatch(/buildRestTally\(\)/)
    }
  })

  /** Both shapes read the SAME tally, so they can never report different numbers. */
  it('the tile and the band are both in rest-band.tsx, over one tally type', () => {
    const band = readFileSync(join(repo, 'src/app/rest-band.tsx'), 'utf8')
    expect(band).toMatch(/export function RestTile\(\{ tally \}: \{ tally: RestTally \}\)/)
    expect(band).toMatch(/export function RestBand\(/)
  })
})
