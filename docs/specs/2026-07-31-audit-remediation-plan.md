# Audit Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the 28 findings in `docs/AUDIT-2026-07-31.md` and make the send path work correctly on both macOS and Windows, without weakening a single safety guard.

**Architecture:** The audit's dominant pattern is *a control implemented in one of the two places that needed it* — six findings share that root cause. So the core of this plan is not 28 separate patches; it is extracting the duplicated logic into one **pure** decision function with a thin DB-gathering wrapper, mirroring the existing `governor.ts` / `plan.ts` split. Purity is what makes both directions testable, which is the discipline this codebase runs on. Platform differences are isolated behind two small adapters rather than sprinkled through the send path.

**Tech Stack:** TypeScript (ESM only — never `require`), Next.js 16, Prisma 7 + SQLite via driver adapter, Patchright (never stock Playwright), vitest, node-cron, pnpm.

---

## Read before starting

- `CLAUDE.md` in full, including Gotchas. It records failures that already happened.
- `docs/AUDIT-2026-07-31.md` — finding IDs (`C-1`, `H-3`, `D-6`…) are referenced throughout.

**Non-negotiables for every task in this plan:**

1. **Never disable a guard to make something pass.** If a change makes a guard fire, the guard is probably right.
2. **Verify both directions.** Every guard gets a test that it *fires* and a test that it *does not*. Eight findings in this codebase's history come from testing only the passing case.
3. **ESM only.** Static `import`, never `require` — it works in the Next bundle and throws under `tsx`.
4. **Do not touch** `headless: false`, `channel: 'chrome'`, Patchright, or the hand-login-only rule.
5. `pnpm test` must stay green (124 tests at start; this plan adds 41).
6. Never run `pnpm build` while `pnpm start` is running.

**Where automated tests are and aren't possible.** The suite covers pure functions only — `governor`, `matching`, `render`, `detectors`, `urls`. There is no DB or component harness. So tasks touching `actions.ts`, `deliver.ts` and `plan.ts` specify **scripted verification against `prisma/dev.db`**, which is this project's actual verification idiom (it is how the audit was conducted). Building a DB harness is deliberately out of scope; introducing one mid-remediation would be a second large change landing on top of a safety fix.

---

## File Structure

**New files**

| File | Responsibility |
|---|---|
| `src/outreach/gate.ts` | **Pure** re-check: may this already-drafted attempt be sent *now*. The single source of truth shared by `sendNow` and `deliverWaiting`. No DB, no clock, no env — every input passed in. |
| `src/lib/platform.ts` | The only place that branches on `process.platform`. Clipboard write + "open a URL". Two functions, nothing else. |
| `tests/gate.test.ts` | Both directions for every rule in `gate.ts`. |
| `tests/platform.test.ts` | Clipboard round-trip including `U+2014`, and the paste-key mapping. |
| `docs/RUNBOOK.md` | Operator setup for macOS and Windows: prerequisites, first run, connecting an account, what to do when an account is halted. |

**Modified files**

| File | Change |
|---|---|
| `package.json` | `start`/`dev` bind loopback |
| `src/app/actions.ts` | atomic claim; call the shared gate; status guards on `skipAttempt`/`markSent`; explicit CHALLENGED acknowledgement |
| `src/outreach/deliver.ts` | call the shared gate instead of its own inline block |
| `src/outreach/plan.ts` | status filter on `usedCampaignIds`; audit row in `applyOutcome`; inter-send delay; `sentBy` provenance |
| `src/outreach/matching.ts` | needle selection never falls back to the greeting |
| `src/outreach/browser/profile.ts` | `hasSession` requires `sessionid` |
| `src/outreach/browser/session.ts` | 2FA is its own state; DOM-based enforcement detection |
| `src/outreach/browser/sendDm.ts` | platform paste key; use `src/lib/platform.ts` |
| `src/outreach/browser/connect.ts` | stale-session sweeper on a timer |
| `src/lib/clipboard.ts` | delegates to `src/lib/platform.ts` |
| `src/scripts/send.ts` | platform URL open |
| `src/worker/runSlot.ts` | advisory slot lock |
| `prisma/schema.prisma` | `cooldownDays` default 5 → 7 |
| `src/app/accounts.tsx` | surface the `MutationResult` from a route toggle |
| `tests/matching.test.ts` | the short-multi-line-body cases that were missing |

---

## Phase 0 — Make the environment safe to work in

Do this first. Everything after it involves running the app, and right now running the app publishes a send button.

### Task 0.1: Bind the dashboard to loopback (C-1)

**Files:**
- Modify: `package.json` (the `dev` and `start` scripts)

- [ ] **Step 1: Confirm the current exposure, so the fix is provably a fix**

Run:
```bash
lsof -nP -iTCP:3000 -sTCP:LISTEN
```
Expected: a line containing `TCP *:3000 (LISTEN)` — the `*` is the bug.

- [ ] **Step 2: Change both scripts to bind 127.0.0.1**

In `package.json`, replace these two lines:
```json
    "dev": "next dev",
    "start": "next start",
```
with:
```json
    "dev": "next dev -H 127.0.0.1",
    "start": "next start -H 127.0.0.1",
```

- [ ] **Step 3: Restart and verify the bind changed**

Run:
```bash
kill $(lsof -nP -iTCP:3000 -sTCP:LISTEN -t) 2>/dev/null; sleep 3
pnpm start &
sleep 12
lsof -nP -iTCP:3000 -sTCP:LISTEN
```
Expected: `TCP 127.0.0.1:3000 (LISTEN)` — no `*`.

- [ ] **Step 4: Verify the negative direction — it must NOT answer on the LAN**

Run (substitute your own LAN IP from `ipconfig getifaddr en0`):
```bash
curl -s -o /dev/null -w "localhost -> %{http_code}\n" --max-time 6 http://127.0.0.1:3000/
curl -s -o /dev/null -w "LAN      -> %{http_code}\n" --max-time 6 http://$(ipconfig getifaddr en0):3000/
```
Expected:
```
localhost -> 200
LAN      -> 000
```
`000` is curl's "could not connect". A `200` on the second line means the fix did not take — do not proceed.

- [ ] **Step 5: Commit**

```bash
git add package.json
git commit -m "fix: bind dashboard to loopback only

The dashboard served Send-from-<revenue-account> buttons, the Autopilot
toggle and Remove controls to the entire local network with no auth and no
middleware. actions.ts already reasons about this for AUTOPILOT_ENABLED
('anyone who can reach it can call this action') and that reasoning stops at
one switch.

Verified: 127.0.0.1 -> 200, LAN IP -> refused."
```

### Task 0.2: Discard the three identical drafts (M-4)

Three `READY` attempts hold byte-identical 534-char bodies to the same recipient from three different senders. That is the repetition pattern decision 3 exists to prevent, and they sit behind live Send buttons.

**Files:** none — this is a data change via the existing operator path.

- [ ] **Step 1: Confirm what is there**

Run:
```bash
sqlite3 prisma/dev.db -header -column "
SELECT s.handle AS sender, t.handle AS target, a.status, length(a.renderedBody) AS chars
FROM OutreachAttempt a
JOIN OutreachPair p ON p.id=a.pairId
JOIN SenderAccount s ON s.id=p.senderId
JOIN TargetAccount t ON t.id=p.targetId
WHERE a.status='READY';"
```
Expected: three rows, all `chars=534`, all targeting `priyanshu123321123`.

- [ ] **Step 2: Discard them, preserving history**

`SKIPPED` is the correct status — it is what `pnpm burner on` uses for exactly this, and it keeps the row. Do **not** delete.

```bash
sqlite3 prisma/dev.db "
UPDATE OutreachAttempt
SET status='SKIPPED', error='discarded: identical body across three senders (audit M-4)'
WHERE status='READY';"
```

- [ ] **Step 3: Verify nothing is waiting and history is intact**

Run:
```bash
sqlite3 prisma/dev.db "SELECT status, count(*) FROM OutreachAttempt GROUP BY status;"
```
Expected: `READY` is absent; `SENT=2`, `REPLIED=1` unchanged, `SKIPPED` up by 3.

- [ ] **Step 4: Fix the seed so it cannot recur**

In `prisma/bespoke.ts`, the three test bodies aimed at the burner are identical. Give each a distinct body. Read the header comment in that file first — it explains why these are per-recipient.

- [ ] **Step 5: Commit**

```bash
git add prisma/bespoke.ts
git commit -m "fix: distinct bespoke test bodies per sender

Three senders had byte-identical 534-char bodies to one recipient sitting
READY. Sending them would have delivered the same message three times from
three accounts - the exact repetition Meta's spam policy penalises and what
decision 3 exists to prevent. Drafts discarded as SKIPPED (history kept)."
```

---

## Phase 1 — One gate, two callers (H-1, H-2, M-2, M-8, M-9)

The root-cause phase. `deliverWaiting` re-checks eight conditions; `sendNow` checks three. Rather than copy five checks into `sendNow` — which would leave two copies to drift again — extract one pure function and call it from both.

### Task 1.1: Create the pure re-check gate

**Files:**
- Create: `src/outreach/gate.ts`
- Test: `tests/gate.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/gate.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { evaluateResend, RESEND_BLOCKS, type ResendInput } from '@/outreach/gate'

/** A state where sending is permitted. Each test breaks exactly one thing. */
function ok(): ResendInput {
  return {
    attemptStatus: 'READY',
    unattended: false,
    pairEnabled: true,
    senderStatus: 'ACTIVE',
    senderAutoSendEnabled: false,
    senderHasSession: true,
    targetOptedOut: false,
    targetRepliedAt: null,
    targetSentTodayCount: 0,
    senderSentTodayCount: 0,
    maxPerTargetPerDay: 2,
    senderDailyCap: 5,
  }
}

describe('evaluateResend — the permitted case', () => {
  it('allows a READY attempt when nothing has changed', () => {
    expect(evaluateResend(ok())).toEqual({ ok: true })
  })

  it('allows a QUEUED attempt too', () => {
    expect(evaluateResend({ ...ok(), attemptStatus: 'QUEUED' })).toEqual({ ok: true })
  })

  it('allows an unattended send when the account is armed', () => {
    expect(evaluateResend({ ...ok(), unattended: true, senderAutoSendEnabled: true })).toEqual({ ok: true })
  })
})

describe('evaluateResend — blocks that the dashboard button used to bypass', () => {
  it('blocks when the target has replied', () => {
    const r = evaluateResend({ ...ok(), targetRepliedAt: new Date('2026-07-31T08:22:00Z') })
    expect(r).toMatchObject({ ok: false, reason: RESEND_BLOCKS.TARGET_REPLIED })
  })

  it('blocks when the target is opted out', () => {
    const r = evaluateResend({ ...ok(), targetOptedOut: true })
    expect(r).toMatchObject({ ok: false, reason: RESEND_BLOCKS.TARGET_OPTED_OUT })
  })

  it('blocks when the route is switched off', () => {
    const r = evaluateResend({ ...ok(), pairEnabled: false })
    expect(r).toMatchObject({ ok: false, reason: RESEND_BLOCKS.PAIR_DISABLED })
  })

  it('blocks when the target already had its allowance today', () => {
    const r = evaluateResend({ ...ok(), targetSentTodayCount: 2, maxPerTargetPerDay: 2 })
    expect(r).toMatchObject({ ok: false, reason: RESEND_BLOCKS.TARGET_DAILY_CAP })
  })

  it('blocks when the sender is at its own daily cap', () => {
    const r = evaluateResend({ ...ok(), senderSentTodayCount: 5, senderDailyCap: 5 })
    expect(r).toMatchObject({ ok: false, reason: RESEND_BLOCKS.SENDER_DAILY_CAP })
  })
})

describe('evaluateResend — blocks both callers already had', () => {
  it('blocks an attempt that is no longer waiting', () => {
    const r = evaluateResend({ ...ok(), attemptStatus: 'SENT' })
    expect(r).toMatchObject({ ok: false, reason: RESEND_BLOCKS.NOT_WAITING })
  })

  it('blocks a CHALLENGED sender', () => {
    const r = evaluateResend({ ...ok(), senderStatus: 'CHALLENGED' })
    expect(r).toMatchObject({ ok: false, reason: RESEND_BLOCKS.SENDER_NOT_ACTIVE })
  })

  it('blocks a disconnected profile', () => {
    const r = evaluateResend({ ...ok(), senderHasSession: false })
    expect(r).toMatchObject({ ok: false, reason: RESEND_BLOCKS.NO_SESSION })
  })
})

describe('evaluateResend — attended vs unattended', () => {
  it('requires auto-send ONLY when unattended', () => {
    const r = evaluateResend({ ...ok(), unattended: true, senderAutoSendEnabled: false })
    expect(r).toMatchObject({ ok: false, reason: RESEND_BLOCKS.AUTO_SEND_OFF })
  })

  it('does NOT require auto-send when a human clicked Send', () => {
    expect(evaluateResend({ ...ok(), unattended: false, senderAutoSendEnabled: false })).toEqual({ ok: true })
  })
})

describe('evaluateResend — precedence', () => {
  it('reports a reply ahead of a daily cap, because it is the more absolute stop', () => {
    const r = evaluateResend({
      ...ok(),
      targetRepliedAt: new Date('2026-07-31T08:22:00Z'),
      targetSentTodayCount: 9,
    })
    expect(r).toMatchObject({ reason: RESEND_BLOCKS.TARGET_REPLIED })
  })

  it('reports not-waiting ahead of everything, because nothing else can matter', () => {
    const r = evaluateResend({ ...ok(), attemptStatus: 'SENT', targetOptedOut: true, pairEnabled: false })
    expect(r).toMatchObject({ reason: RESEND_BLOCKS.NOT_WAITING })
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run tests/gate.test.ts`
Expected: FAIL — `Failed to resolve import "@/outreach/gate"`.

- [ ] **Step 3: Write the implementation**

Create `src/outreach/gate.ts`:

```ts
/**
 * May an ALREADY-DRAFTED attempt be sent right now?
 *
 * Distinct from `governor.ts`, which decides whether to *create* a message. This
 * decides whether a message that already exists is still permissible — a draft can
 * sit for days, and several things that were true when it was written may not be now.
 *
 * WHY THIS FILE EXISTS
 *
 * `deliverWaiting` re-checked eight conditions before delivering. `sendNow` — the
 * dashboard's Send button — checked three. The five it lacked included the two most
 * absolute stops in the system: `target.optedOut` and *the target has replied*. So
 * `removeTarget` told the operator a channel "can never be contacted again by
 * accident" while a draft's Send button still delivered, and recording a reply halted
 * autopilot but not the button beside it.
 *
 * Copying five checks into `sendNow` would have left two copies to drift apart again,
 * which is how this happened. One function, two callers.
 *
 * Deliberately PURE, like `governor.ts`: no DB, no clock, no env. Every input is
 * passed in, so every rule is testable in both directions — firing and not firing.
 * That matters more than usual here: this codebase has an eight-instance history of
 * guards that were verified only in the direction that passes.
 */

export interface ResendInput {
  /** Current status of the attempt. Only READY/QUEUED may be sent. */
  attemptStatus: string
  /**
   * True when nobody is present (autopilot). Attended sends do NOT require the
   * account's auto-send switch — that switch means "may send with nobody present",
   * and a human clicking Send is the presence it is asking about.
   */
  unattended: boolean

  pairEnabled: boolean
  senderStatus: string // ACTIVE | PAUSED | CHALLENGED
  senderAutoSendEnabled: boolean
  senderHasSession: boolean
  senderDailyCap: number

  targetOptedOut: boolean
  /** Any reply from this target to ANY of our senders. Halts all of them. */
  targetRepliedAt: Date | null

  targetSentTodayCount: number
  senderSentTodayCount: number
  maxPerTargetPerDay: number
}

export type ResendResult = { ok: true } | { ok: false; reason: string; detail?: string }

/** Stable strings so callers and logs can group them. */
export const RESEND_BLOCKS = {
  NOT_WAITING: 'not-waiting',
  SENDER_NOT_ACTIVE: 'sender-not-active',
  AUTO_SEND_OFF: 'auto-send-off',
  PAIR_DISABLED: 'pair-disabled',
  TARGET_OPTED_OUT: 'target-opted-out',
  TARGET_REPLIED: 'target-replied',
  NO_SESSION: 'no-session',
  TARGET_DAILY_CAP: 'target-daily-cap',
  SENDER_DAILY_CAP: 'sender-daily-cap',
} as const

export function evaluateResend(input: ResendInput): ResendResult {
  // Ordered most-absolute first, so the reason reported is the fundamental one.

  // Nothing else can matter if this attempt is not waiting to be sent. Also the
  // idempotency check — though callers MUST additionally claim it atomically; a
  // pure function cannot make a check-then-act sequence safe.
  if (input.attemptStatus !== 'READY' && input.attemptStatus !== 'QUEUED') {
    return {
      ok: false,
      reason: RESEND_BLOCKS.NOT_WAITING,
      detail: `already ${input.attemptStatus.toLowerCase()}`,
    }
  }

  if (input.senderStatus !== 'ACTIVE') {
    return {
      ok: false,
      reason: RESEND_BLOCKS.SENDER_NOT_ACTIVE,
      detail: `account is ${input.senderStatus}`,
    }
  }

  if (input.unattended && !input.senderAutoSendEnabled) {
    return { ok: false, reason: RESEND_BLOCKS.AUTO_SEND_OFF, detail: 'auto-send is off for this account' }
  }

  if (!input.pairEnabled) {
    return { ok: false, reason: RESEND_BLOCKS.PAIR_DISABLED, detail: 'this route is switched off' }
  }

  if (input.targetOptedOut) {
    return { ok: false, reason: RESEND_BLOCKS.TARGET_OPTED_OUT, detail: 'channel is retired' }
  }

  // A reply means a human conversation started. Continuing to fire a queued cold
  // pitch into it is the single most damaging thing this system could do, so it
  // halts every sender to this target, not just the one that got the reply.
  if (input.targetRepliedAt !== null) {
    return {
      ok: false,
      reason: RESEND_BLOCKS.TARGET_REPLIED,
      detail: `they replied at ${input.targetRepliedAt.toISOString()} — outreach to this channel is halted`,
    }
  }

  if (!input.senderHasSession) {
    return { ok: false, reason: RESEND_BLOCKS.NO_SESSION, detail: 'account is not connected' }
  }

  if (input.targetSentTodayCount >= input.maxPerTargetPerDay) {
    return {
      ok: false,
      reason: RESEND_BLOCKS.TARGET_DAILY_CAP,
      detail: `channel already received ${input.targetSentTodayCount} today`,
    }
  }

  if (input.senderSentTodayCount >= input.senderDailyCap) {
    return {
      ok: false,
      reason: RESEND_BLOCKS.SENDER_DAILY_CAP,
      detail: `account already sent ${input.senderSentTodayCount} today`,
    }
  }

  return { ok: true }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run tests/gate.test.ts`
Expected: PASS, 13 tests.

- [ ] **Step 5: Run the whole suite and typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: 137 passed (124 + 13); typecheck silent.

- [ ] **Step 6: Commit**

```bash
git add src/outreach/gate.ts tests/gate.test.ts
git commit -m "feat: pure re-check gate shared by both send paths

deliverWaiting re-checked eight conditions; sendNow checked three. The five
missing included target-replied and optedOut - the two most absolute stops.
Pure like governor.ts so both directions are testable."
```

### Task 1.2: Add the DB-gathering wrapper

**Files:**
- Modify: `src/outreach/gate.ts` (append)

- [ ] **Step 1: Append the wrapper**

Add to the bottom of `src/outreach/gate.ts`:

```ts
import { prisma } from '@/lib/db'
import { istDayStart } from '@/lib/time'
import { getSettings } from '@/lib/settings'
import { profileStatus } from './browser/profile'

/**
 * The attempt shape this needs. Structural rather than a Prisma generated type, so
 * both call sites satisfy it with the includes they already fetch.
 */
export interface ResendAttempt {
  id: string
  status: string
  pair: {
    enabled: boolean
    senderId: string
    targetId: string
    sender: { handle: string; status: string; autoSendEnabled: boolean; dailyCap: number }
    target: { optedOut: boolean }
  }
}

/**
 * Gathers the live inputs and applies `evaluateResend`.
 *
 * Kept separate from the decision so the rules stay unit-testable. This half is
 * queries only — if you find yourself adding an `if` here, it belongs in
 * `evaluateResend` with a test.
 */
export async function recheckBeforeSend(
  attempt: ResendAttempt,
  opts: { unattended: boolean },
): Promise<ResendResult> {
  const settings = await getSettings()
  const dayStart = istDayStart()
  const { sender, target, senderId, targetId } = attempt.pair

  const [replied, targetToday, senderToday] = await Promise.all([
    prisma.outreachAttempt.findFirst({
      where: { pair: { targetId }, repliedAt: { not: null } },
      orderBy: { repliedAt: 'desc' },
      select: { repliedAt: true },
    }),
    prisma.outreachAttempt.count({
      where: { pair: { targetId }, status: 'SENT', sentAt: { gte: dayStart } },
    }),
    prisma.outreachAttempt.count({
      where: { pair: { senderId }, status: 'SENT', sentAt: { gte: dayStart } },
    }),
  ])

  return evaluateResend({
    attemptStatus: attempt.status,
    unattended: opts.unattended,
    pairEnabled: attempt.pair.enabled,
    senderStatus: sender.status,
    senderAutoSendEnabled: sender.autoSendEnabled,
    senderHasSession: profileStatus(sender.handle).hasSession,
    senderDailyCap: sender.dailyCap,
    targetOptedOut: target.optedOut,
    targetRepliedAt: replied?.repliedAt ?? null,
    targetSentTodayCount: targetToday,
    senderSentTodayCount: senderToday,
    maxPerTargetPerDay: settings.maxPerTargetPerDay,
  })
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: silent.

- [ ] **Step 3: Commit**

```bash
git add src/outreach/gate.ts
git commit -m "feat: DB-gathering wrapper for the resend gate"
```

### Task 1.3: Make `sendNow` use the gate, and claim atomically (H-1, H-2)

**Files:**
- Modify: `src/app/actions.ts:70-96`

- [ ] **Step 1: Add the import**

At the top of `src/app/actions.ts`, alongside the existing imports:

```ts
import { recheckBeforeSend } from '@/outreach/gate'
```

- [ ] **Step 2: Replace the three guards and the non-atomic claim**

Replace this block (currently `actions.ts:75-97`, from `const { sender, target }` down to and including the `audit('attempt.send.start', …)` line):

```ts
  const { sender, target } = attempt.pair

  // Guard 1 — idempotency. Two clicks, or a click racing the worker, must not
  // produce two messages to a real prospect.
  if (attempt.status !== 'READY' && attempt.status !== 'QUEUED') {
    return { ok: false, message: `already ${attempt.status.toLowerCase()} — nothing sent` }
  }
  if (sender.status !== 'ACTIVE') {
    return { ok: false, message: `@${sender.handle} is ${sender.status} — sending is halted for this account` }
  }

  // Guard 2 — a profile that was never logged into by hand cannot send, and must
  // not be "fixed" by importing a session from somewhere else.
  const profile = profileStatus(sender.handle)
  if (!profile.hasSession) {
    return {
      ok: false,
      message: `@${sender.handle} is not connected yet. Press Connect on its row, and log in in the Chrome window that opens.`,
    }
  }

  await prisma.outreachAttempt.update({ where: { id: attemptId }, data: { status: 'SENDING' } })
  await audit('attempt.send.start', `OutreachAttempt:${attemptId}`, `@${sender.handle} → @${target.handle}`)
```

with:

```ts
  const { sender, target } = attempt.pair

  /**
   * The SAME re-check autopilot runs. This used to be three inline guards and it
   * silently lacked five that `deliverWaiting` enforced — including `optedOut` and
   * "they replied", the two most absolute stops in the system. A human clicking
   * Send is not a reason to skip them; it is a reason not to require the account's
   * unattended-sending switch, which is the only difference.
   */
  const gate = await recheckBeforeSend(attempt, { unattended: false })
  if (!gate.ok) {
    return { ok: false, message: gate.detail ?? gate.reason }
  }

  /**
   * Claim it ATOMICALLY. This was a check-then-act — read the status, then write
   * SENDING as a separate statement — under a comment asserting "a double click
   * cannot double send". Two clicks, two operators, or a click racing a slot's
   * deliverWaiting all passed the read before either wrote. `deliverWaiting` got
   * this right; the button did not. Condition and write in one statement.
   */
  const claimed = await prisma.outreachAttempt.updateMany({
    where: { id: attemptId, status: { in: ['READY', 'QUEUED'] } },
    data: { status: 'SENDING' },
  })
  if (claimed.count === 0) {
    const now = await prisma.outreachAttempt.findUnique({
      where: { id: attemptId },
      select: { status: true },
    })
    return { ok: false, message: `already ${(now?.status ?? 'gone').toLowerCase()} — nothing sent` }
  }

  await audit('attempt.send.start', `OutreachAttempt:${attemptId}`, `@${sender.handle} → @${target.handle}`)
```

- [ ] **Step 3: Fix the now-missing `profile` reference**

`profile.dir` was used at the `browserSender.send` call below. Replace that argument:

```ts
    sessionPath: profileStatus(sender.handle).dir,
```

- [ ] **Step 4: Typecheck**

Run: `pnpm typecheck`
Expected: silent. If it reports `profile` unused or undefined, Step 3 was missed.

- [ ] **Step 5: Verify the reply block now applies to the button**

This is the finding's core claim, so prove it rather than assume. `@bollywoodchronicle` has a recorded reply.

Create a temporary verification script `verify-gate.ts` in the project root:

```ts
import { prisma } from '@/lib/db'
import { recheckBeforeSend } from '@/outreach/gate'

const pair = await prisma.outreachPair.findFirstOrThrow({
  where: { sender: { handle: 'tabishmukaddam1' }, target: { handle: 'bollywoodchronicle' } },
  include: { sender: true, target: true },
})

// A hypothetical waiting attempt on a pair whose target HAS replied.
const fake = { id: 'probe', status: 'READY', pair }
console.log('attended  (dashboard Send):', await recheckBeforeSend(fake, { unattended: false }))
console.log('unattended (autopilot)   :', await recheckBeforeSend(fake, { unattended: true }))
await prisma.$disconnect()
```

Run: `pnpm tsx verify-gate.ts`
Expected: **both** lines report `ok: false` with `reason: 'target-replied'`. Before this task the attended line would have been `ok: true`.

- [ ] **Step 6: Remove the temporary script**

```bash
rm verify-gate.ts
```

- [ ] **Step 7: Commit**

```bash
git add src/app/actions.ts
git commit -m "fix: dashboard Send now runs the same gate as autopilot, and claims atomically

sendNow checked 3 conditions where deliverWaiting checked 8. The missing five
included target-replied and optedOut, so recording a reply halted autopilot
but not the Send button next to it, and removeTarget's promise that a channel
'can never be contacted again by accident' was false.

Idempotency was also a non-atomic check-then-act under a comment claiming a
double click could not double send. Now updateMany with a status condition.

Verified: recheckBeforeSend returns target-replied for @bollywoodchronicle in
both attended and unattended modes."
```

### Task 1.4: Make `deliverWaiting` use the gate

**Files:**
- Modify: `src/outreach/deliver.ts:65-123`

- [ ] **Step 1: Add the import**

```ts
import { recheckBeforeSend } from './gate'
```

- [ ] **Step 2: Replace the inline block**

Replace everything from `if (!sender.autoSendEnabled) {` through the closing brace of the `if (senderToday >= sender.dailyCap) { … }` block (currently `deliver.ts:75-123`) with:

```ts
    // The SAME gate the dashboard's Send button runs. One definition, two callers —
    // these two drifted apart once and the button ended up missing five checks.
    const gate = await recheckBeforeSend(attempt, { unattended: true })
    if (!gate.ok) {
      hold(gate.detail ?? gate.reason)
      continue
    }
```

Delete the now-unused `dayStart` const at `deliver.ts:63` and the `istDayStart` import if nothing else uses it. Keep the `profileStatus` import — it is still used for `sessionPath` at the send call.

- [ ] **Step 3: Typecheck**

Run: `pnpm typecheck`
Expected: silent. Fix any unused-import errors it reports.

- [ ] **Step 4: Verify autopilot still holds unarmed accounts for the right reason**

Run: `pnpm run:slot`
Expected in the output — the three unarmed accounts held with `auto-send is off for this account`, exactly as before:
```
STEP  → waiting message held back  pair=... reason=auto-send is off for this account
```
Note: after Task 0.2 there are no READY attempts, so this step will show no holds. Re-run it after Phase 8 when a draft exists, or temporarily set one attempt back to READY:
```bash
sqlite3 prisma/dev.db "UPDATE OutreachAttempt SET status='READY' WHERE id=(SELECT id FROM OutreachAttempt WHERE status='SKIPPED' ORDER BY queuedAt DESC LIMIT 1);"
pnpm run:slot
sqlite3 prisma/dev.db "UPDATE OutreachAttempt SET status='SKIPPED' WHERE status='READY';"
```

- [ ] **Step 5: Commit**

```bash
git add src/outreach/deliver.ts
git commit -m "refactor: deliverWaiting uses the shared resend gate

Same rules, one definition. The duplication is what allowed sendNow to drift
five checks behind."
```

### Task 1.5: Status guards on `skipAttempt` and `markSent` (M-8, M-9)

**Files:**
- Modify: `src/app/actions.ts` (`markSent` at :158, `skipAttempt` at :577)

- [ ] **Step 1: Guard `skipAttempt`**

Replace the whole function:

```ts
/** Discard a queued message without sending. Does not start the cooldown. */
export async function skipAttempt(attemptId: string, reason: string): Promise<MutationResult> {
  /**
   * Only a message that is still waiting may be discarded.
   *
   * This had no status check at all. Applied to a SENT attempt it erased the record
   * of a message a real person received — and that record is what `touchesSoFar`,
   * spacing and the new-material rule are computed from, so the system would then be
   * free to write to someone it had already written to. That is the outcome the
   * "removal never deletes send history" rule exists to prevent, reachable by one
   * call. Applied to a SENDING attempt it corrupted the state of a live browser send.
   */
  const claimed = await prisma.outreachAttempt.updateMany({
    where: { id: attemptId, status: { in: ['READY', 'QUEUED'] } },
    data: { status: 'SKIPPED', error: reason || 'skipped by operator' },
  })

  if (claimed.count === 0) {
    const now = await prisma.outreachAttempt.findUnique({
      where: { id: attemptId },
      select: { status: true },
    })
    return {
      ok: false,
      message:
        now?.status === 'SENDING'
          ? 'That message is being sent right now — too late to discard.'
          : `That message is already ${(now?.status ?? 'gone').toLowerCase()} and cannot be discarded.`,
    }
  }

  await audit('attempt.skipped', `OutreachAttempt:${attemptId}`, reason)
  revalidatePath('/')
  return { ok: true, message: 'Discarded.' }
}
```

- [ ] **Step 2: Guard `markSent`**

Replace the status check at the top of `markSent`. Change:

```ts
  if (attempt.status === 'SENT') return
```

to:

```ts
  /**
   * Only from a state where the message had not been recorded as delivered.
   *
   * This returned early only for SENT, so SKIPPED, SENDING and — worst — REPLIED
   * could all be flipped to SENT. Flipping REPLIED keeps `repliedAt` but changes the
   * status, desynchronising the two: status-based queries stop seeing the reply while
   * `repliedAt`-based ones still do. It also incremented the variant's usage counter
   * on every call.
   */
  if (attempt.status === 'SENT') return { ok: true, message: 'Already recorded as sent.' }
  if (attempt.status === 'REPLIED') {
    return { ok: false, message: 'They replied to that message — it is already recorded as delivered.' }
  }
  if (attempt.status === 'SENDING') {
    return { ok: false, message: 'That message is being sent right now — wait for it to finish.' }
  }
```

Change the signature to `Promise<MutationResult>` and add `return { ok: true, message: 'Recorded as sent.' }` at the end, after `revalidatePath('/')`.

- [ ] **Step 3: Typecheck and fix call sites**

Run: `pnpm typecheck`
Expected: errors in `src/app/awaiting.tsx` where the return value is now used. Handle them the way the file already handles `editAttemptBody`'s result — set the local message state from `r.message`.

- [ ] **Step 4: Verify both directions**

```bash
# positive: a READY attempt can be discarded
sqlite3 prisma/dev.db "UPDATE OutreachAttempt SET status='READY' WHERE id=(SELECT id FROM OutreachAttempt WHERE status='SKIPPED' LIMIT 1);"
# negative: confirm a SENT attempt is refused - check no SENT row can change
sqlite3 prisma/dev.db "SELECT id, status FROM OutreachAttempt WHERE status IN ('SENT','REPLIED');"
```
Then in the dashboard, discard the READY one (should succeed). There is no UI path to call `skipAttempt` on a SENT row, which is the point — the guard exists because the action is callable regardless of what the UI renders.

- [ ] **Step 5: Commit**

```bash
git add src/app/actions.ts src/app/awaiting.tsx
git commit -m "fix: status guards on skipAttempt and markSent

skipAttempt had no status check and could mark a SENT attempt SKIPPED,
erasing the send history that spacing and the new-material rule are computed
from. markSent guarded only SENT, so REPLIED could be flipped, desyncing
status from repliedAt."
```

### Task 1.6: Audit row for planner sends (M-2)

**Files:**
- Modify: `src/outreach/plan.ts:353-364` (`applyOutcome`)

- [ ] **Step 1: Confirm the gap**

Run:
```bash
sqlite3 prisma/dev.db "
SELECT a.id, a.sentBy, datetime(a.sentAt,'+5 hours','+30 minutes') AS ist
FROM OutreachAttempt a WHERE a.status='SENT' AND a.sentBy='auto';"
sqlite3 prisma/dev.db "SELECT count(*) FROM AuditLog WHERE action LIKE 'attempt.sent%';"
```
Expected: a SENT row with `sentBy=auto` (the 14:00 cron send) and an `AuditLog` count that does not account for it.

- [ ] **Step 2: Add the audit row and fix the provenance string (L-3)**

In `applyOutcome`, replace the `SENT` branch:

```ts
  if (outcome.status === 'SENT') {
    await prisma.$transaction([
      prisma.outreachAttempt.update({
        where: { id: attemptId },
        data: {
          status: 'SENT',
          sentAt: new Date(),
          // Was the bare string 'auto', which is indistinguishable from the
          // dashboard's 'auto:<handle>' at a glance and loses which account sent it.
          // The three send paths now read: autopilot:<handle> (planner and
          // deliverWaiting, both unattended) and operator:<handle> (a human clicked).
          sentBy: `autopilot:${senderHandle}`,
          threadUrl: outcome.threadUrl,
        },
      }),
      prisma.messageVariant.update({
        where: { id: variantId },
        data: { timesUsed: { increment: 1 }, lastUsedAt: new Date() },
      }),
      // The planner is the autopilot path. It wrote no audit row at all, so the one
      // send that happens with nobody present was the one with no audit trail -
      // while actions.ts claims "every state change writes an AuditLog row".
      prisma.auditLog.create({
        data: {
          actor: 'autopilot',
          action: 'attempt.sent.autopilot',
          entity: `OutreachAttempt:${attemptId}`,
          detail: `planner dispatch — ${outcome.threadUrl ?? 'delivered'}`,
        },
      }),
    ])
    return
  }
```

- [ ] **Step 3: Thread `senderHandle` into `applyOutcome`**

`applyOutcome` currently takes `(attemptId, variantId, senderId, outcome)`. Add a handle parameter:

```ts
async function applyOutcome(
  attemptId: string,
  variantId: string,
  senderId: string,
  senderHandle: string,
  outcome: SendOutcome,
): Promise<void> {
```

And update the single call site at `plan.ts:343`:

```ts
  await applyOutcome(attempt.id, variant.id, pair.senderId, pair.sender.handle, outcome)
```

- [ ] **Step 4: Also align `sendNow`'s provenance**

In `src/app/actions.ts`, change `sentBy: \`auto:${sender.handle}\`` to:

```ts
          sentBy: `operator:${sender.handle}`,
```

`markSent` already uses `env.OPERATOR_NAME`; leave that — it means "a human sent it outside the system", which is genuinely different.

- [ ] **Step 5: Typecheck and test**

Run: `pnpm typecheck && pnpm test`
Expected: silent; 137 passed.

- [ ] **Step 6: Commit**

```bash
git add src/outreach/plan.ts src/app/actions.ts
git commit -m "fix: planner sends write an audit row, and sentBy is unambiguous

The planner is the autopilot path and wrote no AuditLog row, so the 14:00
cron-fired send to a real recipient had no audit trail. Provenance is now
autopilot:<handle> for both unattended paths and operator:<handle> for a
click, instead of auto / auto:<handle> / autopilot:<handle>."
```

---

## Phase 2 — Gate correctness (H-7, M-1, M-10)

### Task 2.1: Stop discarded drafts burning campaigns (H-7)

**Files:**
- Modify: `src/outreach/plan.ts:80-88`

- [ ] **Step 1: Record the current divergence, to prove the fix**

Run:
```bash
sqlite3 prisma/dev.db "
WITH p AS (SELECT p.id AS pid, p.targetId AS tid FROM OutreachPair p
  JOIN SenderAccount s ON s.id=p.senderId JOIN TargetAccount t ON t.id=p.targetId
  WHERE s.handle='madaboutmarketingg' AND t.handle='madovermarketing_mom')
SELECT 'governor sees available: ' || (SELECT count(*) FROM DetectedCampaign c
  WHERE c.targetId=(SELECT tid FROM p) AND c.verdict='CAMPAIGN'
    AND c.postedAt >= datetime('now','-72 hours')
    AND c.id NOT IN (SELECT campaignId FROM OutreachAttempt
      WHERE pairId=(SELECT pid FROM p) AND campaignId IS NOT NULL))
UNION ALL SELECT 'dispatcher sees available: ' || (SELECT count(*) FROM DetectedCampaign c
  WHERE c.targetId=(SELECT tid FROM p) AND c.verdict='CAMPAIGN'
    AND c.postedAt >= datetime('now','-72 hours')
    AND c.id NOT IN (SELECT campaignId FROM OutreachAttempt
      WHERE pairId=(SELECT pid FROM p) AND campaignId IS NOT NULL
        AND status IN ('SENT','REPLIED','SENDING','READY','QUEUED')));"
```
Expected: `governor sees available: 2`, `dispatcher sees available: 4`. They must agree after the fix.

- [ ] **Step 2: Add the status filter**

In `src/outreach/plan.ts`, replace the `usedCampaignIds` query:

```ts
    // Campaigns for this target that this pair has NOT already written about. This
    // is what makes a follow-up a genuinely new message rather than a repeat.
    const usedCampaignIds = (
      await prisma.outreachAttempt.findMany({
        where: {
          pairId: pair.id,
          campaignId: { not: null },
          /**
           * MUST match `createAndDispatch`'s definition of "used" — the recipient has
           * to have actually seen it. A SKIPPED or FAILED draft referenced nothing.
           *
           * This filter existed there and not here, so the two disagreed: every
           * discarded draft burned a campaign for the purposes of the NO_NEW_MATERIAL
           * gate while the hook lookup still considered it available. `pnpm burner on`
           * mass-SKIPs drafts by design, so rehearsal mode silently consumed the pool
           * — measured at 2 of 4 already gone on one pair — until the gate reported
           * no-new-material with fresh campaigns sitting right there. Permanent,
           * silent, self-inflicted.
           */
          status: { in: ['SENT', 'REPLIED', 'SENDING', 'READY', 'QUEUED'] },
        },
        select: { campaignId: true },
      })
    )
      .map((a) => a.campaignId)
      .filter((id): id is string => id !== null)
```

- [ ] **Step 3: Verify the two now agree**

Re-run the Step 1 query.
Expected: both lines report `4`.

- [ ] **Step 4: Confirm the governor stops reporting no-new-material spuriously**

Run: `pnpm queued`
Expected: `madaboutmarketingg→madovermarketing_mom` is held with `pair-disabled` (rehearsal mode), **not** `no-new-material-to-reference`.

- [ ] **Step 5: Commit**

```bash
git add src/outreach/plan.ts
git commit -m "fix: discarded drafts no longer burn campaigns in the governor gate

createAndDispatch already excluded SKIPPED/FAILED from 'used campaigns', with
a comment explaining that counting them exhausts the pool. The governor's
unusedCampaignCount had no status filter, so the fix was applied to one of the
two queries. pnpm burner on mass-SKIPs drafts, so rehearsal mode was burning
the pool toward a permanent no-new-material lockout - 2 of 4 already gone.

Verified: governor and dispatcher now both see 4 available."
```

### Task 2.2: `hasSession` must require `sessionid` (M-1)

**Files:**
- Modify: `src/outreach/browser/profile.ts:130-173`

- [ ] **Step 1: Change the cookie requirement**

Replace:

```ts
/** Cookies Instagram sets only for a logged-in session. */
const SESSION_COOKIES = ['sessionid', 'ds_user_id']
```

with:

```ts
/**
 * The cookie that actually proves a session.
 *
 * This was `['sessionid', 'ds_user_id']` matched with `name in (...)` and
 * `count(*) > 0` — an OR. `ds_user_id` is an account identifier, not a session, and
 * it can outlive one, so a profile holding only that reported `hasSession: true`.
 * That is autopilot switch #4, so it would arm an account that cannot send; and it
 * is the sole basis of `pollConnect`'s fallback, which reports "connected" with no
 * identity check at all. The docblock above says this gate must fail CLOSED and the
 * query was the loosest available.
 */
const SESSION_COOKIE = 'sessionid'
```

And in `hasSessionCookie`, replace the query:

```ts
      const row = conn
        .prepare(
          `select count(*) as n from cookies
            where host_key like '%instagram.com' and name = ?`,
        )
        .get(SESSION_COOKIE) as { n: number } | undefined
      return (row?.n ?? 0) > 0
```

- [ ] **Step 2: Verify the positive direction — a real logged-in profile still reports true**

Create `verify-session.ts` in the project root:

```ts
import { profileStatus } from '@/outreach/browser/profile'
for (const h of ['tabishmukaddam1', 'bollywoodsocietyy']) {
  const s = profileStatus(h)
  console.log(`${h.padEnd(20)} initialised=${s.initialised} hasSession=${s.hasSession}`)
}
```

Run: `pnpm tsx verify-session.ts`
Expected:
```
tabishmukaddam1      initialised=true hasSession=true
bollywoodsocietyy    initialised=false hasSession=false
```
The first line is the direction that matters — if it went `false`, the fix broke the working case and must not be committed.

- [ ] **Step 3: Verify the negative direction — `ds_user_id` alone is no longer enough**

```bash
mkdir -p /tmp/fakeprofile/Default
sqlite3 /tmp/fakeprofile/Default/Cookies "CREATE TABLE cookies (host_key TEXT, name TEXT, encrypted_value BLOB); INSERT INTO cookies VALUES ('.instagram.com','ds_user_id',x'00');"
```

Then temporarily point a probe at it — add to `verify-session.ts`:

```ts
import Database from 'better-sqlite3'
const conn = new Database('/tmp/fakeprofile/Default/Cookies', { readonly: true })
const n = conn.prepare(`select count(*) as n from cookies where host_key like '%instagram.com' and name = 'sessionid'`).get() as { n: number }
console.log('ds_user_id-only profile, sessionid rows:', n.n, '=> hasSession would be', n.n > 0)
conn.close()
```

Run: `pnpm tsx verify-session.ts`
Expected: `sessionid rows: 0 => hasSession would be false`. Under the old OR query this was `true`.

- [ ] **Step 4: Clean up**

```bash
rm verify-session.ts
rm -rf /tmp/fakeprofile
```

- [ ] **Step 5: Commit**

```bash
git add src/outreach/browser/profile.ts
git commit -m "fix: hasSession requires sessionid, not sessionid OR ds_user_id

ds_user_id is an account identifier, not a session, and can outlive one. The
OR made a gate documented as fail-closed report connected for a profile that
cannot send - and it is autopilot switch #4.

Verified both directions: the live logged-in profile still reads true, a
ds_user_id-only jar now reads false."
```

### Task 2.3: Align the schema default with the documented one (M-10)

**Files:**
- Modify: `prisma/schema.prisma:94`

- [ ] **Step 1: Change the default**

```prisma
  cooldownDays Int     @default(7)
```

Add above it:
```prisma
  /// 7, matching DEFAULT_COOLDOWN_DAYS. These were 5 and 7 respectively; the
  /// documented value held only because addSender/addTarget pass it explicitly, so
  /// any other insert path silently got 5 days of spacing while every document said 7.
```

- [ ] **Step 2: Push the schema change**

Run: `pnpm db:push`
Expected: `Your database is now in sync with your Prisma schema.`

This is a default change only — it does not alter existing rows.

- [ ] **Step 3: Verify existing pairs are untouched and the new default applies**

```bash
sqlite3 prisma/dev.db "SELECT DISTINCT cooldownDays FROM OutreachPair;"
sqlite3 prisma/dev.db "SELECT sql FROM sqlite_master WHERE name='OutreachPair';" | grep cooldownDays
```
Expected: existing rows all `7`; the DDL now shows `DEFAULT 7`.

- [ ] **Step 4: Commit**

```bash
git add prisma/schema.prisma
git commit -m "fix: schema cooldownDays default 5 -> 7 to match DEFAULT_COOLDOWN_DAYS"
```

---

## Phase 3 — The send guard (H-3)

Both guards `CLAUDE.md` says "must not be removed" degrade to tautologies when the longest body line is under 40 characters and the greeting is the longest line — reachable through the dashboard's edit box, and the 12:27 chronicle send already took that path.

### Task 3.1: Never take the needle from the greeting (H-3, and L-7's missing test)

**Files:**
- Modify: `src/outreach/matching.ts:21-38`
- Test: `tests/matching.test.ts`

The new tests in Step 1 also close **L-7**: the suite had no case for a short
*multi-line* body, which is precisely the shape the bug needed. Its existing
"falls back gracefully" test uses a single-line body, so the fallback never reached
the greeting and the gap was invisible.

- [ ] **Step 1: Write the failing tests**

Append to `tests/matching.test.ts`, inside the `describe('distinctiveSlice', …)` block:

```ts
  /**
   * The gap that let both send guards become tautologies. The existing
   * "falls back gracefully" test uses a SINGLE-line body, so the fallback returns the
   * whole string and the bug is invisible. A short MULTI-line body - which is what
   * the dashboard's edit box produces - fell back to the greeting, the one thing the
   * function's own docblock says to avoid because it renders in the thread header.
   */
  it('never returns the greeting, even when it is the longest line', () => {
    const edited = 'Hi Bollywood Chronicle,\n\nThis is a test message.'
    const needle = distinctiveSlice(edited)
    expect(needle).not.toBeNull()
    expect(needle).not.toContain('Hi Bollywood Chronicle')
    expect(needle).toBe('This is a test message.')
  })

  it('never returns the greeting for a three-line body either', () => {
    const needle = distinctiveSlice('Hi Priyanshu,\n\nShort note about the campaign.\n\nThanks')
    expect(needle).not.toContain('Hi Priyanshu')
  })

  it('returns null rather than the greeting when there is no usable body line', () => {
    expect(distinctiveSlice('Hi Bollywood Chronicle,\n\nok')).toBeNull()
  })

  it('still returns the whole thing for a single-line body', () => {
    expect(distinctiveSlice('Hi there, following up on this.')).toBe('Hi there, following up on this.')
  })
```

And append to the `describe('messageMatchesOurs', …)` block:

```ts
  it('does NOT report a short edited message as delivered from thread chrome alone', () => {
    const body = 'Hi Bollywood Chronicle,\n\nThis is a test message.'
    // What the page holds when Enter did nothing: header, handle, composer label.
    const chromeOnly = 'Bollywood Chronicle  bollywoodchronicle  Active now  Hi Bollywood Chronicle,  Message'
    expect(messageMatchesOurs(chromeOnly, body)).toBe(false)
  })

  it('does NOT accept a paste that lost everything after the greeting', () => {
    const body = 'Hi Bollywood Chronicle,\n\nThis is a test message.'
    expect(messageMatchesOurs('Hi Bollywood Chronicle,', body)).toBe(false)
  })

  it('still matches when the real short body IS present', () => {
    const body = 'Hi Bollywood Chronicle,\n\nThis is a test message.'
    const delivered = 'Bollywood Chronicle  Hi Bollywood Chronicle, This is a test message.  Message'
    expect(messageMatchesOurs(delivered, body)).toBe(true)
  })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run tests/matching.test.ts`
Expected: FAIL on `never returns the greeting…` (receives `'Hi Bollywood Chronicle,'`) and on both `does NOT …` cases (receive `true`). The two "still …" cases should already pass.

- [ ] **Step 3: Write the implementation**

Replace `distinctiveSlice` in `src/outreach/matching.ts`:

```ts
/** A needle shorter than this is too generic to prove anything. */
const MIN_NEEDLE_CHARS = 20

/**
 * Pick a chunk of a message unlikely to appear anywhere else on the page.
 *
 * Deliberately avoids the ends. The greeting repeats the contact's name, which also
 * renders in the thread header; the signature carries the phone number and email,
 * which can appear in profile chrome. A mid-body line is the part that only exists
 * because we wrote it.
 *
 * THE ENDS ARE EXCLUDED FROM THE FALLBACK TOO. They were not, and that was the whole
 * bug: the primary path correctly skipped the greeting, but any body whose longest
 * line was under 40 characters fell through to "longest line available", which for a
 * short edited message IS the greeting. Both send guards then compared against text
 * that is on the page whether the message was delivered or not — the post-send check
 * could not fail, and a paste that lost everything after the greeting passed the
 * composer read-back. Reachable from the dashboard's edit box, and the 2026-07-31
 * 12:27 send took exactly that path.
 *
 * Returning null is the safe outcome: callers treat it as "not a match", so a send
 * is refused rather than falsely confirmed.
 */
export function distinctiveSlice(body: string): string | null {
  const lines = body
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)

  // Which lines are body rather than envelope:
  //   4+ lines — drop the greeting and the last signature line
  //   2-3      — drop the greeting; there is no signature block to speak of
  //   1        — it is all we have, and a single line has no greeting structure
  const interior = lines.length >= 4 ? lines.slice(1, -1) : lines.length >= 2 ? lines.slice(1) : lines

  const long = interior.filter((l) => l.length > 40)
  if (long.length > 0) {
    return long[Math.floor(long.length / 2)]!.slice(0, 60)
  }

  const longest = [...interior].sort((a, b) => b.length - a.length)[0]
  return longest && longest.length >= MIN_NEEDLE_CHARS ? longest.slice(0, 60) : null
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run tests/matching.test.ts`
Expected: PASS, 24 tests.

- [ ] **Step 5: Run the full suite — the existing needle tests are the regression check**

Run: `pnpm test`
Expected: 145 passed. If `avoids the greeting`, `avoids the signature`, `produces something usable for every variant` or any `render` test fails, the interior-slicing thresholds are wrong — do not relax the new tests to compensate.

- [ ] **Step 6: Confirm real stored bodies still produce sane needles**

Create `verify-needle.ts`:

```ts
import { prisma } from '@/lib/db'
import { distinctiveSlice } from '@/outreach/matching'

const rows = await prisma.outreachAttempt.findMany({
  select: { renderedBody: true, status: true },
})
for (const r of rows) {
  const n = distinctiveSlice(r.renderedBody)
  console.log(`[${r.status}] ${n === null ? '*** NULL ***' : JSON.stringify(n.slice(0, 50))}`)
}
await prisma.$disconnect()
```

Run: `pnpm tsx verify-needle.ts`
Expected: every full-length body yields a real mid-body sentence; no needle begins with `Hi `. The 48-char chronicle body should now yield `"This is a test message."` rather than the greeting.

- [ ] **Step 7: Clean up and commit**

```bash
rm verify-needle.ts
git add src/outreach/matching.ts tests/matching.test.ts
git commit -m "fix: needle selection never falls back to the greeting

Both send guards became tautologies for any body whose longest line was under
40 chars: the fallback returned the greeting, which renders in the thread
header, so the post-send check could not fail and a paste that lost everything
after the greeting passed the composer read-back. Same class as the
already-fixed whole-page check, through a different door.

The existing 'falls back gracefully' test used a single-line body, so the
fallback never reached the greeting and the gap was invisible."
```

### Task 3.2: Refuse an edit that cannot be verified

**Files:**
- Modify: `src/app/actions.ts` (`editAttemptBody` at :201)

- [ ] **Step 1: Add the check**

In `editAttemptBody`, after the `MAX_BODY_CHARS` check and before the no-change check, add:

```ts
  /**
   * Refuse a body the send guards cannot verify.
   *
   * `distinctiveSlice` returns null when there is no body line distinctive enough to
   * look for on the page. Saving such a body is not harmless: the composer read-back
   * would then refuse the send with "composer content does not match the drafted
   * message", which is true but points at the wrong thing entirely — the operator
   * would go hunting for a paste bug. Fail at the point of the mistake, with an
   * explanation, rather than opaquely at send time.
   */
  if (distinctiveSlice(next) === null) {
    return {
      ok: false,
      message:
        'That message is too short to verify on screen before sending. Add a sentence of at least 20 characters below the greeting.',
    }
  }
```

And add the import at the top:

```ts
import { distinctiveSlice } from '@/outreach/matching'
```

- [ ] **Step 2: Verify both directions in the dashboard**

Run `pnpm start`, open http://127.0.0.1:3000, and on any waiting message:

- Edit the body to `Hi X,\n\nok` → Expected: refused, with the "too short to verify" message. **Negative direction.**
- Edit it to `Hi X,\n\nThis is a genuine sentence about the campaign.` → Expected: `Saved. NN characters.` **Positive direction.**

If there is no waiting message, temporarily promote one:
```bash
sqlite3 prisma/dev.db "UPDATE OutreachAttempt SET status='READY' WHERE id=(SELECT id FROM OutreachAttempt WHERE status='SKIPPED' LIMIT 1);"
```
and set it back to `SKIPPED` afterwards.

- [ ] **Step 3: Commit**

```bash
git add src/app/actions.ts
git commit -m "fix: refuse an edit too short for the send guards to verify

A body with no distinctive line makes the composer read-back fail with a
message that points at a paste bug rather than at the edit. Fail at the
mistake, not three steps downstream."
```

---

## Phase 4 — Checkpoints and halts (D-6, H-5, H-6)

### Task 4.1: 2FA is not enforcement (D-6)

This is the finding most likely to bite in production, because it triggers on accounts with 2FA enabled — which is the recommended configuration for these accounts.

**Files:**
- Modify: `src/outreach/browser/session.ts:28-50, 104-112`
- Test: `tests/session-paths.test.ts` (new)

- [ ] **Step 1: Write the failing tests**

Create `tests/session-paths.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { classifyUrl } from '@/outreach/browser/session'

describe('classifyUrl', () => {
  it('treats a challenge as enforcement', () => {
    expect(classifyUrl('https://www.instagram.com/challenge/?next=/')).toBe('checkpoint')
  })

  it('treats a suspension as enforcement', () => {
    expect(classifyUrl('https://www.instagram.com/accounts/suspended/')).toBe('checkpoint')
  })

  it('treats a disabled account as enforcement', () => {
    expect(classifyUrl('https://www.instagram.com/accounts/disabled/')).toBe('checkpoint')
  })

  /**
   * The point of this file. A 2FA prompt is routine on accounts that have 2FA
   * enabled - it means an existing session is being re-verified, not that Instagram
   * has taken action. Marking the account CHALLENGED halts every pair using it and
   * by design nothing retries, so a routine re-prompt took a revenue account offline
   * until someone noticed. Exactly the mistake already fixed for /accounts/login:
   * "an operator who sees CHALLENGED three times for something that just needed a
   * fresh login learns to dismiss it, and then dismisses the one that matters."
   */
  it('treats a 2FA prompt as needing a code, NOT as enforcement', () => {
    expect(classifyUrl('https://www.instagram.com/accounts/login/two_factor?next=/')).toBe('needs-2fa')
  })

  it('treats a login form as needing a login, not enforcement', () => {
    expect(classifyUrl('https://www.instagram.com/accounts/login/')).toBe('needs-login')
  })

  it('treats an ordinary page as fine', () => {
    expect(classifyUrl('https://www.instagram.com/bollywoodsocietyy/')).toBe('ok')
  })

  it('classifies 2FA ahead of the login form when the URL contains both', () => {
    // IG's 2FA URL lives under /accounts/login/, so order matters.
    expect(classifyUrl('https://www.instagram.com/accounts/login/two_factor')).toBe('needs-2fa')
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run tests/session-paths.test.ts`
Expected: FAIL — `classifyUrl` is not exported.

- [ ] **Step 3: Implement**

In `src/outreach/browser/session.ts`, replace the `CHECKPOINT_PATHS` / `LOGIN_PATHS` block and `assertNoCheckpoint`:

```ts
/** Instagram surfaces enforcement at these paths. Seeing one means STOP, never retry. */
const CHECKPOINT_PATHS = ['/challenge', '/accounts/suspended', '/accounts/disabled']

/** An expired session. Routine — log in again. Not enforcement. */
const LOGIN_PATHS = ['/accounts/login', '/accounts/signup']

/**
 * A 2FA prompt. ROUTINE, and its own state.
 *
 * This used to live in CHECKPOINT_PATHS, which marked the account CHALLENGED and
 * halted every pair using it. But 2FA is the recommended configuration for these
 * accounts, and a re-prompt means an existing session is being re-verified — not that
 * Instagram has acted. It is the same conflation already fixed for `/accounts/login`,
 * and the reasoning in that comment applies verbatim: an operator who sees CHALLENGED
 * for routine events learns to dismiss it, and then dismisses the one that matters.
 *
 * It is not simply moved into LOGIN_PATHS because the remedy differs — a login form
 * means re-authenticate, a 2FA prompt means enter a code for a session that already
 * exists. Checked BEFORE the login paths, because IG's 2FA URL sits under
 * `/accounts/login/`.
 */
const TWO_FACTOR_PATHS = ['/two_factor', '/accounts/login/two_factor']

export type UrlVerdict = 'ok' | 'checkpoint' | 'needs-login' | 'needs-2fa'

/** Pure, so every verdict is testable. */
export function classifyUrl(url: string): UrlVerdict {
  for (const p of CHECKPOINT_PATHS) if (url.includes(p)) return 'checkpoint'
  for (const p of TWO_FACTOR_PATHS) if (url.includes(p)) return 'needs-2fa'
  for (const p of LOGIN_PATHS) if (url.includes(p)) return 'needs-login'
  return 'ok'
}

export class TwoFactorRequiredError extends Error {
  constructor(readonly handle: string) {
    super(`@${handle} needs a 2FA code. Press Connect and enter it — the account is NOT flagged.`)
    this.name = 'TwoFactorRequiredError'
  }
}

/**
 * Throws if the current URL is an enforcement surface (CheckpointError — halt the
 * account), a 2FA prompt (TwoFactorRequiredError — a human enters a code, account
 * stays ACTIVE), or a login form (NotLoggedInError — just log in again).
 */
export function assertNoCheckpoint(page: Page, handle?: string): void {
  const url = page.url()
  switch (classifyUrl(url)) {
    case 'checkpoint': {
      const kind = CHECKPOINT_PATHS.find((p) => url.includes(p))!.replace(/^\//, '')
      throw new CheckpointError(url, kind)
    }
    case 'needs-2fa':
      throw new TwoFactorRequiredError(handle ?? 'this account')
    case 'needs-login':
      throw new NotLoggedInError(handle ?? 'this account')
    case 'ok':
      return
  }
}
```

- [ ] **Step 4: Make the sender treat 2FA as not-challenged**

`challenged: true` is what marks the account `CHALLENGED` in both `applyOutcome` and
`deliverWaiting`, so 2FA must not set it.

In `src/outreach/senders/browser.ts`, change the import on line 5:

```ts
import {
  CheckpointError,
  NotLoggedInError,
  TwoFactorRequiredError,
  WrongAccountError,
} from '@/outreach/browser/session'
```

And insert this branch immediately after the `CheckpointError` branch (after line 56),
before the `NotLoggedInError` branch:

```ts
      /**
       * A 2FA prompt is NOT enforcement, so `challenged` stays absent.
       *
       * This used to arrive as a CheckpointError, because `/two_factor` was in
       * CHECKPOINT_PATHS — so a routine re-verification on a 2FA-enabled account
       * marked it CHALLENGED and halted every pair using it, with nothing retrying
       * by design. The draft is kept and a human enters the code.
       */
      if (err instanceof TwoFactorRequiredError) {
        log.warn('Instagram asked for a 2FA code — the account is NOT flagged', {
          sender: req.senderHandle,
        })
        return { status: 'FAILED', error: err.message }
      }
```

- [ ] **Step 5: Run tests**

Run: `pnpm test && pnpm typecheck`
Expected: 152 passed; typecheck silent.

- [ ] **Step 6: Commit**

```bash
git add src/outreach/browser/session.ts src/outreach/senders/browser.ts tests/session-paths.test.ts
git commit -m "fix: a 2FA prompt is not enforcement

/two_factor was in CHECKPOINT_PATHS and assertNoCheckpoint runs five times per
send, so a routine 2FA re-prompt marked the account CHALLENGED and halted every
pair using it, with nothing retrying by design. Same conflation already fixed
for /accounts/login. 2FA is now its own state: a human enters a code, the
account stays ACTIVE.

Checked before the login paths because IG's 2FA URL sits under /accounts/login/."
```

### Task 4.2: Detect in-page enforcement, not just URLs (H-5)

**Files:**
- Modify: `src/outreach/browser/session.ts`, `src/outreach/browser/sendDm.ts`
- Test: `tests/session-paths.test.ts` (append)

- [ ] **Step 1: Write the failing tests**

Append to `tests/session-paths.test.ts`:

```ts
import { looksLikeEnforcement } from '@/outreach/browser/session'

describe('looksLikeEnforcement', () => {
  it('recognises Action Blocked', () => {
    expect(looksLikeEnforcement('Action Blocked  We restrict certain activity to protect our community')).toBe(true)
  })

  it('recognises a temporary block', () => {
    expect(looksLikeEnforcement('Your account has been temporarily blocked')).toBe(true)
  })

  it('recognises a try-again-later throttle', () => {
    expect(looksLikeEnforcement('Please wait a few minutes before you try again.')).toBe(true)
  })

  it('recognises a failed message send', () => {
    expect(looksLikeEnforcement('Message could not be sent. Tap to retry.')).toBe(true)
  })

  it('is case- and whitespace-insensitive', () => {
    expect(looksLikeEnforcement('  action   BLOCKED  ')).toBe(true)
  })

  /** The direction that matters most: an ordinary thread must not trip this. */
  it('does NOT fire on an ordinary conversation', () => {
    expect(looksLikeEnforcement('Bollywood Chronicle  Active now  Hi, thanks for reaching out  Message')).toBe(false)
  })

  it('does NOT fire on a normal pitch body', () => {
    const body = 'We generate over 30 crore views a day — I would love 20 minutes to walk you through a plan.'
    expect(looksLikeEnforcement(body)).toBe(false)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run tests/session-paths.test.ts`
Expected: FAIL — `looksLikeEnforcement` is not exported.

- [ ] **Step 3: Implement**

Add to `src/outreach/browser/session.ts`:

```ts
/**
 * Enforcement that renders in the page rather than changing the URL.
 *
 * `assertNoCheckpoint` only ever looked at `page.url()`. But Instagram's most common
 * response to DM activity — "Action Blocked", "We restrict certain activity" — is a
 * MODAL on the current URL, as is a suspension notice on a profile page. None of
 * those change the path, so none were detected and the send simply carried on,
 * failed some later check, and was recorded as an ordinary retryable failure. The
 * account stayed ACTIVE and eligible for the next slot: retrying into a block, which
 * is the one thing the checkpoint rule exists to prevent.
 *
 * Phrases are matched loosely on normalised text. Kept narrow and specific on
 * purpose: a false positive halts a healthy revenue account, so this must not match
 * ordinary conversation. Every phrase here is enforcement language, not chat.
 */
const ENFORCEMENT_PHRASES = [
  'action blocked',
  'we restrict certain activity',
  'temporarily blocked',
  'your account has been disabled',
  'try again later',
  'please wait a few minutes before you try again',
  'message could not be sent',
] as const

export function looksLikeEnforcement(pageText: string): boolean {
  const t = pageText.replace(/\s+/g, ' ').trim().toLowerCase()
  return ENFORCEMENT_PHRASES.some((p) => t.includes(p))
}

/**
 * URL check plus in-page check. Use this wherever a page has just been navigated or
 * acted upon; `assertNoCheckpoint` alone is only half the question.
 */
export async function assertNoEnforcement(page: Page, handle?: string): Promise<void> {
  assertNoCheckpoint(page, handle)
  const text = (await page.locator('body').textContent().catch(() => '')) ?? ''
  if (looksLikeEnforcement(text)) {
    throw new CheckpointError(page.url(), 'in-page enforcement notice')
  }
}
```

- [ ] **Step 4: Use it at the two points that matter in `sendDm.ts`**

In `src/outreach/browser/sendDm.ts`, change the check immediately after Enter (`sendDm.ts:164`) and the one after the composer is found (`sendDm.ts:129`) from `assertNoCheckpoint(page)` to `await assertNoEnforcement(page, senderHandle)`.

Leave the three navigation-time calls as the cheap URL-only check — they run before any action and a body read on every one is wasted work.

Add to the import at `sendDm.ts:6`:
```ts
import { assertLoggedInAs, assertNoCheckpoint, assertNoEnforcement, launchProfile } from './session'
```

- [ ] **Step 5: Verify the false-positive direction against a real page**

This must not fire on a healthy thread. Run:
```bash
pnpm ig:thread tabishmukaddam1 bollywoodsocietyy
```
Expected: reads the thread normally, no `CheckpointError`. If it throws "in-page enforcement notice" on a healthy conversation, a phrase is too broad — narrow it rather than removing the check.

- [ ] **Step 6: Run tests and commit**

Run: `pnpm test && pnpm typecheck`
Expected: 159 passed.

```bash
git add src/outreach/browser/session.ts src/outreach/browser/sendDm.ts tests/session-paths.test.ts
git commit -m "fix: detect in-page enforcement, not only checkpoint URLs

Instagram's usual response to DM activity is an Action Blocked modal on the
current URL. URL-only detection missed it, so the send failed some later check,
was recorded as an ordinary retryable failure, and the account stayed ACTIVE
and eligible next slot - retrying into a block.

Phrases kept narrow: a false positive halts a healthy revenue account."
```

### Task 4.3: CHALLENGED requires an explicit acknowledgement (H-6)

**Files:**
- Modify: `src/app/actions.ts` (`checkConnect` at :304), `src/outreach/browser/connect.ts:81-88`
- Modify: `src/app/accounts.tsx`

- [ ] **Step 1: Stop `checkConnect` from clearing CHALLENGED**

In `src/app/actions.ts`, replace the `data:` block inside `checkConnect`:

```ts
      data: { sessionPath: st.dir, sessionSavedAt: new Date(), status: 'ACTIVE' },
```

with:

```ts
      /**
       * Records the session. Deliberately does NOT set status.
       *
       * This set `status: 'ACTIVE'`, on the reasoning that a fresh hand login is what
       * clears a CHALLENGED account. But `connected` is returned on two paths where
       * no login happens: `startConnect` when the profile is already logged in, and
       * `pollConnect`'s fallback, which reports connected purely from a cookie on
       * disk with no identity check at all. So "Instagram flagged the account →
       * CHALLENGED → press Connect → silently ACTIVE" took one click and inspected
       * nothing. The halt exists precisely so a human looks first.
       *
       * Clearing it is now `clearChallenge`, an explicit separate act.
       */
      data: { sessionPath: st.dir, sessionSavedAt: new Date() },
```

- [ ] **Step 2: Add the explicit acknowledgement action**

Add to `src/app/actions.ts`:

```ts
/**
 * Clear a CHALLENGED halt, after a human has actually looked at the account.
 *
 * Separate from connecting on purpose. A checkpoint means Instagram took action; the
 * session may well still be valid, so "the session works" is not evidence the cause
 * was addressed. The only thing that should lift this is a person confirming they
 * opened the account and dealt with whatever Instagram was asking.
 */
export async function clearChallenge(handle: string): Promise<MutationResult> {
  const sender = await prisma.senderAccount.findUnique({ where: { handle } })
  if (!sender) return { ok: false, message: `@${handle} not found.` }
  if (sender.status !== 'CHALLENGED') {
    return { ok: false, message: `@${handle} is ${sender.status} — nothing to clear.` }
  }
  if (!profileStatus(handle).hasSession) {
    return { ok: false, message: `@${handle} is not connected. Press Connect first, then clear the halt.` }
  }

  await prisma.senderAccount.update({ where: { handle }, data: { status: 'ACTIVE' } })
  await audit('sender.challenge.cleared', `SenderAccount:${handle}`, 'operator confirmed they checked the account')
  revalidatePath('/')
  return { ok: true, message: `@${handle} is active again. Auto-send is still off — arm it deliberately.` }
}
```

Note it deliberately does **not** re-enable `autoSendEnabled`.

- [ ] **Step 3: Surface it in the UI**

In `src/app/accounts.tsx`, in `AccountRow`, add a control shown only when `account.status === 'CHALLENGED'`. Follow the existing `confirmRemove` two-step pattern in the same file — the first click explains, the second acts:

```tsx
      {account.status === 'CHALLENGED' ? (
        <div className="connect-strip warn">
          Instagram flagged @{account.handle} and sending is halted. Open the account yourself and deal with
          whatever it is asking before clearing this.
          {confirmClear ? (
            <>
              <button className="link-btn" onClick={doClear} disabled={clearing}>
                I have checked it — clear the halt
              </button>
              <button className="link-btn" onClick={() => setConfirmClear(false)}>
                Cancel
              </button>
            </>
          ) : (
            <button className="link-btn" onClick={() => setConfirmClear(true)}>
              Clear the halt
            </button>
          )}
        </div>
      ) : null}
```

Add these to `AccountRow`, alongside the existing `busy` / `confirmRemove` state.
**Separate busy flags per action** — `clearing` must not be the same flag as `busy`, per
the gotcha about one flag serving two actions (the Save button rendered "Saving…" before
any save had been attempted because it shared a flag):

```tsx
  const [confirmClear, setConfirmClear] = useState(false)
  const [clearing, setClearing] = useState(false)

  const doClear = async () => {
    setClearing(true)
    setMsg(null)
    try {
      const r = await clearChallenge(account.handle)
      setMsg(r.message)
      if (r.ok) setConfirmClear(false)
    } finally {
      setClearing(false)
    }
  }
```

Add `clearChallenge` to the existing `./actions` import at the top of the file.

Confirm `status` is on the `AccountCard` type in `src/app/view-model.ts`. If it is not,
add it to the type and populate it from `sender.status` where the card is built.

- [ ] **Step 4: Tighten `pollConnect`'s fallback**

In `src/outreach/browser/connect.ts`, replace the `if (!s)` branch:

```ts
  if (!s) {
    /**
     * No window open. A session cookie on disk means a previous login succeeded, but
     * it does NOT tell us which account, so this cannot report a verified connection
     * — it used to, and combined with the OR in `hasSession` that let a stale cookie
     * read as "connected". Report it as unverified and let the operator re-run.
     */
    return profileStatus(handle).hasSession
      ? { state: 'closed', message: 'A session is already stored for this account. Press Connect to re-verify it.' }
      : { state: 'closed', message: 'No connection in progress. Press Connect to start.' }
  }
```

- [ ] **Step 5: Verify both directions**

```bash
# Set up: flag an account
sqlite3 prisma/dev.db "UPDATE SenderAccount SET status='CHALLENGED' WHERE handle='tabishmukaddam1';"
```

In the dashboard: press **Connect** on that account. Expected: it connects, and the account **remains CHALLENGED** (previously this silently cleared it). Verify:
```bash
sqlite3 prisma/dev.db "SELECT handle, status FROM SenderAccount WHERE handle='tabishmukaddam1';"
```
Expected: `CHALLENGED`.

Then press **Clear the halt** → confirm. Expected: `ACTIVE`, and `autoSendEnabled` unchanged. Verify:
```bash
sqlite3 prisma/dev.db "SELECT handle, status, autoSendEnabled FROM SenderAccount WHERE handle='tabishmukaddam1';"
```

- [ ] **Step 6: Commit**

```bash
git add src/app/actions.ts src/app/accounts.tsx src/outreach/browser/connect.ts src/app/view-model.ts
git commit -m "fix: clearing a CHALLENGED halt is an explicit act, not a side effect of Connect

checkConnect set status ACTIVE whenever connect reported 'connected' - and that
is returned on two paths where no login happens, including a fallback that
reads a cookie off disk with no identity check. So a flagged account went back
to ACTIVE on one click with nobody looking at it.

pollConnect's no-window fallback no longer claims a verified connection."
```

---

## Phase 5 — Concurrency (H-4, M-6, M-7)

### Task 5.1: An advisory lock around `runSlot` (H-4)

**Files:**
- Modify: `src/worker/runSlot.ts`

- [ ] **Step 1: Add the lock**

At the top of `runSlot`, before `prisma.scrapeRun.create`:

```ts
/** Setting key holding `{"pid":123,"slot":"11:00","at":"..."}` while a slot runs. */
const SLOT_LOCK_KEY = 'slotRunning'
/** A slot that has not finished in this long is presumed dead, not running. */
const SLOT_LOCK_STALE_MS = 30 * 60_000

/**
 * Is another slot genuinely running?
 *
 * cron tasks pass `noOverlap`, but that is per-task and does not cover `syncNow`
 * (the dashboard's Sync now button), a second `pnpm run:slot`, or a click landing
 * during a cron slot. Two concurrent `runOutreach` calls both read
 * `hasPendingAttempt: false` for the same pair, both create an attempt, and both
 * dispatch — two DMs to one prospect seconds apart.
 *
 * Freshness alone is not liveness: a `kill -9` leaves the record behind. Ask the OS,
 * the same way `startScheduler` does.
 */
async function acquireSlotLock(slot: string): Promise<boolean> {
  const row = await prisma.setting.findUnique({ where: { key: SLOT_LOCK_KEY } })
  if (row) {
    try {
      const held = JSON.parse(row.value) as { pid: number; slot: string; at: string }
      const ageMs = Date.now() - new Date(held.at).getTime()
      const alive = (() => {
        try {
          process.kill(held.pid, 0)
          return true
        } catch {
          return false
        }
      })()
      if (alive && held.pid !== process.pid && ageMs < SLOT_LOCK_STALE_MS) {
        log.warn('another slot is already running — declining to start a second', {
          otherPid: held.pid,
          otherSlot: held.slot,
          ageSeconds: Math.round(ageMs / 1000),
        })
        return false
      }
    } catch {
      // Unparseable lock: treat as absent rather than deadlocking forever.
    }
  }

  const value = JSON.stringify({ pid: process.pid, slot, at: new Date().toISOString() })
  await prisma.setting.upsert({
    where: { key: SLOT_LOCK_KEY },
    update: { value },
    create: { key: SLOT_LOCK_KEY, value },
  })
  return true
}

async function releaseSlotLock(): Promise<void> {
  await prisma.setting.deleteMany({ where: { key: SLOT_LOCK_KEY } }).catch(() => undefined)
}
```

- [ ] **Step 2: Wire it into `runSlot`**

Change the top of `runSlot`:

```ts
export async function runSlot(slot: string): Promise<SlotResult> {
  const started = Date.now()
  log.info(`▶ slot ${slot} starting`, { at: istStamp(), dryRun: env.DRY_RUN })

  if (!(await acquireSlotLock(slot))) {
    return { runId: '', status: 'FAILED', postsSeen: 0, newPosts: 0, detected: 0, queued: 0, sent: 0 }
  }

  const run = await prisma.scrapeRun.create({ data: { slot } })
```

And wrap the body so the lock is always released. Put the existing body inside `try { … } finally { await releaseSlotLock() }`, keeping the final `return` inside the `try`.

Add the import if `log` is not already imported (it is, at `runSlot.ts:3`).

- [ ] **Step 3: Verify the lock holds — the positive direction**

Run two slots at once:
```bash
pnpm run:slot & pnpm run:slot & wait
```
Expected: one runs normally; the other logs `another slot is already running — declining to start a second`. Exactly one new `ScrapeRun` row:
```bash
sqlite3 prisma/dev.db "SELECT count(*) FROM ScrapeRun WHERE startedAt > datetime('now','-2 minutes');"
```
Expected: `1`.

- [ ] **Step 4: Verify the lock releases — the negative direction**

Run: `pnpm run:slot`
Expected: it runs normally (not blocked by its own predecessor's lock). Then:
```bash
sqlite3 prisma/dev.db "SELECT count(*) FROM Setting WHERE key='slotRunning';"
```
Expected: `0` — released.

- [ ] **Step 5: Verify a dead holder does not deadlock**

```bash
sqlite3 prisma/dev.db "INSERT INTO Setting (key,value,updatedAt) VALUES ('slotRunning','{\"pid\":999999,\"slot\":\"fake\",\"at\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}', datetime('now'));"
pnpm run:slot
```
Expected: runs anyway (pid 999999 does not exist). This is the `kill -9` case that broke the scheduler heartbeat once.

- [ ] **Step 6: Commit**

```bash
git add src/worker/runSlot.ts
git commit -m "fix: advisory lock so two slots cannot plan against the same state

noOverlap is per-cron-task and does not cover syncNow, a second pnpm run:slot,
or a click landing during a cron slot. Two concurrent runOutreach calls both
see hasPendingAttempt false for the same pair and both dispatch.

Liveness by process.kill(pid, 0), not freshness - a kill -9 leaves the record
behind, which is the bug that broke the scheduler heartbeat."
```

### Task 5.2: Serialise clipboard use, and honour the jitter config (M-6, M-3)

**Files:**
- Modify: `src/outreach/deliver.ts`, `src/outreach/plan.ts`

- [ ] **Step 1: Add the inter-send delay to `deliverWaiting`**

At the top of `src/outreach/deliver.ts`:

```ts
import { randomInt } from '@/lib/time'
```

Inside the loop, immediately before the `browserSender.send` call, add:

```ts
    /**
     * Space consecutive sends.
     *
     * SEND_JITTER_MIN/MAX_SECONDS were parsed, range-validated, cross-checked
     * (min <= max) and documented in .env as "Human-like delay bounds between
     * consecutive DMs" — and never read by anything. There was no delay between
     * consecutive sends at all. At 1-2/day that is academic; the danger is that the
     * config asserted a control that did not exist, and raising volume is exactly
     * when someone would rely on it.
     *
     * It also serialises the clipboard, which is process-global: two overlapping
     * sends could otherwise interleave copy/paste and put message A into thread B.
     */
    if (out.sent > 0) {
      const waitSeconds = randomInt(env.SEND_JITTER_MIN_SECONDS, env.SEND_JITTER_MAX_SECONDS)
      log.step('spacing before the next send', { seconds: waitSeconds })
      await new Promise((r) => setTimeout(r, waitSeconds * 1000))
    }
```

- [ ] **Step 2: Do the same in the planner**

In `src/outreach/plan.ts`, add the import:

```ts
import { hoursAgo, istDayStart, randomInt } from '@/lib/time'
```

(keep whichever of those are already imported; add only `randomInt`).

Declare the counter next to the other per-run counters, just after
`const sentBySenderToday = new Map<string, number>()`:

```ts
  /** Sends completed in THIS run, so consecutive ones can be spaced. */
  let sentThisRun = 0
```

Inside `for (const pair of pairs)`, immediately before the `createAndDispatch` call in
the `try` block, insert:

```ts
      // Space consecutive sends. Same reasoning as deliverWaiting: SEND_JITTER_* was
      // validated config that nothing read, and the clipboard is process-global.
      if (sentThisRun > 0) {
        const waitSeconds = randomInt(env.SEND_JITTER_MIN_SECONDS, env.SEND_JITTER_MAX_SECONDS)
        log.step('spacing before the next send', { seconds: waitSeconds })
        await new Promise((r) => setTimeout(r, waitSeconds * 1000))
      }
```

And increment it inside the existing `if (result.status === 'SENT')` block, alongside the
two `Map` updates:

```ts
      if (result.status === 'SENT') {
        sentThisRun += 1
        sentToTargetToday.set(pair.targetId, (sentToTargetToday.get(pair.targetId) ?? 0) + 1)
        sentBySenderToday.set(pair.senderId, (sentBySenderToday.get(pair.senderId) ?? 0) + 1)
      }
```

- [ ] **Step 3: Verify the delay is real but does not fire on a single send**

Run: `pnpm run:slot`
Expected: with 0 or 1 deliverable messages, **no** `spacing before the next send` line — the delay must not add 45-180s to every slot for nothing.

To see it fire, temporarily promote two attempts to READY for two different armed pairs. Expected: one `spacing before the next send` line between the two sends, with `seconds` between 45 and 180.

- [ ] **Step 4: Commit**

```bash
git add src/outreach/deliver.ts src/outreach/plan.ts
git commit -m "fix: honour SEND_JITTER between consecutive sends

The variables were validated and documented as inter-DM pacing and never read
- there was no delay between sends at all. Also serialises the process-global
clipboard, which two overlapping sends could otherwise interleave."
```

### Task 5.3: Sweep stale connect windows on a timer (M-7)

**Files:**
- Modify: `src/outreach/browser/connect.ts`

- [ ] **Step 1: Add the sweeper**

At the bottom of `src/outreach/browser/connect.ts`:

```ts
/**
 * Close abandoned Connect windows.
 *
 * MAX_AGE_MS was only enforced when `pollConnect` was called, so closing the
 * dashboard tab with a window open left Chrome running indefinitely, holding the
 * profile lock. Every later send for that account then failed to launch its profile
 * until someone noticed. A timeout that only fires while someone is watching is not
 * a timeout.
 */
const SWEEP_INTERVAL_MS = 60_000

const sweeper = setInterval(() => {
  void (async () => {
    for (const [handle, s] of [...sessions]) {
      if (Date.now() - s.startedAt > MAX_AGE_MS) {
        log.warn('closing an abandoned connect window', { handle, ageMinutes: Math.round((Date.now() - s.startedAt) / 60_000) })
        await cancelConnect(handle)
      }
    }
  })()
}, SWEEP_INTERVAL_MS)
sweeper.unref?.()
```

- [ ] **Step 2: Verify it does not close a live window early**

Start a connect from the dashboard and leave it for 3 minutes without completing it. Expected: still open, dashboard still polling. The sweeper must only act after `MAX_AGE_MS` (20 min).

- [ ] **Step 3: Verify it does close an abandoned one**

Temporarily set `MAX_AGE_MS = 30_000`, start a connect, close the dashboard tab, and wait 90 seconds. Expected: the Chrome window closes on its own and the log shows `closing an abandoned connect window`. Restore `MAX_AGE_MS` to `20 * 60_000` afterwards.

- [ ] **Step 4: Commit**

```bash
git add src/outreach/browser/connect.ts
git commit -m "fix: sweep abandoned connect windows on a timer

MAX_AGE_MS was only enforced while pollConnect was being called, so closing
the dashboard tab left Chrome holding the profile lock and every later send
for that account failed to launch."
```

---

## Phase 6 — Windows support (D-1, D-2, D-10)

The send path is macOS-only in three places. None is hard to fix; all three are total blockers on Windows.

### Task 6.1: One platform adapter

**Files:**
- Create: `src/lib/platform.ts`
- Test: `tests/platform.test.ts`
- Modify: `src/lib/clipboard.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/platform.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { pasteShortcut, clipboardCommand, openUrlCommand } from '@/lib/platform'

describe('pasteShortcut', () => {
  /**
   * sendDm used the literal 'Meta+V'. In Playwright, Meta is Command on macOS and
   * the SUPER key on Windows, where paste is Control+V - so the paste silently did
   * nothing. It failed safe (the composer read-back found an empty box and refused)
   * but nothing could ever be sent. ControlOrMeta resolves per platform.
   */
  it('is ControlOrMeta+V so Playwright resolves it per platform', () => {
    expect(pasteShortcut()).toBe('ControlOrMeta+V')
  })
})

describe('clipboardCommand', () => {
  it('uses pbcopy on macOS', () => {
    expect(clipboardCommand('darwin')).toMatchObject({ command: 'pbcopy', args: [] })
  })

  /**
   * clip.exe encodes with the console code page, which mangles U+2014 - and the
   * message bodies contain 48 of them. A mangled em-dash makes the composer
   * read-back refuse, but only when the needle line happens to contain one, so the
   * failure would be intermittent. PowerShell Set-Clipboard is UTF-16 native.
   */
  it('uses PowerShell Set-Clipboard on Windows, not clip.exe', () => {
    const c = clipboardCommand('win32')
    expect(c.command).toBe('powershell.exe')
    expect(c.args.join(' ')).toContain('Set-Clipboard')
    expect(c.args.join(' ')).not.toContain('clip.exe')
  })

  it('refuses an unsupported platform rather than silently doing nothing', () => {
    expect(() => clipboardCommand('linux')).toThrow(/not supported/i)
  })
})

describe('openUrlCommand', () => {
  it('uses open on macOS', () => {
    expect(openUrlCommand('darwin', 'https://x.test', null)).toMatchObject({
      command: 'open',
      args: ['https://x.test'],
    })
  })

  it('targets a named browser on macOS', () => {
    expect(openUrlCommand('darwin', 'https://x.test', 'Google Chrome').args).toEqual([
      '-a',
      'Google Chrome',
      'https://x.test',
    ])
  })

  it('uses cmd start on Windows', () => {
    const c = openUrlCommand('win32', 'https://x.test', null)
    expect(c.command).toBe('cmd')
    // The empty "" is the window title start requires before a URL.
    expect(c.args).toEqual(['/c', 'start', '', 'https://x.test'])
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run tests/platform.test.ts`
Expected: FAIL — cannot resolve `@/lib/platform`.

- [ ] **Step 3: Implement**

Create `src/lib/platform.ts`:

```ts
import { spawn } from 'node:child_process'

/**
 * The ONLY place this codebase branches on operating system.
 *
 * Three things in the send path were macOS-only, and each was a total blocker on
 * Windows: `pbcopy`, the `Meta+V` paste shortcut, and `open` for a URL. Keeping the
 * branch in one file means the next platform question has one obvious home rather
 * than three scattered `process.platform` checks.
 *
 * Supported: darwin and win32. Anything else throws rather than half-working — a
 * clipboard that silently does nothing produces an intermittent "composer content
 * does not match" that points at a paste bug instead of at the platform.
 */

export type Platform = 'darwin' | 'win32' | (string & {})

export interface Cmd {
  command: string
  args: string[]
  /** Text piped to stdin, when the command reads it that way. */
  stdin?: string
}

/**
 * Playwright's platform-resolving modifier: Meta on macOS, Control elsewhere.
 *
 * `sendDm` hardcoded 'Meta+V'. On Windows Meta is the Super key, so the paste did
 * nothing at all.
 */
export function pasteShortcut(): string {
  return 'ControlOrMeta+V'
}

/**
 * How to put text on the clipboard.
 *
 * On Windows this is PowerShell's `Set-Clipboard`, NOT `clip.exe`. `clip.exe` encodes
 * from the active console code page, which corrupts U+2014 — and the message bodies
 * contain 48 em-dashes. A corrupted needle line makes the composer read-back refuse
 * the send, and only when the needle happens to contain one, so the failure is
 * intermittent rather than clean. `Set-Clipboard` takes UTF-16 on stdin.
 */
export function clipboardCommand(platform: Platform = process.platform): Cmd {
  if (platform === 'darwin') return { command: 'pbcopy', args: [] }
  if (platform === 'win32') {
    return {
      command: 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-Command', '$input | Set-Clipboard'],
    }
  }
  throw new Error(
    `clipboard is not supported on "${platform}" — this project runs on macOS and Windows only`,
  )
}

/** How to open a URL in the operator's browser. */
export function openUrlCommand(platform: Platform, url: string, browser: string | null): Cmd {
  if (platform === 'darwin') {
    return { command: 'open', args: browser ? ['-a', browser, url] : [url] }
  }
  if (platform === 'win32') {
    // `start` is a cmd builtin, and its first quoted argument is a window title —
    // omitting it makes start treat the URL as the title and open nothing.
    return { command: 'cmd', args: ['/c', 'start', '', url] }
  }
  throw new Error(`opening a URL is not supported on "${platform}"`)
}

/** Runs a Cmd, piping `stdin` when present. */
export function run(cmd: Cmd, stdin?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd.command, cmd.args)
    p.on('error', reject)
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd.command} exited ${code}`))))
    if (stdin !== undefined) {
      // Explicit utf8 so multi-byte characters survive the pipe on both platforms.
      p.stdin.write(stdin, 'utf8')
      p.stdin.end()
    } else {
      p.stdin.end()
    }
  })
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run tests/platform.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Rewrite `clipboard.ts` to delegate**

Replace the whole of `src/lib/clipboard.ts`:

```ts
import { clipboardCommand, run } from './platform'

/**
 * Puts text on the clipboard.
 *
 * Used by `pnpm send` so a human can paste, and by the automated sender so it can
 * paste with a real key press. The second is why this matters beyond convenience — a
 * paste event from the OS clipboard carries `isTrusted: true`, whereas setting the
 * composer's value directly does not.
 *
 * Platform selection lives in `./platform.ts`. This was `spawn('pbcopy')` inline,
 * which made every send fail on Windows.
 */
export function copyToClipboard(text: string): Promise<void> {
  return run(clipboardCommand(), text)
}
```

- [ ] **Step 6: Verify the round-trip preserves an em-dash on this machine**

```bash
cat > verify-clip.ts <<'EOF'
import { copyToClipboard } from '@/lib/clipboard'
import { execFileSync } from 'node:child_process'

const probe = 'Line one — with an em-dash\nLine two — and another'
await copyToClipboard(probe)
const back = execFileSync('pbpaste', { encoding: 'utf8' })
console.log('round-trip identical:', back === probe)
console.log('em-dashes preserved :', (back.match(/—/g) ?? []).length, 'of 2')
EOF
pnpm tsx verify-clip.ts
rm verify-clip.ts
```
Expected:
```
round-trip identical: true
em-dashes preserved : 2 of 2
```

- [ ] **Step 7: Commit**

```bash
git add src/lib/platform.ts src/lib/clipboard.ts tests/platform.test.ts
git commit -m "feat: single platform adapter for clipboard, paste key and URL opening

pbcopy, Meta+V and open are all macOS-only and each was a total blocker on
Windows. Windows uses PowerShell Set-Clipboard rather than clip.exe, which
encodes from the console code page and would corrupt the 48 em-dashes in the
message bodies - producing an intermittent composer read-back failure that
points at a paste bug instead of the platform."
```

### Task 6.2: Use the adapter in the send path

**Files:**
- Modify: `src/outreach/browser/sendDm.ts:137`, `src/scripts/send.ts:135`

- [ ] **Step 1: Fix the paste shortcut**

In `src/outreach/browser/sendDm.ts`, add the import:
```ts
import { pasteShortcut } from '@/lib/platform'
```

And replace line 137:
```ts
    await page.keyboard.press(pasteShortcut())
```

- [ ] **Step 2: Fix the URL open**

In `src/scripts/send.ts`, replace the `openUrl` helper and its call. Change the import at the top to add:
```ts
import { openUrlCommand, run } from '@/lib/platform'
```

Replace the call at line 135:
```ts
    await run(openUrlCommand(process.platform, url, env.SEND_BROWSER))
```

Remove the now-unused `openUrl` const at `send.ts:14` and its `promisify`/`execFile` imports if nothing else uses them.

- [ ] **Step 3: Verify the send still works end to end on macOS**

This is the regression risk: the paste is the highest-risk line in the repo.

```bash
sqlite3 prisma/dev.db "UPDATE OutreachAttempt SET status='READY' WHERE id=(SELECT id FROM OutreachAttempt WHERE status='SKIPPED' AND pairId=(SELECT p.id FROM OutreachPair p JOIN SenderAccount s ON s.id=p.senderId JOIN TargetAccount t ON t.id=p.targetId WHERE s.handle='tabishmukaddam1' AND t.handle='bollywoodsocietyy') LIMIT 1);"
```

Then raise `MAX_TOTAL_SENDS` in `.env` by one (it is at 6/6), restart, and press **Send** on that message in the dashboard.

Expected: it delivers, and `pnpm ig:thread tabishmukaddam1 bollywoodsocietyy` shows the new message as `[US ]`. If the composer read-back refuses, the paste shortcut change is wrong — do not work around it by relaxing the guard.

- [ ] **Step 4: Typecheck, test, commit**

Run: `pnpm test && pnpm typecheck`
Expected: 167 passed.

```bash
git add src/outreach/browser/sendDm.ts src/scripts/send.ts
git commit -m "fix: platform-correct paste shortcut and URL open in the send path

Meta+V is the Super key on Windows, so the paste did nothing and the composer
read-back refused every send. Verified on macOS that the send still delivers
and the message appears in the recipient's thread."
```

### Task 6.3: Establish what is actually true about Chrome profiles on Windows

`CLAUDE.md` makes two load-bearing claims about the profile directory that were measured on macOS and **may be false on Windows**, where Chrome encrypts cookies with DPAPI rather than a hardcoded constant. Both claims drive operator instructions, so guessing is not acceptable.

**Files:**
- Modify: `CLAUDE.md`, `docs/RUNBOOK.md`

- [ ] **Step 1: On a Windows machine, test whether normal Chrome destroys the profile**

The macOS claim is that opening one of these profiles with ordinary Chrome deletes the cookie rows it cannot decrypt, taking `mid`/`datr`/`ig_did` with them — unrecoverable. On Windows, Patchright's `--use-mock-keychain` may be a no-op and both browsers may use the same DPAPI key, in which case the hazard does not exist.

Use a **throwaway** account, never a revenue one:

```
1. pnpm ig:login <throwaway>
2. Record the cookie names present:
   sqlite3 "%USERPROFILE%\.ds-sales-agent\chrome-profiles\<throwaway>\Default\Cookies" ^
     "SELECT name FROM cookies WHERE host_key LIKE '%instagram.com' ORDER BY name;"
3. Close everything. Open that profile with ordinary Chrome:
   "C:\Program Files\Google\Chrome\Application\chrome.exe" --user-data-dir=<profile>
4. Close Chrome. Re-run the query from step 2.
```

Record whether `sessionid`, `mid`, `datr`, `ig_did` survived.

- [ ] **Step 2: Test whether the directory is decryptable off-machine**

The macOS claim is that anyone with a copy can decrypt the cookies offline, because the key is a public constant. DPAPI binds to the Windows user account and machine, which would make this **false** on Windows.

Copy the throwaway profile to a different Windows user account or machine and attempt to read a cookie value. Record whether it decrypts.

- [ ] **Step 3: Write the findings into CLAUDE.md, qualified by platform**

Amend the section "The profile directory is a credential file, and normal Chrome destroys it" so each claim states which platform it was measured on and what the Windows result was. Do not delete the macOS findings; they are verified there.

If Windows turns out to be safe on either count, say so explicitly — an unnecessary prohibition costs credibility, and this file's warnings only work if operators trust them.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md docs/RUNBOOK.md
git commit -m "docs: qualify the Chrome-profile hazards by platform

Both claims were measured on macOS where the cookie key is a hardcoded
constant. Windows uses DPAPI, which may make the 'normal Chrome deletes the
rows' hazard and the 'decryptable offline' exposure untrue there. Measured on
a throwaway account and recorded rather than assumed."
```

### Task 6.4: Write the operator runbook

**Files:**
- Create: `docs/RUNBOOK.md`

- [ ] **Step 1: Write it**

Cover, for macOS and Windows separately:

- **Prerequisites** — Node 22+, pnpm, Google Chrome (not Chromium — Patchright uses `channel: 'chrome'`), and on Windows the build tools `better-sqlite3` needs if no prebuild matches.
- **First run** — `pnpm install`, `pnpm db:push`, `pnpm db:seed`, `pnpm start`, then http://127.0.0.1:3000. State plainly that the dashboard is loopback-only by design and how to reach it from another machine if genuinely needed (SSH tunnel), and that exposing it means exposing a Send button.
- **Connecting an account** — press Connect, log in *in the Chrome window that opens*, complete 2FA there. Nothing in this repo reads the password. If it says "needs a 2FA code", that is routine and the account is **not** flagged.
- **When an account is halted** — what CHALLENGED means, that it is never cleared automatically, and that clearing it requires looking at the account first.
- **The four autopilot switches**, and that any one missing means the message waits rather than being dropped.
- **Never open a profile with ordinary Chrome** — with the platform-specific truth established in Task 6.3, and the correct flags if a manual launch is unavoidable.
- **Backing up `~/.ds-sales-agent`** (`%USERPROFILE%\.ds-sales-agent` on Windows) — it holds device identity that cannot be rebuilt, and on macOS it is decryptable offline, so treat it as a password file.

- [ ] **Step 2: Commit**

```bash
git add docs/RUNBOOK.md
git commit -m "docs: operator runbook for macOS and Windows"
```

---

## Phase 7 — Consistency and silent failures

### Task 7.1: Surface the route-toggle result (L-1)

**Files:**
- Modify: `src/app/accounts.tsx` (`RouteChip`)

- [ ] **Step 1: Handle the result**

`RouteChip.flip` discards the `MutationResult`, so a refused toggle (`optedOut`, missing pair) shows nothing and the chip just reverts. Add a `msg` state and render it, following the pattern `AccountRow` already uses:

```tsx
function RouteChip({ senderHandle, route }: { senderHandle: string; route: AccountCard['routes'][number] }) {
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const flip = async () => {
    setBusy(true)
    setMsg(null)
    try {
      const r = await setPairEnabled(senderHandle, route.targetHandle, !route.enabled)
      // Only surface a refusal. A success is visible in the chip itself.
      if (!r.ok) setMsg(r.message)
    } finally {
      setBusy(false)
    }
  }
```

Render `{msg ? <span className="chip-error">{msg}</span> : null}` next to the button.

- [ ] **Step 2: Verify the refusal is now visible**

```bash
sqlite3 prisma/dev.db "UPDATE TargetAccount SET optedOut=1 WHERE handle='priyanshu123321123';"
```
In the dashboard, try to enable a route to that channel. Expected: the message *"@priyanshu123321123 is marked never-contact. Re-add it first."* appears. Then restore:
```bash
sqlite3 prisma/dev.db "UPDATE TargetAccount SET optedOut=0 WHERE handle='priyanshu123321123';"
```

- [ ] **Step 3: Commit**

```bash
git add src/app/accounts.tsx
git commit -m "fix: surface a refused route toggle instead of silently reverting"
```

### Task 7.2: Consistent failure recovery (L-2)

**Files:**
- Modify: `src/outreach/plan.ts` (`applyOutcome`)

- [ ] **Step 1: Keep the draft on failure**

`applyOutcome` sets `FAILED`, so the drafted body is abandoned and no Send button appears. `deliverWaiting` and `sendNow` both set `READY` so a human can retry. Same event, three outcomes. Align on `READY`, with the error attached:

```ts
  // FAILED. Keep the draft READY so a human can retry or send it by hand, which is
  // what deliverWaiting and sendNow both do. Setting FAILED here abandoned a
  // perfectly good body and left the pair to redraft from scratch next slot.
  await prisma.outreachAttempt.update({
    where: { id: attemptId },
    data: { status: 'READY', error: outcome.error },
  })
```

Leave the `outcome.challenged` branch below it exactly as it is.

- [ ] **Step 2: Confirm the ceiling accounting still holds**

`READY` counts toward `MAX_TOTAL_SENDS` where `FAILED` did not, which is correct — a draft waiting to be sent is a message in flight. Verify:

```bash
pnpm queued
```
Expected: a failed-then-retained draft appears in the waiting list with its error, and `pnpm ig:audit` counts it.

- [ ] **Step 3: Commit**

```bash
git add src/outreach/plan.ts
git commit -m "fix: a failed planner send keeps its draft READY like the other two paths"
```

### Task 7.3: Misleading errors and creation asymmetries (L-4, L-8, L-9)

**Files:**
- Modify: `src/outreach/browser/session.ts` (`loggedInAs`), `src/app/actions.ts` (`addSender`, `addTarget`)

- [ ] **Step 1: Stop reporting a network failure as "not logged in" (L-4)**

`loggedInAs` catches everything and returns `null`, which `assertLoggedInAs` turns into
`NotLoggedInError` — telling the operator to run `pnpm ig:login`. Re-logging-in is the
risky action, so a transient network blip must not prompt one.

In `src/outreach/browser/session.ts`, add an error class beside the others:

```ts
export class IdentityCheckFailedError extends Error {
  constructor(readonly handle: string, readonly cause: string) {
    super(
      `could not confirm which account @${handle} is logged in as (${cause}) — ` +
        `NOT sending, and NOT a reason to log in again`,
    )
    this.name = 'IdentityCheckFailedError'
  }
}
```

Change `loggedInAs` to distinguish "logged out" from "could not ask". Replace its
`catch` and the two `return null` paths:

```ts
export type IdentityResult =
  | { kind: 'logged-in'; username: string }
  | { kind: 'logged-out' }
  | { kind: 'unknown'; cause: string }

export async function identify(page: Page): Promise<IdentityResult> {
  const userId = await sessionUserId(page)
  if (!userId) return { kind: 'logged-out' }

  try {
    const res = await page.request.get(`https://www.instagram.com/api/v1/users/${userId}/info/`, {
      headers: { 'x-ig-app-id': '936619743392459' },
    })
    const contentType = res.headers()['content-type'] ?? ''
    // Logged out, Instagram serves the login page with HTTP 200 and HTML, not a 4xx.
    if (!res.ok() || !contentType.includes('json')) return { kind: 'logged-out' }

    const body = (await res.json()) as { user?: { username?: string } }
    const username = body.user?.username?.toLowerCase()
    return username ? { kind: 'logged-in', username } : { kind: 'logged-out' }
  } catch (err) {
    /**
     * A session cookie exists but the lookup could not be made. That is NOT the same
     * as logged out, and conflating them told the operator to re-login on a network
     * blip — the one action that carries real risk.
     */
    return { kind: 'unknown', cause: err instanceof Error ? err.message : String(err) }
  }
}

/** Backwards-compatible wrapper — `null` means "not confirmed as anyone". */
export async function loggedInAs(page: Page): Promise<string | null> {
  const r = await identify(page)
  return r.kind === 'logged-in' ? r.username : null
}
```

And in `assertLoggedInAs`, use `identify` so the third state is distinguishable:

```ts
export async function assertLoggedInAs(page: Page, expected: string): Promise<void> {
  const r = await identify(page)
  if (r.kind === 'unknown') throw new IdentityCheckFailedError(expected, r.cause)
  if (r.kind === 'logged-out') throw new NotLoggedInError(expected)
  if (r.username !== expected.toLowerCase()) throw new WrongAccountError(expected, r.username)
}
```

`connect.ts` keeps using `loggedInAs` and needs no change.

- [ ] **Step 2: Verify the positive direction still works**

Run: `pnpm ig:thread tabishmukaddam1 bollywoodsocietyy`
Expected: reads the thread normally. `assertLoggedInAs` runs inside it, so a break here
means every send is broken — this is the direction that matters.

- [ ] **Step 3: Fix the sender/target asymmetry (L-8)**

`addSender` refuses a handle that is already a channel (*"it cannot also send"*), but
`addTarget` deliberately allows a sender to become a target — and `@bollywoodsocietyy`
is now in exactly that state. The same combined state is reachable one way and forbidden
the other.

In `src/app/actions.ts`, replace the check in `addSender`:

```ts
  if (await prisma.targetAccount.findUnique({ where: { handle } })) {
    return { ok: false, message: `@${handle} is already a channel you watch — it cannot also send.` }
  }
```

with:

```ts
  /**
   * Being both a sender and a target is allowed — messaging one account you own from
   * another is the safest end-to-end rehearsal available, which is why `addTarget`
   * permits it. This used to refuse it, so the same state was reachable by adding the
   * target second and forbidden by adding the sender second.
   *
   * The invariant that actually matters is narrower and is enforced below: a sender
   * must never message ITSELF.
   */
  const alsoATarget = await prisma.targetAccount.findUnique({ where: { handle } })
```

and append to the success message when `alsoATarget` is set:

```ts
      alsoATarget
        ? ` Note @${handle} is also a channel you watch; no route from it to itself was created.`
        : ''
```

- [ ] **Step 4: Make pair creation transactional (L-9)**

Both `addSender` and `addTarget` create pairs in a `for` loop of separate `create`
calls, so a mid-loop failure leaves an account wired to only some channels. Replace the
loop in `addSender`:

```ts
  const targets = await prisma.targetAccount.findMany()
  // One statement, so a failure cannot leave a sender wired to only some channels.
  await prisma.outreachPair.createMany({
    data: targets
      .filter((t) => t.handle !== handle) // never a pair from an account to itself
      .map((t) => ({
        senderId: sender.id,
        targetId: t.id,
        cooldownDays: env.DEFAULT_COOLDOWN_DAYS,
        enabled: false,
      })),
  })
```

And the equivalent in `addTarget`:

```ts
  const senders = await prisma.senderAccount.findMany()
  await prisma.outreachPair.createMany({
    data: senders
      .filter((s) => s.handle !== handle)
      .map((s) => ({
        senderId: s.id,
        targetId: target.id,
        cooldownDays: env.DEFAULT_COOLDOWN_DAYS,
        enabled: false,
      })),
  })
```

- [ ] **Step 5: Verify adding still creates disabled pairs, and no self-pair**

```bash
sqlite3 prisma/dev.db "SELECT count(*) FROM OutreachPair;"
```
Note the number. Then add a channel from the dashboard (use a handle you own or a
plausible one — `handleExists` will warn if unreachable but still add). Re-run the count
and check the new pairs:

```bash
sqlite3 prisma/dev.db "
SELECT s.handle, t.handle, p.enabled FROM OutreachPair p
JOIN SenderAccount s ON s.id=p.senderId JOIN TargetAccount t ON t.id=p.targetId
WHERE t.handle='<the handle you added>';"
```
Expected: one row per sender, **all `enabled=0`**, and no row where sender = target.
Then remove it (it has no history, so it deletes outright).

- [ ] **Step 6: Typecheck, test, commit**

Run: `pnpm test && pnpm typecheck`
Expected: 167 passed.

```bash
git add src/outreach/browser/session.ts src/app/actions.ts
git commit -m "fix: distinguish 'cannot ask' from 'logged out'; allow sender-as-target; transactional pair creation

loggedInAs swallowed network errors into null, so a blip told the operator to
log in again - the one action that carries real risk. addSender refused a handle
that was already a channel while addTarget deliberately allowed the reverse, so
the same state was reachable one way only. Pair creation loops replaced with
createMany so a partial failure cannot half-wire an account."
```

### Accepted without change (L-5, L-6)

Recorded rather than silently dropped:

- **L-5** — `profileStatus` copies the Chrome cookie DB to `tmpdir` on every call. Measured: the source is `-rw-------` and `copyFileSync` preserves mode, so the copy is `0600` and the exposure window is a crash between copy and `rmSync`. The cost of a redesign exceeds the risk. Revisit if the profile directory ever moves somewhere with looser permissions.
- **L-6** — the same function does synchronous file I/O plus a SQLite open per account inside the render path. Real, but with four accounts it is imperceptible, and caching it would introduce a staleness question on the gate that decides whether unattended sending happens. Leave it slow and correct.

---

## Phase 8 — Close the loop

### Task 8.1: Full verification pass

- [ ] **Step 1: Everything green**

```bash
pnpm test && pnpm typecheck
```
Expected: 167 passed; typecheck silent.

- [ ] **Step 2: Build, then start — never the other way round**

```bash
kill $(lsof -nP -iTCP:3000 -sTCP:LISTEN -t) 2>/dev/null; sleep 3
pnpm build && pnpm start &
sleep 15
```

- [ ] **Step 3: Verify the page actually works, not just that the server answers**

```bash
HTML=$(curl -s http://127.0.0.1:3000/)
echo "$HTML" | grep -o '/_next/static/[^"]*\.js' | sort -u | while read -r c; do
  printf "%s -> %s\n" "$c" "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:3000$c")"
done
```
Expected: every chunk `200`.

- [ ] **Step 4: Cross-check every dashboard number**

```bash
pnpm ig:audit
```
Expected: `SENT + REPLIED + READY + QUEUED + SENDING` equals what `MAX_TOTAL_SENDS` is being compared against, and `messages sent` includes REPLIED.

- [ ] **Step 5: Confirm the guards fire on live data**

```bash
pnpm queued
```
Expected: `tabishmukaddam1→bollywoodchronicle` still held with `target-replied`; no pair held with `no-new-material-to-reference` that has fresh campaigns.

### Task 8.2: Update the docs

**Files:**
- Modify: `CLAUDE.md`, `docs/HANDOFF.md`, `docs/AUDIT-2026-07-31.md`

- [ ] **Step 1: `CLAUDE.md` — new gotchas**

Add, in the established style (why, not just what):

- The dashboard is loopback-only, and why exposing it means exposing a Send button.
- One gate, two callers — `gate.ts` exists because `sendNow` drifted five checks behind `deliverWaiting`. Never re-inline it.
- A needle taken from the greeting makes both send guards tautologies; the ends are excluded from the fallback too.
- 2FA is not enforcement. `/two_factor` was in `CHECKPOINT_PATHS` and halted accounts for a routine re-prompt.
- Enforcement is usually a modal, not a URL.
- `REPLIED` replaces `SENT`; any delivered-count must include both.
- The platform branch lives in exactly one file; `clip.exe` corrupts em-dashes.

- [ ] **Step 2: `docs/HANDOFF.md` — current state**

Update the accounts/attempts tables, note that `MAX_TOTAL_SENDS` is still the binding constraint, and replace the next-steps list with what remains.

- [ ] **Step 3: `docs/AUDIT-2026-07-31.md` — mark findings closed**

Add a `Status` column: `fixed` / `fixed, verified on macOS only` / `open — needs a decision`. Do not delete findings; the audit is the record of why these changes exist.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md docs/HANDOFF.md docs/AUDIT-2026-07-31.md
git commit -m "docs: record the audit remediation and its verification"
```

---

## Findings dropped or folded in, so every audit ID is accounted for

The audit's `D-n` findings were written for a Linux/Linode host. That is no longer the
target — macOS and Windows only — so some no longer apply. Recorded explicitly rather
than left silently absent, because "not in the plan" and "not a problem" are different
things and a future reader cannot tell them apart from an omission.

| ID | Disposition |
|---|---|
| **D-3** Xvfb / `headless: false` needs a display | **Dropped.** Both targets have a real desktop. Do **not** reintroduce `headless: true` to compensate for anything — `CLAUDE.md` requires `headless: false` and the reason is measurable. |
| **D-4** Connect cannot be completed remotely | **Dropped.** The operator is at the keyboard, so the Chrome window is reachable and 2FA can be typed into it. This was the blocker that made a remote host unworkable; it evaporates on a desktop. |
| **D-5** public exposure + the fix locking you out | **Folded into Task 0.1.** Loopback binding is the whole fix on a desktop; there is no remote-access half to solve. The runbook (Task 6.4) covers reaching it from another machine via an SSH tunnel if that is ever genuinely wanted, and says plainly that exposing it means exposing a Send button. |
| **D-7** profile directory must outlive deploys | **Partly dropped, partly folded into Task 6.4.** No container or release pipeline destroys it on a desktop. What remains real is the backup guidance — the directory holds device identity that cannot be rebuilt, and on macOS it is decryptable offline — so the runbook covers treating it as a credential file. Task 6.3 establishes the Windows truth. |
| **D-8** datacenter IP throttling detection | **Dropped.** Sending and detection now run from the same residential connection the accounts normally use, which is what `CLAUDE.md` decision 1 requires. This also removes the cascade where no `CAMPAIGN` verdicts meant `NO_NEW_MATERIAL` blocked every follow-up. |
| **D-9** `connect.ts`'s in-memory Map | **Effectively dropped; one runbook line.** `next start` is a single process, so the Map holds. The runbook notes: run the dashboard alone and do not also start `pnpm worker`, or Connect polling can land on the wrong process. The related stale-cookie path is fixed properly in Task 4.3 Step 4. |

**Also worth stating:** dropping Linux resolves the one conflict in the audit that was
not a bug. Decision 1 requires the same home residential IP the accounts normally use,
with no VPS — and a desktop deployment satisfies that, where Linode contradicted it.
Nothing in this plan is a mitigation for a datacenter IP, because there no longer is one.

---

## Deliberately NOT in this plan

These need a decision from Tabish, not an implementation choice. Each would be wrong for me to pick unilaterally.

| Finding | Decision needed |
|---|---|
| **M-5** shared persona | All four senders introduce themselves as "Kapil Jain, Co-founder, Bollywood Society". Three revenue accounts emit byte-identical intro and signature blocks — the cross-account repetition decision 3 exists to prevent. Needs real names per brand. **Do not generate plausible ones.** |
| `MAX_TOTAL_SENDS` | Full at 6/6, so nothing can send until it moves. Task 6.2 needs it raised by one to verify the paste; that is a test allowance, not the production number. |
| Automatic reply detection | `pnpm ig:thread` works and is manual. Running it every slot means a browser session per pair per slot — a real increase in automation volume against these accounts. |
| The 2–4 week soak | Still never done. The first send from a revenue account remains the real test. Nothing in this plan changes that, and none of it should be read as having changed it. |
| **L-10** `thread.ts` selectors | Observed against the live DOM on 2026-07-31 and will drift. Needs a periodic re-check, not a code fix. |

## Test count

| Suite | Before | After |
|---|---|---|
| existing | 124 | 124 |
| `tests/gate.test.ts` | — | +13 |
| `tests/matching.test.ts` | — | +7 |
| `tests/session-paths.test.ts` | — | +15 |
| `tests/platform.test.ts` | — | +8 |
| **total** | **124** | **167** |

Every added test asserts a guard both firing and not firing. That is not stylistic: eight findings in this project's history are guards that were only ever verified in the direction that passes.
