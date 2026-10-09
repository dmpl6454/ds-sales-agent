import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import {
  replyHaltRule,
  replyAlarmHeadline,
  replyFeedSentence,
  replyLede,
  replyBlockerCopy,
  prospectReplyNote,
} from '../src/outreach/replyHaltCopy'

/**
 * NO SCREEN SAYS A REPLY PAUSES EVERY PAGE UNLESS IT ASKED THE SCOPE — audit H9, PER PHRASE.
 *
 * Under the pair scope Tabish chose on 2026-09-01, a reply pauses only the page it reached and
 * rotation hands the turn on. /rules, the landing page, the alarm, the activity feed, /targets and
 * the Send-now dialog all said the opposite, in sentences none of which read `replyHaltScope`.
 * Those sentences now live in ONE file, `replyHaltCopy.ts`, as functions of the scope — so a
 * fleet-wide reply phrase anywhere else under src/app or src/outreach is a sentence that did not
 * ask, and fails here.
 *
 * ── WHY PER PHRASE, AND NOT "THE FILE MENTIONS replyHaltScope" ───────────────
 *
 * The first design passed any file that mentioned the scope anywhere. view-model.ts had THREE wrong
 * literals; fixing one would have turned the guard green for all three. A grep proves a name is
 * MENTIONED, not that it GATES. So every occurrence fails, wherever it is, unless it is inside the
 * copy owner. Comments are stripped first: a docblock recording the old sentence is history, not
 * a screen.
 *
 * NOT matched, deliberately: the breaker's "Every account is halted, not just one" — a TRUE
 * fleet-wide sentence about a different stop.
 *
 * VERIFIED TO FAIL AT THE PRE-CHANGE STATE (rule 37): run over the files at the commit before this
 * change it flags rules/page.tsx, blockers.ts, page.tsx, view-model.ts (three), prospects/list.tsx,
 * gate.ts, onDemand.ts and replyCheck.ts — and below, the patterns are proven able to SEE the copy owner's
 * own target-scope sentences, so the guard cannot pass by matching nothing.
 */

const PATTERNS: RegExp[] = [
  /(halts|pauses) every (account|one of our pages)/i,
  /every account writing to them is paused/i,
  /outreach to them is (paused|on hold|halted)/i,
  /all outreach to them/i,
  /messaging (them )?pauses for/i,
  /a person (should|can) take over/i,
]

const COPY_OWNER = 'src/outreach/replyHaltCopy.ts'

/**
 * PENDING — exactly one sentence, owned by a SEPARATE change (audit H9 §B9, which rewrites
 * `ensureConversationChecked`'s reply-found detail together with where a reply is attached; this
 * change does not touch replyCheck.ts). The entry REQUIRES the sentence to still be there: the day
 * it is rewritten this test fails and says to delete the entry, so the carve-out cannot outlive the
 * reason for it.
 */
const PENDING: { file: string; contains: string; why: string }[] = [
  {
    file: 'src/outreach/replyCheck.ts',
    contains: 'has replied — outreach to them is halted and a person should take over',
    why: 'audit H9 §B9, rewritten with the pair-correct reply attachment',
  },
]

const repo = join(__dirname, '..')
const rel = (p: string) => relative(repo, p).split(sep).join('/')
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) return walk(p)
    return /\.(ts|tsx)$/.test(name) ? [p] : []
  })
}
const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/(^|[^:])\/\/.*$/gm, '$1')

const files = ['src/app', 'src/outreach'].flatMap((d) =>
  walk(join(repo, d)).map((p) => ({ path: rel(p), code: strip(readFileSync(p, 'utf8')) })),
)

function offenders(): string[] {
  return files.flatMap((f) =>
    f.path === COPY_OWNER
      ? []
      : f.code.split('\n').flatMap((line, i) => {
          if (!PATTERNS.some((re) => re.test(line))) return []
          if (PENDING.some((p) => p.file === f.path && line.includes(p.contains))) return []
          return [`${f.path}:${i + 1}: ${line.trim()}`]
        }),
  )
}

describe('a fleet-wide reply sentence lives only in the copy owner', () => {
  it('the walk found both trees and the copy owner, and the strip did not swallow code', () => {
    expect(files.length).toBeGreaterThan(80)
    expect(files.map((f) => f.path)).toContain(COPY_OWNER)
    expect(files.find((f) => f.path === 'src/app/view-model.ts')!.code).toMatch(/replyAlarmHeadline\(/)
  })

  it('no file but replyHaltCopy.ts says a reply pauses every page', () => {
    expect(offenders(), 'a screen states the TARGET scope without asking which scope is in force').toEqual([])
  })

  it.each(PENDING.map((p) => [p.file, p]))('PENDING entry for %s is still needed', (_f, p) => {
    const f = files.find((x) => x.path === p.file)
    expect(
      f?.code.includes(p.contains),
      `${p.file} no longer says this (${p.why}) — delete this PENDING entry so the guard covers the file again`,
    ).toBe(true)
  })

  /** Non-vacuity: the patterns can SEE the sentences they exist to keep in one place. */
  it('the patterns match the copy owner’s own target-scope sentences', () => {
    const target = [
      replyHaltRule('target', 168),
      replyAlarmHeadline('target', { count: 1, name: 'X' }),
      replyAlarmHeadline('target', { count: 2, name: 'X' }),
      replyFeedSentence('target', { target: 'X', senderHandle: 'a', state: 'holding', hours: 168 }),
      replyLede('target'),
      replyBlockerCopy('target', 2, 168).verdict,
    ]
    for (const s of target) expect(PATTERNS.some((re) => re.test(s)), s).toBe(true)
    /* …and NOT the pair-scope ones, or the guard would be refusing the fix. */
    const pair = [
      replyHaltRule('pair', 168),
      replyAlarmHeadline('pair', { count: 2, name: 'X' }),
      replyFeedSentence('pair', { target: 'X', senderHandle: 'a', state: 'holding', hours: 168 }),
      replyLede('pair'),
      replyBlockerCopy('pair', 2, 168).verdict,
      prospectReplyNote('pair', { senderHandles: ['a'], freesIst: '1 Oct' }, true)!,
    ]
    for (const s of pair) expect(PATTERNS.some((re) => re.test(s)), s).toBe(false)
  })

  /**
   * …and each screen asks the owner WITH THE LIVE SCOPE. `replyLede('pair')` would pass the guard
   * above and be the same defect in the other direction the day Tabish flips the Setting.
   */
  it.each([
    ['src/app/page.tsx', /replyLede\(settings\.replyHaltScope\)/],
    ['src/app/rules/page.tsx', /replyHaltRule\(settings\.replyHaltScope, settings\.replyResumeHours\)/],
    ['src/app/view-model.ts', /replyAlarmHeadline\(settings\.replyHaltScope,/],
    ['src/app/view-model.ts', /replyFeedSentence\(settings\.replyHaltScope,/],
    /* An UNDATED reply halts nothing — the feed's third state, not "released". */
    ['src/app/view-model.ts', /r\.replyPostedAt === null\s*\?\s*'undated'/],
    ['src/app/view-model/blockers.ts', /replyBlockerCopy\(input\.replyHalt\.scope, input\.repliesWaiting, input\.replyHalt\.resumeHours\)/],
    ['src/app/page.tsx', /replyHalt: \{ scope: settings\.replyHaltScope, resumeHours: settings\.replyResumeHours \}/],
    ['src/app/view-model/prospects-page.ts', /prospectReplyNote\(\s*settings\.replyHaltScope,/],
    ['src/app/view-model/prospects-page.ts', /replyBlocksEveryPage\(settings\.replyHaltScope\)/],
    ['src/app/prospects/list.tsx', /\{p\.replyNote && <p className="account-message">\{p\.replyNote\}<\/p>\}/],
    ['src/app/prospects/list.tsx', /if \(p\.replied && !p\.nextSenderWillWrite\) return 'var\(--pending\)'/],
    ['src/app/view-model/messages-page.ts', /replyQueueHold\(settings\.replyHaltScope, settings\.replyResumeHours\)/],
    ['src/outreach/gate.ts', /detail: replyHeldDetail\(input\.targetRepliedAt\.toISOString\(\)\)/],
  ])('%s asks the copy owner with the live scope (%s)', (file, re) => {
    expect(files.find((f) => f.path === file)!.code).toMatch(re)
  })

  it('does not flag the breaker, which IS fleet-wide', () => {
    expect(PATTERNS.some((re) => re.test('Every account is halted, not just one'))).toBe(false)
  })
})
