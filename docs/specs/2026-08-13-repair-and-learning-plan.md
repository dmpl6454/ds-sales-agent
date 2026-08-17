# The repair plan, and the learning loop — 2026-08-13

Every item below has a measured root cause recorded in CLAUDE.md under "THE 13 AUGUST
FINDINGS". This is the work order. Read that section and this file together.

**THE RULE THAT OVERRIDES THIS WHOLE DOCUMENT: do not sabotage detection.** Paid-post
detection is working — 97% correct, 100% recall on the one channel with ground truth, 223
paid posts found. Every phase here is ordered so that nothing which could lower recall
happens before the harness that would notice. If a step cannot be measured, it does not ship
on by default; it ships behind a `Setting` row that is off, the way `generateMessages`,
`singleTemplate` and `tagsAsEvidence` did.

---

## The sequencing constraint that decides the order

The audit log shows two `sender.connect.start` events for `@bollywoodsocietyy` today. **The
moment a second account is signed in, the rotation defect stops being theoretical**: six
recipients already hold a draft from all three senders, and `MAX_PER_TARGET_PER_DAY = 2`
permits two of them to be delivered to one inbox on one day, from two pages carrying an
identical phone number and email.

So Phase 1 is the rotation fix, and it must land before Autopilot is turned on with two
signed-in accounts. Everything else can follow.

---

## Phase 0 — Losses that are still accumulating (do first, no behaviour change)

**0.1 Capture the 804 recoverable cover frames.** MEASURED: 2,368 in-window posts, **429
have a frame**, 1,939 do not, and of those **804 still have a live URL** while **1,135 can
never be recovered**. A frame is the only evidence for a placement that lives in the video.
Run `pnpm ig:frames --capture` (costs bandwidth only, ~36 MB), then make it part of the
detect pass so the window never opens again — bounded per pass so it cannot become a burst.

**0.2 Decide about `@bollywoodchronicle` and `@bollywoodsocietyy`.** You turned watching off
for both at 13:41 IST today. That is a legitimate cost saving, and it has a consequence worth
choosing deliberately rather than discovering later: those are the two channels CLAUDE.md
calls ground truth — *"watching our own pages is ground truth, not prospecting"* — because
they are the only channels where we know what we actually paid for. With watching off their
labelled set stops growing, and Phase 6's harness loses its only non-M.O.M source. **Do not
silently re-enable.** Surface the trade-off on `/targets` and let it be a choice.

---

## Phase 1 — Rotation: the exposure fix

**Root cause.** `whoseTurn()` returns `null` for a target in no group; both call sites are
`if (turn && …)`, so null means *no rotation at all*. `Category` has 0 rows and always has.
The ring mechanism itself is correct and tested — it starts after the last sender who wrote
and skips whoever cannot send, which is exactly the intended behaviour.

**1.1 Make "no group" mean ONE sender, not every sender.** This is the whole fix and it is
small. When a target belongs to no group, the fleet itself is the ring: order senders
deterministically, pass the same `unavailable` map, and let `nextSender` choose one. A target
in a group keeps using that group. Net effect: one message per recipient per pass, and the
next account takes a turn only when the first cannot — with no configuration required.

- `src/outreach/categories.ts` — `whoseTurn` returns a choice built from the fleet ring when
  no `CategoryTarget` exists, instead of `null`.
- Keep the `null` branch impossible to reach by accident: make the return type carry the ring
  it used (`'group'` | `'fleet'`), so `/messages` can say *which* ring skipped a sender.
- **This is a behaviour change to who gets written to, so it needs a test per direction:**
  one sender chosen when all three are able; the next chosen when the first has no session;
  `all-unavailable` when none can send; and the existing group path unchanged.

**1.2 Clean up the 8 duplicate recipients already queued.** 6 recipients hold three drafts
and 2 hold two. Do NOT mass-discard — `SKIPPED` drafts burn the campaign pool (documented).
Keep the draft from the sender rotation would have chosen and discard the rest through the
ordinary discard path, so each removal is audited.

**1.3 Say it on screen.** `/messages` and `/targets` currently imply rotation is happening.
Each waiting draft should be able to say *"@x is next for this recipient"*, from the same
function the planner asks — never re-derived.

**1.4 Restore a way to see and set groups.** The UI was removed 2026-08-07 for being
confusing, which was fair, and the result was a mechanism nobody could reach. It does not
need to come back as a per-row control: one line per recipient on `/targets` naming which
account is next is enough, plus the ability to put a recipient in a named group when someone
wants to. `setTargetCategory` already exists in `actions.ts`, is called by nothing, and
revalidates `/prospects` — a retired stub. Fix the revalidate path or delete the action.

---

## Phase 2 — Message accuracy, end to end

**2.1 A handle must never reach prose.** `BrandFirstTouchInput.brandName` is documented
*"Never a handle"* and nothing enforces it. MEASURED: `@agoracitycentre` and `@ahambysenco`
have their own handle as `displayName`, so the pitch reads *"I saw agoracitycentre's
placement…"* — twice per message.

- A pure guard (`usableBrandName`) that refuses a value equal to the handle,
  case-insensitively and ignoring separators, and refuses a value that is only the handle
  prettified. On refusal the pitch **degrades to the opening that names no placement** —
  that path already exists and is tested.
- Assert it at the boundary rather than trusting the caller: `brandPitch` should not be able
  to render a handle even if one is passed.
- Same guard for the greeting. `greetableName` already trims, and it cannot save this.

**2.2 A person is not a company.** `@absolutejk` resolved to BRAND with `displayName`
*"Jignesh N Khatiwala"*, and the draft opens **"Hi Jignesh N Khatiwala team,"**. The
confidence floor cannot catch it because the model was confident.

- Treat a person-shaped `displayName` (two or three capitalised words, no company token) as
  **evidence against** a BRAND verdict: downgrade to `UNRESOLVED`, which never becomes a
  recipient. `reasonSubject.ts` already does subject-traceability; this is the same idea one
  field along.
- Re-examine the 68 existing BRAND rows with this guard before any of them is written to, and
  report rather than auto-delete — a wrong retirement costs a real prospect.

**2.3 A frozen body must not carry a decaying claim.** Bodies are rendered at draft time and
`describeRecency` bands `days <= 10` as *"last week"*. The Amazon draft was 9 days old when
written and has not moved since. When Autopilot goes on, drafts written today would send
"last week" about placements weeks old.

- A gate stop — `HOOK_STALE_SINCE_DRAFT`, alongside the existing
  `PERSONA_CHANGED_SINCE_DRAFT` — that refuses when the recency band the body asserts is no
  longer the band the campaign's age would produce. Refuse rather than silently re-render:
  the stored body is what the send guards compare against, and an operator may have edited it.
- `remedy.ts` needs a sentence and a destination for it, and `tests/stopInventory.test.ts`
  asserts every stop has both.

**2.4 Read the queue before anything is sent.** All 22 drafts should be read once by a person
after 2.1–2.3 land. Tests assert what someone thought to assert; reading found all three of
these.

---

## Phase 3 — Performance, frontend to backend

**Root cause.** 174 queries per dashboard render, each ~28–37 ms across the SSH tunnel (raw
ping 4.4 ms; concurrency barely helps because SSH multiplexes one TCP stream). 145 of them
come from `buildBrandsPanel`, which reads every BRAND target with **no limit** and then runs
**two serial queries per brand**. On SQLite at ~1 ms this cost 0.2 s and was invisible;
hosting made it a 10-second page, and it grows with every brand.

**3.1 Kill the N+1.** One `groupBy` for the per-brand sent counts, one `findMany` for the
campaign publishers, joined in memory. Target: `buildBrandsPanel` under 5 queries regardless
of brand count.

**3.2 Bound the panel.** `take` with a stated total, like the posts table already does
(*"showing the newest 100 of 223"*). An unbounded list is a page that degrades silently as
the system succeeds.

**3.3 Index the substring scans.** Five `signals LIKE '%frame:…%'` counts at **223 ms each**
on `/paid-posts`. Either a real index, or — better — stop encoding a set in a JSON string
that gets substring-matched five times per render. A small `frameOutcome` column with the
five states would make the query trivial and the five-state distinction explicit.

**3.4 Add a query budget to the layout check.** `pnpm ig:layout` asserts geometry; it should
also assert that no page exceeds a query count, so the next N+1 fails a check rather than
being noticed months later. This is the only item here that prevents recurrence.

**3.5 Say which database and how far away.** `pnpm local` already names the database. It
should also report the measured round-trip, so "the dashboard is slow" is diagnosable without
a profiler.

---

## Phase 4 — The two limits that do not mean what they say

**4.1 Decide what the drafting cadence should be, then make one path.** `detectThenDraft`
gates drafting on `autopilotEnabled`; `runSlot` drafts unconditionally. The slot path matches
the product — a draft with Autopilot off is the intended state. So the gate is wrong, and
removing it makes drafting 96×/day instead of 4×.

**That is a real increase in drafting volume and must not be shipped blind.** Drafting is
free of Instagram risk (it writes rows, it does not contact anybody) but it is bounded by
4.2 below, and an unbounded draft queue has its own cost — every draft is a frozen body with
a decaying claim (2.3). Ship the gate removal **and** 4.2 together, or not at all.

**4.2 Make the new-brand cap mean what it says.** `newBrandTouchesToday` counts DELIVERED
messages; nothing has ever been delivered, so the persistent half is permanently 0 and only
the per-run counter binds — "2 a day" is really "2 a run".

- Count **first touches CREATED today** as well as delivered, so the cap bounds the queue and
  not just the send. Two facts, two counters, both named — do not merge them into one number.
- Surface both on `/rules`, from the module that enforces them.

**4.3 The burner holds 70 pair rows.** `@tabishmukaddam1` is `fleetMember: false`, and
`runOutreach` scopes to fleet members, so those routes are inert — but since 2026-08-08 a
pair row *is* a live route, and 70 of them exist for the one account that must never do
outreach. Belt and braces held; remove them anyway, and assert no non-fleet pair can exist.

---

## Phase 5 — Ready for more channels (do before connecting any)

**5.1 A new channel currently judges NOTHING.** `addTarget` sets
`detectorKey: 'passthrough'`, which stores posts and judges none. That was the honest default
when `mom` was the only alternative — a hand-written rule set for one publisher's convention.
It is now the wrong default, because `semantic` is general and measured. **Connect a channel
today and you get posts stored, zero paid posts found, and a card that says "not
classified".**

- Default a new CHANNEL to `semantic`, and let the add form say what that costs (a fraction
  of a cent a post) and what it does.
- Keep `passthrough` reachable, because a channel we own and do not want judged is a real case.
- `/targets` should never show a watched channel on `passthrough` without saying that nothing
  is judging it.

**5.2 Detection cost is per channel and must stay visible.** ~4 pages per channel per pass at
15-minute cadence is ~380 requests/channel/day against an undocumented anonymous endpoint.
`/targets` already shows requests per slot; it must scale that number to the real cadence and
say the daily figure, because the risk here is a 429 that blinds detection entirely.

**5.3 Per-channel vocabulary already scales correctly** — `buildVocabulary` is per target and
learns from every stored caption. Nothing to do, but do not break it: shrinking the corpus
would make ordinary words look novel.

**5.4 A new channel has no ground truth.** This is what Phase 6 is for. Until a channel has
labels, its accuracy is *unmeasured* — and the dashboard must say so rather than showing a
number borrowed from M.O.M.

---

## Phase 6 — Does it learn? No. What to build so it does.

### What was measured

**The system does not learn anything from its mistakes today.** Six specific gaps:

| | |
|---|---|
| Human answers feed nothing | `humanLabel` is read only to filter the queue and to skip re-judging. **`ig:accuracy` scopes to `verdictSource: 'rules'`, so human answers are structurally excluded from the only harness.** |
| A second ground-truth set is dead | `KnownPaidPost` — 33 shortcodes you supplied — is read by **no code at all**, and 0 of 33 are in the corpus. |
| No post is re-judged when evidence arrives | Frames banked later and tags refreshed later change nothing. `pnpm ig:ocr --reclassify` by hand is the only path. |
| Accuracy is measured where the model does not run | M.O.M is `verdictSource: 'rules'` on 63 of 63 in-window posts. @viralbhayani supplies most paid posts and has no ground truth. |
| The one adaptive component is inert | `noveltyScore` learns each channel's vocabulary; its only consumer is a branch that is unconditionally true. Scores are recorded and read by nothing. |
| Disagreements are not mined | 8 posts exist where a person contradicted a model that was confident. Nothing looks at them. |

### What "learning" can honestly mean here

We cannot fine-tune `deepseek-v4-flash`, so reinforcement learning in the gradient sense is
not available. What *is* available is a closed loop that gets measurably better, and the
critical constraint is this: **the prompt must never be edited automatically from labels.**
Two documented attempts to improve it by hand moved the numbers the wrong way — one dropped
recall to 87%, one cratered precision 85% → 71%. An automatic version of that is the single
most dangerous thing that could be built here.

So the loop is: *labels accumulate automatically → the harness scores automatically → a
candidate improvement is proposed automatically → a person promotes it, and only if the
harness says recall held.*

**6.1 One labelled set, three sources.** A `labels` view over: M.O.M's `#Collaboration`
disclosures (a fact), human answers (`verdictSource: 'human'`), and `KnownPaidPost` (yours).
Each row carries its provenance, because a hashtag and an opinion must never be added
together silently — that is what `verdictSource` already exists for.

**6.2 `pnpm ig:accuracy` scores ALL of it, per channel.** Today it scores one channel and
excludes human labels. It should report a block per channel with its label count and its
source mix, and say **"unmeasured"** where a channel has no labels rather than borrowing a
number. This is the instrument everything else depends on; build it first.

**6.3 Backfill `KnownPaidPost`.** 0 of 33 are in the corpus and their captions cannot be
fetched anonymously. Ask which of our pages posted them and reach further back on those
feeds; 33 known-paid posts would roughly triple the paid ground truth.

**6.4 Re-judge when the evidence changes, automatically and bounded.** A frame banked after a
post was judged, or a tag added after publication, is new evidence about a settled verdict.
Re-judge those posts on the detect clock, bounded per pass, **never overriding a human
answer**, and only ever through `judgeWithFrame` so the permission table still applies. This
is the fix for the same shape of bug as the 166 unread frames: evidence captured and never
used.

**6.5 A disagreement queue.** Where a person's answer contradicts a confident model verdict,
that pair is the highest-value item in the system: it is a measured error with a known correct
answer. Surface them on `/paid-posts` as their own list. These are the rows a future exemplar
is drawn from.

**6.6 Learn by curated exemplars, gated.** The safe lever on prompt quality is few-shot
examples drawn from confirmed errors. Mechanics that keep it safe:

- Exemplars live in a **module-level constant**, so the cached prefix stays byte-stable — the
  discount is 50× and a prefix miss is silent and permanent.
- A command proposes candidates from the disagreement queue; **a person promotes them.**
- Promotion is gated on `pnpm ig:accuracy` before and after, on **every** channel that has
  labels, and **recall must not fall on any of them**. Precision improving is the goal.
- Ship the whole thing behind a `Setting` that is off, and record turning it on as your
  decision — the same shape as `tagsAsEvidence`.

**6.7 Report the trend, not a snapshot.** Store each harness run so accuracy over time is
visible. A single number cannot show whether the loop is working, and "it feels better" is
what this project has repeatedly found to be wrong.

### What must NOT be built

- No automatic prompt editing. See above.
- No re-judging of human answers. A person's answer is the highest authority and re-judging it
  would destroy the only ground truth for video-only placements.
- No treating tags as a rule. Measured twice: 85% → 71% once, and 90% → 83% this week.
- No accuracy figure quoted as coverage. It measures what a caption can reveal.

---

## Phase 7 — The poisoned ground truth (your decision, not a code change)

21 posts were bulk-labelled `paid=false` on 2026-08-08 by a script no longer in the repo,
including **both founding cases of the footage feature** — the Thane bus (`SWITCH` on the
bumper) and `Dbuk-oez_C0` (`SONY | INDIAN GAME SHOW`). They are now this system's ground
truth for "not paid", and Phase 6 would train on them.

They are visible and correctable on `/paid-posts` → "Answers you have given". **Nothing should
rewrite them automatically.** Phase 6.2 must not ship until they are settled, or the harness
will be measuring against known-wrong labels.

---

## Verification, every phase

```
pnpm typecheck
pnpm test                    # 1,281 today; must not fall
pnpm build                   # never while a server is on :3100
pnpm ig:layout               # geometry AND, after 3.4, a query budget
pnpm ig:accuracy             # recall must stay 100%; run before AND after any prompt change
pnpm ig:detect               # one real pass; read the log, not just the exit code
```

Plus, every phase: **read the rendered page and the real message bodies.** Every one of the
five findings this plan exists to fix was invisible to 1,281 passing tests.
