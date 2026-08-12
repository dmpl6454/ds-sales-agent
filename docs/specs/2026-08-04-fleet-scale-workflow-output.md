{
  "summary": "Design the category + sender-rotation + generated-message + multi-page-dashboard system for the DS Sales Agent",
  "agentCount": 13,
  "logs": [],
  "result": {
    "plan": "# SPEC — Categories, Rotation, Fleet, Generated Messages, Dashboard
**File:** `docs/specs/2026-08-04-scale-plan.md`
**Status:** proposed. Nothing below ships without the DECISIONS and OPEN QUESTIONS sections being read.
**Verified against:** live `prisma/dev.db` 2026-08-04 (`journal_mode=delete`, `synchronous=2`, `sqlite_stat1` absent, `OutreachPair` has no `targetId` index, `OutreachAttempt.variantId TEXT NOT NULL ON DELETE RESTRICT`, all senders share persona `Kapil Jain / +91 60000 189766 / kapil@digitalsukoon.com`, `ENFORCEMENT_PHRASES` contains `'try again later'`, `runSlot.ts:109` ANDs `alive` with `ageMs < SLOT_LOCK_STALE_MS`, `burner.ts` brakes by sweeping `OutreachPair.enabled`).

---

## 0. THE SHAPE OF THE PLAN IN ONE PAGE

| # | phase | delivers | safe at 4 accounts? | abandonable? |
|---|---|---|---|---|
| **0** | Ship today | 10 live defects, each one-file, no schema | yes | yes — nothing depends on it, but 3 of them are already-reachable double-send bugs |
| **1** | Foundations | WAL, indexes, `OutreachAttempt.targetId/senderId`, `ModelCall`, detection observability, `view-model` split | yes | yes |
| **2** | Per-recipient envelope + atomicity | the guards rotation needs, as DB invariants. **Must precede Phase 3.** | yes (tightens only) | no — Phase 3 is unsafe without it |
| **3** | Categories + derived ring + assignment policy | decision 1, with per-recipient fan-out capped at 1 by default | yes (routing off by default) | yes |
| **4** | Dashboard: nav shell, `/accounts`, `/accounts/login`, `/messages` | decision 6 first half + the 66-login queue | yes | yes |
| **5** | Paced dispatcher | delivery leaves the slot; fleet day/hour reservation; circuit breaker | yes | yes, but Phase 9 is unsafe without it |
| **6** | Reply detection at scale | the hardest guard stops degrading with target count | yes | no once Phase 3 ships |
| **7** | Prospects: import, `/prospects`, `/settings`, `watchEnabled` | decision 5 + decision 6 second half | yes | yes |
| **8** | Generated messages + quality gate | decision 4 | yes | yes |
| **9** | Fleet onboarding | decision 2, as a cohort ladder | n/a — this is the phase that changes it | yes |

**Phases 0-2 change nothing about who receives a message.** Phase 2 only ever refuses more than today. The first behaviour change visible to a recipient is Phase 3, and only after a human turns a category on.

---

## PHASE 0 — SHIP TODAY

Ten fixes. No migration except one additive column. Every one is a defect that exists at 4 accounts; three of them can already send a duplicate DM to a real person.

### Modify

| file | change | why |
|---|---|---|
`prisma/seed.ts` + one-off `UPDATE SenderAccount SET personaPhone=…` | **fix the phone number.** `+91 60000 189766` is 11 digits after `+91`; Indian mobiles are 10 | every message the fleet has ever sent carries an unreachable number, identical across all accounts |
`src/lib/db.ts` (`createClient`) | `PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=15000;` then `ANALYZE` on first connect; add `pnpm db:analyze` and run it weekly | measured: a write during an open read txn blocks **5,216 ms then throws `SQLITE_BUSY`** under `delete`; **0 ms, no error** under WAL. Reader ops 209 → 2,401. `sqlite_stat1` is absent, so every `pair: { targetId }` filter currently plans as `SCAN OutreachPair` |
`src/outreach/plan.ts` (`applyOutcome`, :585-619) | wrap in try/catch; on throw, log ALARM and leave a resolvable record. Move the `messageVariant.update` (`plan.ts:601-604`) **out** of the SENT transaction | a `SQLITE_BUSY` after `sender.send()` returned SENT is caught at `plan.ts:334`, filed as \"outreach failed\", and leaves the attempt `QUEUED` — a delivered DM with no record and a Send button beside it |
`src/outreach/deliver.ts:140-143`, `src/app/actions.ts:337-340` | same: variant bump outside the SENT transaction | prerequisite for Phase 8's nullable `variantId`. With `variantId: null`, `update({where:{id:null}})` throws, the whole transaction rolls back, the attempt stays `READY`, and the next slot **re-sends a delivered message** |
`src/outreach/browser/session.ts:174-182` | delete `'try again later'`; scope `looksLikeEnforcement` to dialog/alert role text rather than `body.textContent()` | verified present. Read from the whole page, twice per send; a false positive marks a revenue account CHALLENGED and halts every pair using it |
`src/outreach/deliver.ts` (:83), `src/outreach/plan.ts` (:219, :549) | `findUnique({where:{id:senderId},select:{status:true}})` immediately before each dispatch, **plus** an in-run `challengedThisRun: Set<string>` | both read a sender snapshot taken before the loop and both write `CHALLENGED` inside it. Unreachable at 4 senders; **rotation makes it reachable by design** because rotation spreads one sender across many targets. This is retrying into a checkpoint |
`src/outreach/matching.ts` (`distinctiveSlice`) | the fallback must exclude the persona intro line and the hook line, and require `> 40` chars | reproduced: with the live 48-char `introLine`, a body whose longest line is ≤40 chars yields **`\"I'm Kapil Jain, Co-founder of Bollywood Society.\"`** as the needle — byte-identical in every message that sender sends. Both send guards become tautologies and `messageMatchesOurs` returns `true` across two *different* bodies |
`src/app/actions.ts:399-401` (`editAttemptBody`) | require the needle to be a substring of the body middle, `> 40` chars, and not inside the greeting/intro/close/persona/hook | today it only checks non-null, so the above is reachable through the dashboard edit box |
`src/outreach/deliver.ts` + `src/outreach/plan.ts` | one slot-scoped `lastSentAt` shared by both stages | `deliverWaiting` counts in `out.sent`, `runOutreach` in a fresh `sentThisRun = 0`, so the first planning send follows the last delivery send with **zero** spacing, possibly from the same account |
`src/worker/runSlot.ts` (:44, :109-130) | refresh the lock row's `at` after every send and every channel; `SLOT_LOCK_STALE_MS` then means \"stopped making progress\" | past 30 min the `alive` term stops mattering and `:123` takes the lock from a process `process.kill(pid,0)` just confirmed alive. Crossed at ~11-12 sends/slot; `@viralbhayani` median is 11 paid posts/day |
`src/outreach/onDemand.ts:351-354` | add `targetKind` to the variant `where` | the discriminator `plan.ts:471` applies is missing, so on-demand can hand a media-buying body to a publisher. Masked today only because the picker offers CHANNEL targets |
`src/outreach/onDemand.ts:306, :376` | `newMaterialFloor(now)` instead of `hoursAgo(settings.hookMaxAgeHours)` | **live drift in no design doc.** `cutoff.ts` states the filter \"applies in exactly two places\"; on-demand implements the same rule with the other floor. With `HOOK_MAX_AGE_HOURS=720` on-demand offers pre-cutoff campaigns the planner refuses |
`src/lib/settings.ts:58-63` (`num`) | `num(key, fallback, min, max)` with clamping + ALARM log when clamped | `env.MAX_PER_TARGET_PER_DAY` is clamped `intish(1,1,10)`; the `Setting` override is not clamped at all. A row of `1000` is accepted silently |
`src/lib/time.ts` | startup assertion `istDateKey(new Date('2026-08-04T18:31:00Z')) === '2026-08-05'` | full-ICU dependency. On a small-icu build the key becomes nonsense, every reservation `create` succeeds, and the per-recipient day cap silently stops existing |

### Migration `20260805090000_attempt_attempts`
```sql
ALTER TABLE \"OutreachAttempt\" ADD COLUMN \"attempts\"    INTEGER NOT NULL DEFAULT 0;
ALTER TABLE \"OutreachAttempt\" ADD COLUMN \"failureCode\" TEXT;
```
`deliver.ts:182` increments `attempts`; at `attempts >= 2` the attempt goes `SKIPPED` with `failureCode`. `failureCode` is a closed union in `constants.ts` — critically `'not-in-thread'` (composer cleared, message never appeared) which is a **shadow-restriction** signal and is today filed as an ordinary retryable failure, returned to `READY`, and retried at every slot forever.

### Tests (both directions each)
- `tests/matching.test.ts`: a **multi-line** body whose every line is ≤40 chars → `distinctiveSlice` returns `null` (not the intro line); a body with two >40-char paragraphs → returns one of them. Then `messageMatchesOurs(threadContainingTouch1, touch2Body) === false`. *(The existing \"falls back gracefully\" test uses a single-line body, which is why this gap was invisible.)*
- `tests/actions.test.ts` (new): `editAttemptBody` rejects a four-short-paragraph body with the live persona; accepts one with two long paragraphs.
- `tests/session.test.ts` (new, **there is no such file today**): a committed \"Action Blocked\" fixture → `looksLikeEnforcement` true; the committed 1 MB clean logged-in page text → false; a thread containing the literal words \"try again later\" → **false**.
- `tests/deliver.test.ts`: a sender challenged on attempt 1 → attempt 2 for that sender is held with `sender-not-active`; sender healthy → dispatched.
- `tests/on-demand.test.ts`: BRAND target selects only BRAND variants and vice versa; a 20-Jul campaign is not offered as new material or as a hook when `HOOK_MAX_AGE_HOURS=720`, a 3-Aug one is.
- `tests/settings.test.ts`: stored `'1000'` clamps to the max with an ALARM; `'2'` passes silently.

### How you know it works
`pnpm test` (338 → ~360). `sqlite3 prisma/dev.db \"pragma journal_mode\"` → `wal`. `sqlite3 prisma/dev.db \"select name from sqlite_master where name like 'sqlite_stat%'\"` → non-empty. Run one real slot with the dashboard open and confirm no `SQLITE_BUSY` in the log. `pnpm ig:audit` clean.

### Does NOT deliver
Anything about categories, rotation, generation, the dashboard, or more senders.

---

## PHASE 1 — FOUNDATIONS

No behaviour change. Everything later depends on this and retrofitting is a live-table backfill.

### Migration `20260805100000_foundations`
```sql
ALTER TABLE \"OutreachAttempt\" ADD COLUMN \"targetId\" TEXT;
ALTER TABLE \"OutreachAttempt\" ADD COLUMN \"senderId\" TEXT;
UPDATE \"OutreachAttempt\" SET
  \"targetId\" = (SELECT p.\"targetId\" FROM \"OutreachPair\" p WHERE p.\"id\" = \"OutreachAttempt\".\"pairId\"),
  \"senderId\" = (SELECT p.\"senderId\" FROM \"OutreachPair\" p WHERE p.\"id\" = \"OutreachAttempt\".\"pairId\");

CREATE INDEX \"ix_att_target_status_sent\"  ON \"OutreachAttempt\"(\"targetId\",\"status\",\"sentAt\");
CREATE INDEX \"ix_att_sender_status_sent\"  ON \"OutreachAttempt\"(\"senderId\",\"status\",\"sentAt\");
CREATE INDEX \"ix_att_target_queued\"       ON \"OutreachAttempt\"(\"targetId\",\"queuedAt\");
CREATE INDEX \"ix_att_status_queued\"       ON \"OutreachAttempt\"(\"status\",\"queuedAt\");
CREATE INDEX \"ix_att_replied\"             ON \"OutreachAttempt\"(\"repliedAt\",\"replyHandledAt\");
CREATE INDEX \"ix_pair_target\"             ON \"OutreachPair\"(\"targetId\");
CREATE INDEX \"ix_dc_target_detected\"      ON \"DetectedCampaign\"(\"targetId\",\"detectedAt\",\"verdict\");

CREATE TABLE \"ModelCall\" (
  \"id\" TEXT PRIMARY KEY NOT NULL,
  \"kind\" TEXT NOT NULL,                    -- 'classify' | 'compose' | 'judge'
  \"model\" TEXT NOT NULL,
  \"refType\" TEXT, \"refId\" TEXT,
  \"promptTokens\" INTEGER NOT NULL DEFAULT 0,
  \"cachedTokens\" INTEGER NOT NULL DEFAULT 0,
  \"completionTokens\" INTEGER NOT NULL DEFAULT 0,
  \"costMicros\" INTEGER NOT NULL DEFAULT 0, -- INTEGER micro-USD, never REAL
  \"latencyMs\" INTEGER,
  \"ok\" BOOLEAN NOT NULL DEFAULT true,
  \"at\" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX \"ix_modelcall_kind_at\" ON \"ModelCall\"(\"kind\",\"at\");

CREATE TABLE \"ChannelRun\" (
  \"id\" TEXT PRIMARY KEY NOT NULL,
  \"runId\" TEXT NOT NULL, \"targetId\" TEXT NOT NULL,
  \"status\" TEXT NOT NULL,                  -- 'OK' | 'PARTIAL' | 'FAILED'
  \"postsSeen\" INTEGER NOT NULL DEFAULT 0,
  \"newPosts\" INTEGER NOT NULL DEFAULT 0,
  \"stage1Dropped\" INTEGER NOT NULL DEFAULT 0,
  \"modelCalls\" INTEGER NOT NULL DEFAULT 0,
  \"moreAvailable\" BOOLEAN NOT NULL DEFAULT false,
  \"error\" TEXT,
  \"startedAt\" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX \"ix_channelrun_target_started\" ON \"ChannelRun\"(\"targetId\",\"startedAt\");
```
`targetId`/`senderId` left nullable so `ADD COLUMN` rewrites nothing; a pair's `targetId` is immutable so the copy cannot go stale.

### Create
- `src/lib/modelCall.ts` — `recordModelCall({kind, model, refType, refId, usage, latencyMs, ok})`. **One implementation, two callers**: `semantic.ts` calls it now, `compose.ts` in Phase 8. Cache-hit and latency alarms live here: ALARM when `cachedTokens === 0` on 5 consecutive calls of a kind (baseline is *exactly* 640 on all 47 recorded classifier calls), and when mean `completionTokens` over a run exceeds 2× the expected answer size (30 classify / 300 compose — detects `thinking` being re-enabled, measured 9.3×).
- `src/app/view/format.ts`, `view/counts.ts`, `view/health.ts`, `view/session.ts` — extracted from `view-model.ts` with no behaviour change. `session.ts` exposes `loginState(handles[]) → Map` with **three** states (`never-connected` / `session-expired` / `connected`) plus `unreadable`, calling `profileStatus` **once per handle**.

### Modify
- `src/lib/env.ts` — `DEEPSEEK_API_KEY` moves here (read raw from `process.env` at `semantic.ts:116,137` today, validated nowhere while 15 other vars are). Add `MAX_MODEL_CALLS_PER_SLOT` (`intish(400, 0, 5000)`).
- `src/lib/constants.ts` — add `PENDING_STATUSES = ['QUEUED','READY','SENDING']`. Replace all **eight** hand-spelled copies: `plan.ts:187`, `onDemand.ts:297`, `view-model.ts:341`, `actions.ts:145`, `actions.ts:876`, `burner.ts:64`, `send.ts:52`, `queued.ts:15`. Also `audit.ts` must use `DELIVERED_STATUSES` rather than spelling `['SENT','REPLIED']`.
- `src/detection/detectors/semantic.ts` — `vocabulary` stops being a module-level global (`:207-210`); `classify(post, vocab)` takes it as a parameter. **Do this before anyone parallelises channels to fit the slot clock**, or channel A's frequency map scores channel B's posts.
- `src/detection/pipeline.ts` — build vocabulary from a **rolling 90-day window**, not the whole corpus (`:104-108` currently loads every stored caption for the channel: 11,880 rows / 3.5 MB per channel at six months, ×57 channels = ~200 MB of string allocation per slot). Count and write `stage1Dropped` per channel. Alarm on `moreAvailable` (returned by `feed.ts:260` and currently **dropped** at `pipeline.ts:71`). Enforce `MAX_MODEL_CALLS_PER_SLOT`.
- `src/detection/detectors/novelty.ts` — `RARE_AT_OR_BELOW = 2` becomes \"rare within the vocabulary window\". It is currently an absolute count against an unbounded corpus, so it gets *stricter* every month, in the direction that saves money and loses recall — and **14 of 34 known CAMPAIGNs survive stage 1 only because ≥2 of their hashtags are still rare.** A repeat advertiser is by definition the best prospect and is the first thing this drops.
- `src/app/view-model.ts` — delete `include: { pairs: { include: { sender: true } } }` at `:308-312` (**never read**, 64 ms → 1 ms at scale); replace the per-channel 5-query loop (`:485-525`, measured 573-691 ms at 60 channels) with two `groupBy`s (~18 ms); replace the per-brand loop (`:613-635`) with one `groupBy`; delete `postsLogged` (unrendered, and the only all-time full-table scan) and `sentThisWeek` (unrendered); replace the O(n²) `otherPersonasBySender` (`plan.ts:113-115`) with one `groupBy` over the five persona columns; `take:` on `unreadReplies`, `awaitingRaw`, `deliver.ts:57`, `replyCheck.ts:88`, `plan.ts:52`.
- `src/worker/runSlot.ts` — stop writing one `PlanOutcome` per pair into `ScrapeRun.detail` (measured 1.65 MB/run at scale, 6.6 MB/day, read on every dashboard render); write `skippedByReason` counts. Add a hard size cap in `src/lib/json.ts` `writeRecord` with a `\"truncated\": true` marker.
- `src/app/page.tsx` — render `detection.degradedRuns` (computed at `view-model.ts:391`, **rendered nowhere**), **split by cause**: measured, 9 of the last 14 finished runs are `PARTIAL`, 8 from channel fetches and 1 from unreadable threads, and the number conflates them. Two problems, two fixes, never one sentence.
- All 24 `revalidatePath('/')` calls scoped to the routes they affect.

### Tests
- `tests/foundations.test.ts`: `OutreachAttempt.targetId` equals `pair.targetId` for every row (this is also a new `pnpm ig:audit` check that must read 0); every index in the migration is present in `sqlite_master`.
- `tests/novelty.test.ts`: a tag used 3× **inside** the window is common; the same tag used 3× but all older than the window is still rare (the drift fix, positive and negative).
- `tests/detectors.test.ts`: `classify` scored with channel A's vocabulary and with channel B's returns different novelty for the same post — proving the parameter is actually consulted.
- `tests/modelCall.test.ts`: a usage payload with `cachedTokens: 640` records no alarm; five consecutive `0`s record one, and the sixth does not re-alarm.
- `tests/constants.test.ts`: `PENDING_STATUSES`, `DELIVERED_STATUSES` and `IN_FLIGHT_STATUSES` partition `ATTEMPT_STATUSES` with every status classified exactly once (adding a status without deciding its set membership fails the suite).

### How you know it works
`buildCeoView` timing before/after on the scratch scale DB (`/private/tmp/.../scratchpad/scale.db`, 65 senders / 264 targets / 17,158 pairs): **780 ms → target < 60 ms**. `select count(*) from ModelCall where kind='classify'` grows after one slot. `select targetId, sum(stage1Dropped), sum(modelCalls) from ChannelRun group by 1` gives the real stage-1 rate — CLAUDE.md's \"54%\" was measured on the backlog corpus; the live figure is 11.7% of judged posts and 74-77% pass rate on fresh posts. **Fix that number in CLAUDE.md in this phase.**

### Does NOT deliver
Any new page, any new guard, any change to which pair is chosen.

---

## PHASE 2 — PER-RECIPIENT ENVELOPE + ATOMICITY

**This is the phase without which rotation is a spam machine that reports itself healthy on every existing check.** Every rule below is per-*recipient*; today every equivalent rule is per-*pair*, and a pair sends roughly once under any ring.

Measured evidence that the failure is already live, not theoretical: three `READY` drafts to `@priyanshu123321123` from three different senders, all `queuedAt = 2026-07-31T12:29:02`, all `touchNumber = 1`, all `campaignId` NULL.

### Migration `20260805110000_recipient_envelope`
```sql
ALTER TABLE \"TargetAccount\" ADD COLUMN \"cooldownHours\"          INTEGER NOT NULL DEFAULT 96;
ALTER TABLE \"TargetAccount\" ADD COLUMN \"maxUnansweredTouches\"   INTEGER NOT NULL DEFAULT 3;
ALTER TABLE \"TargetAccount\" ADD COLUMN \"maxDistinctSenders\"     INTEGER NOT NULL DEFAULT 1;
ALTER TABLE \"TargetAccount\" ADD COLUMN \"maxPerDay\"              INTEGER;   -- null = global Setting
ALTER TABLE \"OutreachAttempt\" ADD COLUMN \"origin\" TEXT NOT NULL DEFAULT 'planner';  -- 'planner'|'ondemand'

-- I1: at most one UNDELIVERED message per recipient, fleet-wide, from any sender.
CREATE UNIQUE INDEX \"uq_att_target_pending\"
  ON \"OutreachAttempt\"(\"targetId\")
  WHERE \"status\" IN ('QUEUED','READY','SENDING');

-- I2: one paid post -> at most one message to that recipient, ever.
CREATE UNIQUE INDEX \"uq_att_campaign_target_inflight\"
  ON \"OutreachAttempt\"(\"campaignId\",\"targetId\")
  WHERE \"campaignId\" IS NOT NULL
    AND \"status\" IN ('QUEUED','READY','SENDING','SENT','REPLIED');

-- I3: the per-recipient day cap as a reservation, not a count.
CREATE TABLE \"RecipientDaySlot\" (
  \"targetId\" TEXT NOT NULL, \"istDay\" TEXT NOT NULL, \"seq\" INTEGER NOT NULL,
  \"senderId\" TEXT NOT NULL, \"attemptId\" TEXT NOT NULL,
  \"claimedAt\" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (\"targetId\",\"istDay\",\"seq\")
);
CREATE UNIQUE INDEX \"uq_recipientdayslot_attempt\" ON \"RecipientDaySlot\"(\"attemptId\");
```
`cooldownHours` default **96**, not 24: `maxPerTargetPerDay` bounds a day, not an interval, and 2/day sustained is 14 messages/week into one inbox from up to 14 accounts — the same pattern decision 3's own rationale names, slower.

`origin` is recorded but **is deliberately NOT in I1's predicate.** On-demand's documented \"a draft is already waiting\" *warning* survives as an explicit **supersede**: `prepareOnDemandSend` moves the existing planner draft to `SKIPPED` with `error: 'superseded by an operator draft'` before creating its own. Exempting `origin='ondemand'` from the index instead — as the rotation design proposed — would let the planner stack a second draft on top of an operator's, which is exactly what the per-target pending rule exists to prevent.

### Create
- `src/outreach/claims.ts` — `claimRecipientDay(targetId, senderId, attemptId, cap)`: `create` on the compound PK, walking `seq` 1..cap, `false` at cap+1. `releaseRecipientDay(attemptId)` called from a **`finally`** around the browser call, never per outcome branch — there are five non-SENT terminations (`deliver.ts:164`, `deliver.ts:182`, `plan.ts:637-640`, sendNow-challenged, sendNow-failed) and missing one silently costs a recipient a day. `isUniqueViolation(e)` matches on `e.code === 'P2002'` only; **measured** on this stack that a partial unique index surfaces as `P2002` with `originalCode: 'SQLITE_CONSTRAINT_UNIQUE'`, and that a `SKIPPED` row inserts freely under the predicate. Never branch on `meta.target`.
- `src/lib/schemaGuard.ts` — reads `sqlite_master` at startup and **refuses to run the planner or the dispatcher** if `uq_att_target_pending`, `uq_att_campaign_target_inflight` or (Phase 3) `uq_tcm_target` is absent, naming which. **Prisma does not model partial indexes and `prisma migrate dev` wants to reset this database**, so one schema regeneration silently removes the entire atomicity argument while every existing check still passes.

### Modify — `src/outreach/governor.ts`
Split, preserving every existing reason string, so the ring can reuse the real rules instead of a second copy:
```ts
evaluateTarget(input): TargetDecision       // once per target
// LIFETIME_CAP, TARGET_OPTED_OUT, TARGET_REPLIED, TARGET_PENDING_ATTEMPT,
// TARGET_DAILY_CAP, TARGET_COOLDOWN_ACTIVE*, TARGET_UNANSWERED_LIMIT*,
// SENDER_FAN_OUT_LIMIT*, NO_NEW_MATERIAL
evaluatePairMember(input): MemberEligibility // once per candidate sender
// SENDER_NOT_ACTIVE, NO_SESSION, AUTO_SEND_OFF(unattended), SELF_SEND,
// ROUTE_SUPPRESSED, PAIR_COOLDOWN_ACTIVE, PAIR_UNANSWERED_LIMIT, SENDER_DAILY_CAP
//                                                              (* = new)
```
Re-scoped inputs, and the rename is load-bearing so nobody reads the wrong one:
- `targetTouchesSoFar` (per target, `DELIVERED_STATUSES`) drives `NO_NEW_MATERIAL` **and** `touchNumber`.
- `pairTouchesSoFar` drives the per-pair unanswered cap **only**. Do **not** lift `maxUnansweredTouches` to the target and delete the per-pair one: its justification is Instagram's one-pending-request-per-non-follower rule, which is genuinely per (sender, recipient). Both exist, at different scopes.
- `usedCampaignIds` scoped `where: { targetId }` via one new function `usedCampaignIdsForTarget(targetId)` — there are **four** copies of that clause today (`plan.ts:123`, `plan.ts:427`, `onDemand.ts:310`, `onDemand.ts:365`) and the first two already carry a comment saying they drifted twice. Put `take: 500` on it: measured, Prisma on SQLite throws at **999** bind parameters.
- `SENDER_FAN_OUT_LIMIT`: distinct `senderId` that have ever delivered to, or hold in-flight to, this target. If the count is at `TargetAccount.maxDistinctSenders` and this sender is not among them → refuse. **This one column is what converts \"rotation\" between sticky assignment (cap 1) and fan-out (cap 2-3).** See DECISION D3.
- `hasPendingAttempt` counted per target (now also a DB invariant).

### Modify — elsewhere
- `src/outreach/brandGuards.ts` — `checkNewBrandTouchCap` → `checkNewProspectCap`; drop the `kind === 'BRAND'` gate (`plan.ts:262`), keep `isFirstTouch`. Its own docblock already argues the case verbatim for channels. **This is the only thing bounding a 200-row CSV import**: for a first touch `targetTouchesSoFar = 0`, so `NO_NEW_MATERIAL` never evaluates (`governor.ts:204` requires `> 0`), the hook is optional, and every imported row is eligible on day one.
- `src/outreach/gate.ts` — `evaluateResend` gains `targetCooldownActive`, `targetUnansweredLimit`, `senderFanOutLimit`, `bodySource`, `qualityGateAt`, `replyCheckStaleDays`. **Every per-recipient bound is a BLOCK and is not in `OVERRIDABLE_BLOCKS`**, for the reason already written at `gate.ts:98-100`. `target-replied` stays overridable (Tabish chose it) but gains a budget — see below.
- `src/outreach/deliver.ts` / `src/app/actions.ts` (`sendNow`) — order: `recheckBeforeSend` → `updateMany({where:{id,status:'READY'}})` → **`claimRecipientDay`** → browser → `finally { releaseRecipientDay }`. This is the only mechanism covering \"an operator clicks Send while autopilot delivers to the same recipient\": `sendNow` takes no slot lock (`acquireSlotLock` is called only from `runSlot.ts:148`).
- Override budget: `Setting` keys `overrideBudgetPerWeek` (3) and `overrideBudgetPerRecipient` (1, ever), enforced **before** `OVERRIDABLE_BLOCKS` is applied, with a typed reason required, and refusing with `override-budget-spent` **naming the count** — never with the underlying block, or the operator reads \"they replied\" and retries. Justification, measured: **3 of the 7 messages ever delivered carry `sentBy = override(target-replied)`**, at touch 2, 3 and **4** against `maxUnansweredTouches = 3`, to a recipient whose 31-July reply still has `replyHandledAt` NULL. The checkbox is not a brake.
- `.env` — `MAX_PER_TARGET_PER_DAY` → **1**, authority moved to `Setting` with a code-side hard max of **2**. Rationale: at ~14 sends/day across ~200 targets the average recipient rate is 0.07/day, so raising the cap cannot increase throughput; it can only permit concentration. And `.env`'s own comment justifying 2 (\"two of our accounts route to each target and both should be able to open\") is defeated by decision 1, where the second message of a day is a *third* page.

### Tests
`tests/governor.test.ts` — each with a passing counterpart:
- `TARGET_UNANSWERED_LIMIT` fires at `targetTouchesSoFar === TargetAccount.maxUnansweredTouches`, permits one below; `pairTouchesSoFar` alone does not trip it, and vice versa.
- `TARGET_COOLDOWN_ACTIVE` fires inside `cooldownHours`, permits outside; **most-restrictive-wins**: pair cooldown expired + target cooldown active ⇒ refused, and the mirror.
- `SENDER_FAN_OUT_LIMIT` at cap 1: sender A permitted, sender B refused, sender A still permitted afterwards. At cap 3: A, B, C permitted, D refused.
- `NO_NEW_MATERIAL` fires when the *pair* has used nothing and the *target* has used everything (the case per-pair scoping permits today).
- `touchNumber === targetTouchesSoFar + 1`, so 63 pairs' first messages to one recipient are touches 1..63, not 1..1.
- Ordering: with `targetRepliedAt` set **and** the fan-out cap exceeded, the reason returned is `target-replied`. Rotation and volume reasons must never mask a reply.
- `checkNewProspectCap` fires for a CHANNEL first touch, not only BRAND; permits at one below the cap.

`tests/atomicity.test.ts` (real temp SQLite):
- I1 fires: two `create`s of a `READY` attempt for one `targetId` → the second throws `P2002` and the helper reports \"not claimed\". I1 releases: flip the first to `SKIPPED`, re-insert → succeeds.
- I1 fires **regardless of `origin`**; and `prepareOnDemandSend` supersedes the planner draft rather than stacking.
- I2 fires for the same `(campaignId, targetId)` in-flight; the same campaign to a *different* target succeeds.
- I3: claims succeed for `seq` 1..cap, `false` at cap+1; after release the slot is re-claimable; a different `istDay` is independent; **claim at 18:29Z and deliver at 18:30:30Z (the IST midnight boundary) does not permit a second message.**
- `Promise.all` of two full derive→claim→create calls for one target produces **exactly one** attempt row and the loser reports a named hold, never an unhandled throw.
- `isUniqueViolation` matches `P2002` only; an unrelated error propagates.
- DDL cross-check: the status lists inside all three partial indexes, read from `sqlite_master`, equal the constants in `src/lib/constants.ts`.
- `schemaGuard` passes with the indexes present; drop one on a temp DB → the planner refuses, naming it.

### Guard-liveness requirement (not a test, an operating rule)
After Phase 3 ships at ≥5 sends/day, `SENDER_FAN_OUT_LIMIT`, `TARGET_COOLDOWN_ACTIVE` and `TARGET_UNANSWERED_LIMIT` must each show a non-zero fire count within 7 days. **Zero fires is the same evidence as `repliedAt` being null everywhere.** Add a `GuardFire(reason, day, count)` rollup written from `PlanSummary` and a `/settings` row showing \"last fired\".

### How you know it works
`pnpm test`. Then, on a copy of the DB: hand-insert the three stacked `@priyanshu123321123` drafts again and confirm two of them are refused with `pending-attempt-exists`. Run `pnpm run:slot` twice concurrently and confirm exactly one attempt row per target.

### Does NOT deliver
Categories. Rotation. Any change to which sender is chosen — Phase 2 only ever refuses more.

---

## PHASE 3 — CATEGORIES + DERIVED RING + ASSIGNMENT POLICY

Decision 1. Runtime-editable categories, a ring that orders senders, and **one setting that decides whether a recipient's follow-ups rotate or stick**.

### Migration `20260806100000_categories`
```sql
CREATE TABLE \"Category\" (
  \"id\" TEXT PRIMARY KEY NOT NULL, \"key\" TEXT NOT NULL, \"label\" TEXT NOT NULL,
  \"routingEnabled\" BOOLEAN NOT NULL DEFAULT false,   -- adding is never sending
  \"retiredAt\" DATETIME, \"notes\" TEXT,
  \"createdAt\" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  \"updatedAt\" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE UNIQUE INDEX \"uq_category_key\" ON \"Category\"(\"key\");

CREATE TABLE \"SenderCategoryMember\" (
  \"id\" TEXT PRIMARY KEY NOT NULL, \"categoryId\" TEXT NOT NULL, \"senderId\" TEXT NOT NULL,
  \"position\" INTEGER NOT NULL DEFAULT 0,
  \"enabled\" BOOLEAN NOT NULL DEFAULT false,
  \"addedAt\" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_scm_cat FOREIGN KEY (\"categoryId\") REFERENCES \"Category\"(\"id\") ON DELETE CASCADE,
  CONSTRAINT fk_scm_snd FOREIGN KEY (\"senderId\")  REFERENCES \"SenderAccount\"(\"id\") ON DELETE CASCADE);
CREATE UNIQUE INDEX \"uq_scm_cat_snd\" ON \"SenderCategoryMember\"(\"categoryId\",\"senderId\");
CREATE INDEX \"ix_scm_cat_pos\" ON \"SenderCategoryMember\"(\"categoryId\",\"position\");

CREATE TABLE \"TargetCategoryMember\" (
  \"id\" TEXT PRIMARY KEY NOT NULL, \"categoryId\" TEXT NOT NULL, \"targetId\" TEXT NOT NULL,
  \"addedAt\" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_tcm_cat FOREIGN KEY (\"categoryId\") REFERENCES \"Category\"(\"id\") ON DELETE CASCADE,
  CONSTRAINT fk_tcm_tgt FOREIGN KEY (\"targetId\")  REFERENCES \"TargetAccount\"(\"id\") ON DELETE CASCADE);
CREATE UNIQUE INDEX \"uq_tcm_target\" ON \"TargetCategoryMember\"(\"targetId\");   -- ONE ring per recipient
CREATE INDEX \"ix_tcm_cat\" ON \"TargetCategoryMember\"(\"categoryId\");

ALTER TABLE \"OutreachPair\" ADD COLUMN \"suppressedAt\"     DATETIME;
ALTER TABLE \"OutreachPair\" ADD COLUMN \"suppressedReason\" TEXT;

INSERT INTO \"Category\" (\"id\",\"key\",\"label\") VALUES ('cat_bollywood','bollywood-celebs','Bollywood / Celebs');
-- NO membership backfill. 4 senders x 5 channels would create 20 implicit routes where 6
-- pairs are enabled today. Applying this migration must change nothing until a human chooses.
```

**The absent-pair question, answered explicitly** (both readings fail silently, so it must be stated): **a pair that does not exist is ROUTABLE.** Routing authority is category membership + `Category.routingEnabled` + `SenderCategoryMember.enabled`. `OutreachPair.suppressedAt` is an *explicit exclusion* an operator sets on a specific combination; `OutreachPair.enabled` is retired from routing (kept for history and for `OVERRIDABLE_BLOCKS`, whose `'pair-disabled'` code becomes `'route-suppressed'`). **This is why the burner fix below is mandatory in this phase.**

### Create
- `src/outreach/rotation.ts` — **pure, empty import graph** (a static test asserts it imports only types; `governor.ts`/`gate.ts` purity is currently enforced only by convention). Rotation state is **derived, never stored**: the cursor is an *identity* (which account went last), so adding, removing or reordering members at runtime cannot corrupt it, and a turn exists only because an attempt row exists — which is why a CHALLENGED or unlogged-in sender never consumes its turn. A stored index would be corrupted by every membership edit, and advance-on-plan would burn a turn on a draft the gate later holds.
  - `ringOrder(members)` — `(position asc, senderId asc)`.
  - `seedIndex(targetId, salt, ringSize)` — FNV-1a. **Distinct salts for the ring seed and for Phase 8's angle picker**, or position and angle correlate invisibly.
  - `pickSender(input) → RotationPick` with `{ chosen, orderedSenderIds, lastDeliveredBy, turnHeldBy, ringSize, eligibleCount, degradedSingleSender, skippedByReason }`. The planner ignores the trace; the dashboard renders it.
  - **Two anchors from one query, and the distinction is not optional:** `turnHeldBy` from `IN_FLIGHT_STATUSES` (a waiting draft holds the turn so the next slot does not re-pick), `lastDeliveredBy` from `DELIVERED_STATUSES` (drives fairness). One anchor means an abandoned on-demand draft becomes a permanent cursor and the ring silently skips a sender forever.
  - `RotationSkipReason` is a **closed union**, with `const SENTENCES = {...} satisfies Record<RotationSkipReason,string>` so the UI cannot render a raw code, and an unassessed member is `reason: 'unknown'` → fail closed, with the sentence \"we could not assess N accounts\", never \"N accounts are fine\".
  - Guard: if `eligibleCount >= 2` and the pick equals `turnHeldBy ?? lastDeliveredBy`, return `WOULD_REPEAT` — **and log ALARM**, because a silent no-send is indistinguishable from \"everyone is in cooldown\".
- `src/outreach/rotationLoader.ts` — one batched load per slot (not per target): `TargetCategoryMember` + `SenderCategoryMember` (with sender scalars) + one `outreachAttempt.findMany` over `IN_FLIGHT ∪ DELIVERED` for the candidate targets, folded to `Map<targetId, …>`. `at = sentAt ?? queuedAt` resolved in **JS**, not in SQL — a two-column NULL-aware sort is exactly the near-miss that produced the IST/UTC cutoff bug. `profileStatus` memoised once per handle (measured 0.42-0.83 ms, `copyFileSync` + native open, called per attempt today).
- `src/app/(dash)/categories/page.tsx` + `view.ts` — functional, plain. One card per category: sender ring in order with a `▶ NEXT` marker and per-member enable toggle, recipient count, create/rename/retire, add/remove member, reorder, and the routing switch. The switch **defaults off**, and its confirmation names the count computed by **the planner's own target-selection query** (not `_count` on the membership tables, or the dialog overstates what consent is being given at the moment it is given).

### Modify
- `src/outreach/plan.ts` — **iterate targets, not pairs.** For each target with a routing-enabled category, ordered by \"longest since any of our accounts messaged this target, nulls first\" (not `target.handle asc`, which starves the alphabetical tail once a per-slot budget exists): `evaluateTarget` → emit its reason **once**, not 63 times → build eligibility from `evaluatePairMember` over the ring → `pickSender` → `upsert` the pair with `update: {}` (an upsert that wrote `enabled: true` would re-arm a route an operator suppressed) → create the attempt, catching `P2002` as a named hold. Measured: 17,158 pairs × 8 queries ≈ 9.5 s of planning → ~200 targets ≈ 0.3 s.
  - Delete the dead in-run accumulators `sentToTargetToday` / `sentBySenderToday` (`plan.ts:330-334`, incremented only on `SENT`, and after Phase 5 nothing is SENT inside `runOutreach`). Replace with an in-run `draftsCreatedBySender` map counted toward the sender cap — otherwise one sender is assigned 20 drafts in one run, 15 get held, and under I1 **those 15 block 15 recipients fleet-wide.**
  - Mutate `historyByTarget` after each create, so a second pass in one run cannot pick the same sender twice.
- `src/scripts/burner.ts` — **`burner on` writes `Setting` key `rehearsalMode = true`, read by `pickSender` AND `evaluateResend`.** Keep the draft-discard sweep. `safeTargetIds()` becomes a ring-level filter. Reason: the only rehearsal brake in the system is implemented as `outreachPair.updateMany({data:{enabled}})` — the exact column routing stops consulting — so it would become a silent no-op at the moment the fleet grows 16×. **Also**: `safeTargetIds()` treats any target that is also one of our senders as safe, so importing 63 senders would make 63 of our own pages permanently messageable during rehearsal; restrict it to the burner handle plus an explicit allowlist.
- `src/app/actions.ts` — new: `createCategory`, `renameCategory`, `retireCategory` (never delete with history), `addSenderToCategory`, `removeSenderFromCategory`, `setSenderMemberEnabled`, `reorderCategory`, `setTargetCategory`, `setCategoryRoutingEnabled`, `suppressRoute`, `unsuppressRoute`. Each begins with `await requireUser()` as its **first statement**, writes `AuditLog`, and defaults to off. **Delete the cross-product pair creation from `addSender` (:657-668), `addTarget` (:777-787) and `confirmBrand` (:1005-1015)** — 65 senders × 264 targets is 17,158 rows nobody can maintain, and pairs are now created lazily.

### Tests — `tests/rotation.test.ts` (pure)
Ordering/seed: deterministic across shuffled input; `seedIndex` stable, in range, `ringSize 0 → 0` without throwing, and **200 distinct cuid-shaped ids over a ring of 63 hit ≥40 distinct indices** (guards \"all 200 imported first touches land on one revenue account\").
Advance: no history → `ordered[seedIndex]`; `[A]` → B; `[B,A]` → C; `[C,B,A]` → wraps to A. For every ring size 2..8 and every history length 1..20, `pick !== lastDeliveredBy` when `eligibleCount ≥ 2`.
`WOULD_REPEAT`: a hand-built input that would repeat with `eligibleCount ≥ 2` returns `picked:false, WOULD_REPEAT`; the same input with `eligibleCount === 1` returns `picked:true, degradedSingleSender:true`.
Runtime edits: member appended → pick unchanged, new member next cycle; member inserted **before the anchor** → pick unchanged (the assertion a stored index would fail); anchor removed → falls back to the newest still-member, pick ≠ last; **every** past sender removed → falls back to the seed; `enabled:false` on the anchor → still anchors, never picked; `enabled:false` on a middle member → other members' turns unchanged; positions renumbered 1..n → n..1 → still never repeats consecutively.
Eligibility: a `sender-not-active` member is skipped, counted once, the next is picked, **and re-running with it eligible picks it** (the turn was not consumed); `self-send` never picked at any ring size including 1 (→ `NONE_ELIGIBLE`, never a self-DM — `bollywoodchronicle` and `bollywoodsocietyy` are both senders and CHANNEL targets today); a member absent from the eligibility map is ineligible with `unknown`; all ineligible → `NONE_ELIGIBLE` with `skippedByReason` totalling `ringSize`; mixed reasons produce distinct counts; `categoryId: null` → `NO_CATEGORY`, `routingEnabled:false` → `ROUTING_OFF`, empty members → `EMPTY_RING`, each with a passing counterpart.
Anchors: an abandoned on-demand `READY` draft sets `turnHeldBy` and does **not** move `lastDeliveredBy`; discarding it releases both.
Rehearsal: with `rehearsalMode` on, `pickSender` returns `picked:false` for every non-safe target **including targets with no pair rows at all**; off → picks resume.
Every `RotationSkipReason` has a non-empty sentence.
Purity: `rotation.ts` imports only types.
`tests/plan.test.ts`: a sender challenged mid-run is skipped for every later target in the same run; a checkpoint failure moves that attempt to `SKIPPED` with `'sender challenged — released for re-drafting'` (without this, I1 leaves the recipient blocked by a draft from a dead account forever), while a **transient** failure leaves it `READY`.

### How you know it works
Create the category, add 2 senders and 1 target with `routingEnabled` off → `pnpm run:slot` creates nothing and reports `category-routing-off`. Turn it on → the first slot picks the seeded sender; record a delivery by hand; the next slot picks the other. Turn `maxDistinctSenders` to 1 → the second slot reports `sender-fan-out-limit` and the same sender keeps the recipient. `pnpm burner on` → every non-safe target reports `picked:false`.

### Does NOT deliver
Any change to pacing, the dashboard beyond `/categories`, generation, imports, or more senders.

---

## PHASE 4 — DASHBOARD: NAV, `/accounts`, `/accounts/login`, `/messages`

Ships early because the 66 hand logins are **calendar-limited** (≥21 days at 3/day) and must start while later phases are built. Correctness over looks.

### Create
`src/app/layout.tsx` nav (six links: Today · Messages · Accounts · Categories · Prospects · Settings; badges only on Messages and Accounts). `src/app/(dash)/accounts/{page.tsx,view.ts}`, `accounts/login/{page.tsx,view.ts}`, `accounts/[handle]/{page.tsx,view.ts}`, `messages/{page.tsx,view.ts}`. `src/app/(dash)/today/` replaces the body of `page.tsx`.

Every page calls `currentUser()` itself — `middleware.ts:129` checks cookie *presence* only and its own docblock says so.

### Rules
- **`/` answers four questions and nothing else:** is it running (+ heartbeat, red when stale); did anyone reply (full cards, max 5); is anything waiting for me (a count and a link); is anything stopping it (a count and a link). Then the three 7-day numbers with the coverage line. **Nothing enumerates more than 10 rows.** No `.map().join()` of handles anywhere — at 65 accounts the current headline becomes a 40-handle sentence.
- **`/accounts` opens with counts, then only exceptions**: challenged rows with Clear-the-halt, invalid-persona rows, then `9 not logged in →` as one link. The healthy majority is a collapsed, paginated (25), searchable table. **One** shared-persona line, not 63 copies of the 3-paragraph warning.
- **`/accounts/login` is a queue, not 66 buttons.** Module invariant: **one open connect window**, enforced in `startConnect` against `sessions.size` (it cancels only the same handle today; 10 clicks = 8.1 GB RSS on a 16 GB box). A **per-day login budget** in the UI that refuses the 4th and says why — this is a safety control, not a convenience: 66 logins from one residential IP in a short window is an anomaly burst on the action the whole design depends on Instagram trusting. Progress is derived from `profileStatus()` on disk, not from `connect.ts`'s module Map (which will not survive a `next dev` recompile mid-batch); the Map answers only \"is a window open right now\". **`pollConnect` must classify 2FA** (`classifyUrl` and `TwoFactorRequiredError` exist and it calls neither, so a 2FA-parked window says \"Waiting for you to log in…\" forever — the majority path at 66 logins). **Three states, not two**: never-connected (the first login *creates* device identity) vs session-expired (a re-login *preserves* it) vs connected — collapsing them invites deleting the profile, which destroys the device identity the whole design exists to protect. Plus `unreadable`, because `hasSessionCookie` returns `false` on any exception and the \"expired\" copy would then instruct a needless re-login on a healthy revenue account. **No control on this page deletes anything.**
- **`checkConnect` stops being polled per row** — each poll is an authenticated `users/{id}/info/` request from that account's own profile; 65 rows × 3 s ≈ 22 authenticated req/s from the home IP.
- **`/messages`**: tabs Needs review / Ready / Sent / Rejected, default Needs review, server-paginated 25, **never unmounts when empty**. Collapsed rows; body on expand. The Approve label is computed by **calling `evaluateResend`** with `unattended:true`, not by re-deriving three of twelve conditions — \"One gate, two callers. Never re-inline it.\" `a`-to-approve is armed **only on a row expanded in this session**; **no bulk approve** (one click arming 14 sends to 14 inboxes has no bound and no per-item read); **bulk reject is offered** because it fails safe.
- The Sent tab reads replies **independently of `replyHandledAt`** — today the activity feed draws reply events from `unreadReplies`, so pressing \"I have replied\" erases the reply from history.
- `FOLLOWER_SNAPSHOT` (2 entries) leaves every table. No `qualityScore` integer on screen — store it, render sentences. No shell command on any page (`autopilot.tsx:92-93` still prints `pnpm worker` and env var names).
- Rewrite `layout.tsx:9-12` (\"No navigation, because there is only one page\") and `page.tsx:16-27`. A stale comment defending a reversed decision is worse than none.

### Tests
`tests/view.test.ts`: `/accounts` view issues a bounded number of queries independent of sender count (assert with a query-count spy at 4 and at 65 seeded senders); `loginState` returns four distinct states for four fixture profiles including an unreadable one; the Approve label reads \"hold\" when the recipient's day cap is spent and \"will send at HH:MM\" when everything is green; `startConnect` refuses a second window with a named reason; the login page refuses the 4th login of an IST day.

### How you know it works
Every page returns 200 **and its `/_next/static/**.js` references each return 200** (a `curl -w \"%{http_code}\"` on the HTML proves only that the server is alive). Rebuild before `start`, never during. Log in one account through the queue end to end, including a 2FA prompt, and confirm the copy names the code.

---

## PHASE 5 — PACED DISPATCHER

Delivery leaves the slot. This is arithmetic, not preference: 14 sends × (60 s send + 112.5 s mean jitter) = 38 min today and **4.2 h** at the human-shaped pacing below, against a 30-min lock and a 120-min gap between the 15:00 and 17:00 slots.

### Migration `20260807100000_dispatcher`
```sql
CREATE TABLE \"FleetSendSlot\" (
  \"istDay\" TEXT NOT NULL, \"seq\" INTEGER NOT NULL,
  \"attemptId\" TEXT NOT NULL, \"senderId\" TEXT NOT NULL,
  \"claimedAt\" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (\"istDay\",\"seq\"));
CREATE UNIQUE INDEX \"uq_fleetsendslot_attempt\" ON \"FleetSendSlot\"(\"attemptId\");
ALTER TABLE \"SenderAccount\" ADD COLUMN \"cohort\"      INTEGER NOT NULL DEFAULT 0;
ALTER TABLE \"SenderAccount\" ADD COLUMN \"graduatedAt\" DATETIME;
```
A **reservation table, not a counter.** A counter decremented at dispatch drifts from the attempt rows on every crash between token-take and the SENT write, and then the page says one thing while the dispatcher enforces another — the `MAX_TOTAL_SENDS` failure verbatim.

### Create
- `src/worker/dispatcher.ts` — long-lived, own heartbeated lease (`Setting`, refreshed every 60 s, `process.kill(pid,0)` for liveness; **freshness alone is not liveness**). Releases **at most one send at a time, fleet-wide.** Serial is non-negotiable for three independent reasons: the clipboard is process-global (`pbcopy` + `ControlOrMeta+V`), so overlapping sends put body A into thread B and the read-back fails *randomly*, which invites weakening it; 815 MB RSS per headful Chrome on 16 GB caps concurrency at 2-3 and a swap stall between Enter and the read-back is the worst possible stall; and simultaneous DMs from N accounts behind one IP with byte-identical fingerprints is a shape no set of independent humans produces.
- Pacing: log-normal inter-arrival, **floor 4 min, median ~18 min, p95 ~75 min**, 2-3 deliberate 60-150 min gaps/day, 3-5 clusters of 2-5 sends, window **10:00-21:30 IST**, Sunday ≤30%, daily volume varied ±40% with occasional zero-send days, ≥90 min between two sends from the same account. Per-account distributions **seeded off `senderId`** so 65 accounts are not one generator. `SEND_JITTER_MIN/MAX_SECONDS` is superseded — 45 s between DMs from two different pages is not a human gap.
- `MAX_SENDS_PER_RUN` / `take` on `deliver.ts:57` (unbounded today, while the read-only reply check is capped at 4 — the risk ordering is inverted).
- **Fleet circuit breaker** as a `Setting` read by the dispatcher, `deliver.ts`, `replyCheck.ts` and the account-state mux: 1 checkpoint → halt that account and **halt fleet expansion**; 2 in 24 h or 3 in 7 d → halt all dispatch. Release is its own explicit act, does not re-arm auto-send, and **renders on every account row as `fleet-halted`** — otherwise `clearChallenge` turns a row green while nothing sends.
- `SEND_ENABLED` env hard floor (default **false**), separate from `AUTOPILOT_ENABLED`, checked at every send site. `maxArmedSenders` refuses arming past the cohort bound. Reason: `AUTOPILOT_ENABLED=true` and `DRY_RUN=0` are already in `.env`, registration is open, and only the `127.0.0.1` bind limits reach.
- Random 0-25 min offset per detection slot. Four sends/day at `HH:00:0x` for weeks is itself a fingerprint.
- Pre-launch **free-space floor** in `launchProfile` (refuse below 8 GB, named reason) and a cache pruner for `Default/Cache`, `Default/Code Cache`, `Default/GPUCache`. Measured: 26 GiB free, 91 MB (login-only) to 604 MB (used) per profile, of which 518 MB is disposable cache and the identity-bearing `Default/Cookies` is 20 KB in both. **Never delete a profile directory**, and say so beside every Remove control. Prefer pruning to `--disk-cache-size` — `launchProfile`'s comment deliberately keeps args to flags a real person's Chrome would also have.
- `sendNow` **enqueues into the dispatcher and consumes a `FleetSendSlot`**; approving never dispatches. Otherwise `/messages`' keyboard review is a burst path around every pacing control.

### Tests
`tests/dispatcher.test.ts`: `claimFleetDay` succeeds 1..cap and refuses at cap+1, releases on non-SENT, is independent per `istDay`; a send is refused outside the window with `outside-send-window`; two sends from one account inside 90 min are refused; the inter-arrival sampler never returns below the floor and its median over 10,000 draws is within 10% of target; two accounts' samplers with different `senderId` produce different sequences; the lease is declined when the holder's heartbeat is fresh at 40 min age and taken over when it stopped 40 min ago (**both directions** — this is the inverse of the documented heartbeat bug); the breaker at 1 checkpoint halts that account and blocks arming, at 2 halts dispatch, and release restores exactly one of those.

### How you know it works
Run the dispatcher in `DRY_RUN` for a full day and plot the inter-arrival histogram and the per-account gaps. `select istDay, count(*) from FleetSendSlot group by 1` matches the dashboard's \"sent today\" from one query. Kill the process between claim and SENT and confirm both numbers still agree.

---

## PHASE 6 — REPLY DETECTION AT SCALE

The hardest stop in the system currently degrades silently with target count, and under rotation it reads the wrong conversation by construction.

### Modify
- `src/outreach/replyCheck.ts` — dedupe on **`(targetId, senderId)`** restricted to senders with a delivered attempt (`:114` dedupes on `targetId` and `:141` then reads *one* sender's thread; a reply to sender B is invisible when reading A↔R, and `:246` then stamps `replyCheckedAt` and reports \"no reply\", converting an unread conversation into verified silence). Drop the `sender: { status: 'ACTIVE' }` scope's silent effect: if the sender that last delivered is CHALLENGED, the run must report `unreadable` for that target and **not** stamp `replyCheckedAt`.
- **Candidates follow the dispatcher, not the corpus.** Check the recipients this cycle is about to write to, which is what `runSlot.ts:198-200` already says the guard is *for*. At 200 targets the current 4 × 2 sweep is one check per recipient every **25 days**.
- **Inbox/requests read per sender** replaces one-thread-per-target where possible: under a fan-out cap of ≤3, 200 recipients × 3 threads live in ~15 armed senders' inboxes, so **15 sessions cover 600 threads versus 600 reads** — cheaper than today's 8. A scan may stamp `replyCheckedAt` **only** for conversations it positively enumerated, must record which folders it read (General / Requests / **Hidden Requests**), and must leave every other target unstamped.
- **`replyCheckStaleDays` becomes a `evaluateResend` input.** `replyCheckedAt` is written by `replyCheck.ts` and read by **nothing** outside it — the honest \"we could not vouch\" distinction is recorded and then used by no send decision and shown on no screen. That is the `repliedAt` bug again.
- **A block is an opt-out.** \"No Message button on a profile we previously messaged successfully\" sets `TargetAccount.optedOut` — already an absolute, non-overridable stop — retiring that recipient fleet-wide. Today it is a `FAILED` string, returned to `READY`, retried at every slot with (before Phase 0) no counter, while rotation hands the next message to a sender who is not blocked.
- The checkpoint `break` stays (do not open more sessions from a flagged estate — the reasoning gets *stronger* at 65) but the un-checked candidates must become a send-path refusal, not silence.
- `src/worker/runSlot.ts` — fix the docblock at `:24-29`, which still says \"There is no automated reply-detection stage\".

### Tests
Two senders to one target, the replying one CHALLENGED → `unreadable`, **no** `replyCheckedAt`; both ACTIVE → the reply is found. A fixture inbox listing 3 of 5 targets → exactly 3 stamps. A Requests tab that fails to load → 0 stamps. Never-checked target → `evaluateResend` refuses with `reply-check-never-run`; checked 2 h ago → permits. A profile with no Message button, with prior delivery → `optedOut` set; without prior delivery → not set.

### How you know it works
`select count(*) from OutreachAttempt where status in ('SENT','REPLIED') and replyCheckedAt is null` and \"oldest unchecked conversation: N days\" both render on `/settings`. Verify positively and negatively against a live thread as CLAUDE.md already records doing for `pnpm ig:thread`.

---

## PHASE 7 — PROSPECTS: IMPORT, `/prospects`, `/settings`

### Migration `20260808100000_prospect_import`
```sql
CREATE TABLE \"TargetImport\" (
  \"id\" TEXT PRIMARY KEY NOT NULL, \"filename\" TEXT, \"categoryId\" TEXT, \"importedBy\" TEXT,
  \"rowCount\" INTEGER NOT NULL DEFAULT 0, \"createdCount\" INTEGER NOT NULL DEFAULT 0,
  \"skippedCount\" INTEGER NOT NULL DEFAULT 0, \"errors\" TEXT NOT NULL DEFAULT '[]',
  \"at\" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP);
ALTER TABLE \"TargetAccount\" ADD COLUMN \"watchEnabled\" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE \"TargetAccount\" ADD COLUMN \"source\"       TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE \"TargetAccount\" ADD COLUMN \"importId\"     TEXT;
UPDATE \"TargetAccount\" SET \"watchEnabled\" = true WHERE \"kind\"='CHANNEL' AND \"optedOut\" = false;
UPDATE \"TargetAccount\" SET \"source\"='discovered' WHERE \"discoveredFromCampaignId\" IS NOT NULL;
```

- **`previewTargetImport(csv)` writes nothing. Dry run is the only default**, like `ig:classify` and `ig:brands`. The preview reports: N new, N already present, N that **do not exist on Instagram** (`detection/exists.ts`, paced — 200 lookups is 200 requests), N that are **one of our own senders**, N **retired** (`optedOut`). The importer must **never write `optedOut`**; a blind upsert on the unique `handle` would resurrect a retired recipient. Leave `contactFirstName` NULL when the sheet has no name column and **render the actual greeting line** in the preview (`Hi Milano Ice Cream, Bangalore team,` reached the live DB).
- **`watchEnabled` defaults false and is the IP valve.** `pipeline.ts:49-52` fetches every CHANNEL target: 4 channels × 4 pages = 48 requests/slot today; 200 watched channels is 800/slot ≈ 3,200/day from the residential IP that also hosts every authenticated session. Measured: the profile endpoint already returns 7/10 HTTP 400 at 2.5 s spacing.
- `/prospects` — two tabs, exceptions first (brands needing a decision — measured 19 of 34 `BrandLookup` rows are `UNRESOLVED`; recipients on hold; channels that could not be read), then a paginated table with `messages today / cap`. `/prospects/[handle]` carries the **rotation panel** (§ below) and **is where the on-demand send lives**, which fixes by construction that \"Send a message now\" cannot currently reach a BRAND target at all (`page.tsx:118` passes `v.channels`, filtered `kind:'CHANNEL'`, and `onDemand.ts:248` then refuses) while decision 7 makes brands half the scope.
- The rotation panel calls `pickSender` and renders its **trace**. It must say \"would send now\", not \"will send\" — the ring, the eligibility and the caps are all evaluated at render time and the slot is hours away. When the ring is entirely ineligible it must name the counts, never `Next: —`. When a draft holds the turn it must say so.
- `/settings` — autopilot toggle + `allowedByEnv` floor + `SEND_ENABLED`; heartbeat and host; **degraded runs over a window, split by cause**; per-recipient cap with its reason beside it; new-prospect rate; lifetime ceiling counted the way `plan.ts` counts it (`IN_FLIGHT_STATUSES`); guard-liveness rows with \"last fired\"; model spend and **cache-hit rate** over 7 days; the four-yeses explainer.
- Coverage copy at 60 channels: `Counted from 5 of 60 channels. 55 are stored but not judged. →` — a count and a link, never 55 names inline, and never deleted.

### Tests
A 200-row fixture CSV: preview writes nothing (assert row counts unchanged), classifies every row into exactly one bucket, and commit creates exactly `createdCount` rows with pairs absent and category membership `enabled:false`; a row whose handle is `optedOut` is reported `skipped: retired` and the target's `optedOut` is still true afterwards; re-importing the same CSV creates 0. `watchEnabled:false` targets are not fetched by `pipeline.ts` (assert the request count).

---

## PHASE 8 — GENERATED MESSAGES + QUALITY GATE

Decision 4. **Generation is a safety control, not a quality nicety**: measured, `MessageVariant` holds 72 rows and **18 distinct texts**, seeded per sender, so at 65 senders one recipient sees the same 18 bodies arriving from different pages — the cross-account repetition decision 3 exists to prevent, created *by* decision 1.

### Migration `20260809100000_generated_bodies`
```sql
ALTER TABLE \"OutreachAttempt\" ADD COLUMN \"bodySource\"     TEXT NOT NULL DEFAULT 'variant';
ALTER TABLE \"OutreachAttempt\" ADD COLUMN \"generatorModel\" TEXT;
ALTER TABLE \"OutreachAttempt\" ADD COLUMN \"promptVersion\"  TEXT;
ALTER TABLE \"OutreachAttempt\" ADD COLUMN \"qualityChecks\"  TEXT NOT NULL DEFAULT '[]';
ALTER TABLE \"OutreachAttempt\" ADD COLUMN \"qualityGateAt\"  DATETIME;
ALTER TABLE \"OutreachAttempt\" ADD COLUMN \"angleUsed\"      TEXT;
ALTER TABLE \"OutreachAttempt\" ADD COLUMN \"askUsed\"        TEXT;
ALTER TABLE \"OutreachAttempt\" ADD COLUMN \"rejectReason\"   TEXT;
ALTER TABLE \"DetectedCampaign\" ADD COLUMN \"disclosureSignal\" TEXT;  -- 'hashtag'|'meta-branded-content'|null
ALTER TABLE \"SenderAccount\"    ADD COLUMN \"pageNiche\" TEXT;
ALTER TABLE \"SenderAccount\"    ADD COLUMN \"pageReach\" TEXT;
-- variantId becomes nullable: table rebuild with PRAGMA defer_foreign_keys (precedent:
-- 20260729110921, 20260730085508). BACK UP prisma/dev.db FIRST and assert count(*) before
-- and after. ONLY safe because Phase 0 moved messageVariant.update out of the SENT txn.
```
`REJECTED` is added to `ATTEMPT_STATUSES` and to **neither** `DELIVERED_STATUSES` nor `IN_FLIGHT_STATUSES`, so a rejection consumes no lifetime ceiling and burns no campaign. `DRAFT` is not introduced — a gate `REFUSE` writes `SKIPPED` + `error: 'quality-gate: <codes>'`, reusing `plan.ts:518-529`'s DRY_RUN pattern.

### Create
`src/outreach/compose.ts` (the only `fetch`; module-constant `COMPOSER_SYSTEM_PROMPT`, `thinking:{type:'disabled'}`, `response_format json_object`, `max_tokens 700`, `temperature 0.8` — the one deliberate divergence from the classifier's `0`, because temperature 0 with a fixed angle makes two senders drawing the same brief produce near-identical prose). `src/outreach/composeFacts.ts` (**pure**: `ComposeFacts`, `buildUserMessage`, `pickDirection`, 10 angles × 6 asks). `src/outreach/bodyGate.ts` (**pure**, one exported predicate per check, closed `GATE_CODES`; **never repairs** except the whitelisted `STRIP_OBSERVATION`, which is a deletion). `src/scripts/drafts.ts` (`pnpm ig:drafts`, **dry run by default**).

**Non-negotiables in the prompt file**, each with a test: no `${`, not built by concatenation / `.replace()` / `.trim()` / `readFileSync`; a checksum test on its bytes; the angle keys parsed out of it must set-equal `AngleKey`, and `union(ANGLES_BY_KIND)` must set-equal `AngleKey`. Cached input is $0.0028/1M against $0.14/1M — **50×** — and the classifier's `prompt_cache_hit_tokens` is *exactly* 640 on all 47 recorded calls, so any drift is unambiguous. The real reason to protect the cache at this scale is **latency**, not money (see RISKS).

**Gate essentials** (full list in the GENERATION survey; these are the ones with a live defect behind them):
- `A4 short-lines-only` — ≥2 lines >40 chars, because otherwise `distinctiveSlice` collapses onto the persona intro line and both send guards become tautologies.
- `A11 network-number-not-canonical` — the canonical set is **derived from `prisma/variants.ts` / `brandVariants.ts`**, not hardcoded, with a test asserting every seeded body passes.
- `A14 repeats-prior-text` — normalised, ≥8-word shared run or 5-gram Jaccard >0.30, against priors to **this recipient from any sender**, priors from **this sender to anyone**, **and a fleet-wide rolling corpus of the last ~500 delivered bodies' 5-gram hashes**. Meta's near-duplicate clustering is fleet-wide and recipient-blind; the first two axes are the ones it does not use.
- `A17 observation-overclaim` — commercial framing only when `disclosureSignal` is set. **Measured: 34 of 40 CAMPAIGN verdicts are `verdictSource:'semantic'`**, and `buildHookLine` says \"your recent branded collaboration with X\" for all of them because `RenderHookSource` cannot see `verdictSource`. Keying `evidence` off `verdictSource === 'rules'` is unsafe: a stage-1 filtered post is already stored as `ORGANIC`/`rules`, so the moment anyone adds a CTA shortcut to stage 1 the value means two different things. Hence the new `disclosureSignal` column, written only by `mom.ts` and by `is_paid_partnership`.
- `A18 observation-names-a-person` — measured, **3 of the 8 most recent** hook lines name a director, an actress or a mangled title as the brand (`\"...with Sandeep Reddy Vanga and Realyukti\"`, `\"...with Rana Ji 2 0\"`). Fix upstream by filtering brands through `BrandLookup`, treating a missing lookup as \"not checked\", never \"is a brand\".
- `B3 needle-not-from-body` — the needle must come from the generated paragraphs, >40 chars, and not be inside the greeting, intro, close, persona fields, **the observation line, or the recipient's own name** (the post-send check reads `body.textContent()`, so profile chrome and the thread header are in scope and the needle would be present whether Enter worked or not).
- `N15` — `gate.ts` refuses any attempt whose `bodySource` is in `GATED_BODY_SOURCES` with `qualityGateAt IS NULL`. `bodySource` and `qualityGateAt` are **required** fields on `ResendInput` so the 30 existing gate tests must state a value rather than passing `undefined` and shipping the guard inert.

**Fallback order, and it is the safety argument:** not configured → variant path, with the reason on screen. Network/non-2xx/malformed → `null`, variant path. `REGENERATE` → one retry, codes fed back **in the user message only**, capped at `MAX_COMPOSE_CALLS_PER_DRAFT = 2`. Still failing → variant path, logged as a **degradation** with the fall-back rate on `/settings` (a rising rate means more messages from the 18-text pool, which is what A14 defends against). `REFUSE` (B1/B2/B3/B4/B5) → **no message**, never a fallback, because a variant assembles through the identical envelope and would fail identically. **429 / 401 / 403 → stop composing for the rest of the run; every other status is per-item** — `if (!res.ok) rateLimited = true` is HANDOFF bug #1 verbatim.

**Every generated attempt must record `campaignId`**, whether or not the observation survived the gate. `plan.ts:501` sets `hook: null` when using a bespoke body, so today a first touch consumes no campaign and `used` never grows — inherit that branch and the per-target material rule counts nothing and becomes a guard that cannot fire.

**A rejection with a factual reason (`overclaims-paid`, `wrong-facts`) excludes that `campaignId` as a hook for that target**; a `tone` rejection does not. Otherwise the reject button spends money every slot and changes nothing.

Fall-back variant selection seeded per `(targetId, senderId)`, not global LRU per sender — at 95% generation the LRU barely advances, so when generation *does* fail every sender draws its stalest variant simultaneously, emitting maximally correlated text at the worst moment.

**Rewrite the headers of `prisma/variants.ts` and `brandVariants.ts` and their CLAUDE.md Layout entries in the same commit.** They assert hand-authorship as a decision; the constant system prompt becomes the editorial artefact instead, measured by `ig:drafts` the way the classifier prompt is by `ig:accuracy`. **Do not delete the pools** — they are the fallback and the renderer's regression suite.

### `pnpm ig:drafts`
Test 1 mechanical pass rate per check and per angle over 40 real triples (~$0.007) — run on **every** prompt edit. Test 2 blind A/B against the hand-written pool, own constant judge prompt, acceptance ≥50%. Test 3 **the repetition test**: 63 bodies for the same campaign and recipient, max/median pairwise 5-gram Jaccard and 8-word-run collisions, compared against the same metric over the 18 hand-written bodies; acceptance zero collisions and max Jaccard <0.30. Test 4 fact-fidelity *attempt* rate (free) — how often the model tries a non-canonical number, which is the leading indicator a prompt edit loosened the leash. Test 5 `--print 10` **fully assembled, addressed to the real recipients, read by a human.** Two defects reached the live database that no test caught because nobody read the actual output. Full run ≈ $0.02.

---

## PHASE 9 — FLEET ONBOARDING

Decision 2, as a ladder. The code supports 65; the rollout is gated.

- Cohorts **3 → 5 → 8 → 12**, 14-day soak each, expansion blocked by any CHALLENGED in the window, `maxArmedSenders` = cohort size.
- Per-sender checklist before the first send, enforced in code where possible: distinct persona passing `validatePersona` **and** `checkPersonaDistinct` for **both** CHANNEL and BRAND; hand login on this machine and IP into its own profile; **both** `sessionid` and `ds_user_id` present (their measured expiries differ by ~275 days, so `sessionid`-only reports connected and throws at send time, sending the operator to re-login — the highest-risk act in the design); `identify(page)` returns exactly this handle; 2FA enrolled and exercised once; login event ≥24 h old with ≥1 ordinary human session in between and **no first send in the same browser session as the login**; category membership added disabled; `autoSendEnabled` off; first real send attended.
- **Warm-up is non-DM activity** — log in, read the feed, read the inbox, over ≥24 h — plus **one** rehearsal send to a single designated throwaway recipient. **Not** to our own network: 63 × 2 = 126 DMs among co-owned pages on one device with identical personas is a coordinated-network signature that needs no external recipient to exist.
- `addSender` must **stop copying the persona from the oldest account** (`actions.ts:616-631`). An account without a distinct persona is created **blocked**.
- Monitoring on screen before cohort 2: send-failure taxonomy by `failureCode` with `'not-in-thread'` halting the account after **one** occurrence; enforcement-phrase hits; forced-logout rate; 2FA re-prompt rate counted **separately** from CHALLENGED; CHALLENGED with a denominator and a window; **reply rate per cohort** at constant volume (the earliest sign messages are being filed into Hidden Requests, invisible any other way); thread-unreadable rate and oldest-unchecked age; **per-recipient exposure report** (distinct senders, total messages, days since first contact, top 10 — nothing computes this today); guard-liveness fires; the override ledger; `ds_user_id` expiry per profile (at 0.22 sends/account/day, idle-past-expiry is the *normal* case at 65).

---

## DECISIONS

**D1.** Rotation state is **derived** from `OutreachAttempt`, never a stored cursor — because decision 1 requires runtime membership edits, and a stored index into a mutable ordered list is corrupted by every insert with no query able to detect it.
**D2.** The cursor is an **identity**, not an index, and a turn exists only because an attempt row exists — so a CHALLENGED or unlogged-in sender never burns its turn, and discarding a draft releases it self-healingly.
**D3. Contested (ATTACK:BANS vs decision 1). Resolved by parameterising, not by overruling.** The ring decides which sender *opens* each recipient and wraps across the fleet forever (decision 1's mechanism, and the load-spreading it is for); `TargetAccount.maxDistinctSenders` decides whether *follow-ups* to the same recipient rotate. **Default 1**, hard max 3. At 1 the system is exactly the sharded model BANS argued for; at ≥2 it is fan-out rotation. One column, one setting, no fork in the code. Tabish sets the number (OQ-1).
**D4. Contested.** Rotation must not ship before Phase 2's per-recipient guards, because per-pair `cooldownDays`, `maxUnansweredTouches`, `hasPendingAttempt`, `usedCampaignIds` and `touchesSoFar` all go inert under any ring — 63 × 3 = 189 legal unanswered messages to one inbox, every clock green.
**D5.** `SenderAccount.dailyCap` is **kept unchanged** as a runaway fuse, not deleted. It is non-binding by ~23× at the material-driven rate, so removing it buys zero throughput and deletes the only per-account bound, contradicting `gate.ts:96-100`. \"No per-sender cap\" is implemented as \"the per-sender cap is not the control any more\", which is already true.
**D6. Contested.** `maxNewBrandTouchesPerDay` **is** a system-wide daily cap and is **kept and widened to all target kinds** as a new-*conversation* introduction rate. It is the only thing bounding a 200-row import where every row skips `NO_NEW_MATERIAL` by construction.
**D7.** Per-recipient cap → **1/day**, authority in `Setting`, hard code max 2. Raising it cannot increase throughput at ~14 sends/day across ~200 targets; it can only permit concentration. The written reason for 2 is defeated by rotation.
**D8.** Every per-**recipient** bound is a **block**, not a warning. Crossing a per-pair rule sends one extra message to one person; crossing a per-recipient rule has no bound. `target-replied` stays crossable (Tabish's choice) but gains a budget, because 3 of 7 delivered messages were already overrides of it.
**D9.** Counted-entity ≠ claimed-entity is fixed with **reservation tables** (`RecipientDaySlot`, `FleetSendSlot`) using `create` on a compound PK, and **partial unique indexes** for pending-per-recipient and campaign-per-recipient. Verified `P2002` on this exact stack.
**D10.** I1's predicate is on **status only**; on-demand's \"draft already waiting\" override is an explicit supersede. An `origin` exemption would let the planner stack on an operator's draft.
**D11.** Two anchors, one query: `turnHeldBy` from IN_FLIGHT, `lastDeliveredBy` from DELIVERED. One anchor makes an abandoned draft a permanent cursor.
**D12.** Routing authority moves from `OutreachPair.enabled` to category membership + `Category.routingEnabled` + `SenderCategoryMember.enabled`, all defaulting false; `OutreachPair.suppressedAt` is an explicit per-combination exclusion. **An absent pair is routable.** This is a reinterpretation of \"adding is never the same act as sending\" — the spirit is kept (one deliberate act per grant) and the act changes scope. Needs Tabish's yes (OQ-2).
**D13.** Therefore `pnpm burner` brakes on a `Setting` read by `pickSender` and `evaluateResend`, not by sweeping `pair.enabled`. Otherwise the only rehearsal brake becomes a silent no-op exactly when the fleet grows 16×.
**D14.** WAL + `synchronous=NORMAL` + `busy_timeout` + `ANALYZE` now. **Postgres is not a prerequisite for scale** — 725,650 rows and 502 MiB with point queries at 1-19 ms — and is a prerequisite only for the Linode host split, where two hosts cannot share a SQLite file.
**D15.** Generation happens **lazily, once per `OutreachAttempt`**, not per detected post: the per-recipient cap plus a 72 h hook window would waste ~98% of 882 bodies/day.
**D16.** The constant system prompt is the editorial artefact, measured by `ig:drafts`. `variants.ts`' \"written by hand\" rationale is half void (the project holds an API key) and half answered differently; **the pools survive as the fallback and the regression suite.**
**D17.** A gate `REFUSE` writes `SKIPPED`, not a new status — the campaign is not consumed, which is what \"surplus posts are never lost\" requires.
**D18.** `disclosureSignal` is a new column; `evidence` never keys off `verdictSource`, because a stage-1 drop is already stored as `ORGANIC`/`rules`.
**D19.** Cost is **not** a design constraint (worst realistic six-month model bill under $50). Do not build cost-saving complexity, and never reuse a generated body across recipients or senders — reuse *is* the repetition decision 3 forbids. `ModelCall` exists for **latency and cache-health**, not spend.
**D20. Contested (54% vs 11.7% stage-1 filter).** Both were measured on different samples; the planning figure is the **fresh-post pass rate, 74-77%**. Instrument it per channel, fix the CLAUDE.md number, and make the vocabulary a rolling 90-day window so `RARE_AT_OR_BELOW` stops getting stricter as the corpus grows.
**D21.** Delivery leaves the slot into a paced dispatcher; sends stay **strictly serial fleet-wide** (clipboard, memory, and co-timing on one IP). `sendNow` enqueues into it.
**D22.** No `/history` page (the DASHBOARD survey wanted one) — the Sent tab plus detail timelines cover it, and raw data belongs in Prisma Studio.
**D23.** No bulk approve; `a` is armed only on an expanded row. Bulk reject is allowed because it fails safe.
**D24.** `maxUnansweredTouches` exists at **both** scopes. Lifting it to the target alone would cap the whole system at 3 messages/recipient/lifetime.
**D25.** `MAX_TOTAL_SENDS` keeps counting `IN_FLIGHT_STATUSES` (decision 6) and stays `unlimited`; the code default changes from 1 to `null` **only** once `SEND_ENABLED` exists, because at 65 senders any finite ceiling below the resting draft count is consumed by drafts and nothing ever sends.
**D26.** `MessageVariant` stays per-sender for now (Phase 8 demotes it to a fallback), rather than being refactored into a shared library — a 1,170-row duplication that generation makes irrelevant is not worth a migration.

---

## RISKS

**R1. 63 additional senders on one machine and one residential IP is the largest unmitigated risk in this plan, and the arithmetic argues against it.** Fleet output is bounded by recipients × per-recipient cap, not by sender count: at 14 sends/day, 8 senders = 1.75/day/account (8.8% of the safe band), 65 = 0.22 (1.1%). Going 8 → 65 divides an already-negligible per-account number by 8 while multiplying device-correlated accounts by 8, adding 57 hand logins from one IP, and enrolling 57 revenue pages with zero current cold-DM exposure into a single blast radius alongside the three that matter. **Recommendation: stop at 10-15 sending accounts and keep the other 50 clean.** This contradicts decision 2 and is stated for Tabish to overrule, not worked around. Note the plan is not blocked either way: logins are calendar-limited to ~21 days at 3/day and the ladder reaches 12 in 8 weeks regardless.

**R2. Decision 3's safety arithmetic uses the wrong denominator, by 63×.** \"0.27 messages/day per sender — trivially safe\" is correct per account and irrelevant to an IP/device-clustered fleet. What an IP-level model sees is **~14 cold DMs/day from one device on one IP operating 65 business accounts**. That is inside the practitioner band cited for a *single* aged account, so it is defensible — but it must be reasoned about as a per-IP figure, and the rationale as written understates it.

**R3. Rotation with `maxDistinctSenders ≥ 2` is functionally per-sender-throttle evasion.** Instagram throttles a second request from the same sender to a non-follower; a second sender opens a new request row that **does** deliver. That signal — N co-owned accounts, one device, one IP, one persona name and phone, contacting the same non-follower in sequence after the previous one went unanswered — sits in the coordinated-inauthentic-behaviour class, which is applied to clusters and has no per-account appeal. D3's default of 1 removes it. **Setting the cap above 1 is a deliberate acceptance of this, not an oversight.**

**R4. The shared persona is the single most dangerous live item and must be fixed before sender #5.** All senders emit `Kapil Jain / Co-founder / Bollywood Society / +91 60000 189766 / kapil@digitalsukoon.com` — **and the phone has 11 digits after +91, so it is unreachable.** A recipient who opens three of our requests sees the same human name and the same wrong number from three different pages: recipient-visible proof of a ring, aimed at the people most likely to report. `checkPersonaDistinct` already blocks 100% of brand outreach for all four accounts, and `addSender` copies the persona, so importing 61 senders produces 61 identical fingerprints and a fleet that cannot send a single brand pitch **while looking like a successful import**. The pressure will be to relax that gate; the correct direction is to **extend it to CHANNEL**. CLAUDE.md 3b forbids generating personas. **This is a business answer, and it blocks Phase 8's brand half and Phase 9 entirely.**

**R5. Unquantified: classifier per-call latency.** Nothing measures it. At 61 channels × 40 new posts/slot × 0.88 pass rate = 2,155 sequential calls, and 30 min ÷ 2,155 = **835 ms** — *any* per-call latency above 0.84 s puts classification alone over the lock-steal threshold. Log it in Phase 1 before planning around any slot budget.

**R6. Unquantified: cache TTL in steady state.** All 47 recorded classifier calls came from four bulk batches; the 86% hit rate describes a backfill, the most cache-favourable workload possible. One 14-hour gap did hit, n=1. Read the first call of each slot separately from the rest.

**R7. Unquantified: whether per-account behavioural variation helps.** It is inference. Every session's entire authenticated history today is \"log in, send exactly one cold DM to a stranger, close\" — one action type, one action per session, identical scroll RNG ranges across all accounts, and reply checks that look like aborted sends. That is a per-account discriminator no fleet-level pacing fixes, and it is the reason a small fleet is safer.

**R8. Partial unique indexes are one `prisma migrate dev` / `db push` from silently vanishing**, taking the entire atomicity argument with them while every check still passes. Mitigated only by the startup `schemaGuard` and the `sqlite_master` DDL test. **Do not skip them.**

**R9. Disk exhaustion has a device-identity payload.** 65 × 604 MB against 26 GiB free. Chrome writing into a full disk can corrupt `Default/Cookies`, destroying `mid`/`datr`/`ig_did` — after which the next login on a revenue account looks like new hardware, the exact state the design avoids. The temptation to \"clean out the ones that aren't connected yet\" is the failure mode; prune caches, never directories.

**R10. `~/.ds-sales-agent` becomes a 6-39 GB credential store holding up to 65 live sessions, encrypted under a public constant key.** Same fact as today at 16× the consequence. No cloud sync, no backups, no screen shares.

**R11. Nothing in this plan staffs reply handling.** At 98 messages/week and a 2-5% reply rate that is 2-5 human conversations/week, each of which permanently halts a recipient until someone acts, and it is the only revenue-producing path in the system. Steady-state operator load is **3-6 hours/week, forever**, plus ~11 hours of one-off logins. The dashboard makes this findable; it does not reduce it.

**R12. The 2-4 week soak on a throwaway account, recommended and never done, is now 63× larger.** Only `@tabishmukaddam1` has ever sent, and it is the only account with a session at all. The cohort ladder is the minimum honest version: 3 accounts, 14 days, clean numbers, then 5.

**R13. Detection at 60 channels puts ~960 anonymous feed requests/day on the IP that hosts every authenticated session.** Decision 4's \"the only exposure is IP rate limiting\" is true at 4 sessions and stops being true at 65. `watchEnabled` defaulting false is the valve; the Linode plan's case gets stronger, and \"sending may not move\" gets much stronger with it (a move would break 65 device+IP continuities at once).

**R14. Generated bodies replace 18 hand-reviewed texts with model output.** N15, the 2-attempt cap, and \"ungraduated senders never send generated bodies unattended\" are the mitigations. The unbounded-cost path is retry-until-pass against a deterministically-failing check — B1 and B5 fail identically every time, and B5 fails for **all four accounts today**.

**R15. Rotation improves our metrics and worsens the recipient's experience, by the same mechanism.** Under any ring every pair reads `touchNumber: 1`, every cooldown reads green, `NO_NEW_MATERIAL` never evaluates, and **the one number describing the recipient's experience — distinct senders that have ever contacted them — is computed nowhere in the codebase today.** Phase 2's per-recipient scoping and the exposure report are the fix; without them, Phase 3 is a spam machine that passes every check.

---

## OPEN QUESTIONS

**OQ-1.** `maxDistinctSenders` per recipient: **1** (one of our pages owns each conversation for life — recommended, and it is what the ban review argues for) or **2-3** (follow-ups rotate)? One number.
**OQ-2.** Do you accept that \"adding is never the same act as sending\" moves from a per-pair chip to a per-category switch plus a per-member enable, both defaulting off, with the switch naming the exact count it authorises? Yes/no.
**OQ-3.** Who fronts each sending page? Either a real name/role/phone/email per page, or \"the persona identifies the page, so only the page name and contact differ\". Nothing in Phase 8's brand half or Phase 9 can ship until this is answered, and it must not be invented.
**OQ-4.** Sending-fleet ceiling: 10-15 accounts, or all 65? If 65, say so explicitly — R1/R2/R3 are then accepted risks.
**OQ-5.** New conversations per day, fleet-wide (currently 2, brands only): what number? 200 imported targets at 2/day is 100 days; at 8/day, 25 days.
**OQ-6.** Should surplus paid posts actually be banked as future material? If yes, `HOOK_MAX_AGE_HOURS` must rise above 72 — which is a judgement about how stale \"I saw your post\" may read, not a code question.
**OQ-7.** Send window: 10:00-21:30 IST, Sunday ≤30%, nothing 22:00-09:00 — acceptable, or does it need to match how your team actually works?

---

## DEFERRED

- **Postgres and the Linode split.** Nothing measured needs a different engine; WAL buys 9-15× for four lines. Revisit only for the host split, where it genuinely is a prerequisite (`process.kill(pid,0)` liveness is wrong in both directions across two hosts). Rehearse against a scratch DB; do not convert the JSON-string columns in the same change.
- **Senders 16-65.** See R1/OQ-4.
- **Sharing machine identity across accounts** (Instagram's own switcher, one `mid`, several pages) instead of minting 65 machine identities from one machine. It is the honest expression of the \"one team, one office, many pages\" narrative and it directly reverses `profile.ts:30-31`. Not deferred because it is wrong — deferred because it needs Tabish's explicit yes and is moot at a fleet of 10-15.
- **Per-account behavioural variation** in `sendDm.ts`. Worth doing once >8 accounts actually send, so it can be evaluated against something.
- **`ig:drafts` Tests 2/3/4.** Test 1 and Test 5 are enough to ship; the rest measures a corpus that does not exist yet.
- **`MessageVariant` as a shared library.** Generation makes the 1,170-row duplication irrelevant.
- **Archiving/partitioning `DetectedCampaign`.** 406 MiB, indexed, sub-ms. The rolling vocabulary window removes the only reason to keep old rows hot.
- **WAL checkpoint tuning.** Measure after Phase 0 — the WAL read *median* got worse in one measurement after 68,888 appended rows. Real, second-order, and a checkpoint must not run inside a send.
- **Multi-category targets.** `uq_tcm_target` enforces one ring per recipient because \"whose turn\" must have one answer. It is a `DROP INDEX` later, not a table rebuild.
- **Anything pretty.** Phase 4 and 7 deliver correct, plain pages."
  },
  "workflowProgress": [
    {
      "type": "workflow_phase",
      "index": 1,
      "title": "Survey"
    },
    {
      "type": "workflow_phase",
      "index": 2,
      "title": "Design"
    },
    {
      "type": "workflow_phase",
      "index": 3,
      "title": "Attack"
    },
    {
      "type": "workflow_phase",
      "index": 4,
      "title": "Synthesize"
    },
    {
      "type": "workflow_agent",
      "index": 1,
      "label": "survey:schema",
      "phaseIndex": 1,
      "phaseTitle": "Survey",
      "agentId": "aa4eac50e5a5cb6dd",
      "model": "claude-opus-5[1m]",
      "state": "done",
      "startedAt": 1785828618290,
      "queuedAt": 1785828618286,
      "attempt": 1,
      "lastToolName": "Bash",
      "lastToolSummary": "cd \"/Users/tabish/Desktop/AI Sales Agent\" && python3 -c \" i…",
      "promptPreview": "You are designing a change to the DS AI Sales Agent, an Instagram outreach system at \"/Users/tabish/Desktop/AI Sales Agent\".

READ THESE FIRST, they are the authority and they are long but load-bearing:
  - /Users/tabish/Desktop/AI Sales Agent/CLAUDE.md  (project rules; the Gotchas section records real failures)
  - /Users/tabish/Desktop/AI Sales Agent/docs/HANDOFF.md  (current state)

THE ONE RUL…",
      "lastProgressAt": 1785829373066,
      "tokens": 176307,
      "toolCalls": 32,
      "durationMs": 754775,
      "resultPreview": "## A. Verified state (measured 2026-08-04 against `prisma/dev.db`)

`SenderAccount 4 · TargetAccount 9 (5 CHANNEL, 4 BRAND) · OutreachPair 31 (6 enabled) · OutreachAttempt 39 (SENT 6, REPLIED 1, READY 3, SKIPPED 29) · MessageVariant 72 (18/sender: 12 CHANNEL + 6 BRAND) · DetectedCampaign 970 · BrandLookup 34 · Setting 3 · db 1.18 MB · journal_mode=delete · PRAGMA foreign_keys=1 on the Prisma adapt…"
    },
    {
      "type": "workflow_agent",
      "index": 2,
      "label": "survey:planner",
      "phaseIndex": 1,
      "phaseTitle": "Survey",
      "agentId": "a052f3cb82a818440",
      "model": "claude-opus-5[1m]",
      "state": "done",
      "startedAt": 1785828618298,
      "queuedAt": 1785828618286,
      "attempt": 1,
      "lastToolName": "Bash",
      "lastToolSummary": "cd \"/Users/tabish/Desktop/AI Sales Agent\" && git status --s…",
      "promptPreview": "You are designing a change to the DS AI Sales Agent, an Instagram outreach system at \"/Users/tabish/Desktop/AI Sales Agent\".

READ THESE FIRST, they are the authority and they are long but load-bearing:
  - /Users/tabish/Desktop/AI Sales Agent/CLAUDE.md  (project rules; the Gotchas section records real failures)
  - /Users/tabish/Desktop/AI Sales Agent/docs/HANDOFF.md  (current state)

THE ONE RUL…",
      "lastProgressAt": 1785829487283,
      "tokens": 182391,
      "toolCalls": 40,
      "durationMs": 868985,
      "resultPreview": "# DECISION LAYER — findings for categories + rotation at 65 senders

Files read in full: `src/outreach/governor.ts`, `gate.ts`, `brandGuards.ts`, `plan.ts`, `deliver.ts`, `src/lib/settings.ts`, `src/worker/runSlot.ts`. Supporting: `onDemand.ts`, `constants.ts`, `env.ts`, `cutoff.ts`, `browser/profile.ts`, `replyCheck.ts`, `app/actions.ts` (addSender/sendNow), `prisma/schema.prisma`.

Measurements …"
    },
    {
      "type": "workflow_agent",
      "index": 3,
      "label": "survey:fleet",
      "phaseIndex": 1,
      "phaseTitle": "Survey",
      "agentId": "a80898146e3366495",
      "model": "claude-opus-5[1m]",
      "state": "done",
      "startedAt": 1785828618299,
      "queuedAt": 1785828618286,
      "attempt": 1,
      "lastToolName": "Bash",
      "lastToolSummary": "cp ~/.ds-sales-agent/chrome-profiles/tabishmukaddam1/Defaul…",
      "promptPreview": "You are designing a change to the DS AI Sales Agent, an Instagram outreach system at \"/Users/tabish/Desktop/AI Sales Agent\".

READ THESE FIRST, they are the authority and they are long but load-bearing:
  - /Users/tabish/Desktop/AI Sales Agent/CLAUDE.md  (project rules; the Gotchas section records real failures)
  - /Users/tabish/Desktop/AI Sales Agent/docs/HANDOFF.md  (current state)

THE ONE RUL…",
      "lastProgressAt": 1785829341307,
      "tokens": 141555,
      "toolCalls": 37,
      "durationMs": 723008,
      "resultPreview": "## A. What 65 profiles costs — measured on this machine

**Machine (measured):** Apple M2, 8 cores, 16.0 GB RAM, **32 GB free on `/`** (`df -h ~` → 228Gi size / 166Gi used / 32Gi avail), `ulimit -n` 1048576, `ulimit -u` 2666, Chrome 151.0.7922.72.

### Disk

| what | measured | re-measure with |
|---|---|---|
| `~/.ds-sales-agent` today (2 profiles) | **695 MB** | `du -sh ~/.ds-sales-agent` |
| `b…"
    },
    {
      "type": "workflow_agent",
      "index": 4,
      "label": "survey:dashboard",
      "phaseIndex": 1,
      "phaseTitle": "Survey",
      "agentId": "a309f5a571e893c52",
      "model": "claude-opus-5[1m]",
      "state": "done",
      "startedAt": 1785828618299,
      "queuedAt": 1785828618286,
      "attempt": 1,
      "lastToolName": "Bash",
      "lastToolSummary": "cd \"/Users/tabish/Desktop/AI Sales Agent\" && grep -n \"async…",
      "promptPreview": "You are designing a change to the DS AI Sales Agent, an Instagram outreach system at \"/Users/tabish/Desktop/AI Sales Agent\".

READ THESE FIRST, they are the authority and they are long but load-bearing:
  - /Users/tabish/Desktop/AI Sales Agent/CLAUDE.md  (project rules; the Gotchas section records real failures)
  - /Users/tabish/Desktop/AI Sales Agent/docs/HANDOFF.md  (current state)

THE ONE RUL…",
      "lastProgressAt": 1785829238956,
      "tokens": 181318,
      "toolCalls": 39,
      "durationMs": 620657,
      "resultPreview": "## 1. INVENTORY — everything currently on screen

Single route `/` (`src/app/page.tsx`, 156 lines) renders 9 sections in a fixed order. `layout.tsx:12` states the doctrine to be reversed: *\"No navigation, because there is only one page.\"*

| # | Surface | file:line | Verdict | Note at 65 senders / ~260 targets |
|---|---|---|---|---|
| 1 | Status dot + headline | `page.tsx:44-48`, built `view-mode…"
    },
    {
      "type": "workflow_agent",
      "index": 5,
      "label": "survey:generation",
      "phaseIndex": 1,
      "phaseTitle": "Survey",
      "agentId": "a7ba2a14dea48a80b",
      "model": "claude-opus-5[1m]",
      "state": "done",
      "startedAt": 1785828618299,
      "queuedAt": 1785828618287,
      "attempt": 1,
      "lastToolName": "Bash",
      "lastToolSummary": "cd \"/Users/tabish/Desktop/AI Sales Agent\" && grep -n \"expor…",
      "promptPreview": "You are designing a change to the DS AI Sales Agent, an Instagram outreach system at \"/Users/tabish/Desktop/AI Sales Agent\".

READ THESE FIRST, they are the authority and they are long but load-bearing:
  - /Users/tabish/Desktop/AI Sales Agent/CLAUDE.md  (project rules; the Gotchas section records real failures)
  - /Users/tabish/Desktop/AI Sales Agent/docs/HANDOFF.md  (current state)

THE ONE RUL…",
      "lastProgressAt": 1785829221275,
      "tokens": 140515,
      "toolCalls": 31,
      "durationMs": 602976,
      "resultPreview": "## 1. DeepSeek integration as it exists today

**Call site** `src/detection/detectors/semantic.ts:136-197` (`classifyCaption`), reached from `semanticDetector.classify` (`:245-306`), reached from `pipeline.ts:114` (`await detector.classify(post)`, strictly sequential) and from `scripts/classify.ts:156` and `scripts/accuracy.ts:38`.

| thing | value | cite |
|---|---|---|
| model | `deepseek-v4-fla…"
    },
    {
      "type": "workflow_agent",
      "index": 6,
      "label": "design:rotation",
      "phaseIndex": 2,
      "phaseTitle": "Design",
      "agentId": "a5988a0df12c1645f",
      "model": "claude-opus-5[1m]",
      "state": "done",
      "startedAt": 1785829487294,
      "queuedAt": 1785829487290,
      "attempt": 1,
      "lastToolName": "Bash",
      "lastToolSummary": "cd \"/Users/tabish/Desktop/AI Sales Agent\" && S=\"/private/tm…",
      "promptPreview": "You are designing a change to the DS AI Sales Agent, an Instagram outreach system at \"/Users/tabish/Desktop/AI Sales Agent\".

READ THESE FIRST, they are the authority and they are long but load-bearing:
  - /Users/tabish/Desktop/AI Sales Agent/CLAUDE.md  (project rules; the Gotchas section records real failures)
  - /Users/tabish/Desktop/AI Sales Agent/docs/HANDOFF.md  (current state)

THE ONE RUL…",
      "lastProgressAt": 1785830214814,
      "tokens": 205514,
      "toolCalls": 22,
      "durationMs": 727519,
      "resultPreview": "# SENDER ROTATION — precise design

## 0. Decision summary

| question | answer |
|---|---|
| where does rotation state live | **nowhere.** Derived from `OutreachAttempt` history. No cursor column, no cursor table. Argument in §2 — it is not merely possible, it is the only form that survives runtime membership edits. |
| what is the ring | `SenderCategoryMember` rows for the target's category, ord…"
    },
    {
      "type": "workflow_agent",
      "index": 7,
      "label": "design:safety",
      "phaseIndex": 2,
      "phaseTitle": "Design",
      "agentId": "a49ae4c1004204a25",
      "model": "claude-opus-5[1m]",
      "state": "done",
      "startedAt": 1785829487296,
      "queuedAt": 1785829487290,
      "attempt": 1,
      "lastToolName": "Bash",
      "lastToolSummary": "cd \"/Users/tabish/Desktop/AI Sales Agent\" && cat src/lib/cu…",
      "promptPreview": "You are designing a change to the DS AI Sales Agent, an Instagram outreach system at \"/Users/tabish/Desktop/AI Sales Agent\".

READ THESE FIRST, they are the authority and they are long but load-bearing:
  - /Users/tabish/Desktop/AI Sales Agent/CLAUDE.md  (project rules; the Gotchas section records real failures)
  - /Users/tabish/Desktop/AI Sales Agent/docs/HANDOFF.md  (current state)

THE ONE RUL…",
      "lastProgressAt": 1785830137937,
      "tokens": 212839,
      "toolCalls": 23,
      "durationMs": 650641,
      "resultPreview": "# SAFETY MODEL — 65-account fleet, no per-sender cap

Everything marked **[M]** was measured on this machine/DB today; **[I]** is inference or design judgement; **[R]** is repo-documented research I did not independently re-verify.

---

## 0. Measured baseline (and how to re-check it)

| fact | value | check |
|---|---|---|
Senders / targets / pairs / enabled pairs | 4 / 9 / 31 / **6** | `sqlite3…"
    },
    {
      "type": "workflow_agent",
      "index": 8,
      "label": "design:generation",
      "phaseIndex": 2,
      "phaseTitle": "Design",
      "agentId": "a7eee942a8c9cb69b",
      "model": "claude-opus-5[1m]",
      "state": "done",
      "startedAt": 1785829487297,
      "queuedAt": 1785829487291,
      "attempt": 1,
      "lastToolName": "Bash",
      "lastToolSummary": "cd \"/Users/tabish/Desktop/AI Sales Agent\" && git status --p…",
      "promptPreview": "You are designing a change to the DS AI Sales Agent, an Instagram outreach system at \"/Users/tabish/Desktop/AI Sales Agent\".

READ THESE FIRST, they are the authority and they are long but load-bearing:
  - /Users/tabish/Desktop/AI Sales Agent/CLAUDE.md  (project rules; the Gotchas section records real failures)
  - /Users/tabish/Desktop/AI Sales Agent/docs/HANDOFF.md  (current state)

THE ONE RUL…",
      "lastProgressAt": 1785830478303,
      "tokens": 211168,
      "toolCalls": 25,
      "durationMs": 991006,
      "resultPreview": "# GENERATED MESSAGES — END-TO-END DESIGN

Read against: `CLAUDE.md`, `docs/HANDOFF.md`, and the code cited. Every number below is measured on `prisma/dev.db` (2026-08-04) or by running the repo's own functions; the check command is given each time.

---

## 0. Files, and the one integration point

| new file | contents | purity |
|---|---|---|
| `src/outreach/compose.ts` | `COMPOSER_SYSTEM_PROMPT`…"
    },
    {
      "type": "workflow_agent",
      "index": 9,
      "label": "design:ux",
      "phaseIndex": 2,
      "phaseTitle": "Design",
      "agentId": "ac8243d46105df03a",
      "model": "claude-opus-5[1m]",
      "state": "done",
      "startedAt": 1785829487297,
      "queuedAt": 1785829487291,
      "attempt": 1,
      "lastToolName": "Bash",
      "lastToolSummary": "cd \"/Users/tabish/Desktop/AI Sales Agent\" && git status --p…",
      "promptPreview": "You are designing a change to the DS AI Sales Agent, an Instagram outreach system at \"/Users/tabish/Desktop/AI Sales Agent\".

READ THESE FIRST, they are the authority and they are long but load-bearing:
  - /Users/tabish/Desktop/AI Sales Agent/CLAUDE.md  (project rules; the Gotchas section records real failures)
  - /Users/tabish/Desktop/AI Sales Agent/docs/HANDOFF.md  (current state)

THE ONE RUL…",
      "lastProgressAt": 1785830141666,
      "tokens": 212326,
      "toolCalls": 32,
      "durationMs": 654369,
      "resultPreview": "## 0. THE PAGE SET — 6 nav items, 4 sub-routes

| route | one job | the single most important thing on it | owns these controls | deliberately absent |
|---|---|---|---|---|
| `/` **Today** | what needs a human in the next hour | the four-answer status strip (§2) | Check now, sign out | fleet list, channel list, personas, autopilot *toggle*, on-demand send, activity feed, any `.map().join()` of ha…"
    },
    {
      "type": "workflow_agent",
      "index": 10,
      "label": "attack:bans",
      "phaseIndex": 3,
      "phaseTitle": "Attack",
      "agentId": "aaead3905eec76e1f",
      "model": "claude-opus-5[1m]",
      "state": "done",
      "startedAt": 1785830478319,
      "queuedAt": 1785830478309,
      "attempt": 1,
      "lastToolName": "Bash",
      "lastToolSummary": "cd \"/Users/tabish/Desktop/AI Sales Agent\" && sed -n '1,40p'…",
      "promptPreview": "You are designing a change to the DS AI Sales Agent, an Instagram outreach system at \"/Users/tabish/Desktop/AI Sales Agent\".

READ THESE FIRST, they are the authority and they are long but load-bearing:
  - /Users/tabish/Desktop/AI Sales Agent/CLAUDE.md  (project rules; the Gotchas section records real failures)
  - /Users/tabish/Desktop/AI Sales Agent/docs/HANDOFF.md  (current state)

THE ONE RUL…",
      "lastProgressAt": 1785831238012,
      "tokens": 201683,
      "toolCalls": 17,
      "durationMs": 759692,
      "resultPreview": "# ADVERSARIAL REVIEW — how this design gets the accounts banned

**Verdict.** Two parts of this design must not ship in the proposed form: **(1) sender rotation per recipient**, which is functionally an Instagram-rate-limit evasion mechanism and moves the enforcement class from \"restrict one account\" to \"act on the cluster\"; and **(2) 63 additional senders / 63 additional Chrome profiles on this m…"
    },
    {
      "type": "workflow_agent",
      "index": 11,
      "label": "attack:silent",
      "phaseIndex": 3,
      "phaseTitle": "Attack",
      "agentId": "a0e18a017589136bc",
      "model": "claude-opus-5[1m]",
      "state": "done",
      "startedAt": 1785830478322,
      "queuedAt": 1785830478310,
      "attempt": 1,
      "lastToolName": "Bash",
      "lastToolSummary": "cd \"/Users/tabish/Desktop/AI Sales Agent\" && cat src/script…",
      "promptPreview": "You are designing a change to the DS AI Sales Agent, an Instagram outreach system at \"/Users/tabish/Desktop/AI Sales Agent\".

READ THESE FIRST, they are the authority and they are long but load-bearing:
  - /Users/tabish/Desktop/AI Sales Agent/CLAUDE.md  (project rules; the Gotchas section records real failures)
  - /Users/tabish/Desktop/AI Sales Agent/docs/HANDOFF.md  (current state)

THE ONE RUL…",
      "lastProgressAt": 1785831128059,
      "tokens": 269842,
      "toolCalls": 34,
      "durationMs": 649737,
      "resultPreview": "## VERDICT SUMMARY

| shape | reintroduced? | worst instance |
|---|---|---|
| guard read many / written none | **YES, 4×** | `SenderCategoryMember.enabled` (no named writer), `qualityGateAt` (unfalsifiable by construction), `RecipientDaySlot` release (5 write sites), N1/N2/N4 columns |
| \"could not determine\" → \"X is false\" | **YES, 3×** | `hasSessionCookie` catch-all `false` → UX renders \"sessio…"
    },
    {
      "type": "workflow_agent",
      "index": 12,
      "label": "attack:scale",
      "phaseIndex": 3,
      "phaseTitle": "Attack",
      "agentId": "aa470bbec835249f4",
      "model": "claude-opus-5[1m]",
      "state": "done",
      "startedAt": 1785830478322,
      "queuedAt": 1785830478310,
      "attempt": 1,
      "lastToolName": "Bash",
      "lastToolSummary": "cd \"/Users/tabish/Desktop/AI Sales Agent\" && git status --s…",
      "promptPreview": "You are designing a change to the DS AI Sales Agent, an Instagram outreach system at \"/Users/tabish/Desktop/AI Sales Agent\".

READ THESE FIRST, they are the authority and they are long but load-bearing:
  - /Users/tabish/Desktop/AI Sales Agent/CLAUDE.md  (project rules; the Gotchas section records real failures)
  - /Users/tabish/Desktop/AI Sales Agent/docs/HANDOFF.md  (current state)

THE ONE RUL…",
      "lastProgressAt": 1785832746937,
      "tokens": 255892,
      "toolCalls": 80,
      "durationMs": 2268615,
      "resultPreview": "# ADVERSARIAL REVIEW — SCALE & COST, SIX-MONTH HORIZON

All `[M]` numbers measured on this machine today (2026‑08‑04). Reproduction artifact: `/tmp/six.db` (523 MB, 725,650 `DetectedCampaign`, 17,290 `OutreachPair`, 65 senders, 266 targets — a literal six‑month projection at 61 channels × 66 posts/day × 180 days). Run anything against it with `DATABASE_URL=\"file:/tmp/six.db\"`.

---

## 0. THE HEAD…"
    },
    {
      "type": "workflow_agent",
      "index": 13,
      "label": "synthesize:plan",
      "phaseIndex": 4,
      "phaseTitle": "Synthesize",
      "agentId": "afd1c2653d6cbba97",
      "model": "claude-opus-5[1m]",
      "state": "done",
      "startedAt": 1785832746948,
      "queuedAt": 1785832746946,
      "attempt": 1,
      "lastToolName": "Bash",
      "lastToolSummary": "cd \"/Users/tabish/Desktop/AI Sales Agent\" && echo \"=== enfo…",
      "promptPreview": "You are designing a change to the DS AI Sales Agent, an Instagram outreach system at \"/Users/tabish/Desktop/AI Sales Agent\".

READ THESE FIRST, they are the authority and they are long but load-bearing:
  - /Users/tabish/Desktop/AI Sales Agent/CLAUDE.md  (project rules; the Gotchas section records real failures)
  - /Users/tabish/Desktop/AI Sales Agent/docs/HANDOFF.md  (current state)

THE ONE RUL…",
      "lastProgressAt": 1785833267285,
      "tokens": 253422,
      "toolCalls": 2,
      "durationMs": 520337,
      "resultPreview": "# SPEC — Categories, Rotation, Fleet, Generated Messages, Dashboard
**File:** `docs/specs/2026-08-04-scale-plan.md`
**Status:** proposed. Nothing below ships without the DECISIONS and OPEN QUESTIONS sections being read.
**Verified against:** live `prisma/dev.db` 2026-08-04 (`journal_mode=delete`, `synchronous=2`, `sqlite_stat1` absent, `OutreachPair` has no `targetId` index, `OutreachAttempt.varia…"
    }
  ],
  "totalTokens": 2644772,
  "totalToolCalls": 414
}