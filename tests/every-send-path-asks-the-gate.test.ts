import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT_DIR = resolve(__dirname, '..')
const readRaw = (p: string) => readFileSync(join(ROOT_DIR, p), 'utf8')

/**
 * CODE ONLY — comments and string literals stripped.
 *
 * The first version of this file grepped the raw source, and its own mutation test PASSED
 * against a `send.ts` with the gate call replaced by `{ ok: true }` — because the docblock
 * ABOVE that line still contained the word `recheckBeforeSend`. A grep proves a name is
 * MENTIONED; only reading the code proves it is CALLED, and this repo has recorded that
 * exact failure once already (`tests/autopilot-off-drives-no-browser.test.ts`, where a
 * source check passed against the edit that reopened the hole).
 */
function read(p: string): string {
  return readRaw(p)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
}

/**
 * ── EVERY PATH THAT DELIVERS A MESSAGE ASKS `recheckBeforeSend` ────────────
 *
 * *"One gate, two callers. Never re-inline it."* is CLAUDE.md's own rule, written after
 * `deliverWaiting` and `sendNow` drifted: one checked eight conditions and the other three,
 * and the five it lacked included `optedOut` and *they replied*.
 *
 * A THIRD CALLER EXISTED THE WHOLE TIME AND NEVER HAD THE GATE AT ALL. MEASURED 2026-08-26:
 * `src/scripts/send.ts` — `pnpm send`, the documented manual fallback offered on every card
 * — took `attempts[0]` from a `queuedAt asc` query with no predicate, copied the body to the
 * clipboard, opened the profile and recorded SENT. No opt-out check, no verified check, no
 * watch-only check, no reply halt, no fleet rule.
 *
 * ── AND THE ORDERING MADE IT SELECT FOR THE WORST DRAFT ───────────────────
 *
 * A draft the gate holds permanently never has its `queuedAt` bumped — only a retryable
 * failure does that (`deliver.ts`) — and the planner will not replace it while
 * `hasPendingAttempt` is true. So it drifts to the FRONT of an ascending queue and stays
 * there. The one ungated path therefore preferentially offered the exact draft every other
 * path refuses, and on the live queue that day it was precisely the cross-fleet one.
 *
 * A SOURCE GREP, because the failure mode is a caller that stops asking — or a fourth one
 * somebody writes next month. No behavioural test can fail for a call site nobody has
 * written yet, which is the same reason `tests/one-route-rule.test.ts` and
 * `tests/visible-channels.test.ts` are greps.
 */

/** Turning a draft into a delivered message. Anything calling these is a send path. */
const DELIVERY_WRITERS = /recordDelivered\(|browserSender\.send\(/

/**
 * A CALL, not a mention and not an import.
 *
 * The second version of this file asserted `src.includes('recheckBeforeSend')` and STILL
 * passed its mutation, because replacing the call with `{ ok: true }` leaves the import
 * line — which survives comment stripping. Two rounds of this file being wrong in the
 * permissive direction is why the pattern is anchored on the open bracket.
 */
const GATE_CALL = /recheckBeforeSend\s*\(/

/**
 * Files allowed to reach a delivery writer WITHOUT the gate, each for a stated reason.
 * Deliberately tiny and deliberately explicit: a denylist of "unsafe" files fails in the
 * dangerous direction the day somebody adds one, which is why `src/middleware.ts` lists
 * PUBLIC routes and `ig:prune` deletes from an allowlist.
 */
const EXEMPT: Record<string, string> = {
  'src/outreach/recordSend.ts': 'it IS the writer — the gate is asked by whoever calls it',
  'src/outreach/senders/browser.ts': 'the driver beneath deliverOne.ts, which gates before calling it',
  'src/outreach/senders/manual.ts': 'prepares only; it delivers nothing',
}

function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(join(ROOT_DIR, dir), { withFileTypes: true })) {
    if (entry.name === 'generated' || entry.name === 'node_modules') continue
    const rel = `${dir}/${entry.name}`
    if (entry.isDirectory()) out.push(...walk(rel))
    else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) out.push(rel)
  }
  return out
}

describe('every path that delivers a message asks the gate first', () => {
  const files = walk('src')

  it('finds the send paths at all — this test is worthless if the pattern matches nothing', () => {
    const hits = files.filter((f) => DELIVERY_WRITERS.test(read(f)))
    expect(hits.length, 'nothing in src delivers a message — the pattern has gone stale').toBeGreaterThan(2)
  })

  it('no file reaches a delivery writer without calling recheckBeforeSend', () => {
    const ungated = files.filter((f) => {
      if (f in EXEMPT) return false
      const src = read(f)
      return DELIVERY_WRITERS.test(src) && !GATE_CALL.test(src)
    })
    expect(
      ungated,
      'a send path skips the gate — every recipient rule (opt-out, verified, watch-only, ' +
        'the reply halt, the fleet rule) is absent from it',
    ).toEqual([])
  })

  /**
   * The known callers, named. If one disappears the rule has not been weakened — but
   * something has moved, and this says which, rather than the count quietly falling.
   *
   * STAGE 1.3 MOVED THE FIRST ONE. The dispatcher's loop and the Send button used to each carry
   * their own delivery, and each called the gate; they now share `deliverOne`, which asks it
   * under the lock for both. `actions.ts` still names it, deliberately: `sendNow` asks it once
   * more BEFORE the lock, as the first refusal, so a draft the gate would refuse is answered
   * with the gate's own sentence even when the lock is refused too (the hosted dashboard's lock
   * always is). That call guards nothing the one in `deliverOne` does not — it is there for the
   * words — and `actions.ts` also holds `markSent`'s `recordDelivered`, which is why it could
   * not simply drop the call without becoming an exemption here.
   */
  it.each([
    ['src/outreach/deliverOne.ts', 'the one delivery function (dispatcher + Send button)'],
    ['src/app/actions.ts', "the Send button's first refusal, before the lock"],
    ['src/scripts/send.ts', 'pnpm send, the manual clipboard fallback'],
  ])('%s still asks it (%s)', (file) => {
    expect(read(file), 'it imports the gate but never calls it').toMatch(GATE_CALL)
  })

  /**
   * And the loop is a CALLER of the one function, not a second delivery path: it holds no
   * delivery writer of its own. This is the half of the Stage 1.3 refactor a grep can pin — the
   * day somebody re-inlines a `browserSender.send(` or a `recordDelivered(` here, the two
   * callers have drifted again, and the check above would not notice (the gate call would
   * simply have moved with it).
   */
  it('deliver.ts is the loop: it calls deliverOne and writes no delivery of its own', () => {
    const loop = read('src/outreach/deliver.ts')
    expect(loop, 'the loop no longer calls the one delivery function').toMatch(/\bdeliverOne\s*\(/)
    expect(loop, 'the loop has grown a delivery writer of its own').not.toMatch(DELIVERY_WRITERS)
    expect(loop, 'the loop has grown a gate call of its own').not.toMatch(GATE_CALL)
    // And the Send button reaches its drive through the same function.
    expect(read('src/app/actions.ts'), 'sendNow no longer delivers through deliverOne').toMatch(/\bdeliverOne\s*\(/)
    expect(read('src/app/actions.ts'), 'sendNow drives a browser itself again').not.toMatch(/browserSender\.send\(/)
  })

  /**
   * And `pnpm send` must SKIP a held draft rather than stopping at it — otherwise a single
   * permanently-held draft at the front of the queue makes the command useless, which is a
   * different bug with the same cause.
   */
  it('pnpm send walks past a held draft instead of halting on the first one', () => {
    const src = read('src/scripts/send.ts')
    expect(src, 'it no longer loops over the candidates').toMatch(/for \(const candidate of attempts\)/)
    expect(src, 'it no longer reports why a draft was skipped').toMatch(/verdict\.reason/)
  })
})
