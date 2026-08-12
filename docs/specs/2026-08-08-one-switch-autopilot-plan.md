# One-Switch Autopilot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Autopilot becomes ONE switch: ON means detect → auto-decide brands (no human queue) → auto-route across the able fleet → draft → send paced; OFF means a clean, audited stop that changes nothing else.

**Architecture:** Remove the two subordinate switches (`SenderAccount.autoSendEnabled`, `OutreachPair.enabled`) from every gate; replace the "It's a company / Not a company" human queue with a model resolver that decides the endpoint's blind spot and skips when unsure; make ability (session + not challenged + cohort + persona) a *derived* fact, never a choice; keep every account-protecting invariant (pacing, caps, breaker, reply halt, cohort ladder, send-proof guards) exactly as it is.

**Tech Stack:** Next.js App Router, Prisma 7 (Postgres on the server, SQLite for tests), deepseek-v4-flash via the existing constant-prompt pattern, vitest.

---

## Execution notes for the implementing agent (written for Opus 5, thinking disabled, high effort)

Every step below is mechanical: exact file, exact anchor, exact replacement, exact
command, exact expected output. **If an anchor string or line number does not match
what you find, STOP that task and report the mismatch — do not improvise a similar
edit.** Line numbers were verified on 2026-08-08; anchors (quoted code) are the source
of truth when the two disagree.

Environment facts you must not rediscover the hard way:
- `.env` `DATABASE_URL` points at the LIVE server Postgres through an SSH tunnel
  (`127.0.0.1:15432`). CLI scripts and the generated client hit production data.
- `pnpm test` regenerates the SQLite client first and is safe. After the suite, run
  `pnpm prisma generate` again before using any `ig:*` script, or it will run against
  the wrong provider.
- NEVER run `prisma migrate dev` (it once offered to reset this database). Migrations
  are hand-written SQL applied through the tunnel.
- NEVER run `pnpm build` while `pnpm start`/`pnpm dev` is running.
- The shell is zsh: `====` as an echo separator breaks it; quote such strings.
- Timestamps bound from JS `Date` into naive Postgres columns pick up the client's
  UTC+05:30 offset — bind timestamps as UTC STRINGS cast with `::timestamp` in any
  ad-hoc SQL (see CLAUDE.md, the timezone gotcha).
- Commit after each task exactly as its final step says; never push, never touch git
  config, end commit messages with the Co-Authored-By line from the harness rules.

---

## Decisions this plan records (Tabish, 2026-08-08)

1. *"The moment autopilot is turned on there must be no more switches."* Per-account
   Auto-send and per-route chips are REMOVED as controls. Enabling autopilot is enabling
   outreach to every messageable prospect, from every able fleet account.
2. *"The channels which are undecided must also be decided on their own."* The
   `UNRESOLVED` brand queue is decided by a model. The manual buttons are removed.
3. *"When the switch is turned off no sabotage or discrepancy should take place."*
   OFF = the dispatcher holds at its next decision point, at most the one in-flight
   message completes, drafts keep their Send buttons, and **nothing else changes state**.
   Both flips are audited (`autopilot.set`, already in place).
4. **What deliberately survives as non-switches** (they protect the accounts, not gate
   the flow): 10:00–21:00 IST, min gap + 3/hour fleet + one send per tick, per-target
   2/day, per-sender daily cap, new-brand 2/day, lifetime ceiling, circuit breaker,
   checkpoint → CHALLENGED (never retried), reply halt + 24 h auto-resume, opt-out
   forever, 7-day cooldown, unanswered-touch cap, cohort ladder, persona distinctness,
   composer read-back + thread-delta proof, `SEND_ENABLED`/`AUTOPILOT_ENABLED` env
   floors (deployment config — the server stays send-disabled forever; these are not
   user switches and no UI exposes them).
5. **Risk accepted and stated:** ON now means real cold DMs to newly discovered brands
   within hours, from revenue accounts, with no per-route human step. The recipient-side
   caps above are the only brake. A model mislabelling a person as a company would pitch
   a person; mitigations in Task 12 (endpoint verdict wins when it exists; the model only
   decides the endpoint's blind spot; below-threshold = skip, never message, never queue;
   the politician fixture is a required test).
6. **Physical limit no switch can cross:** an account with no hand-login session cannot
   send. Today that is @bollywoodsocietyy and @madaboutmarketingg. They join rotation the
   moment Connect is pressed once; until then the fleet is @bollywoodchronicle (and the
   dashboard says exactly that).
7. **@tabishmukaddam1 is not fleet.** With route switches gone, only an explicit
   membership flag keeps the burner out of automatic rotation to real prospects
   (Task 5). It remains usable for on-demand manual sends.

---

## File structure

| File | Change |
|---|---|
| `prisma/schema.prisma` | + `SenderAccount.fleetMember`; + `BrandLookup.decidedBy/modelConfidence/modelReason` |
| `prisma/migrations/<ts>_one_switch/migration.sql` | HAND-WRITTEN (never `migrate dev` against live data) |
| `src/outreach/gate.ts` | − `AUTO_SEND_OFF`, − `PAIR_DISABLED`; `OVERRIDABLE_BLOCKS` = `[TARGET_REPLIED]` |
| `src/outreach/governor.ts` | − `PAIR_DISABLED` skip |
| `src/outreach/deliver.ts` | − auto-send hold at :159-172 |
| `src/outreach/cohorts.ts` | `live` = session + ACTIVE (no armed bit) |
| `src/outreach/plan.ts` | fleet filter, pair auto-creation, dead-select cleanup |
| `src/outreach/brandTarget.ts` | NEW — the one creator of BRAND targets (3 callers today would have drifted) |
| `src/detection/decideBrand.ts` | NEW — model resolver for the endpoint's blind spot |
| `src/detection/resolveBrand.ts` | UNRESOLVED path calls the model; caption context threaded through |
| `src/detection/autoResolve.ts` | NEW — bounded auto-resolution after each detection pass |
| `src/worker/scheduler.ts` | detect cron also plans drafts when autopilot is on |
| `src/lib/modelCall.ts` | + `'resolve'` purpose |
| `src/app/actions.ts` | − `setAccountAutopilot`, − `setPairEnabled`, − `confirmBrand`, − `dismissBrandCandidate` |
| `src/app/brands.tsx` | buttons gone; "decided automatically" record instead |
| `src/app/accounts/group.tsx`, `view-model/accounts-page.ts` | Auto-send toggle/group gone; ability shown |
| `src/app/prospects/list.tsx`, `view-model/prospects-page.ts` | route chips gone |
| `src/app/messages/remedy.ts`, `src/app/rules/page.tsx` | total maps shrink (compiler-enforced) |
| `src/app/view-model.ts` | ready/needs-login derived from session; brands panel reshape |
| `src/scripts/burner.ts` + `package.json` | retired (its target was deleted 2026-08-08) |
| `src/scripts/control.ts` | drop `autopilot on|off <handle>` subcommand and the armed-blocker line |
| `tests/stopInventory.test.ts`, `tests/resolve-brand.test.ts`, `tests/decide-brand.test.ts` (new), `tests/model-call.test.ts`, `tests/cohorts.test.ts` | updated / new |
| `CLAUDE.md`, `docs/PIPELINE.md` + diagram artifact | the "four yeses" section rewritten; diagram re-published same session |

Verification gates used throughout: `pnpm test`, `pnpm typecheck`, `pnpm ig:layout`,
`tests/schema-parity.test.ts` (regen via `scripts/make-postgres-schema.sh`).

---

### Task 1: Schema — fleet membership and model-decision columns

**Files:**
- Modify: `prisma/schema.prisma` (SenderAccount ~line 42, BrandLookup ~line 553)
- Create: `prisma/migrations/20260808_one_switch/migration.sql`
- Regenerate: `prisma/schema.postgres.prisma` via `scripts/make-postgres-schema.sh`

- [ ] **Step 1: Add the columns**

In `model SenderAccount`, after `autoSendEnabled` (kept for now; reads removed in later tasks, column dropped only after a clean soak):

```prisma
  /// Is this account part of the automatic rotation? The burner (@tabishmukaddam1) is
  /// NOT: it exists for rehearsal and on-demand sends. With per-route switches gone
  /// (2026-08-08, one-switch decision), this flag is the only thing keeping a test
  /// account out of automatic outreach to real prospects. Identity, not a switch —
  /// no UI toggles it.
  fleetMember Boolean @default(true)
```

In `model BrandLookup`, after `reachable`:

```prisma
  /// Who settled `kind`: 'endpoint' (Instagram's category data), 'model' (the
  /// decideBrand resolver), 'human' (historic button decisions). Null on rows written
  /// before 2026-08-08 and on UNKNOWN rows (nothing settled).
  decidedBy       String?
  /// The model's confidence (0-100) and one-line reason, recorded so an auto-created
  /// prospect is auditable months later. Null unless decidedBy = 'model'.
  modelConfidence Int?
  modelReason     String?
```

- [ ] **Step 2: Write the migration by hand** (the repo rule: `migrate dev` offered to reset this database once already)

```sql
-- prisma/migrations/20260808_one_switch/migration.sql
ALTER TABLE "SenderAccount" ADD COLUMN "fleetMember" BOOLEAN NOT NULL DEFAULT true;
UPDATE "SenderAccount" SET "fleetMember" = false WHERE "handle" = 'tabishmukaddam1';
ALTER TABLE "BrandLookup" ADD COLUMN "decidedBy" TEXT;
ALTER TABLE "BrandLookup" ADD COLUMN "modelConfidence" INTEGER;
ALTER TABLE "BrandLookup" ADD COLUMN "modelReason" TEXT;
-- Historic human decisions stay recognisable:
UPDATE "BrandLookup" SET "decidedBy" = 'human' WHERE "kind" IN ('BRAND','PERSON') AND "handle" IN
  (SELECT "handle" FROM "BrandLookup" WHERE "kind" IN ('BRAND','PERSON'));
```

(The last statement marks pre-existing settled rows; endpoint-vs-human is not
distinguishable retroactively and `'human'` is the honest upper bound for the four
button-decided rows — adjust to `'endpoint'` for rows whose `category` is non-null.)

```sql
UPDATE "BrandLookup" SET "decidedBy" = 'endpoint' WHERE "kind" IN ('BRAND','PERSON') AND "category" IS NOT NULL;
```

- [ ] **Step 3: Regenerate both clients and the postgres schema**

Run: `bash scripts/make-postgres-schema.sh && pnpm prisma generate && pnpm test tests/schema-parity.test.ts`
Expected: parity test PASS.

- [ ] **Step 4: Apply to the server database** (through the tunnel, with a dry read-back)

Run the ALTERs via psql/pg against the tunnel URL, then verify:
`SELECT handle, "fleetMember" FROM "SenderAccount" ORDER BY handle;`
Expected: `tabishmukaddam1 | f`, the three pages `t`.

- [ ] **Step 5: Commit** — `git commit -m "schema: fleet membership + model brand decisions (one-switch)"`

---

### Task 2: gate.ts — the switch stops go away

**Files:**
- Modify: `src/outreach/gate.ts:136-152` (RESEND_BLOCKS), `:181-184` (OVERRIDABLE_BLOCKS), `:221-223` (AUTO_SEND_OFF check), `:238-240` (PAIR_DISABLED check), `:47`/`:318`/`:321`/`:445`/`:449` (input shapes/wiring)
- Modify: `src/app/messages/remedy.ts:33,37`, `src/app/rules/page.tsx:44-45` (total Records — the compiler names these)
- Test: `tests/stopInventory.test.ts:133-180`

- [ ] **Step 1: Update the exact-set test first** (it pins the whitelist)

```ts
// tests/stopInventory.test.ts — replace the OVERRIDABLE_BLOCKS assertion
it('lets a person cross exactly the timing stops, and nothing else', () => {
  expect([...OVERRIDABLE_BLOCKS].sort()).toEqual([RESEND_BLOCKS.TARGET_REPLIED].sort())
})
```

Remove from `GATE_CASES`: the `AUTO_SEND_OFF` row (`:136`) and `PAIR_DISABLED` row (`:138`). The totality check then *requires* the constants to be gone — run `pnpm test tests/stopInventory.test.ts`, expected FAIL (constants still exist).

- [ ] **Step 2: Remove the stops**

In `RESEND_BLOCKS` delete `AUTO_SEND_OFF` and `PAIR_DISABLED` (10 codes remain). In
`OVERRIDABLE_BLOCKS` leave only `RESEND_BLOCKS.TARGET_REPLIED`. Delete the two checks:

```ts
// DELETE (gate.ts:221-223)
if (input.unattended && !input.senderAutoSendEnabled) { ... }
// DELETE (gate.ts:238-240)
if (!input.pairEnabled && !allowed.has(RESEND_BLOCKS.PAIR_DISABLED)) { ... }
```

Remove `senderAutoSendEnabled` from `ResendInput` (:47), `pairEnabled` and
`pair.enabled`/`sender.autoSendEnabled` from `ResendAttempt` (:318, :321), and their
wiring in `recheckBeforeSend` (:445, :449). Leave a two-line comment where AUTO_SEND_OFF
stood: *"Per-account arming was removed 2026-08-08 (one-switch). Ability is derived:
session, status, cohort, persona — all checked below."*

- [ ] **Step 3: Let the compiler walk you through the total maps**

Run: `pnpm typecheck`
Expected errors at exactly: `src/app/messages/remedy.ts:33,37` and
`src/app/rules/page.tsx:44-45`. Delete those four entries.
Also `src/outreach/onDemand.ts:200-205` (the routeEnabled warning) — delete the warning
block and the `routeEnabled` field (:58, :340): with routes automatic there is nothing
to warn a human about.

- [ ] **Step 4: Run the gate tests both directions**

Run: `pnpm test tests/stopInventory.test.ts`
Expected: PASS — every remaining stop has a case, the whitelist is exactly
`[TARGET_REPLIED]`, remedies are total over the 10 remaining codes.

- [ ] **Step 5: Commit** — `git commit -m "gate: remove auto-send-off and pair-disabled — one switch (Tabish 2026-08-08)"`

---

### Task 3: governor.ts + plan.ts — the planner stops asking permission per route

**Files:**
- Modify: `src/outreach/governor.ts:42,113,141-143`
- Modify: `src/outreach/plan.ts:61-64,166,267`
- Test: `tests/stopInventory.test.ts:71-91`

- [ ] **Step 1: Update GOVERNOR_CASES** — remove the `PAIR_DISABLED` row (`:73`); totality check now demands the constant go. Run, expected FAIL.

- [ ] **Step 2: Remove from the governor**

Delete `PAIR_DISABLED: 'pair-disabled'` from `SKIP_REASONS` (:113), the check at
:141-143, and `enabled: boolean` from `GovernorInput.pair` (:42).

- [ ] **Step 3: Planner cleanup**

`plan.ts:61-64` — scope the query to the fleet and drop disabled bookkeeping:

```ts
const pairs = await prisma.outreachPair.findMany({
  where: { sender: { fleetMember: true } },
  include: { sender: true, target: true },
  orderBy: [{ target: { handle: 'asc' } }, { sender: { handle: 'asc' } }],
})
```

`plan.ts:267` — delete `enabled: pair.enabled,`. `plan.ts:166` — delete the dead
`autoSendEnabled` select (explorer-verified never read).

- [ ] **Step 4: Pair auto-creation** — add at the top of `runOutreach()` (plan.ts:56), before the pairs query:

```ts
/**
 * One switch: routes are not chosen, they exist. Every fleet sender is paired with
 * every messageable target; retirement is target.optedOut (checked independently by
 * the governor), never a missing row. Idempotent — the unique (senderId, targetId)
 * key makes createMany+skipDuplicates a no-op on reruns. Never self-pairs.
 */
const [fleet, messageable] = await Promise.all([
  prisma.senderAccount.findMany({ where: { fleetMember: true }, select: { id: true, handle: true } }),
  prisma.targetAccount.findMany({ where: { optedOut: false }, select: { id: true, handle: true } }),
])
const fleetHandles = new Set(fleet.map((s) => s.handle))
await prisma.outreachPair.createMany({
  data: fleet.flatMap((s) =>
    messageable
      .filter((t) => t.handle !== s.handle && !fleetHandles.has(t.handle))
      .map((t) => ({ senderId: s.id, targetId: t.id, cooldownDays: DEFAULT_COOLDOWN_DAYS, enabled: true })),
  ),
  skipDuplicates: true,
})
```

(`enabled: true` is written for tidiness; nothing reads it after Task 2. The
`!fleetHandles.has(t.handle)` clause keeps our own pages out even if a fleet page ever
reappears as a target. `DEFAULT_COOLDOWN_DAYS`: grep for its export —
`grep -rn "export const DEFAULT_COOLDOWN_DAYS" src` — and import from there; if plan.ts
already imports it, reuse. `skipDuplicates` relies on the existing
`@@unique([senderId, targetId])` on OutreachPair — verify it in schema.prisma before
assuming; it is the same key `actions.ts` updates through as `senderId_targetId`.)

- [ ] **Step 5: Run** `pnpm test tests/stopInventory.test.ts tests/governor* tests/plan*` — expected PASS. **Commit.**

---

### Task 4: deliver.ts + cohorts.ts — ability is derived

**Files:**
- Modify: `src/outreach/deliver.ts:159-172`
- Modify: `src/outreach/cohorts.ts:66,204,235,251`
- Test: `tests/cohorts.test.ts` (adjust `live` fixtures)

- [ ] **Step 1: deliver.ts** — the live re-read keeps the status check, drops the armed check:

```ts
const live = await prisma.senderAccount.findUnique({
  where: { id: sender.id },
  select: { status: true },       // was: { status: true, autoSendEnabled: true }
})
// DELETE the hold at :169-172 (`if (!live.autoSendEnabled) ...`)
```

- [ ] **Step 2: cohorts.ts** — a group is live when it can actually send, not when a bit says so:

```ts
// cohorts.ts:251 — was: m.autoSendEnabled && m.hasSession && m.status === 'ACTIVE'
live: members.filter((m) => m.hasSession && m.status === 'ACTIVE').length,
```

Remove `autoSendEnabled` from `CohortMember` (:66), the select (:204) and mapping
(:235).

**CORRECTED 2026-08-11, and this correction is the important part of the task.** The
original instruction here said to DELETE the `mayArmAccount` export, on the reasoning
that the ladder stays enforced by `COHORT_NOT_CLEARED` in `gate.ts`. **That was wrong
and would have silently removed the guard.** `mayArmAccount` is what FEEDS that check:
`gate.ts:4` imports it and `gate.ts:414` calls it as the unattended branch of
`senderCohortCleared`. The pure check reads `input.senderCohortCleared === false`
(deliberately `=== false`, so an omitted field means "cleared"), so deleting the
function would have left the field undefined, the check permitting, and the cohort
ladder no longer existing on the send path — with no failing test, because nothing
asserts the wiring. Absence of data hardening into a permission, from this plan's own
instruction.

**So: KEEP `mayArmAccount`.** It is the single delivery-time enforcement point for the
ladder. Add a docblock warning that it must not be removed as apparently-unused once
its `actions.ts` caller goes. Task 5 may delete `setAccountAutopilot` (its other
caller) freely — that does not orphan it.

Verify by grep rather than by trusting this document: `grep -rn "mayArmAccount" src tests`.

- [ ] **Step 3: Fix cohort test fixtures** (drop the field), run `pnpm test tests/cohorts*` — PASS. **Commit.**

---

### Task 5: actions.ts — four actions retire

**Files:**
- Modify: `src/app/actions.ts` — delete `setAccountAutopilot` (:661-…), `setPairEnabled` (:1082-1103), `confirmBrand` (:1211-1278), `dismissBrandCandidate` (:1287-1298); in `addSender` (:865) and the pair-creation sites (:911, :1030, :1258) write `enabled: true` with the comment `// vestigial — nothing reads pair.enabled since 2026-08-08`
- Test: `tests/action-authorisation.test.ts` (mechanism is regex-over-source; `setAutopilot` stays, count stays > 20)

- [ ] **Step 1: Delete the four actions.** Their `audit` verbs (`sender.autopilot.set`, `pair.enabled`, `brand.confirmed`, `brand.dismissed`) simply stop being produced — history keeps old rows.
- [ ] **Step 2:** `pnpm test tests/action-authorisation.test.ts` — expected PASS (25 actions, all guarded).
- [ ] **Step 3:** `pnpm typecheck` — expected errors at every UI import of the deleted actions: `src/app/accounts/group.tsx:120`, `src/app/prospects/list.tsx:177`, `src/app/brands.tsx:4`. Those are Tasks 6-7's worklist; fix them there, not here. **Commit only when typecheck is green at the end of Task 7.**

---

### Task 6: Senders page — show ability, not a toggle

**Files:**
- Modify: `src/app/accounts/group.tsx:118-127`, `src/app/view-model/accounts-page.ts:40,125,149,160,197`
- Modify: `src/app/view-model.ts:619,625,676,684`

- [ ] **Step 1:** In `accounts-page.ts`: drop `autoSendEnabled` from `AccountRow`; `state` becomes `usable && !shared ? 'ready' : 'setup'` (:125); replace the `:149` todo string with `'Sign in once — the switch does the rest.'` for session-less rows; delete the `notArmed` group (:197) — its rows fold into `setup`.
- [ ] **Step 2:** In `group.tsx`, find the button whose onClick is
`setAccountAutopilot(row.handle, !row.autoSendEnabled)` (anchor, ~:118-127) and whose
label renders `'Auto-send: on' / 'Auto-send: off'`. Replace that entire `<button>`
element (and the `setAccountAutopilot` import at the top of the file) with:

```tsx
<span className="muted">
  {row.state === 'ready'
    ? 'Sends automatically while Autopilot is on.'
    : 'Needs a one-time sign-in before it can send.'}
</span>
```

If `row.state` is not in scope at that spot, use the same expression the row's status
chip already uses on this page — do not invent a new field. If neither exists, STOP and
report.
- [ ] **Step 3:** In `view-model.ts`: `readyHandles` (:676) and `needLoginHandles` (:684) filter on session/status only.
- [ ] **Step 4:** `pnpm test tests/labels.test.ts` and eyeball `/senders` copy for the CEO-reader rule. **No commit yet.**

---

### Task 7: Targets page — routes are a fact, not chips

**Files:**
- Modify: `src/app/prospects/list.tsx:170-199`, `src/app/view-model/prospects-page.ts:49,83,128,133`
- Modify: `src/app/autopilot.tsx` copy (:63-70 area)

- [ ] **Step 1:** In `src/app/prospects/list.tsx`, find the route-chip block (anchor:
the `onClick={() => act(() => setPairEnabled(route.senderHandle, targetHandle, !route.enabled))}`
call at ~:177 and the `` className={`chip ${route.enabled ? 'on' : ''}`} `` render at
~:187-199). Delete the whole per-route `.map`, its container, and the `setPairEnabled`
import. In its place render one line per target:

```tsx
<span className="muted">
  {target.retired
    ? 'Retired — never contacted.'
    : `Messaged automatically by rotation while Autopilot is on (${target.sendersAble} account${target.sendersAble === 1 ? '' : 's'} able to send).`}
</span>
```

In `src/app/view-model/prospects-page.ts`: delete the `routes` array field (:49) and
its build (:83, :133) and `enabledPairs` (:128); add to the target row type
`retired: boolean` (from `t.optedOut`) and `sendersAble: number`, computed ONCE per page
(not per target) as the count of fleet senders that can send:

```ts
const senders = await prisma.senderAccount.findMany({
  where: { fleetMember: true, status: 'ACTIVE' },
  select: { handle: true, sessionInvalidAt: true },
})
const sendersAble = senders.filter((s) =>
  sessionUsable({ hasSessionOnDisk: profileStatus(s.handle).hasSession, sessionInvalidAt: s.sessionInvalidAt }),
).length
```

(`sessionUsable` from `@/outreach/sessionHealth`, `profileStatus` from
`@/outreach/browser/profile` — both are the same helpers `plan.ts:561-571` already
composes this way. This is a server-side view-model file; if this file is imported by
any `'use client'` module, STOP — that is the client-bundle trap in CLAUDE.md.)
- [ ] **Step 2:** `autopilot.tsx` — the switch description becomes the contract: ON = *"finds paid posts, decides brands, writes messages, and sends them — paced, 10:00–21:00 IST"*; OFF = *"nothing sends; drafts keep their Send buttons."*
- [ ] **Step 3:** Run `pnpm typecheck` (green now — closes Task 5's step 3), `pnpm test`, `pnpm build && pnpm ig:layout`. **Commit Tasks 5-7 together:** `git commit -m "ui: one switch — arming, route chips and brand buttons removed"`

---

### Task 8: Retire the burner script

**Files:**
- Delete: `src/scripts/burner.ts`; Modify: `package.json` (drop `"burner"`), `docs/RUNBOOK.md` mention

- [ ] **Step 1:** Its hardcoded target `@priyanshu123321123` was deleted from the database on 2026-08-08 (Tabish's instruction), so the command already exits at its not-seeded guard. Delete the script and the package.json entry; note in RUNBOOK that rehearsal now means: point the on-demand dialog at an account we own.
- [ ] **Step 2:** `pnpm test` — the suite has no burner test; grep to be sure: `grep -rn "burner" tests/ src/` → only prose. **Commit.**

---

### Task 9: `'resolve'` joins ModelPurpose

**Files:**
- Modify: `src/lib/modelCall.ts:56`, `prisma/schema.prisma:413` (comment), Test: `tests/model-call.test.ts`

- [ ] **Step 1:** Failing test first:

```ts
it('prices a resolve call like any flash call', () => {
  expect(costUsdForModel('deepseek-v4-flash', { inputTokens: 1000, cachedInputTokens: 0, outputTokens: 50 })).toBeGreaterThan(0)
})
// and the union accepts it:
const p: ModelPurpose = 'resolve'
```

- [ ] **Step 2:** `export type ModelPurpose = 'classify' | 'generate' | 'quality' | 'resolve'`; update the schema comment. Run tests — PASS. **Commit.**

---

### Task 10: `decideBrand.ts` — the model decides the endpoint's blind spot

**Files:**
- Create: `src/detection/decideBrand.ts`
- Test: `tests/decide-brand.test.ts` (new)

- [ ] **Step 1: Write the failing tests** — the politician is the required fixture (three docblocks in this repo record that his readable fields are byte-identical to a brand's):

```ts
import { describe, expect, it } from 'vitest'
import { interpretDecision, RESOLVE_CONFIDENCE_FLOOR } from '@/detection/decideBrand'

describe('interpretDecision (pure half)', () => {
  it('a confident company becomes BRAND', () => {
    const v = interpretDecision({ handle: 'adidas', decision: { kind: 'company', confidence: 98, reason: 'global sportswear brand' } })
    expect(v).toMatchObject({ kind: 'BRAND', handle: 'adidas' })
  })
  it('a confident person/politician becomes PERSON — never a prospect', () => {
    const v = interpretDecision({ handle: 'adityathackeray', decision: { kind: 'person', confidence: 97, reason: 'politician' } })
    expect(v).toMatchObject({ kind: 'PERSON' })
  })
  it('an agency is filed PERSON-side (not a prospect), like the existing category rule', () => {
    const v = interpretDecision({ handle: 'mind_shifters', decision: { kind: 'not-a-prospect', confidence: 95, reason: 'marketing agency' } })
    expect(v).toMatchObject({ kind: 'PERSON' })
  })
  it('below the floor NOTHING is decided — unsure stays UNRESOLVED and is never messaged', () => {
    const v = interpretDecision({ handle: 'somelocalshop', decision: { kind: 'company', confidence: 70, reason: 'maybe a shop' } })
    expect(v).toMatchObject({ kind: 'UNRESOLVED' })
  })
  it('unsure stays UNRESOLVED whatever the confidence claims', () => {
    const v = interpretDecision({ handle: 'x', decision: { kind: 'unsure', confidence: 99, reason: '?' } })
    expect(v).toMatchObject({ kind: 'UNRESOLVED' })
  })
  it('a failed call decides nothing (null in → null out)', () => {
    expect(interpretDecision({ handle: 'x', decision: null })).toBeNull()
  })
})
```

Run: `pnpm test tests/decide-brand.test.ts` — FAIL (module missing).

- [ ] **Step 2: Implement** — same shape as `semantic.ts` (constant system prompt, facts in the user message, `null` on every failure, `thinking` disabled, `response_format: json_object`, `temperature: 0`, `recordModelCall({ purpose: 'resolve', ... })` fire-and-forget):

```ts
/**
 * Decides what Instagram's category endpoint cannot: is this @mention a COMPANY that
 * buys media placements, or a person / agency / publisher?
 *
 * WHY A MODEL AND NOT A RULE. Measured 2026-08-03 and recorded in three docblocks:
 * @tilara.india (a brand) and @adityathackeray (a politician) are byte-identical on
 * every field we can read anonymously. What separates them is WORLD KNOWLEDGE
 * (@adidas is a sportswear company; Aditya Thackeray is a politician) plus the caption
 * context — exactly the judgement the caption classifier already makes one modality
 * over. A rule over the readable fields would message the politician.
 *
 * THE SAFE DIRECTION IS SILENCE. 'unsure' and anything under the floor stays
 * UNRESOLVED: never messaged, never queued for a human (one-switch decision,
 * 2026-08-08), retried only when new evidence arrives. A wrong 'company' sends a
 * sales pitch to a person; a wrong skip costs one prospect. Asymmetric, so the floor
 * is high and 'unsure' is honoured regardless of the confidence number.
 */
import { recordModelCall } from '@/lib/modelCall'
import type { BrandVerdict } from './resolveBrand'

const MODEL = 'deepseek-v4-flash'
const API_URL = 'https://api.deepseek.com/chat/completions'
export const RESOLVE_CONFIDENCE_FLOOR = 90

/** Module-level constant — NOTHING interpolated, ever. The cache discount is 50x. */
const SYSTEM_PROMPT = `You classify Instagram accounts that were @-mentioned in a paid post's caption.
The decisive question: is this account a COMPANY whose team BUYS advertising placement
on entertainment publisher pages? A consumer brand, retailer, streaming service, app,
film studio's corporate account, or venue chain is a company. A person is not — actor,
director, musician, politician, athlete, influencer, however famous or verified.
A marketing / PR / talent agency, or another publisher or media page, is "not-a-prospect":
it is the other side of the table, never a buyer of placements.
Use what you reliably know about famous handles. If the handle is obscure and the facts
given do not settle it, answer "unsure" — unsure is safe; a wrong "company" answer sends
a sales pitch to a person.
Reply with JSON only: {"kind":"company"|"person"|"not-a-prospect"|"unsure","confidence":0-100,"reason":"one short sentence"}`

export interface BrandDecision {
  kind: 'company' | 'person' | 'not-a-prospect' | 'unsure'
  confidence: number
  reason: string
}

export interface DecideInput {
  handle: string
  displayName?: string | null
  followers?: number | null
  isVerified?: boolean | null
  reachable?: boolean | null
  enrichment?: string | null
  /** The caption sentence(s) around the @mention — context the endpoint never had. */
  captionContext?: string | null
}

/** PURE half: a decision (or a failed call) → a BrandVerdict, or null when nothing was decided. */
export function interpretDecision(input: { handle: string; decision: BrandDecision | null }): BrandVerdict | null {
  const { handle, decision } = input
  if (!decision) return null // a failed call is never a verdict — resolveBrand keeps its own answer
  if (decision.kind === 'unsure' || decision.confidence < RESOLVE_CONFIDENCE_FLOOR) {
    return { kind: 'UNRESOLVED', handle, reason: `model not confident (${decision.kind} ${decision.confidence}%)` }
  }
  if (decision.kind === 'company') {
    return { kind: 'BRAND', handle, displayName: handle, category: null, followers: null }
  }
  // person and not-a-prospect both mean: never messaged. Same filing the category
  // rule uses for agencies (see NOT_A_PROSPECT_CATEGORIES in resolveBrand.ts).
  return { kind: 'PERSON', handle, category: null }
}

export async function decideBrand(input: DecideInput): Promise<BrandDecision | null> {
  if (!process.env.DEEPSEEK_API_KEY) return null
  const facts = [
    `handle: @${input.handle}`,
    input.displayName ? `display name: ${input.displayName}` : null,
    input.followers != null ? `followers: ${input.followers}` : null,
    input.isVerified != null ? `verified: ${input.isVerified}` : null,
    input.reachable === false ? `note: profile could not be read anonymously` : null,
    input.enrichment ? `profile facts: ${input.enrichment}` : null,
    input.captionContext ? `mentioned in this paid-post caption: ${input.captionContext.slice(0, 500)}` : null,
  ].filter(Boolean).join('\n')

  const started = Date.now()
  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}` },
      body: JSON.stringify({
        model: MODEL,
        thinking: { type: 'disabled' },
        response_format: { type: 'json_object' },
        max_tokens: 120,
        temperature: 0,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: facts },
        ],
      }),
      signal: AbortSignal.timeout(30_000),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const json = (await res.json()) as {
      choices: { message: { content: string } }[]
      usage?: { prompt_cache_hit_tokens?: number; prompt_cache_miss_tokens?: number; completion_tokens?: number }
    }
    const parsed = JSON.parse(json.choices[0]?.message?.content ?? '') as BrandDecision
    if (!['company', 'person', 'not-a-prospect', 'unsure'].includes(parsed.kind)) throw new Error('bad kind')
    void recordModelCall({
      purpose: 'resolve', model: MODEL, subject: `@${input.handle}`, ms: Date.now() - started, ok: true,
      cachedInputTokens: json.usage?.prompt_cache_hit_tokens ?? 0,
      inputTokens: json.usage?.prompt_cache_miss_tokens ?? 0,
      outputTokens: json.usage?.completion_tokens ?? 0,
    })
    return { ...parsed, confidence: Math.max(0, Math.min(100, Math.round(parsed.confidence))) }
  } catch (e) {
    void recordModelCall({
      purpose: 'resolve', model: MODEL, subject: `@${input.handle}`, ms: Date.now() - started,
      ok: false, error: e instanceof Error ? e.message : String(e),
      cachedInputTokens: 0, inputTokens: 0, outputTokens: 0,
    })
    return null // never a fabricated verdict
  }
}
```

- [ ] **Step 3:** `pnpm test tests/decide-brand.test.ts` — PASS. **Commit.**

---

### Task 11: Wire the model into `resolveBrand` and record who decided

**Files:**
- Modify: `src/detection/resolveBrand.ts:316` (signature gains `context?: { caption?: string }`), `:406-414` (cache write), the UNRESOLVED-producing paths (`classifyProfile` fallthrough consumer and the schema-bug branch of `interpretLookupFailure`'s caller), `resolveBrandsInCaption:420` (passes the caption through)
- Test: `tests/resolve-brand.test.ts`

- [ ] **Step 1: Failing test** — these exercise the pure seam (`interpretDecision` is
already covered in Task 10); here we test the INTEGRATION rule set with `decideBrand`
mocked. Add to `tests/resolve-brand.test.ts`:

```ts
import { vi, describe, it, expect, beforeEach } from 'vitest'

vi.mock('@/detection/decideBrand', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/detection/decideBrand')>()
  return { ...real, decideBrand: vi.fn() }
})
import { decideBrand } from '@/detection/decideBrand'
import { applyModelToUnresolved } from '@/detection/resolveBrand' // new pure export, Step 2

describe('the model decides only the endpoint blind spot', () => {
  beforeEach(() => vi.mocked(decideBrand).mockReset())

  it('an endpoint UNRESOLVED + confident company → BRAND, marked decidedBy model', async () => {
    vi.mocked(decideBrand).mockResolvedValue({ kind: 'company', confidence: 97, reason: 'sportswear brand' })
    const out = await applyModelToUnresolved(
      { kind: 'UNRESOLVED', handle: 'adidas', reason: 'no category and not a business account' },
      { caption: 'seen with @adidas at the launch' },
    )
    expect(out.verdict).toMatchObject({ kind: 'BRAND', handle: 'adidas' })
    expect(out.decidedBy).toBe('model')
  })

  it('a model failure changes NOTHING — absence never hardens into a verdict', async () => {
    vi.mocked(decideBrand).mockResolvedValue(null)
    const out = await applyModelToUnresolved(
      { kind: 'UNRESOLVED', handle: 'somelocalshop', reason: 'no category and not a business account' },
      {},
    )
    expect(out.verdict).toMatchObject({ kind: 'UNRESOLVED' })
    expect(out.decidedBy).toBeNull()
  })

  it('an endpoint BRAND is returned untouched — the endpoint wins when it answered', async () => {
    const v = { kind: 'BRAND' as const, handle: 'royalcanin.india', displayName: 'Royal Canin', category: 'Pet Store', followers: 1 }
    const out = await applyModelToUnresolved(v, {})
    expect(out.verdict).toBe(v)
    expect(vi.mocked(decideBrand)).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Implement.** All in `src/detection/resolveBrand.ts`.

Add imports at the top:

```ts
import { decideBrand, interpretDecision, type BrandDecision } from './decideBrand'
import { enrichHandle, describeEnrichment, type HandleEnrichment } from './enrichHandle'
```

Add the new EXPORTED seam (the test target) near `classifyProfile`:

```ts
/**
 * The model decides ONLY the endpoint's blind spot. Any verdict the endpoint actually
 * produced (BRAND, PERSON, MISSING, UNKNOWN) passes through untouched — including
 * UNKNOWN, because "we never got to look" is retried by the endpoint, not guessed at.
 */
export async function applyModelToUnresolved(
  verdict: BrandVerdict,
  context: { caption?: string | null },
): Promise<{ verdict: BrandVerdict; decidedBy: 'model' | null; decision: BrandDecision | null; enrichment: HandleEnrichment | null }> {
  if (verdict.kind !== 'UNRESOLVED') return { verdict, decidedBy: null, decision: null, enrichment: null }
  const enr = await enrichHandle(verdict.handle)
  const decision = await decideBrand({
    handle: verdict.handle,
    displayName: enr.fullName, followers: enr.followers, isVerified: enr.isVerified,
    reachable: enr.reachable, enrichment: describeEnrichment(enr),
    captionContext: context.caption ?? null,
  })
  const decided = interpretDecision({ handle: verdict.handle, decision })
  if (!decided || decided.kind === 'UNRESOLVED') {
    // Not confident, or the call failed: the endpoint's UNRESOLVED stands. Facts are
    // still worth keeping (the enrichment write below happens either way).
    return { verdict, decidedBy: null, decision, enrichment: enr }
  }
  return { verdict: decided, decidedBy: 'model', decision, enrichment: enr }
}
```

In `resolveBrand` (:316), change the signature to
`export async function resolveBrand(handle: string, context: { caption?: string | null } = {}): Promise<BrandVerdict>`
and immediately before the cache write (:406), insert:

```ts
const applied = await applyModelToUnresolved(verdict, context)
verdict = applied.verdict
```

Replace the cache write (:406-414) with:

```ts
const category = verdict.kind === 'BRAND' || verdict.kind === 'PERSON' ? verdict.category : null
const displayName = verdict.kind === 'BRAND' ? verdict.displayName : null
const followers = verdict.kind === 'BRAND' ? verdict.followers : null
const decidedBy = applied.decidedBy ?? (verdict.kind === 'BRAND' || verdict.kind === 'PERSON' ? 'endpoint' : null)
const fields = {
  kind: verdict.kind, category, displayName, followers,
  decidedBy,
  modelConfidence: applied.decidedBy ? applied.decision!.confidence : null,
  modelReason: applied.decidedBy ? applied.decision!.reason : null,
  ...(applied.enrichment
    ? { enrichment: describeEnrichment(applied.enrichment), reachable: applied.enrichment.reachable }
    : {}),
}
await prisma.brandLookup.upsert({
  where: { handle: h },
  update: { ...fields, checkedAt: new Date() },
  create: { handle: h, ...fields },
})
```

In `resolveBrandsInCaption` (:420), pass the caption through:
`const verdict = await resolveBrand(handle, { caption })` (the caption is the function's
own parameter; if the local name differs, use the actual parameter name).

The union guard at :169-172 is untouched — no new kind was added.

- [ ] **Step 3:** `pnpm test tests/resolve-brand.test.ts` — PASS. **Commit.**

---

### Task 12: One creator of BRAND targets, and the auto-resolve pass

**Files:**
- Create: `src/outreach/brandTarget.ts` (extract from `scripts/brands.ts:104-156` — `confirmBrand` was the second copy and died in Task 5; this repo has hit one-flow-two-callers four times)
- Create: `src/detection/autoResolve.ts`
- Modify: `src/detection/pipeline.ts` (call after classification), `src/scripts/brands.ts` (use the shared creator; keep dry-run default)
- Test: `tests/auto-resolve.test.ts` (new)

- [ ] **Step 1: `brandTarget.ts`** — move (do not copy) the create block from
`src/scripts/brands.ts:104-156`, generalised to two callers. Complete file:

```ts
/**
 * The ONE place a discovered brand becomes a TargetAccount. Two callers: the ig:brands
 * CLI and the automatic post-detection resolver. This repo has four recorded cases of
 * one flow drifting between two copies (gate.ts, readThread.ts, the Connect buttons,
 * judge.ts); this file exists so brand creation is not the fifth.
 */
import { prisma } from '@/lib/db'
import type { BrandVerdict } from '@/detection/resolveBrand'

export async function createBrandTarget(
  verdict: Extract<BrandVerdict, { kind: 'BRAND' }>,
  campaign: { id: string } | null,
  auditAction: 'brand.discovered' | 'brand.auto-decided',
  actor: string,
): Promise<'created' | 'exists' | 'is-our-sender'> {
  const handle = verdict.handle
  const existing = await prisma.targetAccount.findUnique({ where: { handle } })
  if (existing) return 'exists'
  const sender = await prisma.senderAccount.findUnique({ where: { handle } })
  if (sender) return 'is-our-sender'

  const target = await prisma.targetAccount.create({
    data: {
      handle,
      displayName: verdict.displayName ?? handle,
      /**
       * A PERSON's first name. We do not know who runs a company's Instagram, so this
       * stays null and buildGreeting produces "Hi <Name> team," — setting it to the
       * company name once addressed a corporation as an individual.
       */
      contactFirstName: null,
      kind: 'BRAND',
      detectorKey: 'passthrough',
      watchEnabled: false,
      optedOut: false,
      discoveredFromCampaignId: campaign?.id ?? null,
      brandCategory: verdict.category,
    },
  })

  // Pairs for the FLEET only (the burner is excluded by fleetMember=false). The
  // `enabled` column is vestigial since 2026-08-08 — nothing reads it.
  const fleet = await prisma.senderAccount.findMany({ where: { fleetMember: true }, select: { id: true } })
  await prisma.outreachPair.createMany({
    data: fleet.map((s) => ({ senderId: s.id, targetId: target.id, cooldownDays: 7, enabled: true })),
    skipDuplicates: true,
  })

  await prisma.auditLog.create({
    data: {
      actor,
      action: auditAction,
      entity: `TargetAccount:${handle}`,
      detail: `kind=BRAND category=${verdict.category ?? 'none'} campaign=${campaign?.id ?? 'none'}`,
    },
  })
  return 'created'
}
```

Then in `src/scripts/brands.ts` replace lines 104-156 with:

```ts
const outcome = await createBrandTarget(v, { id: c.id }, 'brand.discovered', 'ig:brands')
if (outcome === 'created') created++
```

(keep the surrounding counters; add the import `import { createBrandTarget } from '@/outreach/brandTarget'`).
NOTE: check the exact field list at brands.ts:109-134 against the create above before
deleting — if brands.ts sets a field this file does not, STOP and report rather than
dropping it.

- [ ] **Step 2: `autoResolve.ts`** — complete file:

```ts
/**
 * After a detection pass: resolve the @mentions of recent CAMPAIGN captions that
 * nothing has settled yet, so a brand found in a paid post becomes a prospect with
 * no human step (one-switch decision, 2026-08-08).
 *
 * Bounded per pass — the endpoint is scarce and 6s spacing lives inside resolveBrand.
 * A real throttle halts the whole pass (continuing after 429 is what earns IP blocks);
 * one broken handle does NOT (per-item failure must not halt the run).
 *
 * Settled means: a BrandLookup row exists whose kind is not UNKNOWN, and — when the
 * kind is UNRESOLVED — the model has already declined it (decidedBy = 'model' would
 * have flipped it; decidedBy null + modelReason null means the model never ran).
 * An UNRESOLVED the model declined stays declined; re-asking the same question about
 * the same evidence buys nothing.
 */
import { prisma } from '@/lib/db'
import { log } from '@/lib/log'
import { detectionCutoff } from '@/lib/cutoff'
import { mentionsIn, resolveBrand } from './resolveBrand'
import { createBrandTarget } from '@/outreach/brandTarget'

export const MAX_LOOKUPS_PER_PASS = 10

export async function autoResolveBrands(
  opts: { maxLookups?: number } = {},
): Promise<{ looked: number; decided: number; skippedUnsure: number }> {
  const maxLookups = opts.maxLookups ?? MAX_LOOKUPS_PER_PASS
  const posts = await prisma.detectedCampaign.findMany({
    where: { verdict: 'CAMPAIGN', postedAt: { gte: detectionCutoff() } },
    orderBy: { postedAt: 'desc' },
    select: { id: true, caption: true },
  })

  const out = { looked: 0, decided: 0, skippedUnsure: 0 }
  const seen = new Set<string>()
  for (const post of posts) {
    if (out.looked >= maxLookups) break
    for (const mention of mentionsIn(post.caption ?? '')) {
      if (out.looked >= maxLookups) break
      const handle = mention.slice(1).toLowerCase()
      if (seen.has(handle)) continue
      seen.add(handle)

      const cached = await prisma.brandLookup.findUnique({ where: { handle } })
      const settled =
        cached != null &&
        cached.kind !== 'UNKNOWN' &&
        (cached.kind !== 'UNRESOLVED' || cached.modelReason !== null)
      if (settled) continue
      const alreadyTarget = await prisma.targetAccount.findUnique({ where: { handle } })
      if (alreadyTarget) continue

      out.looked++
      const verdict = await resolveBrand(handle, { caption: post.caption })
      if (verdict.kind === 'BRAND') {
        const created = await createBrandTarget(verdict, { id: post.id }, 'brand.auto-decided', 'auto-resolve')
        if (created === 'created') out.decided++
      } else if (verdict.kind === 'UNRESOLVED') {
        out.skippedUnsure++
      } else if (verdict.kind === 'UNKNOWN') {
        // resolveBrand's internal halt flag has stopped the run on a real throttle;
        // everything after this point would come back UNKNOWN too. Stop the pass.
        log.warn('brand auto-resolve stopped early — lookup endpoint unavailable', { handle })
        return out
      }
    }
  }
  return out
}
```

- [ ] **Step 3: Call it from the pipeline** — in `pipeline.ts` at the end of `runDetection` (after classification, before returning), guarded exactly like every network nicety:

```ts
const resolved = await autoResolveBrands().catch((e) => {
  log.warn('brand auto-resolve failed — next pass retries', { error: String(e) })
  return { looked: 0, decided: 0, skippedUnsure: 0 }
})
```

and surface `resolved` in the pass detail so /paid-posts' brands panel can say what was decided and why.

- [ ] **Step 4: Tests** — with `resolveBrand` mocked: creates target+pairs for BRAND; skips settled rows; respects `maxLookups`; a halt stops the pass without marking anything. Run — PASS. **Commit.**

---

### Task 13: Brands panel — a record, not a queue

**Files:**
- Modify: `src/app/brands.tsx` (delete `UndecidedBrand`, the buttons at :140-146, the imports), `src/app/view-model.ts:1205-1262,285-301`

- [ ] **Step 1:** In `src/app/view-model.ts`, replace the `undecided` build (:1246-1262)
and the `UnresolvedBrandCard` type (:285-293) with:

```ts
export interface AutoDecidedBrandCard {
  handle: string
  /** 'company' — added as a prospect; 'left-alone' — the model was not confident. */
  outcome: 'company' | 'left-alone'
  reason: string | null
  confidence: number | null
}
```

and in `buildBrandsPanel`:

```ts
const recentDecisions = await prisma.brandLookup.findMany({
  where: { decidedBy: 'model' },
  orderBy: { updatedAt: 'desc' },
  take: 30,
})
const autoDecided: AutoDecidedBrandCard[] = recentDecisions.map((r) => ({
  handle: r.handle,
  outcome: r.kind === 'BRAND' ? 'company' : 'left-alone',
  reason: r.modelReason,
  confidence: r.modelConfidence,
}))
```

`BrandsPanel.undecided` becomes `autoDecided: AutoDecidedBrandCard[]`; keep the
confirmed-brands list untouched.

- [ ] **Step 2:** In `src/app/brands.tsx`: delete `UndecidedBrand` (:111-…), the two
buttons (:140-146), the `confirmBrand`/`dismissBrandCandidate` import (:4), and the
whole "Instagram could not tell us what these are" section (:63-75). In its place:

```tsx
{brands.autoDecided.length > 0 && (
  <section>
    <h3>Decided automatically</h3>
    <p className="undecided-why">
      When Instagram cannot say what an account is, the classifier decides from what it
      knows about the handle and the paid post it appeared in. When it is not confident,
      the account is left alone — never messaged, never queued for you.
    </p>
    <ul className="plain-list">
      {brands.autoDecided.map((d) => (
        <li key={d.handle}>
          <strong>@{d.handle}</strong>{' '}
          {d.outcome === 'company' ? 'added as a prospect' : 'left alone (not confident it is a company)'}
          {d.reason ? <span className="muted"> — {d.reason}</span> : null}
        </li>
      ))}
    </ul>
  </section>
)}
```

(Note the `{' '}` after `</strong>` — JSX drops the bare space between an expression
and the next line's text; that exact bug reached this dashboard once already.)
- [ ] **Step 3:** `pnpm build && pnpm ig:layout` — PASS. **Commit.**

---

### Task 14: Drafting keeps up with the switch — plan on the detect cadence

**Files:**
- Modify: `src/worker/scheduler.ts:317-325` (the 15-minute detect cron)
- Test: `tests/cadence.test.ts`

- [ ] **Step 1:** Add to `scheduler.ts` imports:
`import { runOutreach } from '@/outreach/plan'` and
`import { getSettings } from '@/lib/settings'` (check the existing import list first —
`getSettings` may already be there). Then after `runDetection()` in the detect cron
callback (:321):

```ts
const d = await runDetection()
// One switch: when autopilot is on, a fresh paid post becomes a draft on the next
// 15-minute pass, not at the next of four daily slots. Drafting is safe (the planner
// never sends — dispatch is its own paced tick) and idempotent (pending-attempt-exists).
const settings = await getSettings()
if (settings.autopilotEnabled) {
  await runOutreach().catch((e) => log.warn('outreach planning after detect failed', { error: String(e) }))
}
```

- [ ] **Step 2:** Extend `tests/cadence.test.ts`: planning runs on the detect clock only when the switch is on; a planning failure does not fail the detection pass. Run — PASS. **Commit.**

---

### Task 15: Docs, diagram, live verification

**Files:**
- Modify: `CLAUDE.md` ("four independent yeses" → the one-switch contract; brand queue section; burner row in Commands), `docs/PIPELINE.md`
- Republish: the pipeline diagram artifact (standing instruction — pass its existing URL so Tabish's bookmark survives)

- [ ] **Step 1:** Rewrite CLAUDE.md's autopilot section: ONE switch + the invariant list from this plan's header; record decisions 1-3 as Tabish's, dated 2026-08-08. Update the Commands table (burner removed, `pnpm agent autopilot` removed).
- [ ] **Step 2:** Update and republish the pipeline diagram in the same session as the code lands.
- [ ] **Step 3: Full gate:** `pnpm test` (all), `pnpm typecheck`, `pnpm build`, `pnpm ig:layout`, `pnpm ig:audit`.
- [ ] **Step 4: Deploy is a BUILD + RESTART + VERIFY-THE-RESTART** (a moved directory is not a moved process): server pulls, `prisma generate --config prisma.postgres.config.ts`, migration SQL applied, dashboard + detect cron restarted, `schedulerHeartbeat` observed advancing with the new pid; Mac device agent restarted (`bash scripts/install-watch.sh install`).
- [ ] **Step 5: Supervised first hour, both directions.** Switch ON: watch one detect pass plan drafts, one dispatch tick deliver ONE message from @bollywoodchronicle inside pacing, `/messages` names every hold. Switch OFF mid-queue: the next tick holds with `autopilot-off`, drafts keep Send buttons, `pnpm ig:audit` clean — that pair of observations is the "no sabotage" guarantee, verified rather than promised.

---

## Self-review notes

- **Spec coverage:** one switch (Tasks 2-7, 14), auto-decided brands incl. @adidas-class unreadables (Tasks 9-13), clean OFF (existing dispatcher holds + Task 15 step 5 verifies), tracking (audit rows throughout, dispatchState untouched), burner exclusion (Tasks 1, 3), sessions surfaced not switched (Task 6).
- **Deliberately NOT done:** dropping the `autoSendEnabled`/`enabled` columns (a later migration once the code has soaked — column drops are the irreversible half); auto-signing-in accounts (impossible by design — device identity comes from a hand login); touching `SEND_ENABLED`/server floors.
- **Known residual risks, restated:** model-decided prospects get first-touch DMs with no human read; the persona fingerprint warning (one phone number under every page) becomes MORE urgent as volume rises — raise before scaling; recipient-side caps are the binding brake and stay.
