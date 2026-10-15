# Harvey × DS Sales Agent — an email lane, staged (2026-10-15)

**Status: a plan. Nothing in it is built, deployed or run.** Not committed. Written read-only: Harvey
(`/home/user/ethanplusai/harvey`, pinned at `e2632eb20ee2d4fb6fe04ae715a52f578acf9a37`) was read as
untrusted data and none of its code was run by this session; the orchestrator ran its suite (428/428).

**Evidence labels.** A bare `file:line` is something I opened myself on 2026-10-15. `(reader)` means a
reader report said it and I did not re-open it. `[ext]` is outside knowledge about Gmail, macOS or
Postgres that no file in either repo can confirm. DS paths are relative to `/home/user/ds-sales-agent`;
Harvey paths are relative to `/home/user/ethanplusai/harvey` and start `harvey/`.

**Tree state.** DS HEAD is `2e7c37a`. The working tree has 15 modified files and 8 untracked ones from the
in-flight redesign Stage 1 (task #12: `src/app/actions.ts`, `src/outreach/deliver.ts`,
`src/outreach/dispatcher.ts`, 12 tests; untracked `deliverOne.ts`, `deliverResult.ts`,
`send-now-message.ts`). `src/app/actions.ts` line numbers in the reader reports are HEAD's and differ from
the working tree's (`optedOut: true` is at `:398` and `:2407` in the tree). **Every stage below must branch
from committed HEAD after redesign Stage 1.3 lands** (`scripts/build-dmg.sh:50-53` refuses a dirty tree).
`gate.ts`, `plan.ts`, `staleIntroductions.ts`, `onDemand.ts` and `rest-tally.ts` are clean in git, so their
line numbers below are stable.

---

## 1. Summary

1. **What gets built.** Email becomes a second channel to the same prospects DS already DMs, under every rule
   DS already has. **Postgres is the only state machine**: three additive tables (`BrandContact`,
   `EmailReply`, `EmailOutreach`), no column on any existing table. A pure rule table (`EMAIL_BLOCKS`) is
   asked at draft, at approval and at the moment of claim. A hosted, operator-only `/email` page is where a
   person approves each message, bound to the sha256 of the exact bytes.
2. **What Harvey is.** Harvey is installed at the pinned commit, **unpatched, outside the repo**, under
   `~/.ds-email-lane/`, and used for exactly one job: **Gmail transport**. That is about 300 lines
   (`harvey/integrations/gmail.py`, `mail_provider.py`, `paths.py`, plus its one-time OAuth flow) driven as a
   short-lived Python subprocess by a new `emailPass` inside DS's own device agent on the selected sending
   Mac. Harvey's Scout, Writer, Handler, Sender, Brain, profiler, dashboard, heartbeat and `harvey train`
   are never started, imported or run. No model call exists anywhere in v1: no Claude CLI, no quota read.
3. **Why so little of Harvey.** Every Harvey component the three designs wrapped or patched is a component DS
   would then carry: the drain has no claim step (`harvey/agents/sender.py:479-495`), the reply handler
   classifies the raw quoted body (`harvey/agents/handler.py:226-229`), the heartbeat runs Scout whenever
   nothing is open (`harvey/main.py:76-106,267`), and the dashboard has no auth. The one part with no DS
   equivalent and no such defect is the transport. The bridge's JSON protocol is Harvey-agnostic, so a
   TypeScript Gmail client can replace it later without touching the ledger.
4. **The first stage ships a decision, not a feature.** DS holds **no contact data at all**: a grep of `src`,
   `prisma`, `tests`, `docs` and `CLAUDE.md` for `external_url`, `business_email`, `bio_links` and
   `public_email` returns zero hits, and the profile endpoint that would carry them returns HTTP 400 for
   business-category accounts (`src/detection/resolveBrand.ts:862-887`). So Stage 0 measures whether DS can
   find a deliverable address for even 1 brand in 4, before any schema or any Harvey code exists. If it
   cannot, the plan stops there.
5. **Every DS rule carries over.** VERIFIED ONLY (`isVerified === true`, NULL refused). Retirement is read
   live at draft, approval and claim. Autopilot stays the one switch (no email switch, no email Setting that
   turns it on). The server can never claim (`SEND_ENABLED` floor). A company that answered **by email** is a
   company that knows us, so the five readers of "has this recipient ever replied" are extended **before the
   first email exists** (H5), and the reverse direction is a cohort rule.
6. **Send authority is narrow.** Per-message human approval, bound to `sha256(to+subject+body)`, expiring in
   48 hours; one guarded claim immediately before the send that returns the approved bytes and refuses on
   mismatch; an at-most-once ledger (`SENDING` then `UNCERTAIN`, never auto-resent); a `DailyReservation`
   slot for the cap; IST 10:00-21:00; a 3/day then 6/day then 10/day ramp; at most one send per 5-minute
   pass. The first email is **Tabish's verbatim template** plus a footer. No model writes any word.
7. **Replies are typed, dated and read safely.** `EmailReply` carries the Date-header time. Classification
   runs on the reply's own text only (quoted lines, "On … wrote:" blocks and any line that appears in the
   message we sent are stripped first), because a footer that says "opt out" would otherwise turn every
   quoted reply into an unsubscribe. A rule-matched unsubscribe suppresses the address and, by default,
   retires the Instagram route (audited, with Undo). Anything ambiguous is a person's.
8. **Size and time.** About 4,800 production lines and 3,400 test lines, roughly 15 engineer-days in six
   stages. Mailbox warm-up, DNS and counsel add weeks of calendar time that no design removes. At the 10/day
   ceiling a first pass over ~900 live prospects would take about three months, so the eligible set, not the
   build, is the limit.
9. **Biggest unknowns, stated.** Address yield (Stage 0 measures it). Whether `sandbox-exec` contains the
   bridge on the chosen macOS (deprecated `[ext]`; a person proves it, and the lane stays off if it fails).
   Deliverability of a new sending domain. Eighteen decisions (D0-D17) that are Tabish's (section 9); the
   first email is blocked on D1, D8 and D11.
10. **Judges split three ways** on which design wins and on four mechanics. Section 4 records each split and
    the reason this plan decides as it does. The plan is the knowledge-first measurement gate, then the
    shared-store authority model, run through the sidecar-on-mac "DS owns the runner" shape, with Harvey cut
    down to its transport.

### Stage list

- **Stage 0 — Census and link-back measurement (go/no-go G0).** TypeScript only, read-only, no schema, no
  Harvey. ~700 prod / ~600 test lines, 1.5-2 days.
- **Stage 1 — Contact store and verified-address pipeline (G1).** `BrandContact`, a provider-only verifier,
  the `~/.ds-email-lane` credential root, dry-run-default CLIs. ~1,000 / ~700, 3 days.
- **Stage 2 — "They know us", both ways (must precede any email).** `EmailReply`, one `knowsUs.ts` union
  across the five existing readers, four sentences, a manual record door, a presence capability. ~450 /
  ~600, 2 days.
- **Stage 3 — Ledger, rules, template and footer, hosted approval page (nothing can send yet).**
  `EmailOutreach`, `EMAIL_BLOCKS`, guarded approve and claim, `/email`. ~1,600 / ~1,000, 4 days.
- **Stage 4 — Transport and the unattended pass.** Harvey at the pin as a Gmail bridge, `emailPass` in the
  device agent, the safe inbound classifier, the installer. ~1,100 TS + 300 Python + 250 shell / ~900 + 200,
  4 days.
- **Stage 5 — Controlled live run.** Internal mailbox, then 3 brands, then the ramp. Person-gated, ~0.5 day
  of code plus calendar time.
- **Stage 6 (optional, gated on D9) — a deterministic paid-post line.** `followUpPostReference` with the
  publisher passed as a filter, plus `FACT_STALE`. ~250 / ~250, 1 day.
- **Not planned:** follow-ups, model-written copy, reply drafting, Harvey's Scout, Writer, profiler and
  `harvey train`. Each needs its own decision and its own plan.

---

## 2. Context

**Harvey, in five lines.** A third-party (MIT) cold-email sales agent in Python 3.11+. A heartbeat loop
runs Scout, Writer, Sender, Handler and Analyst over a SQLite file (`data/harvey.db`), with the brain being
`claude -p --tools "" --strict-mcp-config` on a Claude Pro/Max subscription (or Codex). Mail goes through
Gmail, SMTP or Instantly, with an approval outbox (`pending_review` then `approved` then `sent`) and a
deterministic pre-send gate (`harvey/gate.py`). A FastAPI dashboard on `127.0.0.1:5555` has no auth. It
needs a named person with a title and a mailbox-verified address per prospect (`harvey/agents/writer.py:63-67`).

**DS.** An Instagram DM outreach fleet with heavy account-safety rules, in TypeScript/Next/Prisma. A
Linode (961 MB, 1 vCPU, `SEND_ENABLED=false`) detects, drafts and hosts the dashboard; **one selected Mac**
sends through the device agent under launchd and reaches Postgres through an SSH tunnel. Operator Macs install
from a DMG built by `git archive HEAD` (`scripts/build-dmg.sh:70`); the box is deployed by a `git ls-files`
tar (`scripts/deploy.sh:60-67`).

**"Integrate smartly" means:** add email as a second channel to the prospects DS already vets, without
creating a second way to be wrong. Concretely, no new unattended behaviour that DS cannot stop with the
controls it already has, no second copy of any rule, no new place a retired brand can be written to, no
third-party code on the Linode, and no use of Harvey's parts that conflict with a standing DS rule. It does
**not** mean running Harvey as an autonomous agent beside DS.

**Assumption.** "Install this report" was read as "install this repo": Harvey at
`/home/user/ethanplusai/harvey`, installed at `.../scratchpad/hv-venv` for the orchestrator's test run. If
the report was meant as the thing to build from rather than a repo to install, the plan still holds, because
Stage 0 to 3 contain no Harvey code and Stage 4 uses three of its files.

---

## 3. Decisions already fixed by DS's rules

These are not choices. Each is a standing rule in `CLAUDE.md` and each shapes the lane. Nothing in section 9
reopens them.

| Rule (source) | What it forces in this lane |
|---|---|
| **Account safety outranks throughput** (`CLAUDE.md` "The one rule that overrides everything") | The lane adds no Instagram traffic. The only Instagram requests are person-run profile lookups in Stage 0/1 (same endpoint, same anon gate, 6 s spacing, 429 halts as `ig:audit-targets`). A change that raises exposure is not shipped silently: the lookups are D10. |
| **VERIFIED ONLY** (`CLAUDE.md` "VERIFIED ONLY"; `gate.ts:591`; `tests/verified-only.test.ts:155-177`) | An email recipient must have `TargetAccount.isVerified === true`. NULL refuses. Enforced at three ends (draft, approve, claim) from one pure function, and `verified-only.test.ts`'s source grep is extended to the new enforcer. **Harvey's `email_status="verified"` means "this mailbox exists" and is a different fact; neither stands in for the other.** |
| **AUTOPILOT IS ONE SWITCH** (`CLAUDE.md` "AUTOPILOT IS ONE SWITCH") | No `emailLaneEnabled` Setting and no per-route email switch. The lane is inert until a person provisions `~/.ds-email-lane/lane.json` (provisioning, not a switch). Autopilot OFF means the claim refuses. `dispatchPaused` (`src/outreach/dispatcher.ts:113`) means the claim refuses, so the one Pause stops Instagram and email together. Per-message human approval is a decision on each message, not a switch behind the switch (D3). |
| **THE SERVER CANNOT SEND** (`CLAUDE.md` "IT IS HOSTED NOW"; `src/lib/env.ts:101`) | The claim refuses when `!env.SEND_ENABLED`. `src/app` and `src/worker` never import the transport or the lane config (a grep test). The Linode never gets Python, `lane.json` or a Gmail token. |
| **Retirement is the one promise** (`CLAUDE.md` "AUTOPILOT IS ONE SWITCH" invariants; `gate.ts:533`) | `optedOut` and `role` are read live at draft, approval and claim. Email-level facts (address suppressed, bounced) are additional and address-scoped; they are never a second copy of the brand's retirement. The four existing writers of `optedOut` are untouched. |
| **H5, an introduction to someone who knows us** (`gate.ts:342,606-613`) | An email answer must count as "knows us". Five readers test `replyPostedAt: { not: null }`: `gate.ts:938`, `plan.ts:353`, `staleIntroductions.ts:56`, `onDemand.ts:424`, `rest-tally.ts:450` (consumed at `:558-560`). All five change before any email is sent (Stage 2). |
| **One standard message** (`src/outreach/fleetTemplate.ts:165-168`; `CLAUDE.md` "ONE STANDARD MESSAGE") | The first email is Tabish's text, verbatim, with a greeting token and a footer. No model writes any email word in v1. Whether the rule binds email at all is D1; this plan implements the stricter reading because it is reversible in one direction only. |
| **A guard is in the statement** (rule 50) | Approve, claim and the cap are each one guarded write (`updateMany` with the precondition in the `where`, check `count`), never count-then-write. |
| **A name is not an identity** (rule 51) | The claim records `claimedBy = hostId()` (`src/lib/hostId.ts`), not the typed device name. |
| **A guard's output is the bytes it checked** (rule 53) | The claim sends the bytes it re-hashed, not a copy that SQLite or a caller supplies. |
| **Lanes built in isolation need a review of the merge** (rule 54) | Stage 2 edits five readers that the redesign Stage 3 is also changing. A merge review is a stage exit criterion. |
| **A Setting written on a loop goes in `PULSE_IGNORED_SETTING_KEYS` the same day** (rule 47; `src/app/api/pulse/stamp.ts:60-67`) | `emailLaneBeat` lands with its writer in three places: the owning constant, the list, and `tests/pulse-refresh.test.ts`'s `owners`. |
| **Never run our stack beside someone else's production; never build on a box that serves others** (rules 12, 13) | Nothing is built or installed on the Linode. |
| **Deploy: SQL by hand first, server before DMG, gated by `&&`** (rule 34; `CLAUDE.md:62-64`; "no `_prisma_migrations`") | Every stage's SQL is a hand-applied file run before the deploy. |
| **Credentials live only in `~/.ds-sales-agent`; the data root holds none** (`src/lib/paths.ts:30-32,41-44`) | The Gmail token and verifier key go in a **new** credential-class root, `~/.ds-email-lane`, never in `DATA_ROOT`. Two judges missed this; see section 4. |
| **`.env.example` is total over `env.ts`** (`tests/env-example.test.ts`) | No new `env.ts` key. Lane secrets live in `lane.json`, so `.env`, which every DS process and the DMG installer touch, never holds them. |

---

## 4. How the judges split, and what this plan decides

Three judges ranked three designs: **knowledge-first** (a Mac-local sidecar for site, signal and contact
discovery that exports a CSV; sends nothing), **shared-store** (Postgres as truth, patched Harvey, hosted
approval page, claim-before-send) and **sidecar-on-mac** (vendored pristine Harvey driven by a DS-owned
runner, SQLite triggers as a second lock). Their rankings were `K>S>M`, `K>M>S` and `M>S>K`. They agreed on
far more than they disagreed on, and this plan is the part they agree on, with the disagreements decided.

**What all three agreed on (adopted):** measure address yield before building anything; the email cohort must
be a subset of the DM cohort; "verified" must never be mapped between the two worlds; the five readers must
learn about email replies before the first email; Harvey's Scout, the Instantly path and its dashboard stay
off; credentials do not go in the data root; a quoted footer must not be able to classify a reply.

| Where they differed | The positions | Decision and reason |
|---|---|---|
| **Which design** | K (cheapest, sends nothing), S (best CEO surface and send discipline, heaviest), M (best compliance, weakest authority) | **Staged: K's measurement first, S's authority model, M's "DS owns the runner" shape, with Harvey reduced to transport.** K alone cannot enforce stop-on-reply after its CSV leaves DS; S alone carries a patch series on upstream's hottest functions; M alone has release tokens with no expiry and no claim. |
| **Where Harvey code lives** | M vendors it (`vendor/harvey`, `.gitattributes`, four plumbing edits); S and K fetch at install | **Fetch-at-install at a pinned SHA** with a sha256 manifest of the four files the bridge loads. It avoids `.gitattributes` (which would not even match a trailing-slash pattern `[ext]`), the `deploy.sh` file-list edit, the stale-file sweeps that cover only `src|prisma|tests|docs|scripts` (`scripts/deploy.sh:147`; `scripts/dmg/install.sh:106-110`) and keeps Harvey's untrusted `CLAUDE.md` out of the DS tree. A **git submodule is rejected**: `deploy.sh:67` would `tar -T` the local submodule working directory, secrets included (reader). |
| **Which Mac runs it** | M: any git-checkout "lane Mac" separate from the sender; S: the selected sending Mac | **The selected sending Mac**, inside the device agent. A second designated Mac is a second hand on the wheel (rule 31), would exclude DMG Macs (no `vendor/`), and would need its own heartbeat and selection UI. `thisMacRole()` (`src/outreach/activeDevice.ts:62`) already is the selection. |
| **Where the state machine is** | M: Harvey's SQLite plus a TypeScript sync, triggers and a release token; S: Postgres with Harvey's SQLite as a disposable copy | **Postgres only; no Harvey SQLite exists.** That deletes M's sync, mirror, three triggers, schema-version hash check and `main.heartbeat` copy, and S's patches. The cost is that DS re-implements what Harvey's Sender/Handler do, which is small once the ledger is DS's. |
| **Approval surface** | M/K: Harvey's unauthenticated localhost dashboard over `ssh -L`; S: hosted operator-only `/email` | **Hosted `/email`**, operator-only, bytes-bound. Harvey's dashboard has no auth, Host or CSRF check and a broken Start button (`harvey/dashboard.py:450-456`, reader); it is never started. |
| **Release authority has a lifetime** | M: tokens never expire; S: 48 h approval TTL | **48 h**, and the claim re-evaluates every rule at send time (S). M's tokens could outlive a retirement if the sync died. |
| **Typed reply record or reuse `ig:reply`** | K: reuse `ig:reply` (`src/scripts/reply.ts:166-180`); M/S: typed rows | **Typed `EmailReply`.** `ig:reply` needs a delivered Instagram attempt (so email-first brands are impossible), flips that attempt to `REPLIED` and halts that Instagram pair for 7 days (which is D5, Tabish's call), and skews reply stats. |
| **Does an autoresponder count as "answered"?** | S: AUTO and BOUNCE do not count | **AUTO counts; only BOUNCE does not.** DS already treats an autoresponder as a reply (`@officialsleepwell`, `CLAUDE.md` 1 Sept: the loop died when it was recorded). The refusal direction is the safe one. D14. |
| **Email unsubscribe retires the Instagram route automatically?** | J1: human-confirmed ("flagged, never auto-retired"); S/M: automatic | **Automatic only for a rule-matched, short, unambiguous opt-out; everything else is `needsHuman` and retires nothing.** The one rule makes "a DM to someone who just said stop" the worse error, and the retirement is audited and reversible (`ig:unretire-target`). The "never auto-retired" precedent is about identity audits, where DS was unsure who the account was. D4 records the opposing view. |
| **Does model drafting belong in v1?** | S: Harvey Writer by default; M: DS template by default | **No model anywhere.** Removes the Claude CLI, the subscription-terms question, the keychain read in `harvey/integrations/quota.py:85,104`, the `claude`-on-launchd-PATH failure (silent `""`, `harvey/brain.py:348-352`) and prompt injection through reply text. |
| **A database credential for Harvey** | S: shell out to `pnpm email:*`; psycopg rejected | **Neither.** The agent (TypeScript, already holding the tunnel) owns every database call and hands the bridge only bytes to send and a Gmail query. Python never sees `DATABASE_URL`. This is a bug-containment property, not a security boundary: the bridge still runs with the operator's OS privileges, hence the sandbox. |
| **Where a hook (paid-post line) sits** | K/S: not in the email by default (eligibility only); M: deterministic `followUpPostReference` if D9 | **Eligibility only in v1; the line is Stage 6, gated on D9.** One correction to the readers: `followUpSubject(brands, publisher, recipient, watchChannels)` takes the publisher as a required *filter* argument (`src/outreach/followUpTemplate.ts:374-379`); omitting it removes the filter and can pick the publisher as the subject. |

**Corrections to claims in the design documents** (each re-checked):
- Two designs placed the Gmail token under `~/.ds-sales-agent-data` citing `src/lib/paths.ts:44` as the
  convention. `paths.ts:30-32` says that root contains "nothing that identifies a device or authenticates a
  session". Wrong; the lane gets its own root.
- A design said `src/app` must not import the SQLite module "so the Linode never loads the native module".
  `src/lib/db.ts:1` already imports `better-sqlite3` unconditionally (reader), so that rationale is false. The
  boundary test is kept for a different reason (no transport code in the web tier), and there is no Harvey
  SQLite to import anyway.
- "Release tokens fail closed if the sync dies" is true only for unreleased rows. A released row with a live
  token is still drained by Harvey's Sender (`sender.py:437-440`), and it would be re-sent after a crash
  between `send_email` and the sent mark (`sender.py:479-495`). Not a risk here, because DS's claim is the only
  send path.
- The "+N queries per page" worry about the gate: `/` asks the gate for the head draft only
  (`src/app/view-model/messages-page.ts:683`, `predictResendForQueue(sendableDrafts[0]!, …)`), so the gate's
  cost on `/` is +1, not +N. The rest tally adds one query on `/` and `/targets`. `/` was measured 156/160 on
  2026-08-31 (`src/app/view-model/provenance-posts.ts:17-19`), so this can still break the budget;
  Stage 2 measures and does not raise it.

---

## 5. The design

### 5.1 Shape

```
                      Postgres (the only state machine)
        BrandContact        EmailOutreach            EmailReply
        (address,           (ledger: PENDING_REVIEW   (typed, dated,
         provenance,         -> APPROVED -> SENDING    quote-stripped)
         verification)       -> SENT | UNCERTAIN ...)
              ^                  ^      |                  ^
   person-run |     /email page  |      | claim            | report
   CLIs       |     (operator)   |      v                  |
 email:discover/verify/draft  approve   [ device agent, selected Mac ] ---- emailPass (5 min)
                                              |  JSON on stdin/stdout, scrubbed env, sandbox
                                              v
                              bridge/ds_gmail_bridge.py  (subprocess, ~300 lines of Harvey's Gmail code)
                                              |
                                           Gmail REST (443)        ~/.ds-email-lane/  (0700)
                                                                     lane.json (0600), harvey/ @ pin,
                                                                     harvey/data/gmail_token.json
```

### 5.2 Components and where each runs

| Component | Runs on | Started by |
|---|---|---|
| `BrandContact`, `EmailReply`, `EmailOutreach` tables | Live Postgres on the box | A person, by hand SQL, before each stage's deploy |
| `src/email/*` pure core and writers (rules, content, copy check, classifier, ledger, knowsUs) | Imported by the box web tier and by Macs | n/a (library) |
| `src/scripts/email-*.ts` CLIs, all dry-run by default | A home-IP Mac (git checkout or DMG) | A person |
| `/email` page and `src/app/email/actions.ts` | Box web tier (pm2 `ds-sales-agent`) | `deploy.sh` |
| `src/agent/emailPass.ts`, wired in `src/agent/index.ts` | The selected sending Mac, inside the existing device agent | The agent's own timer (5 min and once at startup), exactly as `brandPass`/`replyPass` (`src/agent/index.ts:412,514,690,700`) |
| `scripts/email-lane/bridge/ds_gmail_bridge.py` and `ds_gmail_auth.py` | The selected Mac, short-lived subprocess per call | `src/email/transport.ts` |
| `~/.ds-email-lane/harvey/` (Harvey at the pin, a throwaway checkout) and its venv | The selected Mac | `scripts/email-lane/install-email-lane.sh`, run by a person |

**Why inside the device agent and not a new launchd job.** One hand on the wheel (rule 31): the selection,
the shutdown drain (`src/outreach/shutdown.ts`), `hostId`, `caffeinate` and KeepAlive already exist there.
A new launchd label would be a third job to forget to install (`scripts/dmg/install.sh:405` installs only
the watch agent). The cost is that a bug in the pass could affect the agent, so the pass is wrapped like
`brandPass`: its own try/catch, a `passIsRunning` timestamp (rule 27), bounded subprocess timeouts, and no
import of the browser stack (the agent's existing source greps are extended).

### 5.3 Data model (exact)

All three tables are scalar-only with **no foreign keys**, so deleting a target never cascades into email
history (the `discoveredFromCampaignId` precedent, `provenance-posts.ts:35-38`). Nothing is added to
`TargetAccount`: 21 test files carry hand-written `CREATE TABLE "TargetAccount"` DDL, and the last column
addition failed 102 tests until every block was updated (`CLAUDE.md`, 20 Aug). Prisma selects every scalar
column, so a new client against a database missing a `TargetAccount` column breaks every read of the hottest
table; a missing new table breaks only the new feature.

**`BrandContact`** (Stage 1)

| Column | Type | Meaning |
|---|---|---|
| `id` | cuid | |
| `targetId` | String | `TargetAccount.id`, no FK |
| `kind` | `EMAIL` or `WEBSITE` | |
| `value` | String | the address or the bare host. After `email:forget`: the sha256 of it |
| `normalised` | String | lowercase; host without `www.` and scheme |
| `domain` | String? | the host of an address, or the site host |
| `source` | `IG_PROFILE` / `LINK_BACK` / `MAILTO` / `OPERATOR` | where it came from. **A pattern guess is not a source.** |
| `sourceUrl` | String? | the page the brand published it on. Required unless `IG_PROFILE` |
| `emailStatus` | `UNVERIFIED` (default) / `VERIFIED` / `RISKY` / `INVALID` / `BOUNCED` / `SUPPRESSED` | only `VERIFIED` is sendable |
| `verifier`, `verifiedAt` | String?, DateTime? | provider and time of the paid verdict |
| `identityConfirmedBy`, `identityConfirmedAt` | String?, DateTime? | a person confirmed the domain is the brand's own |
| `suppressedAt`, `suppressedReason` | DateTime?, String? | unsubscribed, bounced, operator, forgotten |
| `capturedAt`, `updatedAt` | DateTime | |

`@@unique([targetId, kind, normalised])`, `@@index([emailStatus])`.

**`EmailReply`** (Stage 2)

| Column | Type | Meaning |
|---|---|---|
| `id` | cuid | |
| `outreachId` | String? | the `EmailOutreach` it answers; null for a manual record |
| `targetId` | String | denormalised so every reader is one indexed query |
| `providerId` | String, unique | the Gmail message id, or `manual:<cuid>` |
| `fromEmail` | String | |
| `kind` | `HUMAN` / `AUTO` / `UNSUBSCRIBE` / `BOUNCE` | |
| `needsHuman` | Boolean, default false | ambiguous; retires nothing |
| `postedAt` | DateTime, **non-null** | the Date header; `seenAt` when it cannot be parsed |
| `seenAt` | DateTime | when the lane read it |
| `text` | String | at most 5,000 characters, the cleaned own text |
| `classifiedBy` | `rule` / `manual` | |
| `handledAt` | DateTime? | a person took over (display only; nothing windows on it in v1) |

`@@index([targetId])`, `@@index([outreachId])`.

**`EmailOutreach`** (Stage 3), the ledger

| Column | Type | Meaning |
|---|---|---|
| `id` | cuid | |
| `targetId`, `contactId` | String | no FK |
| `kind` | `FIRST` (v1 only) | `REPLY` is not built |
| `step`, `generation` | Int, default 1 | `unique(contactId, kind, step, generation)` is the physical one-first-email-per-brand guard |
| `toEmail`, `subject`, `body` | String | the final bytes, footer included |
| `contentHash` | String | sha256 of the canonical bytes |
| `status` | `PENDING_REVIEW` / `APPROVED` / `SENDING` / `SENT` / `FAILED` / `UNCERTAIN` / `REJECTED` / `CANCELLED` | |
| `approvedBy`, `approvedAt`, `approvedHash` | String?, DateTime?, String? | written only by `approveEmail` |
| `rejectedBy`, `rejectedAt`, `rejectedReason` | | |
| `claimedBy`, `claimedAt` | String?, DateTime? | `hostId()` and the time of the claim |
| `messageId` | String | the RFC Message-ID **DS generates** (`<ds-<id>@<from-domain>>`) so an uncertain send can be found by search |
| `threadRef`, `inReplyTo` | String? | from Gmail |
| `sentAt`, `error` | | |
| `templateVersion`, `factText`, `factObservedAt` | | `factText` is null until Stage 6 |
| `createdBy`, `createdAt`, `updatedAt` | | |

Indexes on `status`, `targetId`, `sentAt`.

**Settings (Stage 3/4).** `emailTemplate` and `emailFooter` (operator-set through a CLI, audited, never
loop-written; unset means the lane drafts nothing, like `followUpBody`, `src/lib/settings.ts:50-51`),
`emailBreakerAckAt`, and `emailLaneBeat` (loop-written, so the rule-47 triple). No `emailLaneEnabled`.

**Reservations.** The daily cap reuses `DailyReservation` (`prisma/schema.prisma:755-777`, `scope` is a free
string) with a new `'email'` member of the TypeScript `ReservationScope` union (`src/outreach/reservations.ts:42`).
Create-is-the-test-and-set; no second mechanism. `attemptId` is a bare string with no FK, so it holds the
`EmailOutreach.id`; **Stage 3 must grep every reader of `DailyReservation.attemptId` first** so nothing sweeps
a reservation whose id is not an `OutreachAttempt`.

### 5.4 Data flow, command by command

All CLIs are dry-run by default (a bare invocation prints counts and the first 20 rows and makes no network
call); `--run` writes; every write is audited (`audit(actor, action, entity, detail)`, actor
`cli:${OPERATOR_NAME}` for CLIs, `email-lane` for the agent). Audit actions are dotted lowercase:
`email.contact.added|verified|identity-confirmed|suppressed|forgotten`, `email.drafted`, `email.approved`,
`email.rejected`, `email.claimed`, `email.sent`, `email.send.failed|uncertain|resolved`,
`email.reply|reply.recorded`, `email.bounced`, `email.unsubscribed.retired`, `email.breaker.acknowledged`.
Entities are `TargetAccount:<id>`, `EmailOutreach:<id>`, `BrandContact:<id>`.

| Command | Reads | Writes | Notes |
|---|---|---|---|
| `pnpm email:census [--limit 40] [--run] [--verify N]` | the sampled cohort; `web_profile_info`; brand homepages; DNS MX | nothing in Postgres | prints counts only, never an address |
| `pnpm email:discover [--handle h] [--run]` | cohort; homepages; DNS | `BrandContact` (`LINK_BACK`, `MAILTO`) | link-back proof required; guessed hosts refused |
| `pnpm email:verify [--run] [--max-calls 25]` | `BrandContact` | `emailStatus`, `verifier`, `verifiedAt` | dry run prints the paid-call count first |
| `pnpm email:confirm-identity --handle h --host d` | | `identityConfirmed*` | only a person sets it |
| `pnpm email:import-contacts file.csv` | | `BrandContact` (`OPERATOR`) | columns `handle,email,sourceUrl`; sourceUrl required |
| `pnpm email:suppress <address\|handle> --reason r` / `email:forget <handle>` | | `suppressedAt` / hashes `value`, deletes reply text | audited |
| `pnpm email:record <handle> --answered\|--unsubscribe\|--bounce [--at ISO] [--note]` | | `EmailReply` (`manual`) | the door for a reply from another address |
| `pnpm email:template --set file`, `email:footer --set file` | | Settings `emailTemplate`, `emailFooter` | `checkEmailTemplate` runs the real renderer and the copy check |
| `pnpm email:draft [--max 10] [--run]` | cohort + rules | `EmailOutreach` `PENDING_REVIEW` | refuses without template, footer and a valid lane |
| `pnpm email:status` | everything | nothing | lane health on one screen |
| `/email` page actions: `approveEmail`, `rejectEmail`, `resolveUncertainEmail`, `suppressContact`, `retireAfterEmailStop`, `acknowledgeEmailBreaker` | | per action | each starts with `requireOperator()` |

**The send path (Stage 4), once per 5-minute pass, in this order:**
1. `passIsRunning(emailPassStartedAt)`; inert unless `lane.json` validates (logged once per streak).
2. Read the autopilot switch, **failing closed** if it cannot be read (the `replyPass` pattern,
   `src/agent/index.ts:514-565`); `thisMacRole().active`; `browserShutdownRequested()`; `env.SEND_ENABLED`.
3. Read the inbox through the bridge (`in:inbox -from:me newer_than:7d`, at most 50, `harvey/integrations/gmail.py:175-193`),
   classify, match, write `EmailReply` rows through the ledger. Stamp `emailLaneBeat.inboxReadAt` only on
   success.
4. Resolve any `SENDING` row older than 5 minutes: ask the bridge to search `in:sent rfc822msgid:<messageId>`;
   found means `SENT` (late), not found means `UNCERTAIN`. Never re-send.
5. At most one `claimEmail()`; send the bytes it returns; report `SENT` or `FAILED`.

**`claimEmail(id)`** re-reads every input and then does one guarded write:
`updateMany({ where: { id, status: 'APPROVED', approvedHash: <recomputed contentHash>, approvedAt: { gte: now-48h } }, data: { status: 'SENDING', claimedBy: hostId(), claimedAt: now } })`
and requires `count === 1`. It takes the `DailyReservation` slot first and releases it
(`attempted: false`, the `revertUndrivenClaim` analogue) if the write loses. It returns `{to, subject, body}`
recomputed from the row; **the bridge sends exactly those bytes**.

### 5.5 `EMAIL_BLOCKS`: one pure evaluator, three stages

`src/email/emailRules.ts` is table-driven (like `RESEND_BLOCKS`, `gate.ts:253`) and returns the first stop or
`ok`. It is called with `stage: 'draft' | 'approve' | 'claim'`. Every stop is non-overridable in v1: every stop
a human may cross in DS is about timing, and these are about who or what, or about proof.

| Block | Meaning | Stage |
|---|---|---|
| `TARGET_OPTED_OUT` | retired: never emailed | all |
| `TARGET_IS_WATCH_ONLY` | `role = 'WATCH'` | all |
| `TARGET_NOT_VERIFIED` | `isVerified !== true`; NULL refuses | all |
| `TARGET_IS_TALENT` | `campaignTalent = true`: v1 emails companies only | draft |
| `NO_PRIOR_DM` | no delivered Instagram DM yet (`EMAIL_REQUIRES_PRIOR_DM`, D2) | draft |
| `NO_RECENT_PAID_POST` | no in-window paid post naming them within 21 days (`campaignsNamingHandleRows`, `src/outreach/materialAllowance.ts:264`) | draft |
| `RECENT_DM` | an Instagram DM was delivered in the last 7 days | all |
| `ALREADY_KNOWS_US` | any `EmailReply` that is not a bounce, **or** any `OutreachAttempt` with `replyPostedAt` **or `repliedAt`** set. The `repliedAt` half is deliberate: `recordReplyOnPair` writes `repliedAt: now, replyPostedAt: args.writtenAt` (`src/outreach/replyCheck.ts:704-706`), and an undatable Instagram reply has `replyPostedAt = null` (`src/outreach/replyHalt.ts:158-185`), which is permissive *for the DM halt* by Tabish's rule and must not be permissive for cold email | all |
| `ADDRESS_NOT_VERIFIED` | `emailStatus !== 'VERIFIED'` or the verdict is older than 30 days | all |
| `ADDRESS_SUPPRESSED` | `suppressedAt` set, or `BOUNCED` | all |
| `ADDRESS_PROVENANCE` | source is not one of the four, or `sourceUrl` missing where required | all |
| `ADDRESS_DOMAIN_NOT_CONFIRMED` | the address domain is not the confirmed brand host (or a subdomain of it); consumer domains refused unless `OPERATOR` with a `sourceUrl` | all |
| `ALREADY_EMAILED` | a non-terminal or sent first email exists for this contact | draft |
| `COPY` | `emailCopyCheck`: footer present; no watched handle or display name; no other brand's name; no `@mention`; figures only from `APPROVED_FIGURES` (`src/outreach/qualityGate.ts:62`); no unrendered `{{ }}`; at most 1 link; no HTML; subject at most 90 characters; body at most 220 words (the limits in `harvey/gate.py:29-31,81-105`, adopted as constants, not imported) | draft, approve, claim |
| `APPROVAL_MISSING_OR_STALE` | no `approvedAt`, older than 48 h, or `approvedHash` differs from the row's recomputed hash | claim |
| `FACT_STALE` | Stage 6 only: `factObservedAt` older than the recency limit (the `hookRecencyStale` analogue, `src/outreach/brandPitch.ts:122-126`) | approve, claim |
| `AUTOPILOT_OFF` | the one switch (`getSettings().autopilotEnabled`; unreadable refuses) | claim |
| `PAUSED` | `dispatchPaused` | claim |
| `SERVER_FLOOR` | `!env.SEND_ENABLED` | claim |
| `NOT_SELECTED_MAC` | `thisMacRole().active` is false | claim |
| `OUTSIDE_HOURS` | not 10:00-21:00 IST | claim |
| `DAILY_CAP` | ramp: 3/day for the first 7 IST days after the first send, 6/day to day 14, then 10/day | claim |
| `MIN_GAP` | under 10 minutes since the last claim | claim |
| `INBOX_STALE` | the last successful inbox read is over 36 hours old (a missed reply is exactly the fact H5 needs; "we could not ask" must never authorise) | claim |
| `BREAKER` | among the last 20 sent, at least 2 bounces **and** at least 10 percent, and none acknowledged since `emailBreakerAckAt` (a chosen number, labelled as one) | claim |
| `LANE_UNCONFIGURED` | `lane.json` invalid, or template, footer or sender identity unset | draft, claim |

A stop with no release is a bug, so `BREAKER` has `acknowledgeEmailBreaker` (reason required, audited,
acknowledges bounces that already happened; a new one trips it again, like `acknowledgeBreaker`).

### 5.6 Replies, in detail

**Matching.** An inbound message is matched to an `EmailOutreach` by `In-Reply-To`/`References` equal to the
Message-ID DS generated, else by Gmail `threadId`. It is **not** matched by sender address (Harvey's rule,
`harvey/agents/handler.py:206-209`), because a colleague answering from another address is still the company
answering. Unmatched mail is counted and shown on `/email`, never silently dropped and never auto-recorded;
`email:record` is the manual door.

**Cleaning** (`src/email/replyClassify.ts`, pure). Remove, in order: `>`-quoted lines; "On … wrote:" and
Outlook "From:/Sent:/To:/Subject:" header blocks and everything below them; signature separators; and **every
line that appears verbatim (after whitespace and case normalisation) in the message we sent**, which defeats
any quoting style. Harvey classifies the raw body (`handler.py:226-229`, `gmail.py:205-239` returns the first
text/plain part, up to 5,000 characters, with no quote stripping), so a footer carrying "opt out" would
classify every quoted reply as an unsubscribe.

**Classes**, on the cleaned text (own text = the subject when it differs from ours, plus the cleaned body):
- `BOUNCE`: sender `mailer-daemon|postmaster|mail delivery subsystem`, or a bounce subject (ported from
  `harvey/integrations/mail_provider.py:55-62`, plus a DSN content-type check).
- `AUTO`: `Auto-Submitted` other than `no`, `X-Autoreply`, `Precedence: bulk|auto_reply|junk`, or an
  "Automatic reply/Out of office/Auto:" subject. `InboundMessage.headers` carries all headers lowercased.
- `UNSUBSCRIBE`: the cleaned text is at most 300 characters and matches a short pattern list (`unsubscribe`,
  `remove me`, `stop emailing`, `do not contact`, `opt out`, `take me off`).
- Otherwise `HUMAN`. A long reply that contains an opt-out phrase is `HUMAN` with `needsHuman = true`: it
  suppresses nothing and retires nothing, and `/email` flags it.

**Effects.**
- Every kind except `BOUNCE` makes the brand "know us" (D14).
- `BOUNCE` sets the contact `BOUNCED` and counts toward `BREAKER`.
- `UNSUBSCRIBE` sets `suppressedAt` immediately and, by default (D4), retires the Instagram route through one
  shared helper, `src/outreach/retire.ts` (`retireProspect`, a guarded statement, audited
  `email.unsubscribed.retired`). `/email` shows an Undo that calls the existing unretire path. The helper is
  extracted from `src/scripts/retire-target.ts:138` rather than adding a fifth hand-copy of the `optedOut`
  write.
- An email reply does **not** halt any Instagram page (the 7-day halt is pair-keyed, `replyHalt.ts:116-140`;
  D5).

### 5.7 Every new unattended action and its default

| Action | Default | Bound |
|---|---|---|
| `emailPass` (5 min and at startup) | **Inert** until `~/.ds-email-lane/lane.json` validates | selected Mac only; autopilot on; not shut down |
| Inbox read | on once configured | read-only, at most 50 messages per pass, one Gmail query |
| Resolve a stale `SENDING` | on once configured | one read-only Gmail search by Message-ID |
| **Send** | **off until a person approves that exact message** | at most one per pass; ramp; 10-21 IST; 10 min gap; never from the server |
| `emailLaneBeat` write | on once configured | at most once per 5 minutes; pulse-ignored |
| Auto-retire the Instagram route | on, rule-matched opt-outs only (D4) | audited, with Undo |
| Drafting | **person-run only** (`email:draft`) | at most 10 per run |
| Verifier calls, site fetches, DNS, profile lookups | **person-run only** | 25 paid calls per run; 6 s spacing and a 429 halts for profile lookups |
| Model calls | **none** | v1 has no model |
| Instagram traffic from the lane | **none** unattended | Stage 1b (passive capture) adds zero requests and is gated on D10 |

**Absent by construction:** Scout, Writer, Handler, Sender, Analyst, Brain, the profile stage, discovery
providers, port-25 probing, `harvey train`, LinkedIn/Playwright, the Instantly path, Harvey's dashboard, any
crawl outside the person-run discovery CLI, any DS Setting that turns the lane on.

### 5.8 What Harvey is used for, and what it is not

| Harvey part | Used? | Why |
|---|---|---|
| `harvey/integrations/gmail.py` (`GmailProvider._token`, `._request`, `.get_replies`, `._parse_message`, `run_auth_flow`) | **Yes** (transport + one-time OAuth) | raw REST over `httpx`, no SDK; the part with no DS equivalent |
| `harvey/integrations/mail_provider.py` (types, `looks_like_bounce`) | **Yes** | imported by `gmail.py` |
| `harvey/paths.py`, `harvey/__init__.py` | **Yes** (import-time only) | `PROJECT_ROOT`; a Python-version guard |
| `gate.py`, `handler.py`, `sender.py` | **Design evidence only, never loaded** | their limits and patterns informed DS's own constants |
| Everything else (`main.py`, `agents/*`, `brain.py`, `quota.py`, `state.py`, `dashboard.py`, `cli.py`, `config.py`, `trainer.py`, `collectors/*`, `prompts/`, `skills/`, `integrations/{email_finder,instantly,linkedin,smtp_mail,calendar,codex}.py`) | **No** | see section 8 |

The honest size of what Harvey contributes is about 300 lines. That is the point: the stages that matter
(rules, ledger, approval, reply safety, H5) are DS's, and `transport.ts` can be re-pointed at a TypeScript
Gmail REST client (~250 lines) without touching any of them. D16 asks whether to keep Harvey at all once the
Stage 4 review of its four files is done.

---

## 6. Stages

Each stage is one commit (rollback is its revert), branched from committed HEAD, gated by
`pnpm typecheck && pnpm test` (the suite stands at 2,940/2,942, the two pre-existing offline
`tests/route-rule.test.ts` failures, `CLAUDE.md:66-68`), deployed with `&&` never `;`. After any test run,
`bash scripts/prisma-client-for-env.sh`, never a bare `prisma generate`. Every guard added is
mutation-tested (revert the guard, confirm exactly its new cases fail, and **confirm the mutation applied**).

### Stage 0 — Census and link-back measurement (go/no-go G0)

**Purpose.** Learn, on about 40 real brands, whether DS can reach a deliverable address. Nothing else is
built until G0.

**Files to add** (no existing file changes):
- `src/email/siteHost.ts`: `normaliseHost`, and a committed `JUNK_HOSTS` constant (instagram.\*, facebook.\*,
  fb.\*, wa.me, t.me, youtube/youtu.be, x/twitter, link-in-bio aggregators: linktr.ee, bio.link, beacons.ai,
  taplink.cc, lnk.bio, bit.ly and similar).
- `src/email/contactFromProfile.ts`: pure; reads `external_url`, `bio_links[].url`, `business_email`,
  `public_email` from a `web_profile_info` user object; every absent field is null.
- `src/email/safeFetch.ts`: one bounded GET. `AbortSignal.timeout(12_000)`, at most 500 KB, `text/html` only, at
  most 3 redirects each re-validated, **refuses loopback, RFC1918, link-local and cloud-metadata addresses after
  DNS resolution** (an SSRF guard no design mentioned: the URLs are brand-supplied and fetched from a home
  Mac), an honest user-agent naming Digital Sukoon, `robots.txt` honoured for `/`. Harvey's collector does
  neither (`harvey/collectors/profile.py:24-29`, reader).
- `src/email/linkBack.ts`: pure; true only if the homepage has an anchor to `instagram.com/<handle>` with the
  **exact** first path segment (not a prefix: `acme` must not match `acme_official`) and links at most 3
  distinct Instagram handles. This mirrors the identity bar in `officialDiscovery.ts`: a constructed handle was
  measured wrong 4 times in 10 and 3 of those 4 exist, so reciprocity is the proof.
- `src/email/mailto.ts`: pure; extracts `mailto:` and visible addresses from a homepage and a contact page;
  keeps only addresses on the site's own host.
- `src/detection/profileContact.ts`: one `web_profile_info` call through `igGet` (the one transport,
  `src/detection/igHttp.ts`) with `anonGateCheck('profile')` and the record calls, like
  `src/detection/exists.ts`. `resolveBrand.ts` is **not** edited in this stage.
- `src/scripts/email-census.ts`: samples `role='PROSPECT' AND optedOut=false AND isVerified=true AND
  campaignTalent=false`, with at least one delivered attempt, no reply (`repliedAt` and `replyPostedAt` both
  null), and a paid post within 21 days, in a stable hashed order (the `rules-golden` hashed-slice idea).
  Bare run: lists the sample and what it would ask. `--run`: profile lookups (6 s apart, 429 halts), homepage
  fetches, DNS MX; optional `--verify N` (N at most 40) if a verifier key is in `lane.json`. Prints the funnel
  and **never an address value**.
- `package.json`: `email:census`.

**Funnel printed:** eligible brands, profile answered, contact field present, real (non-junk) domain, link-back
confirmed, address on the brand's host, MX present, (with `--verify`) verifier says valid.

**Tests that fail without the stage** (`tests/email-*.test.ts`):
- `contactFromProfile` on hand-built payloads (no recorded response exists to copy): each field absent,
  malformed, wrong type, a `business_email` that is not an address.
- `linkBack`: exact handle, `acme` vs `acme_official`, uppercase, trailing slash and query, 4 handles refused,
  a footer link that is not an anchor.
- `siteHost`: every junk host class refused, `www.` and scheme stripped, IDN lowered.
- `safeFetch`: each private range refused after DNS (a fake resolver), a redirect to a private range refused,
  size and content-type caps, timeout. `tests/no-unbounded-waits.test.ts` still passes.
- The census output contains no string matching an address (a redaction assertion on the printed report).
- A grep: nothing in `src/email` or the census imports `src/outreach/browser`, `deliver*` or `dispatcher`.

**Person's steps.** Run `pnpm email:census --limit 40` (dry), then `--run`, **from a home-IP Mac that is a git
checkout** (the maintainer's; DMG Macs do not have these scripts until the next build). Optionally get a
verifier trial key. Read the funnel.

**Gate G0** (Tabish's thresholds; suggested): at least 1 in 4 of the 40 reach "address on the brand's host
with MX". Below that, stop. Everything left behind is inert code.

**Mixed-window / deploy.** None: no schema, no deploy, nothing reaches a server.
**Rollback.** `git revert`. No data exists.
**Size.** ~700 production, ~600 test lines; 1.5-2 days.

### Stage 1 — Contact store and verified-address pipeline (go/no-go G1)

**Only if G0 is go.**

**Schema and SQL.** `prisma/schema.prisma` + `BrandContact`; regenerate `prisma/schema.postgres.prisma` with
`scripts/make-postgres-schema.sh` (`tests/schema-parity.test.ts` runs unchanged); SQLite lineage migration
`prisma/migrations/20261016000000_brand_contact/`; **hand SQL**
`prisma/migrations-postgres/20261016a_brand_contact.sql` as an idempotent `CREATE TABLE IF NOT EXISTS`, generated
by `prisma migrate diff --from-url "$DATABASE_URL" --to-schema-datamodel prisma/schema.postgres.prisma --script`
over the tunnel (read-only) and reviewed by a person. `prisma/migrations-postgres/init.sql` is stale (its
`TargetAccount` has no `role` or `isVerified`) and is not a baseline. `tests/helpers/outreach-db.ts` gets the
DDL.

**Files to add/change:**
- `src/lib/paths.ts`: `EMAIL_LANE_ROOT = join(homedir(), '.ds-email-lane')`, documented as **credential class**:
  never copied, synced or served, not inside `DATA_ROOT` or `CREDENTIAL_ROOT`.
- `src/email/laneConfig.ts`: reads `EMAIL_LANE_ROOT/lane.json` with zod; **refuses a file that is group- or
  world-readable**; fields: `verifier {provider, apiKey}`, `from {name, address}`, `gmail {clientId, clientSecret}`.
  Absent or invalid means "lane unconfigured", never an exception on the hot path.
- `src/email/brandContact.ts`: the **sole writer** of `BrandContact`. Never overwrites `OPERATOR` with a weaker
  source; never moves `SUPPRESSED` or `BOUNCED` back; hashes `value` on forget.
- `src/email/verifier.ts`: ZeroBounce or Reoon over HTTPS, `AbortSignal.timeout`. Only a `valid`,
  non-catch-all verdict becomes `VERIFIED`; `catch-all`, `unknown`, `risky`, `do_not_mail`, `invalid` never do.
  A provider-only port of the idea in `harvey/integrations/email_finder.py:382-405`. **No SMTP or port-25
  probe exists anywhere in `src/email`** (Harvey's is `email_finder.py:426-458`, from the home IP).
- CLIs (all dry-run default): `email:discover`, `email:verify`, `email:confirm-identity`,
  `email:import-contacts`, `email:suppress`, `email:forget`.
- **Stage 1b, optional, a separate commit, gated on G0 showing the fields exist and on D10:** at the call site
  where the whole `user` object is already in scope (`src/detection/resolveBrand.ts:912-927`, just before
  `return persistResolution(...)` at `:939`), call `contactFromProfile(user)` and, after `persistResolution`
  returns, a fail-open `recordBrandContact` (try/catch, so a capture bug or a missing table can never break
  resolution). `persistResolution(h, applied)` itself (`:953`) does not receive `user`, so the contact is passed
  alongside rather than through it. Zero extra requests. Brands already cached are **not** re-fetched (the
  cache branch returns early, `resolveBrand.ts:776-812`), so existing brands need `email:discover`.
- `scripts/build-dmg.sh:79`: extend the credential grep with `gmail_token|lane\.json|\.ds-email-lane`
  (defence in depth; nothing is vendored, so no `.gitattributes` and no `deploy.sh` file-list change).

**Tests that fail without it:**
- Sole-writer grep for `BrandContact` (the `verified-only.test.ts` pattern).
- `brandContact`: operator source never overwritten, suppression never undone, forget hashes the value, dry run
  leaves the row count unchanged.
- `verifier` mapping table, every verdict string; timeout; spend cap; dry run makes no call.
- Domain match both directions: `acme.com` vs `acme-promo.com` vs `sub.acme.com`; consumer domains refused
  unless `OPERATOR` with a `sourceUrl`.
- `laneConfig` refuses a 0644 file; absent file is "unconfigured".
- A grep that nothing in `src/email` imports `node:net`, `node:tls` or an SMTP library.
- `tests/paths-roots.test.ts`: `EMAIL_LANE_ROOT` is under neither existing root, and no route serves it
  (`src/app/api/download/agent/route.ts` reads only `DATA_ROOT`).

**Person's steps.** Apply `20261016a_brand_contact.sql` on the live Postgres in one `BEGIN; … COMMIT;` and
`\d "BrandContact"`. Create `~/.ds-email-lane` (0700) and `lane.json` (0600) with the verifier key and a
monthly budget. Run discover and verify (dry, then `--run`) on the 40; confirm each brand's identity by looking
at the site.

**Gate G1.** Of the sample, how many are send-ready under every Stage 3 rule except approval (verified address,
identity confirmed, cohort-eligible). Suggested: at least 1 in 4 of the 40, and at least 100 projected over the
whole eligible set. Below that, stop at an operator-supplied list and do not build the lane.

**Mixed-window / deploy.** A new table that old code ignores. No box deploy is needed (CLIs only run on a Mac).
**Rollback.** `git revert`; optional `DROP TABLE "BrandContact"`; `rm -rf ~/.ds-email-lane`.
**Size.** ~1,000 production, ~700 test lines; 3 days.

### Stage 2 — "They know us", both ways (must precede any email)

**Schema and SQL.** `EmailReply` (section 5.3); `prisma/migrations-postgres/20261016b_email_reply.sql`; DDL in
`tests/helpers/outreach-db.ts` and in the live-DB tests that reach the readers (the "no such table" failures
name them; the design readers counted about a dozen).

**Sequencing (a hard rule, not a preference).** Redesign Stage 3 (task #14, the bulk fact loader `facts.ts`,
not yet in the tree) changes four of the same five readers. If it has landed, the email read rides it. If it
has not, Stage 2 adds one query per reader and **must show `pnpm ig:layout` within every budget with none
raised**: the head-draft gate +1 on `/`, the rest tally +1 on `/` and `/targets`. If `/` would exceed 160,
**wait for Stage 3**. Do not raise a budget (`src/scripts/layout.ts:70-71`).

**Files to add/change:**
- `src/email/knowsUs.ts`: `targetsWhoKnowUs(ids)` returns the union of `OutreachAttempt` rows with
  `replyPostedAt` not null **and** `EmailReply` rows with `kind != 'BOUNCE'`. **No try/catch**: a missing table
  must refuse, not read as "no replies".
- The five readers: `src/outreach/gate.ts:938` (the `count`, then `targetEverReplied`), `plan.ts:350-358`,
  `staleIntroductions.ts:56-60`, `onDemand.ts:423-424`, `src/app/view-model/rest-tally.ts` (a new query beside
  the wide read at `:450`; `everRepliedTargetIds` at `:558-560` unions it).
- The four sentences that say "replied to one of our pages" gain "or by email": `gate.ts:611`,
  `staleIntroductions.ts:82`, `src/app/messages/remedy.ts:128`, `src/app/rules/page.tsx:53`.
- `src/scripts/email-record.ts`: the manual door (`--answered`, `--unsubscribe`, `--bounce`, `--at`, `--note`).
  Writes `EmailReply` (`providerId: manual:<cuid>`, `classifiedBy: 'manual'`), audit `email.reply.recorded`.
  `--unsubscribe` also suppresses the brand's `BrandContact` rows and prints a hint to retire the Instagram
  route; it does not retire (that is Stage 3/4's audited, reversible path).
- `src/outreach/devicePresence.ts`: optional `caps?: string[]`, written by `src/agent/index.ts` as
  `['email-knows-us']` where the presence row is written (`:259-267`, reader). `setActiveDevice`'s preview warns
  when the chosen Mac lacks it while any `EmailReply` exists.

**Tests that fail without it:**
- Per reader, **behavioural** (a grep proves a name is mentioned, only the call proves it gates): a brand whose
  only evidence is `EmailReply(HUMAN)` is refused the standard introduction at the gate
  (`INTRODUCTION_TO_SOMEONE_WHO_KNOWS_US`), its waiting introduction is discarded by the planner sweep, on-demand
  treats it as follow-up-only, and the planner takes the follow-up path. `AUTO` and `UNSUBSCRIBE` count;
  `BOUNCE` does not; a missing table throws.
- Structural: every `replyPostedAt: { not: null }` reader under `src` also calls `knowsUs`, against an allowlist
  that names each other site and why (for instance `src/app/actions.ts:1953` is a different question).
- The four sentences contain "email".
- The presence `caps` field round-trips and the preview warns.

**Person's steps.** Apply `20261016b_email_reply.sql` first. Before any email is ever sent, confirm every Mac
that could be selected shows a stamped build at or after this stage on `/senders` ("Agent build").

**Mixed-window / deploy order.** **SQL, then box, then DMG.** The readers have no try/catch by design, so code
reaching the box before the table makes the planner throw and every introduction refuse: fail-closed, but an
outage. Until a Mac installs the new image, its gate half does not read email; the `caps` warning and the
Stage 5 checklist close the one real hole (an old Mac selected later while `EmailReply` rows exist).
**Rollback.** Clean while `EmailReply` is empty. Once any reply row exists, **retire those brands first**,
otherwise reverting re-opens the standard introduction to them.
**Merge review (rule 54).** A second reviewer reads the merged diff against redesign Stage 3 before this stage
exits.
**Size.** ~450 production, ~600 test lines; 2 days.

### Stage 3 — Ledger, rules, template and footer, hosted approval page (nothing can send yet)

**Schema and SQL.** `EmailOutreach` (section 5.3); `prisma/migrations-postgres/20261016c_email_outreach.sql`.

**Files to add/change:**
- `src/email/{emailRules,emailContent,emailCopyCheck,policy,ledger}.ts`. `emailContent` builds the canonical
  bytes (NFC, `\r\n` to `\n`) and the sha256. `policy.ts` holds the constants (ramp, hours, caps, windows,
  `EMAIL_REQUIRES_PRIOR_DM`, `HOOK_MAX_AGE_DAYS`) in code, not Settings, matching `maxPerPairPerDay`'s
  "a code change someone reads". `ledger.ts` is the sole writer of status transitions, `approved*`, and
  `EmailReply`.
- `src/outreach/qualityGate.ts`: **export** the figure, placeholder and prior-knowledge predicates, with no
  behaviour change (its existing tests are the proof).
- `src/outreach/reservations.ts`: `'email'` joins `ReservationScope` (`:42`).
- `src/lib/settings.ts`: `SETTING_KEYS` and `RuntimeSettings` for `emailTemplate`, `emailFooter`,
  `emailBreakerAckAt`. Not loop-written, so no pulse change in this stage.
- CLIs: `email:template`, `email:footer` (`checkEmailTemplate` runs the real renderer and the copy check; the
  only token is `{{brand}}`, filled through `src/outreach/usableName.ts` so a raw handle becomes "there"),
  `email:draft`, `email:status`.
- `src/app/email/page.tsx`, `src/app/view-model/email-page.ts`, `src/app/email/actions.ts`
  (`approveEmail(id, hashSeen)`, `rejectEmail`, `resolveUncertainEmail`, `suppressContact`,
  `acknowledgeEmailBreaker`; `retireAfterEmailStop` arrives in Stage 4). Each action's first statement is
  `requireOperator()`.
  `approveEmail` is one `updateMany where { id, status: 'PENDING_REVIEW', contentHash: hashSeen }` setting
  `status: 'APPROVED'`, `approvedBy`, `approvedAt`, `approvedHash = contentHash`; a count other than 1 reads
  "the draft changed since you opened it". There is **no approve-all and no edit**.
- `src/app/nav.tsx`: an `Email` entry in `ENTRIES` (`:186-195`) with **no count**, so no new query on every
  page, plus the page hue the other seven have (a `data-page` rule in `src/app/globals.css:202-`; check
  `tests/shell.test.ts`).
- `src/scripts/layout.ts`: `/email` in `PAGES` with a budget near 30.
- `src/app/api/pulse/{stamp,route}.ts`: a pulse part for `EmailOutreach` and `EmailReply` (`max(updatedAt)`)
  so an open tab refreshes.
- `tests/action-authorisation.test.ts`: it reads **only `src/app/actions.ts`** (`:21`), so a new action file is
  uncovered. Extend it to scan every `'use server'` file under `src/app`.

**The page** (operator-only, because it shows third-party addresses and reply text; D17): lane status; the approval queue with the exact subject, body and footer and the
enforcer's own sentence if the row would be held now; Approve and Reject per row; approved-and-waiting; sent;
`UNCERTAIN` rows with "it was sent" and "it was not sent"; replies; suppressed; unmatched inbound count; the
breaker with its acknowledgement.

**Tests that fail without it:**
- Each `EMAIL_BLOCKS` code in both directions, and each fails when its check is removed (mutation-tested).
- Hash binding: a changed body after approval is refused at claim; a 49-hour-old approval is refused.
- `approveEmail` with a stale hash updates 0 rows. Only `claimEmail` writes `SENDING`; only `approveEmail`
  writes `approvedAt`/`approvedBy`/`approvedHash` (structural greps, like
  `tests/every-send-path-asks-the-gate.test.ts`, anchored on the **call** shape: a name in a docblock or an
  import is not a call).
- The cap: two concurrent claims cannot both take the last `DailyReservation` slot.
- `claimEmail` refuses under each of autopilot off, unreadable autopilot, paused, `SEND_ENABLED=false`, not the
  selected Mac, outside hours, inbox stale, breaker tripped.
- `/email` loader query count (the `queryCount` helper) and the layout budget; operator-only.
- `checkEmailTemplate` refuses empty text, a stray `{{`, a figure off the allowlist, a watched page's name.

**Person's steps.** Apply `20261016c_email_outreach.sql`. Write the template and the footer (D1, D8, D11) and
set them with the CLIs. Run `email:draft` dry. Grep every reader of `DailyReservation.attemptId` before the
Stage 3 commit (section 5.3).

**Mixed-window / deploy order.** SQL, then box (page and actions), then DMG (CLIs and ledger code on Macs). The
page works with no lane at all.
**Rollback.** `git revert`; optional `DROP TABLE "EmailOutreach"` **only if no `SENT` row exists** (history).
**Size.** ~1,600 production, ~1,000 test lines; 4 days.

### Stage 4 — Transport and the unattended pass

**Files to add** (under `scripts/`, which the DMG installer clears on update, `scripts/dmg/install.sh:106-110`,
and `deploy.sh` sweeps, `:147`, so a stale file cannot survive):
- `scripts/email-lane/PIN` (`e2632eb20ee2d4fb6fe04ae715a52f578acf9a37`) and `MANIFEST.sha256` (hashes of
  `harvey/__init__.py`, `harvey/paths.py`, `harvey/integrations/gmail.py`,
  `harvey/integrations/mail_provider.py`).
- `scripts/email-lane/requirements.lock`: hash-locked `httpx` and its dependencies only (`h11`, `httpcore`,
  `anyio`, `certifi`, `idna`, `sniffio`, plus `typing_extensions` below Python 3.13), generated by a person
  with `pip-compile --generate-hashes`.
- `scripts/email-lane/install-email-lane.sh` (`install`, `verify`, `status`, `uninstall`):
  1. refuses below Python 3.11 (`harvey/__init__.py` raises on 3.9, the stock macOS Python; the DMG installer
     bootstraps only Node, `install.sh:77-98`);
  2. creates `EMAIL_LANE_ROOT` (0700);
  3. `git clone --no-checkout` then `checkout --detach $PIN`, asserts `git rev-parse HEAD` equals the pin,
     **deletes the checkout's `CLAUDE.md`** (third-party agent instruction; nothing loads it, but a developer's
     Claude session in that directory would), and verifies `MANIFEST.sha256`;
  4. builds a venv with `pip install --require-hashes -r requirements.lock`;
  5. writes the `sandbox-exec` profile from `harvey.sb.tmpl` (network 443, read-write only
     `EMAIL_LANE_ROOT`);
  6. `verify` runs the proofs **from inside the sandbox**: reading `~/.ds-sales-agent/chrome-profiles`, the DS
     `.env` and `~/.ssh`, and connecting to `localhost:15432`, must all fail; the install is marked failed if any
     succeeds. `sandbox-exec` is deprecated `[ext]`; if the proof fails on that macOS the lane stays off.
  There is **no launchd job**: the agent runs the pass.
- `scripts/email-lane/bridge/ds_gmail_bridge.py`: imports only the manifest files, stdlib and `httpx` (an `ast`
  test enforces it). A subclass of `GmailProvider` that overrides `send_email` to build the MIME itself and POST
  it through the provider's `_request` (a private method; the pin and a bridge test make this safe): it sets a
  DS-generated `Message-ID`, `In-Reply-To`/`References`, and `List-Unsubscribe: <mailto:…>`. Upstream's
  `send_email` (`gmail.py:131-173`) cannot set headers and sets no `Message-ID`, which is why it is
  overridden. Operations, JSON on stdin and stdout, `"protocol": 1`, refusing a mismatch:
  `send`, `read {limit}`, `find_sent {messageId}`, `profile`. Any failure is a JSON error on stderr and a
  non-zero exit; **"could not read" is never an empty success** (the `rapidocr-read.py` contract).
- `scripts/email-lane/bridge/ds_gmail_auth.py`: calls `run_auth_flow(client_id, client_secret)`
  (`gmail.py:254`), importable without Harvey's CLI. Run by a person, **unsandboxed**, once, on the selected
  Mac; it listens on loopback 8765 and opens a browser, and writes the token with mode 0600 at
  `~/.ds-email-lane/harvey/data/gmail_token.json` (`gmail.py:37,58`).
- `scripts/email-lane/bridge/tests/test_bridge.py`.

**Files to add/change in TypeScript:**
- `src/email/transport.ts`: spawns the bridge via `sandbox-exec` with a **scrubbed environment** (`PATH`,
  `LANG`, and `HOME` set to `EMAIL_LANE_ROOT`), `cwd` an empty directory, a timeout per call; refuses when
  `!env.SEND_ENABLED`.
- `src/email/replyClassify.ts` and `src/email/ingest.ts` (section 5.6).
- `src/email/laneBeat.ts`: the Setting `emailLaneBeat` `{device, hostId, at, inboxReadAt, build, ok}`, at most
  every 5 minutes. **Rule 47 the same commit:** the constant in `laneBeat.ts`, the literal in
  `PULSE_IGNORED_SETTING_KEYS` (`src/app/api/pulse/stamp.ts:60-67`), and the entry in
  `tests/pulse-refresh.test.ts`'s `owners` (`:131-158`).
- `src/agent/emailPass.ts`, wired in `src/agent/index.ts` beside the other timers (`:690-721`), fired once at
  startup. Ordering in section 5.4.
- `src/outreach/retire.ts` (`retireProspect`) extracted from `src/scripts/retire-target.ts:138`; the script
  calls it. `removeTarget`, `labelPost` and `reverify-identity` keep their own writes: their semantics differ,
  and the rule is "not a fifth hand copy", not "one writer for all four".
- `src/app/email/actions.ts`: `retireAfterEmailStop`; `/email` shows inbox age, replies, unmatched count and
  Undo.

**Tests that fail without it** (behavioural, with the transport mocked; a source grep passes against the very
edit that reopens the hole, as `tests/autopilot-off-drives-no-browser.test.ts` learned):
- `emailPass` calls the transport **zero times** when autopilot is off, when the switch is unreadable, when
  this Mac is not selected, after `requestBrowserShutdown()`, when the lane is unconfigured, and when
  `SEND_ENABLED` is false.
- A `SENDING` row older than 5 minutes: found by `find_sent` becomes `SENT`, not found becomes `UNCERTAIN`;
  neither re-sends.
- `replyClassify` fixtures: a reply that quotes the footer (Gmail `>` style, Outlook header block, and a
  client that quotes with no marker) is **not** `UNSUBSCRIBE`; "please unsubscribe me" is; a 600-character
  reply containing "opt out" is `HUMAN` with `needsHuman`; auto-reply headers give `AUTO`; `mailer-daemon`
  gives `BOUNCE`; the subject `unsubscribe` from a List-Unsubscribe mailto is `UNSUBSCRIBE`.
- Matching by `In-Reply-To` and by thread; a colleague's address still matches; unmatched mail is counted.
- Transport: a protocol-version mismatch, malformed JSON and a timeout are failures, never empty successes.
- Python: the bridge against a fake provider; the `ast` import allowlist; the scrubbed environment; no network
  at import.
- Greps: `src/app` and `src/worker` never import `transport` or `laneConfig`; `src/email` imports nothing from
  `src/outreach/browser`; `emailPass` does not import the browser stack (the agent's existing source check is
  extended).
- `tests/pulse-refresh.test.ts` fails if `emailLaneBeat` is missing from any of its three places.

**Person's steps (the long pole):**
1. Choose the sender identity, domain and mailbox (D8). **Not `digitalsukoon.com`**: it is the company's main
   domain and the zone the hosted dashboard and its Origin cert sit under (`CLAUDE.md:830,2398`), and Harvey
   itself says never to send cold mail from a main domain (`harvey/integrations/gmail.py:11-14`). A dedicated
   secondary domain.
2. Create the Workspace mailbox and DNS: MX, SPF, DKIM, DMARC at `p=none` first, Google Postmaster Tools, and
   a slow warm-up `[ext]`.
3. A Google Cloud project with the Gmail API enabled, an **Internal** OAuth consent screen (an External app in
   Testing issues refresh tokens that expire after 7 days `[ext]`), a Desktop client. The scope is
   `gmail.modify`, **wider than needed** (send plus read would do); narrowing it means patching the pinned
   file, so it is accepted on a dedicated mailbox.
4. Install Python 3.11 or newer, generate and commit the hashed `requirements.lock`.
5. Run `install-email-lane.sh install` then `verify` on the selected Mac. **Stop if the sandbox proof fails.**
6. Run `ds_gmail_auth.py` once; confirm `profile` returns the mailbox.
7. Write `lane.json` (0600) with the verifier key, sender and Gmail client id/secret.
8. Supply the legal entity, physical address and opt-out wording (D11) and have counsel review them.
9. Review the Stage 4 diff of the four manifest files as untrusted code before bumping a pin.

**Mixed-window / deploy order.** SQL is already done. Box first (page changes), then the DMG so the selected Mac
runs the agent code, then `install-email-lane.sh` on that Mac. **The Linode gets no Python, no `lane.json` and no
Gmail token.** Restarting the agent follows rule 8: wait for `Setting.sendLock` to clear. The new pass respects
the shutdown drain.
**Rollback.** Remove `lane.json` (the pass goes inert) or `install-email-lane.sh uninstall`; revoke the Gmail
token and the OAuth client; revert the commit.
**Size.** ~1,100 TypeScript + 300 Python + 250 shell production, ~900 + 200 test lines; 4 days.

### Stage 5 — Controlled live run (person-gated)

Pre-flight, all of: Stage 2 on every Mac that could be selected (read from `/senders`); DNS checked with `dig`
and a mail-tester run `[ext]`; counsel's note on the footer; `email:status` green.
1. Approve one draft addressed to an internal mailbox. Watch the claim, the send, the Gmail Sent copy, the
   `Message-ID` search, the reply path (reply from a second address in the same thread, then quote the footer
   in a reply and confirm it is **not** an unsubscribe).
2. Three real brands, one per day, watched.
3. Then the ramp. Raising any number is a reviewed code change, not a Setting.
Kill-switch drills, each observed to refuse: Autopilot off; `Pause`; retire a brand after approval; unplug the
tunnel (the claim must fail closed); delete `lane.json`.
**Size.** ~0.5 day of code (`email:status` polish) plus calendar time.

### Stage 6 (optional, gated on D9) — a deterministic paid-post line

`src/email/emailFacts.ts` builds the reference with `followUpSubject(brands, publisher, recipient,
watchChannels)` **with the publisher passed in as the filter argument**, then `followUpPostReference`
(`src/outreach/followUpTemplate.ts:305-307`), producing `your <subject> placement on <IST day>`. It needs its own
`detectedCampaign` query for `brands` and the publisher (`NamingCampaign` is `{id, postedAt}` only,
`materialAllowance.ts:241-262`; `compose.ts:342-350` shows the shape). `FACT_STALE` goes live.
**Tests:** no watched handle or display name survives in any fact (run against the whole in-window corpus, the
backstop that would have caught the 2 Sept "your Social Samosa placement" class); an expired fact refuses at
approve and at claim.
**Size.** ~250 production, ~250 test lines; 1 day.

### Not planned

Follow-ups (a time-based 3-day and 7-day sequence conflicts with DS's material-based follow-ups,
`followUpTemplate.ts:25-29`), model-written first emails (D1), drafted replies, Harvey's Scout, Writer, profiler
and `harvey train`. Each needs a decision first and a new plan.

### Overall deploy order and the one gap

0. The 9-14 October fixes go first (server, then DMG, `CLAUDE.md:62-64`), then redesign Stage 1.3 commits.
1. Per stage: hand SQL, then box, then DMG. Reverse order to roll back, leaving the tables.
2. **The one real gap:** a Mac that is on a pre-Stage-2 build and is selected later, while `EmailReply` rows
   exist, will not refuse an Instagram introduction to a company that answered by email. It also has no
   `emailPass`, so no email goes out from it. Closed by the `caps` warning at selection and the Stage 5
   checklist, not by code that could stall email whenever someone pairs a Mac.
3. Residual, accepted: an Instagram DM can follow an email within the same week (the reverse of `RECENT_DM` is
   not built; D5).

---

## 7. Effort

| Stage | Production | Test | Days |
|---|---|---|---|
| 0 | ~700 | ~600 | 1.5-2 |
| 1 | ~1,000 | ~700 | 3 |
| 2 | ~450 | ~600 | 2 |
| 3 | ~1,600 | ~1,000 | 4 |
| 4 | ~1,100 TS, ~300 Py, ~250 sh | ~900 TS, ~200 Py | 4 |
| 5 | ~100 | ~50 | 0.5 |
| 6 | ~250 | ~250 | 1 (optional) |
| **Total (without 6)** | **~4,800** | **~3,400** | **~15** |

Mailbox warm-up and DNS, a verifier account, Google Cloud setup and counsel's review are calendar time, not
engineering, and gate Stage 5. The 10/day ceiling means the eligible set, not the build, bounds volume.

---

## 8. What NOT to do

**Harvey**
- Do not run `harvey run`, `harvey train`, `harvey setup`, `harvey dashboard` or `harvey gmail auth` (the CLI
  imports far more than the lane needs; use `ds_gmail_auth.py`). `harvey run` reaches `scout.run()` whenever
  nothing is open (`harvey/main.py:101-106,267`), scraping search engines and probing port 25 from the home IP.
  `harvey train` infers competitors and invents testimonials (`harvey/trainer.py:575,713`, reader) and
  overwrites `skills/*.md`. The dashboard's Start button runs `python -m harvey`, which prints help and exits 0
  (`harvey/dashboard.py:450-456`, `harvey/cli.py:771-779`, reader).
- Do not use the Instantly path: it deploys and activates with no approval and no gate (`harvey/agents/sender.py:85-103`, reader).
- Do not import `harvey/brain.py` or `harvey/integrations/quota.py`: the latter reads the Claude OAuth token via
  `security find-generic-password` and sends it to `api.anthropic.com` (`quota.py:85,104`, reader).
- Do not import `harvey/config.py`: its bare `load_dotenv()` (`:328`, reader) walks up the directory tree and
  would find DS's `.env`.
- Do not use Harvey's port-25 verifier (`harvey/integrations/email_finder.py:426-458`) or Hunter guessing.
- Do not use Harvey's LinkedIn or Playwright code.
- Do not map Harvey's `email_status="verified"` to DS's `isVerified`, or the reverse.
- Do not let a Harvey `verified` or an Instagram `business_email` stand in for deliverability, and never treat
  a pattern guess (`hello@domain`) as an address.

**Placement and secrets**
- Do not vendor Harvey into the repo. Do not make it a submodule (`scripts/deploy.sh:67` would `tar -T` the
  working directory and ship its untracked secrets).
- Do not put the Gmail token, `lane.json` or the verifier key in `~/.ds-sales-agent-data` or
  `~/.ds-sales-agent` (`src/lib/paths.ts:30-32`), or in `.env` / `env.ts`.
- Do not install Python, Harvey or `lane.json` on the Linode, and do not build there (rules 12, 13).
- Do not send cold email from `digitalsukoon.com` (`CLAUDE.md:830,2398`).

**Guards and DS surfaces**
- Do not add an `emailLaneEnabled` Setting, an approve-all, an auto-approve, or a second Pause.
- Do not write `OutreachAttempt` rows for emails, and do not reuse `ig:reply` for an email answer.
- Do not wrap the `EmailReply` read in try/catch.
- Do not classify the raw reply body, and do not rely on `>`-quote stripping alone.
- Do not edit `gate.ts`, `plan.ts`, `staleIntroductions.ts`, `onDemand.ts` or `rest-tally.ts` before checking
  redesign Stage 3, and do not raise any `ig:layout` budget to make a stage pass.
- Do not call `followUpSubject` without the publisher filter argument, and do not put a publisher's name in any
  email.
- Do not add a count to the nav entry (a new query on every page).
- Do not add a column to `TargetAccount`.
- Do not add a fifth hand copy of the `optedOut` write; use `retireProspect`.
- Do not store a fresh `DailyReservation.attemptId` without checking every reader of the column.
- Do not deploy code before its SQL, and do not chain deploy steps with `;`.
- Do not run a bare `pnpm prisma generate` (`bash scripts/prisma-client-for-env.sh`).
- Do not build from a dirty tree.
- Do not read the 10/day ceiling as a target: raising a number is a reviewed code change.

---

## 9. Decisions for Tabish

Each line is a decision and what it exposes. The first email is blocked on **D1, D8 and D11**.

- **D0. G0 and G1 thresholds.** The suggested 1-in-4 lines are mine; exposure is building a lane for a funnel
  that is nearly empty.
- **D1. Does the one-standard-message rule bind email?** Default yes (his verbatim text, no model). Exposure
  if no: model-written words to real brands, and most of what Harvey's Writer offers.
- **D2. Cohort.** Default only brands already DMed once, quiet, with a paid post in the last 21 days. Exposure
  if widened: a brand's first contact being cold email, and a second cold touch across channels.
- **D3. Per-message approval (default) or auto-approve under Autopilot.** Exposure: unattended mail under a
  real person's name, and tension with the one-switch rule if left manual.
- **D4. An email unsubscribe auto-retires the Instagram route.** Default yes, rule-matched only, with Undo.
  Exposure if yes: a lost lead on a misclassification. If no: a DM to a company that told us to stop. One
  judge wanted human confirmation; this plan's reason is that account safety makes the DM-after-stop the worse
  error.
- **D5. An email answer halts Instagram pages for 7 days.** Default no (the halt is pair-keyed). Exposure: a DM
  landing a day after an email reply.
- **D6. Does VERIFIED ONLY (the badge) extend to email recipients?** Default yes. Exposure if relaxed: emailing
  lookalike pages DS refuses to DM.
- **D7. May the lane email talent, not just companies?** Default no (`campaignTalent` excluded). Exposure:
  celebrity inboxes are managed and report-happy.
- **D8. Sender identity, mailbox, domain, and whether any reply discloses automation.** Exposure:
  impersonation and the reputation of the sending domain. Kapil's role at Digital Sukoon is not in either
  repo; do not invent one.
- **D9. May a paid-post reference appear in an email (Stage 6)?** Default no. Exposure: telling a brand that
  has never heard from us by email that we watch publisher pages.
- **D10. Profile lookups from the home IP.** Stage 0 is about 40; Stage 1b adds none. Exposure: more calls on
  the IP every Instagram account uses.
- **D11. Footer: legal entity, physical address, opt-out wording, and whether India's DPDP Act applies to
  named individuals' work email.** Exposure: CAN-SPAM and Indian-law non-compliance. Neither repo enforces it
  (`harvey/gate.py:49-107`).
- **D12. Ramp, cap and hours.** Default 3/day for 7 days, 6/day to day 14, then 10/day, 10:00-21:00 IST, a 10
  minute gap. Exposure: domain reputation, not the Instagram accounts. The numbers are chosen, not measured.
- **D13. Where contact addresses live.** Default the shared Postgres, with `email:forget`. Exposure: third
  parties' business addresses and reply text on a shared server. Alternative: Mac-only, which would stop the
  gate on another Mac from enforcing suppression.
- **D14. Autoresponders count as "answered".** Default yes (the Instagram precedent). Exposure if no: a
  standard introduction to a company whose autoresponder already fired.
- **D15. Keep Harvey as the transport, or replace it with a TypeScript Gmail client at the end of Stage 4's
  review?** Exposure of keeping: third-party Python on the Mac that holds the Instagram profiles, mitigated by
  the pin, the manifest, a sandbox and hash-locked dependencies, not eliminated.
- **D16. May the lane run on the selected sending Mac?** It is the only Mac that can. Exposure: the same
  machine as the Instagram sessions.
- **D17. `/email` is operator-only.** Default yes. Exposure if opened to viewers: third-party addresses and
  reply text readable by the shared `team@` login.

---

## 10. Verification

**Per stage (all must hold before the next stage starts):**
- `pnpm typecheck` clean; `pnpm test` at no worse than 2,940/2,942 plus the new tests, with only the two
  pre-existing offline `route-rule` failures; `bash scripts/prisma-client-for-env.sh` run afterwards.
- `pnpm ig:layout` all green with **no budget raised** (Stage 2 and 3 especially).
- Every guard mutation-tested: revert the guard, see exactly its new cases fail, and check the mutation applied
  (a mutation test that passes is evidence only once you have verified the mutation applied).
- Hand SQL: `\d` of each new table after applying; `tests/schema-parity.test.ts` green; nothing in the suite
  executes the Postgres SQL (the two-provider trap), so the diff-generated text and the `\d` are the check.
- Stage 2: the five readers each have a behavioural test, and a merge review of the diff against redesign
  Stage 3.
- Stage 4: Harvey checkout at the pin, `MANIFEST.sha256` verified, the bridge `ast` allowlist test green, the
  sandbox `verify` proofs all failing-as-required.

**What this verification cannot show, stated rather than implied:**
- **Address yield**: only Stage 0 and 1 on real data.
- **Deliverability**: only a warmed domain and a live run (Stage 5).
- **That `sandbox-exec` contains the bridge** on that macOS: only the `verify` proofs, on that Mac.
- **That Gmail's send is safe to retry**: it has no idempotency key; the design avoids retrying.
- **Rule 22**: `import` is not `read`. The bridge is proven by a real send to an internal mailbox and a real
  read of a real reply in Stage 5, not by its unit tests.

**Housekeeping.** One judge created a stray file `/tmp/claude-0/ddl.txt` (a list of 21 test files) outside
both checkouts; the caller can delete it.

---

## Appendix A — Harvey files touched, and every deviation from upstream `e2632eb`

**Loaded by the bridge (and nothing else is):**

| File | Used for | Notes |
|---|---|---|
| `harvey/__init__.py` | import-time Python-version guard (raises below 3.11) | |
| `harvey/paths.py` | `PROJECT_ROOT = Path(__file__).resolve().parent.parent` | imports only `pathlib`; makes the token path `…/harvey/data/gmail_token.json` inside the throwaway checkout |
| `harvey/integrations/gmail.py` | `GmailProvider._token` (`:80`), `._request` (`:110`), `.get_replies` (`:175`), `._parse_message` (`:195`), `run_auth_flow` (`:254`), `TOKEN_FILE` (`:37`), `SCOPE` (`:41`) | imports `httpx`, `harvey.paths`, `harvey.integrations.mail_provider` |
| `harvey/integrations/mail_provider.py` | `InboundMessage`, `SendResult`, `looks_like_bounce` (`:55`) | stdlib only |

**Read as design evidence, never loaded:** `harvey/gate.py` (limits at `:29-31,81-105`, adopted as DS
constants), `harvey/agents/handler.py` (`:44-78` patterns; DS writes its own, stricter and quote-safe),
`harvey/agents/sender.py` (`:420-497`, the missing claim), `harvey/main.py` (`:76-106,267`), `harvey/collectors/profile.py`
and `harvey/integrations/email_finder.py` (the port-25 and catch-all logic that is deliberately not used).

**Never touched, loaded or run:** `harvey/main.py`, `harvey/agents/*`, `harvey/brain.py`,
`harvey/integrations/quota.py`, `harvey/state.py`, `harvey/dashboard.py`, `harvey/cli.py`, `harvey/config.py`,
`harvey/trainer.py`, `harvey/setup.py`, `harvey/collectors/*`, `harvey/integrations/{email_finder,instantly,linkedin,smtp_mail,calendar,codex}.py`,
`prompts/`, `skills/`, `harvey.yaml`, `.env.example`.

**Deviations, complete:**
1. **Zero patches to any upstream file.** The four loaded files are hash-verified against `MANIFEST.sha256`.
2. `CLAUDE.md` is deleted from the throwaway checkout after the pinned checkout (third-party agent
   instruction; not loaded by anything, removed so a developer's Claude session in that directory does not
   load it). The manifest, not `git status`, is the integrity check.
3. The bridge **subclasses** `GmailProvider` and overrides `send_email` to set `Message-ID`,
   `In-Reply-To`/`References` and `List-Unsubscribe`, using the private `_request`. This is a behavioural
   deviation, not a source patch; it depends on `_request` and is covered by a bridge test against the pin.
4. Only `httpx` and its hash-locked dependencies are installed; Harvey's `requirements.txt`/`pyproject.toml`
   (pydantic, PyYAML, aiosmtplib, dnspython, Playwright, FastAPI, …) are not.
5. The OAuth scope stays upstream's `gmail.modify` (wider than needed; narrowing would be a patch).

**Upgrade procedure.** Fetch the new SHA into a scratch clone; read `git diff OLD..NEW` for the four loaded files
as untrusted code, and `git diff --stat` for the rest (looking for a new network host, subprocess call or send
path in anything the bridge imports); re-run the bridge tests and the `ast` allowlist; update `PIN` and
`MANIFEST.sha256`; reinstall. Upstream changes to anything else are irrelevant by construction. Harvey's CI
covers only Python 3.11 and 3.12 (reader); the orchestrator's run was on 3.13.

## Appendix B — DS files touched, by stage

| Stage | New | Changed |
|---|---|---|
| 0 | `src/email/{siteHost,contactFromProfile,safeFetch,linkBack,mailto}.ts`, `src/detection/profileContact.ts`, `src/scripts/email-census.ts`, tests | `package.json` |
| 1 | `src/email/{laneConfig,brandContact,verifier}.ts`, six CLIs, SQL `20261016a`, a SQLite migration, tests | `prisma/schema.prisma`, `prisma/schema.postgres.prisma` (generated), `src/lib/paths.ts`, `scripts/build-dmg.sh`, `tests/helpers/outreach-db.ts`, `package.json`; 1b only: `src/detection/resolveBrand.ts` |
| 2 | `src/email/knowsUs.ts`, `src/scripts/email-record.ts`, SQL `20261016b`, tests | `prisma/schema*.prisma`, `gate.ts`, `plan.ts`, `staleIntroductions.ts`, `onDemand.ts`, `src/app/view-model/rest-tally.ts`, `src/app/messages/remedy.ts`, `src/app/rules/page.tsx`, `src/outreach/devicePresence.ts`, `src/agent/index.ts` (caps), `tests/helpers/outreach-db.ts` and the live-DB tests |
| 3 | `src/email/{emailRules,emailContent,emailCopyCheck,policy,ledger}.ts`, `src/app/email/*`, `src/app/view-model/email-page.ts`, four CLIs, SQL `20261016c`, tests | `prisma/schema*.prisma`, `src/outreach/qualityGate.ts` (exports only), `src/outreach/reservations.ts`, `src/lib/settings.ts`, `src/app/nav.tsx`, `src/scripts/layout.ts`, `src/app/api/pulse/{stamp,route}.ts`, `tests/action-authorisation.test.ts` |
| 4 | `scripts/email-lane/*`, `src/email/{transport,replyClassify,ingest,laneBeat}.ts`, `src/agent/emailPass.ts`, `src/outreach/retire.ts`, tests | `src/agent/index.ts`, `src/app/api/pulse/stamp.ts`, `tests/pulse-refresh.test.ts`, `src/scripts/retire-target.ts`, `src/app/email/*` |
| 5 | | `src/scripts/email-status.ts` |
| 6 | `src/email/emailFacts.ts`, tests | `src/email/emailRules.ts` |

No stage touches `src/outreach/dispatcher.ts`, `deliver.ts`, `browser/*`, `src/worker/*` or `scripts/deploy.sh`.
