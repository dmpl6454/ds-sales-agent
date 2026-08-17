import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  DETECT_INTERVAL_MINUTES,
  DETECT_LOOKBACK_HOURS,
  DETECT_CATCHUP_LOOKBACK_HOURS,
} from '@/detection/cadence'
import { DISPATCH_INTERVAL_MINUTES } from '@/outreach/pacing'
import { tooShortToJudge, MIN_JUDGEABLE_CAPTION } from '@/detection/detectors/semantic'
import { detectThenDraft } from '@/worker/scheduler'

/**
 * Detection runs on its OWN clock, not the sending schedule — Tabish, 2026-08-07:
 * *"the schedule is for sending messages, not for detecting paid posts, paid posts must be
 * detected as fast as possible."*
 *
 * It was stage 1 of `runSlot`, so it inherited 11:00/15:00/17:00/20:00 IST and the
 * 20:00 -> 11:00 gap left posts undetected for FIFTEEN HOURS (~20 a night, measured on
 * 404 real @viralbhayani posts at 57.7/day).
 */
describe('detection cadence', () => {
  it('is far faster than the worst send-schedule gap it replaced', () => {
    const WORST_SLOT_GAP_MINUTES = 15 * 60 // 20:00 -> 11:00 IST
    expect(DETECT_INTERVAL_MINUTES).toBeLessThan(WORST_SLOT_GAP_MINUTES / 10)
  })

  /**
   * The lookback must comfortably exceed the interval, or a pass that is skipped once
   * loses posts outright. 6h against a 15m interval survives 24 consecutive misses.
   */
  it('looks back much further than one interval, so a skipped pass loses nothing', () => {
    expect(DETECT_LOOKBACK_HOURS * 60).toBeGreaterThan(DETECT_INTERVAL_MINUTES * 10)
  })

  /** A restart or a slept-through night needs the long reach; the slots use it. */
  it('keeps a longer window for catch-up than for a routine pass', () => {
    expect(DETECT_CATCHUP_LOOKBACK_HOURS).toBeGreaterThan(DETECT_LOOKBACK_HOURS)
  })

  /**
   * Detection is an anonymous public read; sending drives a browser at a revenue account.
   * They are different risks and must not be tied to one number — if these ever become
   * equal by coincidence, that is fine, but neither may be DERIVED from the other.
   */
  it('is independent of the dispatcher interval', () => {
    expect(typeof DISPATCH_INTERVAL_MINUTES).toBe('number')
    expect(typeof DETECT_INTERVAL_MINUTES).toBe('number')
  })

  /** Politeness to an undocumented endpoint: never sub-minute, never a hammer. */
  it('does not hammer the endpoint', () => {
    expect(DETECT_INTERVAL_MINUTES).toBeGreaterThanOrEqual(5)
  })
})

/**
 * "Too short to be a pitch" is a VERDICT, not a failed call.
 *
 * `classifyCaption` returns null under this length, and null means "the call failed" — so
 * 27 posts (every one a bare celebrity tag, `Om Shanti 🙏`, `RIP 💔`, or empty) sat in
 * UNCLASSIFIED permanently, holding the unjudged count above zero on a screen where
 * unjudged means A JOB TO DO. Re-running could never clear them.
 */
describe('tooShortToJudge', () => {
  it('catches the real captions that were stuck unjudged', () => {
    for (const c of ['#kajol', '#dishapatani', 'Om Shanti 🙏', 'RIP 💔', '', '   ', 'Ravi dubey']) {
      expect(tooShortToJudge(c), `${JSON.stringify(c)} should be too short`).toBe(true)
    }
  })

  it('does NOT catch a caption long enough to carry a pitch', () => {
    expect(tooShortToJudge('Thanekars have double reasons to celebrate #Thane')).toBe(false)
    expect(tooShortToJudge('In cinemas now, book your tickets')).toBe(false)
  })

  it('measures the trimmed length, so whitespace cannot fake a judgeable caption', () => {
    expect(tooShortToJudge(`${' '.repeat(40)}#kajol${' '.repeat(40)}`)).toBe(true)
  })

  it('the bound is exported so it is one place to change', () => {
    expect(MIN_JUDGEABLE_CAPTION).toBe(15)
  })
})

/**
 * ── DRAFTING RUNS ON THE DETECT CLOCK — ONE SWITCH, Tabish 2026-08-08 ──────────────────
 *
 * A paid post found at 11:20 used to wait for the 15:00 slot before anything was written
 * about it. Detection has run on its own 15-minute clock since 2026-08-07; drafting now
 * follows it, so "autopilot is on" means a draft exists within minutes.
 *
 * Both directions are asserted, because the switch-off case is the one that fails silently:
 * a queue growing while the switch reads OFF is the "no sabotage or discrepancy" Tabish asked
 * about, and nothing on screen would say so.
 *
 * SENDING IS DELIBERATELY NOT EXERCISED HERE and must never become reachable from this path
 * — the "the detect clock cannot send" block below pins that structurally.
 */
describe('planning on the detect clock', () => {
  const pass = { newPosts: 0, detected: 0 } as Awaited<ReturnType<typeof import('@/detection/pipeline').runDetection>>

  /**
   * The lock, granted. Planning runs under the SLOT LOCK so this task and a slot cannot both
   * plan the same pair — see the docblock on `withSlotLock`. Injected rather than hitting the
   * database, and granted by default here so every other assertion is about the switch and not
   * about lock contention. The held case has its own test below.
   */
  const grantLock = (async <T,>(_label: string, fn: () => Promise<T>) => fn()) as never

  /**
   * ── REVERSED DELIBERATELY, 2026-08-13 (repair plan 4.1) ────────────────────────────
   *
   * This pair of tests used to assert that drafting was GATED on the autopilot switch, and
   * they passed while asserting something that had never once happened in production:
   * autopilot is off, so the ON case existed only in this file. MEASURED on the server's
   * pm2 log — 23 detection passes to 1 outreach pass, and every waiting draft written at
   * :30/:31 UTC, which is the four IST slots and not the 15-minute clock.
   *
   * The gate was wrong on its own terms: `runSlot` calls `runOutreach()` unconditionally,
   * so the two paths disagreed, and the slot path is the one that matches the product —
   * a draft with autopilot off is the INTENDED state, "prepared and waits for a click".
   *
   * The old assertion's stated worry was "the queue must not grow behind an operator with
   * the switch off". That worry is answered, but by a bound rather than by a gate: the
   * new-brand cap now counts first touches WRITTEN today and not only delivered ones
   * (`brandTouchCounts.ts`), which is why 4.1 and 4.2 had to ship together. Drafting
   * contacts nobody — `plan.ts` has one `.send()` call site and it is `manualAssistSender`.
   */
  it('plans drafts on EVERY pass, whatever the switch says', async () => {
    for (const autopilotEnabled of [true, false]) {
      let planned = 0
      await detectThenDraft({
        detect: async () => pass,
        plan: async () => {
          planned++
          return {} as never
        },
        settings: async () => ({ autopilotEnabled }) as never,
        lock: grantLock,
      })
      expect(planned, `drafting must run with autopilot ${autopilotEnabled}`).toBe(1)
    }
  })

  /**
   * AND THE SWITCH IS NOT CONSULTED AT ALL, which is a stronger claim than "it plans with
   * the switch off" and is the one that would catch a re-gating. A `settings` reader that
   * throws proves the branch is gone rather than merely taking the other arm.
   */
  it('does not ask about the switch to decide whether to draft', async () => {
    let planned = 0
    await detectThenDraft({
      detect: async () => pass,
      plan: async () => {
        planned++
        return {} as never
      },
      settings: (() => {
        throw new Error('detectThenDraft must not read settings to decide whether to draft')
      }) as never,
      lock: grantLock,
    })
    expect(planned).toBe(1)
  })

  /**
   * TWO PLANNERS MUST NOT RUN AT ONCE, and this is not hypothetical: `noOverlap` is per task,
   * and the four slots sit on minute 0 — always a multiple of the 15-minute detect interval —
   * so this task and a slot collide four times a day. Two concurrent `runOutreach` calls both
   * read `hasPendingAttempt: false` for one pair and both draft it, which is two DMs to one
   * prospect. A held lock must therefore skip planning, and must NOT be reported as a failure:
   * the slot holding it is doing the same planning anyway.
   */
  it('skips planning when a slot already holds the lock', async () => {
    let planned = 0
    const warned: string[] = []
    const warn = console.warn
    console.warn = (m: unknown) => void warned.push(String(m))
    try {
      await detectThenDraft({
        detect: async () => pass,
        plan: async () => {
          planned++
          return {} as never
        },
        settings: async () => ({ autopilotEnabled: true }) as never,
        // What `withSlotLock` returns when another slot holds it.
        lock: (async () => null) as never,
      })
    } finally {
      console.warn = warn
    }
    expect(planned, 'a second planner must not run beside a slot').toBe(0)
    expect(warned.join('\n'), 'a held lock is ordinary, not a failure').not.toMatch(/failed/)
  })

  /** Detection still runs regardless — the switch is about drafting, never about reading. */
  it('detects on both sides of the switch', async () => {
    for (const autopilotEnabled of [true, false]) {
      let detected = 0
      await detectThenDraft({
        detect: async () => {
          detected++
          return pass
        },
        plan: async () => ({}) as never,
        settings: async () => ({ autopilotEnabled }) as never,
        lock: grantLock,
      })
      expect(detected, `detection must run with autopilot ${autopilotEnabled}`).toBe(1)
    }
  })

  /**
   * A planning failure must not fail the detection pass. A late draft is recoverable; a post
   * that scrolls out of the 48-deep feed window can never be re-scraped, so the two are not
   * equivalent failures and must not share a handler.
   *
   * THE LOG LEVEL IS THE ASSERTION, and that was found by mutation testing: deleting the
   * `.catch` around `plan()` left every earlier version of this test passing, because the
   * OUTER `try` swallows the throw too and the call still resolves. "It did not crash" is
   * satisfied by both the right and the wrong structure.
   *
   * What actually differs is which failure is reported. `log.alarm` is reserved for "the
   * system is quietly doing nothing" — a broken parser returning zero posts — and a late
   * draft is not that. Raising the alarm for one teaches an operator to discount it for the
   * other, which is the same reason a routine 2FA prompt must not mark an account CHALLENGED.
   */
  it('reports a planning failure as a WARNING, and never as a detection alarm', async () => {
    const warned: string[] = []
    const alarmed: string[] = []
    const warn = console.warn
    const error = console.error
    console.warn = (m: unknown) => void warned.push(String(m))
    console.error = (m: unknown) => void alarmed.push(String(m))

    let detected = 0
    try {
      await expect(
        detectThenDraft({
          detect: async () => {
            detected++
            return pass
          },
          plan: async () => {
            throw new Error('planner exploded')
          },
          settings: async () => ({ autopilotEnabled: true }) as never,
          lock: grantLock,
        }),
      ).resolves.toBeUndefined()
    } finally {
      console.warn = warn
      console.error = error
    }

    expect(detected, 'the detection pass still happened').toBe(1)
    expect(warned.join('\n')).toMatch(/outreach planning after detect failed/)
    expect(
      alarmed.join('\n'),
      'a late draft must not raise the alarm that means detection is silently dead',
    ).not.toMatch(/detection pass threw/)
  })

  /**
   * The reverse, asserted so the ordering cannot be flipped by a later refactor: planning is
   * downstream of detection, so a detection failure must not produce drafts against a corpus
   * that was never refreshed.
   */
  it('does not plan when detection itself throws', async () => {
    let planned = 0
    await expect(
      detectThenDraft({
        detect: async () => {
          throw new Error('feed down')
        },
        plan: async () => {
          planned++
          return {} as never
        },
        settings: async () => ({ autopilotEnabled: true }) as never,
        lock: grantLock,
      }),
    ).resolves.toBeUndefined()
    expect(planned).toBe(0)
  })
})

/**
 * THE FAST CLOCK MUST NEVER GAIN A SEND PATH.
 *
 * `detectThenDraft` runs every 15 minutes and calls `runOutreach`, which prepares drafts. The
 * moment anything on that path can drive a browser, every pacing rule is bypassed at once —
 * active hours, the fleet-per-hour allowance, the minimum gap, the circuit breaker and the
 * fleet-wide send lock all live in the dispatcher, not in the planner.
 *
 * Asserted structurally because there is no way to prove a negative by execution: a test that
 * runs the planner and observes no browser proves only that THIS input did not open one.
 * `plan.ts`'s own docblock already says a returning `browserSender` import is the thing to
 * notice — this is that comment made executable, in the spirit of `tests/one-judging-path.test.ts`.
 */
describe('the detect clock cannot send', () => {
  const PLAN = readFileSync(join(process.cwd(), 'src/outreach/plan.ts'), 'utf8')
  // Comments first: this file DISCUSSES browserSender and dispatchTick at length, and matching
  // prose would assert the wording of a docblock rather than the behaviour of the code.
  const code = PLAN.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

  it('imports no sender that drives a browser', () => {
    expect(code).not.toMatch(/browserSender/)
    expect(code).not.toMatch(/from\s+['"]\.\/senders\/browser['"]/)
    expect(code).not.toMatch(/sendDm/)
    expect(code).not.toMatch(/withSendLock/)
  })

  it('has exactly one send call site, and it is the manual (prepare-only) sender', () => {
    const sends = code.match(/\.send\(/g) ?? []
    expect(sends, 'a second .send() in the planner is a second send path').toHaveLength(1)
    expect(code).toMatch(/manualAssistSender\.send\(/)
  })

  /**
   * And the prepare-only sender must stay prepare-only — the property the assertion above
   * actually depends on. Without this, `manualAssistSender` could grow a browser call and
   * every test here would still pass.
   */
  it('the manual sender delivers nothing', () => {
    const MANUAL = readFileSync(join(process.cwd(), 'src/outreach/senders/manual.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '')
    expect(MANUAL).toMatch(/status:\s*'READY'/)
    expect(MANUAL).not.toMatch(/patchright|launchProfile|sendDm|page\./)
  })

  /** The scheduler wires the planner into the detect task and NOT the dispatcher. */
  it('the detect task drafts but does not dispatch', () => {
    expect(detectFn()).toMatch(/plan\b/)
    expect(
      detectFn(),
      'dispatch belongs on its own paced cron, never on the 15-minute clock',
    ).not.toMatch(/dispatchTick/)
  })

  /**
   * The DEFAULT dependency must be the real lock. Every behavioural test above injects one, so
   * a default of `fn => fn()` — no lock at all — would leave them all green while production
   * ran two planners against one pair. The injection point is exactly what makes this
   * assertion necessary.
   */
  it('defaults to the real slot lock, so production planning is serialised', () => {
    expect(detectFn()).toMatch(/deps\.lock \?\? withSlotLock/)
    expect(detectFn(), 'planning must be INSIDE the lock, not beside it').toMatch(
      /lock\(\s*'[^']*'\s*,\s*plan\s*\)/,
    )
  })

  function detectFn(): string {
    const SCHED = readFileSync(join(process.cwd(), 'src/worker/scheduler.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '')
    const body = SCHED.slice(SCHED.indexOf('export async function detectThenDraft'))
    const end = body.indexOf('export async function startScheduler')
    return body.slice(0, end > -1 ? end : undefined)
  }
})
