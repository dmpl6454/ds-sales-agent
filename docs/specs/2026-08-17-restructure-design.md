# Restructure: two target types, one template, binary verdicts, a simpler dashboard

**Date:** 2026-08-17 · **Status:** awaiting approval · **Author:** measured against the live
Postgres and the live Instagram feed, not read off the code.

Eight changes requested by Tabish. Three were questions and are answered here; five are
code changes and are specified here. Everything below that states a number was measured
today — CLAUDE.md's standing rule is to re-measure rather than trust the file, and **six
figures in CLAUDE.md were found stale by this session** (listed at the end).

---

## The three questions, answered

### Q3 — the manual send registered, and it is the only message this system has ever delivered

```
05:09:44 UTC  autopilot.set        ON
05:10:13 UTC  autopilot.set        OFF
05:11:45 UTC  attempt.send.start   @bollywoodchronicle → @crocsindia
05:12:32 UTC  attempt.sent.auto    delivered
```

A real browser-driven send through `sendNow` under the send lock — 47 seconds, consistent
with the measured send time. It passed the composer read-back and the thread delta, or it
would have parked in `FAILED`.

`threadUrl` is NULL and that is **correct, not a defect**: `sendDm.ts:40` documents that
the URL is recorded only when the page navigates to `/direct/t/`, and this system
deliberately opens the composer over the profile instead.

**Consequence nobody has noticed:** `brandTouchCounts.ts:9-12` and CLAUDE.md both still
assert the delivered counter is "permanently ZERO". As of today `delivered_today = 1`.
**The delivered half of the new-brand cap now binds for the first time.** Both comments are
stale and are corrected by this work.

### Q5 — detection is approximately right; the 100+ figure is not possible

Four independent measurements. Full write-up:
<https://claude.ai/code/artifact/3154f55f-2f4c-4f6e-a231-1707f9412424>

1. **Capture is complete.** Live feed fetched and compared shortcode by shortcode: Instagram
   showed 144 posts over 69 hours, we stored 154 for those days, **0 missing**. We hold
   more than the live feed because we keep posts since deleted.
2. **@viralbhayani publishes ~50.1 posts a day, total.** 130,415 lifetime, 15.7M followers,
   and no sibling publishing account (`viralbhayani2` has 19 posts; `viral.bhayani` has 0).
   **100+ paid a day is double everything they post.**
3. **Ground truth, built for the first time.** This channel had 4 labels across 1,005 posts,
   and every accuracy figure in CLAUDE.md was measured on @madovermarketing_mom — where
   `verdictSource` is `rules` on 79 of 79 posts, so **the model never runs there in
   production**. 60 posts, 11 days, four independent passes:

   | pass | paid rate |
   |---|---|
   | live system | 21.7% |
   | independent judges | 23.3% |
   | adversarial, hunting missed paid | 22.0% |
   | adversarial, hunting false alarms | 23.3% |

   Consensus: 13 unanimously paid, 46 unanimously ordinary, 1 split. **True rate
   21.7–23.3% → 11–12 paid posts a day.** Classifier scores **78.6% recall**, **84.6%
   precision** against it.
4. **Stories are unreachable.** `GET /api/v1/feed/reels_media/?reel_ids=…` returns
   `{"reels":{},"status":"ok"}` — HTTP 200 carrying nothing. Reading stories needs a session,
   and decision 4 forbids attaching one to detection.

**Tabish has confirmed the colleagues mean feed posts only. The claim is therefore
measurably wrong by roughly 10×.**

Real weaknesses found, none of which explains a 10× gap:

- 54% of posts judged on caption alone, no footage text read.
- 13% (119 posts) auto-marked ORGANIC by the short-caption rule; the model never reads them.
  84 of those have footage text nobody classified.
- 83 posts carry `frame:call-failed` — footage read, verdict never reached.
- The model never hedges: **0 of 518 ORGANIC verdicts fall below 80% confidence.**

### Q4 — adding handles works, with one real gap

Adding senders and targets from the dashboard works. Connect works (both buttons share
`useConnect` since the 2026-08-07 fix). The gap is **not** adding — it is **discovery**, and
it is quantified under change 1c below.

---

## The five code changes

### 1a. Two target types — a new column, because both obvious mechanisms are traps

Today **nothing prevents messaging a watched competitor.** `routes.ts:42` has four refusals
and none is about target type; `plan.ts:115` enrols every non-retired target as a route.
Measured: @viralbhayani and @madovermarketing_mom each hold **13 attempts and 4 pairs**, with
**6 drafts waiting right now**.

Two mechanisms suggest themselves and both are wrong:

- **`kind === 'CHANNEL'` is not "watched publisher".** `importProspects.ts:332` creates
  messageable prospects with `kind: 'CHANNEL'`. Keying the invariant on kind would silently
  stop messaging every imported prospect.
- **`optedOut: true` is worse.** `judge.ts:150` short-circuits the footage call for opted-out
  targets. Opting out @viralbhayani would **silently disable OCR-driven detection on the
  channel supplying most paid posts**, while leaving caption detection running — a
  half-broken pipeline that looks healthy.

**Decision: add `TargetAccount.role`, `'WATCH' | 'PROSPECT'`, NOT NULL, backfilled inside the
same migration transaction** so no window exists where the default decides behaviour.

| today | role |
|---|---|
| `kind: 'BRAND'` (77 rows) | `PROSPECT` |
| `kind: 'CHANNEL'`, `watchEnabled: true` (2 rows) | `WATCH` |
| `kind: 'CHANNEL'`, `watchEnabled: false` (2 rows, our own retired pages) | `WATCH` |

Enforced in **three** places, because `routes.ts` alone is provably insufficient:

1. `routes.ts` — a fifth refusal, `target-is-watch-only`. Covers every governed creator.
2. `gate.ts` — a new non-overridable stop `TARGET_IS_WATCH_ONLY`, so a draft written before
   this change cannot be delivered. Requires matching entries in `STOP_LABELS`,
   `messages/remedy.ts` and `/rules`, or `tests/stopInventory.test.ts` fails.
3. `onDemand.ts` + the `/` dropdown — `onDemand` is **deliberately exempt** from `routes.ts`
   (`tests/one-route-rule.test.ts:66`) and creates its own pair at line 287, so a person
   could otherwise pick a competitor by hand.

### 1b. Delete the competitor messages

**Measured: 26 attempts to the two competitors — 20 SKIPPED, 6 READY, and ZERO ever
delivered.** Nothing was ever received by anyone, so there is no send history to protect and
the usual "removal never deletes send history" rule is not engaged.

`pnpm ig:prune-pairs` **cannot** do this: `mayPrunePair` refuses any pair carrying an attempt
of any status, and all 8 pairs carry attempts. A dedicated one-off script, dry-run by
default, that: discards the 6 READY drafts through `discardAttempt` (the one writer, so each
is audited), then deletes the 26 attempts and 8 pairs. It refuses outright if it finds any
attempt in `SENT` or `REPLIED` — so it cannot be reused later to erase real history.

### 1c. Handles for untagged brands — extract the name, then VERIFY it

**The gap, measured: 135 of 286 in-window CAMPAIGN posts (47%) carry no @mention at all, and
134 of those 135 do name a brand.** 494 distinct brand tokens across the window against 77
`BRAND` target rows.

The cause is precise: `extractBrands` (`mom.ts:143`) converts an account into a *display
string for message copy* and prefers a clean hashtag over the handle, so `@tilara.india`
becomes `#Tilara`. The handle is discarded at exactly the step that needs it.

**Decision: the model reads the brand name, and the handle is then VERIFIED before it can
become a target.** Never guessed — CLAUDE.md's rule stands, and it has a measurement behind
it (`@royalcanin` 404s). Flow:

1. For a CAMPAIGN post with no resolvable @mention, ask the model for the advertiser's name
   (reuses the existing `decideBrand` model and its constant system prompt — no new cost line).
2. Generate candidate handles from the name, and **confirm each against
   `web_profile_info`**. A 404 is a dead end, not a target.
3. A confirmed profile then goes through the *existing* `resolveBrand` / `decideBrand` path,
   so the BRAND-vs-PERSON judgement, the confidence floor of 90 and `'unsure'` are unchanged.
4. Anything unconfirmed is **surfaced, never guessed**.

Runs from a home IP only — Instagram 429s the Linode on the profile endpoint (measured, 59
targets from the Mac vs 0 from the server).

**Stated plainly: there is no accuracy harness for brand resolution, so this widens an
unmeasured surface.** The verification step is what keeps it safe; the confidence floor is
not evidence that confident answers are right.

### 2. One template — and the change that would have blocked every send

**The blank line is one array element.** `render.ts:406`:

```ts
const parts = [
  buildGreeting(target),
  ...(hookLine ? ['', hookLine] : []),
  '',            // ← joined with '\n', this is the blank line after "Hi …,"
  body,
```

**THE TRAP, MEASURED BY EXECUTION.** `matching.ts:64` is `kept = kept.slice(1) // the
greeting` — it drops the first prose line **by position, not by pattern**. So merging the
greeting into a **single-paragraph** template destroys the needle entirely, and
`distinctiveSlice` returning null means every send is refused. **A one-paragraph template
would take the whole system down**, and it would look like a sending outage rather than a
copy change.

**The template must therefore keep at least two prose lines after the merged greeting
line.** Tabish's copy has four, so this is satisfied — but it is now a tested invariant, not
an accident.

Second measured finding: **`bodyAppearedSince` is SAFE with byte-identical bodies.** It
compares occurrence counts across two reads (`count(after) > count(before)`), verified in
both directions. The intuitive worry is unfounded.

**Third, and this one is a real defect that must be fixed in the same change:
`readThread.ts:293` counts MEMBERSHIP per body, not occurrences.** With identical bodies, one
visible bubble satisfies all N messages we sent, so a partial read reports `complete: true`
and **vouches for silence it never verified** — the "a successful read can be a partial read"
bug returning through a different door. Fix: count occurrences, not membership.

The template, with the greeting merged and no blank line:

```
Hi {Brand}, I'm Kapil Jain, Co-founder of {Sending Channel}.

We're a Bollywood and paparazzi network doing over 30 crore (300M) views a day, and we
work with film studios and entertainment brands on year-round visibility rather than
one-off campaigns.

I'd like to explore an annual collaboration covering your releases, trailers, music
launches and celebrity moments across our owned pages.

Could we find 20 minutes for me to walk you through a tailored plan?

Looking forward to connecting.

Kapil Jain
Co-founder, {Sending Channel}
+91 60000 189766
kapil@digitalsukoon.com
```

Only `{Brand}` and `{Sending Channel}` vary. Notes:

- Shorter than the supplied draft, as Tabish invited ("can be wayyy shorter").
- The variant pools are **kept, not deleted** — `compose.ts:249` reads the pool and throws
  `NoVariantsError` *before* the template branch, so deleting them breaks composition
  outright. The variant is still claimed so the per-pair machinery keeps working.
- Every figure in it is already in the quality gate's allowlist.
- `usableBrandName` still governs the greeting: a brand with no real name gets "Hi there,"
  rather than an invented one.

### 6. Binary verdicts — and the one thing this forces

**Measured: 26 REVIEW rows live. 18 exist ONLY because the footage flagged them. The
confidence band that also produces REVIEW has never fired — 0 rows carry
`downgraded:confidence-below-70`.**

Abolishing REVIEW forces a decision the codebase has deliberately refused: `applyFrameSignal`
lets footage raise ORGANIC→REVIEW and *nothing else*, precisely so a frame-driven CAMPAIGN is
never minted. Remove REVIEW and `frame:says-campaign` has nowhere to land.

**Decision, and it matches Tabish's instruction exactly: footage-flagged posts become
CAMPAIGN.** A post is paid or ordinary; the footage flagging it makes it paid; the cross
button is how a person says otherwise. This trades precision for recall, which is the
direction this project always chooses — *"a missed paid post is invisible and unappealable, a
false alarm becomes a draft a human reads."*

- `applyFrameSignal` keeps its permission table but its escalation target becomes CAMPAIGN.
- The `Verdict` union loses `'REVIEW'`; the `never` bindings make the compiler name every
  site. Existing REVIEW rows migrate to CAMPAIGN.
- `review.tsx` ("Worth a look", the two buttons) is deleted. `verdictLabel`'s
  `'borderline — worth a look'` goes.
- **One control: a cross on each detected paid post**, meaning *this was ordinary*. It calls
  `labelPost(shortcode, false)` — still the one writer.

**THE CASCADE GAP, and it is the most actionable finding in the audit.** `labelPost` sets
`verdict: 'ORGANIC'`, which cascades automatically to five consumers that all query
`verdict: 'CAMPAIGN'` (`unusedCampaignCount`, `pickHook`, `autoResolve`, `render.ts:265`,
the nav badge). **It does NOT reach the 74 BRAND targets holding
`discoveredFromCampaignId`.** So dismissing a post today leaves prospects discovered from it,
and a draft can still cite a placement a human has said was not paid. The cross must also:

- refuse to create new prospects from that post, and
- flag any prospect whose *only* provenance was that post.

**What this costs, stated honestly.** Dismissal-only labelling makes the accuracy harness
structurally unable to measure recall from human answers — every new label is a negative.
Measured today: **26 human labels, of which 1 is positive.** Recall measurement continues via
M.O.M's `#Collaboration` ground truth and via sampled audits like the one run today; the
`--repeat 3` harness still works. This is a real trade and should be a recorded decision.

**The 21 poisoned labels.** A bulk write on 8 August set `paid=false` on 21 posts in one
second, including both founding cases of the footage feature. Removing "This was paid"
removes the only control that could restore them. **Proposal: clear all 21 in this work** —
they were never judgements about their posts — letting each return to its model verdict.
This needs Tabish's explicit yes, because they are his rows.

### 7. The cap — and a correction to what throughput is actually limited by

| cap | value | enforced | ceiling |
|---|---|---|---|
| `MAX_PER_TARGET_PER_DAY` | 2 | `governor.ts` | per recipient |
| `MAX_SENDS_PER_TICK` × 15-min ticks | 1 | `pacing.ts` | 44/day |
| **`FLEET_MAX_PER_HOUR`** | **3** | `pacing.ts` | **33/day — binds first** |
| `FLEET_MAX_PER_DAY` | ∞ | — | none |
| `MAX_TOTAL_SENDS` | unlimited | `plan.ts` | none |
| **`maxNewBrandTouchesPerDay`** | **2** | `plan.ts:561` | **2 new companies/day** |

**Correction to a claim made earlier in this session.** The new-brand cap is not the whole
story. It caps **draft creation** in the planner, not delivery — it is absent from
`gate.ts`'s `RESEND_BLOCKS`. And today the actual binding constraint is not a cap at all:

- `autopilotEnabled = false`, so nothing sends unattended (`dispatchState` reads
  `{"action":"hold","reason":"autopilot-off"}`);
- **only @bollywoodchronicle holds an Instagram session.** @bollywoodsocietyy and
  @madaboutmarketingg have none.

**So raising the cap alone will change nothing, and will look like the change failed.**

Change: `maxNewBrandTouchesPerDay` **2 → 10** (a `Setting` row; the settings form already
allows up to 20). Clears the 61-company backlog in ~6 days and stays under the 33/day fleet
ceiling. `FLEET_MAX_PER_HOUR` stays at 3 — 10/day fits comfortably inside 33/day.

Not raised, deliberately: `MAX_PER_TARGET_PER_DAY` is the only rule that sees a recipient's
total across all senders, and `env.ts:60` is `intish(1, 1, 10)` — **setting it above 10 in
`.env` throws at startup and takes the dashboard down.**

Made visible: one line on the landing page — *"N of 10 new companies contacted today ·
M waiting"* — replacing the per-recipient "Today's allowance" block, which duplicates a gate
stop whose remedy is deliberately `href: null`.

### 8. A dumb dashboard

Measured on the landing page: **8 direct children, 11 blocks, ~26 always-on prose blocks, and
90–120 discrete numerals on a live day** — against **6 controls**. The pace panel alone
renders 10 numbers and 0 controls.

Delete outright, zero safety loss:

- `src/app/messages/dispatcher.tsx` — **182 lines with no importer anywhere.** Dead.
- "Today's allowance" — duplicates `TARGET_DAILY_CAP`, whose remedy is intentionally no-op.
- The 7 fields `buildTodayView` returns that the page never reads, and the
  `replyCoverage`/`sentToday` computations `/` does not render. These are paid for in queries
  against the 520-query budget.

Collapse, not delete — **CLAUDE.md is emphatic that "nothing happened with no explanation" is
the failure this project keeps rediscovering**, so explanations stay reachable:

- The landing page becomes: **the switch · one health sentence · the single most important
  blocker · the draft queue · the cap line.**
- Each draft row keeps its refusal sentence **on the collapsed row**, not inside an expander —
  the 2026-08-06 measurement found all four waiting drafts would have been refused by a
  button that said nothing.
- The pace detail, the full blocker list and the allowance move to `/rules`, which already
  exists for exactly this.
- Keep the dispatcher's one-line last-tick sentence — it is the only place "autopilot is on
  and nothing has gone out" is explained.

Constraints any UI change must satisfy: `src/scripts/layout.ts:66-77` hardcodes each path,
its exact `H1` and a query budget and **fails rather than skips**; `tests/shell.test.ts`
requires ≥6 authenticated pages; `tests/stopInventory.test.ts` requires every stop to remain
reachable with a remedy.

### 6b. Remove our own pages from every screen

**Scope correction from the audit:** only **two** of the four accounts exist as targets —
@bollywoodchronicle (937 posts) and @bollywoodsocietyy (802). @tabishmukaddam1 has no target
row; @priyanshu123321123 has no row in either table. Both existing rows are **already**
`optedOut: true, watchEnabled: false`, so no new posts arrive.

**The problem is not the rows, it is that not one `DetectedCampaign` query on the dashboard
filters by channel.** Measured: their 1,555 in-window posts are **59.6%** of every figure on
`/paid-posts`; 37 of their posts render as paid findings; and **5 of the 26 open review rows
are @bollywoodsocietyy** — which is exactly the complaint.

**Decision: exclude, do not delete.** Deleting the two rows cascades away **1,739
DetectedCampaign rows that can never be re-scraped** (the feed is a 48-deep window) and
destroys 9 human labels. It also risks the fatal mistake here: the same handles exist as
**SenderAccount** rows with different ids, and deleting those cascades 158 attempts and the
accounts that send.

Mechanism: one shared predicate — `visibleChannels()` — applied at the ~12 query sites, with
a source grep test asserting no `DetectedCampaign` dashboard query omits it. A per-site fix
would recreate the one-rule-many-callers drift this codebase has now found five times
(`gate.ts`, `readThread.ts`, the two Connect buttons, `judge.ts`).

---

## Order of work

1. `readThread.ts` occurrence-count fix — **must land before or with the template**, or the
   reply guard silently stops working.
2. `role` column + migration + backfill; the three enforcement points.
3. Delete competitor messages (dry run, then run).
4. The template + the ≥2-prose-lines invariant test.
5. Binary verdicts; delete `review.tsx`; the cross; the cascade fix.
6. `visibleChannels()` + the source-grep test.
7. Cap 2 → 10 and the one-line UI.
8. Dashboard simplification.
9. Untagged-brand discovery (last — it widens an unmeasured surface).

Nothing is deployed to the Linode by this plan. `ig:dedupe-drafts` and `ig:prune-pairs`
still wait on a deploy, per the standing ordering trap.

## CLAUDE.md figures found stale today

| file says | measured 2026-08-17 |
|---|---|
| "nothing has ever been delivered" | **1 delivered** (crocsindia, 05:12 IST) |
| 68 BRAND targets | **77** |
| 22–26 waiting drafts | **52** |
| 65 in-window `frame:call-failed` | **83** |
| 98% correct / 100% recall as the headline | measured on the channel where the model **never runs**; the real channel scores **78.6% recall** |
| @viralbhayani "never discloses" | still true: `is_paid_partnership` **0/144** |
