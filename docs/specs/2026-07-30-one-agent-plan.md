# One Agent — Plan to Close the Loop

**Date:** 2026-07-30
**Goal:** The system detects a paid campaign and sends the DM itself. No human in the path.
Plus: the dashboard becomes a CEO view — and only that.

---

## 1. Where we actually are

Four of six links work and are verified against live data. Two do not exist.

| Link | State |
|---|---|
| Watch both channels, 4×/day, forever | **Working.** Ran live: 24 posts read |
| Detect paid campaigns | **Working.** 4/4 correct on MOM, right brand each |
| Decide who to message and when | **Working.** Governor, 112 tests |
| Compose the message | **Working.** Verified end to end |
| **Deliver the DM** | **Written but never executed.** No session has ever existed |
| **Notice a reply** | **Does not exist.** A human clicks a button |

The gap is exactly the two things a person is doing that an agent-with-a-browser wouldn't
need to: carrying the message *into* Instagram, and carrying a reply *back out*.

## 2. The target: one loop, four steps

```
Every slot — 11:00 / 15:00 / 17:00 / 20:00 IST, daily, forever:

  1. READ    both channels          → detect paid campaigns
  2. LISTEN  our DM inbox           → any target replied? halt them
  3. DECIDE  governor               → who is eligible right now
  4. SEND    logged-in browser      → deliver the DM, confirm it landed
```

Steps 1 and 3 are done. Steps 2 and 4 are this plan.

Nothing about the architecture changes. `OutreachSender` already has two
implementations behind one interface; `autoSendEnabled` is already a per-sender boolean.
The wiring is inert, not absent.

---

## 3. What blocks everything: one login, and it has to be you

`PlaywrightSender` has never run. Instagram's DM interface is unreachable logged out, so
its selectors were written from documented structure and have zero empirical validation.

I cannot validate them without a logged-in session, and I cannot create one — by design.
`pnpm session:add --sender=<handle>` opens a real browser window on your machine, you log
in yourself, and only the resulting cookies are saved. No password passes through this
code, which is why it needs your hands on the keyboard once per account.

**Everything below is blocked on that one action.** Roughly five minutes per account.

---

## Phase A — Make the send real

### A0. Instrument first, so validation takes one attempt (no session needed — I can do this now)

The first live run will either work or fail on a selector. Right now a failure returns a
one-line error, which would cost several round-trips to diagnose. Before touching a real
session, make the sender produce a full diagnostic on failure:

- Screenshot at the point of failure
- HTML snapshot of the relevant region
- Every candidate selector tried, and what each matched (0, 1, or many)
- The visible text of all buttons found on the profile

Cheap to build, and turns selector validation from a guessing loop into a single pass.

### A1. Capture a session *(yours — 5 min per account)*

```bash
pnpm session:add --sender=bollywoodsociety
```

### A2. Validate the send path against a live DOM

```bash
pnpm session:check
```

This already opens a real thread and confirms the composer is reachable without sending.
Expect to iterate on selectors here — this is where the unvalidated code meets reality.

### A3. The first real send goes between two accounts you own

Not to a prospect, and no throwaway account needed: have `@bollywoodsociety` send to
`@bollywoodchronicle`. You own both ends.

This validates the entire chain — button, composer, newline handling, Enter, and the
"did it actually leave the composer" confirmation — while proving delivery by simply
looking in the other account's inbox. Zero risk to a prospect relationship.

### A4. Harden delivery confirmation

Current check is "the composer emptied", which is a proxy, not proof. Replace with:
read the last message in the thread back and assert it matches what we sent. If it
doesn't, the attempt is `FAILED`, not silently `SENT`.

**Deliverable:** a real DM, sent by the agent, verified received.

---

## Phase B — Reply detection (without this, it is not autonomous)

Today the governor correctly halts every sender the moment a target replies — but nothing
*detects* the reply. An autonomous loop without this keeps pitching someone who already
answered, on a 7-day drumbeat. That is worse than not messaging at all.

### B1. Read the inbox

New pipeline step, running before outreach planning. Two signals, combined:

- **Unread badge** on the thread in `/direct/inbox/` — strong, cheap
- **Last message author** in the thread itself — confirms it, and catches a reply that was
  already opened on someone's phone

Only two target threads to check, so this is a small, bounded read.

### B2. Auto-halt and surface

A detected reply sets `repliedAt`, which the governor already honours — it halts *every*
sender to that target, not just the one that got the reply. It becomes the top item on the
CEO view, because a reply is the only event in this system that means money.

### B3. Never re-open a halted target automatically

Once halted, only a human un-halts. A conversation with a real person is not something an
automation should decide to resume.

**Note:** these selectors also need live validation. Same session unblocks it.

---

## Phase C — Make it survive running unattended

Correcting something I told you earlier: I said volume risk was negligible — 2 DMs/day
against ~60/day of safe capacity. True, and the wrong reassurance. Low volume protects
against *rate-limit blocks*. It does nothing about *automation fingerprinting*, which is a
separate detection system. These close that gap:

| | Why |
|---|---|
| **Persistent browser profile** per sender (`user-data-dir`) instead of a fresh context each run | Accumulates real cache/IndexedDB/service-worker state. A pristine context every time is itself a tell |
| **Human-shaped session**: land on the feed, scroll briefly, visit the profile, dwell, *then* message | Current path is navigate → click → type → Enter, which no person does |
| **Stealth patches**: `navigator.webdriver`, plugin arrays, CDP traces | Playwright leaves all of these by default. Not currently addressed |
| **Wider, less regular timing** — jitter the slot itself, not only the gap between sends | Per-send jitter doesn't disguise a machine-regular *daily* rhythm |
| **Stable residential/mobile IP** pinned per account | A laptop that sleeps and a datacenter VPS are *both* flags |

Warm-up is calendar time, not code: three accounts going from never cold-DMing to daily
outbound is a signal in itself. Ramp over ~2 weeks.

---

## Phase D — CEO dashboard

Replace six engineering pages with **one page**. Everything currently on screen that a CEO
would not ask about comes off: confidence scores, signal arrays, variant labels, grid
indices, detector keys, parse-failure diagnostics, per-pair cooldown editors.

The raw data stays fully accessible through `pnpm db:studio` for debugging — nothing is
lost, it just stops competing for attention.

### What the page answers, in order

```
┌────────────────────────────────────────────────────────────┐
│ ● Running normally                Next send: today 20:00   │
└────────────────────────────────────────────────────────────┘

  ⚑ 1 REPLY — Mad Over Marketing answered 2 days ago
    → Open conversation

  THIS WEEK
    31 campaigns detected    4 messages sent    1 reply

  ACTIVITY
    Today
      17:00   → Mad Over Marketing    from Bollywood Society
              referencing their Royal Canin campaign
    Yesterday
      20:00   → Viral Bhayani         from Bollywood Chronicle

  CHANNELS WE WATCH
    Mad Over Marketing   1.5M    4 campaigns this week   contacted 2d ago
    Viral Bhayani       15.6M   12 posts logged          contacted 5d ago

  OUR ACCOUNTS
    ● @bollywoodsociety      autopilot on    2 sent this week
    ● @maraboutmarketing     autopilot on    1 sent this week
    ● @bollywoodchronicle    autopilot on    1 sent this week
```

Design rules:
- **One status light.** Green when the last slot ran clean and every account is healthy.
  Red with a plain-English sentence when not — "Instagram locked @bollywoodsociety, log in
  and clear it" — never a stack trace.
- **Replies at the top**, above the metrics. It is the only line that represents revenue.
- **Activity in plain sentences**, not table rows. "Sent to Mad Over Marketing from
  Bollywood Society, referencing their Royal Canin campaign."
- **Three numbers, not twelve.** Detected, sent, replied.
- **No controls that could break it.** No cooldown inputs, no per-pair toggles. Those move
  to a config file or Studio.

---

## Phase E — Staged go-live

Deliberately gradual, because the failure mode is losing an account.

1. **3 days**, autopilot wired but `DRY_RUN=1`. Read what it *would* have sent.
2. **Flip one sender** — `@bollywoodchronicle`, the least load-bearing of the three.
   Watch 3 days.
3. **Flip the rest** if clean.

Kill switches, unchanged: `AUTOPILOT_ENABLED=false` in env stops everything regardless of
per-sender flags; any Instagram checkpoint pauses that sender immediately and never
retries.

---

## Effort

| Phase | Work | Blocked on |
|---|---|---|
| A0 Instrument for diagnosis | ~2h | nothing — can start now |
| A1 Session capture | ~5 min × 3 | **you** |
| A2–A4 Validate + prove the send | ~half a day | A1 |
| B Reply detection | 1–2 days | A1 |
| C Hardening | ~1 day | — |
| D CEO dashboard | ~1 day | nothing — can run in parallel |
| E Staged go-live | ~1 week calendar | A–D |

**≈3–4 engineering days, plus about a week of staged rollout.**

## Residual risk, stated plainly

Cold DMs violate Instagram's terms regardless of how human the automation looks. Phase C
lowers the odds of being flagged; it cannot make this sanctioned. Over a year the
realistic outcomes are: it mostly works with occasional breakage you fix; or a sender picks
up a temporary action block; or, least likely but not negligible, you lose a handle.

That trade is a business call, not a technical one. The technical part — making it actually
work autonomously — is what this plan delivers.

## What I need from you

1. **One login per account** (`pnpm session:add`). Everything in A and B is blocked on it.
2. **Confirmation that the first proof-send goes `@bollywoodsociety` → `@bollywoodchronicle`**
   rather than to a prospect.
3. Nothing else. The plan is otherwise unblocked.
