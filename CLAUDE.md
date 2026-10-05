# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

DS Sales Agent watches a set of Instagram publisher channels for paid/branded posts, identifies
the companies and talent those posts name, and runs paced Instagram DM outreach to them from a
fleet of sending accounts. It is a Next.js dashboard plus background workers over one Prisma
database.

## Commands

```bash
pnpm install                 # also generates the Prisma client (postinstall)
cp .env.example .env         # every env key is documented there; schema in src/lib/env.ts
pnpm db:push && pnpm db:seed # local SQLite database

pnpm dev                     # dashboard on http://127.0.0.1:3100
pnpm build && pnpm start
pnpm worker                  # the scheduler as its own process
pnpm agent:device            # sending agent for a machine that holds Chrome profiles
pnpm local                   # dashboard against the hosted database through the tunnel

pnpm test                    # full vitest suite
pnpm vitest run tests/gate.test.ts   # a single test file (run `pnpm prisma generate` first)
pnpm typecheck               # tsc --noEmit (there is no separate lint step)
pnpm db:studio               # browse raw data
```

`pnpm test` regenerates the **SQLite** Prisma client (tests build temporary `.db` files), then
restores the client matching `DATABASE_URL` via `scripts/prisma-client-for-env.sh`. Run that script
after any partial test run or `prisma generate`, because the generated client is baked for one provider.

Operational commands live under `pnpm ig:*` (see `package.json`, implemented in `src/scripts/`);
most of them default to a dry run and need `--run` to write.

## Stack

Next.js 16 (App Router, server actions) + React 19 · Prisma 7 with driver adapters (SQLite via
`better-sqlite3` locally, Postgres via `pg` when hosted) · node-cron · Patchright (drives real,
hand-logged-in Chrome profiles) · DeepSeek `deepseek-v4-flash` for classification and brand
resolution · OCR via Apple Vision (macOS) or RapidOCR (Linux) · zod · vitest · pnpm.

## Architecture

```
detect (anonymous feed read) ──► judge (caption, then cover-frame OCR) ──► resolve brands/talent
        │                                                                        │
        ▼                                                                        ▼
  DetectedCampaign                                                   TargetAccount (PROSPECT)
                                                                                │
                                        plan (draft OutreachAttempts) ◄─────────┘
                                                     │
                        dispatch (paced, one send per tick, re-gated) ──► browser send
                                                     │
                                       reply sweep (reads threads, halts on reply)
```

### Hosting split

- **Server**: dashboard, database (Postgres), detection and drafting. Runs with `SEND_ENABLED=false`,
  which `withSendLock` enforces, so it never drives a browser.
- **Device** (an operator's Mac): `pnpm agent:device` sends, reads replies and connects accounts
  using that machine's own Chrome profiles. One device is selected as the sending device
  (`Setting.activeDevice`, `src/outreach/activeDevice.ts`); the others stand by. Devices reach the
  database over an SSH tunnel and pair through a device-authorisation flow
  (`src/lib/deviceEnrol.ts`, `/devices/enrol`).
- `scripts/deploy.sh` ships the web tier (built locally) and the worker to the server;
  `scripts/build-dmg.sh` builds the signed macOS installer (`scripts/dmg/`).

### Detection: `src/detection`

- `feed.ts` + `igHttp.ts`: anonymous feed reads (no session) through one transport; `anonGate.ts` throttles per host.
- `pipeline.ts`: orchestration, idempotent on shortcode; `cadence.ts` is detection's own 15-minute clock.
- `detectors/`: per-channel detectors: `mom` (disclosure-hashtag rules), `semantic` (novelty score, then the model), `passthrough`.
- `judge.ts`: the single judging path (caption first, then frame text from `ocr.ts`/`media.ts`), combined by `frameSignal.ts`.
- `resolveBrand.ts`, `decideBrand.ts`, `autoResolve.ts`, `badgeDoor.ts`, `officialDiscovery.ts`: turn handles and names in paid posts into verified prospects.
- `labels.ts` + `src/scripts/accuracy.ts` (`pnpm ig:accuracy`): accuracy measurement against labelled posts.

### Outreach: `src/outreach`

- `governor.ts` (may a draft be created) and `gate.ts` (may an existing draft be sent now): pure rule sets. Every send path asks `gate.ts`.
- `plan.ts`: the planner. It writes drafts and never sends.
- `rotation.ts`, `availability.ts`, `routes.ts`, `categories.ts`, `senderCategories.ts`: which sender writes to which recipient (fleets and rotation rings).
- `compose.ts`, `render.ts`, `fleetTemplate.ts`, `followUpTemplate.ts`, `brandPitch.ts`, `generate.ts` + `qualityGate.ts`: message bodies.
- `dispatcher.ts` + `pacing.ts`: the paced dispatcher, fleet-wide send lock, active hours and circuit breaker.
- `deliver.ts`, `recordSend.ts`, `reservations.ts`: delivery and atomic cap reservations (`DailyReservation`).
- `replyCheck.ts`, `replyHalt.ts`, `inboxTriage.ts`: reply detection and halts.
- `browser/`: Patchright profiles (`profile.ts`, `session.ts`), `sendDm.ts`, `readThread.ts`, `inboxScan.ts`, `messageEntry.ts`, `connect.ts`.

### Scheduling: `src/worker` and `src/agent`

- `worker/scheduler.ts`: the IST send slots, the detect-then-draft clock, the dispatch clock and a heartbeat. `runSlot.ts` runs one slot. The dashboard can embed the scheduler (`instrumentation.ts`).
- `agent/`: the device agent loop: dispatch, reply sweep, brand passes, connect relay (`connectPass.ts`), presence, disk care and session reconcile.

### Dashboard: `src/app`

- Pages: Autopilot (`/`), Targets, Senders, Paid posts, Rules, Analytics, Cost, Settings. `nav.tsx` defines the navigation.
- `actions.ts`: server actions, each guarded by `requireOperator()`. `auth-actions.ts` handles sign-in and sign-up.
- `view-model.ts` and `view-model/`: data builders for pages, memoised via `lib/viewMemo.ts`. Client components must not import server-side modules.
- `api/`: `pulse` (refresh and build stamp), `device` (enrolment), `download` (installer), `export` (CSV), `query-count`.
- `src/middleware.ts`: deny-by-default auth routing. Sessions are in `lib/session.ts`, scrypt passwords in `lib/password.ts`, roles in `lib/roles.ts`.
- `pnpm ig:layout` checks every page in a real browser (layout, assets and per-page query budgets).

### Shared code: `src/lib`

`env.ts` (zod env schema), `db.ts`/`dbPool.ts` (Prisma client and adapter selection), `settings.ts`
(runtime `Setting` rows), `urls.ts` (all Instagram URLs), `platform.ts` (macOS/Windows differences),
`paths.ts` (data directories), `constants.ts` (status sets), `cutoff.ts`, `time.ts` (IST helpers),
`logger.ts`, `modelCall.ts` (model cost ledger).

### Data model: `prisma/schema.prisma`

`SenderAccount`, `TargetAccount` (role `WATCH` | `PROSPECT`), `OutreachPair`, `OutreachAttempt`,
`DetectedCampaign`, `MessageVariant`, `BrandLookup`, `Category`/`CategorySender`/`CategoryTarget`,
`DailyReservation`, `Setting`, `User`/`Session`, `AuditLog`, `ModelCall`, `ScrapeRun`,
`RuleFeedback`, `KnownPaidPost`.

`prisma/schema.postgres.prisma` is generated from `schema.prisma` by
`scripts/make-postgres-schema.sh` and should not be edited by hand.

### Other directories

- `scripts/`: deploy, DMG build, launchd installers (`install-watch.sh`, `install-tunnel.sh`, `install-dashboard.sh`) and the RapidOCR reader.
- `tests/`: the vitest suite. Several tests run against temporary SQLite databases.
- `docs/`: runbook, deployment notes and design specs.
