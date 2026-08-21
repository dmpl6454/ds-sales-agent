/**
 * VERIFIED ONLY — Tabish, 2026-08-20: *"No message is to be sent to any target that are
 * unverified."*
 *
 * This file is the FUTURE-PROOFING, and it is deliberately three different kinds of check,
 * because the rule can be lost in three different ways:
 *
 *   1. BEHAVIOURALLY, at both enforcers, in both directions — including the NULL case,
 *      which is the one a "helpful" edit would loosen first.
 *   2. STRUCTURALLY, as a source grep, because a NEW creator of targets or a NEW send path
 *      is a call site nobody has written yet and no behavioural test can fail for it.
 *   3. AS AN INVARIANT about overridability: this stop is about WHO the recipient is, so no
 *      human acknowledgement may cross it — the same class as the watch-only stop.
 */
import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * `evaluateResend`/`evaluatePair` are PURE, but their module reaches `@/lib/db` at import
 * time. Stubbed so this file tests the RULE regardless of which provider the generated
 * client currently carries — otherwise the outcome depends on what ran before it, which is
 * the two-provider trap wearing a test's clothes.
 */
vi.mock('@/lib/db', () => ({ prisma: {} }))
import { evaluateResend, RESEND_BLOCKS, OVERRIDABLE_BLOCKS } from '@/outreach/gate'
import { evaluatePair, SKIP_REASONS } from '@/outreach/governor'

const gateInput = (over: Record<string, unknown> = {}) =>
  ({
    attemptStatus: 'READY',
    unattended: true,
    senderStatus: 'ACTIVE',
    senderHasSession: true,
    /* Nothing parked on this pair — the duplicate guard, 2026-08-21. */
    parkedFailureCode: null,
    targetOptedOut: false,
    targetIsWatchOnly: false,
    targetIsVerified: true,
    targetRepliedAt: null,
    pairSentTodayCount: 0,
    maxPerPairPerDay: 5,
    crossSpacing: { held: false },
    ...over,
  }) as Parameters<typeof evaluateResend>[0]

const governorInput = (over: Record<string, unknown> = {}) =>
  ({
    now: new Date('2026-08-20T12:00:00Z'),
    sender: { status: 'ACTIVE' },
    target: { optedOut: false, isVerified: true },
    touchesSoFar: 0,
    targetRepliedAt: null,
    hasPendingAttempt: false,
    parkedFailureCode: null,
    unusedCampaignCount: 5,
    pairSentTodayCount: 0,
    maxPerPairPerDay: 5,
    crossSpacing: { held: false },
    totalSentEver: 0,
    maxTotalSends: null,
    ...over,
  }) as Parameters<typeof evaluatePair>[0]

describe('the gate refuses an unverified recipient', () => {
  it('permits a verified one — so the refusals below are not vacuous', () => {
    expect(evaluateResend(gateInput())).toEqual({ ok: true })
  })

  it('refuses isVerified === false', () => {
    const r = evaluateResend(gateInput({ targetIsVerified: false }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe(RESEND_BLOCKS.TARGET_NOT_VERIFIED)
  })

  /**
   * THE LOAD-BEARING CASE. "We never looked" is not "verified", and absence of data
   * hardening into a positive verdict is this codebase's most-repeated defect. The cost of
   * refusing NULL is paid at creation instead — `createBrandTarget` enriches every new row.
   */
  it('refuses isVerified === null, and says so in different words', () => {
    const r = evaluateResend(gateInput({ targetIsVerified: null }))
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason).toBe(RESEND_BLOCKS.TARGET_NOT_VERIFIED)
      expect(r.detail).toContain('never confirmed')
    }
  })

  it('cannot be crossed by a human acknowledgement — it is about WHO, not WHEN', () => {
    const r = evaluateResend(
      gateInput({ unattended: false, targetIsVerified: false, overrides: [RESEND_BLOCKS.TARGET_NOT_VERIFIED] }),
    )
    expect(r.ok, 'an absolute stop was crossed by passing its own code as an override').toBe(false)
    expect([...OVERRIDABLE_BLOCKS]).not.toContain(RESEND_BLOCKS.TARGET_NOT_VERIFIED)
  })
})

describe('the planner refuses to WRITE to an unverified recipient', () => {
  it('permits a verified one', () => {
    expect(evaluatePair(governorInput()).eligible).toBe(true)
  })

  it.each([[false], [null]])('refuses isVerified === %s at drafting', (v) => {
    const d = evaluatePair(governorInput({ target: { optedOut: false, isVerified: v } }))
    expect(d.eligible).toBe(false)
    if (!d.eligible) expect(d.reason).toBe(SKIP_REASONS.TARGET_NOT_VERIFIED)
  })
})

/**
 * THE STRUCTURAL HALF. A grep that matches nothing reports success, so every assertion
 * below names what it expects to find and fails loudly when it does not.
 */
describe('the rule cannot be bypassed by a new call site', () => {
  const read = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf8')
  const codeOnly = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

  it('BOTH enforcers check it — the gate at delivery and the governor at drafting', () => {
    expect(codeOnly(read('src/outreach/gate.ts'))).toContain('input.targetIsVerified !== true')
    expect(codeOnly(read('src/outreach/governor.ts'))).toContain('input.target.isVerified !== true')
  })

  /**
   * `createBrandTarget` is the ONE creator of a prospect row, and it must stamp the badge at
   * birth. Without this a freshly discovered brand is born NULL, the gate refuses it, and
   * the lead is lost silently — which is the opposite of what discovery is for.
   */
  it('the one target creator stamps the verified fact at creation', () => {
    const src = codeOnly(read('src/outreach/brandTarget.ts'))
    expect(src).toContain('enrichHandle')
    expect(src).toMatch(/isVerified: verified/)
  })

  /** Both admission bars are verified-only: no size fallback may return as a second door in. */
  it('neither admission bar admits on follower count alone', () => {
    expect(codeOnly(read('src/outreach/targetAudit.ts'))).toContain('return e.isVerified === true')
    expect(codeOnly(read('src/detection/officialHandle.ts'))).toContain('input.isVerified === true')
  })
})

/**
 * AND THE DISCOVERY HALF RUNS ITSELF (Tabish, 2026-08-20: "we cannot lose leads in posts
 * with no tags"). A SOURCE GREP, because the failure is a caller nobody wrote: this repo
 * has twice shipped a working feature that only ran when a person typed a command — 166
 * cover frames saved in a day and none read, and `autoResolveBrands` wired everywhere
 * except the automatic path.
 */
describe('untagged-post discovery is on the automatic path', () => {
  const agent = readFileSync(join(process.cwd(), 'src/agent/index.ts'), 'utf8')

  it('the device agent calls discoverOfficialPages, not just the CLI', () => {
    expect(
      agent.includes('discoverOfficialPages'),
      'nothing on the automatic path discovers the advertiser behind an untagged paid post, ' +
        'so 172 measured CAMPAIGN posts produce leads only when someone remembers a command',
    ).toBe(true)
  })

  it('it is bounded, because it shares one throttled endpoint with the brand pass', () => {
    expect(agent).toMatch(/OFFICIAL_LOOKUPS_PER_PASS\s*=\s*\d+/)
    expect(agent).toContain('maxLookups: OFFICIAL_LOOKUPS_PER_PASS')
  })
})
