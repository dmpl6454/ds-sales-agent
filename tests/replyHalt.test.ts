import { describe, expect, it } from 'vitest'
import {
  REPLY_HALT_SCOPE_DEFAULT,
  REPLY_RESUME_HOURS_DEFAULT,
  parseReplyHaltScope,
  replyHaltActive,
  replyHaltFloor,
  replyHaltKey,
  replyHaltPairFilter,
  replyHaltWhere,
} from '@/outreach/replyHalt'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

/**
 * The reply halt releases ITSELF after `replyResumeHours` — Tabish's decision,
 * 2026-08-07, chosen after the risk was stated (an automated follow-up resuming into a
 * conversation a human answered). These tests pin the rule in BOTH directions on both
 * sides of the boundary, because a halt that never releases and a halt that never holds
 * would each pass a one-direction suite.
 */
describe('replyHaltActive', () => {
  const NOW = new Date('2026-08-07T12:00:00Z')
  const HOURS = 24

  it('a fresh reply halts', () => {
    expect(
      replyHaltActive({ replyPostedAt: new Date('2026-08-07T11:00:00Z'), replyHandledAt: null, resumeHours: HOURS, now: NOW }),
    ).toBe(true)
  })

  it('a reply older than the window has released itself', () => {
    expect(
      replyHaltActive({ replyPostedAt: new Date('2026-08-06T11:59:59Z'), replyHandledAt: null, resumeHours: HOURS, now: NOW }),
    ).toBe(false)
  })

  it('exactly at the boundary still halts — the window is inclusive', () => {
    expect(
      replyHaltActive({ replyPostedAt: new Date('2026-08-06T12:00:00Z'), replyHandledAt: null, resumeHours: HOURS, now: NOW }),
    ).toBe(true)
  })

  /**
   * ── AN UNDATABLE REPLY DOES NOT HOLD THE HALT (Tabish's rule, 2026-08-21) ──
   *
   * `replyPostedAt: null` covers two cases that must behave the same: no reply at all,
   * and a reply whose date the thread/inbox never showed. Verbatim: *"the agent must see
   * the date on the reply … if no date is visible send the message … as the reply might
   * be to an older conversation."* The reply itself is still recorded (`repliedAt`,
   * `replyText`) and still listed for a person — only the automatic seven-day pause
   * requires a date it can count from. This is the permissive direction, chosen by him,
   * recorded here.
   */
  it('no dated reply, no halt — undatable replies release per the 2026-08-21 rule', () => {
    expect(replyHaltActive({ replyPostedAt: null, replyHandledAt: null, resumeHours: HOURS, now: NOW })).toBe(false)
  })

  it('"handled" is an early release inside the window', () => {
    expect(
      replyHaltActive({
        replyPostedAt: new Date('2026-08-07T11:00:00Z'),
        replyHandledAt: new Date('2026-08-07T11:30:00Z'),
        resumeHours: HOURS,
        now: NOW,
      }),
    ).toBe(false)
  })

  /**
   * A prospect who keeps replying keeps deferring: each NEW reply carries its own
   * timestamp (only unrecorded messages count as new — replyCheck.ts), so the window
   * re-arms from the newest one.
   */
  it('a newer reply re-arms the window', () => {
    const old = replyHaltActive({ replyPostedAt: new Date('2026-08-05T12:00:00Z'), replyHandledAt: null, resumeHours: HOURS, now: NOW })
    const renewed = replyHaltActive({ replyPostedAt: new Date('2026-08-07T09:00:00Z'), replyHandledAt: null, resumeHours: HOURS, now: NOW })
    expect(old).toBe(false)
    expect(renewed).toBe(true)
  })

  it('the old behaviour is one Setting away — a huge window never releases in practice', () => {
    expect(
      replyHaltActive({ replyPostedAt: new Date('2020-01-01T00:00:00Z'), replyHandledAt: null, resumeHours: 24 * 365 * 100, now: NOW }),
    ).toBe(true)
  })
})

describe('replyHaltFloor', () => {
  it('is exactly resumeHours before now', () => {
    const now = new Date('2026-08-07T12:00:00Z')
    expect(replyHaltFloor(24, now).toISOString()).toBe('2026-08-06T12:00:00.000Z')
    expect(replyHaltFloor(1, now).toISOString()).toBe('2026-08-07T11:00:00.000Z')
  })

  it('default is seven days — Tabish\'s "resume after 7 days automatically or manually" (2026-08-19)', () => {
    expect(REPLY_RESUME_HOURS_DEFAULT).toBe(168)
  })
})

/**
 * ── THE SCOPE (2026-09-01, Tabish's decision) ─────────────────────────────────
 *
 * *"Only the channel (sender) which has gotten the reply should halt for 7 days."* The risk
 * was put to him with the alternatives before the change and is recorded in `replyHalt.ts`;
 * the pair scope is his call. Both scopes are driven here so the one that is switched off
 * stays enforceable — the discipline `crossPageGapHours` (0) and the active-hours window
 * (0/0) already have.
 */
describe('replyHaltScope', () => {
  const IDS = { senderId: 'send_a', targetId: 'targ_1' }

  it('defaults to the pair — one page’s conversation, not the whole recipient', () => {
    expect(REPLY_HALT_SCOPE_DEFAULT).toBe('pair')
  })

  it('pair scope filters on both ends; target scope on the recipient alone', () => {
    expect(replyHaltPairFilter('pair', IDS)).toEqual({ senderId: 'send_a', targetId: 'targ_1' })
    expect(replyHaltPairFilter('target', IDS)).toEqual({ targetId: 'targ_1' })
  })

  /** The in-memory twin, for the two screens that group replies rather than query per draft. */
  it('the grouping key separates pages under pair scope and merges them under target', () => {
    const other = { senderId: 'send_b', targetId: 'targ_1' }
    expect(replyHaltKey('pair', IDS)).not.toBe(replyHaltKey('pair', other))
    expect(replyHaltKey('target', IDS)).toBe(replyHaltKey('target', other))
  })

  /** The whole `where`, handed out as one object so a caller cannot take half of it. */
  it('the where clause carries the scope, the window AND the early release together', () => {
    const now = new Date('2026-09-01T12:00:00Z')
    const w = replyHaltWhere({ scope: 'pair', senderId: 'send_a', targetId: 'targ_1', resumeHours: 24, now })
    expect(w.pair).toEqual({ senderId: 'send_a', targetId: 'targ_1' })
    expect(w.replyPostedAt.gte.toISOString()).toBe('2026-08-31T12:00:00.000Z')
    expect(w.replyHandledAt).toBeNull()
  })

  /**
   * ABSENT keeps the default; UNREADABLE falls to the WIDER halt. The asymmetry is
   * deliberate: the default here is the PERMISSIVE scope, so a typo falling back to it would
   * silently widen who is messaged mid-conversation — absence of a readable value becoming a
   * permission, which is this codebase's most-repeated defect.
   */
  it('an absent value keeps the default and an unreadable one fails closed', () => {
    expect(parseReplyHaltScope(undefined)).toBe(REPLY_HALT_SCOPE_DEFAULT)
    expect(parseReplyHaltScope('pair')).toBe('pair')
    expect(parseReplyHaltScope(' TARGET ')).toBe('target')
    for (const junk of ['targt', 'all', '', 'true', 'sender']) {
      expect(parseReplyHaltScope(junk), `"${junk}" must not widen the halt`).toBe('target')
    }
  })
})

/**
 * ── AND EVERY ENFORCER ASKS replyHalt.ts, NOT ITS OWN `where` ─────────────────
 *
 * A source grep, because the failure mode is a call site nobody has written yet. The halt
 * was once spelled out at seven sites and drifted, which is why this module exists at all;
 * a SCOPE spelled out at eight of them would produce a page claiming a hold the gate is not
 * enforcing — the "a page reporting a rule by a different rule than the one enforcing it"
 * failure this repo's history is full of.
 */
describe('the halt is expressed in one place', () => {
  const ROOT = resolve(__dirname, '..')
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

  it.each([
    ['src/outreach/gate.ts', 'the gate refuses the send'],
    ['src/outreach/plan.ts', 'the planner refuses the draft'],
    ['src/outreach/onDemand.ts', 'the dialog warns about it'],
  ])('%s builds its halt query with replyHaltWhere — %s', (file) => {
    const src = strip(readFileSync(join(ROOT, file), 'utf8'))
    expect(src, `${file} must ask replyHalt.ts for the scope`).toMatch(/replyHaltWhere\(/)
    /* And must NOT hand-write the old target-only shape beside it. */
    expect(src, `${file} still spells the halt out itself — the scope will drift`).not.toMatch(
      /replyPostedAt:\s*\{\s*gte:\s*replyHaltFloor/,
    )
  })

  it.each([
    ['src/app/view-model/messages-page.ts', 'the queue predicts a hold per draft'],
    ['src/app/view-model/rest-tally.ts', 'the tally attributes a company to it'],
  ])('%s groups replies with replyHaltKey — %s', (file) => {
    const src = strip(readFileSync(join(ROOT, file), 'utf8'))
    expect(src, `${file} groups replies by recipient, so it will hold pages the gate does not`).toMatch(
      /replyHaltKey\(/,
    )
  })
})
