# AI Sales Agent — Phase 1: Design & Implementation Plan

**Date:** 2026-07-29
**Owner:** Tabish (tabish@dashmani.com) · Digital Sukoon
**Status:** Draft for approval
**Scope:** Phase 1 only — detect paid campaigns on two Instagram publisher channels and deliver DMs from three owned accounts, with a dashboard. Everything else is later.

---

## 1. Goal

A standing watch on two Instagram publisher channels. When either posts paid/branded content, deliver a partnership pitch DM from a designated owned account to that channel — governed so it runs indefinitely without tripping spam controls.

Manual-confirm first, to prove a message actually lands. Then autopilot.

### Routing matrix — the complete universe of Phase 1

| Sender (we own, full credentials) | → | Target (not ours) |
|---|---|---|
| `@maraboutmarketing` | → | `@madovermarketing_mom` |
| `Bollywood Society` *(handle TBC)* | → | `@madovermarketing_mom` |
| `Bollywood Society` *(handle TBC)* | → | `@viralbhayani` |
| `Bollywood Chronicle` *(handle TBC)* | → | `@viralbhayani` |

Four sender→target pairs. Stored as **data** (`OutreachPair` rows), never hardcoded, so adding targets in Phase 1.5 is an insert.

### Schedule

11:00 / 15:00 / 17:00 / 20:00 **IST**, daily. Slots are *opportunities the scheduler evaluates*, not quotas it fills. With a 7-day cooldown most slots are idle by design.

---

## 2. Verified constraints

Measured 2026-07-29, not assumed. These shape the design.

| Finding | Evidence | Consequence |
|---|---|---|
| **No compliant API for cold DMs.** Official Instagram Messaging API only replies within 24h of a *user-initiated* message; Human Agent tag extends to 7 days, support only. | Meta docs + platform guidance | Sending must use browser automation. This is a ToS violation and an accepted business risk. |
| **No official way to read third parties' paid-partnership data.** Meta's Apr 2026 update added the partnership label to the *Content Publishing* API (publish your own) and a *Collaborative Media* endpoint (media where **you** are an accepted collaborator). `business_discovery` has no partnership flag. | developers.facebook.com | Detection must come from the public web. |
| `web_profile_info` API returns **HTTP 400** (Instagram-side schema error) | Direct probe | Dead end. |
| Logged-out **profile page, raw HTTP** → 684 KB JS shell, **0 shortcodes** | Direct probe | Profile discovery needs a rendered browser. |
| Logged-out **profile page, JS rendered** → **12 shortcodes**, no metadata | Direct probe | 12-post window per check. |
| Logged-out **post page `/p/{code}/`, raw HTTP** → **full caption untruncated to 1,368 chars** + likes + comments + date + permalink, via `og:description` | 22/22 posts | Caption enrichment is free, no browser, no login. |
| `sponsor_tags` / `is_paid_partnership` **absent on all 22 posts** | Direct probe | Cannot rely on structured flags. |
| Safe cold-DM volume: **~20/day per warmed account**; Meta cut the hard cap to 200/hr (Oct 2024) | Platform guidance | ~60/day capacity across 3 senders. Not our binding constraint. |

> **Detection requires no Instagram login.** Both steps work logged-out. Detection therefore cannot endanger any account, needs zero credentials, and works on a fresh clone. Playwright is needed for exactly one thing: sending.

---

## 3. Volume model

### Detection (measured / estimated)

| Channel | Posts/day | Paid posts/day |
|---|---|---|
| `@madovermarketing_mom` | ~3 (9 recent posts spanned Jul 27–29) | **1–3** — three `#Collaboration` posts on Jul 28 alone |
| `@viralbhayani` | 20–30 (12+ by ~15:20 IST) | **~10–15** est. (~50% of sampled posts commercial) |
| **Total** | | **~12–18 opportunities/day** |

*Viral Bhayani's rate is extrapolated from one afternoon's sample and should be re-measured after a week of live data.*

### Sending

Detections supply the **hook**, not the rate. Rate is governed per recipient.

| Cooldown per pair | DMs/day | DMs/month | Sustainable |
|---|---|---|---|
| **7 days (default)** | ~0.6 avg, peak 2 | ~17 | ✅ |
| 3 days (aggressive) | ~1.3 avg, peak 2 | ~40 | ✅ |
| None — one per detection | ~28 | ~840 | ❌ blocked within 48h |

**Hard guards, always on:**
- Max **1 DM per target per day** across all senders (prevents MOM receiving two pitches the same day)
- Max **1 DM per pair per `cooldownDays`**
- Per-sender `dailyCap` (default 5; we will use ~1–2)
- **A reply from a target halts all senders to that target** and raises an alert

Peak 2 DMs/day against ~60/day safe capacity — **3% utilisation**. Volume-driven ban risk is negligible. The binding constraint is recipient tolerance, not platform limits.

---

## 4. Architecture

Single machine. Runs identically on localhost and on a VPS.

```
┌─ Next.js 15 (App Router, TS) ─┐   ┌─ worker (tsx, same repo) ──────────┐
│  Dashboard (RSC)              │   │  node-cron  11/15/17/20 Asia/Kolkata│
│  Server actions (send/approve)│   │    ↓ catch-up-on-boot if slot missed│
│  Prisma Studio (free admin UI)│   │  1 discover  → Playwright, logged-out│
└───────────────┬───────────────┘   │  2 enrich    → plain HTTP GET /p/   │
                │                   │  3 classify  → per-channel detector │
        SQLite (single file) ◄──────┤  4 plan      → cadence governor     │
                                    │  5 notify    → dashboard READY tray │
                                    │  6 send      → adapter (manual|auto)│
                                    └─────────────────────────────────────┘
```

**Stack — 7 runtime dependencies, zero external services, zero API keys.**

| Choice | Why | Rejected |
|---|---|---|
| TypeScript | One language across dashboard + worker + shared types | — |
| Next.js 15 App Router | Dashboard + API + server actions in one process, one deploy | Express + separate Vite SPA (two processes, CORS, no gain) |
| Prisma + **SQLite** | Zero services locally, one file, `cp` is the backup. Prisma Studio is a working admin UI on day 1. Postgres later = one-line datasource change | Postgres (a container we don't need yet); Drizzle (leaner, but no Studio) |
| Playwright | **Sending only.** Persistent `storageState` per sender | Unofficial DM API vendors (hand over credentials, same ToS exposure, vendor outage) |
| node-cron + catch-up-on-boot | 4 slots, one linear pipeline | pg-boss / BullMQ+Redis (retries and fan-out we don't have) |
| Zod | Validate every parsed payload at the boundary; fail loudly on shape change | — |
| Vitest | Classifier + governor are pure functions where a bug means spamming or silence | — |

**Deliberately not used, with the trigger that would change it:**

| Tool | Cut because | Reinstate when |
|---|---|---|
| Apify ($10/mo) | At 8 page views/day there is no anti-bot problem to outsource | Brand targeting — detection becomes the prospect list, and the 12-post window starts losing Viral Bhayani posts overnight |
| Telegram bot | Manual mode is a short validation phase; you'll be watching the dashboard because you're validating it | Volume or latency makes missed pushes costly |
| LLM at runtime | MOM's signal is a deterministic hashtag (see §5) | Viral Bhayani classification — batched Haiku, ~$0.30/mo |
| Auth.js | Unnecessary locally; on a VPS, Caddy `basicauth` does it in 3 lines with no app code | Multi-user with per-user permissions |
| A dedicated "reader" IG account | Detection works logged-out | Never, unless detection moves to logged-in pagination |

**Decision rule for buying vs. self-hosting detection:** *if detection breaking for a week costs nothing, self-host it; if it costs the pipeline, buy it.* Phase 1 (2 hardcoded targets) → self-host. Phase 1.5 (brands) → buy.

---

## 5. Detection

**Two channels, two behaviours.** Measured, not assumed.

### `@madovermarketing_mom` — discloses. Deterministic, free.

Paid posts carry **`#Collaboration`**, with the brand in the hashtag and @mention:

| Shortcode | Signal | Brand extracted |
|---|---|---|
| `DbXfC7Pk7FQ` | `#Collaboration #HarRoofTilara #Tilara` | Tilara |
| `DbVMqWgTOOg` | `#Collaboration #RoyalCanin` | Royal Canin |
| `DbVAgeNE2rE` | `#Collaboration #TheLeela` + `@theleela @mind_shifters` | The Leela |

Regex on the caption. Near-100% precision, brand extraction free, **zero LLM, zero cost**.

### `@viralbhayani` — never discloses. Semantic. Deferred.

No hashtag, flag, or label separates a paid film campaign from an organic paparazzi shot. Only the meaning of the words does:

| Caption excerpt | Reality | Disclosure |
|---|---|---|
| "Blockbuster **#JanaNayagan** is running successfully in cinemas now" | Film campaign | none |
| "**ASAMBHAUUU** — Get ready for a heartwarming tale…" | Film campaign | none |
| "**Dr L H Hiranandani Hospital, Powai** invites you to a FREE Fertility Awareness Program" | Brand/event promo | none |
| "#malaikaarora spotted with her mystery friend" | Organic | n/a |
| "#athiyashetty went to the airport to receive #klrahul" | Organic | n/a |

**Phase 1 decision: log every Viral Bhayani post with its caption, classify none.** They appear on the dashboard as `UNCLASSIFIED`.

Rationale: classification here needs an LLM, can be wrong, and buys nothing in Phase 1 — the prospect list is two hardcoded handles and outreach is governed by cooldown, not by detection count. Meanwhile every logged caption accumulates a real, growing labelled corpus, which is exactly what's needed to build *and validate* the semantic classifier in Phase 1.5 rather than guessing at prompts on day one.

Phase 1 therefore stays genuinely zero-LLM and zero-key — because we measured which half of the problem is cheap, not by wishful architecture.

### Interface

```ts
interface ChannelDetector {
  channel: string
  classify(post: EnrichedPost): { verdict: Verdict; confidence: number; signals: string[]; brands: string[] }
}
// Phase 1:   MomDetector (rules)         · PassthroughDetector (logs as UNCLASSIFIED)
// Phase 1.5: ViralBhayaniDetector (rules pre-filter → batched Haiku)
```

`Verdict = CAMPAIGN | REVIEW | ORGANIC | UNCLASSIFIED`. `REVIEW` items surface in the dashboard for a one-tap yes/no; answers land in `RuleFeedback` and drive a weekly precision report so weights are tuned from evidence, not vibes.

### Pipeline per slot

1. **Discover** — Playwright, logged out, loads each profile → 12 shortcodes. 2 page loads.
2. **Enrich** — plain `fetch('/p/{code}/')` → parse `og:description` for caption, likes, comments, date. Skip shortcodes already in DB. ~0–24 GETs.
3. **Classify** — per-channel detector → upsert `DetectedCampaign` keyed on `shortcode`.

### Failure modes that must alarm

| Symptom | Meaning | Action |
|---|---|---|
| Discover returns 0 shortcodes | **Parser broke** or IP blocked | Alarm — this is an error |
| Enrich: `og:description` missing | **Meta tag shape changed** | Alarm |
| 30 posts parsed, 0 paid | Quiet day | Normal, no alarm |

The silent-zero failure is the real risk: a broken parser looks exactly like a quiet news day. Distinguishing them is non-optional. Every raw payload is persisted so a break can be diffed against yesterday and fixed in minutes.

---

## 6. Outreach & cadence governor

At each slot, after classify, walk all `OutreachPair` rows. Cheapest check first:

1. Pair `enabled`? Target not `optedOut`? Sender `ACTIVE`?
2. Cooldown elapsed since this pair's last `SENT` (`cooldownDays`, default 7)?
3. No `REPLIED` attempt on this target **from any sender**?
4. Target received nothing today from any other sender?
5. Sender under `dailyCap`?
6. A `CAMPAIGN` detected on this target in the last 72h to use as hook? *(If none — send anyway with `hookLine` empty. Outreach is not blocked on detection.)*

Survivors get: freshest `CAMPAIGN` as hook → least-recently-used `MessageVariant` → render → `OutreachAttempt(status: READY)`.

> **Point 6 matters.** Detection enhances the message; it must never gate it. If the classifier breaks, outreach continues with a generic opener instead of going silent.

### Message

Kapil's block is immutable. Only surrounding prose varies across 12 stored variants, rotated LRU — identical bodies from 3 accounts is both a spam signal and visibly bad when one recipient gets two.

```
Hi {{target.contactFirstName}},

I'm {{sender.personaName}}, {{sender.personaTitle}}.
{{hookLine}}          ← "Saw your recent collaboration with Royal Canin — strong execution."
{{variantBody}}       ← 1 of 12, LRU-rotated

{{sender.personaName}}
{{sender.personaTitle}}
{{sender.personaPhone}}      ← CONSTANT, never varied
{{sender.personaEmail}}
```

`contactFirstName` is per **target** (each recipient gets their own real name). The Kapil block is per **sender**. The 12 variants will be written by hand and reviewed before first send — no runtime LLM, and the pitch stays editorially yours.

### Send adapters

```ts
interface OutreachSender {
  send(a: OutreachAttempt): Promise<{ status: 'SENT' | 'FAILED'; threadUrl?: string; error?: string }>
}
```

| Adapter | Behaviour |
|---|---|
| `ManualAssistSender` *(default)* | Marks `READY`, surfaces in dashboard tray with body + copy button + `https://ig.me/m/{handle}` deep link. Human taps → records `sentBy` |
| `PlaywrightSender` *(built, flag-off)* | Persistent `storageState` per sender, 45–180s jitter, **abort and set sender `CHALLENGED` on any checkpoint — never retry a challenge** |

Flipped per sender via `SenderAccount.autoSendEnabled`. Same pipeline, same records, same dashboard. Autopilot is a boolean, not a rewrite.

---

## 7. Data model (Prisma / SQLite)

```prisma
model SenderAccount {
  id              String  @id @default(cuid())
  handle          String  @unique
  displayName     String
  personaName     String            // "Kapil Jain"                  ← constant
  personaTitle    String            // "Co-founder, Bollywood Society"
  personaPhone    String            // ← REQUIRED INPUT, see §12
  personaEmail    String            // kapil@digitalsukoon.com
  autoSendEnabled Boolean @default(false)
  dailyCap        Int     @default(5)
  status          String  @default("ACTIVE")   // ACTIVE | PAUSED | CHALLENGED
  sessionPath     String?
  variants        MessageVariant[]
  pairs           OutreachPair[]
}

model TargetAccount {
  id               String  @id @default(cuid())
  handle           String  @unique
  displayName      String
  contactFirstName String?           // ← REQUIRED INPUT, per recipient
  kind             String  @default("CHANNEL")  // CHANNEL | BRAND  ← Phase 1.5 hinge
  optedOut         Boolean @default(false)
  detectorKey      String            // "mom" | "passthrough"
  campaigns        DetectedCampaign[]
  pairs            OutreachPair[]
}

model OutreachPair {                  // the routing matrix, as data — 4 rows
  id           String @id @default(cuid())
  senderId     String
  targetId     String
  cooldownDays Int     @default(7)
  enabled      Boolean @default(true)
  sender       SenderAccount @relation(fields: [senderId], references: [id])
  target       TargetAccount @relation(fields: [targetId], references: [id])
  attempts     OutreachAttempt[]
  @@unique([senderId, targetId])
}

model DetectedCampaign {
  id           String   @id @default(cuid())
  targetId     String
  shortcode    String   @unique      // natural idempotency key
  permalink    String
  postedAt     DateTime
  detectedAt   DateTime @default(now())
  caption      String
  likeCount    Int?
  commentCount Int?
  brands       String   @default("[]")   // JSON array (SQLite has no native arrays)
  signals      String   @default("[]")   // JSON array — which rules fired
  confidence   Int      @default(0)
  verdict      String                     // CAMPAIGN | REVIEW | ORGANIC | UNCLASSIFIED
  humanLabel   Boolean?
  rawPayload   String?                    // for diffing when parsers break
  target       TargetAccount @relation(fields: [targetId], references: [id])
}

model OutreachAttempt {
  id           String   @id @default(cuid())
  pairId       String
  campaignId   String?                    // hook source, nullable
  variantId    String
  touchNumber  Int
  hookLine     String?
  renderedBody String                     // exact bytes queued — audit trail
  status       String                     // QUEUED|READY|SENT|SKIPPED|FAILED|REPLIED
  queuedAt     DateTime @default(now())
  sentAt       DateTime?                  // ← "time contacted at"
  sentBy       String?                    // human name, or "auto"
  threadUrl    String?
  error        String?
  pair         OutreachPair @relation(fields: [pairId], references: [id])
}

model MessageVariant { id String @id @default(cuid())  senderId String  body String  timesUsed Int @default(0)  lastUsedAt DateTime?  sender SenderAccount @relation(fields:[senderId], references:[id]) }
model ScrapeRun      { id String @id @default(cuid())  slot String  startedAt DateTime @default(now())  finishedAt DateTime?  postsSeen Int @default(0)  newPosts Int @default(0)  detected Int @default(0)  error String? }
model RuleFeedback   { id String @id @default(cuid())  campaignId String  wasActuallyPaid Boolean  labelledBy String  labelledAt DateTime @default(now()) }
model AuditLog       { id String @id @default(cuid())  actor String  action String  entity String  detail String?  at DateTime @default(now()) }
```

**Why `shortcode @unique` carries the whole design:** four scrapes/day over a rolling window means every post is seen ~4×. A unique constraint plus `upsert` makes re-detection free and crash-safe — the database answers "have I processed this?", so there's no bookkeeping to get wrong.

---

## 8. Dashboard

| Route | Contents |
|---|---|
| `/` | Next-slot countdown · last run health · today's detections · **READY tray with Send buttons** · 7-day sparkline |
| `/targets/[handle]` | Profile card · campaign timeline · **every attempt with exact send timestamp, sender, variant, status** · cooldown state · pause toggle |
| `/senders/[handle]` | Sent counts (day/week/month) · cap usage · session health · `autoSend` toggle · per-variant reply rate |
| `/campaigns` | All detected posts, filterable, with fired signals + confidence + permalink · **REVIEW queue** with approve/reject |
| `/runs` | Every scrape run: counts, duration, errors · **"Sync now"** manual trigger |
| `/settings` | Cooldown days · caps · slot times · message variant editor |

Covers the brief's "individual's data, time contacted at, number of campaigns detected, sync."

---

## 9. Cost

| Item | Localhost | VPS |
|---|---|---|
| Hosting | $0 | $8–12/mo (Hetzner CPX21 / Linode 2GB) |
| Detection | $0 | $0 |
| LLM | $0 | $0 |
| External services | none | none |
| **Total** | **$0** | **$8–12/mo** |

Phase 1.5 adds ~$10.30/mo (Apify + batched Haiku) when brand targeting turns on.

---

## 10. Testing

| Layer | Approach |
|---|---|
| **Detection** | Vitest against golden fixtures — real captured payloads from both channels, including the three known MOM `#Collaboration` posts and the five known Viral Bhayani false-positive traps (spotted/airport/organic). This is the correctness core. |
| **Governor** | Vitest on all 6 eligibility rules, plus the nasty ones: cooldown boundary, reply-halts-all-senders, same-day cross-sender collision, sender at cap |
| **Renderer** | Snapshot tests — assert Kapil's block is byte-identical across all 12 variants |
| **Dashboard** | Playwright smoke on each route |
| **End-to-end** | `DRY_RUN=1` runs the full pipeline, writes to DB, sends nothing. **First week runs in this mode** so the exact bodies that would have gone out can be audited before anything is live. |

---

## 11. Build sequence

| # | Deliverable | Done when |
|---|---|---|
| 0 | Repo scaffold: pnpm, TS strict, Next.js 15, Prisma+SQLite, Vitest, `.env.example`, git init | `pnpm dev` serves a page |
| 1 | Prisma schema + migration + seed (3 senders, 2 targets, 4 pairs, placeholder persona fields) | Prisma Studio shows 4 `OutreachPair` rows |
| 2 | **Discover**: Playwright logged-out profile → 12 shortcodes, both channels | Returns 12 codes each, `ScrapeRun` logged |
| 3 | **Enrich**: HTTP GET `/p/{code}/` → Zod-validated `{caption, likes, comments, postedAt}` | 22-post fixture set captured to disk |
| 4 | **Classify**: `MomDetector` + `PassthroughDetector` + Vitest suite | 3 known MOM collabs detected; 5 VB organics not misfired |
| 5 | Scheduler: node-cron 4 IST slots + catch-up-on-boot + idempotent re-run | Slots fire in IST; running twice creates no duplicates |
| 6 | 12 message variants (hand-written, reviewed) + renderer + snapshot tests | Kapil block byte-identical across all 12 |
| 7 | **Cadence governor** + `plan-outreach` + Vitest | `DRY_RUN` produces exactly the expected sends for a simulated week |
| 8 | `ManualAssistSender` + dashboard `/` READY tray + `/targets/[handle]` + `/runs` | Can answer "who, when, how many" and send with one tap |
| 9 | `/campaigns` + REVIEW queue + `/senders/[handle]` + `/settings` | Full loop, cooldown editable |
| 10 | `PlaywrightSender` behind `autoSendEnabled` — session persistence, jitter, challenge-abort | Sends to a **test account we own**, never a target, until proven |
| 11 | VPS deploy: systemd units, Caddy + basicauth + TLS, nightly SQLite backup | Live on your domain |
| 12 | One week `DRY_RUN` → audit bodies → go live manual → flip autopilot | Your sign-off at each gate |

Steps 0–9 are Phase 1 proper. 10–12 are the graduation to autopilot you asked for.

---

## 12. Required inputs

**Blocking before the first real send (not before building):**

1. **Exact @handles** for "Bollywood Society" and "Bollywood Chronicle". Also confirm `@maraboutmarketing` — flagging factually: it is one character-class from `@madovermarketing_mom`, which can trip Meta's impersonation detection and reads oddly when pitching that exact target.
2. **Kapil's correct phone.** `+91 60000 189766` is 11 digits; Indian mobiles are 10. Likely `+91 60001 89766`. It appears in every message.
3. **Real first names** for both targets ("Sumeet" confirmed as a placeholder) — one per recipient.
4. Confirm all three senders are aged **Business/Creator** accounts with complete bios.

**For step 11:** VPS + domain.

**Nice to have:** the voice memo from your conversation (not present on this Mac — `~/Library/Group Containers/group.com.apple.VoiceMemos.shared/Recordings/` is empty; export to `~/Downloads` and it can be transcribed locally).

---

## 13. Accepted risks

| Risk | Mitigation | Residual |
|---|---|---|
| Cold DM violates Instagram ToS | Volume at 3% of safe cap; jitter; challenge-abort; human-confirm until proven | Accepted business decision |
| Self-hosted parser breaks silently | Raw payloads persisted for diffing · Zod at every boundary · **parse-zero alarms, paid-zero does not** | Hours of downtime, not days |
| 12-post window misses Viral Bhayani posts overnight | Accepted in Phase 1 (detection is a hook, not the prospect list) | Resolved by Apify in Phase 1.5 |
| Sender account challenged | Auto-pause that sender, alert, other pairs continue | One sender degraded, not all |
| Recipient annoyance | 7-day cooldown · 1/target/day · 12 rotating variants · stop-on-reply | Tunable in `/settings` |

---

## 14. Phase 1.5 preview (not in scope)

Turning on brand targeting is the volume unlock — Tilara, Royal Canin, The Leela and Dr Hiranandani Hospital all surfaced in a single afternoon's scrape. It requires:

1. `TargetAccount.kind = BRAND` rows, auto-created from `DetectedCampaign.brands`
2. `ViralBhayaniDetector` — regex pre-filter → batched Haiku (~20 captions/call, ~$0.30/mo), validated against the corpus Phase 1 accumulated
3. Apify (~$10/mo) to paginate past the 12-post window
4. Contact-name enrichment per brand, cached permanently
5. `autoSendEnabled = true`

At ~60 safe DMs/day across 3 senders, roughly 25–30 target accounts can run before Instagram becomes the binding constraint. Phase 1's schema is already shaped for all of it.

---

## Open decisions

- **Cooldown:** 7 days (default in this plan) or 3 days (aggressive)? Editable in `/settings` either way.
- **Brand resolver:** left out of Phase 1 per "channel only for now". Schema is brand-ready (`TargetAccount.kind`) at zero cost, but no resolver is built.
