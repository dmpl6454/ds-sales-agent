# DS AI Sales Agent — Phase 1

A standing watch on two Instagram publisher channels. When either posts paid/branded
content, it prepares a partnership pitch DM from a designated owned account, governed so
it can run indefinitely without tripping spam controls.

**Zero external services. Zero API keys. Runs on localhost.**

```bash
pnpm install
cp .env.example .env
pnpm db:migrate      # creates prisma/dev.db
pnpm db:seed         # 3 senders, 2 targets, 4 routing pairs, 36 message variants
npx playwright install chromium

pnpm dev             # dashboard → http://localhost:3000
pnpm worker          # the 11:00 / 15:00 / 17:00 / 20:00 IST watch
```

`DRY_RUN=1` is the default. The pipeline runs end to end and sends nothing.

## The loop

```
Every slot — 11:00 / 15:00 / 17:00 / 20:00 IST, daily:

  1. READ    both channels     → detect paid campaigns
  2. LISTEN  our DM threads    → did a target reply? halt every sender to them
  3. DECIDE  cadence governor  → who is eligible right now
  4. SEND    logged-in browser → deliver, then confirm by reading it back
```

Reply detection runs *before* planning, so a reply halts a target in the same run
it is discovered rather than one slot later — otherwise we could answer someone's
reply with another templated pitch.

---

## What it does

| | |
|---|---|
| **Watches** | `@madovermarketing_mom`, `@viralbhayani` |
| **Sends from** | `@maraboutmarketing`, `@bollywoodsociety`, `@bollywoodchronicle` |
| **Schedule** | 11:00 / 15:00 / 17:00 / 20:00 IST, daily, plus catch-up on boot |
| **Detects** | ~12–18 paid campaigns/day across both channels |
| **Sends** | ~0.6 DMs/day average, peak 2 — set by cooldown, not by detection count |

### Routing matrix

Stored as `OutreachPair` rows, never hardcoded. Adding a target is an INSERT.

| From | → | To |
|---|---|---|
| `@maraboutmarketing` | → | `@madovermarketing_mom` |
| `@bollywoodsociety` | → | `@madovermarketing_mom` |
| `@bollywoodsociety` | → | `@viralbhayani` |
| `@bollywoodchronicle` | → | `@viralbhayani` |

---

## How it works

```
   ┌─ Next.js 16 ──────────┐   ┌─ worker ──────────────────────────────┐
   │  One page (CEO view)  │   │  node-cron  11/15/17/20 Asia/Kolkata   │
   │  Prisma Studio        │   │    ↓                                  │
   │  pnpm agent (CLI)     │   │  1 discover  Playwright, LOGGED OUT   │
   └───────────┬───────────┘   │  2 enrich    plain HTTP GET /p/{code} │
               │               │  3 classify  per-channel detector     │
        SQLite (one file) ◄────┤  4 replies   read threads, auto-halt  │
                               │  5 plan      cadence governor         │
                               │  6 send      logged-in browser        │
                               └───────────────────────────────────────┘
```

### Detection needs no Instagram login

Verified against 22 live posts on 2026-07-29:

| Approach | Result |
|---|---|
| Official `web_profile_info` API | HTTP 400 — Instagram-side schema error |
| Profile page, raw HTTP | 684 KB JS shell, **0 shortcodes** |
| Profile page, JS rendered | **12 shortcodes** ✓ |
| Post page `/p/{code}/`, raw HTTP | **Full caption to 1,368 chars** + likes + comments + date ✓ |

So: render the profile once for shortcodes, then one plain GET per post. No credentials,
which means detection can never endanger an account. Playwright is needed for exactly one
thing — sending.

> The enrichment fetch identifies itself honestly (`DSSalesAgentBot/0.1`). A Chrome UA
> without the full Sec-Fetch header set gets the JS shell; an obvious crawler gets the
> server-rendered metadata page, which is what `og:` tags exist for. No impersonation
> needed, and it's the smaller response.

### The two channels behave completely differently

**`@madovermarketing_mom` discloses.** Paid posts carry `#Collaboration` with the brand
named alongside — real examples: `#Collaboration #RoyalCanin`, `@tilara.india #Tilara`,
`@theleela #TheLeela`. Deterministic regex, near-100% precision, free brand extraction,
**no LLM**.

**`@viralbhayani` never discloses.** Roughly half their output is commercial, and nothing
structural says so:

| Caption | Reality | Disclosure |
|---|---|---|
| "Blockbuster #JanaNayagan is running successfully in cinemas now" | film campaign | none |
| "Dr L H Hiranandani Hospital invites you to a FREE Program" | brand promo | none |
| "#malaikaarora spotted with her mystery friend" | organic | n/a |

Only meaning separates row 1 from row 3. That needs a language model, which costs money
and can be wrong — and in Phase 1 would buy nothing, because the prospect list is two
hardcoded handles and the rate is set by cooldown. So **every post is stored with its
caption and left `UNCLASSIFIED`**, building the labelled corpus a semantic classifier gets
built *and validated* against in Phase 1.5.

### The cadence governor

`src/outreach/governor.ts` — a pure function, exhaustively tested. Detections supply the
hook; this sets the rate.

1. Pair enabled · target not opted out · sender ACTIVE
2. **A reply halts every sender to that target**, not just the one that got it
3. No pending unsent attempt for this pair
4. Cooldown elapsed (default 7 days per pair)
5. Target under its daily cap (default 1/day, across all senders)
6. Sender under its daily cap

Without it, ~15 detections/day would mean ~28 near-identical DMs into two inboxes and a
block inside 48 hours.

### Detection never gates outreach

If the classifier breaks, messages still go out with a generic opener. A monitoring
subsystem must never be able to silence the thing it monitors — *"sends nothing, reports
nothing wrong"* is the failure mode that actually costs money.

Correspondingly: **0 posts parsed** is an alarm; **30 parsed / 0 paid** is a quiet day.

---

## Credentials

**No password is ever typed into, stored by, or committed with this project.**

```bash
pnpm session:add --sender=bollywoodsociety
```

Opens a real Chromium window. You log in yourself — 2FA and checkpoints just work,
because a human is driving a real browser. Playwright saves the resulting cookies to
`sessions/<handle>.json`, which is gitignored.

```bash
pnpm session:check    # verify sessions are alive and the DM composer is reachable
```

> ⚠️ The DM selectors were written against documented structure — the DM UI is unreachable
> logged out, so they have **never met a live page**. Every locator therefore goes through
> `findFirst()`, which tries named candidates in order and records what each matched, and
> any failure writes a full diagnostic to `diagnostics/` (screenshot, HTML, every button
> and editable on the page) so a selector can be fixed in one pass rather than several.
>
> Validate with `pnpm session:check`, and make the first real send go
> `@bollywoodsociety → @bollywoodchronicle` — you own both ends, so it proves the whole
> chain without touching a prospect.

### Graduating to autopilot

Two keys, both required:

1. `AUTOPILOT_ENABLED=true` in `.env` (deployment opt-in — a hard floor the DB cannot override)
2. `pnpm agent autopilot on <handle>` per account

`pnpm agent status` shows exactly what is blocking each account. It refuses to arm an
account that cannot actually send, so the flag never reads "on" while every attempt fails.

Manual and autopilot share one `OutreachSender` interface, so this is a boolean, not a rewrite.

---

## Commands

| | |
|---|---|
| `pnpm dev` | Dashboard on :3000 |
| `pnpm worker` | The scheduled watch |
| `pnpm run:slot` | Run one slot now and exit |
| `pnpm agent status` | What is blocking each account from sending |
| `pnpm agent autopilot on\|off <handle>` | Let an account send by itself |
| `pnpm agent pause\|resume <handle>` | Stop/resume an account (resume clears a lock) |
| `pnpm session:add --sender=X` | Capture a login session |
| `pnpm session:check` | Verify sessions and that the DM composer is reachable |
| `pnpm preview` | Print the exact message each pair would send |
| `pnpm inspect` | Detected campaigns and extracted brands |
| `pnpm reclassify [--apply]` | Re-run detectors over stored captions, no re-fetching |
| `pnpm test` | 129 tests |
| `pnpm db:studio` | Full raw data — everything the dashboard deliberately omits |

---

## Layout

```
prisma/
  schema.prisma          10 models; SQLite (no arrays/enums → JSON + string unions)
  seed.ts                idempotent; prints a NEEDS-CONFIRMATION checklist
  variants.ts            12 hand-written message bodies
src/
  detection/
    discover.ts          Playwright → 12 shortcodes, logged out
    enrich.ts            HTTP GET → og:description parser
    detectors/mom.ts     #Collaboration rules + brand extraction
    detectors/passthrough.ts
    pipeline.ts          orchestration, idempotent on shortcode
  outreach/
    governor.ts          pure eligibility function
    render.ts            message assembly, persona validation
    matching.ts          "is this text ours?" — used by send-confirm and reply-detect
    plan.ts              DB-driven planner
    replies.ts           reads threads, auto-halts on a reply
    senders/             manual.ts | playwright.ts | browser.ts | diagnose.ts
  worker/                node-cron + catch-up
  app/                   one page (CEO view)
tests/                   129 tests, fixtures captured from live posts
docs/specs/              design & implementation plan
```

---

## Before autopilot

Sender handles, Kapil's number and the greeting style are all confirmed. What remains is
mechanical:

1. **Log in once per account** — `pnpm session:add --sender=<handle>`. Nothing can be sent
   until this exists, and it cannot be automated: a real browser opens and you log in, so
   no password ever passes through this code.
2. **Validate the send path** — `pnpm session:check`, then a proof send
   `@bollywoodsociety → @bollywoodchronicle`.
3. **Arm the accounts** — `pnpm agent autopilot on <handle>`, one at a time.

`pnpm agent status` tells you which of these is outstanding at any moment, and the
dashboard's "Needs you" list says the same thing in plain English.

## Known limits

| | |
|---|---|
| **Cold DMs violate Instagram's ToS.** There is no compliant API for unsolicited DMs — the official Messaging API only replies within 24h of a user-initiated message. This is an accepted business decision. | |
| **12-post grid window.** Viral Bhayani posts 20–30/day, so some roll off unseen overnight. Costs nothing in Phase 1 (detection is a hook, not the prospect list); the trigger for adding a paginating source in Phase 1.5. | |
| **Day-precision timestamps.** `og:description` gives a date, not a time. Ordering within a day falls back to grid position. | |
| **Self-hosted parsing.** If Instagram changes shape, we own the fix. Raw payloads are persisted for diffing and parse-zero alarms loudly. | |

## Phase 1.5

Brand targeting is the volume unlock — Tilara, Royal Canin, The Leela and Dr Hiranandani
Hospital all surfaced in a single afternoon. Requires: `TargetAccount.kind = BRAND` rows
auto-created from detected brands; a semantic `ViralBhayaniDetector` (batched Haiku,
~$0.30/mo) validated against the Phase 1 corpus; a paginating source (~$10/mo) for the
12-post gap; `autoSendEnabled = true`.

At ~60 safe DMs/day across three senders, roughly 25–30 targets can run before Instagram
becomes the constraint. The schema is already shaped for it.
