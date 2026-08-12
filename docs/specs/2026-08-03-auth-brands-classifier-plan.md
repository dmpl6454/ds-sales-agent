# Auth, brand outreach, classifier depth, hosting groundwork

**Written** 2026-08-03, after Tabish set scope in session. Supersedes the "three next
steps" at the bottom of `docs/HANDOFF.md`, which was written before auth was
un-deferred and before the 1-August cutoff.

**Order: 0 → 1 → 2 → 3.** Auth is first because `sentBy` and the brands panel both
land inside it, and retrofitting auth around a new panel costs more than building the
panel behind auth.

---

## Decisions taken in this session

| Question | Answer | Consequence |
|---|---|---|
| Auth vs decision 3b | **Both.** Auth un-deferred | Step 0 exists; 3b plumbing in step 1 |
| Who signs in | **Fully open signup, everyone can send** | See "The open-signup decision" below |
| Automate sending | **Capability for all accounts; switch on for `@tabishmukaddam1` only** | No code discriminates by account; `autoSendEnabled` does |
| Brand sender | `@tabishmukaddam1` first | Persona is honest there; revenue accounts gated |
| Brand copy | **Bespoke touch-1 + brand variant pool for follow-ups** | Needs `MessageVariant.targetKind` |
| `MAX_NEW_BRAND_TOUCHES_PER_DAY` | **2** | New governor rule, oldest-discovered-first |
| Detection cutoff | **1 August 2026 onwards** | Classifier + `unusedCampaignCount` scope |
| Classifier depth | **Build a real @viralbhayani evaluation set** | M.O.M's 96% does not generalise |
| Linode | **Deferred** — "perfect localhost first" | Step 3 unblocks it, does not do it |

---

## The open-signup decision

**Chosen deliberately by Tabish on 2026-08-03, after the exposure was raised and
restated. It is recorded here so it reads as a decision, not an oversight.**

The dashboard's Send button carries no credentials. It drives
`~/.ds-sales-agent/chrome-profiles/<handle>` — a Chrome profile logged into by hand.
Anyone signed in inherits that session. So a public registration form is, functionally,
**a public form granting DM-sending from `@madaboutmarketingg`, `@bollywoodsocietyy`
and `@bollywoodchronicle`** — the three revenue accounts on the 200-page network.

There is no per-user permission model in this codebase: `sendNow` checks the safety
gate, not who is asking. Building one is substantially larger than this work.

What limits the exposure today, and what does not:

- **Limits it:** the app stays bound to `127.0.0.1`. "Anyone" is currently "anyone with
  access to Tabish's Mac". The exposure becomes real at the Linode step, deferred.
- **Limits it:** only `@tabishmukaddam1` has `autoSendEnabled`. Unattended sending from
  a revenue account needs a deliberate switch flip.
- **Does NOT limit it:** the persona gate (step 1) blocks revenue-account *brand*
  sends. **Channel** pitches from revenue accounts are sendable by any signed-in user
  the moment this becomes publicly reachable.

**Before this is exposed beyond localhost, revisit this.** The natural next step is
roles — view on signup, send on approval — which the `User` model in step 0 is shaped
to accept without migration pain.

---

## Where the existing docs are wrong

The code is authoritative. Verified against the working tree 2026-08-03.

### 1. `BrandLookup.kind` has five values, not four — LATENT BUG

`prisma/schema.prisma:353` documents `BRAND | PERSON | MISSING | UNKNOWN`.
`src/detection/resolveBrand.ts` also emits **`UNRESOLVED`**, and the live database
holds **4 rows** with it (`PERSON 3 · UNRESOLVED 4 · UNKNOWN 1`).

`UNRESOLVED` is the load-bearing one — it is the "we looked and the data is not there"
outcome whose whole reason for existing is that it must not collapse into `PERSON`.
The schema comment omits exactly the value the file's own header explains at length.

### 2. `DETECTOR_KEYS` omits `semantic` — LATENT BUG

`src/lib/constants.ts` declares `DETECTOR_KEYS = ['mom', 'passthrough']` and
`schema.prisma:73` says `"mom" | "passthrough"`. But `semantic` is registered in
`detectors/index.ts` and **`@viralbhayani` runs on it in production**.

This is the more dangerous of the two. A `switch` over `DETECTOR_KEYS` that silently
omits `semantic` reintroduces precisely the *"Paid campaigns found: 0"* bug that bit
last session — a channel where roughly half of ~62 posts/day are commercial rendering
a confident zero.

**Both are inert today for the same reason:** nothing validates these strings on write,
and `getDetector` falls back to `passthrough` rather than throwing. They are type-level
lies that bite whoever next writes a `switch`.

### 3. "Only 20% of brands are resolvable" — measured on the wrong field

`docs/specs/2026-08-03-brand-outreach-design.md` §3 measures resolvability against
`DetectedCampaign.brands`, which holds *display names* — `extractBrands` deliberately
converts `@royalcanin.india` into `"RoyalCanin"`, discarding the handle at exactly the
step that needs it. CLAUDE.md decision 7 already corrects this: the **captions** of the
same posts hold 26 real `@mentions`. `resolveBrand.ts` reads the caption.

### 4. The brand spec describes machinery that was never built

§3 says resolution confirms with `handleExists()` — it does not; `handleExists` is
called only from `actions.ts:571` and `:701`. §9 calls for a `BrandCandidate` review
queue model and a `'none'` detector: **neither exists**, and `brands.ts` points brand
targets at `passthrough` instead. Read that spec for its reasoning, not as a
description of the code.

### 5. Scheduler host identity — subtler than the handoff says

The handoff asks for "host identity in the scheduler heartbeat" as if absent. It is
present (`SchedulerHeartbeat.host`) but typed `'worker' | 'dashboard'` — a **role**, not
a machine. `process.kill(pid, 0)` is honest and correct for one host, and its comment
says so.

Across two hosts it fails in **both** directions:

- the foreign pid does not exist locally → "it died, take over" → **two schedulers**,
  every slot fired twice;
- the foreign pid collides with an unrelated local process → "it is alive" → **zero
  schedulers**, autopilot ON with nothing scheduled.

Fix before any split, not after.

---

## Step 0 — Auth

Today: no `middleware.ts`, **18 exported server actions**, and `curl` to the LAN IP
returns 200 with Send buttons in the HTML.

- **Schema:** `User` (email unique, password hash, createdAt) and `Session` (token,
  userId, expiresAt). Hash with a slow KDF (argon2id or bcrypt).
  **This does not contradict "nothing in this repo stores a password":** that rule is
  about *Instagram* credentials, which are still never stored, read, or transmitted. A
  dashboard password is ours, and it is hashed, never reversible.
- **`middleware.ts` covering every route and every server action, default-deny.** A new
  route must be protected unless it explicitly opts out. The failure direction is the
  whole point — an allowlist-by-default matrix is how 18 actions came to be exposed.
- **Sign up / sign in / sign out.** Open registration (see above).
- **`sentBy` becomes the signed-in user**, replacing `env.OPERATOR_NAME` at its 6 call
  sites across `actions.ts`, `scripts/send.ts` and `lib/env.ts`. A real improvement to
  the audit trail: `override(target-replied):tabish@dashmani.com` rather than a shared
  string. CLI scripts keep a fallback — they have no session.
- **Still `127.0.0.1`.** Auth is not permission to rebind. `pnpm dev` and `pnpm start`
  keep `-H 127.0.0.1`.

---

## Step 1 — Brand outreach

1. **Fix the two unions.** Add `semantic` to `DETECTOR_KEYS`; add a `BRAND_LOOKUP_KINDS`
   export including `UNRESOLVED`; correct both schema comments. **Plus a test asserting
   every registered detector key appears in `DETECTOR_KEYS`**, so the next detector
   cannot drift the same way.
2. **Migration** — hand-written and additive. `npx prisma migrate dev` wants to RESET
   this database (pre-existing drift on `OutreachPair`); use `migrate deploy`, and back
   up `prisma/dev.db` first.
   - `MessageVariant.targetKind` — `'CHANNEL' | 'BRAND'`, default `'CHANNEL'` so all 48
     existing rows stay channel-scoped.
   - `Setting` key `maxNewBrandTouchesPerDay`, default `2`.
3. **Drain discovery** — `pnpm ig:brands --run`, repeatedly, 6s spacing. One `UNKNOWN`
   row to retry. Rate-limit stops are expected behaviour, not failures.
4. **Brand pitch copy** — new `prisma/brandVariants.ts`, media-buying proposition, its
   own pool, `targetKind: 'BRAND'`. Touch-1 is bespoke, built from
   `TargetAccount.discoveredFromCampaignId` → the actual campaign → *"your Royal Canin
   piece with M.O.M last week"*. Reads the **caption**, never the `brands` column.
5. **Three guards:**
   - `targetKind` added to variant selection at `plan.ts:303`, which is
     `{ senderId, enabled: true }` today — unscoped, so brand copy would otherwise
     reach publishers.
   - `MAX_NEW_BRAND_TOUCHES_PER_DAY = 2` in the **pure** governor, oldest-discovered
     first. Protects the *pattern*; `dailyCap` protects the *account*.
   - **Persona gate:** refuse a `BRAND` send while that sender's persona block is
     byte-identical to another sender's. Fails closed.
6. **Per-sender personas (3b).** Plumbing and gate only. All four senders currently
   carry *Kapil Jain, Co-founder, Bollywood Society* — verified in the DB.
   **Do not invent personas.** Tabish supplies the values.
7. **Brands panel** on the dashboard. `view-model.ts:222` filters `kind: 'CHANNEL'`, so
   brands are invisible today. Show discovery source, category, queue depth, enable
   toggle. Pairs stay disabled; enabling is a deliberate click.

Autopilot delivers brand drafts for any account whose `autoSendEnabled` is on — which
is `@tabishmukaddam1` alone, by choice. **No code branches on which account it is**;
accounts graduate one at a time via the existing switch, per CLAUDE.md decision on the
four independent yeses.

---

## Step 2 — Classifier: cutoff, backlog, and a real VB evaluation

### The 1-August cutoff

Applies in **two** places, not globally:

- the classifier, so pre-August posts are never sent to the model;
- `unusedCampaignCount` in the governor, so an old post cannot become new material.

`HOOK_MAX_AGE_HOURS = 72` already subsumes the cutoff for *hook selection*, which is
why a global filter is the wrong shape.

Pre-August posts stay `UNCLASSIFIED`. That is honest: `UNCLASSIFIED` already means
*not judged*, never *organic* — the distinction this codebase has broken twice.

### Draining, staged

```
pnpm ig:classify                    # dry run, free, reports what would reach the model
pnpm ig:classify --run --limit 50   # CHECKPOINT: read the verdicts before trusting 690
pnpm ig:classify --run              # the rest, post-cutoff
pnpm ig:accuracy                    # record the number
```

The checkpoint is load-bearing. If the cache-hit rate falls away from ~86%, something
is interpolating into the system prompt and every call costs **50×** ($0.14/1M against
$0.0028/1M) — silently. Catching that at 50 posts rather than 690 is the point.

### Going deeper: the VB evaluation set

`pnpm ig:accuracy` is held out against **M.O.M**, which discloses with
`#Collaboration`. `@viralbhayani` discloses nothing (0/48 on every structural signal),
and it is where the classifier actually earns its keep. The 96% says nothing rigorous
about it.

Build a **stratified sample** of VB posts for hand-labelling:

- posts the model called `CAMPAIGN`;
- posts it called `ORGANIC`;
- **posts the novelty filter dropped before the model ever saw them.**

That third stratum is the one nobody has ever checked. Stage 1 discards **54%** of
posts for free, was measured 5/5 on M.O.M only, and a paid post lost there is
**invisible and unappealable** — there is no queue it lands in and no number that goes
up. Protect recall over precision: a false alarm becomes a draft a human reads.

Output: real precision **and** recall for VB, plus a measured false-negative rate for
the free filter.

---

## Step 3 — Hosting groundwork, no cutover

Linode is deferred by Tabish's own sequencing — *"we can do this later as well by first
perfecting our code on localhost first."* This step removes the blockers; it does not
move anything.

- **Heartbeat host identity.** Add `hostname` and a per-process boot id. Treat liveness
  as **unknown** — not dead, not alive — when the record belongs to another machine.
  Fixes both wrong directions in divergence 5 above.
- **`SEND_ENABLED`** — env hard floor like `AUTOPILOT_ENABLED`. Misconfiguration must
  fail toward *prepares but sends nothing*.
- **Postgres migration** — written and rehearsed against a scratch database, **not cut
  over**. Do NOT convert the JSON-string columns in the same change. ~750 rows.
- **Linode, documented not built.** Tabish's target is "whatever localhost can do, the
  production site can do" — including connecting accounts via Chrome and sending.
  State the constraint plainly: CLAUDE.md decision 1 requires the **same home
  residential IP**. Driving the profiles from a datacentre IP is the *network* half of
  the identity-continuity problem the design exists to avoid — the device half is
  handled by reusing the profile, the network half is not. `docs/specs/2026-08-03-linode-hosting-plan.md`
  calls VPS sending *buildable* (headed Chrome under Xvfb) with **unquantified** risk.
  Unquantified is not safe, and it is the three revenue accounts at stake.

---

## Traps that apply to this work specifically

- **`pnpm build` while `pnpm start` runs** serves replaced chunks. Stop, build, start.
- **`npx prisma migrate dev` wants to RESET.** Hand-write additive migrations,
  `migrate deploy`, back up `prisma/dev.db`.
- **Never `require()`** — ESM only. Works in the Next bundle, throws under tsx.
- **A `curl` 200 does not mean the page works.** Extract `/_next/static/**.js` and fetch
  each one. Doubly true for step 0: an auth redirect returns 200 on the login page.
- **Verify both directions.** Every guard here — the persona gate, the brand cap, the
  cutoff, `middleware.ts` — gets a test that it fires AND a test that it permits.
  This codebase has an eight-instance history of guards checked only where they pass.
- **"Could not determine X" must never become "X is false".** `UNRESOLVED` and
  `UNKNOWN` exist because of this; the cutoff must not turn pre-August posts into
  `ORGANIC`.
