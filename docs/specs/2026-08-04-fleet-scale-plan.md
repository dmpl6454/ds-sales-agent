# Scaling to a sender fleet: categories, rotation, generated messages, new dashboard

**Written** 2026-08-04. **Status:** proposed, nothing built. Read §1 and §7 before approving.

Produced from a 13-agent design pass (survey → design → adversarial attack → synthesis)
plus my own measurement against the live system. **Every claim below is marked with how it
was established.** Agent findings I could not verify are labelled as such rather than
presented as fact — one of the workflow's highest-priority recommendations turned out to be
wrong in a way that would have reversed a decision Tabish confirmed.

---

## 1. What must be decided or known before anything is built

### 1.1 The volume asymmetry — the fact the whole design turns on

**Measured** against the live database:

| target | posts/day | **paid posts/day** |
|---|---|---|
| `@viralbhayani` | 58 median, 75 peak | **11 median, 14 peak** |
| `@madovermarketing_mom` | ~3 | 1 median, 3 peak |

Across 63 senders each account would send **0.27 messages/day** — against a
practitioner-safe 20–35. Per-account risk is negligible. But 14 messages/day into
`@viralbhayani`'s single inbox, from 14 different Bollywood pages, is the recipient-side
pattern that produces spam reports, and reports are what get accounts banned.

**Rotation solves sender risk and does nothing for recipient risk.** That sentence is the
reason this plan caps per recipient and lets total volume scale with the number of targets.

Tabish decided: **no per-sender cap, no system-wide cap, per-recipient cap stays.**

### 1.2 Live defects that must be fixed before the fleet grows

I verified these myself. They exist today at 4 accounts.

**(a) Both send guards can be tautologies. VERIFIED BY EXECUTION.**

`distinctiveSlice` picks a "needle" from the drafted body; the composer read-back before
Enter and the thread confirmation after Enter both search for it. With a body whose lines
are all short, the needle becomes:

```
"I'm Kapil Jain, Co-founder of Bollywood Society."   (48 chars)
```

I ran it. That needle **also matches a completely different message from the same sender** —
so neither guard can fail, and `messageMatchesOurs` returns true across two unrelated bodies.

CLAUDE.md records this exact bug as fixed *for the greeting*, "with a 20-character minimum".
The persona intro is 48 characters, so it clears the minimum, and it was never excluded. **The
fix was incomplete in precisely the way the original was** — and the previous fix's test used
a single-line body, so it could not have caught this.

**(b) A delivered message can be re-sent. VERIFIED STRUCTURALLY, mechanism is mine.**

Two facts compose:

- I measured `journal_mode = delete` with `busy_timeout = 5000`. Every write takes an
  exclusive whole-database lock, and the dashboard, scheduler and CLI share the file. A write
  can therefore throw `SQLITE_BUSY`.
- `deliver.ts:129` records SENT inside a `$transaction([...])` with other writes. If any
  member throws, the whole transaction rolls back.

So: the DM is delivered → the recording transaction throws `SQLITE_BUSY` → rolls back → the
attempt stays `READY` → **the next slot sends it again.** The recipient gets it twice and our
own records show it as never sent.

`WAL` removes the trigger; taking the variant bump out of the SENT transaction removes the
class. Both are one-line changes and both are prerequisites.

**(c) `'try again later'` is in `ENFORCEMENT_PHRASES`. VERIFIED** at
`src/outreach/browser/session.ts:179`, and it is matched against the whole page twice per
send. That is ordinary Instagram copy. A false positive marks a revenue account `CHALLENGED`
and halts every pair using it — and CLAUDE.md's own note beside this list warns that
`CHALLENGED` for routine events teaches an operator to dismiss the one that matters.

**(d) Two of my own bugs from the last session. VERIFIED.**

`src/outreach/onDemand.ts` is the second caller of logic I changed in `plan.ts` and I updated
only one side:

| | `plan.ts` | `onDemand.ts` |
|---|---|---|
| variant pool | `{ senderId, enabled, targetKind }` (:471) | `{ senderId, enabled }` (:352) — **no `targetKind`** |
| campaign floor | `newMaterialFloor(now)` | `hoursAgo(settings.hookMaxAgeHours)` (:306, :376) |

So on-demand can hand a media-buying body to a publisher, and it offers campaigns the
planner refuses. This is the "one gate, two callers, never re-inline it" shape from CLAUDE.md
— committed by me, one session after documenting it.

**(e) A hung slot is treated as a dead slot. VERIFIED.**

`feed.ts` has retry with exponential backoff but **no request timeout** (`exists.ts` already
uses `AbortSignal.timeout(12_000)`). Worst case per slot is `targets × 6 pages × 4 attempts`
= **216 unbounded requests**. Measured slot durations: healthy runs are 24–81 s; I found
`PARTIAL` runs of 3957 s, 7574 s, 12782 s, 19230 s and **24674 s (6.85 hours)**.

`SLOT_LOCK_STALE_MS` is 30 minutes and its comment reads *"a slot that has not finished in
this long is presumed dead, not running"*. That presumption is false: a slot with no fetch
timeout is **hung but alive**, so a second slot claims the lock and runs concurrently. At 65
accounts driving browsers, two live runs could drive one Chrome profile at once. This is
"freshness is not liveness", already learned once for the scheduler heartbeat.

### 1.3 One workflow recommendation I am rejecting

The synthesis put **"fix the phone number"** as item #1 of Phase 0, on the grounds that
`+91 60000 189766` has 11 digits where Indian mobiles have 10.

**Do not do this.** `src/outreach/render.ts:215` says: *"11 is also accepted because Kapil's
number (+91 60000 189766) was confirmed correct as written — some virtual/business numbers
carry an extra digit."* Confirmed 2026-07-29.

The agent read the digit count and not the comment directly above the check. Acting on it
would have silently reversed a decision the human confirmed — the exact failure the
"decisions that must not be quietly reversed" section exists to prevent, arriving as the
first line of a confident plan. Kept here as a caution about the rest of the plan.

### 1.4 Scale facts, measured

**Chrome profiles.** A lightly-used profile is **91 MB**; the one that has done every send is
**604 MB**. At 65 that trends to ~39 GB against **32 GB free** — the disk fills. But the
composition is:

```
421 MB  Default/Cache        ← disposable
 97 MB  Default/Code Cache   ← disposable
1.6 MB  Default/GPUCache     ← disposable
 20 KB  Default/Cookies      ← mid, ig_did, datr. THE DEVICE IDENTITY.
  7 KB  Local State          ← irreplaceable
```

**86% of a profile is disposable browser cache and the irreplaceable part is 27 KB.** Pruning
the three cache directories with Chrome closed takes 65 profiles to **~5.5 GB**. It must never
touch `Cookies` or `Local State` — that is the device identity the entire send design rests on.

**Storage is not the problem; locking and the planner are.** The database is **1.2 MB** at 970
posts, so ~50 MB/year at 120 posts/day. `OutreachPair` is one row per sender×target: 65×60 =
**3,900 pairs**, and the planner does ~7 awaits per pair per slot = **~27,300 queries per
slot**. **Postgres is not a prerequisite for this work** and stays deferred with the hosting
step. `WAL` plus restructuring the planner covers this scale.

Nothing indexes `OutreachAttempt` by target, which every rotation and per-recipient-cap query
will need.

### 1.5 The 63 channels

All **63/63 exist** (anonymous HTTP 200, 0 missing, 0 unknown). Combined reach 60,488,000.
**61 are new senders.** `@bollywoodchronicle` and `@bollywoodsocietyy` are already senders —
**and also already rehearsal targets**, so those two target rows must be retired or they are
simultaneously sender and recipient with only the never-message-itself rule between them.

> My first validation reported all 10 sampled handles as non-existent. The bug was mine:
> `handleExists` returns a plain string union and I read `r.exists`, always `undefined`, so the
> check **could only ever fail**. Re-run correctly: 63/63. Noted because it is the same
> tautology shape as §1.2(a), produced by me within an hour of writing about it.

---

## 2. Decisions taken

| Question | Decision | Consequence |
|---|---|---|
| The 63 channels | **Senders** — our own network | 61 new accounts, 61 hand logins, fleet 4 → 65 |
| Per-sender cap | **None** | rotation makes it unnecessary: 0.27/day each |
| System-wide cap | **None** | throughput = paid posts detected |
| **Per-recipient cap** | **Stays. Default 1/day** | the one control that protects the inbox |
| Message copy | **Model-generated per post + quality gate** | ~$0.0002/message |
| Targets | **Provided list + discovered brands** | breadth is what makes bulk safe |
| Storage | **SQLite + WAL.** Postgres deferred | measured: size is not the constraint |
| Rotation state | **Derived from send history, not a stored cursor** | a cursor can drift from reality; this codebase has been bitten by exactly that |

---

## 3. Phases

Each is independently shippable and independently abandonable. **Phases 0–2 change nothing
about who receives a message** — Phase 2 only ever refuses more than today. The first
recipient-visible change is Phase 3, and only after a human turns a category on.

### Phase 0 — the live defects (no new behaviour)

Fix §1.2 (a)–(e). One additive migration (`OutreachAttempt.attempts`, `failureCode`).

- `distinctiveSlice`: exclude the persona intro and hook line from the fallback, raise the
  minimum to 40 chars, and make `editAttemptBody` refuse a body the guards cannot verify.
  **Test: the needle must not match a different body from the same sender** — the assertion
  that would have caught both instances.
- `WAL` + `busy_timeout=15000` + `ANALYZE` in `src/lib/db.ts`.
- Variant bump out of every SENT transaction (3 sites).
- Delete `'try again later'`; scope enforcement matching to dialog/alert text.
- `AbortSignal.timeout` on the feed fetch; slot lock refreshes on progress so staleness means
  "stopped progressing" rather than "old".
- `onDemand.ts`: `targetKind` + `newMaterialFloor`.
- Re-read sender status immediately before each dispatch, plus an in-run `challengedThisRun`
  set, so one flagged account cannot be retried inside the same slot.

**Ships safely at 4 accounts. Nothing depends on it, but three of these are already-reachable
double-send paths.**

### Phase 1 — foundations

`OutreachAttempt.targetId`/`senderId` denormalised (rotation and the per-recipient cap both
query by target, and today that requires a join through `pair`), indexes, a `ModelCall` table
so generation cost is observable, and `view-model.ts` split per page.

### Phase 2 — the per-recipient envelope, as a database invariant

The guards rotation needs, expressed so they cannot be bypassed: a per-recipient-per-day
reservation row with a unique key, claimed atomically. **Must precede Phase 3** — rotation
without this is the flooding scenario.

Atomicity is `create`-on-unique-key or `updateMany` with the condition in the `where`, never
read-then-write. That bug has bitten twice here.

### Phase 3 — categories and the derived rotation ring

`Category`, membership for senders and targets, and rotation **derived from
`OutreachAttempt` history** rather than a stored cursor: *who sent the most recent message to
this target, and who comes after them in the category order.*

Pure function, testable both directions, covering: a sender added mid-cycle, removed
mid-cycle, `CHALLENGED`, not logged in, the sender that is also the target, two concurrent
slots, and a failed send.

**The loophole to close explicitly:** `cooldownDays` is **per pair**. With 63 senders rotating,
a target can receive a message every single day while every individual pair stays inside its
7-day cooldown. The per-recipient cap from Phase 2 is what closes it, which is why the order
matters.

### Phase 4 — dashboard: shell, `/accounts`, `/accounts/login`, `/messages`

Separate pages, each with one job. 65 accounts cannot be a flat list — grouped by state with
summary before detail. `/accounts/login` is a queue for working through 61 logins over time.

### Phase 5 — paced dispatcher

Delivery leaves the slot and becomes a paced dispatcher with per-hour and per-day fleet
reservations and a circuit breaker. A slot must not take hours; sends must not cluster.

### Phase 6 — reply detection at scale

Today reply checking is per-target with a browser session each, at two slots. With many
targets that degrades — and it is the hardest guard in the system, so it must not.

### Phase 7 — prospects: import, `/prospects`, `/settings`

CSV/sheet import for target lists, `watchEnabled` so prospects are messaged without being
scraped four times a day.

### Phase 8 — generated messages + quality gate

Constant cacheable system prompt (the 50× cache discount is why it must never be
interpolated into), per-post facts in the user message, and a mechanical gate: no unfilled
placeholders, length bounds, persona intact, greeting correct for company vs person, no
invented claims, **and the body must be verifiable by `distinctiveSlice`** — which is only
meaningful once Phase 0 fixes it.

Failure never degrades silently: no verdict means no send, falling back to a hand-written
variant.

### Phase 9 — fleet onboarding

61 accounts as a **cohort ladder**, not a bulk import: a few accounts, watched, before the
next few. This is the phase that actually changes exposure.

---

## 4. What I would push back on

**Stated plainly rather than laundered.**

1. **65 accounts on one residential IP, messaging overlapping recipients, is a correlation
   surface that does not exist today.** Rotation hides volume from *our* metrics — each
   account looks quiet — while the recipient's inbox and Meta's view of that inbox are
   unchanged. The per-recipient cap is the only thing addressing this, and it is a control we
   chose, not a property of the platform.

2. **The persona problem gets worse, not better, at 65 accounts.** All senders currently share
   *Kapil Jain, Co-founder, Bollywood Society*. 63 pages emitting one contact block is the
   cross-account fingerprint decision 3 exists to prevent. The persona gate blocks brand
   sends; it does not block channel sends. **At fleet scale this should probably gate channel
   sends too** — which would halt outreach that runs today, so it is Tabish's call.

3. **61 hand logins is the real cost of this plan**, and each one writes device identity that
   cannot be rebuilt. The 2–4 week soak on an aged throwaway was recommended and never done at
   4 accounts; at 65 the first send from each new account is still the test.

4. **"No daily limit" is honoured at the sender and system level but not at the recipient
   level.** If the intent was truly uncapped per recipient, this plan does not deliver it and I
   would want that said out loud rather than discovered later.

---

## 5. Deferred

Postgres (measured: not needed at this scale), the Linode/tunnel move, roles on top of open
signup, visual polish on the new dashboard.

---

## 6. Open questions

1. **Per-recipient cap: 1/day or 2/day?** 1 is the safe default and what this plan assumes.
2. **Should the persona gate extend to channel sends at fleet scale?** (§4.2) It would halt
   outreach that currently works.
3. **Order:** ship Phase 0 alone first, or fold it into a longer first push?
4. **The two rehearsal targets** `@bollywoodchronicle` / `@bollywoodsocietyy` — retire them as
   targets now that they go live as senders?

---

## 7. Verification status of everything above

| Claim | How established |
|---|---|
| Paid posts/day per target | **measured** against live DB |
| 63/63 handles exist | **measured**, anonymous HTTP |
| Profile sizes, cache composition | **measured** on disk |
| `journal_mode = delete` | **measured** via pragma |
| Slot durations incl. 6.85 h | **measured** from `ScrapeRun` |
| Send guards can be tautologies | **verified by executing the code** |
| `'try again later'` present | **verified** at session.ts:179 |
| `onDemand` missing `targetKind` / wrong floor | **verified** at onDemand.ts:352, :306, :376 |
| SENT-transaction rollback path | **verified structurally**; the `SQLITE_BUSY` trigger is measured |
| Phone number is wrong | **agent claim, REJECTED** — contradicts a confirmed decision |
| Everything else in the 13-agent output | **not independently verified.** Treat as a lead |
