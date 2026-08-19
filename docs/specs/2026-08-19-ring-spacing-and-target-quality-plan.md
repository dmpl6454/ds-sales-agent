# Ring Spacing, Held-Queue Visibility, and Target Quality — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the sender-blind 7-day spacing rule (which has halted the entire fleet — measured 2026-08-19: 33 of 33 waiting drafts held, first clear 24 Aug) with Tabish's ring rule — every page may contact a recipient, and the 7-day rest applies only once ALL pages have — plus: make held drafts visible in "Up next", lengthen the reply halt to 7 days, audit/remove faulty targets, discover official brand pages for untagged paid posts (verified-badge bar), and admit verified celebrities tagged in paid campaigns as targets.

**Architecture:** One new PURE module (`src/outreach/crossSpacing.ts`) becomes the single definition of cross-page spacing, called by all three enforcement/display sites (gate, governor via plan.ts, messages-page view model) — the "one rule, several callers" defect class this codebase keeps rediscovering is prevented by a source-grep test, exactly like `tests/cross-account-spacing.test.ts` does today for the rule being replaced. Target quality and discovery reuse the existing `enrichHandle` → `resolveBrand` → `createBrandTarget` chain; nothing new talks to Instagram.

**Tech Stack:** TypeScript, Prisma 7 (Postgres prod / SQLite dev — remember the two-provider trap), Next.js dashboard, vitest, Patchright on the device agent.

---

## MEASURED STATE, 2026-08-19 18:07 IST (the justification — do not re-derive)

- Autopilot **healthy**: `autopilotEnabled=true`, device agent pid alive under caffeinate, tunnel up, dispatcher ticking every minute.
- **68 delivered in the 6h before the halt; 72 in 24h.** Last delivery 16:31 IST. Then `dispatchState.reason = "all-held"`: all 33 waiting drafts refused with *"this recipient heard from @X N day(s) ago — spacing applies across every page, not per account"*.
- **33/33 held by cross-page spacing.** First clears **Aug 24 12:37 UTC**, last Aug 26. Zero clear within 48h. Without this plan the fleet is idle ~5 days.
- **76 recipients heard from exactly 1 sender in 7d, 5 from 2, 1 from 3.** Under the ring rule, all 33 drafts become immediately eligible (their other-page contact is ≥24h old).
- Prospect inflow is dry: 90 live prospects, only 7 never-touched (all person-guard refusals). The queue will drain again quickly — workstreams C/D/E are what refill it.
- 4 reply halts active. 1 FAILED row (`not-in-thread` — the guard working, leave it).

## DECISIONS RECORDED AS TABISH'S (state plainly, do not soften)

1. **Ring spacing** replaces sender-blind spacing. A recipient may now hear from up to 5 of our pages inside one week, near-identical template each time. This reinstates the recipient-side pattern the 2026-08-18 measurement flagged (@absolutejk, 3 pages, 2 days). Risk stated; his call; the `crossPageGapHours` Setting (default **24**) is the one editorial mitigation — it spreads the ring to one page per day per recipient. He can zero it in one Setting row.
2. **Reply halt: 48h → 7 days** (auto-resume), manual "I have replied" early release unchanged. More conservative; still his call to record.
3. **Celebrities/talent tagged in paid campaigns become messageable** when verified or very large. DMing celebrity inboxes from revenue accounts raises report likelihood; his call.
4. **Official-page discovery constructs candidate handles from brand names.** "Never guess a handle" was measured (wrong 4/10, 3 of 4 wrong handles EXIST). The bar here is identity-grade, not existence: auto-accept only a **verified badge + name match**, or **≥100k followers + exact name match + business account**. Everything else goes to a human. This is an amendment to the rule, not a repeal.

---

# Workstream A — Ring spacing (unblocks the fleet)

### Task A1: Pure module `crossSpacing.ts`

**Files:**
- Create: `src/outreach/crossSpacing.ts`
- Test: `tests/cross-spacing.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/cross-spacing.test.ts
import { describe, expect, it } from 'vitest'
import { crossSpacingVerdict } from '@/outreach/crossSpacing'

const now = new Date('2026-08-19T12:00:00Z')
const daysAgo = (d: number) => new Date(now.getTime() - d * 24 * 3600 * 1000)
const hoursAgo = (h: number) => new Date(now.getTime() - h * 3600 * 1000)
const base = { now, windowDays: 7, crossPageGapHours: 24, thisSenderId: 's1' }
const delivery = (sentAt: Date, handle = 'other') => ({ sentAt, handle })

describe('crossSpacingVerdict', () => {
  it('clear when nobody has written to the recipient', () => {
    expect(
      crossSpacingVerdict({ ...base, eligibleSenderIds: ['s1', 's2'], lastDeliveryBySender: new Map() }),
    ).toEqual({ held: false })
  })

  it('clear when ONE other page wrote outside the inter-page gap — the rule Tabish reversed', () => {
    const v = crossSpacingVerdict({
      ...base,
      eligibleSenderIds: ['s1', 's2', 's3'],
      lastDeliveryBySender: new Map([['s2', delivery(hoursAgo(30))]]),
    })
    expect(v.held).toBe(false)
  })

  it('held (inter-page-gap) when a DIFFERENT page wrote within crossPageGapHours', () => {
    const v = crossSpacingVerdict({
      ...base,
      eligibleSenderIds: ['s1', 's2'],
      lastDeliveryBySender: new Map([['s2', delivery(hoursAgo(3), 'bollywoodchronicle')]]),
    })
    expect(v).toMatchObject({ held: true, kind: 'inter-page-gap', otherHandle: 'bollywoodchronicle' })
  })

  it('own delivery within the gap does NOT hold — self-repetition is the pair rules\' job', () => {
    const v = crossSpacingVerdict({
      ...base,
      eligibleSenderIds: ['s1', 's2'],
      lastDeliveryBySender: new Map([['s1', delivery(hoursAgo(3))]]),
    })
    expect(v.held).toBe(false)
  })

  it('held (ring-complete) when EVERY eligible sender delivered within the window', () => {
    const v = crossSpacingVerdict({
      ...base,
      eligibleSenderIds: ['s1', 's2', 's3'],
      lastDeliveryBySender: new Map([
        ['s1', delivery(daysAgo(6))],
        ['s2', delivery(daysAgo(4))],
        ['s3', delivery(daysAgo(2))],
      ]),
    })
    expect(v).toMatchObject({ held: true, kind: 'ring-complete', senderCount: 3 })
    if (v.held && v.kind === 'ring-complete') {
      // resumes when the OLDEST in-window delivery ages out: 6 days ago + 7 days = 1 day from now
      expect(v.resumesAt.getTime()).toBe(daysAgo(6).getTime() + 7 * 24 * 3600 * 1000)
    }
  })

  it('NOT ring-complete when one eligible sender has not written (or wrote before the window)', () => {
    const v = crossSpacingVerdict({
      ...base,
      eligibleSenderIds: ['s1', 's2', 's3'],
      lastDeliveryBySender: new Map([
        ['s1', delivery(daysAgo(2))],
        ['s2', delivery(daysAgo(8))], // aged out
        ['s3', delivery(daysAgo(3))],
      ]),
    })
    // s2 aged out, so the ring is open again — but s3 wrote 3d ago (> 24h), so no gap hold either
    expect(v.held).toBe(false)
  })

  it('empty eligible set never holds (vacuous "all" must not fire)', () => {
    const v = crossSpacingVerdict({ ...base, eligibleSenderIds: [], lastDeliveryBySender: new Map() })
    expect(v.held).toBe(false)
  })

  it('crossPageGapHours: 0 disables the inter-page gap entirely', () => {
    const v = crossSpacingVerdict({
      ...base,
      crossPageGapHours: 0,
      eligibleSenderIds: ['s1', 's2'],
      lastDeliveryBySender: new Map([['s2', delivery(hoursAgo(0.02))]]),
    })
    expect(v.held).toBe(false)
  })
})
```

- [ ] **Step 2: Run to verify failure** — `pnpm vitest run tests/cross-spacing.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement**

```ts
// src/outreach/crossSpacing.ts
/**
 * Cross-page spacing, reshaped 2026-08-19 on Tabish's instruction:
 *
 *   "there is no limit except the 7 day constraint which should occur only if target
 *    has been contacted by all targets or a reply has been detected"
 *
 * The OLD rule (any other page delivered within 7 days → hold) halted the whole fleet
 * the day after the 1-minute pace shipped — MEASURED: 33/33 waiting drafts held, first
 * clear 5 days out, while 76 recipients had heard from exactly ONE page. The NEW rule:
 *
 *   ring-complete  — hold only when EVERY eligible fleet sender has delivered to this
 *                    recipient within `windowDays`. Releases when the oldest in-window
 *                    delivery ages out.
 *   inter-page-gap — a DIFFERENT page delivered within `crossPageGapHours` (Setting,
 *                    default 24, 0 disables). Without it the planner would walk the whole
 *                    ring through one inbox in an afternoon — five near-identical
 *                    templates in five minutes is the recipient-side ban pattern. The
 *                    ban-pattern risk of the ring rule itself was stated to Tabish and is
 *                    recorded as his call; this gap is the one mitigation he owns.
 *
 * Self-deliveries never hold here: one page re-messaging its own recipient is governed
 * by NO_NEW_MATERIAL and PAIR_DAILY_CAP (the 2026-08-18 decision), and re-adding a
 * self-window would silently reinstate the 7-day pair cooldown Tabish deleted.
 *
 * ONE implementation, THREE callers (gate.ts, plan.ts→governor, messages-page.ts).
 * tests/cross-account-spacing.test.ts greps all three call sites — a blocker fixed on
 * one path and not the others is this codebase's most repeated defect.
 */

const MS_PER_HOUR = 3_600_000
const MS_PER_DAY = 24 * MS_PER_HOUR

export type CrossSpacingVerdict =
  | { held: false }
  | { held: true; kind: 'inter-page-gap'; otherHandle: string; hoursAgo: number; resumesAt: Date }
  | { held: true; kind: 'ring-complete'; senderCount: number; resumesAt: Date }

export function crossSpacingVerdict(input: {
  now: Date
  windowDays: number
  crossPageGapHours: number
  thisSenderId: string
  /** Every fleet sender rotation could elect today — machine-independent facts only. */
  eligibleSenderIds: string[]
  /** senderId → that sender's most recent delivery to this recipient (any age). */
  lastDeliveryBySender: Map<string, { sentAt: Date; handle: string }>
}): CrossSpacingVerdict {
  const { now, windowDays, crossPageGapHours, thisSenderId, eligibleSenderIds, lastDeliveryBySender } = input
  const windowFloor = now.getTime() - windowDays * MS_PER_DAY

  const inWindow = new Map(
    [...lastDeliveryBySender].filter(([, d]) => d.sentAt.getTime() >= windowFloor),
  )

  // Ring-complete: everyone eligible has written recently → the 7-day rest Tabish chose.
  if (eligibleSenderIds.length > 0 && eligibleSenderIds.every((id) => inWindow.has(id))) {
    const oldest = Math.min(...eligibleSenderIds.map((id) => inWindow.get(id)!.sentAt.getTime()))
    return {
      held: true,
      kind: 'ring-complete',
      senderCount: eligibleSenderIds.length,
      resumesAt: new Date(oldest + windowDays * MS_PER_DAY),
    }
  }

  // Inter-page gap: a different page wrote very recently.
  if (crossPageGapHours > 0) {
    const gapFloor = now.getTime() - crossPageGapHours * MS_PER_HOUR
    let newest: { sentAt: Date; handle: string } | null = null
    for (const [senderId, d] of inWindow) {
      if (senderId === thisSenderId) continue
      if (d.sentAt.getTime() >= gapFloor && (newest === null || d.sentAt > newest.sentAt)) newest = d
    }
    if (newest !== null) {
      return {
        held: true,
        kind: 'inter-page-gap',
        otherHandle: newest.handle,
        hoursAgo: (now.getTime() - newest.sentAt.getTime()) / MS_PER_HOUR,
        resumesAt: new Date(newest.sentAt.getTime() + crossPageGapHours * MS_PER_HOUR),
      }
    }
  }

  return { held: false }
}

/** One sentence for gate/governor detail strings — writer and screen share bytes. */
export function crossSpacingDetail(v: CrossSpacingVerdict): string | null {
  if (!v.held) return null
  if (v.kind === 'inter-page-gap') {
    const h = Math.max(1, Math.round(v.hoursAgo))
    return `@${v.otherHandle} wrote to this recipient ${h}h ago — one page per ${''}day per recipient, next page resumes ${v.resumesAt.toISOString()}`
  }
  return `all ${v.senderCount} of our pages have written to this recipient in the last week — resting until ${v.resumesAt.toISOString()}`
}
```

- [ ] **Step 4: Run** `pnpm vitest run tests/cross-spacing.test.ts` → PASS. Mutation-test by hand: flip `every` to `some`, confirm two tests fail, revert.

- [ ] **Step 5: Commit** — `git add src/outreach/crossSpacing.ts tests/cross-spacing.test.ts && git commit -m "Ring spacing predicate: hold only when every page has written (Tabish, 2026-08-19)"`

### Task A2: Settings — `crossPageGapHours`

**Files:**
- Modify: `src/lib/settings.ts` (follow the existing pattern exactly: `SETTING_KEYS` entry ~line 21-34, interface field ~57-119, default in the defaults object ~230-255, `num(...)` read ~341-381)

- [ ] **Step 1:** Add `crossPageGapHours: 'crossPageGapHours'` to `SETTING_KEYS`, `crossPageGapHours: number` to the settings interface, default `crossPageGapHours: 24` beside `defaultCooldownDays`, and `crossPageGapHours: num(SETTING_KEYS.crossPageGapHours, d.crossPageGapHours)` in the reader. Comment on the default: `// 24h between DIFFERENT pages to one recipient; 0 disables. Tabish's lever on the ring rule's ban-pattern risk.`
- [ ] **Step 2:** `pnpm typecheck` → clean. Extend the settings test file if one asserts key totality (grep `tests/` for `SETTING_KEYS`; follow whatever totality pattern exists).
- [ ] **Step 3: Commit.**

### Task A3: Eligible-sender reader

**Files:**
- Modify: `src/outreach/availability.ts` (append; keep every fact machine-independent — this runs on the Linode AND the Mac)
- Test: `tests/availability-eligible.test.ts` (against a real temp SQLite file, the `tests/cohorts-live.test.ts` pattern — this is assembled from a Prisma `select`, where a stale column name fails at runtime while typecheck passes)

- [ ] **Step 1: Failing test** — seed a fleet ACTIVE sender with a recorded session (eligible), a `fleetMember: false` burner (excluded), and a `sessionInvalidAt`-marked account (excluded); assert `eligibleFleetSenderIds()` returns exactly the first.
- [ ] **Step 2: Implement**

```ts
/**
 * The senders the ring rule counts as "all our pages". MACHINE-INDEPENDENT on purpose —
 * the governor asks on the Linode, the gate asks on the Mac, and a filesystem fact here
 * would make the two enforcers disagree (the profileStatus trap, again).
 * Reuses readSenderAvailability so "who rotation would skip" and "who the ring counts"
 * can never drift apart.
 */
export async function eligibleFleetSenderIds(): Promise<string[]> {
  const [fleet, unavailable] = await Promise.all([
    prisma.senderAccount.findMany({ where: { fleetMember: true, status: 'ACTIVE' }, select: { id: true } }),
    readSenderAvailability(),
  ])
  return fleet.map((s) => s.id).filter((id) => !unavailable.has(id))
}
```

(Confirm at implementation time that `readSenderAvailability()`'s Map is keyed by sender **id**, not handle — read the top of `availability.ts`; if keyed by handle, select handles and filter on those.)

- [ ] **Step 3:** Run test → PASS. **Commit.**

### Task A4: Gate — replace the sender-blind lookup

**Files:**
- Modify: `src/outreach/gate.ts` — the pure check at :322-331 and the query wrapper at ~:398-455 (the `pair: { targetId, senderId: { not: senderId } }` lookup feeding `targetRecentContact`)
- Test: update `tests/stopInventory.test.ts` fixtures at :158 and :315

- [ ] **Step 1:** In `GateInput`, replace `targetRecentContact: { fromHandle; hoursAgo } | null` with `crossSpacing: CrossSpacingVerdict`. In the pure check, keep the stop name (`RESEND_BLOCKS.TARGET_RECENTLY_CONTACTED` — `STOP_LABELS`/`remedy.ts` totality then needs no change) and emit `crossSpacingDetail(input.crossSpacing)`:

```ts
if (input.crossSpacing.held) {
  return {
    ok: false,
    reason: RESEND_BLOCKS.TARGET_RECENTLY_CONTACTED,
    detail: crossSpacingDetail(input.crossSpacing)!,
  }
}
```

- [ ] **Step 2:** In the query wrapper, replace the single `findFirst` with:

```ts
const [eligibleIds, recentRows] = await Promise.all([
  eligibleFleetSenderIds(),
  prisma.outreachAttempt.findMany({
    where: { targetId, status: { in: [...DELIVERED_STATUSES] }, sentAt: { gte: windowFloor } },
    select: { senderId: true, sentAt: true, pair: { select: { sender: { select: { handle: true } } } } },
    orderBy: { sentAt: 'asc' }, // later rows overwrite → map holds each sender's newest
  }),
])
const lastDeliveryBySender = new Map(
  recentRows.map((r) => [r.senderId, { sentAt: r.sentAt!, handle: r.pair.sender.handle }]),
)
// then in the GateInput assembly:
crossSpacing: crossSpacingVerdict({
  now, windowDays: settings.defaultCooldownDays, crossPageGapHours: settings.crossPageGapHours,
  thisSenderId: senderId, eligibleSenderIds: eligibleIds, lastDeliveryBySender,
}),
```

(`windowFloor = new Date(now.getTime() - settings.defaultCooldownDays * 86_400_000)`. If `OutreachAttempt` lacks a direct `targetId` column in the Prisma client — the `@@index([targetId, sentAt])` says it has one — use it; otherwise go through `pair: { targetId }`.)

- [ ] **Step 3:** Also fix the stale reply-halt string at gate.ts:310 — `'messaging them pauses for two days'` → `'messaging them pauses for seven days, then resumes on its own'` (Task A6 changes the number this describes).
- [ ] **Step 4:** Update `tests/stopInventory.test.ts` fixtures so the stop stays REACHABLE: the `target-recently-contacted` case must now construct **all eligible senders delivered in-window** (ring-complete) — a fixture pinning the old one-sender shape goes stale GREEN, the exact failure that file's own history warns about. Add a second direction: one-sender-contacted-30h-ago must be **sendable**.
- [ ] **Step 5:** `pnpm vitest run tests/stopInventory.test.ts tests/cross-spacing.test.ts` → PASS. `pnpm typecheck` → the compiler now names every other call site that still builds the old input (plan.ts, tests, view model). That list is Tasks A5/A7. **Commit.**

### Task A5: Governor + planner

**Files:**
- Modify: `src/outreach/governor.ts` :186-198 (the `otherPageLastDeliveredAt` block) and its input type
- Modify: `src/outreach/plan.ts` ~:396-408 (feeds `evaluatePair`) — replace the `otherPageLastDelivered` query with the same two reads as the gate (hoist `eligibleFleetSenderIds()` OUTSIDE the per-pair loop — one call per run, not per pair; `/` has a query budget and `ig:layout` enforces it)
- Test: `tests/governor.test.ts` spacing cases

- [ ] **Step 1:** Governor input: replace `otherPageLastDeliveredAt: Date | null` + `cooldownDays: number` with `crossSpacing: CrossSpacingVerdict`. The block becomes:

```ts
if (input.crossSpacing.held) {
  return {
    eligible: false,
    reason: SKIP_REASONS.TARGET_RECENTLY_CONTACTED,
    detail: crossSpacingDetail(input.crossSpacing) ?? undefined,
  }
}
```

- [ ] **Step 2:** Update `tests/governor.test.ts`: both directions — ring-complete refuses; single-other-page-3-days-ago is eligible; inter-page-gap (3h ago, gap 24) refuses. Reuse `crossSpacingVerdict` to build inputs so the fixtures cannot drift from the rule.
- [ ] **Step 3:** Run governor tests → PASS. **Commit.**

### Task A6: Reply halt → 7 days

**Files:**
- Modify: `src/outreach/replyHalt.ts:40`
- Test: `tests/replyHalt.test.ts` (update any test pinning 48)

- [ ] **Step 1:**

```ts
/**
 * SEVEN DAYS since 2026-08-19 — Tabish: the 7-day constraint applies when "a reply has
 * been detected (which would resume after 7 days automatically or manually by clicking
 * on the UI)". Was 48h (2026-08-18). "I have replied" stays as the early release.
 */
export const REPLY_RESUME_HOURS_DEFAULT = 168
```

- [ ] **Step 2:** Grep for other stale copy: `grep -rn 'two days\|48 hours\|48h' src/app src/outreach --include='*.ts*'` — fix every sentence that describes the window (the /rules page imports the value, so it self-corrects; prose strings do not).
- [ ] **Step 3:** Run reply tests → PASS. **Commit.**

### Task A7: Rewrite the spacing source-grep test

**Files:**
- Rewrite: `tests/cross-account-spacing.test.ts`

- [ ] **Step 1:** The old grep asserts `senderId: { not: ... }` exists — now FALSE by design. Rewrite it to pin the NEW invariants:

```ts
// 1. gate.ts, plan.ts and messages-page.ts each import crossSpacingVerdict (one rule, three callers).
// 2. No file under src/ builds an inline cross-page spacing query:
//    /senderId:\s*\{\s*not:/ must match ZERO files in src/outreach and src/app.
// 3. crossSpacing.ts itself never special-cases the self sender out of ring-complete
//    (grep: `every((id`) — deleting a sender from the "all" set is how the 7-day rest
//    silently stops firing.
```

Follow the existing file's read-the-source pattern. **A grep that matches nothing reports success** — assert each positive grep found > 0 occurrences (the `tag-evidence.test.ts` lesson).

- [ ] **Step 2:** Run → PASS. Full suite: `pnpm test` → all green, `pnpm typecheck` → clean. **Commit.**

---

# Workstream B — "Up next" shows the held queue (the invisible-33 fix)

### Task B1: View model returns held rows with resume times

**Files:**
- Modify: `src/app/view-model/messages-page.ts` :310-397 (the bulk-hold mirror and `upNext` assembly)

- [ ] **Step 1:** The bulk mirror currently reproduces the OLD rule inline (`some((sid) => sid !== draft.senderId)` at ~:342). Replace `isHeld` with the shared module: extend the `recentDeliveries` select with `sentAt` and the sender handle, build `lastDeliveryBySender` **per target**, fetch `eligibleFleetSenderIds()` once, and call `crossSpacingVerdict` per draft. Reply holds stay as-is (they are a different stop).
- [ ] **Step 2:** Add to the page payload:

```ts
export interface HeldRow {
  senderHandle: string
  targetHandle: string
  /** 'spacing-gap' | 'spacing-ring' | 'reply' */
  why: string
  /** verdict.resumesAt, or repliedAt + resumeHours for reply holds. */
  resumesAt: Date
}
// heldUpNext: first 8 held drafts by queuedAt, heldWaiting stays the total count
```

- [ ] **Step 3:** Modify `src/app/messages/waiting.tsx` (:22-80): under the sendable list, render the held rows — `@sender → @target · resting until 24 Aug, all 5 pages have written` / `next page's turn at 14:10` / `they replied — resumes 26 Aug or the moment you press "I have replied"`. Keep the existing one-line count as the summary above the list. **This is a server-resolved payload handed to a client component — do NOT import gate.ts or crossSpacing.ts into `waiting.tsx`** (the `'use client'` → better-sqlite3 HTTP-500 trap is documented in CLAUDE.md).
- [ ] **Step 4:** When `sendable === 0 && heldWaiting > 0`, the panel's headline states it as one sentence with the earliest resume time: *"Nothing is sendable until Aug 24, 12:37 — all 33 waiting drafts are resting (spacing or replies). Not a fault: autopilot is on and the dispatcher is checking every minute."* — "nothing happened" must explain itself at every level.
- [ ] **Step 5:** `pnpm ig:layout` (server up, `DS_QUERY_COUNT=1`, `DS_LAYOUT_TOKEN` set) → all green including `/`'s 160-query budget (the bulk approach adds ~1 query). **Commit.**

---

# Workstream C — Target quality: verify, flag, retire

### Task C1: Schema — verification facts on the target row

**Files:**
- Modify: `prisma/schema.prisma` (TargetAccount, model at :123)
- Regenerate: `prisma/schema.postgres.prisma` via `bash scripts/make-postgres-schema.sh` (NEVER hand-edit)
- Server SQL (hand-written — there is NO `_prisma_migrations` on the Linode; never `prisma migrate deploy`):

```sql
ALTER TABLE "TargetAccount" ADD COLUMN "isVerified" BOOLEAN;
ALTER TABLE "TargetAccount" ADD COLUMN "followerCount" INTEGER;
ALTER TABLE "TargetAccount" ADD COLUMN "campaignTalent" BOOLEAN NOT NULL DEFAULT false;
```

- [ ] **Step 1:** Add to the model:

```prisma
  /// From web_profile_info at last enrichment. NULL = never looked, never "false"/"0" —
  /// absence of data must not harden into a negative verdict.
  isVerified    Boolean?
  followerCount Int?
  /// TRUE only for a person DELIBERATELY admitted as a target because Instagram asserted
  /// them (tag/collab/mention) on a CAMPAIGN post AND they passed the verified/size bar
  /// (Tabish, 2026-08-19). checkRecipientIsNotAPerson exempts these and ONLY these.
  campaignTalent Boolean @default(false)
```

- [ ] **Step 2:** Local dev: `pnpm db:push` (SQLite). `tests/schema-parity.test.ts` will fail until the postgres schema is regenerated — run the script, test passes.
- [ ] **Step 3:** Apply the SQL on the server **before** deploying code that selects the columns (a deployed `select` against a missing column is a runtime error the suite cannot see). **Commit** (schema + regenerated postgres schema together).

### Task C2: `pnpm ig:audit-targets` — re-verify every live prospect, flag the faulty

**Files:**
- Create: `src/scripts/audit-targets.ts`
- Modify: `package.json` scripts — `"ig:audit-targets": "tsx src/scripts/audit-targets.ts"`
- Test: `tests/audit-targets.test.ts` for the pure classifier

- [ ] **Step 1: Pure suspicion rule + failing tests**

```ts
// in src/scripts/audit-targets.ts (exported for the test)
export type TargetAudit =
  | { flag: false }
  | { flag: true; why: 'person-role-category' | 'tiny-unverified' | 'no-category-thin' | 'gone' }

export function auditTarget(t: {
  brandCategory: string | null
  isVerified: boolean | null
  followerCount: number | null
  exists: boolean
  campaignTalent: boolean
}): TargetAudit {
  if (!t.exists) return { flag: true, why: 'gone' }
  if (t.campaignTalent) return { flag: false } // deliberately-admitted people are audited by the E bar, not this one
  if (isPersonRoleCategory(t.brandCategory)) return { flag: true, why: 'person-role-category' }
  if (t.isVerified === false && t.followerCount !== null && t.followerCount < 1_000)
    return { flag: true, why: 'tiny-unverified' }
  if (t.brandCategory === null && t.isVerified !== true && (t.followerCount ?? 0) < 5_000)
    return { flag: true, why: 'no-category-thin' }
  return { flag: false }
}
```

Tests: each flag direction, plus the survivors — a NULL `isVerified`/`followerCount` must NOT flag (never looked ≠ tiny), and a verified account with a person category still flags `person-role-category` (celebrities enter via workstream E's deliberate door, never by audit pass-through).

- [ ] **Step 2: The command.** Follow `src/scripts/brands.ts`'s conventions exactly (DRY RUN default, `--run`, `--limit N`, 6s lookup spacing, halt on 429, home-IP note in the banner). Flow: live PROSPECT targets → `enrichHandle(handle)` + `handleExists` → write `isVerified`/`followerCount` back (this write happens even in dry run? NO — dry run writes nothing, prints what it would) → print the flag table grouped by `why` with handle, displayName, category, followers, and the drafts/attempts each holds. `--retire h1,h2` retires through the EXISTING retire path (`optedOut` via the same function `ig:retire-target` uses — never delete; send history feeds spacing). Retiring a target with waiting drafts must discard them through `discardAttempt` (the one writer).
- [ ] **Step 3:** Run `pnpm ig:audit-targets` (dry) from the home IP over all ~90 live prospects (~9 min at 6s spacing). **READ the flag list before any `--retire`** — measure what the rule refuses, the `usableName` lesson. **Commit**, then run `--run` to persist verification facts.

### Task C3: Show verification on /targets

**Files:**
- Modify: `src/app/targets/` list row + its view model (`src/app/view-model/prospects-page.ts`)

- [ ] **Step 1:** Each prospect row gains a quiet suffix: `✔ verified · 1.2M followers`, or `unverified · 800 followers — review` when `auditTarget` flags it (import the pure rule into the view model, server-side). Flagged rows group under **"Review these — possibly not real companies"** with the existing retire control beside each.
- [ ] **Step 2:** `pnpm ig:layout` → green. **Commit.**

---

# Workstream D — Official-page discovery for untagged paid posts

### Task D1: Pure candidate generation + identity bar

**Files:**
- Create: `src/detection/officialHandle.ts`
- Test: `tests/official-handle.test.ts`

- [ ] **Step 1: Failing tests** — candidates for `"Royal Canin"` include `royalcanin`, `royalcanin.india`, `royalcanin_india`, `royalcaninindia`, `royalcanin.official`; the identity bar accepts `{isVerified: true, fullName: 'Royal Canin India'}`, accepts `{isVerified: null, followerCount: 250_000, fullName: 'Royal Canin', isBusiness: true}`, REJECTS `{isVerified: true, fullName: 'Ryan Canin'}` (verified but wrong name), REJECTS `{isVerified: false, followerCount: 90_000, fullName: 'Royal Canin'}` (big-ish, unverified, below floor). Include the measured trap as a fixture: `@philips` (exists, verified, name "Philips") for brand name "Philips India" must NOT be auto-accepted — token-set match must require the candidate to cover the brand-name tokens, so "Philips India" ⊄ "Philips".

- [ ] **Step 2: Implement**

```ts
// src/detection/officialHandle.ts
/**
 * From a brand NAME (caption prose or OCR frame text) to an OFFICIAL Instagram page —
 * the one path this project measured unsafe (wrong 4/10, and 3 of the 4 wrong handles
 * EXIST — @philips is the global HQ, @philipsindia ran the campaign). It becomes safe
 * only by demanding IDENTITY, not existence:
 *
 *   auto-accept  = verified badge AND name-match       (Instagram asserting identity)
 *                | ≥ officialMinFollowers AND exact name AND business account
 *   anything else → a human decides, or nobody does. NEVER a fuzzy accept.
 *
 * Tabish, 2026-08-19: "find verified channel or channel that is truly big and legitimate".
 */
export function candidateHandlesFor(brandName: string): string[] {
  const flat = brandName.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim()
  const joined = flat.replace(/ /g, '')
  const dotted = flat.replace(/ /g, '.')
  const scored = flat.replace(/ /g, '_')
  const out = new Set([joined, dotted, scored])
  for (const base of [joined, dotted]) {
    out.add(`${base}.india`); out.add(`${base}india`); out.add(`${base}.official`); out.add(`${base}official`)
  }
  return [...out].filter((h) => h.length >= 3 && h.length <= 30)
}

const tokens = (s: string) => new Set(s.toLowerCase().replace(/[^a-z0-9 ]/g, '').split(/\s+/).filter(Boolean))

/** Candidate profile covers every token of the brand name (subset, not overlap). */
export function nameMatches(brandName: string, profileFullName: string | null): boolean {
  if (!profileFullName) return false
  const want = tokens(brandName)
  const have = tokens(profileFullName)
  if (want.size === 0) return false
  return [...want].every((t) => have.has(t))
}

export function isOfficialMatch(input: {
  brandName: string
  fullName: string | null
  isVerified: boolean | null
  followerCount: number | null
  isBusiness: boolean | null
  officialMinFollowers: number
}): boolean {
  if (input.isVerified === true && nameMatches(input.brandName, input.fullName)) return true
  return (
    (input.followerCount ?? 0) >= input.officialMinFollowers &&
    input.isBusiness === true &&
    input.fullName !== null &&
    tokens(input.fullName).size === tokens(input.brandName).size &&
    nameMatches(input.brandName, input.fullName)
  )
}
```

- [ ] **Step 3:** Add Setting `officialMinFollowers` (default `100_000`) via the Task A2 pattern. Run tests → PASS. **Commit.**

### Task D2: `pnpm ig:find-official` — the home-IP command

**Files:**
- Create: `src/scripts/find-official.ts`
- Modify: `package.json` — `"ig:find-official": "tsx src/scripts/find-official.ts"`

- [ ] **Step 1:** Flow (DRY RUN default, `--run`, `--limit`, 6s spacing, 429 halts the run):
  1. Select in-window CAMPAIGN posts whose evidence names **nobody**: `brandCandidatesFor(post)` returns empty (no caption mention, no tag, no collab) — today these yield NO prospect by design.
  2. Brand names from two sources, in trust order: `DetectedCampaign.brands` (caption-derived display names), then capitalised multi-char tokens from stored `frameText` (OCR) — frame names are lower-trust; mark provenance on each.
  3. `candidateHandlesFor(name)` → for each candidate `enrichHandle()` (existing plumbing; also answers existence) →
     - `isOfficialMatch` → **auto-accept**: `createBrandTarget` (the ONE creator; asks routes.ts; `watchEnabled: false`), stamping `isVerified`/`followerCount`, audit row `target.created.official-match` recording name, handle, badge, followers.
     - near-miss (exists, plausibly right, fails the bar) → **print under "NEEDS A HUMAN"** with the evidence; `--accept <handle>` on a later invocation creates it deliberately (audited as the operator's act).
     - no candidate resolves → the post stays prospect-less, which stays correct.
  4. Cache every lookup in `BrandLookup` so re-runs never re-spend the endpoint (reuse the existing outcome vocabulary; UNKNOWN retries, everything else does not).
- [ ] **Step 2:** Run dry over the real corpus. **Read the acceptance list end to end before `--run`** — this is the workstream where the 4-in-10 measurement lives; the list being short and convincing is the release gate.
- [ ] **Step 3:** **Commit.**

---

# Workstream E — Verified celebrities tagged in paid campaigns

### Task E1: The admission bar + guard exemption

**Files:**
- Modify: `src/outreach/brandGuards.ts:145-160` (`checkRecipientIsNotAPerson`)
- Modify: `src/lib/settings.ts` — Setting `celebrityMinFollowers`, default `500_000`
- Test: `tests/person-category.test.ts` (extend, don't weaken)

- [ ] **Step 1:** Guard input gains `campaignTalent: boolean`; first line after the kind check:

```ts
if (input.campaignTalent) return { ok: true } // deliberately admitted — Tabish, 2026-08-19
```

The compiler names every call site (planner, prospects view model); thread the column through each.
- [ ] **Step 2:** Tests both directions: a `campaignTalent` row with category "Artist" passes; the identical row without the flag still refuses (the guard must keep catching ACCIDENTAL people — @ananyapanday-as-"Private Investigator" is the standing fixture and stays refused). **Commit.**

### Task E2: Create talent targets from campaign tags

**Files:**
- Modify: `src/detection/resolveBrand.ts` (the PERSON branch of `applyModelToUnresolved`/`classifyProfile` consumers — where a PERSON verdict currently ends the road)
- Modify: `src/outreach/brandTarget.ts:40` — `createBrandTarget` gains `opts?: { campaignTalent?: boolean; isVerified?: boolean | null; followerCount?: number | null }`
- Test: `tests/talent-admission.test.ts`

- [ ] **Step 1:** Pure admission rule beside the pipeline:

```ts
export function admitsAsTalent(e: { isVerified: boolean | null; followerCount: number | null }, minFollowers: number): boolean {
  if (e.isVerified === true) return true
  return (e.followerCount ?? 0) >= minFollowers // null never admits — absence is not size
}
```

- [ ] **Step 2:** In the resolution flow (both callers — `autoResolveBrands` and `ig:brands`; they share `resolveBrand`, so wire it ONCE where the PERSON outcome is handled): when the candidate came from a CAMPAIGN post's Instagram-asserted evidence (every `brandCandidatesFor` candidate does) and the verdict is PERSON and `admitsAsTalent(...)` → `createBrandTarget(handle, { campaignTalent: true, ... })` instead of dropping. A PERSON below the bar behaves exactly as today. Historic backfill: `pnpm ig:brands --talent-backfill` re-reads cached PERSON lookups whose handles appear in in-window CAMPAIGN evidence and applies the same bar (cached PERSON is never re-looked-up otherwise — the "a cache that answers first" gotcha).
- [ ] **Step 3:** Tests: verified person tagged in CAMPAIGN → target created with `campaignTalent: true` and routes exist; unverified 100k person → not created; verified person mentioned only in an ORGANIC post → not created (the source set is CAMPAIGN evidence only). Run → PASS. **Commit.**

---

# Workstream F — Autopilot health (verified today + keep it visible)

- [ ] **F1:** Nothing to fix in the engine — 2026-08-19 verification: agent alive under caffeinate, tunnel up, autopilot ON, dispatcher ticking 1/min, 68 sends in 6h, halt fully explained by spacing. The B1 all-held banner is the lasting fix: the next "why is nothing sending" answers itself on the landing page with a resume time.
- [ ] **F2:** After deploy, verify live: watch `dispatchState` flip from `all-held` to sends (the 33 released drafts should go out ~1/min, inter-page gap permitting), and run `pnpm ig:dispatch` once to see the head verdicts in the gate's own words.

---

# Deploy & ordering (the traps are documented; follow exactly)

1. **A + B ship together, to BOTH hosts in one session.** The governor runs on the Linode, the gate on the Mac — deploying one leaves the planner drafting what the gate refuses (or vice versa). Server: `bash scripts/deploy.sh` (never tar, never `build | tail`). Mac: `bash scripts/install-watch.sh install` then confirm the agent restarted (`ps` start time — a running process keeps the OLD rule in memory; that exact costume is in CLAUDE.md).
2. **C1's SQL runs on the server Postgres BEFORE any C/D/E code deploys**, and `pnpm db:push` locally. Then `bash scripts/prisma-client-for-env.sh` — never bare `prisma generate`.
3. C2 (`ig:audit-targets`), D2 (`ig:find-official`), E2 backfill run **from the home IP** — the Linode is 429'd on the profile endpoint.
4. Full gates before each deploy: `pnpm test`, `pnpm typecheck`, `pnpm build`, `pnpm ig:layout`.
5. **Update the pipeline diagram** (docs/PIPELINE.md rule — re-publish to the SAME artifact URL) — the spacing rule and the two new prospect sources change the flow. Update CLAUDE.md with the decisions table above and refresh memory files (`caps-removed-2026-08-18.md` notes the gap; spacing entries).
6. Expected immediately after step 1: the 33 held drafts become sendable (their cross-page contacts are >24h old); at the 1-minute pace with the reply sweep, expect them to drain over ~1-2 hours, then throughput is again bounded by prospect inflow — which is what C/D/E exist to widen.

# Self-review notes

- Spec coverage: pause/exhaustion → A + F2; "no limit except 7-day, all-pages-or-reply" → A1/A4/A5; reply 7d + UI release → A6 (release button already exists); held queue invisible → B; faulty targets → C; official pages for untagged paid posts (verified/big) → D; celebrities tagged in campaigns (verified, "sometimes might not be the case" → follower floor + human near-miss queue) → E; autopilot health → F.
- Type consistency: `CrossSpacingVerdict` is the one shape crossing A1→A4→A5→B1; `campaignTalent` crosses C1→E1→E2; `eligibleFleetSenderIds` crosses A3→A4→A5→B1.
- Known judgment calls awaiting Tabish (defaults chosen, one Setting row each to change): `crossPageGapHours=24`, `officialMinFollowers=100k`, `celebrityMinFollowers=500k`.
