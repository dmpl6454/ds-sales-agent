import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * THE DEVICE POLL IS A PERIOD, NOT IDLE TIME AFTER A SEND — 2026-08-22.
 *
 * ── THE MEASUREMENT ───────────────────────────────────────────────────────
 *
 * Tabish: *"autopilot is not sending every minute (monitor and verify this claim)."* He was
 * right. 473 consecutive intervals from the live fleet:
 *
 *     min 73s   p50 77s   p90 81s   439/473 inside 90s
 *
 * A distribution that tight is an equation. The loop was `await tick()` then an
 * unconditional `sleep(30s)`, so the wait was ADDITIVE to the ~47s a send spends driving a
 * browser:
 *
 *     period = drive (47s) + poll (30s) = 77s = ~47/hour
 *
 * i.e. `fleetMinGapMinutes = 1` could not produce a one-minute cadence at ANY value,
 * because the loop added half a minute after the gap had already been satisfied. This is
 * the SAME defect fixed one layer up the day before — the fleet gap measured from a send's
 * completion rather than its start — surviving inside the sleep that wraps it. And
 * `agent/index.ts`'s own docblock asserted the opposite, which is why it went unseen.
 *
 * ── WHY THIS FILE IS BEHAVIOURAL AND NOT A GREP ───────────────────────────
 *
 * A source grep for `POLL_INTERVAL_MS` passes against BOTH shapes: the additive version and
 * the remainder version both mention the constant. The bug is in the arithmetic around it,
 * which only running it can show. Same reason `gapClock` was extracted last night: a grep
 * cannot see which branch of a comparison returns.
 */

const root = join(import.meta.dirname, '..')
const read = (p: string) => readFileSync(join(root, p), 'utf8')

/**
 * The loop's pacing rule, extracted as the pure arithmetic it is. Kept beside the assertions
 * rather than imported, because the real loop is a `while` inside a function that also opens
 * browsers — this is the decision it makes, driven in both directions.
 */
const sleepAfterTick = (pollMs: number, tickTookMs: number): number => Math.max(0, pollMs - tickTookMs)

describe('the poll sleeps the REMAINDER, so it never adds to a send', () => {
  const POLL = 30_000

  it('a ~47s send leaves NO sleep — the gap alone then decides', () => {
    expect(sleepAfterTick(POLL, 47_000)).toBe(0)
  })

  it('the period after a send is the send itself, not send + poll', () => {
    const drive = 47_000
    const period = drive + sleepAfterTick(POLL, drive)
    expect(period).toBe(47_000)
    /* The old shape, for the record: this is the 77s that was measured. */
    expect(drive + POLL).toBe(77_000)
    expect(period).toBeLessThan(drive + POLL)
  })

  it('an IDLE tick still waits its full poll — polling gets no busier', () => {
    expect(sleepAfterTick(POLL, 800)).toBe(29_200)
    expect(sleepAfterTick(POLL, 0)).toBe(POLL)
  })

  it('a tick slower than the poll never sleeps a negative amount', () => {
    expect(sleepAfterTick(POLL, 120_000)).toBe(0)
  })

  /**
   * THE SAFETY PROPERTY, and it is the point of the whole change: removing the additive
   * wait cannot make the fleet send faster than the gap, because the gap is a REFUSAL
   * inside the tick rather than a property of this sleep. Asserted against the real
   * `decideDispatch` so it is the enforcer's own answer.
   */
  it('the fleet still cannot send inside the gap — the loop is not the ceiling', async () => {
    const { decideDispatch, FLEET_MIN_GAP_MINUTES } = await import('@/outreach/pacing')
    const base = {
      autopilotEnabled: true,
      breaker: { tripped: false as const, detail: null },
      istHour: 14,
      waitingCount: 40,
      minGapMinutes: FLEET_MIN_GAP_MINUTES,
    }
    /* Zero minutes since the last send START: refused, however eagerly the loop returns. */
    const tooSoon = decideDispatch({ ...base, minutesSinceLastSend: 0 })
    expect(tooSoon.action).toBe('hold')
    if (tooSoon.action === 'hold') expect(tooSoon.reason).toBe('too-soon')
    /* And at the gap it proceeds — so the gap is the lever, which is the invariant restored. */
    expect(decideDispatch({ ...base, minutesSinceLastSend: FLEET_MIN_GAP_MINUTES }).action).toBe('send')
  })
})

describe('the loop as written', () => {
  const src = read('src/agent/index.ts')

  /**
   * The regression in one line. `POLL_INTERVAL_MS` appears in both the broken and the fixed
   * shape, so this asserts the SUBTRACTION exists and that no unconditional sleep of the
   * whole interval remains next to the tick.
   */
  it('takes its wait from nextPollWait, with the elapsed time and whether the tick drove', () => {
    const loop = src.slice(src.indexOf('while (!stopping)'), src.indexOf('clearInterval(presence)'))
    expect(loop).toMatch(/nextPollWait\(\{ pollMs: POLL_INTERVAL_MS, elapsedMs: Date\.now\(\) - startedAt, drove, retryInMs \}\)/)
    expect(loop).toMatch(/drove = r\.drove === true/)
    expect(loop).toMatch(/if \(wait > 0\)/)
    /* The old, additive line must be gone rather than merely shadowed. */
    expect(loop).not.toMatch(/setTimeout\(r, POLL_INTERVAL_MS\)/)
  })

  it('still logs a failed tick and still cannot exit the loop on one', () => {
    const loop = src.slice(src.indexOf('while (!stopping)'), src.indexOf('clearInterval(presence)'))
    expect(loop).toMatch(/catch \(err\)/)
    expect(loop).toMatch(/device tick failed/)
  })

  /**
   * The docblock claimed "at 30s the gap is what paces the fleet rather than this timer"
   * while the timer was, in fact, pacing the fleet. A stale invariant in a comment is how
   * this survived a week, so the correction is pinned too.
   */
  it('the docblock no longer asserts the invariant it used to break', () => {
    expect(src).toMatch(/false invariant stated in a comment|the claim this docblock used to make was false/i)
    expect(src).toMatch(/POLL FLOOR for idle ticks, not the pace/)
  })
})

/**
 * AND THE TWO UNBOUNDED FETCHES THAT HUNG THE BRAND PASS FOR 70 MINUTES (same morning).
 *
 * `feed.ts` learned that `fetch` has no default timeout and bounded itself at 12s, with a
 * docblock recording PARTIAL slots that ran up to 6.85 hours. The lesson reached that file
 * and not the two other callers of the same endpoints. MEASURED: the Mac's network dropped,
 * `enrichHandle`'s lookup hung, and `brandPassRunning` stayed true for 70+ minutes — so
 * brand discovery AND the badge door were skipped every 30 minutes while the log honestly
 * said "still running from the last pass". It recovered only because the socket eventually
 * errored; a stalled socket would have wedged both passes forever, silently.
 */
describe('every anonymous lookup is bounded', () => {
  /**
   * COMMENTS STRIPPED FIRST, and finding that out is the point.
   *
   * The first version of this counted `await fetch(` over the raw source and failed on
   * `resolveBrand.ts` — which has exactly ONE real call and a DOCBLOCK that says "…shipped
   * precisely because this logic sat inside an `await fetch()`". Prose about a fetch is not
   * a fetch, and a checker that cannot tell the difference cries wolf and gets deleted.
   * Measure the property, not the artefact — the same correction the OCR recall figure
   * needed when whitespace read as a reading failure.
   */
  const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

  it.each([
    ['src/detection/enrichHandle.ts', 'i.instagram.com feed lookup'],
    ['src/detection/resolveBrand.ts', 'web_profile_info lookup'],
    ['src/detection/feed.ts', 'the feed itself'],
  ])('%s bounds its fetch', (file) => {
    const src = code(read(file))
    // igGet is the Instagram transport since 8 Sept 2026 (node:https — Node's fetch adds Sec-Fetch headers the app identity must not carry)
    const fetches = [...src.matchAll(/await (fetch|igGet)\(/g)]
    expect(fetches.length, 'no fetch found — this check would pass vacuously').toBeGreaterThan(0)
    /* Every fetch call in these files must carry the shared timeout. */
    const bounded = [...src.matchAll(/(AbortSignal\.timeout\(REQUEST_TIMEOUT_MS\)|timeoutMs: REQUEST_TIMEOUT_MS)/g)]
    expect(bounded.length).toBeGreaterThanOrEqual(fetches.length)
  })

  /** And the stripper itself must work, or the check above passes by erasing everything. */
  it('the comment stripper keeps code and drops prose', () => {
    expect(code('/* await fetch( in prose */\nawait fetch(x)')).toMatch(/await fetch\(x\)/)
    expect([...code('/* await fetch( */\nawait fetch(x)').matchAll(/await fetch\(/g)]).toHaveLength(1)
  })

  it('the timeout is ONE constant, not three copies', async () => {
    const { REQUEST_TIMEOUT_MS } = await import('@/detection/feed')
    expect(REQUEST_TIMEOUT_MS).toBe(12_000)
    for (const f of ['src/detection/enrichHandle.ts', 'src/detection/resolveBrand.ts']) {
      expect(read(f), `${f} must import the constant, not redeclare it`).toMatch(
        /import \{[^}]*REQUEST_TIMEOUT_MS[^}]*\} from '\.\/feed'/,
      )
      expect(read(f)).not.toMatch(/const REQUEST_TIMEOUT_MS/)
    }
  })
})

/**
 * THE PLANNER SAYS WHY IT SKIPPED, not just how many.
 *
 * It logged `skipped=861` and nothing else — the exact failure the dispatcher's
 * `holdReasons` exists to fix, one level up and worse, because the planner is where a
 * message either comes into existence or does not. Asked "why is the queue empty when 39
 * recipients have allowance room", the logs could not answer: every reason had been
 * computed, recorded on the outcome, and thrown away at the one place a person reads.
 */
describe('the planner explains a quiet pass', () => {
  it('logs skips grouped by reason', () => {
    const src = read('src/outreach/plan.ts')
    expect(src).toMatch(/outreach skips by reason/)
    const block = src.slice(src.indexOf('outreach skips by reason') - 900, src.indexOf('outreach skips by reason') + 400)
    expect(block).toMatch(/o\.skipReason \?\? 'unrecorded'/)
  })

  it('every skip path records a reason, so the grouping cannot report "unrecorded"', () => {
    const src = read('src/outreach/plan.ts')
    const pushes = [...src.matchAll(/outcomes\.push\(\{[^}]*eligible: false[^}]*\}/gs)]
    expect(pushes.length).toBeGreaterThan(0)
    for (const p of pushes) expect(p[0], 'a skip with no reason').toMatch(/skipReason/)
  })
})

/** Silence the unused-import lint in environments that check it. */
void vi

/**
 * AND THE INBOX SCAN IS BOUNDED TOO (2026-08-22).
 *
 * It is the newest browser drive inside the reply sweep, and the sweep holds the fleet-wide
 * SEND LOCK for its whole run — so a hung scan does not merely delay reading, it stops the
 * fleet sending. Per-navigation timeouts do not bound the `page.evaluate` scroll loop.
 * Measured the same morning: an unbounded lookup in the brand pass wedged that pass for
 * 70+ minutes behind its own "still running" flag.
 */
describe('the inbox scan cannot hang the sweep', () => {
  const src = read('src/outreach/browser/inboxScan.ts')

  it('has a deadline that closes the context', () => {
    expect(src).toMatch(/SCAN_DEADLINE_MS/)
    expect(src).toMatch(/setTimeout\(\(\) => \{[\s\S]*?context\.close\(\)/)
  })

  it('matches the thread reader rather than inventing a second number', async () => {
    const { SCAN_DEADLINE_MS } = await import('@/outreach/browser/inboxScan')
    const { READ_DEADLINE_MS } = await import('@/outreach/browser/readThread')
    expect(SCAN_DEADLINE_MS).toBe(READ_DEADLINE_MS)
  })

  /**
   * THE ASSERTION CARRYING REAL WEIGHT. Closing a context mid-flight throws Playwright text
   * we do not control, and `checkConversation` marks an account CHALLENGED on
   * /checkpoint|challenge|suspend/i — which halts the WHOLE FLEET through the breaker. A
   * network stall must never be able to flag a healthy revenue account.
   */
  it('a deadline is unreadable, and is decided BEFORE the checkpoint branch', () => {
    const cat = src.slice(src.indexOf('} catch (err) {'), src.indexOf('} finally {'))
    expect(cat).toMatch(/if \(deadlineFired\)/)
    expect(cat.indexOf('deadlineFired')).toBeLessThan(cat.indexOf('CheckpointError'))
    expect(cat).toMatch(/reason: 'unreadable'/)
  })

  /** A timeout must never read as "nobody has written to us". */
  it('never returns an empty-inbox success on failure', () => {
    const cat = src.slice(src.indexOf('} catch (err) {'), src.indexOf('} finally {'))
    expect(cat).not.toMatch(/ok: true/)
  })
})

/**
 * ── THE REMAINDER ALONE WAS STILL 77s: THE GRID (measured 2026-08-22, same day) ──
 *
 * First live interval after the remainder fix: 77s again. A ~47s drive puts the next tick
 * at +47s — held, 13s before the 60s gap clears — and the following grid tick at +77s.
 * "Expected ~60s" was written without walking that arithmetic; one measured interval
 * disproved it. The dispatcher now returns `retryInMs` on a too-soon hold and the loop
 * sleeps exactly that long. These drive the composed arithmetic in the direction that
 * failed: the period must be max(drive, gap), not drive + grid-overshoot.
 */
describe('the loop wakes at the gap boundary, not on its grid', () => {
  const POLL = 30_000
  const GAP = 60_000

  /** The loop's wait rule, as written: the dispatcher's boundary wins when sooner. */
  const waitAfter = (tickTookMs: number, retryInMs?: number): number => {
    const remaining = POLL - tickTookMs
    return retryInMs !== undefined ? Math.min(Math.max(remaining, 0), Math.max(retryInMs, 0)) : Math.max(remaining, 0)
  }

  it('THE 77s CASE: a 47s drive then a held tick sleeps 13s, and the period is the GAP', () => {
    /* t=0 send starts; t=47 drive ends, loop returns instantly (remainder 0). */
    const afterDrive = waitAfter(47_000, undefined)
    expect(afterDrive).toBe(0)
    /* t=47 tick: held too-soon, gap clears at t=60 → dispatcher says 13s. */
    const heldWait = waitAfter(1_000, 13_000)
    expect(heldWait).toBe(13_000)
    /* Composed period: 47s drive + 0 + ~1s tick + 13s = the 60s gap, not 77. */
    expect(47_000 + afterDrive + 1_000 + heldWait).toBe(GAP + 1_000)
  })

  it('the hint can only wake the loop EARLIER, never later than the grid', () => {
    expect(waitAfter(1_000, 45_000)).toBe(29_000) // grid wins when the boundary is beyond it
    expect(waitAfter(1_000, 5_000)).toBe(5_000) // boundary wins when sooner
  })

  it('a garbage hint degrades to the plain poll, never to a negative sleep', () => {
    expect(waitAfter(1_000, -500)).toBe(0)
    expect(waitAfter(40_000, undefined)).toBe(0)
  })

  it('the dispatcher computes the boundary from the same clock its refusal read', () => {
    const src = read('src/outreach/dispatcher.ts')
    const hold = src.slice(src.indexOf("if (verdict.action === 'hold')"), src.indexOf('withSendLock(`dispatch:'))
    expect(hold).toMatch(/verdict\.reason === 'too-soon' && lastStart !== null/)
    expect(hold).toMatch(/lastStart\.getTime\(\) \+ settings\.fleetMinGapMinutes \* 60_000/)
    expect(hold).toMatch(/Math\.max\(0, clearsAt - at\.getTime\(\)\)/)
  })

  it('the agent consumes the hint with min(), so it cannot extend the wait', () => {
    /* Moved into the pure `nextPollWait` (2026-10-09), where the property is also driven by
       behaviour below: a 90 s hint cannot stretch a 30 s wait. */
    expect(read('src/agent/pollWait.ts')).toMatch(/retryInMs !== undefined \? Math\.min\(/)
    expect(read('src/agent/index.ts')).toMatch(/nextPollWait\(/)
  })
})

/**
 * ── THE REMAINDER IS FOR SENDS ONLY (2026-10-09) ────────────────────────────
 *
 * The remainder rule above exists so a ~47 s SEND leaves nothing to wait for. Applied to every
 * tick, it let a long all-held evaluation (the whole queue through the gate, under the fleet
 * lock, over the tunnel) restart at once, so the lock was held almost continuously and the reply
 * sweep and disk care in the same process only ran by luck. These drive the real rule.
 */
describe('nextPollWait — the remainder after a drive, the full interval otherwise', async () => {
  const { nextPollWait } = await import('@/agent/pollWait')
  const POLL = 30_000

  it('after a send, sleeps only the remainder — the 77 s fix is intact', () => {
    expect(nextPollWait({ pollMs: POLL, elapsedMs: 47_000, drove: true })).toBe(0)
    expect(nextPollWait({ pollMs: POLL, elapsedMs: 10_000, drove: true })).toBe(20_000)
  })

  it('after a long tick that drove NOTHING, waits the full interval — the lock is left free', () => {
    expect(nextPollWait({ pollMs: POLL, elapsedMs: 180_000, drove: false })).toBe(POLL)
  })

  it('an idle tick waits the full interval, as before', () => {
    expect(nextPollWait({ pollMs: POLL, elapsedMs: 800, drove: false })).toBe(POLL)
  })

  it('the dispatcher\'s boundary still wakes the loop early, never late', () => {
    expect(nextPollWait({ pollMs: POLL, elapsedMs: 120_000, drove: false, retryInMs: 5_000 })).toBe(5_000)
    expect(nextPollWait({ pollMs: POLL, elapsedMs: 0, drove: false, retryInMs: 90_000 })).toBe(POLL)
    expect(nextPollWait({ pollMs: POLL, elapsedMs: 0, drove: true, retryInMs: -5 })).toBe(0)
  })
})
