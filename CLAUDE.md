# CLAUDE.md — DS AI Sales Agent

Instructions for anyone (human or model) working on this repo. Read this before
changing anything that touches sending.

---

## VERIFIED ONLY — THE ADMISSION RULE FOR EVERY RECIPIENT (2026-08-20, TABISH, PERMANENT)

**Read this before adding any path that creates a target or sends a message. It is one
sentence and it outranks convenience everywhere.**

> *"No message is to be sent to any target that are unverified. … A simple rule, we cannot
> lose leads in posts with no tags, so we discover valid verified instagram accounts and add
> them as target and message them."* — Tabish, 2026-08-20

**A recipient is messageable only if Instagram shows the verified badge.** That is the whole
rule, and it is enforced at BOTH ends like every load-bearing rule here:

| | |
|---|---|
| `governor.ts` → `TARGET_NOT_VERIFIED` | refuses to WRITE a draft, so the queue never fills with permanent holds |
| `gate.ts` → `RESEND_BLOCKS.TARGET_NOT_VERIFIED` | refuses to SEND, catching every draft written before the rule |
| **NOT overridable** | absent from `OVERRIDABLE_BLOCKS`, with a test asserting the override is inert. Every stop a human may cross is about TIMING; this one is about WHO the recipient is, and "I know something the agent does not" is not an argument about whether an account is the company it appears to be |

**`isVerified: null` IS REFUSED, AND THAT IS THE DESIGN.** "We never looked" is not
"verified" — absence of data hardening into a positive verdict is this codebase's
most-repeated defect, and this is the one place it must not happen. The cost of refusing
NULL is paid at CREATION instead: **`createBrandTarget` enriches every new row** so the fact
exists at birth, and `pnpm ig:audit-targets --run` backfills. A NULL therefore means a row
predating both — visible and fixable, never a silent send.

**WHY THIS RULE EXISTS, measured:** `@lego.mybrickhouse` — display name *"My Brickhouse"*,
unverified, no category — received a real media-buying pitch from a revenue account at
11:09 IST, **two minutes after the genuine `@legoindia_official` ("LEGO India", verified) at
11:07.** A professional account with nothing else known falls to `classifyProfile`'s business
branch and becomes a BRAND. Absence of data becoming a verdict, one door along.

**THE SAME BAR NOW GOVERNS BOTH ADMISSION DOORS, and both size fallbacks were DELETED
rather than left unreachable** — they required a follower count `enrichHandle` never returns
(see below), so they were dead code that read like a second way in:

- `admitsAsTalent` (celebrities on CAMPAIGN posts) — **badge only**.
- `isOfficialMatch` (official pages for untagged posts) — **badge AND a name covering every
  token of the brand name**. The @philips / "Philips India" trap is still a permanent
  fixture: a badge on the WRONG account passes every existence check, and only the name test
  stops it.

**AND THE LEAD-RECOVERY HALF RUNS ITSELF, which is what makes the rule affordable.**
Refusing unverified accounts would lose leads if nothing replaced them, so
`discoverOfficialPages` (`src/detection/officialDiscovery.ts`) works the **172 measured
in-window CAMPAIGN posts that assert no handle at all**: brand names from the caption, then
OCR frame text → candidate handles → the badge bar → a prospect. It runs on the **device
agent's brand timer, 5 lookups every 30 minutes**, sharing the throttled profile endpoint
with `autoResolveBrands`, on the home IP where that endpoint answers. It is a FUNCTION
shared with `pnpm ig:find-official`, not logic inside the script, because *a feature that
works only when someone runs a command is not running* — this repo has paid for that twice.
Anything resolving but failing the bar is REPORTED for a person (`--accept`), never guessed.

`tests/verified-only.test.ts` is the future-proofing and is deliberately three kinds of
check, because the rule can be lost three ways: behaviourally at both enforcers in both
directions (including NULL), structurally as a source grep over the creators and the
automatic path, and as the overridability invariant.

**THE DATA STATE THIS LEFT:** 18 unverified prospects retired (all had delivered history, so
retired and never deleted — `optedOut`, the promise that survives every feature), the 20
drafts aimed at them discarded through the one writer with an audit row each, and the live
list is now **74 prospects, 74 of them verified**. If a retired brand's verified page is
later discovered it arrives as a NEW row on the correct handle — the lead is re-acquired
properly rather than kept on a handle we could never confirm.

---

## 22 AUGUST — "NOT SENDING EVERY MINUTE" WAS TRUE, AND CHASING IT FOUND THE QUEUE'S REAL LID

**Tabish: *"What is the health of the system, autopilot is not sending every minute (monitor
and verify this claim)."*** Verified, and it led to two defects of the same family, one of
them the reason the queue kept emptying.

### THE PERIOD WAS 77 SECONDS BECAUSE THE POLL SLEPT *AFTER* THE SEND

473 consecutive live intervals: **min 73s, p50 77s, p90 81s, 439 inside 90s.** A
distribution that tight is an equation, and the loop was the equation:

```
while (!stopping) { await tick(); await sleep(POLL_INTERVAL_MS) }   // 47s drive + 30s = 77s
```

The sleep is **additive to whatever the tick just did**, so `fleetMinGapMinutes = 1` could
not produce a one-minute cadence at ANY value — the loop added half a minute after the gap
had already been satisfied. **This is the defect fixed one layer up the day before** (the
fleet gap measured from a send's completion instead of its start) surviving inside the sleep
that wraps it, and `agent/index.ts`'s own docblock asserted the opposite — *"at 30s the gap
is what paces the fleet rather than this timer"*. **A false invariant in a comment, twice in
two days: it is why nobody looked.**

The loop sleeps only the **REMAINDER** now, which is structural rather than a smaller magic
number: after a 47s send the remainder is zero, the loop returns at once, and `dispatchTick`
— which still refuses anything inside the gap of the last send's START — is what decides,
exactly as that docblock always claimed. Idle ticks still wait the full 30s, so polling gets
no busier. **It cannot send faster than the gap**: the gap is a refusal inside the tick, not
a property of this sleep. `tests/poll-is-a-period.test.ts` is behavioural because a grep
passes against BOTH shapes, and it was mutation-tested by restoring the additive line.

**AND THE REMAINDER ALONE WAS STILL 77s — MEASURED THE SAME DAY, ONE INTERVAL, DETERMINISTIC.**
The first two post-fix sends were 77s apart. The additive sleep was gone; **the GRID
remained**: a ~47s drive puts the immediate next tick at +47s — held, 13 seconds before the
60s gap clears — and the following 30s-grid tick at +77s. Period = drive + grid-overshoot,
not max(drive, gap). *"Expected ~60s"* had been written in this file without walking that
arithmetic, and it is left corrected here rather than erased: **predicting a period from a
fix without composing the actual timeline is how both 77s bugs shipped.** The finish:
`dispatchTick` returns **`retryInMs`** on a `too-soon` hold — when the gap clears, computed
from the SAME clock the refusal read — and the loop sleeps exactly that, consumed with
`min()` so a hint can only ever wake the loop EARLIER than its grid. The boundary tick
re-asks every rule, so nothing can send faster than the gap. Composed period:
**max(drive, gap) = 60s** at the current setting.

### AND THEN: EVERY PROSPECT WAS CAPPED AT ONE MESSAGE PER PAGE, FOREVER

The cadence explains the rate when there IS a queue. The queue was EMPTY — 4 drafts, all
held — so the second half of the question was why. **40 recipients had allowance room and
every one was refused by every sender.**

`DetectedCampaign.targetId` is **the channel that POSTED**, never the brand named in the
post. So `count({ targetId: <recipient> })` is zero for a prospect, always — and that query
existed in **FOUR** places. The allowance's own copy was fixed on 21 August (it had made the
unlock half of Tabish's rule unreachable and the fleet went quiet at `skipped=851 queued=0`).
**The other three were not, because nothing compared them:** `plan.ts` inlined it (the
production path), `compose.ts` in `unusedCampaignCount` AND `pickHook` (the on-demand path),
and `scripts/generate.ts` + `scripts/preview.ts` — both of which carry comments claiming to
mirror the planner.

**So `NO_NEW_MATERIAL` refused every follow-up to every prospect PERMANENTLY.** Each
(sender → prospect) pair could send exactly ONE message ever — the first touch, exempt by
construction — and never another, however many placements that brand bought.
**@amazonmgmstudios: 17 paid posts naming it inside the window, 5 messages, capped forever.**
*A fail-closed guard with an unsatisfiable precondition is a blindfold wearing a seatbelt* —
third time that sentence has been earned here.

All four now ask **`campaignsNamingHandleRows`**, one linkage returning ROWS so the count and
the hook lookup cannot drift. `unusedCampaignCount` takes the recipient **ROW** rather than an
id — required, so the compiler named every call site, and it costs no extra query.

**MEASURED BOTH WAYS with the real planner on the same corpus, which is the part that made
it safe to ship:**

| | before | after |
|---|---|---|
| `no-new-material-to-reference` | **137** | **0** |
| `target-recently-contacted` (the 7-day ring rest) | 0 | **135** |
| drafts released | — | **2** |

The refusal moved from a rule that COULD NOT PASS to **the rule Tabish actually specified**,
and two drafts released rather than a flood — because the ring rule correctly holds the rest.
That is the shape a blindfold-removal should have. `tests/naming-linkage.test.ts` greps every
`src` file for a recipient id used as `DetectedCampaign.targetId`, with **the variable name as
the carve-out** (in detection `target` IS the publisher and that usage is correct); it found
`generate.ts` and `preview.ts` on its first run.

### THE PLANNER NOW SAYS WHY IT SKIPPED, AND TWO FETCHES COULD HANG FOREVER

`outreach summary skipped=861` and nothing else — the exact failure the dispatcher's
`holdReasons` exists to fix, one level up and worse, because the planner is where a message
either comes into existence or does not. Asked *"why is the queue empty when 39 recipients
have room"*, the logs could not answer, though every reason had been computed and recorded
on the outcome and then thrown away at the one place a person reads. Grouped by reason now.
The live answer: `material-exhausted=1718 target-replied=165 target-recently-contacted=135
target-opted-out=131 not-verified=30 is-a-person=6`.

**AND A ~2-HOUR OUTAGE THAT MORNING, 08:28→10:29, was the Mac's network dropping** — the SSH
tunnel logged `Network is unreachable` repeatedly and the agent could not read the database
at all. It recovered by itself (the tunnel's KeepAlive working). What it exposed is worse
than the outage: **`brandPassRunning` stayed true for 70+ minutes**, so brand discovery AND
the badge door were skipped every 30 minutes while the log honestly said *"still running from
the last pass"*. `feed.ts` had learned that `fetch` has no default timeout and bounded itself
at 12s — with a docblock recording PARTIAL slots that ran up to **6.85 hours** — and **the
lesson never reached `enrichHandle` or `resolveBrand`.** It recovered only because the socket
eventually errored; a socket that stalls instead of resetting would have wedged both passes
forever, silently. One exported constant, three callers. A timeout stays `UNKNOWN` /
unreachable and is never a verdict.

### AND THE REPLY HALT WAS CROSSED FOR THE FIRST TIME EVER — BY YESTERDAY'S OWN FIX

**Found by watching a monitor fire on a send while writing the report.** @drongofilms wrote
*"Hi Kunal this side, saw your poster 'vibe', we can amplify your content"* — a live inbound
lead. The sweep observed it at 11:14 IST and **`parseThreadTimestamp` dated it 19 MAY**,
three months early. The halt keys on the reply's own date and an old date does not hold it
(Tabish's rule), so **the fleet delivered that recipient another message nine minutes after
they wrote to us.** CLAUDE.md's standing measurement — *"sends that went out AFTER a
recipient's reply was recorded: 0"* — was true until this.

MEASURED across all 41 stored replies: **9 carried a date earlier than the message they
answer.** Most by minutes (Instagram floors inbox ages — "8h" covers 8-9 hours — which can
date a reply just before our own send), harmless against a seven-day rule. @drongofilms was
three months off, and that is the class that releases a halt.

**`plausibleReplyDate` is the rule that makes any parser mistake harmless: a reply cannot
predate the message it answers, and cannot postdate the moment we saw it.** Both bounds are
DB facts rather than guesses. Outside that window the parse is discarded and the lower bound
used. **Tabish's rule survives intact, which is what makes this a fix and not a reversal:** a
reply appearing in a thread we last wrote to five weeks ago clamps to that old send, lands
outside the window, and still does not halt — precisely the "it might be answering an older
conversation" case he asked for. Both directions pinned; both write sites clamp, with a test
grepping for the raw-parse shape at either.

The 9 rows were clamped with an audit row each, and the halt was verified by **executing the
real gate**: `HELD — target-replied`. **The general lesson, which is new here: a date read
off a screen is EVIDENCE, and evidence that contradicts a fact we hold is not usable.** The
permissive direction Tabish chose for undatable replies is only safe when "undatable" is
honest — a confidently wrong date is worse than no date, because it silently satisfies the
rule instead of falling to the default.

### THE HEALTH PICTURE, MEASURED

360 delivered on 22 Aug by 11:00 IST; 36-47/hour through the night, which is the 77s period.
All 5 senders ACTIVE, none challenged, no dead sessions. Detection healthy: 108 CAMPAIGN
posts in 24h, newest 10 minutes old, `linode-detect` heartbeat fresh. 14 FAILED rows, all
`not-in-thread` (the ambiguous class, parked for a person by design). Replies: 35 recorded,
**0 undated** (so none is holding the halt on a date we could not read), coverage 13.2% and
rising with the inbox scan.

Tabish's audit request named five discrepancies; measuring them found four real defects, all
fixed, tested (1,793), deployed to both hosts, and re-verified live the same night. The
headline: **reply detection was reading 4 threads per run against ~600 open conversations
(10% coverage ever), and one probe of ONE sender's real inbox found six undetected replies in
ten minutes** — including a live Lufthansa collaboration response, a Royal Canin reply, and a
Hindi buyer conversation sitting in the "Partnership messages" folder no sweep had ever opened.

### THE SWEEP SCANS INBOX LISTS NOW — ONE DRIVE ANSWERS FOR EVERY CONVERSATION AT ONCE

`src/outreach/browser/inboxScan.ts` (read-only by construction: it clicks the inbox icon and
the Partnership folder, never a row, never a composer) reads every conversation row of a
sender in one drive: display name, snippet, relative age, unread state. The snippet's grammar
is the ours/theirs signal, OBSERVED live: "You sent an attachment."/"You: …" = ours last;
the reply text, "<Name> sent an attachment." or "2 new messages" = theirs. `inboxTriage.ts`
is the PURE interpreter, its fixtures the real probe rows. Rows where THEY wrote last and a
prospect matches are recorded as replies immediately — the HALT, the safety-critical half —
and the capped 4-thread deep-read budget now covers what remains instead of rotating blindly.
**First live run: 14 replies recorded against 6 ever detected before.** After dedupe and two
undos, **20 genuine reply records stand**, each on its own thread.

Watching the two live runs caught three defects no test could have (render the real output):
presence text (**"Active"**) recorded as a reply — and the real snippet underneath it turned
out to be *"Regarding?"*, a genuine human reply the noise was hiding; a system notice
(*"This account can't receive your message…"*) recorded as a reply; and state snippets
re-recording EVERY run because the attach rule was target-scoped — the per-PAIR
`shouldRecordInboxReply` fixes that (a row describes ONE sender's thread; a state can never
be "new" twice). All three undone with audit rows, filtered, and pinned in
`tests/reply-dating.test.ts` with the live rows as fixtures. Rows matching NO prospect are
REPORTED for a person, never guessed (36 on the first run — several are inbound enquiries
from strangers, the @fukra_insaan class; and several exposed that stored `displayName`s are
often just the handle, which the squashed-handle exact match now covers: "India Gate Foods" →
`indiagatefoods`, while "Kama Ayurveda" stays honestly unmatched against `kamaayurvedaindia`).

**The exposure, stated:** the sweep now opens ~6 inbox scans + up to 4 thread reads per
30-minute run (was 4 reads). All read-only, home IP, inside the send lock, checkpoint-halted.

### THE HALT COUNTS FROM WHEN THEY WROTE, NOT WHEN WE LOOKED (TABISH'S RULE, VERBATIM)

*"the agent must see the date on the reply or message sent; if no date is visible send the
message … as the reply might be to an older conversation."* `repliedAt` is the OBSERVATION
clock, and at 10% coverage growing it meant "discovering" weeks-old replies that would each
have halted their target seven days from the day of DISCOVERY. New column
**`replyPostedAt`** (hand-ALTERed on the live Postgres, 6 existing replies backfilled, DDL
added to all seven live-test blocks) carries the reply's own date: from the thread's date
separators — plain `span[dir=auto]` texts interleaved with bubbles, OBSERVED live ("12:39"
above our message, "18:04" above the reply) and parsed by the anchored `threadDates.ts` —
or from the inbox row's age ("41m", "2d"). Every halt site (gate, plan, onDemand, three view
models) keys on it, the gate's refusal sentence names the WRITTEN date it counts from, and
**an UNDATABLE reply does not halt — his call, the permissive direction, recorded in
`replyHalt.ts`.** The reply itself is always recorded and listed; only the automatic
seven-day pause needs a date it can count from.

### THE PACE CLOCK STAMPED ON INTENT — "0 MINUTES AGO" FOR TWELVE MINUTES WITH ZERO SENDS

The lock-level stamp shipped that same morning was measured wrong by evening: a dispatch tick
takes the lock BEFORE it knows whether any draft passes the gate, so on a drained queue every
passing tick re-stamped `fleetLastSendStartedAt` — watch.log read *"the last message went out
0 minute(s) ago"* every minute from 17:07 to 17:18 with nothing sent, and a newly-cleared
draft could wait a full extra gap period behind stamps from ticks that delivered nothing.
The stamp lives in **`browserSender.send`** now (`paceClock.ts` — its own module because the
sender sits below `deliver.ts` in the import graph): the ONE implementation every delivered
message passes through, still inside the lock, still before the browser moves. The `isSend`
flag died with it — a read structurally cannot stamp a clock it never reaches. Its test mock
had now been wrong in BOTH directions across the flag's one-day life.

### AND THE ANSWERS TO THE REST OF THE AUDIT, MEASURED

- **"Autopilot on but nothing sends"** — the fleet delivered 362 that day and DRAINED the
  queue; the 4 remaining drafts were all held by his own rules (1 reply halt, 3 at
  allowance). Waiting-for-material is the steady state, not a fault; new paid posts release
  it automatically.
- **Repetition:** every send since the allowance shipped complies (sanyamalhotra 3/3, zee5
  4/4, pharsfilm 1/1; the 124 over-allowance recipients are all pre-fix history, all now
  held). **Worth his eyes:** sanyamalhotra's 3 messages trace to ONE film campaign ("Bandar")
  syndicated across three watched channels in 43 minutes — his rule counts each channel's
  copy as a new unlock, so syndication multiplies messages. Stated, not changed.
- **Failure path:** a retryable failure re-queues to the BACK (`queuedAt` bumped) so the next
  tick takes the next recipient; the third failure parks in FAILED, visible with
  requeue/discard; `not-in-thread` parks immediately for a person (13 parked, all that class).
- **Reply rate on /analytics divides by conversations CHECKED now** and names its denominator
  on the tile — dividing by every send was understating reality tenfold at 10% coverage.
- **/paid-posts carries a "We message" column** (left of the cross): the prospect(s) each
  paid post earns a message to, via `mentionsHandleExactly` — the allowance's OWN linkage, so
  the column cannot disagree with the enforcer — plus `discoveredFromCampaignId` for
  prospects minted from untagged posts. "nobody verified" is the honest empty state.
- **Accuracy, all channels, server, --repeat 3:** fleet-wide **96% recall (43/45), 91%
  correct, 80% precision over 140 labels**. Both misses are the documented
  dressed-as-commentary class (one carries "#ad-" stripped by the harness). @rvcjinsta's "0%"
  is 0/1 on a single label. THE HONEST HALF: filmygyan (0/304), voompla (0/108), taranadarsh
  (0/20) and most new channels have NO labels — their accuracy is UNMEASURED, not good, and
  only disclosures or human answers on /paid-posts can change that.

### THE COLUMN EXPOSED THE LEAD FUNNEL'S REAL LEAK THE HOUR IT SHIPPED — THE BADGE DOOR

Tabish, from the live page: *"Several of the paid posts columns has nobody verified, this
is false … we must send one to Rocket Reels, @ajaydhama7, @ameyjoshi30,
@kumarmangatpathak, @krantishanbhag provided they have verified accounts … Why are we
missing out so many of the leads when we have clear indications."* He was right, and the
funnel audit found a leak nobody suspected:

**Of 280 handles asserted on in-window paid posts, ZERO were never-looked** — the lookup
pipeline keeps up — **and only 74 were prospects. The leak was the VERDICTS.** 144 sat as
cached PERSON — among them @amazonmgmstudiosin, @zeemarathiofficial, @rkdstudios, @1win:
companies the model mis-filed, permanently, because PERSON never retries. And the genuine
people among them were equally stuck: `admitsAsTalent` needs the badge, a cached PERSON
carries `isVerified: null`, and NOTHING EVER FILLED IT IN — "a cached PERSON flows through
the bar on every pass" was true and useless. Absence of data hardening into a permanent
refusal, inside the door built for his talent rule. 43 more were model-declined once and
never re-asked (@dr_pradeep_sethi — the Eugenix founder — among them).

**`src/detection/badgeDoor.ts`** closes it: every asserted-but-unminted handle in
PERSON/UNRESOLVED/MISSING/UNKNOWN gets ONE feed enrichment; the badge is persisted to
`BrandLookup.isVerified` (new column, live-ALTERed); TRUE admits via `createBrandTarget`
with `campaignTalent` and the asserting post as provenance; FALSE persists as a refusal
the screen names. On the device agent's brand timer (10/pass) + `pnpm ig:reaudit` for the
backlog. **THE DRAIN, MEASURED COMPLETE: 399 enriched, 266 ADMITTED, 109 refused as
unverified (the bar working), 24 unreachable (the timer retries them). Live prospects went
152 → 415 (409 verified) in one evening; the queue went 4 → 137 drafts; 13 delivered in
the following hour** — including @1win and @aamirkhanproductions, both previously stuck as
model-"PERSON" verdicts, admitted → drafted by the server planner → delivered by autopilot
within the hour, which is the loop closing end to end. The voompla post from his screenshot
went from one recipient to three, with the fourth honestly marked "badge check pending".

Two linkage gaps fixed with it, both his observations: **brand STRINGS that exactly name a
verified prospect now credit that prospect** in `campaignsNamingHandle` (45 in-window
posts named "Amazon MGM Studios"/"JioHotstar"-class prospects with no tag and unlocked
nothing; exact squashed-name equality only, so `fg6`-class junk structurally cannot match
— minting stays string-free, crediting stops being blind). And the **"We message" column
states each candidate's disposition** — "N unverified, refused · M badge check pending" —
with "nobody named" only for posts that assert no account at all. The blanket "nobody
verified" is gone; it was false, as reported.

**The Autopilot page was VERIFIED REAL-TIME the same hour:** DB said 4 waiting, the page
said "4 written and waiting" at the same instant (it re-renders every 30-45s), and the
send he watched was @bachelorssociety → @parthiv9 at 20:17 IST — a prospect minted, drafted
and delivered from the JITO Premier League post while the four held drafts stayed held.
The queue moves; the page tells the truth about it.

**THE THROUGHPUT CONSEQUENCE, STATED:** ~100+ new verified prospects means the planner
fills the queue toward its 150-draft depth and the dispatcher works through it at the
paced ~1/minute. That is the lead recovery he asked for, at the pace the safety design
already enforces. The talent door risk (celebrity inboxes are managed and report-happy)
was stated 2026-08-20 and stands recorded as his call.

Tabish asked for a supervised end-to-end run: autopilot on from the real UI, three paid posts
detected accurately, blocker 5 resolving itself, three more sends, everything reflected on the
pages. Each step of watching it surfaced something real. **All fixed, deployed, and re-verified
live the same evening** — and the pattern across all six is the same sentence: *a rule reached
one of the places it needed to reach.*

### THE SWEEP HAD BEEN BLIND SINCE 03:39, AND A LIVE RATE NEGOTIATION SAT UNSEEN

Every sweep read since ~03:39 reported `incomplete=4`. Driving one read by hand showed why, and
it is the worst near-miss in this file: **@taniya_chatterjee had been NEGOTIATING** — *"Hi,
this will cost you 8k per post"*, *"10 posts deal lelo"*, a phone number — in a thread the
sweep had "read" that same hour and could not vouch for.

The completeness bar was gathered FLEET-WIDE (`ourBodies` by `targetId`) while a thread holds
ONE pair's conversation. The ring fan-out had put the identical template in front of her from
five pages — five copies in five different threads — so `expectedOurs` was 5 in a thread that
can only ever show 1: **structurally unsatisfiable, for every fanned-out recipient, forever.**
The guard's fail-closed design held perfectly (incomplete never vouches for silence, so
`replyCheckedAt` was never stamped) and that is precisely what made it a blindfold: replies
could never be recorded, and other pages kept messaging her. **A fail-closed guard with an
unsatisfiable precondition is a blindfold wearing a seatbelt.** The old comment defending the
fleet-wide set — "it can only make 'not ours' a stricter test" — was TRUE for classification
and inherited by completeness silently: two questions with OPPOSITE safe directions sharing one
input. `ThreadBodies { expected, allOurs }` splits them by name. Her reply is recorded, the
fleet is halted to her, and **she is a live lead for a person**. VERIFIED: every sweep since
reads `incomplete=0` and coverage is growing for the first time.

**The lesson with teeth: a fail-closed guard holding for DAYS is itself the alarm.** Permanent
fail-closed means the precondition is unsatisfiable, not that the world keeps misbehaving.

### BLOCKER 6 — THE ACCEPT DOES NOT STICK UNTIL "MOVE TO PRIMARY" IS ANSWERED

Blocker 5 (the Accept-message-request panel) fired live on @sohamrockstrent — and the accept
was UNDONE, because Instagram follows it with *"Move messages from X into: **Primary** /
General / Cancel"* and nothing answered. Tabish's screenshot named it within minutes.
**Primary only**: General files the lead in a tab the sweep never opens, Cancel abandons the
accept — which is also why `dismissBlockingDialog` must never know this dialog (it DECLINES
things, and declining here undoes the acceptance; a test pins its clickable vocabulary to
exactly "Not Now"). VERIFIED on the real thread under the send lock: pass 1 — *accepting the
message request* → *filing the accepted conversation under Primary*; pass 2 — **the panel is
gone.** Six blockers now, all in `messageEntry.ts`, both paths, and the all-five order was
re-verified when he asked whether fixing 5 broke 3 (it had not: 4/4 sends delivered post-fix;
what he watched "fail" was the blind sweep above).

### THE UNLOCK COULD NEVER FIRE, AND THE FLEET WENT QUIET WITHIN THE HOUR

*"The queue also doesn't seem to move forward … I only see gea_saudi, kumarmangatpathak
repeatedly."* Both halves measured true, same root: `materialAllowance` counted
`DetectedCampaign.targetId === recipient` — and **`targetId` is the channel that POSTED**, so
for a prospect the count is zero forever. `max(1, 0)` clamped every recipient to ONE message
per window; the unlock half of his rule ("another paid post … and only then") was structurally
unreachable. MEASURED: 133/139 verified prospects at allowance, `skipped=851 queued=0`.

`campaignsNamingHandle` counts what actually links a campaign to a prospect — the same
Instagram-asserted evidence that MINTED it: caption @mentions and media tags, quoted-tag and
boundary-regex matched so `zee5` never credits `@zee5_marathi`, brand STRINGS deliberately not
consulted (`fg6` was one). **The first draft used `caption ~*` — Postgres-only, and the suite
drives the gate on SQLite: the two-provider trap, caught before shipping.** Portable now:
`contains` prefilter, exact boundary test in JS.

And the UI half of his observation was the fifth entry in the "a page reporting a rule by a
different rule than the one enforcing it" series: **"Up next" kept showing the two held drafts
as sends**, because the partition predates the allowance. It now asks the enforcer's own
predicate and renders the enforcer's own sentence.

### THE REST OF THE MONITORED RUN, MEASURED GREEN

- **Autopilot ON from the real UI toggle** (Playwright on the rebuilt local dashboard), audited
  as tabish@dashmani.com; the switch renders checked with the honest sentence.
- **4 sends delivered** in the first minutes (sanyamalhotra_, vibe, zee5, sonylivindia — all
  verified PROSPECTs, real thread URLs, the fixed ~79s period), then the queue drained to
  held-only, which is what exposed the unlock bug above.
- **8 fresh paid posts read for accuracy**: the "Ohh My Dog" film campaign syndicated across
  THREE channels, "Bandar on Zee5" ×2 with dates and platform — and ONE more filmygyan
  anniversary false positive, which exposed that the publisher input had missed
  `detector.classify()`, the production caption path (fixed above, then the fresh row
  re-judged: 42→7→5 filmygyan CAMPAIGNs).
- **All 13 channels re-judged** with the publisher context: filmygyan 38/200 changed; every
  other channel 0–5 of ~100 — confirming filmygyan was the anomaly and the input is surgical.
- **Two zombie SENDING rows parked as uncertain** (one killed by my own `kickstart -k` during
  an active send — an agent restart during sending is an interrupt, take the log's word on
  whether a drive is in flight first). They take the "check the conversation" flow.
- The verified bar refused three fake filmygyan lookalikes at discovery (`@filmygyanindia`
  etc., all unverified) — working unattended, printed for a person.

---

## 21 AUGUST, LATE — THE DUPLICATE DM, AND A PUBLISHER'S OWN WATERMARK READ AS A PAID PLACEMENT

Two independent defects, both found from Tabish's screenshots, both measured before anything
was changed. **A third batch of items from the same message is NOT done and is listed at the
end — read that before assuming this section closes them.**

### A PARKED `FAILED` ATTEMPT WAS INVISIBLE TO THE PLANNER, SO IT RE-DRAFTED THE PAIR

He photographed @bollywoodchronicle sending @indiagatefoods **the identical message twice**.
The database explains it exactly:

```
07:30  FAILED  not-in-thread   bollywoodchronicle → indiagatefoods
09:16  a NEW draft for the same pair
12:39  SENT                    bollywoodchronicle → indiagatefoods
```

`hasPendingAttempt` counts `QUEUED|READY|SENDING`; `touchesSoFar` counts DELIVERED. **FAILED
is in neither.** So a parked attempt made the pair look untouched, and the fresh draft was a
**first touch** — which `NO_NEW_MATERIAL` exempts by construction. Every guard passed.

`not-in-thread` is what makes this severe rather than untidy: its entire meaning is *the
composer cleared, we cannot prove what happened, the recipient MAY have it*. This file's
"`not-in-thread` is never retried" was a promise about the **ATTEMPT**; nothing protected the
**PAIR**, so the planner simply reopened it.

**THE SAME HOLE IS THE "8+ ATTEMPTS" HE SAW.** @sohamrockstrent had accumulated **six parked
drafts at three attempts each — eighteen browser drives at one revenue profile** against a
recipient whose composer cannot open (blocker 5, below), because each park was invisible.

Fixed at BOTH ends: the governor refuses to WRITE for a pair with an unsettled park, the gate
refuses to SEND one written before the rule. **Two reasons, not one** — `UNCERTAIN_DELIVERY`
and `PARKED_FAILURE` — because "they may already have it" and "it kept failing" have different
remedies, and collapsing them puts the ambiguous case behind a button labelled for the certain
one. Neither is overridable: every stop a human may cross is about TIMING, and this is about
whether a stranger already holds this exact message. The gate excludes the attempt being
judged, or a re-queued draft would refuse to send on its own history.

**VERIFIED by executing the real gate against the live queue:** the seventh sohamrockstrent
drive now reads `parked-failure-unsettled`, and the clean drafts still read CLEAR TO SEND.

**MEASURED and reassuring, from the same audit:** `(sender→target)` pairs delivered more than
once: **0** apart from this mechanism. Sends that went out AFTER a recipient's reply was
recorded: **0** — the reply halt has never been crossed.

### A PUBLISHER'S OWN WATERMARK IS NOT EVIDENCE THAT SOMEBODY PAID THEM

*"the detection mechanism has beautifully failed for filmigyan's posts … this was their
anniversary celebration."* Correct, and the row names the mechanism. `DcRTPMDTTjX`:

| | |
|---|---|
| caption verdict | **ORGANIC** — *"Publisher's own anniversary, not a paid promotion."* |
| signals | `frame:escalated-to-campaign`, `frame:says-campaign` |
| frame text | `…celebrationasFilmygyan \| marks10amazingyears… — in shot: FILMYGYAN` |
| stored verdict | **CAMPAIGN** |

**The caption classifier got it right and the FOOTAGE overruled it on the channel's own
logo.** @filmygyan burns `FILMYGYAN` into every video, so OCR reports its own watermark on
every post and the frame stage reads it as a brand in shot. Systematic, not incidental:
**@filmygyan produced 42 CAMPAIGN verdicts since 20 August against @viralbhayani's 25.**

**THE CONTROL CASE PROVES THE STAGE IS SOUND AND MUST NOT BE WEAKENED.** Same channel, same
path, `DcRB5e1Cy_M`: the frame reads `acerpure | BaDolby | 120Hz | FILMYGYAN` and **that
escalation is CORRECT** — a real television placement the caption missed, exactly what reading
footage was built for. So the answer is not to distrust the frame; it is to stop handing a
publisher its own name as evidence about itself. The same rule `brandCandidatesFor` already
applies to handles, one modality late.

`src/detection/ownMarks.ts` is PURE and **its control cases carry the weight** — acerpure,
Zee5, 5Star, Dolby all survive, because a missed paid post is invisible and unappealable while
a false one is a row on a screen. Those tests caught two real weaknesses in the first rule:
`fg` is an **acronym** of filmygyan rather than a prefix (so the stem must be a
first-letter-anchored subsequence — which also rejects `ig11`), and unbounded containment
would have swallowed a `FilmygyanXAcerpure` blob (so it is length-bounded, and prose about the
publisher survives for the model to judge, since the model judges it correctly).

**INTERNAL SERIES CODES fall out of the same rule.** *"filmigyan uses #fg6 … there is no brand
by that name, similarly #bs2."* MEASURED since 20 August: **fg6 ×15, fg2 ×10, fg14 ×4, fg15
×4, fg18, fg11, FG17** stored as brand NAMES; **54 rows carry at least one.** The test is
deliberately not "short token with digits" — that is Zee5 — it is *the publisher's own initials
followed by a number*, which cannot be a third party by construction.

`publisher` is a **required** field on `JudgeInput`, so the compiler named all five callers.
The stored `frameText` still records everything read — **what we READ and what we treat as
EVIDENCE are different facts** — and a frame whose text was only own marks now reports
`frame:only-own-marks` rather than collapsing into "no text found" (the `framesRead`
five-states lesson).

**AND WATCHED CHANNELS ARE SAFE, MEASURED:** attempts ever aimed at a watched channel or one
of our own pages = **0**, and no watched handle exists as a second non-WATCH row. Self-tagging
cannot create a prospect either, because `brandCandidatesFor` excludes our pages and watched
publishers *before* the lookup budget.

### BLOCKER 5 — THEY MESSAGED US FIRST, SO THERE IS A REQUEST AND NO COMPOSER

The fifth recipient-side blocker, at the rate this file predicted ("expect a fifth"). When an
account has sent US a message we never accepted, the conversation opens on **Block · Delete ·
Accept** with no composer. The send timed out looking for one and was filed `no-composer` — a
name asserting the account cannot be messaged, about an account that had just messaged us.

`acceptMessageRequest` lives in `messageEntry.ts` and **BOTH paths take it.** For this blocker
that matters more than usual: an unaccepted request IS a message somebody sent us, so leaving
the read path out would make the thread most likely to hold a real enquiry the one thread that
can never be read.

**ACCEPT IS THE ONLY BUTTON EVER CLICKED**, the same discipline as blocker 3's "Not Now":
**Delete** throws away an inbound lead — the most valuable thing this system can receive — and
**Block** severs the relationship, and neither is undoable from here. The matcher is anchored
(`/^accept$/`) because the panel's own prose reads *"Accept message request from …"*, and the
panel is confirmed to BE a request before anything is clicked. Stated plainly: accepting lets
the sender see our activity status, which is a small deliberate widening and the direction a
person would take by hand.

An accepted request usually means a human should look, and that follows by itself — their
message is now a bubble that is THEIRS, so the reply guard halts outreach on the next read.
That is the correct outcome, not a side effect to design around.

### ONE MESSAGE PER DETECTED PAID POST — THE 5× FAN-OUT IS GONE

*"If only a single paid post is detected … we send a message to the brand only once unless we
detect another paid post."* **MEASURED: 133 recipients had heard from more than one of our
pages, many from all five** — @indiagatefoods got five messages from five pages in twelve
hours off ONE post — and **493 surplus messages in the last seven days.**

**THE MECHANISM WAS A SCOPE, NOT A MISSING RULE**, and this is the part worth keeping.
`NO_NEW_MATERIAL` already said exactly this and was defeated twice over:

1. `unusedCampaignCount` counts campaigns unused **by this sender**, so one paid post reads as
   unused for all five senders at once.
2. The check only runs when `touchesSoFar > 0`, and each sender's own pair has zero touches —
   so every one of the five is exempt as a first touch.

`materialAllowance` asks the question about the **RECIPIENT**, which is who the rule was always
about. Allowance = `max(1, paid posts naming them in the window)` against messages ANY page
delivered in the SAME window — one window on both sides, because all-time deliveries against
recent campaigns would retire a recipient permanently the first time a campaign aged out, and
the reverse would let one old post fund a message a week forever.

**The `max(1, …)` is load-bearing rather than defensive:** a hand-imported prospect, or one
found by `discoverOfficialPages` from a post that named nobody, would otherwise be unreachable
forever — absence of data hardening into a permanent refusal, presenting as "the queue never
drains".

**THROUGHPUT, STATED:** 147 of 173 prospects are now held until their next paid post. That is
his rule and it is the safer direction, but it is a large reduction; detection finds ~150
CAMPAIGN posts a day, so material keeps arriving. The remedy is deliberately `href: null` — the
release is a new paid post, which detection finds by itself, so a button would imply a fault.

### AND THE DOMINANT filmygyan CAUSE WAS AN INPUT GAP, NOT A RULE GAP

Only ONE of the 42 rested on the frame. The rest were caption-decided, and the model's own
stored reasons say why: *"Promotes video on own channel, likely paid promo"*, *"Promotes
Filmygyan's 10-year party event"*.

**THE SYSTEM PROMPT ALREADY GETS THIS RIGHT.** Its editorial list contains, verbatim, *"The
publisher promoting its OWN newsletter, show, merch or account"*. The model simply had no way
to know the "Filmygyan" in the caption IS the account that posted it — and reading *"watch it
on Filmygyan's YouTube channel"* without knowing whose feed it is, a third-party promotion is
the **correct** inference from the evidence given.

So `publisherContext.ts` adds an INPUT and changes no rule, which is what makes it safe. Three
properties make it measurable and reversible:

- **Cache-safe.** The system prompt stays a module-level constant (the 50× discount needs that
  prefix to match in full, and destroying it is silent and permanent), so the block goes in the
  USER message beside the tags and the frame. A test asserts nothing is interpolated into it.
- **Emitted only when the caption NAMES its publisher.** A caption without one has no ambiguity
  to resolve and produces a byte-identical user message — which is what makes most of the
  corpus structurally unable to move rather than merely measured not to have moved.
- **Both calls or neither.** Derived once in `judge.ts` and passed to both `classifyCaption`
  calls, under the same rule `tagText` documents: `applyFrameSignal` attributes any difference
  to THE FOOTAGE, so reaching one call only would score a publisher-driven change as a
  frame-driven one. A grep pins every call site.

**MEASURED BEFORE TURNING IT ON, `ig:accuracy --repeat 3` both ways:**

| | baseline | with the publisher |
|---|---|---|
| @madovermarketing_mom recall | 97% | **97%** |
| @viralbhayani recall | 100% | **100%** |

**Recall did not move**, which is this project's standing gate. And the direct evidence, read
rather than scored, on 14 real @filmygyan CAMPAIGN rows: **9 flip to ORGANIC** with reasons like
*"Publisher's own anniversary celebration, not a paid placement"* — while the two genuine film
promos (`Toxic` and `VIBE`, both with release dates and booking links) **hold at CAMPAIGN 95%,
unchanged**, because neither names its publisher and their prompt is byte-identical. That
control is the whole argument: self-promotion moves, real placements do not.

`publisherAsContext` is **ON**, audited with that measurement. `pnpm ig:rejudge-channel <handle>`
(DRY RUN BY DEFAULT) revisits stored verdicts after an input changes — `ig:classify` only ever
selected `verdictSource: 'none'`, so there was no way to reconsider a judged row. It never
selects a human label, goes through `judgeWithFrame`, and leaves a failed call alone.

**FOUND BY RUNNING IT:** the first version reported all 42 rows "undecided". `judgeWithFrame`
takes the caption verdict as an ARGUMENT and does not recompute one for a semantic channel, so
`UNCLASSIFIED` in means `UNCLASSIFIED` out — a frame may never give an unjudged post a verdict.
It re-asks the caption now, because the stored verdict was formed without the new input and
composing against it would measure the change against itself.

### WHAT IS NOT DONE FROM THIS MESSAGE — READ THIS BEFORE ASSUMING IT IS

1. **REPLY DETECTION COVERS 50 OF 640 delivered messages (7.8%).** No send has ever crossed a
   *recorded* reply — measured, zero — but the sweep reads four conversations a run against 640
   open threads, so most replies are simply unknown. The 5× fan-out used to multiply this and
   no longer does, which shrinks the exposure without closing it.
2. **`/paid-posts` has no per-channel filter and no pagination**, and the "not paid" cascade has
   not been re-verified end to end against drafts already written. Both were asked for in the
   same message.
3. **The 54 brand lists carrying `fg6`-style codes are not cleaned.** The rule that stops new
   ones is live (`ownMarks.ts`); the stored rows are cosmetic and want a bounded `--run` sweep.
   No prospect was ever minted from one — discovery reads @mentions and tags, never the
   `brands` column — so this is UI noise rather than a live risk.
4. **The other watched channels have not been re-judged** with the publisher context. Only
   @filmygyan has, because it is the one Tabish named and the one with a 42-vs-25 anomaly. The
   command is `pnpm ig:rejudge-channel <handle>` and it is dry-run by default.

---

## 21 AUGUST — THE 1-MINUTE GAP WAS MEASURED FROM A SEND'S *END*, SO THE PERIOD WAS 1 MIN + 47 s

**Tabish: *"If we are sending every 1 min or so why are only 25-35/hour being sent?"*** The
answer is arithmetic, and the overnight run is the cleanest sample this fleet has produced —
276 deliveries, autopilot on, 80+ drafts waiting, nothing held:

```
gap between consecutive sends:  min 104s   p50 107s   p90 124s
235 of 275 gaps inside ONE 15-second bucket (105-119s)
```

**A distribution that tight is an equation, not jitter.** `sentAt` is stamped on COMPLETION and
`minutesSinceLastSend` was measured from it, so the next send could only START a full minute
after the previous one FINISHED, and then took ~47s itself:

> **period = gap (60s) + browser drive (~47s) = 107s = 33.6/hour**

So the knob **could never produce the rate it named, at any value** — at gap=1 the true period
was 107s, at gap=5 it would be 347s. The number on `/rules` and the number in force were
different rules: the `MAX_TOTAL_SENDS` failure moved into the pacing layer, where "one message
a minute" silently meant "one message per minute-plus-a-send".

**THE FIX IS THAT THE GAP IS A PERIOD.** `fleetLastSendStartedAt` is stamped inside
`withSendLock` **before** the drive, and the tick gates on that. `withSendLock` is what makes
this safe rather than reckless: it is fleet-wide and refuses to nest, so two sends cannot
overlap however small the gap gets. **The gap controls PACE, the lock enforces SERIALISATION** —
measuring from completion conflated the two, and that conflation is the whole bug.

The stamp lives in the LOCK and not in the tick because the dashboard's Send button is a send
too; a stamp reaching only the dispatcher would let a manual send land seconds after an
automatic one. `SendLockKind.isSend` is a **required** field rather than an optional flag, so
the compiler names every call site the day a new one appears (the `RenderTarget.kind` pattern)
— and it immediately named four, including a test mock whose old two-argument shape had been
silently passing the callback into the options slot.

### THE FIRST VERSION OF THE FIX DID NOTHING, AND IT WAS DEPLOYED BEFORE THAT WAS KNOWN

`lastSendStartedAt` returned **`max(started, completed)`** — "the later clock is safer". It is
not: a send COMPLETES ~47s after that same send STARTS, so **the max is the completion every
single time** and the fix silently reinstated the behaviour it was written to remove. Deployed,
agent restarted, measured: **106.8s against a 107s baseline. No change at all** — while every
source grep passed, because the caller genuinely did read the new function.

**A defensive fallback that outranks the signal it defends is this codebase's most repeated
shape, and this is the first time it has appeared inside a fix for itself.** A grep cannot see
which branch of a comparison returns, so the comparison is now the pure `gapClock`, driven in
the direction that failed and mutation-tested by restoring the `max()` with the real
timestamps. **Only re-measuring after deploying caught it.**

**MEASURED AFTER THE REAL FIX: 77s, 77s, 76s — the period is 77s, 47.6/hour, up from 33.6.**

### WHAT STILL COSTS THE LAST 13/HOUR, AND IT IS NOW THE POLL

At a 77-second period the arithmetic is `drive (47s) + poll (30s)`, so **the 30-second device
poll is the binding constraint and the 60-second gap is not** — which contradicts the stated
invariant in `agent/index.ts`'s own docblock, *"at 30s the gap is what paces the fleet rather
than this timer, which is where the decision belongs"*. That was true while the period was
107s; the fix made it false. Restoring it means a shorter poll (10s → ~57-67s period,
~54-63/hour), which is cheap — a handful of queries, no browser — and **cannot exceed the gap,
so the gap stays the lever.** NOT CHANGED HERE: it is a deliberate throughput increase rather
than a bug, and it is Tabish's call, stated rather than shipped.

**THE EXPOSURE ALREADY SHIPPED, STATED PLAINLY (rule 1):** ~33/hour → ~47/hour at the same
setting. That is the rate he asked for twice and never actually got, but it is 40% more than
has been running. **`fleetMinGapMinutes = 2` restores the old rate in one write**, and
autopilot OFF still stops everything at the next decision point. The long tail of the old
distribution (20 gaps of 135-290s) is the reply sweep holding the fleet lock for its whole run
— known, documented, and a different change (per-conversation locking) than this one.

### AND THE THIRD FACE OF THE CAPPED-LIST BUG, PLUS THE HISTORY HE ASKED FOR

*"it should reflect in analytics and autopilot page accurately all the message thread with an
ability to go even beyond."* `SentList` rendered **`Delivered ({recent.length})`** — the size of
its own `take: 50` window, labelled as the total, on a fleet doing ~290 a day. Third distinct
face in three days of *a bounded list read as a complete record*, after `sentToday` (a
`take: 50` filtered into a count) and the activity feed (a `take: 40` whose oldest row read as
the day's first send).

`buildSentHistory` is the whole delivered record, 50 a page: `total` from **its own count**
(deriving it from the page would report "50 of 50" and agree with the truncation — *a check
verifying its own symmetry*, third time recorded here), the page **clamped** into range because
`?sent=999` is a URL anyone can type, and ordered `[sentAt desc, id desc]` because at a
~1-minute period two rows can share a timestamp and an unstable sort silently repeats or skips
a row across a page boundary. `/analytics` drives it from `?sent=` with the range preserved, a
`#history` anchor, and Newest/Newer/Older/Oldest — "the oldest message we ever sent" is a real
question and stepping to it one page at a time is not an answer. The **Autopilot page** finally
states what has gone out at all (**290 today, 578 all time**, both real counts) with the newest
eight and a link, because that page had the queue, the pace and the switch — everything about
what is ABOUT to happen — and no figure for what already had.

VERIFIED on the deployed server: *"Showing 1–50 of 578 · page 1 of 12"*, `?sent=12` →
*"551–578 of 578"*, `?sent=999` clamps, `?sent=abc&from=../etc` falls back safely. 1,693 tests,
typecheck clean, `ig:layout` all green.

---

## 21 AUGUST — THE NIGHT RAN PERFECTLY; THE FEED SAID IT STARTED AT 07:51 AND THAT WAS THE 40-ROW CAP

**Tabish: *"Verify messages sent tonight (the machine was turned on for the whole duration) so
why does it show message sent at 7:51 as the first this day?"*** The premise was measurably
false, and finding out WHY the screen suggested it is the whole entry.

**MEASURED: the fleet never stopped.** 280 delivered on 21 Aug IST, **first at 00:01:43**, and
the hourly shape is the flattest this project has ever recorded — 31, 31, 32, 29, 29, 31, 32,
30, 31 per hour from midnight to 09:00, i.e. the documented 25-35/hour settling exactly where
the docs say it should. Zero gaps over 4 minutes. Autopilot was ON from his 23:13 instruction
until **he turned it off at 09:09:43** from the dashboard (audited, `tabish@dashmani.com`) —
which is why nothing was sending when he asked.

### 07:51:32 IS THE 40TH-NEWEST SEND, AND THE FEED NEVER SAID IT WAS A WINDOW

`recentSends` is `take: 40` and feeds the **"What happened"** activity feed. At 30 sends an
hour, forty events is **eighty minutes of history** — so on a 280-message day the feed's
bottom row sat at 07:51 and read as the day's first event.

**EVERY NUMBER ON THE PAGE WAS CORRECT.** The counter said 280. The forty rows were real sends
at real times. What was wrong was an INFERENCE the layout invited, and that is the distinction
worth keeping: the day before, a `take: 50` corrupted the `sentToday` VALUE and a 60-row
fixture caught it; here the cap corrupts a READING, and no assertion about any number on the
page could ever have failed for it. Same root cause — *a bounded list read as a complete
record* — two days running, in two different disguises.

`ActivityDay` carries `shown`/`total` now and the day states its own figure: **"Today · newest
40 shown of 280 sent"**, rendered only when the day is genuinely truncated. The total comes
from its OWN `groupBy` over the 14-day window and explicitly **not** from `recentSends` —
deriving it from the capped list would report "40 of 40" and agree with the truncation, which
is *a check that verifies its own symmetry*, now recorded here for the third time.
`tests/activity-truncation.test.ts` greps both halves, including that the total is not derived
from the capped list, because the data half is worthless if nothing draws it.

**Still true and deliberately not "fixed" by raising the cap:** at this volume the feed covers
about eighty minutes. Raising it trades page density and queries for history the CSV export
already holds completely. The note makes it honest; the export is the record.

### WHAT THE NIGHT ALSO PRODUCED, AND ONE ITEM NEEDS A PERSON

- **A REAL INBOUND BUYER ENQUIRY, 02:36:59 IST**, from `@fukra_insaan` to
  @bollywoodpaparazzii: *"We would like to know the commercials for posting one content on
  your page."* That is the outcome this system exists for, it is **unhandled**, and outreach to
  them is correctly halted by the reply guard. Two older ones (`@vivo_india`,
  `@victorinox_india`, both 19 Aug) are autoresponders and can be released.
- **Every rule held across 280 sends**: 280 recipients, **0 unverified** (VERIFIED ONLY
  intact), **0 sends to any WATCH page** — including the 11 added hours earlier.
- 12 FAILED: 10 `not-in-thread` (the ambiguous class, parked for a person by design) and 2
  `no-composer`. Both expected; the breaker watches for a RISING rate, not a count.

---

## 20 AUGUST, NIGHT — ELEVEN WATCH PAGES, AND SIX OF THE HANDLES AS TYPED WERE WRONG ACCOUNTS THAT EXIST

**Tabish: *"I want to add these pages as targets as well (to be monitored for paid posts not
to be sent any messages whatsoever… When I clicked on our manual method to add filmigyan it
did not get added… the manual method must work as well e2e)."*** Fourteen handles. Every one
was probed against `web_profile_info` from the home Mac before anything was added, and the
probe is the story:

### EXISTENCE IS NOT IDENTITY, MEASURED A SECOND TIME — ON WATCH PAGES

**Six of the fourteen, exactly as typed, resolve to wrong accounts that EXIST**: `filmigyan`
is a **219-follower fan page** ("4K FOLLOWERS ON MAIN PAGE") while the page he means is
**@filmygyan, 31.6M, verified**; `manavmanglani` is a 19-follower private person
(**@manav.manglani**, 9.2M ✓, is the paparazzo); `rvcj` is "rachael", 97 followers
(**@rvcjinsta** = "RVCJ Media" ✓ — its profile endpoint hits Meta's schema-bug 400, so
identity came from the FEED endpoint, which returns `full_name` + `is_verified`);
`varinderchawla` → **@varindertchawla** (8.9M ✓); `komalnahata` and `sacrasm` are 404s;
`indian` is a username squatter. A wrong WATCH page is NOT harmless: its CAMPAIGN posts mint
real prospects that get real DMs, so the identity bar for auto-accepting a correction was
**verified badge AND the display name being the page he named** — the isOfficialMatch
philosophy at the watch door.

**ELEVEN ADDED** (all ✓verified): filmygyan 31.6M, varindertchawla 8.9M, manav.manglani 9.2M,
voompla 19.5M, instantbollywood 42.8M, rvcjinsta, pinkvilla 7.3M, taranadarsh 771k,
adultsociety 8.1M, trolls_official 12M, naughtyworld 10.8M. **THREE HELD FOR TABISH, never
guessed:** `sacrasm` (the famous @sarcasm_only is now named **"ecards"and UNVERIFIED**, 17M —
possibly the page rebranded, his call), `indian` (no credible candidate), `komalnahata`
(@komal.nahta is "Game changers of India", unverified — plausibly his show account,
unconfirmable; @komalnahtaofficial is an empty shell).

### WHY HIS FILMIGYAN CLICK RENDERED NOTHING, AND WHAT THE FORM DOES NOW

No row, no audit row, no message — the action never ran. The form's `submit` had **`finally`
with no `catch`**, so a THROWN failure rendered silence; the reachable thrower is a tab open
from before a deploy calling a server action by a stale build-time ID ("Failed to find Server
Action"), and at one deploy a day every open tab is that tab. Three fixes, all now behind
`tests/exists.test.ts` (17 tests, both roles, both directions):

- **the catch renders the error and the remedy** (reload the page);
- **`probeHandle` returns existence AND identity facts from the one fetch**, and
  `addTargetMessage` (PURE) puts them on screen at the moment of the add: *"Watching
  @filmygyan… Instagram says this is "F I L M Y G Y A N", 31,619,996 followers, verified —
  if that is not who you meant, remove it and check the handle."* A wrong add is visible to
  the person who just made it, not discovered in the corpus weeks later;
- **the success sentence matches the ROLE** — the old copy promised "the fleet will write to
  them" for WATCH adds, false by definition. Fifth of the screen-asserts-a-rule-the-enforcer-
  does-not-hold family. Plus `revalidatePath('/targets')` so the list beside the form updates.

**All 11 were added through the REAL form in a REAL browser** (Playwright on the rebuilt
local dashboard), each add answered with its identity line. VERIFIED in the DB: all 11 rows
byte-match viralbhayani's shape (`CHANNEL/WATCH/semantic/watchEnabled/not opted out`),
**zero `OutreachPair` rows** (`routeAllowed` refused every route), absent from the on-demand
dropdown, 11 `target.added` audit rows.

### THE ELEVEN NEW CHANNELS BLEW FOUR QUERY BUDGETS AT ONCE, WHICH IS `ig:layout` WORKING

`buildChannelCards` issued **five queries PER channel** — invisible for its whole life at 2
channels, 65 at 13, and `/` (192/160), `/targets` (142/120), `/paid-posts` (150/120) and
`/analytics` (151/125) all failed together because all four render the cards through
`buildTodayView`. The identical N+1 the `buildBrandsPanel` docblock ONE FUNCTION DOWN records
being killed on 2026-08-13. Now five `groupBy`s total over `cardTargetIds`; **below the OLD
numbers with 11 more channels** (`/` 192→132, `/targets` 142→82, `/paid-posts` 150→90,
`/analytics` 151→91). The visible-channels grep accepts exactly `targetId: { in:
cardTargetIds }` — the VARIABLE NAME is the carve-out, so a survey over every channel id
still fails it. **A loop over a list whose size is a product decision must not cost queries
per row.**

### DETECTION ON THE NEW PAGES, MEASURED THE SAME EVENING

The server's own 15-minute cron picked all 11 up with **zero code changes** (the deploy was
for the form fixes; the rows alone were enough). First pass per channel, then steady state by
23:00 IST — **128 CAMPAIGN posts stored and judged across the new pages within hours**:
pinkvilla 20, manav.manglani 21 (a paparazzo — the viralbhayani profile exactly),
varindertchawla 16, naughtyworld 14, adultsociety 12, trolls_official 11, taranadarsh 10 of
12(!), voompla 9, filmygyan 6, rvcjinsta 6, instantbollywood 3. Every post `verdictSource:
semantic`, zero never-looked. **And the LOOP CLOSED THE SAME NIGHT**: the device agent's
brand timer minted verified prospects from those campaigns — @gilletteindia, @indiagatefoods,
@jioworldplaza, @jatt_prabhjot (from an @adultsociety campaign detected two hours earlier) —
all `isVerified: true`, per the VERIFIED ONLY rule.

**THE REQUEST-LOAD TRADE, STATED:** 13 watched channels ≈ **~5,000 anonymous feed
requests/day** (was ~750 at 2). The feed endpoint has stayed healthy at every measurement,
and it is the endpoint that answers on the server; if a 429 ever appears, raise
`DETECT_INTERVAL_MINUTES` first. Classifier cost at this scale is cents a day; frames add
roughly tens of MB/day on the server disk (ig:prune covers it).

### ROTATION, PROVEN AGAINST THE GROWN TARGET LIST, AND THE OVERNIGHT RUN

With the 11 WATCH rows in place: two sends observed (`bollywoodchronicle → zee5_marathi`,
`bollywoodpaparazzii → zeemusiccompany` — different ring senders, both recipients verified
PROSPECTs), **zero attempts ever addressed to any WATCH row**, and zero drafts aimed at the
new pages. Rotation cannot elect them: they hold no pair rows, and `hasPendingAttempt`/ring
election walk pairs.

**AUTOPILOT IS ON FOR THE NIGHT, ON TABISH'S INSTRUCTION** (*"autopilot is going to be on
throughout the night"*), audited with those words at 23:13 IST after his own dashboard OFF at
18:27 — the flip trail is four rows, all named actors. **Send #170 landed 45 seconds after
the flip** (`bollywoodpaparazzii → @ddecordiaries`, verified, real thread URL). The Mac: on
AC power, `caffeinate` asserting on behalf of the agent — the one uncoverable case remains a
CLOSED LID, so the lid stays open. Queue: 56 waiting; 170 delivered on the day at the flip.

---

## 20 AUGUST, AFTERNOON — 59 SENT AND NO SCREEN SAID SO; THE ONE FIGURE THAT DID WAS A `take: 50`

**Tabish: *"How many messages have been sent today and is all that value reflected in the UI…
I see 60 messages sent today but nowhere that indicates real count of messages sent."*** He
was right on both halves, and the second half is the more instructive one.

**MEASURED against the live Postgres, IST midnight → 09:01Z: 59 delivered** — bachelorssociety
19, bollywoodsocietyy 14, bollywoodpaparazzii 12, totalfilmii 10, bollywoodchronicle 4, all
`autopilot:`. His count was right.

### THE NUMBER EXISTED, WAS CORRECT, AND REACHED NO SCREEN

`fleetUsage()` returns `{ thisHour, today }` and has done since 2026-08-18. Both halves are
covered in both directions by `tests/fleet-reservations.test.ts`. **`page.tsx` passed only
`thisHour` to the pace band; `today` was computed on every render and thrown away.** Every
function was right and the product still could not answer the question — *the defect is a
missing CALLER*, which is this file's most-repeated shape (166 cover frames read by nothing,
`resetBrandResolverLimit` with zero callers, `addSender` with no UI caller for weeks,
`repliedAt` read in six places and written in none). No behavioural test can fail for a
caller nobody has written, so `tests/sent-today-rendered.test.ts` is a SOURCE GREP.

**AND `/analytics` ANSWERED A DIFFERENT QUESTION UNDER A HEADING THAT READS LIKE THIS ONE.**
All four stats in its headline grid are a rolling SEVEN DAYS, so "messages sent" showed 152
on a day with 59. Nothing was false; the page simply had no daily figure, which is the fifth
entry in this file's "a screen reporting one rule by another" series — except here the screen
was honest and merely silent, and silence is the failure this dashboard's whole design is
against.

### THE ONE `sentToday` IN THE CODE WAS A CEILING WEARING A COUNT'S LABEL

`buildMessagesPage` had `sentToday: recentRaw.filter(a => a.sentAt >= istMidnight).length` —
and **`recentRaw` is `take: 50`**. So the day's total was capped at however many of today's
sends sat inside the newest fifty rows: today it would have read **50, and gone on reading 50
until midnight**. VERIFIED LIVE after the fix — `fleetUsage().today` 59, `recent.length` 50 —
so the old expression is provably wrong *right now*, not in principle.

It was rendered nowhere, which is the only reason it cost nothing rather than being a figure
somebody had trusted. **A "count" derived by filtering a paginated list is a `LIMIT` in
disguise, and it reads correctly until the day volume exceeds the page size** — the
`MAX_TOTAL_SENDS` shape again (a limit reported by a different rule than the one enforcing it
reads as headroom).

`sentToday` is now `dispatch.usage.today`. `dispatch` was **already awaited on that page**, so
the correct answer costs ONE FEWER query than the wrong one did, and the page cannot report the
day by a different rule than the dispatcher.

### WHAT IS ON SCREEN NOW, AND WHY IN THOSE TWO PLACES ONLY

- **`/` → the pace band**, a second row under "This hour": same measurement, same call, a
  different boundary. No pips — `fleetMaxPerDay` is unset by Tabish's decision, and drawing a
  bounded row would picture a rule not in force (the `Infinity` → `RangeError` → HTTP 500 that
  took `/` down on 18 Aug).
- **`/analytics` → one sentence** beside "Last 7 days.", from `fleetUsage()` rather than a
  count written locally. **NOT a fifth stat tile:** `.grid-4` is a hard `repeat(4, 1fr)` that
  cannot collapse, so a fifth column scrolls the page sideways at 800px — the defect
  `ig:layout` caught on `.grid-2` and the history table.

**MUTATION-TESTED IN BOTH DIRECTIONS.** Reverting `fleetUsage`'s day count to a `take: 50`
fails the new 60-row case with `expected 50 to be 60` — **and left the other 14 tests in that
file green**, because every existing case used TWO rows and so could not tell an uncatered
count from a capped one. Removing the prop from `page.tsx`, and re-deriving `sentToday` from
`recentRaw`, each fail the grep.

**AND READING THE RENDERED COMPONENT CAUGHT TWO THINGS NO TEST COULD**, which is why it is
always the last step: the row read *"Today · 59 messages sent **today**, since midnight IST"*
— the word twice in nine words — and the analytics line read *"1 message has gone out, **1 of
them** in this hour"*. Both pass every assertion in both spellings. The hour clause now
renders only when it is a genuine subset.

### VERIFIED BY WATCHING TWO REAL SENDS MOVE THE COUNTER, ON BOTH HOSTS

Deployed (`baa91dc`), then **the number was proven by making it change** rather than by
reading it once — a figure that is correct on a still queue says nothing about whether it
tracks. Autopilot had been OFF since 13:54 IST (his flip; the 08:24:12Z send eleven seconds
after it is the documented in-flight completion, not a leak), so it was turned ON through the
same two writes the dashboard toggle makes — `setSetting` plus an `autopilot.set` row — and
**restored to OFF in a `finally`**, because a script must not leave a revenue fleet sending:

```
14:57:03  autopilot OFF · today=59        page: "Today · 59 messages sent since midnight IST"
14:57:04  AUTOPILOT ON            (audited, cli:Tabish)
14:57:52  SENT #1  @bollywoodsocietyy → @luxindia        today=60  thisHour=1
14:59:39  SENT #2  @bachelorssociety  → @mcintoshlabs    today=61  thisHour=2
14:59:50  AUTOPILOT RESTORED TO OFF
          /            "Today · 61 messages sent since midnight IST"
          /analytics   "Since midnight IST, 61 messages have gone out, 2 of them in this hour."
```

Both carry real thread URLs; 1m47s apart, which is the 1-minute pace end to end. Both
recipients clear the VERIFIED ONLY bar — **"LUX India"** and **"McIntosh Laboratory, Inc."**,
`isVerified: true`, both PROSPECT/BRAND — so the admission rule held on the sends this
exercise caused. The Linode reads 61 as well, from its own build.

**AND THE HOUR ROLLED OVER WHILE THE DAY DID NOT, which is the free half of the measurement.**
Read again just past 15:00 IST: `thisHour` **2 → 0**, `today` still **61**. The two boundaries
are independent and the IST hour floor is right — worth having, because a machine-local floor
would be 30 minutes out (IST is +05:30) and the Linode does not run in IST, and a day figure
that silently tracked the hour is exactly the class of bug this whole entry is about.

**THE LOCAL DASHBOARD NEEDED REBUILDING AND IS NOT A SECOND SENDER.** `pnpm start` on :3100
was serving a pre-fix build, so it showed the old page while the Linode showed the new one —
stop it, `pnpm build` (exit code read directly), restart. On boot it logged *"another
scheduler is already running — not starting a second, otherHost=dashboard"*: the Linode's
heartbeat is fresh, so the local copy is a VIEWER and rebuilding it cannot affect sending.
Sending is the launchd device agent (`caffeinate -i`, pid 16541), which was left alone —
nothing in this change is reachable from it, and a restart it does not need is a restart that
can only cost sends.

---

## 20 AUGUST, MIDDAY — "AUTOPILOT IS OFF AND IT STILL SENT" WAS FALSE; "THE UI IS STUCK" WAS TRUE

Three claims from Tabish, all measured. The first two were the system being right and the
SCREEN being wrong; the third found a guard I had shipped dead the day before.

### AUTOPILOT OFF IS WORKING. THE LAST SEND WAS 50 SECONDS BEFORE HE FLIPPED IT

MEASURED from the audit log: `autopilot.set OFF` at **11:19:15 IST** by
tabish@dashmani.com; the last `attempt.sent.autopilot` at **11:18:25** — fifty seconds
EARLIER. Zero sends after the toggle, no row in SENDING, and `dispatchState` reads
`autopilot-off` on every tick since. The just-in-time `getSettings()` before the SENDING
claim (2026-08-19) is doing its job.

**What he actually saw was the PAGE, not the fleet** — which is finding two.

### "UP NEXT" PROMISED SENDS WHILE THE SWITCH WAS OFF, SO A PAUSED FLEET READ AS A STUCK ONE

With autopilot off the panel went on rendering **"in ~1 min" ETAs** and **"clear to send on
the next tick"** over eight rows that could not move — so the queue looked frozen on every
refresh while the page insisted it was draining. Both halves of his complaint, one cause.

**THE GATE CANNOT CATCH THIS, AND THAT IS THE GENERAL LESSON.** `AUTO_SEND_OFF` was deleted
in the one-switch change (2026-08-08), so `recheckBeforeSend` says nothing about the switch
and truthfully answers `ok` for a draft nothing will send. The verdict was right; the
sentence built from it was not. `WaitingList` now takes `autopilotOn`: the ETA column reads
**"when Autopilot is on"**, the head row says *"every check passes — waiting only for
Autopilot to be switched on"*, and the summary states **"Autopilot is off, so none of these
are going out"**. `etaMinutes` is `null` rather than a number, because a countdown is a
promise and nothing was counting down.

Fourth entry in this file's "a page reporting a rule by a different rule than the one
enforcing it" series. The queue was never stuck — **it was obedient, and the page lied
about it.**

### THE 91-DRAFT QUEUE IS REAL AND EXPECTED — IT IS THE GAP REMOVAL WORKING

83 drafts were written in the 11:00-11:30 IST window: with the inter-page gap gone the
planner can write for pairs it previously refused, so each recipient now holds up to one
draft per page. MEASURED: **max 2 drafts per recipient, from 2 distinct senders** — nothing
is stacked, because `hasPendingAttempt` still forbids two unsent drafts on one pair. The
depth is bounded at `maxWaitingNewBrandDrafts` (150), so it fills toward that and stops.
"Perpetual" is the intended steady state, not a leak.

### AND HALF THE TARGET AUDIT WAS DEAD CODE REPORTING SUCCESS — SHIPPED BY ME THE DAY BEFORE

His third question — *"are we sending to authentic users"* — is what exposed it.
**MEASURED: `followerCount` is NULL on all 91 queued recipients**, and probing
`enrichHandle` live on three handles says why: the anonymous FEED endpoint returns
`is_verified` and `full_name` and **no follower count at all, ever**. Follower data exists
only in `BrandLookup`, from the profile endpoint that 429s on the server and 400s on Meta's
deleted category schema — **55 rows of 438**.

So `auditTarget`'s `tiny-unverified` and `no-category-thin` flags, `admitsAsTalent`'s size
arm and `isOfficialMatch`'s size arm were **all unreachable**, and the audit's "no suspect
prospects" was an all-clear over rows it had not judged. *A guard nobody can trigger is not
a guard* — this codebase's signature failure, committed by me one day earlier inside the
code written to find faulty targets.

Fixed three ways: followers now come from `BrandLookup` (partial beats always-null); the
identity flag keys on **badge + category only**, so it needs no count; and the command
REPORTS how many rows it could not judge, because "no flags" and "no facts" are different
answers (the `framesRead` five-states lesson).

**WHAT THE NEW FLAG CAUGHT, and it is a real send to a real fan page:**
`@lego.mybrickhouse` — display name *"My Brickhouse"*, unverified, no category, account
type 2 — **was messaged from a revenue account at 11:09, two minutes after the genuine
`@legoindia_official` ("LEGO India", verified) at 11:07.** A professional account with
nothing else known falls to `classifyProfile`'s business branch and becomes a BRAND, which
is absence-of-data-becomes-a-verdict one door along. Retired.

**THE HONEST ANSWER ON AUTHENTICITY:** of 91 queued recipients, **71 verified, 20
unverified, 0 never-looked**. The unverified twenty are mostly real Indian brands without a
blue tick (Senco Gold, Shiprocket, Wildstone, Anand Pandit Motion Pictures) — which is why
the flag is worded **"unconfirmed identity"** and not "faulty", and why it feeds a review
queue rather than a retirement sweep. Both readings stay a person's.

---

## 20 AUGUST, MORNING — THE INTER-PAGE GAP IS GONE (SECOND INSTRUCTION), AND A HUNG READ HELD THE FLEET FOR 88 MINUTES

**Read this before the section below it: it DELETES the one mitigation that section shipped,
and it records the measurement that justified deleting it.**

### THE 24-HOUR INTER-PAGE GAP BECAME THE ONLY THING STOPPING THE FLEET, SO IT IS ZERO NOW

The ring rule went out at 00:30 IST and delivered 11 messages in twenty minutes. Then
sending stopped, and the morning measurement named the cause exactly: **23 of 23 waiting
drafts held by the 24h inter-page gap alone**, freeing 13:29-15:32 IST — while the 7-day
rule the gap was protecting was **firing for nobody** (77 recipients had heard from exactly
ONE page, so no ring was complete). The mitigation had become the entire constraint.

Tabish, for the second time in twelve hours: *"Remove this 24-hour inter-page gap …
I told you before and I am telling you this again, 7 day constraint only no other
limitation."*

`crossPageGapHours` is **0**. The MECHANISM is deliberately kept rather than deleted —
exactly the shape of the 0-0 active-hours window — so one number restores it, and
`tests/cross-spacing.test.ts` still drives it with an explicit 24 so it stays enforceable.
**The default is now pinned by a test whose failure message names whose call it was**,
because the next person to read this code will see an unspaced fleet and want to "fix" it.

**WHAT IT PERMITS, STATED FOR THE THIRD TIME AND RECORDED AS HIS:** all five pages may
reach one recipient within minutes of each other, near-identical template each time, then
that recipient rests seven days. Nothing else spaces our pages apart. Same trade as the
caps removal (18 Aug) and the 24/7 window (19 Aug).

**VERIFIED BEFORE DEPLOY, on the real queue through the real page:** "Up next (23 waiting)"
with **22 sendable** at 1-8 minute ETAs, and "Resting (1 held)" — the single remaining hold
being a REPLY halt (@fastrackworld, freeing 26 Aug, which is the new 7-day window). That is
Tabish's rule rendered exactly: the ring, a reply, and nothing else.

### A SINGLE REPLY READ HUNG FOR 88 MINUTES AND STOPPED ALL SENDING, INVISIBLY

MEASURED the same morning, and it is the more dangerous finding. At 09:04 IST the reply
sweep took the **fleet-wide send lock** and opened a conversation; the SSH tunnel to the
database dropped underneath it (`Can't reach database server` in the agent log); the read
did not return until **10:32**. For those 88 minutes every dispatcher tick reported only
*"another send is already running"*, `/`'s pace band looked healthy, and nothing anywhere
said the fleet had stopped. **A hard stop with no release, in the guard that holds the
lock.**

It cost no sends *this time* purely because the gap was holding everything anyway. The fix
is `READ_DEADLINE_MS = 6 minutes` in `readThread.ts`, and the shape matters more than the
number:

- **Closing the CONTEXT is the interrupt AND the cleanup.** Every `page.goto` here was
  already bounded at 60s, so the hang was not a navigation — an in-page `fetch` (the
  identity check) has no timeout and waits forever on a stalled socket. `context.close()`
  makes it reject immediately, and it is what the `finally` does anyway.
- **Racing the promise and walking away would be worse than the hang.** An abandoned read
  leaves a live context on a profile a send may pick up seconds later, and two contexts on
  one profile is how device identity dies. So nothing is abandoned; the context is closed.
- **A timeout is `unreadable`, NEVER "no reply"** — otherwise a stalled network becomes an
  assertion of verified silence and releases the hardest guard in the system.
- **The thrown message must not match `/checkpoint|challenge|suspend/i`.**
  `checkConversation` tests exactly that pattern and marks the account CHALLENGED, which
  halts the WHOLE FLEET through the breaker. A network stall flagging a healthy revenue
  account would be far worse than the hang. `tests/read-deadline.test.ts` asserts this
  directly, and it is the assertion in that file carrying real weight.

**Still open, and it is the general form of this bug:** the sweep holds a fleet-wide lock
for its whole duration, so its worst case is now bounded at 6 minutes per conversation
rather than bounded at all. If sending must never pause for a read, the sweep needs to hold
the lock per conversation rather than per run — a bigger change than a "keep messages
flowing" fix should carry.

### AND `/rules` WAS DESCRIBING THE DELETED RULE, AT BOTH OF ITS SPACING STATEMENTS

The page promises every value on it comes from the module that enforces it, and its two
spacing sentences still said *"another of our pages wrote to this recipient recently — one
inbox hears from one of our pages at a time"* and *"our OTHER pages leave them alone for 7
days"* — both describing the rule deleted the night before. Both now state the ring rule
and the 7-day reply window, and the gap sentence appears **only when the gap is non-zero**,
so the page cannot claim spacing that is switched off. Third time this file has recorded a
screen asserting a rule the enforcer no longer holds.

---

## 20 AUGUST, SMALL HOURS — SPACING IS THE RING RULE NOW, AND THE FLEET UN-FROZE THE MINUTE IT DEPLOYED

**Read this before trusting anything below about cross-account spacing, the reply window,
or the person guard. All deployed to both hosts and verified live, 00:30–01:00 IST.**

### THE ANY-OTHER-PAGE SPACING RULE HALTED THE ENTIRE FLEET, AND TABISH REPLACED IT WITH THE RING RULE

MEASURED 2026-08-19 18:07 IST: **33 of 33 waiting drafts held** by `TARGET_RECENTLY_CONTACTED`
(first clear Aug 24, none within 48h), 76 recipients each "locked" by having heard from
exactly ONE page, dispatcher ticking `all-held` every minute, prospect inflow dry — the
sender-blind rule restored on 2026-08-18 met the 1-minute pace and froze the fleet for five
days. Tabish, verbatim: *"there is no limit except the 7 day constraint which should occur
only if target has been contacted by all targets or a reply has been detected."*

**The rule is now `crossSpacingVerdict` (src/outreach/crossSpacing.ts) — ONE pure
implementation, THREE callers (gate.ts, plan.ts→governor, messages-page.ts), pinned by the
rewritten `tests/cross-account-spacing.test.ts`:**

- **ring-complete** — hold only when EVERY eligible fleet sender (`eligibleFleetSenderIds`,
  machine-independent, built on `readSenderAvailability`) has delivered to the recipient
  within `defaultCooldownDays` (7). Releases when the oldest in-window delivery ages out.
- **inter-page-gap** — a DIFFERENT page delivered within `crossPageGapHours` (Setting,
  default **24**, 0 disables). Without it the planner walks all five pages through one inbox
  in an afternoon. **This is the one editorial mitigation and it is Tabish's lever.**
- Self-deliveries never hold (that would reinstate the pair cooldown deleted 2026-08-18);
  the empty eligible set never holds (a vacuous "all" must not fire).

**The ban-pattern risk was stated and recorded as his call**: up to 5 near-identical
templates to one inbox per week. The stop NAME is unchanged, so STOP_LABELS/remedies were
untouched. VERIFIED LIVE: the first previously-frozen draft
(bollywoodsocietyy→anandpanditmotionpictures, held since Aug 18) **delivered at 00:30 IST,
one minute after the agent restarted**, and the queue has been draining at the 1-minute pace
since. The reply halt is **7 days** now (`REPLY_RESUME_HOURS_DEFAULT = 168`, was 48) — auto-
resume, "I have replied" still releases early.

### "UP NEXT" SHOWS THE RESTING HALF NOW — 33 waiting can never again be an invisible list

`buildMessagesPage` partitions the queue with the SAME shared predicate (never a UI mirror —
the old inline `some(sid => sid !== senderId)` copy was exactly how the rule drifted) and
returns `heldUpNext`: the first 8 held drafts, soonest-release first, each with the
enforcer's own sentence and the IST time it frees up. `waiting.tsx` renders them under
"Resting (N held)", in a `.table-wrap` (the layout harness caught the page scrolling
sideways without it — 819px against 800). The all-held state now states the earliest resume
time and says outright it is not a fault.

### TARGETS CARRY VERIFICATION FACTS, AND THE FAULTY ONES ARE FLAGGED, NEVER AUTO-RETIRED

Tabish: *"targets identified should not be faulty … remove targets that are undesired and
faulty."* Three new `TargetAccount` columns (`isVerified`, `followerCount`,
`campaignTalent`), applied to the live Postgres by hand-written `ALTER TABLE` (there is
still no `_prisma_migrations`; the same SQL went into every live-test DDL block — the suite
failed 102 tests until it did, which is the two-provider trap's cousin: hand-transcribed DDL
goes stale the day the schema moves). `pnpm ig:audit-targets` (dry-run default, home IP,
6s spacing, 429 halts) re-enriches every live prospect, persists the facts with `--run`, and
FLAGS through the pure `auditTarget` rule (src/outreach/targetAudit.ts): gone / person-role-
category / tiny-unverified / no-category-thin. NULL facts never flag — never-looked is not
tiny. The rule flags, a PERSON retires (`ig:retire-target`), because `usableName` taught
what plausible predicates do to real populations. `/targets` rows show the legitimacy line
("verified · 1.2M followers", review suffix from the same rule). First real pass: caught
@apoorvsinghkarki01 ("Film Director", unverified) within its first 12 rows.

### UNTAGGED PAID POSTS CAN MINT A PROSPECT NOW — BUT ONLY THROUGH AN IDENTITY BAR

"Existence is not identity" (wrong 4/10, 3 of 4 wrong handles EXIST) is AMENDED, not
repealed. `pnpm ig:find-official` (dry-run default, home IP) walks in-window CAMPAIGN posts
whose evidence names NOBODY (172 of them at first run — the population that yielded no
prospect by design), takes brand names from `DetectedCampaign.brands` then OCR `frameText`
tokens, generates candidate handles (`candidateHandlesFor`), and auto-accepts ONLY
`isOfficialMatch` (src/detection/officialHandle.ts): **verified badge + name-covering, or
≥`officialMinFollowers` (100k Setting) + business + EXACT name**. The Philips trap is a
permanent test fixture: profile "Philips" never passes for brand "Philips India" — the
subset direction carries the safety. Near-misses print under NEEDS A HUMAN with
`--accept <handle>` as the deliberate door. First dry run: 1 identity-grade match in 15
lookups (@gururandhawa, verified). Candidate lookups are NOT yet cached in BrandLookup, so
repeated dry runs re-spend the endpoint on 404s — known, minor, fix by persisting MISSING
rows if it starts to matter.

### CELEBRITIES TAGGED IN PAID CAMPAIGNS ARE MESSAGEABLE — DELIBERATELY, VIA `campaignTalent`

Tabish: *"send messages to celebrities as well if they are part of the paid campaign …
legitimate and verified (sometimes might not be the case)."* A PERSON verdict from a
CAMPAIGN post's Instagram-asserted evidence is admitted when `admitsAsTalent`: **verified,
or ≥`celebrityMinFollowers` (500k Setting)** — NULL never admits. Wired in BOTH resolvers
(autoResolve.ts and ig:brands — one bar, two callers), created as kind BRAND with
`campaignTalent: true`, which is the ONLY thing `checkRecipientIsNotAPerson` exempts:
accidental people (vanity categories — @ananyapanday-as-"Private Investigator" is still the
fixture) stay refused. The PERSON verdict now carries `isVerified`/`followers`/`displayName`
for this; a cached PERSON has `isVerified: null` and flows through the bar on every pass, so
history needs no separate backfill. Risk stated: celebrity inboxes are managed and report-
happy; recorded as his call.

### WHAT BIT DURING THE NIGHT, SO NOBODY RE-CHASES IT

- **The Mac's disk hit literally ZERO bytes free, twice.** Once mid-session (every tool
  including `df` failed — the harness cannot even open its own output file), once after two
  local builds. `pnpm ig:prune --run` (Tabish ran it) plus `pnpm store prune` (1,180
  packages) and deleting `.next` recovered it. **This machine's disk is structurally too
  full** — ~/Library is the real problem and it is Tabish's; expect ENOSPC again.
- **The device agent crash-looped for ~2h because the suite left the SQLite client on
  disk** and the prune restart booted onto it — the exact documented trap. The agent was
  down 23:0x–00:31; nothing was lost (the queue was all-held anyway). `bash
  scripts/prisma-client-for-env.sh` after ANY test run on this machine, always.
- The layout harness earned its keep again: it caught the held-list table scrolling `/`
  sideways, and the query-count check refuses to pass when counting is off (a run with
  `DS_QUERY_COUNT` unset fails rather than skips — by design).

---

## 19 AUGUST, LATE — THE HALT WHEN AWAY WAS THE MAC SLEEPING, AND SENDING IS 24/7 NOW

### "MESSAGES HALT WHEN I'M NOT ON THE PAGE" WAS THE MAC IDLE-SLEEPING — caffeinate FIXES IT

Tabish: *"autopilot works phenomenally if I am on the localhost open, but falters if I am
somewhere else … messages were halted and resumed only after I landed on the page."*

**MEASURED from watch.log, and it is not App Nap and not the browser:** overnight the device
agent went **silent for 50-68 minutes at a stretch** while it polls every 30 seconds. Total
silence — not even the `autopilot-off` tick — means the process was SUSPENDED, i.e. the Mac
idle-slept. launchd cannot wake a sleeping Mac (this file has said so for weeks), and the
sender lives on this machine, so a slept Mac is a stopped fleet. When Tabish was active the
Mac stayed awake and the agent ran continuously; when he walked away it slept. That is the
whole correlation with "being on the page".

**Ruled out, with evidence, so nobody re-chases them:** (1) the agent DOES tick reliably
every 30s when merely backgrounded — the 6-minute "gap" that looked like throttling was
`reason=autopilot-off` every tick, i.e. Tabish's own toggling; (2) the local `pnpm local`
dashboard is NOT a second sender — the Linode's heartbeat is fresh, so the Mac dashboard's
embedded scheduler reads it and declines to start (`another scheduler is already running`).

**The fix is in `scripts/install-watch.sh`: the agent runs under `caffeinate -i`** (prevent
idle system sleep, released when the agent exits) plus `ProcessType=Interactive`. VERIFIED
with `pmset -g assertions`: `caffeinate … asserting on behalf of pnpm`. **The one case it
still cannot cover is a CLOSED LID** — clamshell sleep is a hardware state no assertion
overrides on battery. Keep the lid open (or external power + display). Reinstall with
`bash scripts/install-watch.sh install` after any change; the plist now carries the wrapper.

### THERE IS NO TIME WINDOW ANY MORE — SENDS AND REPLY CHECKS RUN 24/7

Tabish: *"there is no limit or time constraint … the message can be sent at any time, no
matter if it is morning or past midnight."* `ACTIVE_FROM_HOUR` and `ACTIVE_TO_HOUR` are both
**0** — a zero-width window, which `withinActiveHours` reads as "always on" — so the
dispatcher and the reply sweep (which reads the same constants) run around the clock.

**This reverses a load-bearing safety property and is recorded as his call**, like the caps,
the 1-minute gap and the 24/7 decision before it. "We never DM at 4 a.m. from an Indian
business page" was a behavioural signal that cost nothing to keep; a 03:00 IST send is a
pattern a person does not produce. The lever to restore a window is those two numbers (e.g.
10 and 21) — one edit, no schema change. The pace band and `stopInventory`/`pacing` tests
now exercise the window MECHANISM with explicit hours so it stays enforceable if restored.

### "UP NEXT" SHOWED PERMANENTLY-STUCK ROWS — NOW IT SHOWS WHAT ACTUALLY SENDS

Tabish: *"the number changes but the list below it remains the same."* The dispatcher drains
READY oldest-first but HOLDS every draft that fails the gate and sends the first that passes.
Most of the queue's front is held by 7-day cross-page spacing (@anandpanditmotionpictures
"heard from @bollywoodchronicle 1 day ago"), so those rows never move — while sends happen
from further down, dropping the count. So the raw oldest-first list was eight stuck faces
over a falling number.

`buildMessagesPage` now computes the two DOMINANT holds in bulk — cross-page spacing
(`TARGET_RECENTLY_CONTACTED`, another page delivered within `defaultCooldownDays`) and the
reply halt — one query each, mirroring `gate.ts`, and lists only SENDABLE drafts in dispatch
order plus a `heldWaiting` count. The list now advances with the count. Rarer per-sender
holds (cohort, dead session) are left to the head row's real `recheckBeforeSend`. **MEASURED
live: 33 of 33 waiting were spacing-held**, so "Up next" is legitimately empty and says so —
which is the honest answer to why sending slows: not a bug, the spacing rule Tabish restored
on 2026-08-18. Throughput is bounded by spacing and prospect inflow, not by the 1-min gap.

### THE PACE COUNTER IS ACCURATE; ~25-35/hr IS THE REAL RATE, NOT 60

Tabish asked whether "24 sent this hour" is true. **It is** — `fleetUsage.thisHour` was 11
against a direct hourly count of 11 the moment he asked; 24 was a fuller hour. The pace band
copy now states the real rate honestly: a send itself takes ~1 minute and the reply sweep
pauses sending while it reads up to 4 conversations, so the fleet settles around 25-35/hour,
not 60. The band was also fixed for the zero-width window (it was dividing by a zero span →
NaN → falsely "outside sending hours").

### THE LANDING AND ANALYTICS PAGES REFRESH THEMSELVES, AND ANALYTICS SHOWS PER-ACCOUNT SENDS

`auto-refresh.tsx` (`router.refresh()` every 30-45s, paused while the tab is hidden, refreshed
on return) so a page open while messages go out every minute stays current without a manual
reload — a refresh re-runs the server components in place and was verified not to error on any
page. Analytics gained a **"Messages sent, by account"** table (sent + replied per sending
page) — the per-SENDER view that had no home; per-recipient detail stays in the recent-sends
list and the CSV export.

### THE "CHECK THE CONVERSATION" SEND (sonypicturesin) IS THE `not-in-thread` GUARD WORKING

Tabish saw a send where "the agent completed the entire process but the browser closed
unexpectedly … no message was sent." MEASURED: it is `failureCode: not-in-thread` — the
composer cleared (Instagram accepted the keystroke) and the message never confirmed in the
thread. That is the one ambiguous outcome: the recipient MAY have it, and re-sending is wrong
under both readings, so it parks in FAILED under "check the conversation" for a person to
read the thread and settle. One occurrence is expected; the circuit breaker watches for a
RISING rate. Not a bug — the guard doing its job.

---

## FOUR RECIPIENT-SIDE BLOCKERS STAND BETWEEN A PROFILE AND THE COMPOSER — ALL FOUR ARE BYPASSED

**Read this before touching `sendDm.ts` or `readThread.ts`.** Instagram no longer offers one
reliable path from a profile to a DM box. Four different obstacles were found IN FIVE DAYS,
each by Tabish from a screenshot or screen recording rather than by a test, and each one
previously filed as a failure code that asserted something false about the recipient. All
four now live in ONE module — `src/outreach/browser/messageEntry.ts` — and BOTH paths that
open a conversation (the send path and the reply reader) call it, because a blocker fixed on
one path and not the other is this codebase's most repeated defect.

| # | what appears | what it looked like | what we do |
|---|---|---|---|
| 1 | **no Message button** — "Send message" is inside the "…" options menu (@dharmaticent) | `no-message-button`, i.e. "this account cannot be messaged" about one a person messages in a click | open the … menu, click **"Send message"** |
| 2 | **the business interstitial** — "Partnership messages are more likely to get a response…" (@anandpanditmotionpictures, @cameratakefilms) | `no-composer` on the send path; `unreadable` on the read path | click **"Send message request"**, NEVER "Send prioritised message" (Tabish's instruction) |
| 3 | **"Turn on notifications"** — a modal that can appear AT ANY MOMENT | `locator.click: Timeout 30000ms exceeded` on a composer that was found and visible | click **"Not Now"**, never "Turn On" |
| 4 | **no door at all** — no Message button AND no "Send message" in the … menu (@idfreshfood, from Tabish's screen recording) | `no-message-button` twice, WITH the …-menu fallback already live | the INBOX route: open Messages → compose ("New message") → type the handle into To: → click the EXACT username → Chat |

**BLOCKER 4 IS THE FALLBACK OF LAST RESORT (`openThreadViaInbox`), tried only after 1-3's
answers all failed** — it is the longest path and the least profile-shaped. Its one dangerous
step is the search-result click, and it is guarded the way "existence is not identity"
demands: the result row must match the username EXACTLY (anchored regex, dots escaped —
handles like @audionirvana.in would otherwise wildcard), and no exact match means REFUSE,
never a fuzzy click. A wrong row here is a DM to a stranger from a revenue account.

**THE RETRY DISCIPLINE, Tabish's rule stated in full:** at most three tries per draft — the
existing `MAX_DELIVERY_ATTEMPTS` cap, which parks the draft in FAILED where the landing page
shows it ("Gave up after repeated failures") with re-queue and discard — **and the queue no
longer waits behind a failing draft**: a retryable failure now re-queues to the BACK
(`queuedAt` bumped), so the very next tick takes the next recipient instead of driving the
same blocked profile three ticks in a row.

**BLOCKER 3 IS THE ONE THAT TAUGHT SOMETHING GENERAL: VISIBILITY IS NOT CLICKABILITY.** The
composer lookup passed — `isVisible()` is about CSS and layout, not about what is on top —
and then `click()` waited out its entire 30-second timeout because a modal was over it. So
the selector-list approach that solves blockers 1 and 2 is structurally unable to see this
one. Two mechanisms answer it, and both are needed:

- `dismissBlockingDialog` is checked at EVERY dwell point (feed, profile, after the entry
  click, before Enter) rather than at one step, because Instagram raises this dialog on its
  own schedule and not in response to anything we did.
- `clickPastDialogs` wraps the click that must land: three attempts of 9s, each preceded by
  a dismissal. **Same total budget as the one 30-second click it replaces**, spent so that a
  dialog arriving mid-click costs a retry instead of a delivery.

**"Not Now" is the only button ever clicked.** Every dialog Instagram phrases this way
(notifications, "save your login info?", "add to home screen") is safe to DECLINE and unsafe
to accept: accepting changes the Chrome profile's state, and that profile is the credential
the whole design protects.

**AND A DIALOG LANDING JUST BEFORE `Enter` IS THE DANGEROUS CASE.** A modal holds focus, so
the keystroke would go to ITS default button — which on the notifications dialog is **Turn
On** — rather than to the composer. So that gap gets its own dismissal, and if one was found
the composer is re-focused AND the staged text re-verified, because a keystroke aimed at the
wrong element is exactly what the read-back guard exists to catch.

**Expect a fifth.** Four in five days is a rate, not a coincidence: these are
recipient-side and account-side experiments Instagram is running, so the next one will also
arrive as a screenshot. The shape of the fix is now established — add it to `messageEntry.ts`
so both paths get it at once, and never let a failure code assert something about the
recipient that it has not established.

**ALSO CORRECTED THE SAME DAY (2026-08-19 afternoon), from Tabish's live observations:**

- **Autopilot OFF now stops the NEXT send too.** He flipped it off and watched another
  message go out: settings were read once at the top of the tick, and the gate plus a
  just-in-time conversation read can take a minute at the new pace. One fresh
  `getSettings()` immediately before the SENDING claim closes that window; the only tail
  left is a browser already mid-paste, which must finish — interrupting a paste in flight
  is how a message lands with no record of it.
- **The landing page updates itself now** (`auto-refresh.tsx`, every 30s, paused while the
  tab is hidden, refreshed the moment it becomes visible). At one message a minute a
  server-rendered page was stale before it was read.
- **The ring resize left cross-sender duplicate drafts.** Removing @madaboutmarketingg
  changed the hash spread (`stableIndex` mod 5, not mod 6), so the planner elected NEW
  senders for recipients that already held drafts from the old mapping — MEASURED: 36
  surplus drafts, one recipient at a time. `pnpm ig:dedupe-drafts --run` swept them
  (audited, keeps rotation's choice). **Any future ring-size change will do this again**;
  run the broom after removing or adding a sender.
- "16 companys" on the landing page — the pluraliser wrote `company` + `s`. Now
  "companies".

**VERIFIED LIVE, AND BLOCKERS 1 AND 3 FIRED ON THE SAME SEND:**

```
13:26  an Instagram dialog appeared — dismissed it with "Not Now"
13:27  Message button hidden — using "Send message" from the … menu   target=dharmaticent
13:27  dm delivered  bachelorssociety → dharmaticent
       threadUrl=https://www.instagram.com/direct/t/115517513167735
```

@dharmaticent had failed **six times across two days** — three as `no-message-button` under
@madaboutmarketingg, then three more once the … menu was solved and the notifications modal
ate the composer click. One send, both doors, delivered with a real thread URL. The second
message went out **1m49s later** (`bollywoodpaparazzii → @discoveryplusin`), which is the
1-minute pace working end to end.

---

## 19 AUGUST — A SENDER CAN LEAVE, THE QUEUE CANNOT; THE SWEEP FINALLY RUNS WHERE THE SESSIONS ARE

All on Tabish's instruction, all deployed and verified live the same day.

### @madaboutmarketingg IS OUT OF THE ROTATION, AND ITS 19 DRAFTS MOVED BY ROTATION

`handOffWaitingDrafts` (src/outreach/handOff.ts) is the mechanism, and `removeSender` now
calls it: when a sender leaves, every READY/QUEUED draft — and every parked FAILED one
except `not-in-thread` — is reassigned to the account `nextSender` would choose on the
ring MINUS the leaving sender, with `touchNumber` recomputed from the RECEIVING pair's
history and the retry counter reset. A recipient another account already covers gets its
duplicate DISCARDED through `discardAttempt` (the one writer); a retired recipient's
draft is discarded too; `not-in-thread` stays on the account that sent it, because the
recipient may HAVE that message. `tests/hand-off.test.ts` drives all seven properties
against a real SQLite file. VERIFIED LIVE: 18 transferred, 1 discarded, 0 kept —
including the two @dharmaticent rows collapsing to exactly one READY draft on
@bachelorssociety with its counter reset.

**madabout is ACTIVE + `fleetMember: false` (the burner's shape), NOT paused** — its
17-18 Aug deliveries are open conversations, and the reply sweep only reads ACTIVE
senders' threads. Pausing it would have made any reply to those messages invisible.
Rotation cannot elect it, the planner writes nothing for it; the only path left is a
person deliberately picking it in the on-demand dialog. `/senders` has a Remove form now
(typed-confirmation), which is `removeSender` — the action retires WITH hand-off.

### THE MESSAGE BUTTON IS SOMETIMES BEHIND THE "…" MENU, AND THAT IS NOT "CANNOT MESSAGE"

@dharmaticent (Tabish's screenshots): profile header shows Follow only; "Send message"
lives in the options ("…") dialog. The agent failed it 3 times as `no-message-button`.
`clickMessageEntry` (src/outreach/browser/messageEntry.ts) is now the ONE implementation
of "open the composer from a profile" — plain button first, then the … menu — shared by
`sendDm.ts` AND `readThread.ts`, because a profile that hides the button must stay
readable too, or its conversation can never be checked for a reply. `jitter`/
`firstVisible` moved there (readThread re-exports them for scripts/thread.ts).

### THE REPLY SWEEP RUNS ON THE DEVICE AGENT NOW — IT HAD NEVER ONCE RUN ANYWHERE IT COULD WORK

Same fix as brand discovery: `checkForReplies` (the SAME function, caps and checkpoint
handling intact) runs on the device agent every 30 minutes inside active hours, HOLDING
THE SEND LOCK — reading drives the same Chrome profiles as sending, and two contexts on
one profile is how device identity dies. A tick that lands mid-sweep returns lockBusy and
loses nothing. Not gated on autopilot: a reply to a hand-sent message halts outreach the
same way. The server-side 11:00/20:00 schedule is untouched (it still no-ops there).

**AND THE SWEEP BACKFILLS `threadUrl`.** MEASURED: all 21 delivered messages carried
`threadUrl: null` — the send-path conversation opens as a panel OVER the profile, so the
`/direct/t/` URL the capture loop waits for never appears, and the CSV thread column was
empty end to end. `checkConversation` now writes the thread URL it actually navigated to
onto every delivered attempt of that pair that lacks one, and `sendDm` gained an anchor
fallback (`a[href*="/direct/t/"]`, a DOM read, no navigation).

### THE FLEET GAP IS 3 MINUTES (WAS 5), AND 1 MINUTE IS ONE ROW AWAY

`FLEET_MIN_GAP_MINUTES = 3` — Tabish: "5 mins is too much… 3 mins or lesser". ~220/day
of headroom inside the active window; what bounds real volume is still prospect inflow.
The `fleetMinGapMinutes` Setting row overrides it in one write, and the device agent
polls every 60s, so ONE minute is the effective floor if he asks — the risk (identical
template, one home IP, faster clustering) was stated when the caps went and is unchanged
in kind. The pace band and /rules read the same limits object, so both show 3 without
being told.

### "UP NEXT" IS ON THE LANDING PAGE, AND IT IS THE DISPATCHER'S OWN ORDER

The queue renders as the next 8 sends (oldest draft first — the exact `deliverWaiting`
query), each with sender → recipient and an ETA at the current gap, and THE HEAD ROW
carries the live gate verdict from the same `recheckBeforeSend` the dispatcher will ask.
Per-sender counts sit under it. The 18/15/12-style split Tabish asked about is
`stableIndex` (FNV-1a) spreading never-messaged recipients across the ring —
deterministic and roughly even, never exactly even; nothing to fix.

### THE PACE IS ONE MINUTE NOW, WHICH IS THE ARCHITECTURE'S FLOOR

Tabish, twice in one day: 5 minutes was "too much", then *"make sending every 1 min"*.
`FLEET_MIN_GAP_MINUTES = 1` and the device agent's poll went **60s → 30s**, because the poll
interval was the real ceiling — one send per tick means a 60-second poll can never beat
60 seconds and on average waits half a poll past the moment the gap clears. Sends themselves
take 30-60s, so the observed cadence is one message every 1-2 minutes.

**There is nothing below this without changing `MAX_SENDS_PER_TICK`**, and that is the
number that cannot cluster — so "faster" from here means concurrent browser drives against
revenue accounts, which is a different decision entirely. The ban-pattern risk was stated
again when he asked and is recorded as his, like the caps.

**`tests/stopInventory.test.ts` had a fixture that went stale the moment the gap changed** —
`['too-soon', { minutesSinceLastSend: 1 }]` stopped producing `too-soon` once the gap became
1, so the case silently stopped exercising the stop it names. It reads
`FLEET_MIN_GAP_MINUTES - 1` now. A fixture that pins a number the rule owns goes stale the
first time the rule changes, and it goes stale GREEN.

### "I HAVE REPLIED" RELEASES EVERYTHING IMMEDIATELY — NOW PROVEN BY EXECUTION

Tabish: *"The moment a human clicks on 'I have replied' manually all messages to that account
must resume."* It already did — all three enforcers (`gate.ts`, `plan.ts`, `onDemand.ts`)
scope the halt with `replyHandledAt: null` — but **nothing executed that claim.**
`tests/replyHalt.test.ts` covers `replyHaltActive`, the PURE predicate, and no enforcer calls
it: they each express the halt as a QUERY, and a query filter is a property of the generated
Prisma client (the `skipDuplicates` gotcha, one door along).

`tests/reply-release-live.test.ts` runs the real `recheckBeforeSend` against a real database,
both directions, and was MUTATION-TESTED: dropping `replyHandledAt: null` from the gate's
query fails it. It asserts the reply stop is GONE rather than `ok: true`, because
`CREDENTIAL_ROOT` is not overridable and a seeded account can therefore never hold a session —
and TARGET_REPLIED is evaluated before NO_SESSION, so its absence is the release. The reply,
its text and the REPLIED status all survive being handled; history is never erased.

### THE DISK FILLED COMPLETELY, MID-SESSION, AND THE PROJECT'S OWN TOOL FIXED IT

`ENOSPC: no space left on device` on an ordinary file write. MEASURED: **172 MB free of
228 GB**, the Data volume at 100%. This is the growth `ig:prune`'s docblock projected in
August (26 GB free then, "44.7 GB unpruned at 65 profiles") arriving in full.

`pnpm ig:prune --run` freed **1,321.8 MB across 7 profiles (1,814 MB → 492 MB)**, and all
7 sessions verified byte-identical afterwards. **Stop the device agent first** — the pruner
refuses while Chrome holds a profile, which is correct and which means a running agent
blocks the one command that unblocks the disk. Two things worth knowing: the reply sweep
makes cache growth proportional to conversations READ as well as messages sent, and
`~/Library` (1.4 TB by `du`, i.e. mostly cloud placeholders) is where the machine-wide
problem actually lives — that half is Tabish's to decide, not this project's to delete.

### PAID POSTS: TWO BOXES, AND THE FUNNEL IS ON THE PAGE

The verdict boxes are CAMPAIGN and ORGANIC only (Tabish: "only paid and ordinary");
"not judged" survives as the one quiet sentence when non-zero, because it has never
meant organic. Under them, the funnel in live counts — paid posts → companies Instagram
itself names → live prospects → queued/contacted/retired — which is the honest answer to
"356 paid posts, why 75 messages": most paid posts name nobody or repeat a company, and
a fully anonymous paid post yields NO prospect by design (existence is not identity).



## THIS REPO IS SHARED NOW — READ `docs/SECOND-MACHINE.md` BEFORE SETTING IT UP

As of 2026-08-17 the code goes to a second operator on their own Mac, via
`github.com/dmpl6454/ds-sales-agent`. That changes the threat model, because **`SEND_ENABLED`
defaults TRUE** — a fresh clone on somebody's laptop can drive a browser and DM a real
company, where the hosted deployment is hard-floored off.

**VERIFIED BY DOING IT, not by writing it down.** The repo was cloned into a temporary
directory and set up exactly as a newcomer would: 336 files, `pnpm install` (postinstall
generates the SQLite client), `cp .env.example .env`, `pnpm typecheck` clean, `pnpm test`
**1,567 passing / 78 files**, `pnpm db:push`, `pnpm db:seed`. All of it worked with no
database, no tunnel and no API key.

**AND THE APP WAS STILL UNUSABLE.** `.env.example` did not mention `SIGNUP_INVITE_CODE`, and
an unset invite code means signup is **CLOSED** — correct on a server, a dead end on a
laptop. You start the app, open `/sign-up`, and can never create the account that would let
you in; nothing on screen explains it, because from the code's point of view nothing is
wrong. `SEND_ENABLED` and `MAX_TOTAL_SENDS` were missing too.

`tests/env-example.test.ts` is now TOTAL over the schema in `src/lib/env.ts`, the same way
`tests/stopInventory.test.ts` is total over `RESEND_BLOCKS` — the failure mode is a key
somebody adds and forgets to document, and no behavioural test can fail for a line of
documentation nobody wrote. Mutation-tested: removing `SIGNUP_INVITE_CODE` from the example
fails two assertions.

**What must never be shared, and is not in the repo:** `.env` (untracked in all 13 commits;
a pattern scan of the whole history is clean), `~/.ds-sales-agent` (Chrome profiles — the
cookie key here is a PUBLIC CONSTANT, so a copy of that directory decrypts offline), and any
Instagram session. **Sessions are deliberately not copyable between machines**: each Mac logs
in by hand, once per account, from its own home IP. That is the single load-bearing safety
choice in the whole design and it is why a second machine cannot be bootstrapped from the
first one's profiles.

---

## 20 AUGUST — "OFF" DID NOT MEAN OFF, AND EVERY LAYER WAS BEHAVING CORRECTLY

**Tabish, watching it happen: *"I have clearly turned off autopilot, browser pop up and
message delivery still occurs in front of my eyes."*** He was right, and the reason is the
most instructive shape in this file: nothing was broken, and the product still did the thing
he had just told it to stop.

**MEASURED, before changing anything:**

| | |
|---|---|
| deliveries after the switch went off | **ZERO** |
| the switch | OFF at 07:43:26.853Z, by him, audited |
| the last delivery | recorded 07:43:13.719Z — **13 seconds BEFORE** he pressed it |
| the dispatcher | held with `autopilot-off` on every tick from that second onward |

So the message he watched land was a send already mid-flight, which the design permits
deliberately (*"at most the one message already in flight completes, because a send under
way is a browser mid-paste"*). That half was correct and is worth keeping.

**THE BROWSERS WERE THE REPLY SWEEP, AND IT NEVER ASKED THE SWITCH.** Moved onto the device
agent on 2026-08-19 to fix the eleven-day reply blindness, it opens up to four real Chrome
profiles every 30 minutes — *and once the instant the agent starts* — with no autopilot gate
and, since the active-hours window was removed the same day, **around the clock**. Reading
is not sending, so on its own terms it was fine; from the operator's side it is a browser
touring conversations from a revenue account after he pressed stop.

**This file predicted it, in these words, when the sweep still lived on the server:** *"the
fix is to move the sweep onto the device agent, and that means unattended browser sessions
against revenue accounts, which is an exposure change to decide rather than to slip in."*
It was slipped in.

**THE RULE NOW, and it is the general one:** the one control the product offers means *stop
touching my accounts*, not *stop sending*. Any pass on the device agent that launches a
Chrome profile asks `autopilotEnabled` first and **fails closed** when it cannot read it —
"we could not ask" must never authorise driving a browser, the same direction as
`identify()`'s `no-answer`. `replyPass` asks before it even takes the send lock.

**Nothing is lost by gating it**, which is what makes this conservative rather than a trade:
with the switch off no follow-up can land, so the guard has nothing to guard;
`ensureConversationChecked` still reads the exact thread immediately before every follow-up
once it is back on; and a reply arriving while it is off is picked up by the first sweep
after it resumes, before anything goes out.

### THE FIRST VERSION OF THE TEST PASSED THE MUTATION, WHICH IS WHY IT IS BEHAVIOURAL NOW

The obvious guard was a source grep — *"the switch is read before the thread read"*. Deleting
the early return leaves `autopilotEnabled` sitting above `checkForReplies`, so **the grep
passed against the exact edit that reopens the hole.** A grep proves a fact is CONSULTED;
only calling the function proves it GATES. `tests/autopilot-off-drives-no-browser.test.ts`
drives `replyPass` with the switch off and asserts `checkForReplies` is never reached —
verified to FAIL when the gate is deleted, and to pass in the permitting direction and the
unreadable-switch direction. A source check beside it refuses any NEW browser driver on the
agent (`launchProfile`, `sendDm`, `openAndReadThread`, …), because that is how this one
arrived and no behavioural test can fail for a caller nobody has written yet.

**VERIFIED LIVE:** agent restarted with autopilot still OFF — `→ autopilot is off — the
reply sweep opens no browser`, **zero Chrome processes**, brand discovery still running
(it drives no browser, so it is deliberately NOT gated: prospects keep arriving while
sending is stopped).

---

## 18 AUGUST, LATE — SPACING CAME BACK, DISCOVERY RUNS ITSELF, AND `/` WAS 500 FOR AN HOUR

**Read this before the section below it: it CORRECTS three things that section shipped.**
All three were found by running the system rather than by reading it, and one of them was
in front of Tabish as a broken page.

### `Infinity` REACHED `Array.from`, AND EVERY PAGE RETURNED 500

`FLEET_MAX_PER_HOUR = Number.POSITIVE_INFINITY` was correct as a rule and fatal as a
drawing: `pace.tsx` renders one pip per allowed send, so `Array.from({ length: Infinity })`
threw `RangeError: Invalid array length` and `/` was HTTP 500 on every request. The console
error Tabish screenshotted (*"Encountered a script tag while rendering React component"*) is
NOT this — it is a pre-existing dev-only notice about the theme boot script in `layout.tsx`,
and it is noise. The 500 was in the server log, one line above it.

**The fix is not a null check.** `PaceBand` now takes `perHour` and `minGapMinutes` from
`dispatchStatus().limits` — *the values the dispatcher actually enforces*, which are the
`Setting` rows where they exist and the constants otherwise. Importing the constant was one
source short of correct all along: a Setting row overriding it would have made the page
state a limit nobody was enforcing, which is the `MAX_TOTAL_SENDS` failure with the roles
reversed. With no allowance the row draws the rule that IS in force — the 5-minute gap and
the ceiling it implies (~130/day).

**This shipped because `pnpm ig:layout` was never run after the restructure** (it needs the
server up, and the server was mid-deploy). Running it then found two MORE things, both
pre-existing and both general: `.grid-2` was a hard `1fr 1fr` that could not collapse, and
the history table had no `.table-wrap` — together they scrolled `/analytics` 108px sideways
at 800px. `/`'s query budget also drops **520 → 160**, because the per-draft gate loop it
was sized for is gone and a ceiling four times the real figure cannot catch the regression
it exists for.

### CROSS-ACCOUNT SPACING IS BACK, AND IT EXCLUDES THE SENDER ITSELF

Tabish, within the hour, watching it run: *"add back cross account spacing, we do not want 3
accounts to send the same message to the individual 3 times."* MEASURED when he said it:
**6 recipients had been reached by more than one of our accounts, and @absolutejk by three**
(@bollywoodchronicle, @bollywoodsocietyy, @madaboutmarketingg). The morning's removal
reproduced the 2026-08-17 duplicate incident within hours — which is the strongest evidence
this file can offer that the rule was load-bearing rather than decorative.

`TARGET_RECENTLY_CONTACTED` is restored at the governor AND the gate, absolute, with the
window from `settings.defaultCooldownDays` (7 days, restored to settings with it).

**ONE DELIBERATE DIFFERENCE, and it must not be "simplified" away:** the lookup now carries
`senderId: { not: senderId }` — it asks whether ANOTHER of our pages wrote, not whether
anyone did. It used to include self, which was harmless while a 7-day per-pair cooldown said
the same thing; that cooldown is gone and Tabish's rule is FIVE A DAY from one account, so
including self would silently reinstate a seven-day pair cooldown and contradict the number
he chose — presenting as "the queue stopped draining", days later, pointing at nothing.
`tests/cross-account-spacing.test.ts` is a SOURCE GREP over both call sites for exactly that,
mutation-tested; the boundary is tested in both directions in `governor.test.ts`.

**VERIFIED LIVE by executing the gate against the real queue**, not by reading it: 10 waiting
drafts now held with *"this recipient heard from @bollywoodchronicle 6h ago — spacing applies
across every page, not per account"*, and **64 still clear to send** — a rule that binds
without becoming an outage. The 6 duplicates cannot be unsent; all 6 are now inside the
window, so no seventh is possible.

### BRAND DISCOVERY RUNS ITSELF NOW, ON THE DEVICE AGENT

Tabish: *"this should run automatically, nothing should be manually run."* He is right, and
this file already had the principle: *a feature that works only when someone runs a command
is not running.* `autoResolveBrands` — **the same function the server calls**, not a copy —
now runs on the device agent every **30 minutes** at **25 lookups a pass**, which puts it on
the home IP where the profile endpoint answers instead of 429ing. It is on its own timer
rather than inside the send tick (6-second lookup spacing would delay delivery by minutes),
guarded against overlapping passes, never able to fail the agent, and NOT gated on autopilot
— discovering who bought a placement is reading public data, and gating it on the send
switch would mean turning autopilot on to a queue that stopped being filled hours ago.

**VERIFIED: the first automatic pass ran at 17:54 IST — `looked=9 created=4 unsure=1
unreached=0 haltedEarly=false`.** Four prospects nobody typed a command for.

### AND THE DEPLOY SPRANG BOTH OF ITS DOCUMENTED TRAPS, IN ONE COMMAND

The server dashboard was down for ten minutes because I typed the archive deploy instead of
following this file's own procedure. Both traps are already written down here, and both
still fired:

1. **`tar xzf` never deletes.** Three files deleted from the repo hours earlier
   (`src/app/settings/{actions,form,template-form}.ts[x]`) were still on the server, still
   importing settings that no longer exist — and `next build` typechecks what it FINDS, so a
   deploy of correct code failed on code that was not in the repo at all.
2. **`pnpm build | tail -1` masks the exit code**, so pm2 started with no production build.
   That exact failure is documented two sections down, verbatim, from the last time.

**`bash scripts/deploy.sh` is the answer** — the file list comes from `git ls-files`, stale
files are removed explicitly (`LC_ALL=C sort` on both sides), the build's status is read
directly, and pm2 is restarted ONLY on success; on failure the server is left STOPPED with
the log printed, because a running old build beats a started new one with nothing behind it.
A rule written down is not a rule enforced; this one is a script now.

---

## 18 AUGUST, EVENING — EVERY VOLUME CAP BUT ONE IS GONE, ON TABISH'S INSTRUCTION

**Read this before trusting anything below it about caps, spacing, personas or the message.**
Tabish, verbatim intent: *"there must be only a limit of say 5 messages per target per same
account in a day (this should then result in 100s of messages being sent to multiple targets
in a day), rest unlimited. Remove all caps … cooldown if conversation is ongoing to 2 days"*,
one universal template *"no signature name whatsoever … no space after hi, it is all
continuous"*, no settings page, CSV export of sends. **The ban-pattern risk — this file's own
"several hundred a day from three accounts is the ban pattern" — was stated to him plainly;
the call is his and is recorded as his, like reply auto-resume and one-switch before it.**

### THE "STALL" HE REPORTED WAS THE CAPS PLUS THE TOGGLE, MEASURED BEFORE ANYTHING CHANGED

Autopilot delivered FIVE times that day (10:46, 10:58, 11:32, 13:48, 14:01 IST, all
chronicle), but each ON window emitted one send and then held — the 5-minute gap, then the
3/hour allowance, then chronicle's dailyCap=5 spent by 14:01 — and the toggle was flipped
ON/OFF six times (all audited) and was OFF when investigated. Also measured: **all 72
waiting drafts belonged to @bollywoodchronicle** — rotation elected the ring FRONT for every
never-messaged recipient, so one account owned the entire queue; and the three new channels
added that morning (@bollywoodpaparazzii, @bachelorssociety, @totalfilmii — sessions
recorded, personas set) sat in cohort 2 behind the 14-day soak with zero drafts. The 10:52
interstitial retry burst (3 failures) was the OLD agent code; the 11:15 restart picked up
the fix and the same recipient delivered at 11:32.

### WHAT THE SYSTEM IS NOW

- **ONE volume rule: `PAIR_DAILY_CAP` — 5 delivered/day from one account to one recipient**
  (`MAX_PER_PAIR_PER_DAY`, env default 5, clamp 1..10). Enforced in the governor, the gate,
  and atomically as a `scope: 'pair'` reservation. It replaced MAX_PER_TARGET_PER_DAY
  (cross-sender), SENDER_DAILY_CAP, the 7-day pair cooldown, TARGET_RECENTLY_CONTACTED
  (sender-blind spacing), UNANSWERED_LIMIT, the new-brand delivered/day cap, and the fleet
  hourly allowance (FLEET_MAX_PER_HOUR = Infinity; a `fleetMaxPerHour` Setting row re-binds
  it in one write — that is the first lever if checkpoints appear).
- **What still stands, deliberately:** active hours 10:00–21:00 IST, the 5-minute fleet gap
  (~130 deliveries/day practical ceiling), the reply halt (now **48h** —
  REPLY_RESUME_HOURS_DEFAULT), NO_NEW_MATERIAL (without it the planner would re-draft the
  identical template to every unresponsive recipient daily, forever), opt-out, watch-only,
  the person guard, the cohort ladder MECHANISM (its soak is a Setting row now at **0** —
  new accounts send immediately, his call), checkpoint handling, the circuit breaker, the
  composer read-back and thread delta, queue depth 150, and MAX_TOTAL_SENDS.
- **THE MESSAGE IS THE TEMPLATE, VERBATIM.** `composeForPair` under `singleTemplate` returns
  `singleTemplateBody ?? SINGLE_TEMPLATE_MIDDLE` byte-for-byte: no greeting, no signature,
  no hook — `renderMessage` is not called. The shipped copy is Tabish's one-line text
  ("Hi,We're an Entertainment & Pop Culture Media Network… - Kapil"). A single-line body
  takes `proseLines`' single-line branch (nothing dropped by position), so the needle is the
  line's first 60 chars — verified by execution, plus `checkTemplateBody` now validates the
  verbatim text. **The floor is now simply: keep the template over 40 characters.**
- **Persona is gone from everything a recipient sees**, so `checkPersonaDistinct`,
  `personaFingerprint`, `validatePersona`-in-planner, PERSONA_NOT_DISTINCT and
  PERSONA_CHANGED_SINCE_DRAFT are deleted; the persona editor and the senders form's name
  field went with them (`addSender` takes a handle, full stop). HOOK_STALE_SINCE_DRAFT went
  too — no dated claim renders. The columns survive; nothing reads them into messages.
- **Rotation spreads fresh recipients by hash.** `nextSender` starts a never-messaged
  recipient at `stableIndex(targetId, ringSize)` (FNV-1a, exported, deterministic across
  hosts) instead of the ring front. Without this, "no caps" meant "130/day from ONE
  account" — the per-account ban pattern wearing rotation's clothes.
- **UI:** the queue is a per-sender COUNT table (no per-draft cards — every draft is the
  same bytes; the per-draft gate loop and its ~7 queries/row went with it, so `/` is far
  under budget); the template editor lives on the Autopilot page; **/settings is a redirect
  stub**; **/analytics has the CSV export** (`/api/export/messages`, filters: IST date
  range, account, delivered/replied/all; columns: IST+UTC time, sender, recipient, status,
  sentBy, touch number, reply, thread URL; capped at 10,000 rows).
- `fleetUsage` counts DELIVERED `OutreachAttempt` rows now (unlimited buckets write no
  reservation rows, so the old source would read 0 forever), with the hour boundary derived
  from the IST helpers, not the host clock — the Linode is not on IST.

### DEPLOYED AND VERIFIED LIVE, SAME EVENING

Committed (`90c96bb`), tar-deployed to the Linode (install → postgres client → pm2 stop →
build → start; scheduler up, detection every 15 min), device agent restarted 16:54:28 IST.
DB ops, each with an audit row: `cohortSoakDays=0`, stale `maxNewBrandTouchesPerDay=10` row
deleted (the stale-Setting-row trap, pre-empted this time), autopilot ON. All 72
old-template drafts discarded via the broom (`ig:discard-stale-drafts` — its
`requiredPhrase` now reads the EFFECTIVE template, fixing the noted bug where a saved
override classified every current draft stale). Tests **1,551 / 80 files**, typecheck and
`pnpm build` clean on both hosts.

### AND THE FIRST LIVE SENDS FOUND A CLIPBOARD ENCODING BUG THE SUITE NEVER COULD

The first agent-driven send of the new template refused with `composer-mismatch: 242
chars staged vs 238 drafted`, three drives in a row — while the IDENTICAL code delivered
from a CLI. The refusal now logs the staged bytes, and they named it: `We‚Äôre` —
**`pbcopy` under launchd has no `LANG`, so the template's U+2019 apostrophes (the first
non-ASCII bytes any template ever carried) were decoded as MacRoman**, three characters
each (+2 × 2 = the 4-char difference, exactly). Reproduced in both directions with
`env -u LANG pbcopy`; fixed by pinning `LANG`/`LC_ALL=en_US.UTF-8` in `run()`
(platform.ts) — the same trap as Windows `clip.exe` corrupting em-dashes, one platform
over. The composer read-back guard was RIGHT every time, and parked nothing: retries
delivered once the restarted agent held the fix.

**VERIFIED LIVE: the new regime delivered its first two messages** —
17:07 `autopilot:madaboutmarketingg → @absolutejk` and 17:16
`autopilot:bollywoodsocietyy → @agoracitycentre`, both 238 chars (the template's exact
length), both from accounts that had never sent unattended before. The queue rebuilt
spread across ALL SIX accounts (12/9/13/12/17/10), 0 parked rows, autopilot ON. Note
what the removed spacing permits, concretely: @absolutejk has now heard from THREE of
our pages in two days — that is the trade Tabish chose, visible on its first afternoon.

**What actually bounds throughput now is PROSPECT INFLOW, not caps**: first touches drain
the queue and new prospects arrive only from detection plus `pnpm ig:brands --run` on a
home IP. Follow-ups still require new material. If sends must slow down in a hurry:
autopilot OFF (instant), or a `fleetMaxPerHour` Setting row.

---

## 18 AUGUST — THE SECOND LOOK'S FIRST REAL BATCH SAYS IT CAUGHT NOTHING, AND THE REPLY SWEEP HAS NEVER RUN

### `no-composer` WAS A DIALOG, AND THE RETRY LOOP BEHIND IT WAS THE REAL FIND

**Instagram now shows business accounts an INTERSTITIAL instead of the composer** for some
professional recipients — *"Partnership messages are more likely to get a response…"* with
two buttons, "Send prioritised message" and "Send message request". Tabish supplied the
screenshot; the send path had never seen it, so the composer lookup timed out behind the
dialog and the outcome was filed `no-composer` — a name that reads "this account cannot be
messaged" about an account that can. `sendDm.ts` now clicks **"Send message request"** —
never "prioritised", Tabish's explicit instruction and the ordinary DM lane — in a
four-second window between the Message click and the composer lookup. Expect this dialog on
MORE of the queue: it is recipient-side Instagram behaviour, not a property of one account.

**And the failure it produced exposed something worse than itself.** The generic failure
branch returned the draft to READY — which is exactly what the dispatcher picks up — so the
same draft was retried ONCE A MINUTE, each retry driving a real Chrome profile at
Instagram, and each retry spending the whole per-tick bound so the other 73 drafts starved
behind it. MEASURED live: four consecutive minutes of `delivering → anandpanditmotionpictures
… failed=1` before a hand parked the row. **The `attempts` counter was incremented in four
places and read by NOTHING** — this codebase's signature failure, in the loop whose entire
job is pacing browser drives against revenue accounts.

`MAX_DELIVERY_ATTEMPTS = 3` now parks a repeatedly-failing draft in FAILED — the
`not-in-thread` treatment, for the same reason — and parking is only safe because it is
VISIBLE: the landing page has **"Gave up after repeated failures"** with the failure named
and two controls (`requeueParkedAttempt`, which resets the counter or the cap re-parks it
on its first failure and the button appears dead; and Discard, `discardAttempt` widened to
FAILED rows with `failureCode ≠ not-in-thread` — that one exclusion carries the safety,
because a not-in-thread row may have REACHED the recipient and must go through its own
two-button flow).

### 15 AUGUST ON M.O.M, POST BY POST — THE DATA DOES NOT SUPPORT "MORE PAID"

Tabish asked whether M.O.M should have more paid posts around 15 August. All 13 posts from
14–16 Aug, read individually: **5 CAMPAIGN** (D'Décor×Ranveer Singh, ZEISS, The World at
Jubilee Hills, LAVA — all four rule-disclosed with #Collaboration — plus the Zomato
Independence-Day post the second look escalated) and **8 ORGANIC**, every one of which is
M.O.M writing ABOUT someone else's campaign or pure filler: IKEA's co-worker-day campaign,
a Mercedes gesture for a disabled dog, Netflix's horror-street stunt, a Ted Lasso quote, a
meme. The classifier's stated reasons name the distinction each time ("commentary on a
campaign, not a paid promotion"). **If Tabish believes any of those eight WAS paid, the
label control on /paid-posts is the mechanism** — his answer becomes `verdictSource:
'human'`, outranks the model, and joins the ground truth. In-window M.O.M now reads
**25 CAMPAIGN / 86 posts** (22 rule + 3 second-look).

### A PAID POST THAT NAMES NOBODY CANNOT SAFELY NAME A TARGET, AND THAT IS A MEASUREMENT

Tabish asked how a channel is targeted when a paid post has no tag, no collaborator and no
caption mention. The honest answer is structural: prospect handles come ONLY from handles
**Instagram itself asserts on the post** — caption @mentions and media tags/collabs —
because every path from a NAME to a handle was probed live and measured unsafe:
constructing a handle from a name was wrong **4 times in 10, and 3 of those 4 wrong handles
EXIST** (existence is not identity — `@philips` is the global HQ, `@philipsindia` ran the
campaign), and there is no anonymous name→handle search (`topsearch` 401s). Frame text is
additionally FORBIDDEN from naming brands — the salon control produced a DM claiming a
collaboration with the signage behind a celebrity. So a fully anonymous paid post yields a
CAMPAIGN verdict (it still counts, renders, and feeds accuracy) and NO prospect — by
design, because the alternative is a media-buying pitch in a stranger's inbox from a
revenue account. The lever that exists: `pnpm ig:brands --run` from a home IP widens the
tag-derived candidates; anything further is a new data source, not a rule change.

### AND THE REST OF THE 18 AUGUST QUESTIONS, VERIFIED RATHER THAN ASSERTED

- **Rotation works as designed, and the design is per-recipient.** A never-messaged
  recipient elects the ring front (cohort, then handle — chronicle first) and keeps
  electing it until it cannot send; yesterday's tape shows exactly that: chronicle's 5,
  then society took over at the cap. Fleet-level per-send round-robin across different
  recipients is NOT the mechanism, and with recipient-level spacing each recipient hears
  from ONE page per window anyway.
- **A human "not paid" label cannot sabotage recognition.** `labelPost` is the one writer;
  a human verdict outranks display and feeds `ig:accuracy` as ground truth, the classifier
  itself is never retrained or re-prompted by it, `judgeWithFrame` refuses to re-judge
  human-labelled posts (checked before every other branch), and the second-look backfill
  selects `humanLabel: null` only. The cascade retires prospects discovered ONLY from the
  re-labelled post and never touches one that has been written to.
- **The two watched sends delivered**: 10:47 @amazonmgmstudios, 10:58 @asshnadevelopers,
  both `autopilot:`, eleven minutes apart, no duplicate, no flag. Autopilot ON 10:45 and
  OFF 11:00, both audited as Tabish.
- **The dispatcher's "all N waiting messages were held" undercounts on purpose-shaped
  wording** — N is how many it EVALUATED before the one-drive bound ended the tick, not the
  queue depth. Known, not yet reworded.

### THE M.O.M BACKFILL: 61 JUDGED, 3 ESCALATED, AND ALL THREE READ AS FALSE ALARMS

`pnpm ig:second-look --run` on the server drained the backlog: **61 rule-negatives judged,
3 escalated to CAMPAIGN, 56 confirmed ordinary, 2 calls failed and left retryable.** Then
the escalations were READ, which is the only thing that settles them:

| shortcode | the model's reason | the caption |
|---|---|---|
| `DcC_FG_TmJE` | "Zomato Independence Day promo with branded hashtag" | *"Gotta love it when creativity is this effortless! [Independence Day] [Zomato]"* |
| `Db5fgpsE9eF` | "Promotes Rare Beauty's new fragrance billboard experience" | *"Rare Beauty has put up this billboard in New York where people can experience their new fragrance."* |
| `Dbkq8sNE0n9` | "Promotes McDonald's outlet opening as marketing story" | *"Mcdonalds opened its first ever outlet in Mexico… Here's how they got the entire city's attention."* |

**All three are a marketing publication writing ABOUT someone else's advertising** —
third-person reportage and an admiring note on a creative. That is the documented hard case,
and this file NAMES two of these three brands in its own false-alarm list from the 13 August
audit: *"all four are M.O.M commentary about other brands' campaigns — McDonald's, Miu Miu,
Netflix, Rare Beauty."* All three sit at **confidence 85**, the bottom of the model's
eight-value vocabulary and its ORGANIC floor — so the number carries no information here.

**So the honest score on the first real batch is 0 confirmed catches against 3 probable false
alarms.** The predicted precision cost arrived; the hoped-for recall gain did not appear in
61 posts. What that does NOT establish is that no undisclosed M.O.M paid post exists — a
batch with no catch is not evidence of an empty population, and recall is the thing this
project never trades. Both readings are on the table and **it is Tabish's call whether the
second look stays on for M.O.M**; the mechanism, the command and the `--run` default are
unchanged either way.

**The blast radius was measured before it was reasoned about, and it is small.** None of the
three carries an @mention or a tag, so `autoResolveBrands` cannot mint a prospect from any of
them; with `singleTemplate` ON a CAMPAIGN verdict never reaches message copy; and the cross on
`/paid-posts` undoes each one in a click. The cost is three wrong rows on a screen — plus a
real cost that is easy to miss: **`ig:accuracy` now scores these as false positives**, which is
the harness being correct rather than a regression to chase.

### THE TWICE-DAILY REPLY SWEEP CANNOT RUN WHERE IT IS SCHEDULED. IT NEVER HAS

**MEASURED: `replyCheckedAt` is non-null on ZERO attempts, ever.** `replyCheck.ts` asks
`profileStatus(handle).hasSession` — a FILESYSTEM check — and it is scheduled inside `runSlot`,
which runs on the **Linode**, which has no `~/.ds-sales-agent` at all. So the 11:00 and 20:00
sweeps fire, find every account signed out, and skip every conversation. Not a bug in the
sweep: it is the hosted split, and the same shape as the planner's `profileStatus` trap that
nearly stopped drafting fleet-wide on 13 August — *a guard that mixes shared-database facts
with per-host filesystem state answers differently depending on where it ran.*

**What still holds, so this is a gap and not an open wound:** `ensureConversationChecked` runs
on the DEVICE immediately before every FOLLOW-UP, which is the design's real answer (coverage
proportional to messages sent, not to prospects held). All 7 deliveries so far are FIRST
touches, which are exempt by construction — there is no conversation to read. And `optedOut`,
the reply HALT and the 7-day spacing are all unaffected.

**What is genuinely not happening: nobody is watching the 7 open conversations.** If a prospect
replies today, nothing detects it until either a follow-up to that same pair is attempted or
somebody runs `pnpm ig:replies` from the Mac. **NOT FIXED HERE, deliberately** — the fix is to
move the sweep onto the device agent, and that means unattended browser sessions against
revenue accounts, which is an exposure change to decide rather than to slip in. Until then
`pnpm ig:replies` on the Mac is the answer and the reply rate on `/analytics` should be read as
*"0 of 7, and nothing has looked"*, never as *"nobody replied"*.

### "NO NEW DRAFTS IN SIXTEEN HOURS" IS SATURATION, NOT A STALL

The planner runs every 15 minutes on the server and had written nothing since 18:15 the
previous evening, which reads exactly like the drafting outage this file has recorded twice.
It is not one. MEASURED: **82 live prospects — 72 hold a waiting draft, 5 have been messaged,
and the 7 with neither are the PEOPLE** `checkRecipientIsNotAPerson` refuses (Rahul Dev,
Karthik Subbaraj, Shalini Passi, a photographer, …). There is nothing left to draft *for*.

The queue only grows when a new prospect appears, and new prospects only appear when somebody
runs `pnpm ig:brands --run` from a home IP — the server is still 429'd on the profile endpoint.
Newest prospect: 17 Aug 14:17 IST, from that run. **So the drafting cadence a person actually
experiences is: within 15 minutes of a new PROSPECT existing, and prospects arrive at the pace
of the home-IP command, not of detection.** Detection itself is unaffected and healthy.

### THE REST OF THE SWEEP, ALL GREEN

| | |
|---|---|
| detection | 26 @viralbhayani + 4 M.O.M posts in 18h, **median latency 9 minutes**; heartbeat `linode-detect` 1 min old |
| the second look, live | all 4 new M.O.M posts carry `verdictSource: semantic` — before 17 Aug they would have read `rules`, so the pipeline half is confirmed running in production |
| duplication | **still exactly the 2 pre-guard duplicates.** Zero new ones overnight; the 3 held drafts are still held |
| in-flight | 0 SENDING, 0 FAILED, no stuck rows |
| settings | 4 rows, none touched since 17 Aug 18:35 (autopilot OFF, by Tabish). **No `singleTemplateBody` row** — the template editor exists and nobody has overridden the shipped copy |
| cost | **$0.2077 total, ever**; $0.0359 in 24h across 1,280 calls, cache hit **95%**, 4 failures in 8,063 calls |
| unjudged | **1** in-window @viralbhayani post, `classifier:no-verdict` from 14 Aug — one failed call, retryable with `ig:classify` |

---

## 17 AUGUST, EVENING — AUTOPILOT'S FIRST REAL SEND, AND WHY IT NEVER WORKED BEFORE

**At 17:44 IST autopilot delivered its first unattended message from a revenue account
ever** — `autopilot:bollywoodchronicle → @absolutejk` — one minute after the fix, which
was not a code change at all. It was `launchctl kickstart`.

### THE DISPATCHER WAS A NINE-DAY-OLD PROCESS ENFORCING A DELETED RULE

The device agent (`com.digitalsukoon.ds-sales-agent.watch`, pid 23423) had been running
since **8 August** — started the same day the one-switch redesign deleted
`autoSendEnabled`. Node froze its modules at start, so for nine days the only process on
the Mac that could send held every draft with *"auto-send was switched off for
@bollywoodchronicle"* — **a sentence that exists nowhere in the current tree**, about a
switch nothing can turn on because the actions that wrote it were deleted. MEASURED at
17:32 IST: `held=78, sent=0`, all on that one reason, while `/senders` said every account
was ready and the toggle was ON. The dashboard could not name the stop because the stop
had been deleted from `STOP_LABELS` — a stale process is the one enforcer the
"every refusal explains itself" design cannot see.

**The control probe settled it in one grep**: the hold string matches nothing in `src/`,
so the process writing it could not be running the code on disk. Same lesson as the
frames reappearing in the credential directory: *a file on disk is not a running
process* — and it wears its costume better here, because the process was healthy,
beating, and writing well-formed state rows the whole time. `ps` start time is the
diagnostic: **when a guard names a rule the code no longer contains, check the process's
age before debugging the code.**

The morning's one send (`operator:bollywoodchronicle → @crocsindia`, 10:42 IST) was
Tabish pressing Send by hand — `operator:` is `sendNow`'s format. No `autopilot:` row
existed before 17:44.

### A HAND LOGIN THE POLL MISSED IS NOW RECORDED BY THE MACHINE THAT CAN PROVE IT

@madaboutmarketingg was signed in by hand at 16:53 IST and **the database never heard** —
8 `sender.connect.start` audit rows that day, 1 `sender.login`. `sessionPath` is written
only when `checkConnect`'s poll returns `connected`; stop polling (close the tab,
navigate away) and the login completes invisibly. The split is the killer:
`/senders` asks the FILESYSTEM (`sessionUsable`) and said *signed in*; rotation on the
Linode asks the DATABASE (`sessionRecorded`) and said *never signed in* — so the account
looked healthy on the one screen anybody reads while no draft could ever be written for
it. All 77 waiting drafts were chronicle's; that is why.

`src/agent/reconcile.ts` closes the class: every device-agent tick, a profile with a
session on disk whose row records no login gets recorded (`sender.login.reconciled`,
actor `device:<name>`). It writes `sessionPath` ONLY — **never `sessionInvalidAt`**,
which clears on proof alone (§3.5); the fail-closed direction is pinned by
`tests/session-reconcile.test.ts` and was mutation-tested. Worst case if the disk lies
(profile holds someone else's session): rotation writes a draft, `identify()` refuses at
send with WrongAccountError — a wasted draft, never a wrong message.
@madaboutmarketingg itself was recorded the stronger way first: `pnpm ig:login`'s
already-signed-in branch, identity verified against Instagram.

### INSTAGRAM'S 2FA URL IS `two_step_verification`, AND THE CARVE-OUT NEVER MATCHED IT

The live prompt (seen in a real hand login, screenshot 17 Aug) is
`/accounts/login/two_step_verification?encrypted_context=…`. `TWO_FACTOR_PATHS` shipped
matching `/two_factor` only — and `/accounts/login` IS a substring of the real URL, so
`classifyUrl` returned **needs-login**: a routine code prompt on a 2FA-enabled account
read as a DEAD SESSION, and the §3.5 cascade would have marked a live revenue session
invalid on false evidence. Executed, not inferred, before and after the fix.
`tests/session-paths.test.ts` now pins the URL Instagram actually serves, verbatim —
the older tests pinned the URL the author assumed, which is how the gap shipped green.

### AND THE VOLUME LIST WAS HONEST BUT NEVER ADDED ITSELF UP

Tabish read *"2 per recipient per day"* on /rules as the system's total throughput and
called the page a lie. Every number was true; no line said what the fleet can do in a
day. /rules now carries one derived line — pace ceiling (3/hr × 11h = 33) against the
fleet accounts' own caps (sum of `dailyCap`, 15 today) — and says outright that the
per-recipient number protects an inbox, not throughput. **The daily ceiling is
min(pace, account caps, 10 new-brand touches), and "several hundred a day" from three
accounts is not a setting away — it is the ban pattern**, stated to Tabish rather than
configured. Scale comes from the 61-account ladder, never from cranking three.

### AND WITHIN THE HOUR, ROTATION GOING LIVE EXPOSED THE MISSING SPACING RULE

**Tabish caught it from the dashboard before any code did**: @absolutejk heard from
@bollywoodchronicle at 17:44 and from @bollywoodsocietyy at **18:13** — twenty-nine
minutes apart, near-identical template bodies, different page names. @crocsindia the
same (10:42 manual, 18:07 society). Three more society drafts sat queued at recipients
chronicle had reached that afternoon.

**Every spacing rule was PER PAIR.** The 7-day cooldown, the touch counter, the
first-touch exemption from new-material — all keyed on (sender, target). So a second
page writing to a fresh recipient was a textbook first touch with no history; the only
cross-sender rule (`MAX_PER_TARGET_PER_DAY` = 2) PERMITS exactly one duplicate a day;
and rotation then deliberately elects the NEXT page for the next touch — spreading
senders across one recipient is its whole point, and that is precisely what it did,
half an hour apart. Nothing anywhere asked *"has anyone written to this person
lately?"* This only became reachable the day THREE senders held recorded sessions,
which is why two weeks of running never showed it.

**`TARGET_RECENTLY_CONTACTED` now exists at both ends and is sender-blind**: the
governor refuses to draft, and the gate refuses to deliver, any message to a recipient
with a DELIVERED message from ANY page inside the spacing window (`cooldownDays`, 7).
A BLOCKED sender never locks a recipient — nothing was delivered — so the fallback
Tabish described ("another page only if the first was blocked") holds by construction.
Absolute like the daily caps; the override is inert and tested. VERIFIED live within a
minute of the agent restart: all three queued duplicates held with *"this recipient
heard from @bollywoodchronicle 1h ago — spacing applies across every page, not per
account."* The two delivered duplicates cannot be unsent; both recipients are now
inside the window, so a third touch is refused everywhere.

The inventory test caught my own first version: `!== null` let `undefined` straight
past both new checks — fixtures that omit a field are exactly how a guard ships
half-wired. `!= null`, and the totality tests now carry a case for the new stop.

### THE M.O.M SECOND LOOK, AND A TEMPLATE EDITOR — BOTH SHIPPED THE SAME EVENING

**The `mom` rule's negative now reaches the model** (Tabish: "make sure paid posts
detection is accurate … for both viral bhayani and madabout"). MEASURED before the
change: **61 in-window M.O.M posts were rule-negative and NOTHING had ever read them**
— the "missed with certainty" class from the 13 August audit. `judgeWithFrame` now
takes `detectorKey` instead of `frameJudgingSupported` (judge.ts owns what each
detector permits — the compiler named all four call sites, including one a grep
missed), and `SECOND_LOOK_DETECTORS` re-judges a mom rule-NEGATIVE with the semantic
model, caption first and alone, then the frame. **A rule POSITIVE is never touched** —
a disclosure is a fact and stays label-grade `rules`. A failed call decides nothing and
stays selectable. `pnpm ig:second-look` (DRY RUN default) drains the 61 — **run it on
the server**, where the frames live; it refuses to persist machine-local absence
signals for exactly the reason `tests/rejudge.test.ts` pins. Same-day harness
(`--repeat 3`, predRule `final-campaign`): M.O.M recall **100-100%**, correct 96-97%,
precision 87-90% over 98 labels.

**The standard message is editable on /settings** (`singleTemplateBody` Setting, null =
the shipped copy). `checkTemplateBody` runs the save through the REAL `renderMessage`
and the REAL `distinctiveSlice` — writer and probe share bytes — because the mechanical
floor on that copy ("at least one paragraph over 40 chars or EVERY send refuses") is
now one textarea away, and it would otherwise surface hours later as a fleet-wide
outage pointing at nothing. `{{tokens}}` are refused outright: the renderer adds the
only two things that vary, and braces typed here would reach a real inbox as-is.
Existing drafts keep their stored bytes; the form says so and points at the discard
broom.

| after this session | |
|---|---|
| autopilot | **WORKING** — 5 unattended sends 17:44–18:13 IST, then honest holds (hourly allowance, then the new spacing stop) |
| the duplicate incident | 2 recipients double-messaged before the guard existed; 3 more were queued and are now HELD; guard live at both ends |
| sessions | all four accounts `sessionRecorded`, zero dead-session marks; the reconcile net catches the next missed poll within 60s |
| today's remaining room | chronicle spent its 5/day; society delivered 2; fresh recipients only, per the new stop |
| detection | M.O.M second look live in the pipeline; the 61-post backlog drains via `ig:second-look` ON THE SERVER after deploy |
| tests | **1,600 / 80 files**, typecheck clean; three new guards mutation-tested |

---

## 17 AUGUST, AFTERNOON — IT IS DEPLOYED, AND FOUR THINGS BELOW THIS LINE WERE FALSE

**Read this before the section under it.** The 17 August work is now COMMITTED and RUNNING
on the Linode. Deploying it is what made the next four findings visible, and every one of
them was invisible to a passing suite.

### THE HEADLINE CHANGE WAS NOT IN FORCE. A `Setting` ROW WAS DEFEATING IT

`singleTemplate` defaults **true** in code, and the live database held **`false`** — a row
left from 2026-08-06 when the flag shipped off-by-default, with **no audit row**, because
settings were not audited then. So "one standard message" was not what production wrote, and
the queue this session cleared would have been rewritten from the variant pools.

Same shape as `autoSendEnabled`: a stored bit nobody had written since, gone quietly inert
and silently outranking the code that reads it. **Turned ON as Tabish's decision, recorded as
his in the audit log.** When a flag's default changes, CHECK THE ROW — the default only
governs a deployment that has never set it.

### THE 83 `frame:call-failed` WERE NEVER FAILED CALLS

**MEASURED: 83 of 83 have a caption under 15 characters, and all 83 carry frame text.** Not
one was a failed call. `classifyCaption` returns null BEFORE making a request when the
caption is short — so no `ModelCall` row was written either, and the cost table read 1,912
successes against a single failure while 83 posts sat unjudged.

`judgeWithFrame` passes the frame prompt to that same function — a call whose input is the
caption AND the footage — and the caption-length floor vetoed it on the caption alone. The
null then reached the caller and was recorded as `frame:call-failed`, **a name asserting the
opposite of what happened**, about the exact population the footage feature exists for.

What was sitting unread, straight off the stored `frameText`: `BALMAIN`,
`EUGENIX HAIRSCIENCES`, `x300Ultra` (a Vivo handset — and Vivo is the only advertiser ever
confirmed on that channel by a disclosure hashtag), and `SONY ENTERTAINMENT TELEVISION |
24 AUG | 8PM MON`.

The floor now asks whether there is ANY evidence, which is what its docblock always said it
meant. **Deliberately NOT relaxed for tags**: tags reach both calls about a post, so lifting
it for them would let a tag-driven disagreement be recorded as `frame:disagreed-higher` and
credit the footage for something it never saw.

**This MERGES two items the handoff listed separately** — "83 posts whose footage never
reached a verdict" and "119 auto-ORGANIC by the short-caption rule, 84 with unread footage"
are the same defect from two ends. `pnpm ig:rejudge` (DRY RUN BY DEFAULT) drained it: **83 →
0, 11 verdicts escalated to CAMPAIGN.** The dry run predicted 12 and the write produced 11,
which is the documented non-determinism, not a bug.

**Read the 11 before trusting them.** Roughly 6-7 are convincing (a Sony show promo with
airtime, EUGENIX saturating a frame, a ZEE5 promo with certification); 4-5 are weak, two of
them escalating on garbled OCR fragments (`PRESE | LRA`). That precision cost was accepted
because recall is never traded here, the cross on `/paid-posts` makes it reversible, and with
`singleTemplate` ON a false CAMPAIGN **no longer reaches message copy at all**.

### "54% JUDGED ON CAPTION ALONE" IS A DEAD BACKLOG, NOT AN OPEN HOLE

The handoff asked *why*. Measured, and the answer retires the item:

| week posted | posts | caption-only |
|---|---|---|
| W31 (28 Jul–3 Aug) | 325 | **100%** |
| W32 (4–10 Aug) | 1,373 | 68.2% |
| W33 (11–17 Aug) | 820 | **0.9%** |

`judgeWithFrame` became the one judging path on 2026-08-08 and frame capture began 7 August.
So the 1,269 caption-only posts are **history**, and **only 27 of them (2.1%) have a frame on
the server's disk** — the rest never had one banked and the CDN URL is long gone. Same
conclusion as "804 recoverable frames" turning out to be 85, all HTTP 403: nothing to build,
the preventive half already works.

**THE ONE REAL AND PERMANENT GAP IS @madovermarketing_mom: 100% caption-only, by design.**
Its detector is `mom`, a hashtag rule, which never calls the frame path at all. An undisclosed
M.O.M paid post is missed with certainty. Changing that is its own decision with its own risk.

### THE MODEL NEVER HEDGES, AND THE FLOOR IS 85 NOT 80

In-window, `verdictSource: 'semantic'`: **ORGANIC 2,071 verdicts, ZERO below 80, minimum 85.**
CAMPAIGN has 10 below 80, all at exactly 60. The whole corpus uses about **eight** distinct
confidence values (60, 85, 88, 90, 92, 95, 98, 100).

That is a small vocabulary of stock numbers, not a calibrated probability. **The consequence
is a design constraint: a review queue keyed on model uncertainty would find nothing**, and
the direction where doubt would actually be useful — an ORGANIC that might be paid — is the
one where it never appears. Know this before building anything that reads a confidence.

---

## THE TAG SOURCE REACHED NEITHER PATH IN PRODUCTION — AND RUNNING IT MADE A COMPANY OF AN ACTRESS

Priority 2 was *"verify, do not rebuild"*. Verifying found the feature unreachable.

`taggedHandlesIn` shipped on 17 August wired into `autoResolveBrands` **and nowhere else** —
and that pass is 429'd on the Linode on its first lookup of every pass. Meanwhile
`pnpm ig:brands`, the command the handoff tells an operator to run **from a home IP precisely
because of that throttle**, read caption @mentions only, and did
`if (mentionsIn(c.caption).length === 0) continue` — throwing away the whole post. **51% of
in-window CAMPAIGN posts carry no usable caption @mention**, which is exactly the half tags
were added for.

So it reached neither the unattended pass nor the command a person runs, while every unit
test of `taggedHandlesIn` passed, **because the defect was a missing CALLER.** Fifth time.

`src/detection/brandCandidates.ts` is the one definition now (`brandCandidatesFor`, PURE, plus
`excludedHandles` beside it as `cohorts.ts` keeps its reader). Both invariants survive and are
tested: a caption mention is ordered BEFORE a tag, and our own pages plus watched publishers
are excluded BEFORE the lookup budget rather than refused after it is spent.
`tests/brand-candidates.test.ts` greps both call sites.

**MEASURED from the real home-IP run:** candidates 349 → **374**, of which **31 from media
tags**; 141 brands, 279 people, 78 needs-a-human, **18 new BRAND targets**.

The four checks the handoff asked for all PASS: `@deepikapadukone` PERSON,
`@itsrohitshetty` PERSON, `@bollywoodpap` PERSON ("Digital creator"), `@aasthagill` PERSON —
none became a target. Real advertisers arrived: **@lava_mobiles, @mtr_foods, @philipsindia,
@sonytvofficial, @redchilliesent, @zee5_marathi** — and `@philipsindia` rather than `@philips`
is the tag approach earning its keep, since the global HQ is what a guessed handle produces.

### AND THE PERSON RULE IS AN ENUMERATION OVER AN OPEN TAXONOMY

**@ananyapanday — a Bollywood actress with 26.3M followers — was created as a BRAND target
with three live routes**, because Instagram reports her category as **"Private
Investigator"**. So was @acharyavinodkumar, an astrologer with 2.1M, on **"Astrologist"**.

Both words are now in `PERSON_ROLE_WORDS`, and **that is a plaster, not a fix**: anyone may
set any category, and a vanity category is exactly what a celebrity sets. The structural
fault is that a category the list does not recognise is read as evidence of a COMPANY —
*absence of data becoming a positive verdict*, for the sixth time in this codebase. It should
fall through to `decideBrand` as UNRESOLVED, and that is NOT done here because it reroutes
many currently-correct resolutions through a model that **still has no accuracy harness**.
Measure it before shipping it.

`pnpm ig:retire-target` (DRY RUN BY DEFAULT) exists because the undo lived only on the
dashboard while the command that CREATES prospects must be run from a terminal on a home IP.
It sets `optedOut`, never deletes. Retired: **@ananyapanday, @acharyavinodkumar,
@deepakmukut, @kamala.trust.**

**FOUND BY RUNNING IT:** the first version parsed the `--reason` VALUE as a handle and went
looking for a target called *"not a media buyer: a person or a charity…"*. It reported "no
such target" — safe by luck. `--reason bollywoodchronicle` would have offered to retire a
real account.

---

## READING THE REAL MESSAGE FOUND THREE MORE THINGS THE SUITE COULD NOT

Every one of these came from rendering an actual body to an actual prospect. 1,542 tests did
not see any of them.

- **The handle still reached the BODY.** The 13 August rule "a stored `displayName` is often
  just the handle and must never be shown" was applied at TWO of the three places that speak
  the name — `buildGreeting` and `brandFirstTouch` — and missed the `{{brand}}` token. So the
  greeting degraded correctly to "Hi there," while the body read *"an annual plan for
  **agoracitycentre**"*. **A half-applied rule is worse than an unapplied one: the part a
  reader checks is the part that got repaired.** Now "your brand" — the only phrasing
  grammatical across all six live `{{brand}}` contexts, one of which is possessive.
- **`"Asshna Developers's placement"`** — `brandFirstTouch` concatenated `'s`. Names ending in
  `s` are the NORMAL case here (Asshna Developers, Amazon MGM Studios, Excel Music Records).
  `possessive()` now handles it.
- **A DRAFT GOES STALE IN TWO INDEPENDENT WAYS.** The server drafted 9 messages at 08:00:28
  UTC; `singleTemplate` went on at 08:04:15. All 9 carried the correct merged opener — so the
  opener check called them current, rightly — while their bodies were the pool the setting had
  just replaced. **And all 9 were SENDABLE**, because @bollywoodchronicle holds a session and
  they postdated the persona change. `classifyOpener` and `classifyTemplate` are therefore two
  pure predicates, not one clever one; `stale` on either is stale, and `unknown` still beats
  `stale`.

**`pnpm ig:discard-stale-drafts`** (DRY RUN BY DEFAULT) is the command for all of this. Its
predicate is a PATTERN, not an equality, and running it against the live queue is what proved
why: `usableBrandName` had changed the greeting for every raw-handle recipient, so comparing
against today's greeting filed five drafts as "probably edited by hand" when they carried the
worst copy in the queue.

**A TEST CAUGHT MY OWN MEASUREMENT BEING UNSOUND.** The obvious probe for the merged opener is
"the old shape has a blank second line" — and BOTH shapes have one, because the blank is the
paragraph break and always was. It agreed with the hypothesis regardless of the data. That is
*a check that verifies its own symmetry*, already in this file once, reproduced live.

---

## THE DEPLOY, AS IT ACTUALLY WORKS — AND ONE THING THAT WOULD BREAK IT

The server is **not a git repo**; code is rsync'd from `git ls-files`, stale files removed
explicitly, then `prisma-client-for-env.sh` → `pnpm build` → `pm2 restart ds-sales-agent`.
It is a SHARED box (five other pm2 apps), so nothing may be done broadly.

**THERE IS NO `_prisma_migrations` TABLE. NEVER RUN `prisma migrate deploy` THERE.** The
schema was never managed by `prisma migrate`; the `role` column and its index are already
present and correct. A migrate would try to replay everything against a populated database.

**`pnpm build` requires stopping pm2 first** (the standing never-build-while-serving rule),
and that also pauses DETECTION, because the scheduler is embedded in the dashboard process.
The feed window gives ~18 hours of slack, so a few minutes is safe — but it is the same
coupling that made the 2026-08-08 outage invisible.

**A `comm` diff of server-vs-repo file lists needs `LC_ALL=C sort` on both sides.** macOS and
GNU `sort` order punctuation differently, and the mismatch showed files as present in BOTH
"only on server" and "only in repo" — acting on that output would have deleted live files.

**NEVER PIPE THE BUILD INTO `tail` AND THEN `&& pm2 start`.** Done exactly once this session
and it took the dashboard down: `pnpm build 2>&1 | tail -2 && pm2 start …` takes its exit
status from **`tail`**, which always succeeds, so `pm2 start` fired after a failed build and
pm2 crash-looped the app 40+ times on *"Could not find a production build in the '.next'
directory"*. The build failure itself was transient and the next build was clean — the
damage was entirely the masked exit code. Check `${PIPESTATUS[0]}`, or do not pipe.

### DISCARDING A DRAFT DOES NOT GIVE THE DAY'S BUDGET BACK — **FIXED THE SAME DAY, see above**

> The section below is the MEASUREMENT that justified the redesign two sections up. It is kept
> because the reasoning is the useful part; the behaviour it describes is gone. A discarded draft
> now returns its slot immediately, because the queue bound is a depth rather than a daily rate.

**MEASURED at the end of this session: `created=10 delivered=1` against
`maxNewBrandTouchesPerDay = 10`, and all ten of those attempts are `SKIPPED`.** The cap
counts first touches CREATED today, so the 9 drafts discarded for carrying the old template
plus one more spent the entire day's allowance on messages nobody ever received. **The queue
does not rebuild until IST midnight**, and a slot before then reports `queued=0 skipped=285`,
which reads exactly like drafting being broken.

That is the conservative direction and probably the right one — the cap exists to protect the
PATTERN, and ten first touches in one afternoon look nothing like ten across ten days
regardless of how many were later thrown away. But it means **a rewrite cycle costs double**,
so clearing the queue and expecting it to refill the same day is wrong. Say which it is before
anyone concludes the planner has stopped.

### THE CAP ON DRAFTS WAS GUARDING THE WRONG THING, AND IT MADE THE DELIVERY CAP UNREACHABLE

Tabish: *"cap should not exist for drafts should it, what if we discover several targets?"*

He is right. `checkNewBrandTouchCap` compared TWO counters against ONE number, and the old
shape had three faults visible only together:

1. **A draft reaches nobody.** The rule's own rationale — ten first touches in one afternoon
   look nothing like ten across ten days — is about what a RECIPIENT sees. That is an argument
   about DELIVERY. Applied to creation it guards something no stranger observes.
2. **THE DELIVERY CAP COULD NEVER BE REACHED.** `created` was checked FIRST and shared the
   number, so once the queue held N first touches nothing more was written — and `delivered`
   could therefore never reach N either. **The counter carrying the actual safety argument was
   dead in practice.** `tests/brand-guards.test.ts` now asserts it binding with an EMPTY queue,
   which is a state the old shape made unreachable.
3. **A cleanup spent the day's allowance.** MEASURED: 9 drafts discarded for carrying the old
   template plus 1 written read **10/10**, so no new company could be contacted for the rest of
   that day, on account of messages nobody received.

**The queue bound is a DEPTH now** — `maxWaitingNewBrandDrafts`, default **150**, counted over
READY/QUEUED only:

- discovering 200 companies fills the queue and stops, rather than stalling drafting for a day;
- discarding a draft returns its room immediately, because room is a slot and not a spent token;
- the draft/discard/redraft loop the old docblock feared still cannot exceed the bound, because
  it never grows the queue — and it contacts nobody and spends no model call, since with
  `singleTemplate` on rendering is template substitution.

`maxNewBrandTouchesPerDay` keeps the name that carries the rationale and now means **DELIVERED
first touches per day, nothing else.** It is **10**. It was briefly 60, which was only ever
defensible while it also governed drafting — 60 deliveries a day is far past what fleet pacing
permits (3/hour inside 10:00-21:00 IST = 33).

**The refusal text changed with the rule, and a test asserts the old word is GONE.** *"the rest
of the queue waits for tomorrow"* is now false: waiting is not what clears a depth, sending or
discarding is, and that can happen in the next minute.

**VERIFIED BY RUNNING IT:** with the old cap spent a slot queued 0; after the change, 50 drafts,
then 27 more on the next slot — **77 waiting, 73 room left, 0 body defects** across all of them
(right opener, standard template, non-null send-guard needle, no raw handle anywhere).

### AND READING THE RECIPIENTS FOUND NINE PEOPLE THE CATEGORY RULE CANNOT SEE

Retired: **@azmishabana18** (Shabana Azmi), **@ushakakadeofficial** (2.4M followers, no
category — the pitch would have opened *"Hi Usha Kakade team,"*), @anandpandit (his company
@anandpanditmotionpictures stays), @arvindwriterdirector, @kunalkemmu, @shekharravjiani,
@ritesh_sid, @you_sunilsihaag, @paradoxindia_ — plus @ananyapanday, @acharyavinodkumar,
@deepakmukut and @kamala.trust earlier in the day.

The planner's own guard held @rahuldevofficial and @shalini.passi correctly. It cannot see the
rest because **45 of the never-contacted BRAND rows have NO CATEGORY AT ALL**, and a category
the list does not recognise is read as evidence of a COMPANY. That is the honest gap, unchanged:
it should fall through to `decideBrand` as UNRESOLVED, and brand resolution still has **no
accuracy harness**, so that change must be measured before it ships.

**A queue this size must be READ before autopilot is turned on.** 74 of 77 drafts pass every
gate; the only thing standing between them and a stranger's inbox is the switch.

### ACCURACY RUNS ON A CRON NOW

`30 3 * * *` on the Linode (09:00 IST — after the overnight posts land, before the commercial
peak, so it scores a settled corpus), `pnpm ig:accuracy --repeat 3`, logging to
`/var/log/ds-accuracy.log`. **`--repeat 3` is not optional**: the classifier is not
deterministic and one run swings recall 95-100%, so a single figure is a sample.

Each run stores the RANGE across its repeats and the `predRule` that produced it. **Figures
either side of 2026-08-17 are not comparable** — `pred` became `final === 'CAMPAIGN'`, so frame
escalations now count as positive predictions. The rule is recorded IN THE ROW rather than as a
caveat in this file, because a trend is rendered from rows.

**Still not rendered anywhere.** The data half is done; `/paid-posts` does not yet show it.

### THE UI AUDIT — FIVE THINGS THE SCREEN CLAIMED THAT THE DATA DID NOT

Tabish: *"UI frontend to backend audit must be performed and data must be represented
accordingly."* Done by rendering each page in a real browser and querying the live database
in the same script. Each half was self-consistent; only the comparison showed the gap.

1. **YOU COULD NOT ADD A SENDING ACCOUNT AT ALL.** `addSender` had existed for weeks —
   validated, audited, creating routes — and **not one file in `src/app` imported it**. The
   only way in was writing to the database by hand. `/targets` had its form the whole time,
   which is exactly why nobody noticed: the pair looked symmetrical from outside. There is
   now an **Add a sending account** form on `/senders`.
2. **THE TARGET LIST GROUPED BY `kind`, NOT `role`.** This file already says why that is a
   trap — `kind === 'CHANNEL'` is NOT "a page we watch", because `importProspects` writes
   messageable prospects as CHANNEL. The two columns agree on all 99 rows TODAY, which is
   precisely why reading the page could not catch it: the first imported list would have
   appeared under the heading for pages we never write to.
3. **THE HEADINGS COUNTED ROWS THE CLAIM WAS FALSE OF** — *"Companies we message (95)"* while
   13 are retired and can never be messaged; *"Pages we watch (4)"* while 2 are. Now (82) and
   (2), with retired rows still listed and counted separately.
4. **A CONTROL THAT DOES NOTHING WAS OFFERED ON 95 ROWS.** *"read their posts every check"* on
   company rows — and `pipeline.ts` reads `kind: 'CHANNEL'`, so turning it on for a BRAND
   spends four feed requests a pass on an account whose posts nothing classifies. Tabish
   asked for it to go; it is now on WATCH rows only.
5. **"checked four times a day" WAS THREE WEEKS STALE** — detection got its own 15-minute
   clock on 2026-08-07. Imported from `DETECT_INTERVAL_MINUTES` now. It also rendered as
   **"watch2 channels"**: the JSX bug already recorded here, where the space between an
   expression and the next line's text is dropped.

And the wording Tabish saw on a draft: `gate.ts` said *"channel is retired"* about a BRAND
row. **95 of 99 targets are companies**, so the word was wrong for nearly every row it can
appear on. It is "this recipient is retired" now, in the gate and in the remedy.

### THE ACCURACY TREND IS ON SCREEN, AND THE LANDING PAGE IS HALF THE SIZE

`accuracyHistory` had stored every run since 13 August and **nothing rendered it** — measured
thirty times, shown never. `/paid-posts` now carries it: the **RANGE** across a run's repeats
(never a point — 2 of 89 posts flip between identical runs), how long ago it ran, *"not
measurable"* rather than 0% where a channel has no positives, and the standing caveat that
this measures CAPTION judging and is not a coverage figure.

**THE SIMPLIFICATION FIGURE WAS TAKEN ON AN EMPTY QUEUE AND UNDERSTATED IT FIVEFOLD.** With
77 drafts the landing page measured **196 numerals, 3,458 words, 12,253px**, against the
35/593/1,349 measured when the queue was empty. Density is proportional to queue depth, so
that whole exercise must be done on a full day.

Collapsing each draft's message body behind one click takes it to **96 numerals, 1,837 words,
5,961px** — half. The brief's hard constraint is ASSERTED rather than assumed: all 20 cards
still carry their refusal sentence on the **collapsed** row, checked in the browser.

**`pnpm ig:layout` then failed at 611 queries against a 520 budget, and that is the check
earning its keep.** Not raised — a budget is a ceiling over a bounded design. The second
`recheckBeforeSend` per draft is skipped when autopilot is OFF, because with the dispatcher
stopped it buys one sentence ("ready to send by hand" against "ready, and waiting for you")
that means press the button either way. With autopilot ON the distinction is real and the
call is still made.

### COST IS ACCURATE, AND IT WAS CHECKED TWICE

Tabish asked. Verified two independent ways, because a figure agreeing with itself proves
nothing: the stored ledger sums to **$0.193662**, and recomputing from raw tokens against the
price table gives **$0.193662** — the eighth decimal.

**The DeepSeek trap is NOT present.** `usage.prompt_tokens` INCLUDES
`prompt_cache_hit_tokens`, so recording both bills cached tokens twice. `semantic.ts` records
`prompt_cache_miss_tokens` as `inputTokens`, which is the correct complement. Had it been
wrong the total would read **$1.69 against $0.124 — 13.6× high**. 7,486 calls, cache hit
**94.4%**.

### OUR OWN TWO PAGES HAVE NOT BEEN READ SINCE 13 AUGUST

Found while auditing, corroborated two ways and **not acted on, because it is Tabish's call**:
@bollywoodsocietyy and @bollywoodchronicle have `watchEnabled: false`, and (1) their newest
stored post is 2026-08-13T08:00 while @viralbhayani is current to the minute, and (2)
`pipeline.ts` reads `where: { kind: 'CHANNEL', watchEnabled: true }`, which excludes them.

**No audit row explains it.** That contradicts the 2026-08-07 entry in this file — *"posts
kept, still watched — watching our own pages is ground truth, not prospecting"*. Their 802 and
937 posts are frozen history still counted in figures. Resuming would restart roughly 1,500
feed requests a day, which is why it was left alone rather than flipped.

### "WHY IS THIS ACCOUNT STILL THERE, WE DELETED IT?" — WE DELETED ITS ROUTES

Tabish hit *"@tabishmukaddam1 is already one of your accounts"* while adding it, and read that
as the delete having failed. It had not, and the confusion was the UI's fault three times over.

**A PAIR IS A ROUTE. AN ACCOUNT IS AN IDENTITY.** `pnpm ig:prune-pairs --run` removed the
burner's **70 `OutreachPair` rows** and nothing else — which is exactly what it says it does.
The `SenderAccount` row survives with `fleetMember: false`, 0 routes and 0 attempts: an
account we own that writes to nobody, which is the whole point of the burner.

**AND `/senders` NEVER READ `fleetMember`.** MEASURED: the word appeared **zero** times in
`accounts-page.ts`, so the burner was filed under **"Sending on their own"** — a group title
asserting a capability it does not have and cannot have. There is now a fourth group,
**"Not in the rotation — writes to nobody"**, taken FIRST because it is a fact about what the
account IS rather than about what is currently wrong with it.

**AND THE REFUSAL NAMED NOTHING.** *"@x is already one of your accounts"* is true and sends a
person looking for something they cannot see — `AccountGroupView` collapses any group that
needs no attention, which is right at 65 accounts and means a healthy account is one click
away. The message now names the group and the state, and says outright that removing routes
does not remove the account. *"If the person a warning is FOR has to ask what it means, the
warning has not done its job"* — already in this file, about a different warning.

**A side effect worth recording:** verifying this in a headless browser clicked a Connect
button and opened a real Chrome profile for @bollywoodsocietyy. No send is possible from a
login window, and it was closed properly — closing is what flushes cookies to disk — with the
cookie file intact at 20,480 bytes. **Do not drive `/senders` with a blanket click sweep.**

### WHERE THIS SESSION LEFT THE SYSTEM

Everything below is deployed and running unless it says otherwise.

| | |
|---|---|
| committed | **10 commits**, all deployed to the Linode. `origin/main` on GitHub is still at `db2687d` — **the push has not been done** |
| the queue | **0 waiting drafts.** 46 cleared (30 duplicates, 16 old template, 9 more written and discarded mid-session), 1 delivered message untouched throughout |
| the caps | **REDESIGNED** — delivery 10/day (the pattern guard), queue depth 150 (its own number). Discarding now returns room immediately |
| detection | `frame:call-failed` **83 → 0**, 11 escalated to CAMPAIGN. In-window CAMPAIGN **316 → 328** |
| prospects | **91 live, 6 retired.** 18 created from a home-IP run; 4 retired as people or charities |
| routes | the burner's **70** pair rows pruned; 285 remain, 0 history lost |
| layout | `pnpm ig:layout` **all green**, first run ever. `/` measures **111/520** queries, not the 454 this file used to state |
| the diagram | **rebuilt and republished to the same URL**, from the deployed code — see `docs/PIPELINE.md` |
| the queue | **77 waiting**, 73 room left. 74 of 77 pass every gate — READ THEM before turning autopilot on |
| GitHub | `origin/main` is level with the Linode and with this working tree |
| accuracy | on a daily cron at 09:00 IST, storing the range and the `predRule`. Not rendered yet |
| the UI | **you can add a sending account now** (there was no form at all); targets grouped by WATCH/PROSPECT with honest counts |
| accuracy | daily cron at 09:00 IST **and rendered on /paid-posts** as a range with its date |
| the landing page | **half the size** with a full queue — 12,253px → 5,961px, every refusal still on the collapsed row |
| cost | verified twice: ledger $0.193662 = recomputed $0.193662. No DeepSeek double-count |
| tests | **1,572 / 78 files**, typecheck clean, `ig:layout` all green including budgets |

**STILL OUTSTANDING, honestly:**

- **The dashboard simplification** (the largest item in the 17 August handoff) is untouched.
  Its four constraints are unchanged and still binding — a draft's refusal must stay on the
  COLLAPSED row, `tests/stopInventory.test.ts` requires every stop reachable with a remedy,
  `tests/shell.test.ts` requires ≥6 authenticated pages, and `src/scripts/layout.ts` hardcodes
  each page's path, H1 and query budget and FAILS rather than skips.
- **Accuracy is half done.** `accuracyHistory` now stores the RANGE across a run's repeats and
  the `predRule` that produced it — you cannot render a range you never stored, and figures
  either side of 17 August are not comparable. **Nothing renders it, and `ig:accuracy` is not on
  a cron.** Note before designing that: the model emits ~8 distinct confidence values and never
  goes below 85 on an ORGANIC, so **a review queue keyed on model uncertainty would find
  nothing**.
- **Two of three fleet accounts still have no Instagram session.** Until someone presses Connect
  from the home IP, raising any cap changes nothing.

### FIGURES RE-MEASURED THIS AFTERNOON

| stated | measured |
|---|---|
| burner holds 72 pair rows (then 73) | **70** — all pruned, 0 carried an attempt, the 1 delivered message untouched |
| 46 waiting drafts, all blocked | true at the start; **now 0**, after 30 duplicates + 16 stale + 9 more |
| 83 `frame:call-failed` | 83, and **not one was a failed call** |
| 119 short-caption posts, 84 with footage | **144 rules-judged, 113 with a frame on disk** |
| 2,614 in-window posts | **2,616**, CAMPAIGN 316 → **328** after the re-judge |

Timestamps were re-verified after draft times looked wrong: DB in UTC, stored text matching
`now()`, Mac agreeing. **The 5.5-hour bug has not returned.**

---

## THE 17 AUGUST RESTRUCTURE — TWO TARGET TYPES, ONE MESSAGE, TWO VERDICTS

**Read this before anything below it. It changes the target model, the message copy, the
verdict set and the labelling control, and it corrects six figures this file states.**

### THE TARGETS ARE TWO KINDS NOW, AND THE COLUMN IS `TargetAccount.role`

`WATCH` — we read their feed forever to find paid posts and **never message them**.
`PROSPECT` — the companies found IN those paid posts. They are who we write to.

@viralbhayani and @madovermarketing_mom are **COMPETITORS**. Watching them is how we find
the brands buying placement; messaging them was never intended and was happening.
**MEASURED the day this shipped: 26 attempts and 8 pairs to the two of them, with 6 drafts
still waiting to send.** Zero had ever been delivered, which is the only reason deleting
them was safe — `pnpm ig:purge-watch-drafts` refuses outright if it finds a delivered one.

**BOTH OBVIOUS MECHANISMS ARE TRAPS AND WERE MEASURED TO BE:**

- **`kind === 'CHANNEL'` is not "watched publisher".** `importProspects.ts` creates
  messageable prospects as CHANNEL. A rule keyed on kind stops messaging every imported
  prospect — a sending outage that looks like a quiet day.
- **`optedOut: true` is worse.** `judge.ts` short-circuits the FOOTAGE call for an
  opted-out target, so retiring @viralbhayani to stop messaging it would have silently
  killed OCR-driven detection on the channel supplying most paid posts, while leaving
  caption detection running.

Enforced in **THREE** places, because `routes.ts` alone is provably insufficient:
`routes.ts` (`target-is-watch-only`), `gate.ts` (`TARGET_IS_WATCH_ONLY`, non-overridable —
it catches drafts written *before* the rule), and the on-demand dropdown, which is
**deliberately exempt from `routes.ts`** and creates its own pair. Verified by executing
`recheckBeforeSend` against all 6 live drafts, plus the negative direction and an inert
override.

### ONE STANDARD MESSAGE, AND THE GREETING RUNS INTO IT

Tabish: *"no custom message is required whatsoever … no space and new line after hi this
ruins it."* `singleTemplate` now defaults **TRUE**. Exactly two things vary across every
message: the recipient's name and the sending page's name.

**THE BLANK LINE WAS ONE ARRAY ELEMENT.** `render.ts` built
`[greeting, '', body, …].join('\n')`, and Instagram's inbox previews only the FIRST line —
so every recipient's preview read `Hi Crocs India team,` and nothing else. The greeting and
the introduction are now one line.

**AND THE COPY HAS A MECHANICAL FLOOR THAT IS NOT EDITORIAL.** `proseLines` drops line 1 BY
POSITION — now the merged opener — and `distinctiveSlice` needs a survivor of 40+
characters or it returns null, **and null refuses every send in the system**. MEASURED, and
it corrects the obvious guess: the property is LENGTH, not paragraph count.

```
three paragraphs (shipping)  prose=3  needle ok
one LONG paragraph           prose=1  needle ok
one SHORT paragraph          prose=1  NULL — every send refused
two SHORT paragraphs         prose=2  NULL — every send refused
```

So the hazard is **shortening** the copy, which is the direction "make it shorter" pushes.
`tests/single-template.test.ts` asserts it against the real exported constant.

**THE REPLY GUARD HAD TO BE FIXED IN THE SAME CHANGE.** `assessRead` counted MEMBERSHIP per
body, and membership is a property of the whole thread — so with byte-identical messages
ONE visible bubble answered for all N, `complete` came back true, and the caller stamped
**verified silence over a conversation it had not seen.** Latent while bodies differed; the
standard template makes it the common case. Each sent body now claims its own bubble.
Mutation-tested: the old code reports `foundOurs: 3` from one message.

`bodyAppearedSince` is SAFE with identical bodies — it is an occurrence-count DELTA — which
is the opposite of the intuitive worry and was verified in both directions.

**The persona name and role are BACK** (they render again, so `personaFingerprint` and
`validatePersona` take them back — the contract is "includes exactly what appears in the
message"). A recorded reversal of the 2026-08-07 decision, not a regression.

### A POST IS PAID OR ORDINARY. `REVIEW` IS GONE

Tabish: *"no more indecisiveness … no in between or borderline or worth a look or manual."*

`VERDICTS` is `['CAMPAIGN', 'ORGANIC', 'UNCLASSIFIED']`. `UNCLASSIFIED` is **not** a third
verdict — it means NOT JUDGED and has never meant ordinary.

REVIEW had two producers and removing it forced a real decision about one of them:

| producer | measured | now |
|---|---|---|
| the confidence floor (<70 CAMPAIGN) | **0 rows in the entire corpus.** Never fired once | no downgrade; recall is not traded |
| the FOOTAGE | **18 of the 26 live REVIEW rows** | escalates to **CAMPAIGN** |

**So `applyFrameSignal` now MINTS a paid post from video text, which that table was written
to forbid.** Three things make it a trade rather than a loosening, and all three must hold
if anyone tightens it back: it is the recall-protecting direction; the **cross shipped with
it**; and the evidence is real — both founding cases (the Thane bus reading `SWITCH`, the
Sony game-show card) came from this path. `frame:escalated-to-campaign` marks every such
row, because `ig:accuracy`'s labels are caption-derived and **a frame-driven CAMPAIGN is
still measured by no harness.**

**The model's prompt was NOT edited.** It still offers `REVIEW` for a genuinely ambiguous
post, and `modelVerdictToStored` maps it to CAMPAIGN at the boundary. Editing the prompt
would invalidate a 50× cache discount permanently and would be a classification change
requiring `ig:accuracy` before and after — mapping means the model's behaviour is *provably*
unchanged rather than measured unchanged.

**ONE CONTROL: a cross on each paid post.** `src/app/paid-posts/dismiss.tsx`. The "Worth a
look" queue, the two buttons and the separate "Answers you have given" list are all deleted —
three lists showing the same posts taught a reader to skip all three. The table now carries
dismissed rows too, so the cross is **undoable**, which is the release the 8 August bulk
write proved was necessary.

**AND THE CASCADE, which setting the verdict does not complete.** Flipping to ORGANIC reaches
five consumers free (they all query `verdict: 'CAMPAIGN'`). It does **not** reach
`discoveredFromCampaignId` — so a company was a live prospect because of a post a person had
just called ordinary. `labelPost` now also retires any prospect whose only provenance was
that post **and** which has never been written to.

**`ig:accuracy`'s `pred` changed to `final === 'CAMPAIGN'`.** Frame escalations now count as
positive predictions, so **the headline numbers will move — that is the harness becoming
correct.** Do not compare a run after this against any figure recorded above it.

### OUR OWN PAGES ARE OFF EVERY SCREEN — EXCLUDED, NOT DELETED

**Not one `DetectedCampaign` dashboard query filtered by channel.** MEASURED: their 1,555
in-window posts were **59.6% of every figure on `/paid-posts`**, 37 rendered as paid
findings, and **5 of the 26 open review rows were @bollywoodsocietyy** — the dashboard
asking Tabish to judge a page he owns, which is what he actually noticed.

`src/detection/visibleChannels.ts` is the one predicate, folded into `inWindow` so a query
added later inherits it, with a **source grep** (`tests/visible-channels.test.ts`) because
the failure mode is a query nobody has written yet. It caught two real gaps on its first run.

**DO NOT DELETE THE ROWS.** It cascades away **1,739 `DetectedCampaign` rows that can never
be re-scraped** (48-post window), destroys the ground truth those pages exist to provide,
and the same handles are `SenderAccount` rows with different ids — deleting the wrong one
takes out the accounts that send plus 158 attempts of real history.

Detection, storage, `buildVocabulary` and `ig:accuracy` still read every channel. **This is
a rule about a SCREEN, not about the corpus.**

### THE 21 POISONED LABELS ARE CLEARED

`pnpm ig:clear-bulk-labels`. All 21 shared one millisecond, including both founding cases —
and one reading `MARUTI SUZUKI | NEXA` in its footage, labelled not-paid. Cleared, not
re-decided: each falls back to its classifier verdict, because asserting the opposite would
be minting ground truth from a docblock. **5 genuine one-at-a-time labels remain.**

### THE CAP WAS 2 A DAY AND IS 10 — BUT IT IS NOT WHAT IS STOPPING YOU

| cap | value | ceiling |
|---|---|---|
| `MAX_SENDS_PER_TICK` × 15-min ticks, 11 active hours | 1 | 44/day |
| **`FLEET_MAX_PER_HOUR`** | 3 | **33/day — binds first of the pacing rules** |
| **`maxNewBrandTouchesPerDay`** | **2 → 10** | the one that governed throughput |

**CORRECTION TO THE OBVIOUS READING:** the new-brand cap bounds **draft creation** in the
planner — it is absent from `gate.ts`'s `RESEND_BLOCKS`. And today the binding constraint is
not a cap at all: **autopilot is OFF and only @bollywoodchronicle holds a session.** Raising
the cap alone changes nothing and will look like the change failed.

`MAX_PER_TARGET_PER_DAY` was NOT raised: it is the only rule that sees a recipient's total
across all senders, and `env.ts` is `intish(1, 1, 10)` — **setting it above 10 in `.env`
throws at startup and takes the dashboard down.**

### FIGURES IN THIS FILE THAT WERE MEASURED FALSE ON 17 AUGUST

| this file said | measured |
|---|---|
| "nothing has ever been delivered" | **1 delivered** — @bollywoodchronicle → @crocsindia, 10:42 IST. The delivered counter binds for the first time |
| 68 BRAND targets | **77** |
| 22-26 waiting drafts | **52** |
| 65 in-window `frame:call-failed` | **83** |
| 98% correct / 100% recall as the headline | measured on the channel where the model **NEVER RUNS** — see below |

### THE ACCURACY FIGURE WAS MEASURED ON THE WRONG CHANNEL, AND THE REAL ONE IS 78.6%

@viralbhayani had **4 labels across 1,005 posts**. Ground truth was built for the first
time: 60 posts, 11 days, four independent judging passes including one told to HUNT for
missed paid posts and one told to hunt for false alarms.

| pass | paid rate |
|---|---|
| the live system | 21.7% |
| independent judges | 23.3% |
| adversarial — hunting missed paid | 22.0% |
| adversarial — hunting false alarms | 23.3% |

Consensus: 13 unanimously paid, 46 unanimously ordinary, **1 split**. Against it the
classifier scores **78.6% recall (11/14)** and **84.6% precision (11/13)** — real
performance with room to improve, and nothing like the 98%/100% this file has been quoting.

**AND THE "100+ PAID POSTS A DAY" CLAIM IS ARITHMETICALLY IMPOSSIBLE.** Live feed fetched
and compared shortcode by shortcode: Instagram showed **144 posts over 69 hours (50.1/day)**,
we had stored **154** for those days, **0 missing** — capture is complete. @viralbhayani
publishes ~50 posts a day IN TOTAL, and 21.7-23.3% of them are paid, i.e. **11-12 a day**.
There is no sibling publishing account (`viralbhayani2` has 19 posts).

**STORIES ARE THE LIKELY SOURCE OF THE CLAIM AND ARE UNREACHABLE:**
`GET /api/v1/feed/reels_media/?reel_ids=…` returns `{"reels":{},"status":"ok"}` — HTTP 200
carrying nothing. Reading them needs a session, which decision 4 forbids.

**REAL RECALL HOLES FOUND, none explaining a 10× gap:** 54% of posts judged on caption alone
with no footage read · 13% (119) auto-ORGANIC by the short-caption rule, 84 of them with
unread footage text · 83 posts `frame:call-failed` · and the model **never hedges** — 0 of
518 ORGANIC verdicts below 80% confidence.

### BRANDS ARE FOUND IN POSTS THAT TAG NOBODY NOW — AND THE OBVIOUS FIX WAS MEASURED UNSAFE

**MEASURED: 161 of 315 in-window CAMPAIGN posts (51%) carry no usable caption @mention**, and
134 of 135 in the earlier sample named a brand anyway. Discovery read @mentions and NOTHING
else, so half of every paid post it found produced no prospect. Per channel: @viralbhayani
44% untagged, @bollywoodchronicle 100%, **@madovermarketing_mom 0%** — which is exactly why
the gap was invisible from the one channel with ground truth.

**THE APPROACH TABISH CHOSE WAS "extract the name, then VERIFY the handle", AND IT WAS PROBED
LIVE AND REJECTED.** Two measurements kill it, and anyone reaching for it again should read
these first:

1. **There is no anonymous name→handle search.** `web/search/topsearch` → HTTP 401,
   `fbsearch/topsearch` → the SPA shell, while the per-handle verifier answered 200 in the
   same run. There is nothing to look a name up in.
2. **EXISTENCE IS NOT IDENTITY.** Constructing a handle from a name was wrong **4 times in
   10, and 3 of those 4 wrong handles EXIST** — so verifying existence passes on the wrong
   company. `@philips` is the global HQ (268k); `@philipsindia` (200k) ran the campaign.
   `@jitopremierleague` has 354 followers; the real `@jito.premierleague` has 6,828 — and was
   already sitting in that post's tags.

A guessed handle that exists is *"never guess a handle"* failing in the one way a check
cannot catch, and it puts a media-buying pitch in a stranger's inbox from a revenue account.

**WHAT SHIPPED INSTEAD: the handles Instagram itself asserts about the post.**
`taggedAccounts` and `collabHandles` have been stored by `pipeline.ts` since the beginning,
are refreshed by `evidence.ts`, and **nothing in discovery had ever read them.**
`taggedHandlesIn` (PURE, `resolveBrand.ts`) feeds them into the SAME
`resolveBrand → decideBrand → createBrandTarget` chain as a caption mention, so the
BRAND-vs-PERSON judgement, the confidence floor and `'unsure'` are unchanged.

**VERIFIED against live data: 26 new candidates from media tags against 9 from captions** — a
3.9x widening — including Red Chillies Entertainment, Sony TV and Philips India. Probed live
in both directions: `@redchilliesent`/`@sonytvofficial` resolve BRAND, `@aasthagill`
("Artist") is correctly refused as a PERSON.

**TWO THINGS THAT MUST NOT BE UNDONE HERE:**

- **A CAPTION MENTION IS ORDERED BEFORE A TAG.** The bound is a LOOKUP budget (10/pass), so a
  weaker candidate taking a slot is a stronger one not taken. A tag is Instagram saying an
  account appears in the media, which is true of the celebrity as often as the advertiser —
  @bollywoodchronicle tags someone in **46.3% of ORGANIC posts against 20.0% of CAMPAIGN**,
  so the correlation INVERTS there. `orderForLookup` ranks `source` first.
- **OUR OWN PAGES AND WATCHED PUBLISHERS ARE EXCLUDED BEFORE THE BUDGET, NOT AFTER IT.**
  @viralbhayani and @bollywoodpap appear in their own posts' tags. `tests/auto-resolve.test.ts`
  used to assert `looked: 1` for one of our own senders (refused at creation, after spending
  a lookup); it now asserts **`looked: 0`**, and the safety assertions are unchanged.

Still true and still unmeasured: **there is no accuracy harness for brand resolution.** 39 of
77 live BRAND targets were decided by a model with no measured precision. Lookups still only
work from a home IP.

### VERIFIED

typecheck clean · **1,490 tests, 74 files** · every new guard mutation-tested · the
watch-only stop verified by executing `recheckBeforeSend` on live drafts in all three
directions · dashboard scoping verified against live counts (1,555 rows hidden) · the tag
source verified against live data (26 new candidates).

**NOT DONE, and the order matters:** nothing is committed or deployed. The **46 waiting
drafts still carry the OLD copy** — every one is already blocked (`no-session` 31,
`persona-changed-since-draft` 15, which is the gate correctly catching the signature
change), and discarding them before the deploy is undone by the server's next slot, which is
the same ordering trap `ig:dedupe-drafts` documents. **Discard them AFTER deploying.**
The broader dashboard simplification is largely untouched — see the handoff doc.

---

## Read this before you "fix" anything

Four things here are counter-intuitive enough that a competent person will undo them.

0. **NOTHING RUNS UNLESS A PROCESS IS RUNNING, AND ON 2026-08-08 NOTHING WAS.** Measured:
   no process at all, `schedulerHeartbeat` **20 hours stale**, and 108 posts arrived in one
   burst the moment it restarted — **9 of them CAMPAIGN**. The dashboard said nothing, and
   the branch that should have said it *could not fire*: `staleRun` read `ScrapeRun` with a
   26-hour threshold, but detection moved to its own 15-minute clock on 2026-08-07 and
   writes no `ScrapeRun` row. **Two clocks, two tables, and the alarm read the one detection
   had stopped touching.**

   The deadline is not a chosen number. The anonymous feed is a **WINDOW** (48 posts deep),
   `@viralbhayani` posts 49–75 a day (8 days, mean ~64), so the corpus survives about
   **eighteen hours** and that outage cleared it by roughly one. A post that scrolls out
   can never be re-scraped — no endpoint hands it back.

   Now: `assessWatch` (PURE, `src/detection/watchHealth.ts`) derives the boundary from the
   measured feed depth and posting rate and separates **at-risk** (recoverable — one pass
   gets it all back) from **losing-posts** (gone). It sits ABOVE replies and drafts on the
   health ladder, because a missed post is the only unrecoverable item there. The copy says
   *"this is not about sending"* — the previous wording lived in the autopilot card and
   ended "whatever this toggle says", so with autopilot correctly OFF it read as irrelevant.
   `bash scripts/install-watch.sh install` keeps a dead worker restarted;
   `pnpm worker:heartbeat` answers it from a terminal and exits non-zero only when posts are
   being lost. **launchd cannot wake a sleeping Mac** and the docblock says so — the server
   is that answer, not this.

1. **The database is `journal_mode = delete`. Do NOT switch it to WAL.** WAL was tried,
   measured, and reverted — under WAL a long-lived process never sees another process's
   writes. Full argument in the docblock at the top of `src/lib/db.ts`, and below.
2. **Nothing sends at all right now — and since 2026-08-06 the persona gate is NOT the
   reason.** Each account was given its own channel name, which released the gate on all
   three revenue accounts; verified by executing `recheckBeforeSend`, not by reading code.
   What blocks sending today is that no account has a working Instagram session. The shared
   PHONE NUMBER and EMAIL survive on all four and the gate cannot see them, because it
   compares the whole block. Never satisfy any of this by inventing personas.

   **CORRECTION, 2026-08-06 evening: "no account has a working session" was PARTLY AN
   ARTEFACT OF A BUG, and the bug is fixed.** `@tabishmukaddam1` was signed in the whole
   time. The identity lookup had died and `identify()` read a dead endpoint as *"this account
   is logged out"* — see the `/api/v1/users/<id>/info/` entry under Gotchas, which is the
   root cause of both that claim and Connect never working. Its `sessionInvalidAt` mark was
   written on that false evidence and has been cleared through `clearSessionInvalid` on real
   proof. The three REVENUE accounts genuinely have no session: measured on disk, only
   `@tabishmukaddam1` holds a `sessionid`, and `@bollywoodsocietyy` holds device cookies
   (`datr`, `ig_did`, `mid`) with no session. So the sentence is true of the accounts that
   matter and was false of the fourth — and the fourth is the one somebody would have
   re-logged-in for no reason.

   **UPDATE 2026-08-07: `@bollywoodchronicle` is signed in too** — Tabish signed in by
   hand through the dashboard, the row button's missing poll left it unrecorded (see the
   Gotcha), and it was finalised and identity-verified via `pnpm ig:login`. TWO accounts
   now hold live sessions (the burner and @bollywoodchronicle); `@bollywoodsocietyy` and
   `@madaboutmarketingg` still have none. Autopilot remains OFF, so nothing sends
   unattended regardless. Also that day: chronicle and society were RETIRED as message
   targets by Tabish (posts kept, still watched — watching our own pages is ground truth,
   not prospecting), chronicle's detector switched to `semantic` like society's, and the
   seven BRAND rows' `watchEnabled` set false (the scraper never read them; the flag
   claimed otherwise).

   **A DEAD session is RECORDED now (2026-08-06, simple-sender §3.5).** `hasSession` is a
   cookie-on-disk check and Instagram revokes server-side, so "the dashboard says connected"
   and "every send fails with a login form" were both true at once — and the dispatcher
   drove a browser at the dead session every 15 minutes forever, because `NotLoggedInError`
   was filed under `failureCode: 'navigation'` (the retryable code) and written nowhere.
   Now: `markSessionInvalid` (src/outreach/sessionHealth.ts, ONE writer like
   `markChallenged`) records the evidence to `SenderAccount.sessionInvalidAt`; the gate
   folds it into the EXISTING `no-session` stop via `sessionUsable`; `logged-out` and
   `two-factor` split out of `navigation` (FAILURE_CODES is 10); and it clears only on
   PROOF — an identity-verified hand login or a delivered send, never a page load. Fourth
   appearance of "freshness is not liveness" in this codebase. Verified in both directions
   against the live database.
3. **The dashboard is on port 3100**, not 3000. Another project on this machine binds
   `*:3000` on IPv6 and macOS resolves `localhost` to `::1` first, so `localhost:3000`
   served the wrong app. Still `127.0.0.1` only; that bind must not change.
4. **Delivery does not happen in a slot any more.** A paced dispatcher sends at most one
   message every fifteen minutes, inside 10:00-21:00 IST. "Autopilot is on and nothing
   has gone out" is the ordinary state for most of an hour, and `/messages` says why.
5. **Generated message copy is BUILT and switched OFF** (`generateMessages`, default false).
   With it off, drafting behaves exactly as it did before. Turning it on is Tabish's
   decision and the reason is not the cost — measured at $0.000045-$0.000138 a message,
   under $10/year at full fleet scale. It is that the gate provably cannot catch every
   invented claim. See Phase 8 below.
6. **Adding a sending account does not mean it can send — and since 2026-08-08 the reason
   is not an arming switch.** New accounts join an onboarding GROUP and a group waits 14
   days behind the one before it. Not overridable. The per-account Auto-send switch is
   GONE (autopilot is one switch, Tabish's instruction), so the ladder is now enforced in
   exactly one place: `mayArmAccount`, asked by `gate.ts` at the moment of delivery. An
   earlier version of the one-switch plan said to delete that function on the strength of
   its name — it was the only thing left standing between an un-soaked group and an
   unattended send. **A group is now "live" when it can actually send** (`hasSession &&
   status === 'ACTIVE'`), not when a bit said so; the bit was never the evidence, and rule
   4 — has this group actually DELIVERED something — carries the weight. Groups are
   visible on `/senders`.

---

## The read-it-yourself list

Four defects were fixed on 2026-08-05 that had all been recorded as "known, not fixed" or
were not known at all. Each was invisible on reading and obvious on running, and each is
written up in full where the code lives:

| | |
|---|---|
| `src/outreach/matching.ts` | the post-send thread check asked *is the needle present* — satisfiable by a message we sent last week. Now a delta. |
| `src/outreach/compose.ts` | the variant LRU was scoped to the SENDER, so 8 of 11 pairs had already been handed the same body twice. |
| `src/outreach/render.ts` | `{{brand}}` meant two different things in two pools and one rule served both, so a pitch could name a competitor. |
| `src/outreach/browser/readThread.ts` | a **jitter** decided whether the reply guard saw the conversation. The losing side reported "no reply". |

---

## THE LEARNING LOOP — WHAT WAS BUILT, AND THE TWO PARTS THAT ARE BLOCKED BY DATA

**6.4 — EVIDENCE THAT WAS READ AND NEVER REACHED A VERDICT.** MEASURED: **65 in-window posts
carry `frame:call-failed`** — the footage was read, the words extracted, and the classifier
call that would have folded them in failed. Correct at the time (*a failed call is never a
verdict*) and wrong forever after, because nothing tried again. `rejudgeUnusedEvidence` runs
at the end of every detect pass, bounded at 10, only through `judgeWithFrame` so the
permission table still applies, never touching a human answer, never able to fail a run.

Note what the measurement CORRECTED: the obvious query — *frame text stored but no `frame:`
signal* — returns **0**, and so does *judged with no frame but a frame on disk now*. Both
were the wrong question. The population that exists is only visible by counting the signals.

**AND THE FIRST VERSION WROTE A LOCAL ABSENCE AS A FACT ABOUT A POST.** Frames live on the
host that detected them; this pass writes to a database BOTH hosts share. Run from the Mac,
`readFrameText` truthfully said "no frame saved" about posts whose frames are on the server,
and the loop wrote it down: **4 posts moved from `frame:call-failed` to `frame:not-saved`**,
retiring them from the retry queue on the evidence of a laptop's disk. That is the
`profileStatus` trap exactly. Fixed — a re-judge may only record what it actually READ — the
4 rows were restored with an audit row, and `tests/rejudge.test.ts` pins it (mutation-tested;
removing the guard fails two assertions). On the host that HAS the frames every one of those
assertions passes vacuously, which is why it is a test and not a comment.

**6.5 — THE DISAGREEMENT QUEUE, AND ITS HEADLINE NUMBER IS ABOUT THE BULK WRITE.** 18 of the
24 settled posts contradict what the classifier concluded — and **16 of those 18 are inside
the 8 August bulk write**, which is the strongest evidence yet that those 21 answers were
never judgements about their posts. Marked and sorted first inside the EXISTING "Answers you
have given" list rather than given a second list: a reader who sees the same post twice on
one page learns to skip both. **2 usable disagreements remain**, both stable across runs.

**6.7 — EVERY RUN IS STORED, so accuracy has a trend.** A `Setting` row (`accuracyHistory`,
bounded at 30) rather than a new table: this machine cannot deploy a migration to the server,
and a schema change applied to a live database from a host that cannot ship the code using it
is a split-brain window for no gain. `ig:accuracy` prints per-channel recall over the last 8
runs.

**5.4 — EVERY CHANNEL SAYS WHETHER ITS JUDGING HAS EVER BEEN CHECKED.** No accuracy figure
was ever rendered on the dashboard, so the "borrowed number" risk was not realised — the gap
was that nothing said a channel had *no* number. `/paid-posts` now reads, per channel:
*"Never checked for accuracy"* (@bollywoodchronicle, **0 labels across 937 posts**),
*"checked against only 4 of 1005 posts, so the figure is thin"* (@viralbhayani), *"checked
against 86 posts, which is most of them"* (M.O.M). Deliberately quotes no percentage: a
single run is a sample.

### 6.3 IS BLOCKED BY DATA, AND THAT IS NOW MEASURED RATHER THAN ASSERTED

The 33 `KnownPaidPost` shortcodes would roughly triple the paid ground truth. They are not
reachable, and the reason is specific:

- their shortcodes are `C4…`, `C8…`, `C-…` — **2024 posts**;
- the stored corpus for @viralbhayani reaches back only to **2026-07-29**, and the anonymous
  feed is a **48-deep window**, so no backfill can reach 2024;
- **32 of the 33 URLs name no page at all** (`/p/…` and `/reels/…` permalinks carry no
  author). The one that does names `@bollywoodpaparazzii`, which is not a watched channel.

So the blocker is not an unrun command. Unblocking it needs Tabish to supply either the
captions or the posting page AND a source that reaches 2024 — neither of which this system
has. `ig:accuracy` reports the 33 as unscorable on every run rather than staying silent.

### 6.6 WAS DELIBERATELY NOT BUILT, AND THE REASON IS ITS INPUT

Curated exemplars are the plan's own "single most dangerous thing that could be built here".
Its input is the disagreement queue, and that queue currently holds **2 usable rows** — the
other 16 are the poisoned bulk write. Drawing few-shot exemplars from two examples is not a
learning loop; and its promotion gate ("recall must not fall on any channel") cannot be
evaluated while recall itself swings 95-100% between identical runs. Both blockers clear the
same way: settle Phase 7, then let the review queue accumulate real answers.

---

## THE CLASSIFIER IS NOT DETERMINISTIC, AND "100% RECALL" WAS ALWAYS ONE SAMPLE

**READ THIS BEFORE QUOTING ANY ACCURACY FIGURE IN THIS FILE, INCLUDING THE ONES ADDED TODAY.**

MEASURED 2026-08-13, three runs of `pnpm ig:accuracy` against an unchanged corpus, an
unchanged prompt and unchanged code:

```
@madovermarketing_mom   recall 95%   ·   recall 100%   ·   recall 95%
                        correct 95%-98%   precision 88%-92%
```

**2 of 89 posts change verdict between identical runs** (`C0f7E7Jyu3l`, `Db-pCbEE8El`), and
at 22 paid posts one flip is 4.5% of recall. Every figure this file records — 98%, 100%
recall, 92% precision — is a SINGLE RUN quoted to the percentage point.

The consequence is not academic. This project's standing gate is *"revert rather than tune
if recall moves off 100%"*, and **that gate fires on noise**: a run showing 95% after a
change that did nothing is the common case, not the exception. It fails the other way too —
a real regression of one post is indistinguishable from an unlucky run.

`pnpm ig:accuracy --repeat 3` reports the RANGE and names the unstable posts. Use it before
and after any prompt change; a single run is a sample, and the harness now says so.

## ACCURACY IS PER CHANNEL NOW, AND @viralbhayani DOES DISCLOSE — TWICE

`ig:accuracy` scored one channel and one source. It now reads `src/detection/labels.ts`:
three sources with provenance on every row, a block per channel, and **UNMEASURED** where a
channel has no labels rather than a number borrowed from somewhere else.

| channel | detector | labels / stored | correct | recall | precision |
|---|---|---|---|---|---|
| `@madovermarketing_mom` | mom | **84 / 86 (98%)** | 95-98% | **95-100%** | 88-92% |
| `@viralbhayani` | semantic | **4 / 1,005 (0%)** | 75% | **67% (2/3), stable** | 100% |
| `@bollywoodsocietyy` | semantic | 1 / 802 | — | n/a | n/a |
| `@bollywoodchronicle` | semantic | **0 / 937** | **UNMEASURED** | — | — |

**THIS FILE SAYS @viralbhayani *"Never"* DISCLOSES, AND THAT IS NOW FALSE.** The `0/48`
measurement was true of the 48 posts it read. Across the **1,005** now stored there are
**2** `#Ad` posts — `Dbxvk4cKm-y` and `DbzyBNZThnu`, both Vivo — and **the classifier gets
both right**. Two labels is not many, and they are the only fact-grade ground truth that has
ever existed for the channel supplying most of the paid posts this system finds.

**THE ASYMMETRY THAT MAKES THE VIRAL FIGURE HONEST.** A disclosure hashtag PRESENT is a label
on any channel. A hashtag ABSENT is a label only where the publisher discloses reliably —
which is exactly what `detectorKey: 'mom'` asserts. On @viralbhayani absence means nothing,
so treating it as a negative would mint **1,003 fake ORGANIC labels against 2 real
positives** and report ~99% for a channel it had barely measured. That is *absence of data
hardening into a negative verdict* arriving in the one place whose whole job is telling the
truth about the numbers.

**AND 15 OF VIRAL'S 24 HUMAN LABELS ARE INSIDE THE POISONED BULK WRITE.** `findBulkWrites`
(PURE) separates labels sharing a byte-identical `labelledAt` — 21 of them, one script, one
second, 8 August. They are EXCLUDED by default and NAMED on every run, never rewritten;
`--include-bulk` shows the effect. Of 24 human answers, **3** are usable. The rule is about
the WRITE, not the answer: a label stamped in the same millisecond as twenty others was not
a judgement about that post.

**@viralbhayani's one miss is STABLE across all three runs** — `DbxpLGsCmBz`, a post a person
marked paid that the classifier calls ORGANIC at 85% ("editorial commentary on actor's look").
That is a reproducible error with a known correct answer, which is the highest-value row in
the system and the seed of the disagreement queue (plan 6.5).

**The footage RESCUED a labelled-paid post for the first time** (`Db-pCbEE8El`) — the first
time that counter has been non-zero in any recorded run.

### AND TWO MORE PLAN NUMBERS MEASURED FALSE

- **Phase 3.3's premise.** *"Five `signals LIKE '%frame:…%'` scans at 223 ms each"* measures
  **42 ms for all five** on the live Postgres — 8 ms each against 6 ms for a plain count.
  That was a SQLite figure. **3.3 was not done**: its stated justification does not exist,
  and the remaining benefit (making the five states explicit) does not justify a schema
  migration applied to a live database from a machine that cannot deploy the code using it.
- **The tunnel round trip.** This file says 28-37 ms. `pnpm local` now measures and prints it
  on every run (plan 3.5): **4.3 ms, median of 7**, with the multiplication spelled out —
  *"the busiest page issues about 450 queries, so roughly 1.9s of waiting"*.

---

## THE 13 AUGUST EVENING SESSION — THE CADENCE, THE CAP, AND FOUR THINGS READING FOUND

Read this before the section below it: it FINISHES the repair plan's phases 4.1, 4.2, 4.3 and
3.4, and it **re-measures numbers that were already stale a few hours after being written.**

**EVERY DOCUMENTED FIGURE THAT WAS RE-MEASURED HAD MOVED.** Not by much, and that is the point
— these were written the same day:

| CLAUDE.md / the plan said | measured against live Postgres |
|---|---|
| the burner holds **70** pair rows | **72** |
| **22** waiting drafts, 15 surplus | **26** waiting, 17 surplus |
| **68** BRAND targets | **70**, then **71** after one detect pass |
| **23** human labels | **24** |
| `ig:accuracy` 96% correct, 87% precision, 20/20 | **98% correct, 91% precision, 21/21 (n=80)** |

**RECALL IS STILL 100%.** Nothing in this session touches the classifier; the corpus grew.

### 1. DRAFTING IS ON THE 15-MINUTE CLOCK NOW, AND THE CAP THAT BOUNDS IT BINDS (4.1 + 4.2)

Shipped together, as the plan required. `detectThenDraft` no longer asks
`settings().autopilotEnabled` before planning — the branch had **never fired**, and `runSlot`
called `runOutreach()` unconditionally, so the two paths disagreed and the slot path is the one
that matches the product. Drafting contacts nobody: `plan.ts` has one `.send()` call site and
it is `manualAssistSender`.

**The cap it needed is `brandTouchCounts.ts`, and the old one could not bind at all.**
`checkNewBrandTouchCap` was asked ONE number, counted over DELIVERED messages — and **nothing
has ever been delivered**, so it was permanently 0 and the only thing binding was a counter
reset every run. "2 a day" was enforced as "2 a run": ~8 at four slots, and **~192 once drafting
moved to 96 passes a day.** It now takes TWO counters, both named and both measured against the
cap independently: first touches **written** today and first touches **delivered** today.
VERIFIED against live data in both directions — `created=6 delivered=0 cap=2` refuses now, where
the old rule said ALLOW. `/rules` renders both from the same function the planner asks.

Do not merge them. They answer different questions and today they read 6 and 0.

### 2. AN ACCOUNT OUTSIDE THE ROTATION NOW GETS NO ROUTE (4.3), AND THE RULE IS IN routes.ts

`@tabishmukaddam1` is `fleetMember: false` and held **72** pair rows. This file used to say the
burner's routes were "excluded at the query rather than here" — true, and it left the rows in
place, when the whole content of the 2026-08-08 change is that **a pair row IS a live route**.
Not one of the three creators (`addTarget`, `brandTarget`, `importProspects`) filtered on fleet
membership; `addTarget`'s own comment DEFENDED that, to protect "the burner's rehearsal routes".

**Rehearsal never used them.** `prepareOnDemandSend` CREATES the pair it needs when a person
picks both ends — it is the documented exempt creator. So `RouteQuestion` gained
`senderIsFleetMember` and `mayRouteExist` refuses `sender-not-in-fleet`; the compiler named all
five call sites. **VERIFIED IN PRODUCTION, not by a test**: a real detect pass discovered
`@googlegeminiindia` and gave it three fleet routes and none for the burner (fleet 72 → 73,
burner unchanged).

`pnpm ig:prune-pairs` removes what already exists. **DRY RUN BY DEFAULT, and NOT YET RUN** — it
must follow the deploy, exactly like `ig:dedupe-drafts`, or the server recreates the rows.

**THE CASCADE TRAP, GUARDED AND MEASURED.** `OutreachAttempt.pairId` is `ON DELETE CASCADE`, so
a pair delete erases the record of messages real people received — which spacing, the
unanswered-touch cap and the new-material rule are all derived from. `mayPrunePair` (PURE)
refuses any pair carrying an attempt of ANY status, and the delete carries the condition itself
(`attempts: { none: {} }`) so check and write are one statement. **0 of the 72 carry an attempt,
so the refusing branch cannot execute against live data** — `tests/prune-pairs-live.test.ts`
constructs it against a real database, and asserts in the same file that removing the guard DOES
erase the attempts, or the test would pass on a harness where the cascade never fires.

### 3. THE QUERY BUDGET (3.4) FOUND A 559-QUERY DASHBOARD ON ITS FIRST RUN

`pnpm ig:layout` now asserts a per-page query count, read from `/api/query-count`. It is the
only item in the plan that prevents recurrence, and it earned its keep immediately: **`/` issued
559 queries, measured twice, 1,577 ms — after `buildBrandsPanel`'s N+1 was killed this week.**

The cause was the per-draft gate loop in `buildMessagesPage`, whose own comment claimed the list
was "small by construction — `maxUnansweredTouches` and the daily caps bound it". **Those bound
SENDS. Nothing bounded DRAFTS**, and 4.1 takes drafting to 96 passes a day. The list is capped
at `WAITING_SHOWN` (20) with the total shown beside it, which took `/` to 454. The remaining
count is the deliberate design — every draft states why it cannot be sent, from the gate that
would refuse it — and reducing it means batching the gate's own reads, which is **outstanding
work, not a solved problem.** Budgets are ceilings over a BOUNDED design; raising one to make
the check pass is the one thing not to do.

**GETTING THE COUNTER RIGHT TOOK TWO WRONG ANSWERS, BOTH OF WHICH PASSED.** A module-level
counter gave every page exactly **2**; moving it to `globalThis` gave every page **0**. In
production `db.ts` deliberately does NOT cache the client on `globalThis`, so each Next route
bundle builds its OWN PrismaClient — the counter must be global and the SUBSCRIPTION per client.
Both wrong versions printed a green tick. Only the printed NUMBER gave them away: 0 queries to
render `/` is not plausible. **A checker must show its working.**

### 4. READING THE RENDERED PAGES FOUND FOUR DEFECTS A PASSING SUITE AND A GREEN GEOMETRY CHECK BOTH MISSED

| | |
|---|---|
| `/` said **"watch running INSIDE THIS DASHBOARD"** on a Mac, while the watch runs on the Linode. `host` is `'dashboard'` for the hosted deployment too; only `machine` distinguishes them. `SchedulerState` now carries `machine` and `here`, and the sentence names the other machine and says slots fire "whether or not this window is open" |
| `/targets` rendered **"about 768requests a day"**. The source has a space and the words are on the SAME line — the space vanishes because the text node CONTINUES onto the next line. Narrower than the gotcha already recorded here, and the same paragraph used `{' '}` correctly two words later. **Three more instances were then found by scanning the served HTML for `[a-z0-9]<!-- -->[a-z]`** — `387older posts`, `747posts had`, `19 postsnobody`, `24 postssettled` |
| `/targets` promised **"Next message comes from @bollywoodchronicle"** for all 8 BRAND rows that are PEOPLE, which `checkRecipientIsNotAPerson` refuses in the planner. The mirror of "never claim a halt the gate is not enforcing", and worse: those rows were left for a person to JUDGE, and this was the one screen where someone would notice they are people |
| `/rules` listed **"the route being off"** among the rules a person may cross — `PAIR_DISABLED`, deleted 2026-08-08. The page promises every value on it comes from the module that enforces it, and that half was hand-written prose. `CROSSABLE_RULES` is now declared in `onDemand.ts` and the page is TOTAL over it, like `STOP_LABELS` |

**VERIFIED:** typecheck clean · **1,446 tests** (from 1,426), 71 files · `pnpm build` clean ·
`pnpm ig:layout` all green including the new budgets · `pnpm ig:accuracy` **100% recall
(21/21)**, 98% correct, 91% precision · `pnpm ig:detect` one clean pass, brand resolution
working from the home IP. Every new guard was mutation-tested.

**STILL OUTSTANDING, and the order is unchanged:** nothing is committed or deployed;
`ig:prune-pairs --run` and `ig:dedupe-drafts --run` both wait on the deploy; `/`'s 454 queries;
**Phase 7 is Tabish's decision and Phase 6.2 must not ship until it is settled** — a harness
built on 21 known-wrong labels measures against poison.

---

## THE 13 AUGUST REPAIR — WHAT WAS FIXED, AND THE TRAP THE FIX ALMOST SET

The five findings below were worked through against `docs/specs/2026-08-13-repair-and-learning-plan.md`.
Read this first: it corrects three of the plan's own numbers and records one near-miss that
matters more than any of the fixes.

**1. ROTATION IS LIVE. A recipient in no group is now rotated through the FLEET.**
`whoseTurn` cannot return null any more, so there is no branch left meaning *everybody
writes*. A recipient in a group keeps that group's ring; the fleet ring is ordered `cohort`
then handle and is built **from the pair rows that already exist**, so it can never elect a
sender with no route. `/messages` names the account on every draft and `/targets` names it
per recipient, both from `whoseTurn` itself. `pnpm ig:dedupe-drafts` (dry run by default)
clears the 15 surplus drafts already queued.

**AND THE FIX ALMOST STOPPED DRAFTING FLEET-WIDE, SILENTLY.** `plan.ts` built its
`unavailableSenders` map from `profileStatus(handle).hasSession` — a FILESYSTEM check. That
was harmless only while rotation was inert. MEASURED before making it binding: the planner
runs on the **Linode** (`schedulerHeartbeat` → `machine: linode-detect`, every waiting draft
written at :30/:31 UTC by the slot path there), and that host has **no `~/.ds-sales-agent`
directory at all** — profiles live on each operator's own device and the server may never
send. So the filesystem answer is `false` for every account on the one machine that drafts,
and a binding rotation fed that map returns `all-unavailable` for every recipient. Drafting
stops everywhere, looking exactly like a planner that ran and found nothing to do.

`readSenderAvailability` (`src/outreach/availability.ts`) is the one reader now, shared by
the planner, the dashboard and `ig:dedupe-drafts`, and every fact in it is
MACHINE-INDEPENDENT: status, `sessionInvalidAt`, and `sessionRecorded` (a hand login was
once recorded and nothing has since proved it dead). Weaker than `sessionUsable` on purpose
— it decides only whose turn it is to be WRITTEN to. Whether a message may go OUT is still
`gate.ts`, on the device that actually sends. **The general rule: a database shared between
hosts plus per-host filesystem state is not one system, and any guard that mixes them gives
a different answer depending on where it ran.**

**2. THE MESSAGE FIXES, and reading the bodies found one more than the audit did.** The
handle appears **three** times in an affected pitch, not twice — greeting, placement claim,
and the "For X that would mean" line. `usableBrandName` (PURE) refuses a display name only
when it normalises to the handle AND has no whitespace AND is all lower case; the obvious
normalise-and-compare rule matches **47 of the 68 live BRAND rows**, including *Amazon MGM
Studios*, *Crocs India* and *Royal Canin India*, so it would have degraded 47 pitches to fix
21. Asked inside `brandFirstTouch`, not at the call site. The greeting falls back to
"Hi there," rather than inventing a company name.

**`HOOK_STALE_SINCE_DRAFT`** is an eleventh gate stop (`RESEND_BLOCKS` 10 → 11), not
overridable, beside `PERSONA_CHANGED_SINCE_DRAFT` and for the same reason. It reads the band
the STORED body asserts (`assertedRecency`) and compares it against the band that campaign's
age would produce now — reading the body, because an operator may have edited it and the
stored bytes are what the send guards compare against. Verified against the live Amazon
draft: posted 2 August, currently **10.96 days** old, so it says "last week" truthfully for
about another hour and is `stale=true` at +2h. Brand first touches carry `campaignId: null`
and get their date from `discoveredFromCampaignId`; reading only `attempt.campaign` would
have left the stop unreachable on exactly the drafts that have it wrong.

**3. A PERSON IS NOT A COMPANY, AND THE CAUSE WAS NOT A NAME HEURISTIC.**
`PERSON_CATEGORIES` was a `Set` compared with **exact equality** containing `'director'`,
`'producer'` and `'artist'`, while Instagram returns `"Film Director"`, `"Film Producer"` and
`"Creators & Celebrities"`. None ever matched. MEASURED: **8 of 68 BRAND targets are human
beings** — five film directors including Karthik Subbaraj, the actor Rahul Dev, Shalini
Passi. `isPersonRoleCategory` matches on WORD boundaries (a bare `includes` would file
"Broadcasting & media production company" as a person on "production"). A classifier fix does
not reclassify existing rows, so `checkRecipientIsNotAPerson` is a third brand-only guard in
`brandGuards.ts` — the planner refuses to write to them, because *a report nobody runs is not
protection*. The rows are left for a person to judge, exactly as the plan asked.

**4. THE DASHBOARD IS 19× FASTER, MEASURED.** `buildCeoView` **9.9 s → 508 ms** against the
same live Postgres over the same SSH tunnel. `buildBrandsPanel` is three queries regardless
of brand count (rows, one `groupBy`, one `findMany`) and is bounded at 40 with the total
shown beside it, the way the posts table already does it. `tests/labels.test.ts` caught the
refactor holding a raw `displayName` in a map — that grep earning its keep.

**5. FRAME RECOVERY: THE PLAN'S 804 IS A MAC NUMBER AND THE REAL ONE IS ZERO.** Frame stores
are **per machine**: the Mac holds 446, the server 1,057, and the server is where detection,
OCR and judging run. Measured there: 2,375 in-window posts, **1,048 with a frame**, 85 with a
URL worth trying — and `--capture` saved **0 of the 85**, all HTTP 403. Those URLs are gone.
What matters is that the preventive half already works: **100% frame capture every day since
9 August** (119/119, 167/167, 206/206, 188/188, 69/69). Nothing to build; the backlog is
unrecoverable. **Note the consequence: `/paid-posts` frame counts differ by 2.4× depending on
whether the Mac or the server rendered the page.**

**AND TWO MORE PROSE CLAIMS IN THIS FILE WERE FALSE.** `requestsPerSlot` was computed by
`buildProspectsPage` and rendered **nowhere**, while this file said "/targets shows what
watching currently costs in requests per slot". It does now, per DAY — a per-slot figure
understates the real load 24× since detection got its own 15-minute clock. And `addTarget`'s
docblock still promised "Pairs start DISABLED", three months after the chip was deleted, on
the one action that creates a recipient.

**VERIFIED:** typecheck clean · **1,426 tests** (from 1,281) · `pnpm ig:accuracy` **100%
recall** (20/20), 96% correct, 87% precision · `pnpm ig:detect` one clean pass, brand
resolution working from the home IP (`looked=10 created=2 haltedEarly=false`). Every new
guard was mutation-tested; one attempt passed against a deleted sort until the fixtures were
inserted in the OPPOSITE order to the answer they expect, which is the test being fixed
rather than the code.

### WHAT IS STILL OUTSTANDING, AND THE ORDER TO DO IT IN

**Nothing from this session is committed, and nothing is deployed to the Linode.**

**THE ORDERING TRAP, before anything else.** `pnpm ig:dedupe-drafts --run` must NOT be run
until the rotation fix is deployed to the machine that DRAFTS (the Linode). Until then the
next slot recreates all 15 duplicates and the only lasting effect is 15 audit rows. The
command prints this warning itself and the dry run is the default.

| | why it was left |
|---|---|
| `pnpm build`, `pnpm ig:layout` | Something was listening on **:3100** and the standing rule is never to build while it is. Stop the dashboard, then run both. `ig:layout` needs `DS_LAYOUT_TOKEN` set to a session cookie value — mint a row, revoke it after |
| **the diagram** | Its **"Known wrong"** section names five defects and three are now fixed, so that section has become the stale part — worse than none, because it is what a reader trusts to be current. The exact delta is written into `docs/PIPELINE.md`. Re-publish by passing the existing URL as `url`, or Tabish loses the bookmark |
| **Phase 4.3** — the burner's 70 pair rows | `OutreachAttempt.pairId` is **`ON DELETE CASCADE`**: a delete path that reaches a pair with history erases the record of messages real people received, which is what spacing, the unanswered-touch cap and the new-material rule are derived from. 0 of the 70 carry attempts *today*, so a delete is safe today and a delete PATH is not. The exclusion is asserted twice instead — `runOutreach` and `fleetRingFor` both scope to `fleetMember`, each with a test |
| **Phase 4.1 + 4.2** | Must ship **together or not at all**, and the plan says so: removing the `autopilotEnabled` gate on `detectThenDraft` takes drafting from 4×/day to 96×/day, and 4.2's cap is the only thing that would bound the resulting queue. Every draft is a frozen body with a decaying claim — `HOOK_STALE_SINCE_DRAFT` now catches that at the gate, which makes 4.1 safer than it was this morning but does not make it free |
| **Phase 3.3–3.5** | The five `signals LIKE '%frame:…%'` scans at 223 ms each; the query budget in `ig:layout` (**the only item here that prevents recurrence** — the N+1 went unnoticed for months); round-trip reporting in `pnpm local` |
| **Phase 6** | The learning loop, untouched. **6.2 must not ship before Phase 7 is settled** — 21 human labels are known-wrong, including both founding cases of the footage feature, so a harness built on them measures against poison |
| **Phase 7** | Tabish's decision, not a code change. The 21 answers are visible and one click from correct on `/paid-posts` → "Answers you have given" |

---

## THE 13 AUGUST FINDINGS — FIVE THINGS THE DOCS AND THE UI BOTH GET WRONG

**FINDINGS 1, 4 AND 5 ARE FIXED — see the section directly above. Findings 2 and 3 are still
live.** The text below is kept as the measurement that justified each fix.

Found by answering six questions Tabish asked after reading the real dashboard. Every one was
measured against the live system, and every one contradicts something written down.

**1. ROTATION HAS NEVER RUN. NOT ONCE.** MEASURED: `Category` **0 rows**, `CategorySender`
**0**, `CategoryTarget` **0**, and 0 of 72 targets in a group. `plan.ts` asks `whoseTurn()`
per pair; it returns **null** for a target in no category, and both guards are
`if (turn && …)`, so null means *no rotation at all*. The planner says so itself: *"A target
in NO category behaves exactly as before — every enabled pair is considered independently."*

So **every sender drafts to every recipient.** MEASURED: 8 recipients hold drafts from
multiple senders, **6 of them from THREE senders each** — @amazondotin, @agoracitycentre,
@absolutejk, @crocsindia, @viralbhayani, @madovermarketing_mom. The three bodies are
near-identical and carry the **same phone number and email**, differing only in the page
name. That is precisely the cross-account fingerprint decision 3b exists to prevent, and
`MAX_PER_TARGET_PER_DAY=2` means two of the three could reach one inbox on one day the
moment Autopilot goes on.

**The mechanism is not wrong — nothing feeds it.** `nextSender` does exactly what Tabish
described: start after the last sender who wrote, walk the ring, skip whoever cannot send.
It is pure and tested. What is missing is any way to put a target in a group: the "Rotation
groups" UI was deleted 2026-08-07 (Tabish: confusing) and the note left behind says
*"behaviour is unchanged — the table has always been empty"*. TRUE THEN, at four senders and
a handful of targets. It stopped being true on 2026-08-08 when pair rows became live routes,
and again on 2026-08-12 when brand discovery created 59 BRAND targets. `setTargetCategory`
still exists in `actions.ts`, is called by nothing, and revalidates `/prospects` — a retired
redirect stub.

**2. THE 15-MINUTE DRAFTING CLOCK DOES NOT RUN, because it is gated on Autopilot.**
`scheduler.ts`, `detectThenDraft`:

```ts
if ((await settings()).autopilotEnabled) {
  await lock('detect-draft', plan)      // ← never fires while Autopilot is OFF
}
```

MEASURED on the server's pm2 log: **23 detection passes, 1 outreach pass** in the same
window, and every waiting draft was created at :30/:31 UTC — exactly 11:00/15:00/17:00/20:00
IST. `runSlot` calls `runOutreach()` **unconditionally**, so the two paths disagree about
whether drafting needs Autopilot, and the slot path is the one that matches the product: a
draft with Autopilot off is the intended state ("prepared and waits for a click"). The
2026-08-11 entry claiming drafting joined the detect clock describes something that has never
happened with Autopilot off, which is the normal state.

**3. "2 NEW BRANDS A DAY" IS ACTUALLY "2 PER RUN", AND THE PERSISTENT HALF NEVER BINDS.**
`checkNewBrandTouchCap` reads `newBrandTouchesToday`, and `plan.ts` counts that over
**DELIVERED_STATUSES** with `sentAt >= dayStart`. **Nothing has ever been delivered**, so it
is permanently 0 and only `brandFirstTouchesThisRun` binds — reset every run. Four slots a
day × 2 = ~8 brand first touches a day. That, with finding 2, is the whole answer to *"why
only 22 drafts when 100+ paid posts were found"*: MEASURED 22 waiting drafts, **62 of 68
brands never drafted**, and at this rate ~25 days to reach the brands already discovered.
Same shape as the `MAX_TOTAL_SENDS` bug — a limit whose reported meaning and enforced meaning
are different rules.

**4. THE DASHBOARD IS SLOW BECAUSE OF AN UNBOUNDED N+1 OVER A TUNNEL.** MEASURED: `/`,
`/paid-posts`, `/targets` and `/analytics` each take **9-15 seconds**, second request no
faster. `buildCeoView` alone is **9.9 s** and issues **174 queries**.

- `buildBrandsPanel` reads every `kind: 'BRAND'` target with **no `take`**, then per brand
  runs **two serial awaits** — 145 of the 174 queries.
- Raw ping to the Linode is **4.4 ms**; a `select 1` through the SSH tunnel is **28-37 ms**,
  and 20 concurrent queries on a pool of 10 take 305 ms, because SSH multiplexes every
  channel over ONE TCP stream. Concurrency barely helps.

Neither cause is sufficient alone: on SQLite at ~1 ms a query the N+1 cost 0.2 s and was
invisible. **Hosting turned a latent design flaw into a ten-second page, and brand discovery
finally working on 2026-08-12 is what tripped it** — 9 brands became 68. It grows linearly;
at 500 brands the page is a minute. Minor and separate: five `signals LIKE '%frame:…%'`
substring scans on `/paid-posts` at **223 ms each**, unindexed.

**5. `brandName` IS DOCUMENTED "never a handle" AND IS A HANDLE.** The contract is a comment
with nothing enforcing it. MEASURED by reading the real stored bodies:

| target | `displayName` | what the DM would say |
|---|---|---|
| `@agoracitycentre` | `agoracitycentre` | *"I saw agoracitycentre's placement with Viral Bhayani…"*, twice |
| `@ahambysenco` | `ahambysenco` | the same |
| `@absolutejk` | `Jignesh N Khatiwala` | ***"Hi Jignesh N Khatiwala team,"*** |

`brandTarget.ts` writes the handle into `displayName` when Instagram returns no full name, and
`brandPitch` reads it straight into prose. 6 of 16 brand drafts carry a raw handle. The third
row is worse than cosmetic: a person's name greeted as a team is the *wrong-"company"* risk
realised, and the confidence floor cannot catch it because the model was confident.

**WHAT IS ACCURATE, checked rather than assumed.** The Amazon pitch's claim — *"I saw Amazon
India's placement with Mad Over Marketing last week"* — is **TRUE**: `DbiT2rHk2w6` carries
**`#Collaboration`**, M.O.M's own disclosure, `verdictSource: 'rules'`, confidence 100. My
first reading was that this looked like M.O.M's editorial ABOUT Amazon's campaign, which is
the documented false-positive class; the disclosure hashtag settles it the other way. The
recency band is `days <= 10 → "last week"` and the campaign was 9 days old when drafted — at
the edge, and **the body is frozen at draft time**, so a draft that waits keeps a recency
claim that decays. `crocsindia` has no provenance and correctly makes no claim at all.

**AND THE SPEND IS NOT A CONCERN.** MEASURED: **$0.117 total, ever**, across 4,496 model
calls; **$0.019 today** over 691 calls; classifier cache hit **93.7%**. Roughly two cents a
day. Nothing in detection or drafting is token-intensive.

---

## The one rule that overrides everything

**Account safety outranks throughput, always.**

Three Instagram accounts send from here — `@madaboutmarketingg`,
`@bollywoodsocietyy`, `@bollywoodchronicle` (note the doubled final letters on the
first two; both were wrong in the seed until 2026-07-30). They are revenue-generating business
assets tied to Digital Sukoon's 200-page network. Losing one costs more than any
outreach campaign gains. Tabish stated it directly: *"there must be no sabotage,
these are high risk accounts and should not get banned for suspicious activities."*

In practice:

- Never raise volume, shorten a delay, or disable a guard to hit a number.
- Never retry into an Instagram checkpoint. Pause and surface it.
- If a change increases account exposure, do not ship it silently — raise it.
- When uncertain, take the conservative option and say so plainly. Do not reassure.
- Cold DMs already violate Instagram's ToS. Residual risk is never zero; the job
  is keeping it near zero, not pretending it is absent.

---

## What this is

A standing watch on two Instagram publisher channels — `@madovermarketing_mom`
and `@viralbhayani`. When either posts paid/branded content, the agent writes a
partnership pitch and **sends it**.

```
Every slot — 11:00 / 15:00 / 17:00 / 20:00 IST:
  1. READ     watched channels → detect paid campaigns (anonymous, no login)
  2. REPLIES  11:00 and 20:00  → read open conversations, halt any that answered
  3. DISPATCH one tick         → see below
  4. PREPARE  drafts           → bespoke on first touch, fresh hook on follow-ups.
                                 The planner NEVER sends; it only writes drafts.

Every 15 minutes — the paced dispatcher, 10:00-21:00 IST:
  - may the fleet send at all?   circuit breaker, autopilot, active hours, the gap
  - whose turn is it?            rotation, per category, derived from send history
  - is this conversation clean?  a follow-up READS its own thread first, or holds
  - claim, atomically            recipient + sender + fleet allowance, or none
  - send ONE message             under a fleet-wide lock, then stop until next tick

Sending happens three ways, one code path underneath:
  autopilot   → unattended, if the ONE switch is on AND pacing permits AND the
                account can actually send (session, status, group, persona — all
                DERIVED, none of them a switch since 2026-08-08)
  one click   → "Send from @x" on the dashboard
  by hand     → pnpm send, or the "send it by hand" fallback on each card
```

**Detection runs on its own 15-minute clock. DRAFTING WAS MEANT TO AND DOES NOT** — it is
gated on `autopilotEnabled` in `detectThenDraft`, which is OFF, so drafting still happens
only at the four IST slots. MEASURED 2026-08-13: 23 detect passes to 1 outreach pass. See
finding 2 at the top of this file; do not read the 2026-08-11 entry below as describing
production.

### How the send actually works

Each sending account has **its own real Chrome profile**, at
`~/.ds-sales-agent/chrome-profiles/<handle>`. You log into it **once, by hand** —
press **Connect** on the dashboard, or run `pnpm ig:login <handle>`; automation
drives that same profile forever after.

That one design choice is the whole safety argument. What gets accounts banned is a
session appearing on a device that has never seen it — a hand login writes durable
device identifiers (`mid`, `ig_did`, `ig-u-rur`) and records a login event from your
home IP, and reusing that profile means Instagram sees a device it already knows.
**Never import a cookie or `storageState` into one of these profiles.** `sessionid`
is a bearer token with no channel binding, so a transplant *works* — right up until
enforcement lands silently. If a profile is not logged in, the fix is
`pnpm ig:login <handle>`, never a transplant.

The send path (`src/outreach/browser/sendDm.ts`) is: feed → scroll → target's
profile → scroll → **Message** → paste → verify → Enter → confirm it appeared in
the thread. Never deep-link `/direct/t/<id>`. Input is `page.mouse` /
`page.keyboard` / `locator.click()` only, so events carry `isTrusted` — never
`evaluate(el => el.click())`, never `fill()`.

The body is **pasted**, not typed: nobody hand-types a 1200-character pitch, and
typing it would need Shift+Enter between twenty lines, where one missed modifier
sends twenty separate DMs to a prospect.

**Two guards that must not be removed.** Before Enter, the composer's contents are
read back and compared to the drafted body — a failed paste or misplaced focus
cannot be delivered. After Enter, the message must be found in the thread before
anything is recorded as SENT.

**A checkpoint is never retried.** A challenge, suspension notice, or login form
where a session was expected marks the sender `CHALLENGED` and halts every pair
using it. An automatic retry here is not an improvement.

### Hands-free needs a scheduler, and it must be visible

Autopilot is a *permission*. The **scheduler** is what actually fires at 11:00 /
15:00 / 17:00 / 20:00. For a day those were confused: the scheduler only existed as
`pnpm worker`, nobody had run it, and the dashboard reported "Autopilot is ON —
messages go out at 11:00" with no process on earth able to send one.

The dashboard now starts the same scheduler in its own process
(`instrumentation.ts`), so turning the app on is enough. `pnpm worker` still works
for a server; whichever starts second sees the other's heartbeat (`Setting` key
`schedulerHeartbeat`, written every 60s) and declines rather than double-firing every
slot. The dashboard shows that heartbeat, in red when it is stale — **a toggle that
promises behaviour must show whether anything is behind it.**

The scheduler on its own only detects and drafts. Delivery still needs all four
switches below, so embedding it does not widen what can be sent.

### Delivery is a PACED DISPATCHER, not a step in the slot

Rewritten in Phase 5 (2026-08-05). `runSlot` is: detect → check replies → **one dispatch
tick** → plan new drafts. The tick is also fired on its own cron, every
`DISPATCH_INTERVAL_MINUTES` (15), by the same scheduler.

**Why it left the slot.** `deliverWaiting` drained the whole queue with a 45-180 s sleep
between sends. At four accounts with three drafts that is a two-minute slot. At measured
fleet volume — 11-14 paid posts a day from `@viralbhayani` alone — it is an hour of
continuous browser driving, and every message of it lands inside the same hour, in one
inbox, from a dozen different pages. That is the recipient-side pattern the whole fleet
design exists to avoid, arriving as a side effect of a loop rather than as anyone's choice.

The rules live in `src/outreach/pacing.ts`, PURE and tested both directions:

- **at most one send per tick** (`maxSendsPerTick`). Spacing is a property of the
  schedule, not of a sleep inside a loop that can wedge while holding a lock. The bound
  counts BROWSER DRIVES, not deliveries — a run of failures otherwise drove Instagram once
  per waiting draft with the counter stuck at zero.
- **10:00-21:00 IST** (`withinActiveHours`). This guard used to exist by accident: delivery
  only ran at four daytime slots, so "we never DM at 4 a.m." was a property of the slot
  list. A dispatcher on its own cadence would send at 03:40 from an Indian business page.
  Taking an implicit safety property and writing it down is the only way a refactor can be
  shown not to have dropped it.
- **a minimum gap** between fleet sends, and a **per-hour fleet allowance** (3/hour).
  Nothing is refused by pacing — it is DEFERRED, and the draft keeps its Send button.
- **a per-DAY fleet allowance that defaults to unlimited.** A fleet-per-day cap IS a
  system-wide cap and Tabish decided there is none; shipping a number would quietly
  reverse that. The mechanism is wired and is one `Setting` row (`fleetMaxPerDay`) from
  binding.

Fleet pacing uses `DailyReservation` with `scope: 'fleet'` — the scope Phase 2 added and
left unused. Same table, same unique key, same `create`-is-the-test-and-set. **Do not add
a second mechanism.**

**The circuit breaker.** Any account challenged in the last 24 h halts the WHOLE fleet:
all 65 drive one code path from one residential IP, so a checkpoint is evidence about the
pattern rather than about the account. Also a rising rate of `not-in-thread` — 2 or more
AND ≥30% of recent sends, both conditions, so one slow render cannot stop 65 accounts.

It can always be released, because *a hard stop with no release is a bug wearing a safety
feature's clothes*: clear the account's halt (immediate), or wait out the window (so an
un-cleared flag cannot wedge the fleet forever). `SenderAccount.challengedAt` is written by
**one** function, `markChallenged` — four code paths set CHALLENGED and any one omitting
the timestamp would make the breaker read "nothing was flagged" and keep sending.

**The planner no longer delivers.** It drove browsers inside its loop over pairs whenever
the switches lined up — a second send path, and the unpaced one: no fleet allowance, no
active hours, no breaker, no gap, no lock. There is now exactly one way a message reaches a
recipient unattended, and every condition is re-checked at delivery by `gate.ts`, which is
strictly better than checking them when the draft was written. **Verified rather than
assumed, 2026-08-11:** `plan.ts` has exactly ONE `.send()` call site and it is hardcoded to
`manualAssistSender`, which logs and returns `{ status: 'READY' }`; `browserSender` is not
imported there. Asserted by tests now, not by that file's comment — a comment claiming "one
implementation, two callers" was already present and untrue in `readThread.ts`.

**One clipboard, one send.** `sendDm` pastes from the OS clipboard, so two overlapping
sends can put message A into thread B. The per-attempt READY→SENDING claim stops the SAME
message twice and says nothing about two DIFFERENT ones racing — a dashboard click landing
during a tick. `withSendLock` covers every path that drives a browser, asks the OS whether
the holder is alive, and never steps over a live one however stale the lock. It also
refuses to NEST: granting a nested acquisition let the inner `finally` delete the outer
call's lock mid-send, which was found by running it.

`deliverWaiting` still re-checks only what can have CHANGED since the draft was written —
account CHALLENGED or disconnected, channel retired, they replied, today's caps used.
Anything held stays READY with its Send button; nothing is ever dropped.

**Its own `autoSendEnabled` hold was removed with the switches (2026-08-08), and leaving
it would have split one decision across two enforcers.** With the stop gone from `gate.ts`,
`recheckBeforeSend(unattended: true)` returned ok and `/messages` rendered *"Clear to send.
Every check passes; the paced dispatcher will pick this up in turn"* over a draft this loop
then held **forever** — for a reason deleted from `REMEDIES` and `STOP_LABELS`, so it
appeared on no screen at all. `autoSendEnabled: false` was the schema default, so that was
the common path rather than an edge case. Same shape as the `MAX_TOTAL_SENDS` bug: a page
reporting a limit by a different rule than the one enforcing it reads as headroom. **The
invariant is that a draft the gate permits is a draft the dispatcher will attempt**; the
two checks left in the loop re-read state that can move between the query and the send,
which is a freshness concern about an input, not a second copy of a rule. Each hold is logged with its reason, and `/messages` shows what the last tick did,
because "nothing happened" with no explanation is the failure this whole section exists to
prevent — and a dispatcher that holds silently would reintroduce it four times an hour.

### `not-in-thread` is never retried

The composer cleared — Instagram accepted the keystroke — and the message then never
appeared. Two things are true at once: **the recipient may have it**, and **this is what a
shadow restriction looks like from outside**. Re-sending is wrong under both readings.

Phase 0 made it recordable and deliberately changed no behaviour, so it went back to READY
— which is exactly what the delivery loop picks up. It now parks in `FAILED`, where nothing
automatic reads it (`deliverWaiting` queries READY; `evaluateResend` refuses anything else
with `not-waiting`, which is not overridable), and appears on `/messages` under **"check the
conversation"** with the two buttons that settle it. Confirmed delivered records it as SENT
and keeps the reservation; confirmed absent releases the reservation and re-queues it —
the one moment when delivery has genuinely been ruled out by someone who looked.

Parking a message where nothing picks it up is only safe because it is VISIBLE. Both halves
shipped together.

### AUTOPILOT IS ONE SWITCH (2026-08-08, Tabish's instruction)

> *"The moment autopilot is turned on there must be no more switches. One switch to turn
> on the process (which gets tracked) and when the switch is turned off no sabotage or
> discrepancy should take place. The channels which are undecided must also be decided on
> their own. How can adidas not be recognized as anything? I do not want this option to
> select manually, correct it. Automated mode must simply send the messages."*
> — Tabish, 2026-08-08

**There is exactly one control.** The **Autopilot** toggle on the dashboard. It defaults
**off**, both flips are audited, and nothing else has to be turned on afterwards.

Three subordinate switches were DELETED, not hidden: the per-account **Auto-send** bit
(`SenderAccount.autoSendEnabled`), the per-route chip (`OutreachPair.enabled`), and the
manual company / not-a-company buttons on the brands panel. `RESEND_BLOCKS` went 12 → 10 —
`AUTO_SEND_OFF` and `PAIR_DISABLED` are gone from `gate.ts`, from `governor.ts`, from
`deliverWaiting`, and from the four server actions that wrote them (29 actions → 25).

**What ON means, end to end.** One clock, and no step waits for a person:

```
every 15 minutes            detect        anonymous feed read, cover frames banked,
                                          caption judged then footage (judge.ts)
              ↓ same pass    auto-resolve  @mentions in in-window CAMPAIGN captions →
                                          BRAND targets, bounded at 10 lookups/pass
              ↓ same clock   draft         runOutreach, inside the SLOT LOCK.
                                          The planner NEVER sends
every 15 minutes, 10:00-21:00 IST
                             deliver       dispatchTick: at most ONE message, under the
                                          fleet-wide send lock, every invariant re-asked
```

**Drafting was WIRED onto the detect clock on 2026-08-11 and it has never fired: the branch
is gated on `autopilotEnabled`, which is off. Read finding 2 at the top of this file — the
problem this paragraph describes is still live.** (it was stage 4 of the four IST
slots). A paid post found at 11:20 waited until 15:00 before anything was written about
it, and a hook line is age-bounded by `HOOK_MAX_AGE_HOURS`, so a slow draft could retire
the very material it was going to reference. Same lesson as the 166 cover frames saved in
a day and never read: **the only reason the draft did not exist was a schedule nobody had
asked for.** Nothing about *sending* moved — four slots, reply checks at 11:00 and 20:00,
active hours, the gap, the allowance and the breaker are all untouched.

**What OFF means.** The dispatcher holds at its next decision point; at most the one
message already in flight completes, because a send under way is a browser mid-paste and
interrupting it is how a message lands with no record of it. Drafts keep their Send
buttons and are still delivered by a person clicking. Nothing else changes state — no
pair row is rewritten, no account is disarmed, no draft is discarded. Both flips are
audited. *"No sabotage or discrepancy"* is the requirement and it is met by OFF being a
gate the dispatcher asks rather than a sweep that edits rows: the burner's `pnpm burner
off` used to brake by rewriting `OutreachPair.enabled` across the fleet, and that command
is deleted for exactly this reason.

**THE INVARIANTS ARE NOT SWITCHES, AND EVERY ONE IS STILL ENFORCED.** This is the
sentence to check a future change against — removing the switches removed nothing below:

| | |
|---|---|
| pacing | active hours 10:00-21:00 IST, the minimum gap, 3/hour fleet, **one send per tick** |
| caps | per-target 2/day, per-sender daily, new-brand first-touches 2/day, the lifetime ceiling |
| circuit breaker | any account challenged in 24 h halts the WHOLE fleet; also a rising `not-in-thread` rate |
| checkpoints | a challenge or a login form marks CHALLENGED and is **never retried** |
| replies | halts every sender to that target; auto-resumes after `replyResumeHours` (24) |
| opt-out | `optedOut` refuses **forever**, checked before the reply halt |
| spacing | 7-day per-pair cooldown, the unanswered-touch cap (3), the new-material rule |
| the ladder | 14-day cohort soak, enforced at delivery by `mayArmAccount` at `gate.ts` |
| identity | persona distinctness; `PERSONA_CHANGED_SINCE_DRAFT` if the account was re-identified after drafting |
| proof | composer read-back before Enter, thread **delta** after it; `not-in-thread` parks in FAILED |
| env floors | `AUTOPILOT_ENABLED`, `SEND_ENABLED` — deployment config, no UI exposes either |

The two env floors are the one thing that outranks the toggle, and they are not switches
in the product sense: `SEND_ENABLED=false` lives inside `withSendLock`, so the **server
cannot send and never will**, and `AUTOPILOT_ENABLED=false` means a deployment may not
send unattended at all. A web page must not be able to widen its own access — same
reasoning as `SIGNUP_INVITE_CODE`.

**A physical limit no switch can cross.** Ability is DERIVED now (session + status +
cohort + persona), and two of the three revenue accounts derive to *cannot*:
`@bollywoodsocietyy` and `@madaboutmarketingg` hold no hand-login session, so turning
Autopilot on cannot make them send. **Only `@bollywoodchronicle` can.** Someone must press
Connect once, by hand, from the home IP — the one act in this design that cannot be
automated and must not be (see "log in once, by hand"). `/senders` says this as a
sentence per row rather than offering a control that would not work.

**`fleetMember` is what keeps the burner out, and it is IDENTITY rather than a switch.**
With the route chips gone it is the only thing standing between `@tabishmukaddam1` and
automatic outreach to real companies: `ensureFleetPairs` and `runOutreach` both scope
senders to `fleetMember: true`. It is deliberately NOT "every account we own" — the burner
is still MESSAGEABLE as a target, because it is the rehearsal recipient every end-to-end
send in this project was proven against, and widening the set reads like the safer
simplification while silently retiring the only safe test recipient there is.

**THE EXPOSURE THIS WIDENED, STATED PLAINLY.** ON now means cold DMs to brands discovered
within the last few hours, from revenue accounts, with **no per-route human step anywhere
in the path**. Before this, a discovered brand sat behind a chip somebody had to flip; the
recipient-side caps are now the only brake between a detected paid post and a stranger's
inbox. And the resolver is a model: a handle mislabelled as a company puts a media-buying
pitch in a private person's DMs from a revenue account. `RESOLVE_CONFIDENCE_FLOOR = 90`
and honouring `'unsure'` regardless of the number are structural mitigations and **not
evidence that the confident answers are right** — there is no accuracy harness for brand
resolution the way `pnpm ig:accuracy` exists for classification, so its error rate here is
unmeasured. That is the honest state of it, not a caveat to be smoothed over.

#### The four-yeses design, superseded — kept because it explains the shape

> Until 2026-08-08 autopilot needed four independent yeses: `AUTOPILOT_ENABLED` in `.env`,
> the dashboard toggle, **that account's own Auto-send switch** ("accounts graduate one at
> a time"), and a hand-logged-in Chrome profile. Any one missing meant the message was
> *prepared and waits for a click*.
>
> Three of the four survive in substance. The env floor is unchanged; the toggle is now
> the only control; and the profile requirement was never a switch — it is the physical
> fact above, which is why it is the thing still blocking two accounts today. **What went
> was #3**, and its stated purpose ("accounts graduate one at a time") is now served by
> the cohort ladder, which was always the mechanism that actually staged an expansion:
> 14 days per group, derived from send history rather than from an arming bit, enforced at
> delivery. The bit was a statement of intent; a delivered message is an observation.
>
> **The bit had also gone quietly inert, which is why leaving it would have been worse
> than removing it.** `autoSendEnabled` defaults false and nothing wrote it after the
> actions went, so anything reading it read false forever: `cohorts.ts` rule 2 would have
> reported **zero live accounts** and frozen the ladder at group 1 with no way to clear a
> step, and `plan.ts`'s missing-session warning could not fire at all — under-warning to
> total silence, exactly as the fleet grew. Rule 2 now means what it says: connected and
> not halted.
>
> The old fallback sentence — *"prepared and waits for a click"* — is still true of every
> stop in the table above. It stopped being true of a *switch*, because there is only one.

### The send is proven three times, all from one throwaway account

All on 2026-07-31, all from `@tabishmukaddam1`, all verified by reading the thread
rather than trusting our own logs:

| | |
|---|---|
| one click, dashboard | → `@priyanshu123321123`, 47s, thread `/direct/t/18098292211925958` |
| unattended, hand-run slot | → `@bollywoodchronicle`, `sentBy=autopilot:…`, thread `/direct/t/107198187338891` |
| **cron-fired, on the clock** | → `@bollywoodsocietyy`, 14:00:00 IST exactly, 77.5s |

The third closed a gap the first two did not: both of those were started by a person
or by a hand-run `pnpm run:slot`. **No slot had ever fired on its own schedule and
delivered anything** — today's `11:00` row in `ScrapeRun` started at 11:40, which was
catch-up-on-boot, not cron. A temporary `14:00` slot was added, fired on time, and
sent; a `14:15` net slot correctly sent nothing because the lifetime ceiling was
reached. Both slots were removed afterwards — a test slot is not a chosen cadence.

Four cron slots then fired on schedule the same afternoon — 14:00, 14:15, 15:00, 17:00,
each at `:00` exactly — so "the scheduler fires" is now observed repeatedly rather than
once. Only the 14:00 one had anything eligible to send.

That send needed **no guard loosened**. Both reachable pairs were inside their 7-day
cooldown, and cooldown was not even the binding rule: `@bollywoodchronicle` and
`@priyanshu123321123` are `passthrough` targets whose posts are all `UNCLASSIFIED`,
so `unusedCampaignCount` is 0 and `NO_NEW_MATERIAL` blocks every *follow-up* to them
regardless of spacing. Only `@madovermarketing_mom` has fresh `CAMPAIGN` material,
and it is a real prospect. So the clean path was a **first touch**
(`touchesSoFar = 0`), which skips the new-material rule by construction: a new
rehearsal target `@bollywoodsocietyy` — an account we own, therefore safe under
`safeTargetIds()` — with a pair created deliberately enabled.

Verified independently afterwards with `pnpm ig:thread`, on a fresh navigation: the
message came back from Instagram's own store, rendered, not from a `<script>` payload
and not from optimistic UI.

Read that as **the mechanism works**, not **the approach is validated**. Three sends
from a throwaway account prove the paste, the composer read-back, the thread
confirmation, the delivery gates, the lifetime ceiling and now the schedule. They say
nothing about a 2-4 week soak on an aged account, which remains the outstanding
recommendation and the reason the first send from a revenue account is still the real
test.

### Replies are detected now, and that guard had never once fired

`OutreachAttempt.repliedAt` was **read in six places and written in none**. The
governor's hardest stop — `TARGET_REPLIED`, which halts *every* sender to a target
the moment a human answers — was wired to a field no code path could set. Status
`REPLIED` was likewise never assigned anywhere.

This is the project's signature failure in its purest form. The negative direction
worked perfectly: no reply → `null` → proceed. Six call sites read the field, so it
looked thoroughly plumbed. Nobody tested the positive direction because there was no
way to produce it. **A guard nobody can trigger is not a guard**, and it reads as
healthy precisely because the common path is the one that works.

The cost was specific: someone answers a pitch, and the agent keeps firing cold
follow-ups into a live conversation from up to three accounts — the exact "repeated
unwanted contact" Meta's policy penalises, aimed at the one person who engaged.

Two commands now write it:

- `pnpm ig:reply <sender> <target> [--at <ISO>]` — record it by hand. Re-running with
  `--at` *corrects* the timestamp, because the common case is recording "now" and
  learning the real time later; without that the approximation would be permanent.
- `pnpm ig:thread <sender> <target> [--record-reply]` — open the real conversation,
  read it back, and classify each message as ours or theirs.

Verified in **both** directions against live threads: `@bollywoodsocietyy` (no reply)
reads as one `[US ]` message and reports none; `@bollywoodchronicle` (which had
replied `"Hi"`, and we had never noticed) reads `[US ]` + `[THEM]` and reports the
reply. Recording it then produced `target-replied` from the governor — the first time
that stop has ever executed.

**A reply is not an opt-out.** `optedOut` means "never contact again" and is used for
retirement; a reply is the outcome we *want*. It stops automated outreach so a human
can take over. Conflating them would file every interested prospect under do-not-contact.

**Replies are now checked automatically, twice a day.** `src/outreach/replyCheck.ts`
runs inside the 11:00 and 20:00 slots, before delivery — discovering a reply *after*
this slot has already sent into the conversation would make the check worthless for
the one message it most needed to stop.

The volume question CLAUDE.md was weighing is still respected: **two slots, not four**, a
10-hour minimum between checks on the same conversation, and at most four browser sessions
per run so a backlog cannot become a burst. `pnpm ig:replies` runs the identical function
on demand — one implementation, two callers.

### The sweep cannot scale, so the check moved to the send (Phase 6)

The sweep's capacity is a **constant** — four conversations twice a day — and the number of
conversations is not. At the planned size, 60 open conversations against 8 checks a day is
a mean staleness of **7.5 days**, while the dispatcher sends every twenty minutes. The
hardest stop in the system would still be there, reading data nobody had refreshed in a
week. And it degrades **silently**: "no reply recorded" looks identical whether the thread
was read yesterday or never.

Raising the cap is the obvious move and the wrong one — it buys coverage of conversations
nobody is about to write to, in unattended browser sessions against revenue accounts.

So `ensureConversationChecked` runs **immediately before a follow-up is delivered**, on
exactly the thread that message would land in. Its cost is proportional to messages SENT,
which the dispatcher already paces, rather than to prospects held — so coverage of what
matters is total at any fleet size.

- **First touches are exempt**, and not as a shortcut: there is no conversation to read,
  and `openAndReadThread` on a never-messaged profile is indistinguishable from an
  unreadable thread, so a fail-closed guard would refuse every first touch forever.
- **Skipped when this pair's thread was read within `REPLY_FRESHNESS_HOURS` (24).**

#### And a JITTER decided whether the read saw the conversation

Found 2026-08-05 while pruning a profile and re-reading a thread to check the session had
survived. **Two consecutive reads of the same conversation returned "1 message, no reply"
and then "6 messages, they replied twice."** The truth was two replies.

Instrumenting the live page explained it completely:

```
t+1528ms   composer visible, all six bubbles present in the DOM
t+2528ms   the DOM RESTRUCTURES; exactly ONE bubble still matches the selector
ever after one bubble. Scrolling recovers nothing — scrollTop is already 0.
```

`openAndReadThread` slept `jitter(2000, 3500)` before reading, so the read landed either
side of that boundary **depending on a random number**. The losing side is the silent,
permissive one: a thread showing only our own newest message reports "no reply",
`replyCheckedAt` is stamped as **verified silence**, and the next follow-up fires into a
live conversation — the "repeated unwanted contact" this guard exists to prevent, aimed at
the one person who engaged.

Note the shape, because `unreadable` was carefully designed against and this walked round
it: **the read did not fail. It succeeded and returned a truthful subset.**

Two independent fixes, because a fix that depends on winning a race is not a fix:

- **Observe DURING the dwell** instead of sleeping through it. Same wall-clock pause — the
  behavioural property is not traded away — but the window where the data exists is no
  longer discarded. A `MutationObserver`, not polling: it catches a node that appears and is
  removed between two samples, which is exactly this failure, and costs two CDP round-trips
  instead of a dozen.
- **CHECK completeness.** We know which bodies we delivered to this pair, so a read that
  cannot find them all has provably not seen the conversation and must not vouch for
  silence. Counted per body, never by comparing lengths — Instagram can group two of our
  messages into one bubble, and a length check would then be satisfied by bubbles that are
  not ours, including the reply.

`incomplete` is a **distinct outcome from `unreadable`** all the way to the dashboard. Both
hold and neither stamps `replyCheckedAt`, so the safety behaviour is identical; what differs
is what an operator should do about it.

Three things found on the way, each worth more than the original bug:

1. `ensureConversationChecked` ended with a bare `return { ok: true }` for anything it had
   not explicitly handled, so adding `incomplete` made an incomplete read **permit** the
   send. Fail-open, no type error, because a fall-through return is valid code. It is now
   exhaustive with a `never` binding, which turns "a new outcome quietly permits a send"
   into a compile error.
2. **`src/scripts/thread.ts` had a full private copy** of `readMessages`, `firstVisible`,
   `browseBriefly` and `jitter`, while `readThread.ts`'s own docblock claimed *"one
   implementation, two callers"*. The extraction happened and the CLI was never switched
   over. Left alone, this fix would have landed in the scheduled check and NOT in the
   command a person runs to verify it by hand.
3. Deduplication is on **raw** text, not normalised: normalising merged a reply of "Hi" and
   a later "hi" into one bubble.
- **Fails closed.** Unreadable, no session, or a checkpoint all HOLD the send.
- Runs **before** the SENDING claim and any reservation, so a hold leaves nothing to
  unwind, and the gate is re-asked afterwards if a thread was actually opened — that read
  can RECORD a reply, and the earlier verdict predates it.

**A check covers one THREAD, not one inbox — a correction.** The sweep checked once per
TARGET and skipped every other sender, on the reasoning that "three senders to one channel
is one inbox — triple the exposure for the same fact". The premise is true from the
recipient's side and the conclusion does not follow: **Instagram DMs are per account
PAIR.** A session logged in as `@a` can only read `@a`'s thread, so a reply sent to `@b`
was invisible to a check through `@a` — which then stamped `replyCheckedAt` and recorded
**verified silence**. That is "unreadable becomes no-reply" wearing a different hat, and
rotation makes it the normal case, since spreading senders across one recipient is the
entire point.

Deduplication is now per pair. The cap is unchanged, so this costs no extra browser
sessions — it changes WHICH conversations the same budget reads. (Stated as structural
reasoning about Instagram DMs, not as something measured here.) The HALT stays per target:
a reply to any sender stops them all.

**A limited budget is spent on what matters.** `prioritiseConversations` (pure, tested)
orders pairs with a draft waiting first, then never-read, then stalest. The old ordering
was oldest-first — fairness, which is the wrong criterion for a safety guard: the
conversation where a missed reply does real damage is the one about to be written into
again.

**And the degradation is visible.** `deferred` is returned and reported rather than logged
and forgotten, and `replyCoverage` puts open / never-read / stale on `/messages`. A number
that falls quietly as the fleet grows is exactly what this project keeps finding late.

An unreadable thread is recorded as **unreadable, never as "no reply"**, and
`replyCheckedAt` is deliberately NOT stamped in that case: "we looked and can vouch
for the silence" and "we could not read it" are different facts, and collapsing them
would let a DOM change silently disable the hardest guard in the system. A checkpoint
during a read marks the account CHALLENGED and stops the whole run — reading is lower
risk than sending, but it is the same account and the same enforcement surface.

**Only messages we have not already recorded count as a reply.** A thread holds the
whole conversation, so `theirs.length > 0` is true forever once anyone answers once.
The first version recorded on that alone, which meant every subsequent check
re-detected the SAME old message as fresh — re-halting outreach seconds after an
operator pressed "I have replied", making that button useless and the halt
inescapable all over again. Replies are compared on normalised text against every
reply already stored for that target, **handled ones included**: the point of handling
one is that it stops counting, and dropping it from the comparison would resurrect it.
A reply recorded before `replyText` existed carries no text and cannot be compared, so
the first read that sees the thread **backfills it and records nothing new** — self
-healing, and the safe direction, since the existing halt is left untouched.

**Reply checking never runs on the `manual` slot.** The dashboard's "Check now" button
calls `runSlot('manual')`, so including it would have opened up to four Chrome windows
and driven Instagram for minutes when someone pressed a button labelled *check the
channels*. A control must do what its label says. Reply checking is reachable
deliberately — `pnpm ig:replies` — or on its own schedule.

**THE REPLY HALT RELEASES ITSELF AFTER ONE DAY (2026-08-07, Tabish's decision).** The
manual-release requirement below is HISTORY — kept because it explains the shape. Tabish
asked to remove the manual step; the risk was stated to him plainly (an automated
follow-up resuming into a conversation a human answered is the "repeated unwanted
contact" pattern, aimed at the one prospect who engaged) and he chose auto-resume after
1 day. Recorded as his. Mechanics: `replyResumeHours` Setting (default 24),
`src/outreach/replyHalt.ts` is the ONE place the window lives (`replyHaltFloor` for
query sites, `replyHaltActive` for rows in hand), and every halt site uses it — gate,
planner, on-demand warning, nav badge, replies card, /targets chip — so the UI never
claims a halt the gate is not enforcing. "I have replied" survives as an EARLY release.
A newer reply re-arms the window from its own timestamp, so an actively-replying
prospect keeps deferring. `TARGET_OPTED_OUT` is checked before `TARGET_REPLIED` and
still refuses forever — retirement is the promise that survives every feature. The old
behaviour is one Setting row away: any very large `replyResumeHours`.

**A reply can now be released.** It halts every sender to that target, which is right,
but nothing could ever clear it: the first reply retired a channel permanently, the
dashboard nagged forever with no control to dismiss, and the only exit was editing the
database. **A hard stop with no release is a bug wearing a safety feature's clothes.**
`replyHandledAt` records that a person took over; `repliedAt`, `replyText` and status
`REPLIED` all survive, because handling a reply is not erasing it. Every reply-halt
query is scoped `replyHandledAt: null` — verified in both directions, halting before
and releasing after, with the record intact.

Reply text lives in `replyText`. It was previously read out of `error` — a column for
send failures — because no field for reply content existed, so a message that failed
and was later marked replied would have displayed its own error string as the
recipient's words.

### Sending on demand, and the only stops a person may cross

Added 2026-08-03. **Send a message now** on the dashboard: pick an account, pick a
channel, it writes the message, shows it, and sends it on a second click.

The scheduled path exists so nobody has to think about spacing, and most of the time its
answer is *not yet*. This is the other case — someone knows something the agent does not
— and it deliberately does not ask what that reason is. What it does instead is name,
in a sentence each, every rule about to be crossed. **It removes no guard; it moves the
decision to a human and makes sure the human is told what they are deciding.**

Two lists, and the split is the whole safety argument:

- **Warnings** are shown, acknowledged with a checkbox, and crossed: spacing, nothing
  new to say, a draft already waiting, the unanswered-touch cap, the lifetime ceiling,
  the route being off — and **they replied**, which Tabish chose deliberately on
  2026-08-03 so the button can reach someone mid-conversation. That last one is the
  riskiest thing here, so the dialog shows the reply and how long ago it was rather than
  a generic "are you sure".
- **Blocks** refuse outright with no dialog offered: Instagram has flagged the account,
  the channel is retired (`optedOut`), the account is not connected, either daily cap is
  spent, contact details are invalid, or it is trying to message itself.

The two BRAND-only guards (`brandGuards.ts` — the new-brand daily cap and the persona
gate) sit in the planner, not in `gate.ts`, and are therefore **not** overridable from the
on-demand dialog. That is deliberate: the persona gate is about the message being wrong for
its recipient rather than about timing, so "I know something the agent does not" is not an
argument that applies to it. Give the account its own persona instead.

`OVERRIDABLE_BLOCKS` in `gate.ts` is a **closed whitelist**, and overrides are applied by
membership in it — never by trusting the caller's strings. A server action is reachable
by anything that can reach the page, so passing `['sender-not-active']` must be inert,
and there is a test per absolute stop asserting exactly that. Overrides are also dropped
entirely when `unattended` — autopilot has no human to have acknowledged anything, so an
override arriving with it is a bug upstream and fails closed.

Daily caps are **not** crossable and that is deliberate: crossing cooldown sends one
extra message to one person, crossing a daily cap has no bound at all — the difference
between a considered follow-up and a stuck button.

Preparing is not sending. `prepareOnDemandSend` writes a real `OutreachAttempt` in READY
and returns it; delivery needs a second call to `sendNow` carrying the acknowledged
codes. A draft the operator abandons is an ordinary waiting message with the usual Send
and Discard beside it, so there is no half-created state. An overridden send records
`sentBy: override(<codes>):<handle>` — months later that string is the only record of
why, and it must never read like the system decided it was fine.

### Editing a drafted message

Allowed while `READY`/`QUEUED`, never once `SENDING` (a browser is typing it) or
`SENT` (the recipient has it, and editing the record would make the audit trail
describe a message nobody received). The stored body is the single source of truth
downstream — the composer read-back compares against exactly it — so an edit is
carried through the send guard without that guard needing to know editing exists.

### The database is `journal_mode = delete`, and WAL is the wrong fix

**Measured and reverted 2026-08-04.** Phase 0 switched to WAL to reduce `SQLITE_BUSY`, on
the reasoning that a contended write could roll back the transaction recording a DELIVERED
message and leave the recipient holding a DM our records said we never sent. WAL did fix
that contention. It also broke something worse:

> A long-lived process pins a WAL read snapshot at its FIRST query and never releases it.
> Writes made by ANOTHER process after that moment are invisible to it until it restarts.

Reproduced repeatedly and confirmed against a falsifiable prediction: restart the
dashboard, make five external writes, read them back — #1 visible, #2-#5 not. Restart,
make three writes *before* the first query — all three visible, the next one not.
Identical through the plain `sqlite3` CLI, so it is not this codebase's doing; WAL merely
exposes it, because a rollback-journal reader takes a fresh shared lock per read and
therefore always sees the latest commit. In `delete` mode, 5/5 visible.

**Three processes share this file by design** — the dashboard, the scheduler embedded in
it, and any CLI script. Under WAL the worker never saw an account marked CHALLENGED from
the dashboard: the exact Phase 0 guard that re-reads live sender status before driving a
browser. **A guard reading a frozen snapshot is this project's signature failure arriving
through the storage engine.** Between "a write may contend and retry" and "a guard silently
reads the past", the second is far worse.

The symptom that led there is worth knowing: under WAL the server began returning
`SQLITE_CORRUPT: database disk image is malformed` on ordinary reads while
`integrity_check`, `quick_check` and `foreign_key_check` on the file were all clean with
every row present. **Corruption reported by one connection against a healthy file means
the connection's view, not the data.**

The double-send risk WAL was bought for is handled structurally instead:
`src/outreach/recordSend.ts` commits the SENT row ALONE, retries it, and never returns an
attempt to READY when delivery cannot be ruled out. WAL was the belt; that is the braces,
and the braces are what hold.

**If WAL is ever reconsidered** it is only safe once every long-lived process is proven to
see another process's writes. Run the experiment above first.

**Never run `ANALYZE` at process start.** It was added in Phase 1 and removed in the same
commit: it made every CLI script write to the database just to boot, and on a WAL database
the closing connection can truncate the `-wal` file underneath another process's reader.
`refreshStatistics()` in `src/lib/db.ts` runs it deliberately, after a bulk import or a
migration.

### The profile directory is a credential file, and normal Chrome destroys it

Two facts verified 2026-07-30 against the live process, both counter-intuitive:

Patchright hardcodes `--use-mock-keychain --password-store=basic` and `launchProfile`
cannot opt out without `ignoreDefaultArgs`. So Chrome's cookie-encryption key is a
**public constant**, not a macOS Keychain entry.

1. **Never open one of these profiles with ordinary Chrome.** Plain Chrome derives its
   key from the Keychain, cannot decrypt these cookies, and **deletes the rows it
   cannot read** — taking `mid`, `datr` and `ig_did` with them. That destroys the
   device identity the whole design exists to preserve, so the next login looks like
   new hardware to Instagram: the precise state we are avoiding. Measured on throwaway
   profiles; returning to Patchright does not recover it. Opening the profile by hand
   is the natural reflex when something looks wrong, which is exactly why this has to
   be written down. If a manual launch is unavoidable it must carry the same flags:
   `--user-data-dir=<profile> --password-store=basic --use-mock-keychain`.
2. **`~/.ds-sales-agent` is as sensitive as a password file.** The key is a constant
   and not machine-bound, so anyone with a copy of the directory can decrypt the
   session cookies offline. Backups, cloud-synced folders, screen shares all count.

   **AND SINCE 2026-08-08 IT CONTAINS NOTHING ELSE, which is what makes that rule
   followable.** Two non-secret things had accumulated inside it: post cover frames
   (public CDN images, 321 files) and the Swift OCR binary this repo compiles itself.
   Neither is a credential, and both are things a future feature wants to touch casually —
   a contact-sheet UI, a support bundle, an `rsync` to the server. Every one of those is
   safe for frames and catastrophic for profiles, and while they shared a parent the
   difference depended on whoever wrote that feature remembering it.

   `src/lib/paths.ts` is now the one place that split lives: **`~/.ds-sales-agent` is
   credentials ONLY** (chrome-profiles, identity-backups) and **`~/.ds-sales-agent-data`**
   is everything else (frames, bin, logs). A SIBLING directory, not a subdirectory, so the
   two are separable by a glob or a backup rule. Same reasoning as `middleware.ts` listing
   public routes and the pruner deleting from an allowlist: make the dangerous set small,
   explicit, and impossible to widen by accident.

   **AND THEY CAME BACK, because a moved directory is not a moved PROCESS.** Frames
   reappeared in the credential directory between 11:30 and 12:15 — after the migration —
   because the running worker still held the old `FRAMES_ROOT` in memory. Node caches
   modules at require time; moving files and editing a constant does nothing to a process
   that is already up. They stopped the moment the agent was restarted (0 files written
   since), which is the same lesson as the OCR fix on the server: **build, restart, and
   verify the restart happened.**

   Removing the strays found the other half of it. A filename comparison said all 93 were
   duplicated in the data directory and nothing would be lost. **A HASH comparison found 3
   that differed** — the same posts re-fetched later, and Instagram's CDN returns a
   slightly different JPEG each time. Both encodings OCR to the same words, so nothing was
   lost either way, but the filename check would have been a deletion justified by a claim
   that was measurably false. Backed up before deleting, then removed.

   `pnpm ig:migrate-data` moved them — dry run by default, copy then verify then unlink.
   **FOUND BY RUNNING IT:** the first version hash-verified all 322 files, reported success,
   and the Swift binary landed **mode 644** because `writeFile` creates a new file and
   SHA-256 cannot see a mode bit. Bytes perfect, file unrunnable, `ig:ocr` immediately
   reported "could not be read" on the founding case. **The check was not wrong, it was
   INCOMPLETE — it verified the property I thought to verify.** Mode is now copied and
   compared. Ask what a check would MISS, not whether it passes.

### "Log in once" is true; "log in once, ever" is not

Verified: persistent cookies survive close/relaunch of a Patchright profile with
expiries intact, and device cookies come back byte-identical, so there is no
per-send or per-week re-login. The design works.

But nobody has measured how long an authenticated Instagram *web* session survives.
The only primary observation found was `sessionid` with `Max-Age=31536000` (1 year)
from a 2020 hobby repo; the "corroborating" source turned out to be a commented-out
placeholder. Cookies on disk are capped at 400 days by Chrome regardless. And a
cookie surviving on disk is **not** the same claim as Instagram still honouring it —
revocation is server-side and invisible until a request is made.

So: log in once per account now, expect to do it again occasionally, and rely on the
system to say so rather than on a promise. `hasSession` is the honest gate.

### A model may write the body, and a gate decides whether anyone may send it (Phase 8)

Built 2026-08-05, **switched OFF** (`generateMessages`, default false). With it off,
`composeForPair` behaves byte-for-byte as before. Phase 3 shipped the same way: a change to
what a real prospect reads should be switched on by a person on a day they chose.

**The reason it is off is not the money.** Measured across 7 real calls,
**$0.000045-$0.000138 a message** — under $10/year at 65 senders × 60 recipients, and the
prompt cache holds at **95-98%**. The reason is stated below.

`src/outreach/generate.ts` — `deepseek-v4-flash`, `thinking: { type: 'disabled' }`, and the
**system prompt is a module-level constant with nothing interpolated into it, ever**. The
cache discount is 50× and destroying it is silent and permanent. Per-recipient facts go in
the user message.

`src/outreach/qualityGate.ts` is PURE and every bound in it was **measured** against the 25
bodies that already ship, not chosen: 348-1031 chars, 3-4 paragraphs, 25 of 25 with a needle,
0 cross-matching. The first test is that all 25 pass — *a gate no good copy can satisfy is an
outage wearing caution's clothes.*

It checks: no placeholder survived **rendering** (not the middle — `{{brand}}` is legitimate
there), length and shape, the persona block exactly ours and appearing exactly once, the
greeting the one `buildGreeting` would produce, no chat preamble, every figure claimed one we
actually claim, and the body verifiable by `distinctiveSlice` **including that its needle does
not match a message this recipient already has**.

**WHAT READING THE REAL OUTPUT FOUND, three times, none of it caught by a test:**

1. **Figures spelled in WORDS bypassed the entire allowlist.** Every rule matched digits, so
   "eighty million followers", "five hundred pages", "two billion views a day" and "fifty
   crore views" all passed the check that exists to stop exactly them. Verified by execution
   before and after. What made it visible was a harmless "under fifteen minutes".
2. **An invented claim about the RECIPIENT.** Told to reference nothing, the model told Royal
   Canin *"your team already buys placement across pet-focused pages and lifestyle feeds"*.
   The prompt already forbade guessing; it guessed anyway. Two fixes — a prior-knowledge
   phrase check that only fires when there is no observation, and the better half: actually
   *giving* it one, since `discoveredFromCampaignId` records the paid post that made a brand a
   prospect and the generator was ignoring what `brandPitch` already used.
3. **An invented claim about US.** *"We run a network of owned pages in the pet and general
   interest space"* — to a pet-food brand, from a Bollywood network. And audience data we do
   not have: *"the audience skews young, urban and highly engaged"*.

**The third category is not mechanically checkable and that is the honest conclusion of this
phase.** The figures are guarded because they are enumerable; what the network IS is not.
There is no accuracy harness for generation the way `pnpm ig:accuracy` exists for
classification. So the gate is a **floor**, `pnpm ig:generate` prints the whole message rather
than a verdict, and turning `generateMessages` on without a person reading messages is not
something this work justifies.

`observationFor` is exported and shared by the planner and the CLI — the first version left
`ig:generate` with its own copy, so the command whose entire job is showing what the planner
would produce showed something else.

### 61 accounts arrive as a LADDER, and the ladder is code (Phase 9)

Built 2026-08-05. **No account was added.** This is the only phase that changes exposure: 4
sending accounts become 65, and each of the 61 needs a hand login writing device identity
that cannot be rebuilt.

The risk is not per-account — at 65 each sends 0.27 messages a day against a
practitioner-safe 20-35. It is that **all 65 drive one code path from one residential IP
against overlapping recipients**, a correlation surface that does not exist today. Rotation
hides volume from *our* metrics while the recipient's inbox is unchanged.

`SenderAccount.cohort` is the **only stored column**; how long a group has been sending and
whether anything went wrong is DERIVED from `OutreachAttempt` and `challengedAt`, following
Phase 3's decision that state comes from history rather than a cursor.

Four rules in `src/outreach/cohorts.ts` (PURE), each answering a different question:

- **Group 1 is the BASELINE and always passes.** Those accounts predate the ladder and one has
  done every send this project has made.
- **The previous group must be LIVE** — connected AND active. Otherwise a step is skipped by
  leaving it empty. This read `autoSendEnabled && hasSession && status === 'ACTIVE'` until
  2026-08-08; the arming bit is gone and **leaving it would have made `live` permanently
  ZERO**, freezing the ladder at group 1 with no way to clear a step. That is a
  strengthening: an armed account with a dead session cannot send and counted as live,
  while a signed-in healthy account nobody had flipped counted as dead.
- **It must have SENT something.** Never-delivered has not been observed at all, and without
  this thirteen steps could be climbed in a fortnight. Same "freshness is not liveness"
  mistake as reading a heartbeat's age. **This rule now carries the whole evidential
  weight**, which is where it always belonged — arming was a statement of intent, a
  delivered message is what was observed.
- **Nothing in ANY earlier group may have been questioned.** `ever`, not `currently`: a
  cleared checkpoint still happened and is evidence about the pattern. Clearing a halt lets
  that account send again; it must not buy permission to add five more. Checked FIRST so the
  sentence a person reads names the real problem.

**FOUND BY RUNNING IT:** the live database reported *"next new account joins cohort 1"*. Group
1 had 4 of 5 places free — and group 1 is the baseline, exempt from the soak. **The first
account of the 61-account expansion would have been armable the moment it was logged in**,
bypassing the whole mechanism built to stage it. Room in the baseline is not room on the
ladder; new accounts start at 2.

**Since 2026-08-08 it is enforced in exactly ONE place, and that place is the send path.**
It used to hold at both ends — the dashboard refused to arm a blocked group, and `gate.ts`
re-asked at delivery so editing `autoSendEnabled` in the database could not get round it.
Arming is gone, so the arming end went with it and `gate.ts:414` →
`RESEND_BLOCKS.COHORT_NOT_CLEARED` is now the **only** thing standing between an un-soaked
group and an unattended send. `mayArmAccount` therefore **must not be deleted on the
strength of its name** — an earlier version of the one-switch plan said to, on the reasoning
that its only caller was the deleted action, and the cohort tests would all have carried on
passing because they exercise the pure function and not the caller. Not overridable — every
stop a human may cross is about timing, this one is about how many accounts are at risk at
once. Turning Autopilot OFF is always allowed; a stop must never need permission.

The soak is **14 days, and that is a floor chosen rather than measured** — the standing
recommendation is a 2-4 week soak before touching the revenue accounts and it has never been
done. Both it and the group size are `Setting` rows, like `fleetMaxPerDay`.

Operator-facing strings say **"group", never "cohort"**, matching the page heading, with a
test asserting the word never appears.

### The disk fills before the fleet finishes onboarding

Measured 2026-08-05, and it had moved since the plan: free disk **32 GB → 26 GB**, and the
sending profile **604 MB → 685 MB in a day containing ZERO sends**. The growth was
reply-check browser sessions — and Phase 6 made those run before every follow-up, so **cache
growth is now proportional to messages sent**, which is what scales with the fleet. One
thread read alone added 37 MB.

`pnpm ig:prune`. **88% of a profile is disposable cache; the irreplaceable part is 27 KB**
(`Default/Cookies` — `mid`, `datr`, `ig_did` — plus `Local State`). Run once: **627 MB freed,
794.8 MB → 167.2 MB**, both protected files byte-identical by SHA-256, and the session then
verified **against Instagram** by reading a real thread — because a cookie on disk is not the
same claim as Instagram honouring it.

Projection printed by the command itself: at 65 profiles, **44.7 GB unpruned → 5.4 GB
pruned** against 26 GB free.

Three things about it are load-bearing:

- **The deletable set is an ALLOWLIST** — `Default/Cache`, `Default/Code Cache`,
  `Default/GPUCache`, and nothing else, ever. A denylist of protected paths fails in the
  dangerous direction the day Chrome invents a directory, which is exactly why
  `src/middleware.ts` lists public routes rather than private ones. 79 MB more per profile
  sits in top-level caches and is deliberately left alone.
- **"Is Chrome closed?" asks the OS**, matching `--user-data-dir=<dir>` in a live process's
  argv. Not `SingletonLock`, which survives a crash. The first version matched the path plus
  the word "chrome" anywhere and **matched my own mutation-testing shell command** — a false
  positive, so the safe direction, but it proved the matcher was never testing the right
  thing. Both "a browser has it" and "we could not tell" refuse.
- **The 27 KB is backed up before anything is deleted and verified by hash afterwards.**
  "This does not touch the cookies" is a claim; a hash is evidence. Mutation testing then
  showed the verification could be replaced with a constant `true` and break no test — it is
  now a pure function driven to fail.

### Being worth messaging and being worth READING are separate decisions

Phase 7, 2026-08-05. `TargetAccount.watchEnabled`.

Detection reads every `kind: 'CHANNEL'` target, four pages per slot. At four channels that
is 16 requests a slot and it has been measured healthy (48/48 HTTP 200, median 1090 ms). A
provided list of 60 prospects makes it ~240 a slot and about **a thousand a day** against
an anonymous, undocumented endpoint whose only risk is IP rate limiting — and it buys
almost nothing, because a cold **first touch does not use a hook from the recipient's own
feed**.

So watching is now its own toggle. It **defaults true**, so every channel that was being
read still is; imported prospects arrive unwatched, and so do brands the resolver
discovers — set `watchEnabled: false` explicitly against a schema default of TRUE, or
every auto-discovered prospect would enrol itself into detection. `/targets` shows what
watching currently costs in requests per slot, because that number is otherwise invisible
— which is exactly how a 60-row list quietly becomes a thousand requests a day.

**This is the one toggle the one-switch change did NOT remove, and the distinction is the
section heading.** Watching is a question about spending requests against an anonymous
endpoint; messaging is a question about a stranger's inbox. Autopilot decides the second.

**Importing a list.** `pnpm ig:import <file>` or the form on `/prospects`. Parsing is pure
and forgiving about format — a bare list, a header row in several spellings, tabs or
commas or semicolons, quoted fields, CRLF, an Excel BOM, a pasted profile URL, duplicates
under different capitalisation. It is **completely unforgiving about the handle**: an
unparseable one is rejected WITH ITS LINE NUMBER and never repaired, because "never guess a
handle" has a measurement behind it and a typo deserves the same treatment as a guess.

Dry run by default, like `ig:classify` and `ig:brands`. The preview checks every handle
against Instagram, so it is the real answer rather than an optimistic one. Rows past the
limit are **reported, never silently truncated**. Created targets are unwatched, are never
self-paired, and never routed from one of our own pages — the rule for that is
`src/outreach/routes.ts` and every creator asks it.

**Their routes are LIVE, and "adding is never the same act as sending" changed meaning on
2026-08-08.** It used to be kept by creating pairs DISABLED, so importing sixty prospects
was inert until somebody flipped sixty chips. With the chips gone a pair row IS a live
route, so what keeps the promise is the *dry run* and the *import itself being a deliberate
act* — not a downstream switch. Anything that imports or discovers a target now widens what
the rotation will write to, and the copy on the import form was corrected the same day: it
had gone on saying *"every route is switched off … turn on what you want"*, which
**overstated safety about the one act that now reaches a real prospect**.

**`/targets` is not the channels card grown larger** (it absorbed `/prospects` in the
2026-08-06 redesign). That card rendered a chip per sender×target route: twenty then,
**3,900** at 65×60. That was not a layout problem, it was the wrong control — nobody
decides 3,900 routes one at a time, which is a large part of why Tabish asked for the
switches to go. Each row now reads *"Messaged automatically by rotation while Autopilot is
on (N accounts able to send)"*, and **`sendersAble` is ABILITY**: it reads zero when the
fleet is signed out even with the switch on, which is the honest answer to "will anything
happen here?" that a wall of chips buried and that a bare route count would have faked.

### Accounts and channels are managed from the dashboard, not the terminal

The terminal flow still exists and still works, but it is the developer path. The
person running this day to day should never need a shell, so the dashboard owns:

- **Connect / Reconnect** an account — opens that account's own Chrome window and
  polls until Instagram reports the login. Identical to `pnpm ig:login` underneath;
  only "are you done yet?" changed, from a readline prompt to a poll.
- **Add / Remove** a sending account, **Add / Remove** a channel. The per-route chip is
  GONE (2026-08-08, one switch), and so are `setAccountAutopilot`, `setPairEnabled`,
  `confirmBrand` and `dismissBrandCandidate` — 29 server actions became 25.

Two rules the UI must keep:

1. **Adding is never the same act as sending — but the mechanism changed, and the new one
   is thinner.** New senders and new channels used to get their pairs created **disabled**,
   so adding a channel to see what it looks like could not message it under any
   circumstance. Routes are now created live, so what stands between adding and sending is
   the Autopilot switch, the caps, the cooldown and the cohort ladder — real rules, but a
   *shared* brake rather than a per-row one. **Say this plainly to anyone adding a channel;
   do not restate the old sentence, which is now false.** Four pieces of copy still claimed
   it on 2026-08-08 (`addTarget`, `addSender`, the import form, the channels card) and all
   four were corrected: they named a deleted chip AND implied adding was inert.
2. **Removal never deletes send history.** Attempts record what real people were
   actually sent, and spacing, the unanswered-touch cap and the new-material rule are
   all derived from that. Deleting it would let the system write to someone it has
   already written to. So anything with send history is *retired* — the target marked
   `optedOut`, which is a hard stop the governor checks independently and `gate.ts` checks
   again at delivery — and only a never-used account or channel is deleted outright. The
   Chrome profile is left on disk either way: it holds device identity that cannot be
   rebuilt.

   **Retirement was NEVER a missing pair row and that now matters much more.**
   `ensureFleetPairs` recreates every allowed route at the top of each pass, so a promise
   carried by a deleted row would survive exactly one run. It is a flag on the TARGET for
   precisely this reason, and `routes.ts` refuses an `optedOut` target as housekeeping on
   top — never as the promise itself.

`connect.ts` keeps open browser contexts in a module-level Map, which is correct for
one local Node process and would not survive a multi-process deployment or a dev-server
hot reload. Both cases fail visibly ("no connection in progress"), never silently.

New channels get the `passthrough` detector. `mom` is a hand-written rule set for one
publisher's `#Collaboration` convention; applying it to an arbitrary channel would
silently mislabel posts.

### Credentials

**Nothing in this repo stores, reads, or transmits an INSTAGRAM password.** There is
no field for one. Detection is anonymous; sending uses a browser profile you logged
into yourself. A login prompt therefore always means the browser lacks a session,
never that the agent lost one.

That sentence used to read "…stores a password" without the qualifier, and since
2026-08-03 the qualifier is load-bearing: the **dashboard** has its own accounts, and
a dashboard password is stored as a scrypt hash. The two are unrelated, and conflating
them would be an argument for leaving the send button unauthenticated.

All Instagram URLs are built in one place, `src/lib/urls.ts`, because the CLI and
the dashboard drifted apart once — the dashboard used `ig.me/m/<handle>`, which
returns **HTTP 400** on desktop web and so never worked at all.

### The dashboard has a front door now, and registration is deliberately open

Added 2026-08-03. Before it, there was **no `middleware.ts` and 18 exported server
actions** — `sendNow`, `setAutopilot`, `connectAccount`, `removeSender`, `removeTarget`.
A server action is reachable by anything that can reach the page, so every one of those
was callable with no password by any client that could open the port.

- `src/middleware.ts` is **deny-by-default**: it lists PUBLIC paths (`/sign-in`,
  `/sign-up`, static assets) and protects everything else. A list of *protected* paths
  fails in the dangerous direction — a route added later would be exposed until someone
  remembered it, which is exactly how 18 actions ended up with nothing in front of them.
  The routing decision is a pure function, `decideRoute`, tested in both directions.
- **Every action also calls `requireUser()` as its first statement**, before arguments
  are read or anything is written. Not redundant: middleware is a router filter and an
  action is a POST endpoint. Several actions mutate then audit, so a check deferred into
  `audit()` would let the mutation land and fail afterwards.
- An unauthenticated **POST gets a bare 401, never a redirect.** Redirecting would hand
  the client a 200 for the login page, which reads as success — a refused mutation must
  never look like a completed one.
- Passwords are **scrypt** from `node:crypto` (N=65536), not bcrypt or argon2, because
  both are native: `serverExternalPackages` exists precisely because native bindings
  break this build, and the same code must run in the Next bundle *and* under `tsx`.
  Cost parameters are stored in the hash, so raising them later cannot lock anyone out.
- Session tokens are 32 random bytes, stored **SHA-256 hashed**. A session token is a
  bearer credential exactly like Instagram's `sessionid` — the reason this project
  refuses cookie transplants applies to our own tokens, so a database read (a backup,
  `pnpm db:studio`, a screen share) must not hand over live sessions.
- `sentBy` and `AuditLog.actor` now record the **signed-in user's email**. The CLI has
  no session and writes `cli:<OPERATOR_NAME>`, prefixed so "pressed Send on the
  dashboard" and "typed y in a terminal" stay distinguishable.

**REGISTRATION IS NO LONGER OPEN, AND THERE ARE ROLES NOW — 2026-08-08.** The paragraph
below is HISTORY, kept because it explains the shape and because its final sentence was
the instruction that got followed.

> *"Registration is OPEN, and this was chosen after the exposure was stated twice. There
> is no role model: `sendNow` checks the safety gate, not who is asking… So anyone who
> registers can DM from `@madaboutmarketingg`, `@bollywoodsocietyy` and
> `@bollywoodchronicle`. What limits that today is the `127.0.0.1` bind and nothing else.
> **Before this is reachable from anywhere else, add roles** — view on signup, send on
> approval."*

Open registration was a defensible trade while **the bind WAS the access control**. Hosting
removes the bind, so the same sentence stops being a note and becomes the vulnerability.
Two independent gates now:

1. **`SIGNUP_INVITE_CODE`** (environment) to create an account at all. An **unset code means
   signup is CLOSED**, never "no gate" — a server deployed without it refuses new accounts
   rather than offering an open door onto a page with a Send button. Same hard-floor
   reasoning as `AUTOPILOT_ENABLED`: a web page must not be able to widen its own access.
2. **`User.role`** — `viewer` | `operator` (`src/lib/roles.ts`). Passing (1) grants a
   **VIEWER**, so someone handed the code still cannot send.

Both fail closed. `parseRole` maps `null`, `''`, `'admin'`, `'Operator'`, `'OPERATOR'` all
to `viewer`: `role` is a String because SQLite has no enums, so the column can hold
anything, and absence-of-data becoming a **permission** is worse than the four times this
codebase has already produced that shape without one.

**All 25 actions in `actions.ts` call `requireOperator()`** (29 until 2026-08-08, when the
four switch-writing actions were deleted — `setAccountAutopilot`, `setPairEnabled`,
`confirmBrand`, `dismissBrandCandidate`; the authorisation test passed unaltered and no
safety assertion was lowered) — every one mutates, which is
what makes the blanket rule correct rather than lazy; read-only work belongs in a view
model. It is a separate function rather than a flag on `requireUser`, because an argument
defaulting to "no role check" is one forgotten parameter away from an unprotected mutation,
and this file once exported 18 actions with nothing in front of them at all.
`tests/action-authorisation.test.ts` asserts every action is guarded, that the guard
precedes any `prisma.` call, and that none downgrades to `requireUser`.

The **FIRST account** on a deployment bootstraps as `operator`, or a fresh server has nobody
who can promote anybody — a locked door with the key inside, "solved" by editing the
database by hand. Existing users default to `viewer` on upgrade, deliberately: granting send
rights by accident of history is the same fail-open in migration clothing.

**The migration was written BY HAND.** `prisma migrate dev` found pre-existing drift in
`OutreachPair` and offered to reset the database — 1,833 posts and every send record.
Declined. The playbook's rule that production migrations are never automatic applies to a
dev database holding irreplaceable data too.

Verified against the running server, both directions: anonymous GET → 307 to `/sign-in`;
unauthenticated POST → 401; valid session → 200 with the dashboard; **expired** session
→ 307; **forged** token → 307. That last pair is what proves the downstream
`currentUser()` validation is real rather than middleware's cookie-presence check
standing in for it.

---

## Decisions that must not be quietly reversed

Each of these was researched, verified, and chosen deliberately. If you think one
is wrong, say so — but do not undo it as a side effect of another change.

### 1. Automated send is BUILT. Do not undo it, and do not loosen how it works

Automated sending exists (`src/outreach/browser/`) and manual is now a fallback, not
the mode. An earlier version of this file said "the send is never automated" — that
was a *phase* decision hardened into doctrine Tabish never chose. He stated the
sequencing twice: manual to prove it works, then automate. It is automated.

What the research actually established, verified 2026-07-30 (18 research agents;
10 of 12 load-bearing claims refuted on adversarial verification) — read this as the
list of constraints automation must satisfy, never as an argument against it:

- **Device + network identity continuity is a pass/fail gate, not a score.** A hand
  login records a login event binding (browser × account) to durable identifiers
  (`mid`, `ig_did`, `ig-u-rur`) and a residential IP. Cookie-replay into a fresh
  automation profile destroys all of it — and `sessionid` is a bearer token with
  **no channel binding**, so replay *works* right until enforcement lands silently.
  This is why we drive a hand-logged-in profile rather than importing a session, and
  it is the single load-bearing choice in the whole send path.
- **Behavioural telemetry** — pointer movement, focus changes, scroll depth, dwell
  before clicking Message — is what a person emits. Hence the deliberate scrolling
  and jittered pauses in `sendDm.ts`, which are not decoration.
- **CDP attach does not help, and stock Playwright is detectable.**
  `navigator.webdriver` is true in *every* stock Playwright configuration including
  attach, and `Runtime.enable` is emitted per-frame identically whether you launch
  or attach. Hence **Patchright**, which patches both. Do not swap it for
  `playwright`.

Requirements still in force:

- Log in **by hand**, once per account, into that account's own profile
  (`pnpm ig:login <handle>`). Never transplant a cookie.
- **Patchright**, never stock `playwright`.
- Same **home residential IP** the accounts normally use. No VPS, no VPN.
- Input only via `page.mouse` / `page.keyboard` / `locator.click()`. Never
  `evaluate(el => el.click())`, never `fill()` for the body.
- `headless: false`, always. Headless Chrome differs measurably.
- Realistic navigation: feed → scroll → profile → dwell → Message. Never deep-link
  the thread.
- **Still outstanding:** none of this has been proven on a throwaway 4th account for
  2-4 weeks before touching these three. That was the recommendation and it has not
  been done. The first real send is therefore the test, which is a genuine risk that
  was accepted rather than eliminated — say so plainly, do not paper over it.

**Wasted effort — verified refutations, do not spend time here:** TLS/JA3/JA4
fingerprinting (Playwright-driven Chrome produces JA4 identical to Chrome stable);
`X-IG-WWW-Claim` "session warmth" (real clients send `'0'` on every new tab);
browser extensions as low-signal transport (worse on telemetry, synthetic events
lack `isTrusted`); anti-detect browsers or proxies for three legitimate accounts
(converts a normal pattern into an evasion pattern).

### 2. Multiple messages per target ARE allowed — with new material

A channel that ran four paid campaigns this week gives four genuinely different
reasons to write, and the system supports that.

**Corrected 2026-07-30.** An earlier version locked each pair after one message, on
the reading that Instagram allows "one message per target, ever". That was wrong.
The actual constraint is **one message *pending*** to a non-follower — it lifts the
moment they accept. It was also built on a research claim that never went through
the adversarial verification pass, which is exactly the sort of thing that pass
exists to catch.

What actually protects the account is **the new-material rule**: every follow-up
must reference a campaign not used before for that pair. Meta's written spam policy
penalises *repetition*, not volume — so fresh material is what makes a second
message a new message rather than a repeat. That permits volume and protects the
account with one rule.

Supporting guards: per-pair spacing (`cooldownDays` — the schema column defaults to
5 but seeded pairs and `DEFAULT_COOLDOWN_DAYS` both use **7**, which is the value
actually in force), a cap on unanswered touches (`maxUnansweredTouches`, default 3 —
beyond that a pending request will not deliver anyway), and per-target/per-sender
daily caps.

**`MAX_PER_TARGET_PER_DAY` accepts `"unlimited"` and has no ceiling.** Corrected
2026-08-04: the `Setting` override is now shape-clamped (a positive whole number, or an
explicit "unlimited") with **no upper bound**, because Tabish called 1/day "laughingly
low". The effective value is **2**, from `.env`. Changing it is one `Setting` row and no
code change.

The risk is stated rather than waved away: measured, `@viralbhayani` posts **11-14 paid
posts a day**, and uncapped rotation across 65 senders puts all of that into ONE inbox from
a different page each time. **Rotation solves SENDER risk and does nothing for RECIPIENT
risk**, and a recipient's spam report is what gets accounts banned. This cap is the only
control addressing that, and it is a control we chose rather than a property of the
platform.

`cooldownDays` cannot help here: it is **per pair**, so 63 senders rotating through one
category can message a recipient every single day while every individual pair sits
comfortably inside its 7-day spacing. `DailyReservation` is what closes it, and it is
claimed atomically — a count-then-compare is passed by two concurrent runs.

**On volume:** practitioner figures put aged, healthy business accounts at **25-35**
cold DMs/day. We operate at 1-2. Several per day is safe; the caps are guard-rails
with large headroom, not the binding constraint.

### 3. Every message written from scratch per recipient

Meta's **written** spam policy states repetitive content *lowers the frequency
threshold at which restrictions apply*. Templates with merge fields and spintax do
not count as variation — research found an aged account sending only ~20
spintax-varied messages that was still blocked. At 1–2 messages/day this is the
highest-leverage safety control available.

Bespoke bodies live in `prisma/bespoke.ts` → `OutreachPair.bespokeBody`, used for the
**first** touch. Follow-ups use a fresh variant plus a campaign not referenced
before — reusing the bespoke body would be the exact repetition this guards against.
The 12 variants in `prisma/variants.ts` are the follow-up pool.

**THE SINGLE TEMPLATE IS BUILT AND OFF (`singleTemplate`, default false, 2026-08-06).**
Tabish asked for "no super custom messages"; that partially reverses this decision, so it
shipped behind a flag the way Phases 3 and 8 did, and **turning it on is his call, to be
recorded as his.** When on, every body is ONE template (`SINGLE_TEMPLATE_MIDDLE` in
compose.ts) with ONE variable line — the paid post we actually saw, omitted when there is
none, never invented. Every figure in it is already in the quality gate's allowlist. The
variant is still CLAIMED per send so the per-pair exclusion, `VariantsExhaustedError` and
the send-guard needles all keep working — the hook line is what keeps two touches to one
recipient from being byte-identical, which `distinctiveSlice`/`bodyAppearedSince` require.
Real output was rendered and read for all four shapes (channel±hook, brand±discovery)
before this shipped. If he also says "drop the hook line", that breaks the post-send
delivery check by construction — say so, then record it as his call.

**"A fresh variant" was documented and not enforced, for weeks.** Corrected 2026-08-05.
The LRU was scoped to the SENDER — `{ senderId, enabled, targetKind }` ordered by
`lastUsedAt` — so it said nothing about which bodies a given RECIPIENT had already read.
Nothing in the query looked at the pair. **MEASURED against the live database: 8 of 11 pairs
had already been handed the same variant more than once, one of them five times.** A pool of
12 shared across a sender's 7-9 pairs wraps after 12 messages to *any* target and comes back
round.

The campaign half of the rule was enforced and the variant half was not, which is the half
that matters: Meta penalises **repetition**, and a fresh hook line stapled to a body the
recipient has already read is exactly that. Selection now excludes variants this pair has
been sent (counting `IN_FLIGHT` only, so a discarded draft does not burn the pool — the bug
already recorded for campaigns), and **exhaustion REFUSES** via `VariantsExhaustedError`
rather than wrapping round to something they have read. Not overridable; nearly unreachable
(pool 12, `maxUnansweredTouches` 3, deepest live pair 4).

**It also weaponised a shared needle, and that is the worse half.** Two messages built from
one variant carry the same `distinctiveSlice`, and the post-send thread confirmation asked
*is the needle present* against `page.locator('body').textContent()` — the whole
conversation. So an earlier message of ours satisfied it alone: the new message need never
have appeared and we record SENT. Verified by execution — building a thread from one attempt
and asking about a LATER one returned `true`, with the bodies not even identical.

That is the same mistake this guard has now made **twice, one level up each time**: first the
check read the whole page and our text sat in the COMPOSER whether Enter worked or not; now
it read the whole page and our text sat in an EARLIER BUBBLE. Both times the answer is the
one already written down: *check the thing that changes, not the thing that is there either
way.* `bodyAppearedSince` reads the thread with an empty composer before pasting and requires
the occurrence count to **increase** — a delta history cannot fake.

It was LATENT, not live: 0 delivered messages yet shared a needle with a later one on the
same pair, because only 6 have ever been delivered and the reuse was in SKIPPED drafts that
never reached a thread. Both halves ship together on purpose — the guard must not depend on
selection being right, and selection must not depend on the guard catching it.

**And `{{brand}}` meant two different things while one rule served both.**
`prisma/brandVariants.ts` states the contract in as many words — *"{{brand}} becomes the
recipient's own name"* — and nothing implemented it. `renderMessage` had the CHANNEL rule
only: the sponsor detected in the recipient's paid post, falling back to "your brand
partners". Found by rendering the real message to a real prospect:

- **reachable today** — a media-buying pitch to Royal Canin closed *"indicative numbers for
  YOUR BRAND PARTNERS?"*, addressing a buyer as though it were a publisher with sponsors.
- **latent, worse** — with a hook present it becomes *a different company's name*:
  *"indicative numbers for Amazon Dot In?"* sent to Royal Canin, under a hook line claiming
  Royal Canin collaborated with them. An invented claim about the recipient's own marketing,
  addressed to the people certain to know it is false.

Both fixed, and the latent pair asserted anyway: they are unreachable only because
`pickHook` queries by the RECIPIENT's `targetId` and `pipeline.ts` scrapes `kind: 'CHANNEL'`
alone, which is a property of which rows the scraper visits rather than a rule. A brand now
receives **no hook line at all** — its first touch has `brandPitch`, which names a placement
we genuinely saw. `RenderTarget.kind` is REQUIRED so the compiler named all 24 call sites
instead of one defaulting silently to channel behaviour, which is the bug itself.

**Still broken, deliberately untouched:** the channel hook line renders "Milano Icecream
Bangalore". `prettifyBrand` reconstructs a name from a caption token while the real one sits
in `TargetAccount.displayName`, so the fix is a source-of-truth decision that would make a
pure, tested function do a lookup. Flagged rather than half-done.

### 3b. ENFORCED ON EVERYTHING: all four senders share one persona

> **RESHAPED 2026-08-07, by Tabish's explicit instruction: "the persona needs to only be
> channel name … with the contact details listed accordingly."** Messages no longer
> introduce a person at all. The `"I'm Kapil Jain, Co-founder of …"` intro line and the
> name/role signature lines are GONE from `renderMessage`; every message now signs off as
> the PAGE alone:
>
> ```
> Bollywood Society
> +91 60000 189766
> kapil@digitalsukoon.com
> ```
>
> Consequences, each applied the day of the change so they cannot drift:
> - `signatureBlock()` in render.ts is the ONE writer of that block, and the gate's
>   `PERSONA_CHANGED_SINCE_DRAFT` probe and the quality gate both call IT — writer and
>   probe share bytes.
> - `personaFingerprint` (distinctness, decision 3b) narrowed to brand|phone|email,
>   honouring its own contract ("excludes nothing that appears in the message — and
>   includes nothing that does not"). Two accounts differing only by the now-invisible
>   `personaName` CLASH now, where before they passed as distinct with byte-identical
>   rendered signatures. Stricter in the right direction; tested both ways.
> - `personaName`/`personaRole` remain as columns, validated no longer (a guard about a
>   field no recipient sees is a guard about nothing), and the dashboard editor offers
>   only Page name / Phone / Email.
> - Old-format drafts PASS the staleness probe when their contact block still matches —
>   deliberate; the stop catches a message signed as the WRONG identity, not one signed
>   in last month's format.
> - The retired intro-line pattern STAYS in `ENVELOPE_PATTERNS` (delivered messages carry
>   it forever, and envelope matching errs loose).
>
> **The shared phone+email fingerprint is now 2 of the 3 signature lines.** The gate
> passes because the page names differ, but the standing warning below is sharper, not
> weaker, after this change: at scale, one phone number under every page announces one
> operation. Raise it before volume rises.

Observed 2026-07-31, blocking brand sends since 2026-08-03, and **since 2026-08-04 it
blocks CHANNEL sends too — decision 6, taken by Tabish.**

> **RELEASED 2026-08-06, and this is the entry to read carefully.** Each account was given its
> own channel name — Bollywood Chronicle, Bollywood Society, Mad About Marketing, Demo Account —
> so `checkPersonaDistinct` now passes on all four and this gate blocks nothing. Verified by
> running `recheckBeforeSend` against the live database: the binding stops were `no-session` and
> `auto-send-off`. (`auto-send-off` was DELETED on 2026-08-08 — autopilot is one switch — so
> `no-session` is the binding stop that survives, and it still binds on two of the three
> revenue accounts.)
>
> **The fingerprint it exists to prevent is still there.** All four carry the identical
> `+91 60000 189766` and `kapil@digitalsukoon.com`, and the gate cannot see it because it
> compares the WHOLE block and the block now differs. At four accounts that is cosmetic; at 65
> it is one phone number under 63 pages, which is exactly the "they are one operation" signal
> this decision was written about. **Raise it before volume rises.** A guard passing is not the
> same as the risk being gone.
>
> **Never satisfy it by generating personas.** Who fronts each page is a business identity
> question, and a plausible invented person in a real DM to a real company is worse than a
> blocked send. Runtime flag: `personaGateChannels`, default on.

**Why the reversal.** The reasoning below said halting channel outreach "would be a much
bigger change than this guard is entitled to make on its own", and at four accounts that
was right. At 65 it inverts: 63 pages emitting one byte-identical contact block is the
cross-account fingerprint decision 3 exists to prevent, and **rotation sharpens it in the
specific way that matters** — the whole point is that a recipient hears from a different
page each time, and an identical name, phone number and email under every one announces
they are one operation.

It holds at drafting AND at delivery, and it is **not overridable** — deliberately absent
from `OVERRIDABLE_BLOCKS`, with a test asserting the override is inert. Every stop a human
may cross is about TIMING (too soon, nothing new to say, they already replied); this one is
about the message being wrong for its recipient, and "I know something the agent does not"
is not an argument that applies to a signature naming the wrong company.

The original brand-only reasoning, kept because it explains the shape:

**What a persona actually is, since this needs saying plainly.** It is the identity every
message carries — the intro line and the four-line signature `renderMessage` appends:

```
I'm Kapil Jain, Co-founder of Bollywood Society.        ← intro
...
Kapil Jain
Co-founder, Bollywood Society                            ← signature
+91 60000 189766
kapil@digitalsukoon.com
```

Every `SenderAccount` carries that block **byte-identically**, `@madaboutmarketingg` and
`@bollywoodchronicle` included. Two consequences, and the second is the worse one:

1. A DM from **Mad About Marketing** introduces the co-founder of a *different company*.
   Read as sloppiness, or as one script running several pages.
2. If two of our pages pitch the same brand, that brand's team sees the **identical phone
   number and email twice**. That is the cross-account repetition decision 3 exists to
   prevent, and the bespoke bodies do not fix it: the *bodies* differ per recipient, the
   contact block does not, and it is the part of a message most trivially fingerprinted.

**Why brands FIRST, and then everything.** A brand's social team reads pitches for a
living and checks who is writing; a publisher is a softer audience, and that outreach
already ran this way. So `checkPersonaDistinct` in `brandGuards.ts` started by refusing
only `kind: 'BRAND'` — and now takes a `gateChannels` flag which is on by default.

`validatePersona` checks **shape**, not truthfulness or distinctness, so four identical
blocks sail through it. Distinctness is the property that was missing, and it is now
checked by the same function the dashboard uses to render the warning — a page computing
this its own way could disagree with the rule actually blocking the send.

**Fixable from the dashboard** ("Edit who this account is" on each account row). The moment
one account's block differs from the others, its brand pitches release. Distinctness is
deliberately NOT enforced on *save*: the shared state exists today and channel outreach
runs on it, so blocking the save would force whoever is mid-edit to get all four right in
one atomic step.

This is a business identity question — who actually fronts each brand — and it is Tabish's
to answer. **Do not "fix" this by generating personas**: a plausible invented person in a
real DM to a real company is worse than a blocked send. `@tabishmukaddam1`, the throwaway,
is the one place a stand-in is appropriate.

**On wording.** The on-screen warning originally read *"Another account introduces itself
with these same details, so a brand pitch from here is held back."* Accurate, and it assumed
the reader already knew the persona was the signature — Tabish asked what it meant. It now
shows the actual signature and names the specific mismatch. **If the person a warning is FOR
has to ask what it means, the warning has not done its job.**

### 4. Detection never uses a login

`src/detection/feed.ts` hits Instagram's anonymous web feed endpoint with
`x-ig-app-id: 936619743392459`. **Never attach a session cookie here.** Doing so
converts an IP-level risk into an account-ban risk — the one thing this project
must not do. The only exposure today is IP rate limiting.

### 5. Detection never gates outreach

If the feed endpoint breaks, a permitted message is still prepared, just without a
specific hook. A monitoring subsystem must never be able to silence the thing it
monitors. Correspondingly: **0 posts parsed is an alarm; 60 parsed / 0 paid is a
quiet day.**

### 6. The lifetime ceiling counts messages *in flight*

`MAX_TOTAL_SENDS` counts SENT + REPLIED + SENDING + READY + QUEUED. Counting only
delivered messages would draft every pair before the ceiling bound. The code default
is 1; `'unlimited'` parses to `null` (no ceiling) and is the value in `.env` since
2026-08-03. It was **6**, which had been silently consumed — the planner refused to
prepare anything for two days while the dashboard showed no reason why.

### 7. We message the CHANNEL and the BRANDS in its paid posts

Scope set by Tabish 2026-08-03: *"Message channels that posted and the brands (their
instagram channels)."* Both, not one or the other.

A paid post names its buyer. `@royalcanin.india` ran a campaign with M.O.M, so they are
a company demonstrably spending on influencer placement — exactly who Digital Sukoon's
200-page network is for. The channel gets a partnership pitch; the brand gets a
**different** pitch (media buying), because it is a different proposition to a
different reader.

**Where brand handles come from, and the mistake that hid them.** NOT from
`DetectedCampaign.brands` — that column holds *display* names for message copy, and
`extractBrands` deliberately converts `@royalcanin.india` into "RoyalCanin", throwing
the handle away at exactly the step that needs it. Measured 2026-08-03: across 14
CAMPAIGN posts the brands column held **1 usable handle out of 19 tokens**, while the
CAPTIONS of those same posts held **26 real @mentions**. An earlier conclusion in this
file that "only 20% of brands are resolvable" was measured on the wrong field and is
wrong. `resolveBrand.ts` reads the caption.

**Deduplication is free.** `TargetAccount.handle` is unique, so a brand appearing on
both channels resolves to the SAME row, and the existing cooldown, reply-halt and
opt-out rules cover it with no new logic. Tabish's requirement — *"if those brands are
detected in the other channel's posts they must not be messaged again"* — needs no
code beyond upserting on handle.

---

## The two channels behave completely differently

| | `@madovermarketing_mom` | `@viralbhayani` |
|---|---|---|
| Volume | ~3 posts/day | **~62 posts/day** (measured) |
| Discloses paid work? | **Yes — `#Collaboration`** | **Never** |
| Detector | `mom` — deterministic regex | `semantic` — novelty filter, then a model |
| Brand extraction | free (hashtag + @mention) | not attempted |

**Do not build a rules-based classifier for `@viralbhayani`.** Measured 2026-08-03
against 48 live posts, every structural signal is empty: `is_paid_partnership` 0/48,
`sponsor_tags` absent, `branded_content_tag_info` absent,
`commerce_integrity_review_decision` absent, `#ad`/`#sponsored`/`#collaboration` 0/48.
`commerce_integrity_review_decision` looked promising and is **noise** — present on
43/48 M.O.M posts, 33 of which are not `#Collaboration`.

The dashboard says "not classified" rather than "0 paid campaigns", because a bare
zero would read as *they do no paid work*, which is false. The metrics row now also
carries a coverage line — *"Counted from 1 of 5 channels"* — because a number that
silently describes one channel out of five is unreadable rather than merely incomplete.

### THE CAPTION IS NOT THE POST — A PAID PLACEMENT CAN LIVE ENTIRELY IN THE VIDEO

Found 2026-08-07 by Tabish, and it is the most important open limitation in detection.
`DbtNU9UzWYU` was called ORGANIC by the model with a defensible reason ("news of a new bus,
no promotion or brand brief") — and the model was reading the only thing it is given, the
CAPTION. **The evidence was in the footage.** MEASURED by fetching the reel's cover frame:

  * the vehicle carries **SWITCH** across the front bumper — SWITCH Mobility, Ashok
    Leyland's EV brand. A named commercial product, centre frame.
  * an on-screen title card reads *"THANE's First Double Decker Bus 😍 Inside View!"* —
    supplied-creative styling, not a paparazzi grab.
  * the caption mentions none of it and credits another creator.

So caption-only classification has a blind spot that **no prompt edit can close**. It is a
missing INPUT, not a tuning problem.

**AND IT BREAKS THE MEASUREMENT, WHICH IS THE WORSE HALF.** `pnpm ig:accuracy` scored this
post as a *correct* ORGANIC — the label it compares against is itself caption-derived, so
the harness and the classifier agreed with each other about a post they were both wrong
about. **98% correct / 100% recall therefore means "98% of what a caption can reveal", not
"98% of paid posts found"**, and recall on video-only placements is not merely unmeasured
but unmeasurable by this harness. Never quote the accuracy figure as coverage. Full
reasoning under the warning box in "The prompt is the classifier, so it has a test".

**WHAT IS REACHABLE, MEASURED (all anonymous, no session — decision 4 holds):**

| | |
|---|---|
| `image_versions2.candidates` | **11 sizes on 12/12 posts.** A 480px thumb is ~35 KB, HTTP 200, 50-800 ms |
| `video_versions` | 3 renditions, 720x1280, on every reel (7/12 posts were video) |
| `accessibility_caption` | **0/12 — always absent.** Instagram's own alt-text is not an option |
| `clips_metadata.branded_content_tag_info` | **`{"can_add_tag":false}` on every post.** No hidden disclosure; consistent with `is_paid_partnership` 0/48 |

The thumbnail is the cover FRAME of the reel, which is where a wrap, signage or a product
sits — so vision is genuinely available for about a third of a cent's bandwidth per post.

**AND THE CONTROL FRAMES ARE WHY THIS MUST NOT BE BUILT NAIVELY.** Two more posts were
fetched deliberately as controls, and both would fool a "does the frame contain a brand?"
rule:

  * `DbtMhHdTXDQ` — genuine paparazzi editorial, ORGANIC, correctly. The frame shows
    Samantha outside a salon with **KÉRASTASE and DESSANGE PARIS signage filling the
    background** and a branded cup in her hand. Three brand marks, zero payment.
  * `DbstKpLqBzW` — genuine CAMPAIGN (film promo, 95%). The frame is a man in an orange
    coat and a Hinglish title card: **no brand mark visible at all.**

So brand-visible does NOT mean paid, and paid does NOT mean brand-visible — the same
"identical syntax, only meaning separates them" result that killed a rules-based caption
classifier, one modality over. A vision stage has to ask *is this publisher acting as this
product's channel* (product centred and lit, supplied creative, a title card selling a
feature) versus *is a brand incidentally in shot* (background signage at a location).

**WHAT IS BUILT (2026-08-07): the CAPTURE, not the classification.** `feed.ts` now takes the
cover-frame URL (`pickThumbnail` — smallest candidate >=480px, largest as fallback, never
null when anything exists) plus `video_versions[0].url` and the duration, and `pipeline.ts`
stores them in `rawPayload` and **REFRESHES them on every re-observation**. That last part is
the point: these are CDN URLs with a lifetime, so the newest sighting holds the only ones
still fetchable, and a post that scrolls out of the feed window can never be re-scraped.
Capturing now is time-sensitive and costs nothing; deciding later is fine.
VERIFIED on a live 15:00 cron pass, not by reading code: 23 new posts stored, thumbnail URL
on 23 of the newest 40 rows, video URL on 18.

**RESOLVED 2026-08-07/08 — AND WITHOUT A VISION API. Tabish refused a Gemini key, and he
was right: a paid API was never what solved this.**

**How the Thane post was actually identified: TABISH SPOTTED IT, and the frame was then
read by eye.** No vision model was involved in finding it or in confirming it. That points
straight at what the evidence actually is — **the decisive content of that frame is TEXT**,
and text can be read locally, offline, for nothing. MEASURED on the real 480px cover frame
with Apple's Vision framework, all at confidence 1.00:

```
"THANE's First Double Decker Bus ... Inside View!"   the supplied title card (79% of frame width)
"SWITCH"                                             the advertiser, on the bumper (8% width)
"GALE CIRCLE"                                        the LED destination board
```

**So OCR turns a vision problem into a TEXT problem, and this repo already owns a text
classifier measured at 98% correct / 100% recall.** The frame's words become more words for
it to read. `src/detection/ocr.ts` (Apple Vision via a Swift helper compiled once and
cached; tesseract as a cross-platform fallback, MEASURED WORSE — it read the same title card
and missed `SWITCH` entirely). ~0.2s a frame, no network, **no API, no key, no new cost
line**. The only spend is the classifier call that was happening anyway.

**VERIFIED END TO END on the founding case**: `DbtNU9UzWYU` moved ORGANIC -> REVIEW, reason
*"Title presents new bus as product; likely paid promo."* The corpus backfill then found a
SECOND one nobody had spotted — `Dbuk-oez_C0`, caption ordinary, footage reading
`SONY | 24 AUG | FRI | SONY liv | INDIAN GAME SHOW`.

**WHAT SEPARATES PAID FROM EDITORIAL IS WHAT THE TEXT SAYS — not that text or a brand is
present.** The control frame `DbtMhHdTXDQ` is genuine paparazzi editorial and carries a
prominent overlay too: *"The way Paps are saying / Sambhal ke Madam"* (the publisher's own
joke) plus `DESSANGE D` and a garbled `KERAST` from salon signage. Both frames have a title
card; only meaning separates them, which is exactly the judgement the classifier already
makes. Verified: the salon control does NOT flag, and neither does a chess post carrying
`adani` sponsor boards in shot.

**A MISTAKE WORTH KEEPING, because it cost the founding case a whole build.** The first
version grouped narrow text as `scene` and told the model it was *"scenery, not evidence of
payment"*. `SWITCH` is 8% of frame width, landed there, and the model was thus instructed to
discount the one token naming the advertiser — the Thane post stayed ORGANIC through the
entire new pipeline. **A GEOMETRY fact was asserting a MEANING claim.** Width knows how wide
text is; it cannot know whether a word is a hoarding behind a celebrity or a badge on the
vehicle being shown off. The groups are now named for what they measure (`LARGE TEXT ACROSS
THE FRAME` / `SMALLER TEXT IN THE FRAME`) and the classifier decides.

**THE CAPTION IS JUDGED FIRST, ALONE — and that ordering is load-bearing.** Reading the
frame first and passing its text into the only call was cheaper and wrong three ways, all
found by adversarial review:

1. **It failed open.** A second call established what the caption alone would have said;
   when that call failed, the code assumed the frame had agreed — so a CAMPAIGN produced
   entirely by frame text was asserted. A network blip was enough.
2. **It let frame text name BRANDS, and brands become message copy.** Executed against the
   real salon control, it produced the DM sentence *"I noticed your recent branded
   collaboration with Dessange Paris and Kerastase"* — to a prospect, about signage behind a
   celebrity. Brands now come from the caption-only call, always.
3. It made the guard against a frame CLEARING a post unreachable.

Caption first fixes all three by construction, and costs ~2.8 cents across the whole corpus.

**THE FOOTAGE MAY ONLY RAISE A POST TO REVIEW.** `src/detection/frameSignal.ts`
(`applyFrameSignal`, PURE, exhaustive with `never` bindings, property-tested that it can
never demote): a frame may turn a caption ORGANIC into REVIEW so a person looks, and nothing
else. It can never mint a CAMPAIGN, never overturn one, never clear one, never give an
UNCLASSIFIED post a verdict. The reason is honest rather than cautious: `ig:accuracy`'s
labels are caption-derived, so a frame-driven CAMPAIGN is measured by nothing that exists.

**AND THE REVIEW QUEUE CAN NOW BE ANSWERED, which shipped in the same commit deliberately.**
`humanLabel`/`labelledBy`/`labelledAt` had existed since the schema was written with **ZERO
writers** and no control anywhere — 17 REVIEW rows, the oldest six days old. Escalating a
post to REVIEW without a way to settle it converts an invisible miss into an unactionable
one, which is worse because the queue looks handled. `labelPost` (ONE writer) plus the
"Worth a look" section on `/paid-posts` fixes that, and a person's answer is stamped
`verdictSource: 'human'` so it is never counted as a model's opinion. **Those answers are
also the only possible labels for the video-only class** — `ig:accuracy` cannot measure it
by construction, so every answer is a row in the harness that would.

**THE GATE, MEASURED BOTH WAYS (and `ig:accuracy` now runs the PRODUCTION path — caption
first, then footage, then `applyFrameSignal` — because scoring one call with frame text
would measure a pipeline that does not exist):**

| | correct | recall | precision |
|---|---|---|---|
| before any change | 98% | 100% | 93% (1 FP) |
| new prompt, footage OFF (`--no-frames`) | **98%** | **100%** | **94%** (1 FP) |
| new prompt, footage ON | 96% | **100%** | 88% (2 FPs) |

The control run is the one that matters: **with frames off the new prompt matches the
baseline**, so the prompt edit did not damage caption classification. And with caption-first
ordering a frame move can only produce REVIEW, so frame text is *structurally* unable to
create a false CAMPAIGN — the FP difference is model variance at n=53 (McDonald's appears in
both runs, Miu Miu in one). The harness prints what the footage actually changed, because
otherwise the whole feature could work or misfire with every headline figure identical.

**One prompt attempt failed the gate and was reverted**, which is the loop working: a rule
telling the model that commentary-about-marketing is usually organic dropped **recall to
87%** — trading the one thing this project never trades. The rule that shipped is phrased
strictly as a restriction on RAISING, so it cannot make caption judgement more conservative.

**Frames are BYTES on disk now** (`src/detection/media.ts`, `~/.ds-sales-agent/frames/`),
because the URL is what expires. MEASURED mean **47.4 KB** a frame (206 frames) and 203
posts/day, so ~9.6 MB/day and ~3.5 GB/year — the first draft of this said 35 KB and 90/day,
understating it threefold. 206 frames are banked including the founding case.

**AND THE URL REFRESH THIS ALL RELIED ON NEVER RAN.** The previous session's docblock claimed
media URLs were "REFRESHED on every re-observation". `persist()` is reached only from
`for (const post of fresh)`, and `fresh` excludes every known shortcode — so a re-observed
post was never re-persisted. MEASURED: 48 of 1,709 rows carry a thumbnail URL; 39 pre-capture
rows re-observed across ~9 later passes gained none. It was "verified" by checking that NEW
posts had URLs, which cannot test a claim about re-observation. Frames are now banked for
re-observed posts in the pipeline's known-post loop, which is how the Thane frame was
recovered at all. **Do NOT delete the `upsert` `update:` branch as dead code** — it fired 16
times in one day: the four IST slots sit on minute 0, always a multiple of 15, so they
collide with the 15-minute detect cron four times a day, and that branch is the reconciler.

**Commands:** `pnpm ig:ocr` reads every saved frame and prints what it says — **the default
does real work because OCR is free**, and only `--reclassify` spends. `pnpm ig:frames
--capture` banks frames whose URLs are still alive; run it generously, judging can wait.
`pnpm ig:detect` runs a pass on demand.

**Known limitations, stated rather than buried.** OCR only sees the COVER frame, so a brand
revealed later in a reel is still invisible (ffmpeg multi-frame extraction is feasible and
free of API cost — MEASURED at 7.25 MB a reel, 81.7% of posts are reels, so ~453 GB/year,
which is why it is not built). A placement with no on-screen text and no readable brand mark
remains unreachable. `OVERLAY_MIN_WIDTH` and `OCR_CONFIDENCE_FLOOR` are measured from 156
frames, not tuned against outcomes. And a Windows machine has no Vision framework: it gets
tesseract if installed and an **honest refusal** otherwise, never a silent "no text found".

### THE FRAME CHECK WAS BUILT AND NEVER RAN — 166 FRAMES SAVED IN A DAY, NONE READ (2026-08-08)

The single most important finding of the hosting session, and it invalidates the confident
tone of everything above until this date.

`pipeline.ts` saved every new post's cover frame and then classified the **caption alone**.
The only frame-aware code lived in `scripts/ocr.ts --reclassify`. So the Thane class of
paid post — the entire reason the OCR work exists — was **still being missed in normal
operation**, and `DbtNU9UzWYU` was only ever escalated because a person typed a command by
hand. MEASURED that day: 166 posts had a frame on disk that nothing had looked at.

**A feature that works only when someone runs a command is not running.**

`src/detection/judge.ts` (`judgeWithFrame`) is now the ONE judging path — caption first and
alone, then the footage, composed through `applyFrameSignal` — and all three callers use it
(`pipeline.ts`, `scripts/classify.ts`, `scripts/ocr.ts`). This is the FOURTH time one rule
with several callers has drifted here after `gate.ts`, `readThread.ts` and the two Connect
buttons, so it is asserted by `tests/one-judging-path.test.ts` rather than by a comment —
a comment claiming "one implementation, two callers" was already present and untrue in
`readThread.ts`. That test FAILED on its first run and caught `scripts/ocr.ts` still
holding its own copy, which is exactly its job.

The frame call is gated on `optedOut` in one place (MEASURED: 64% of OCR runs were our own
retired pages). Frames are still SAVED for them — our own channels are ground truth and the
labelled set any future measurement needs. Backfill after the fix: 51 judged, **114
correctly skipped**, 5 calls failed and left untouched.

### OCR IS NOT macOS-ONLY ANY MORE — RapidOCR, MEASURED (2026-08-08)

MEASURED across all 321 saved frames, comparing normalised CONTENT against Vision's answers:

| engine | content recall | the founding case (`SWITCH` on the Thane bumper) |
|---|---|---|
| vision | baseline | reads it, confidence 1.00 |
| **rapidocr** | **87.1%** | **READS IT, confidence 0.83** |
| tesseract | 71% | **misses it entirely** |

**The first attempt at that recall figure said 27.1% and was WRONG.** RapidOCR emits
`THANE'sFirstDoubleDeckerBusInsideView!` where Vision emits the same words spaced, so
splitting on whitespace made one engine's single token unmatchable against the other's
seven — a FORMATTING difference reading as a reading failure. Trusting it would have
rejected the engine that reads the decisive token. Measure the property that matters, not
an artefact of how an engine chunks its output.

**What decided it was the founding case and the CONTROLS, not the aggregate.** RapidOCR
recovered every decisive token: `SWITCH`/`THANE`/`Double Decker`; the editorial control's
`DESSANGE`/`Sambhal` (which must NOT flag); `SONY`/`GAME SHOW`. An engine with a good
average that cannot read the one token the feature exists to catch is a regression with a
good average.

`scripts/rapidocr-read.py` prints the SAME JSON shape as the Swift Vision helper, so
`parseVisionOutput` reads both — one parser, two producers. Speed: **0.61 frames/second**
on the Linode (ONNX, no GPU) against Vision's ~5/s locally; fine for a background pass,
not for a request. The engine that answered is recorded on every result: **never compare
verdicts across engines without knowing which read the frame.**

`framesRead` on `/paid-posts` no longer collapses **five** states into one number —
read-with-text / read-no-text / no-frame / no-engine / failed have five different
remedies, and a single low count cannot distinguish a clean corpus from a broken reader.
The second is an outage wearing the costume of a quiet day.

### IT IS HOSTED NOW, AND THE SERVER CANNOT SEND (2026-08-08)

The dashboard, the database and detection run on the Linode (172.105.53.101). **Sending
does not, and cannot.** Full detail in `docs/DEPLOY.md`; the parts that must not be undone:

```
LINODE                                    A USER'S OWN MAC / WINDOWS
──────                                    ─────────────────────────
dashboard :3100 behind nginx + TLS        pnpm agent:device
Postgres 16  ds_sales_agent               their Chrome profiles
detection cron, every 15 min              their Instagram sessions
RapidOCR  /opt/ds-ocr-venv                drives the browser from THEIR IP

SEND_ENABLED=false      <- hard floor     SEND_ENABLED=true
AUTOPILOT_ENABLED=false <- hard floor     pnpm ig:brands  <- SEE BELOW
```

**AND SINCE 2026-08-12 A SECOND THING MUST RUN FROM A HOME IP: BRAND LOOKUPS. MEASURED,
with a control probe, which is the diagnostic that has now corrected this endpoint's story
three times.** Instagram 429s the Linode on the per-handle PROFILE endpoint
(`web_profile_info`) while the SAME handles answer from the Mac, seconds apart:

| handle | from the Linode | from the home Mac |
|---|---|---|
| `aafiyasayed_` | **429** | 200 |
| `aaflims.official` | **429** | 404 |
| `royalcanin.india` | **429** | 200 |

**It is a SPLIT, not an outage, and the split is the part to get right.** The anonymous
FEED endpoint is fine on the server — `pnpm ig:detect` found a paid post in the same minute
a lookup 429'd. Only the profile endpoint is throttled. So on the server every
`autoResolveBrands` pass spends its first lookup on a 429 and halts, permanently, while
detection stays healthy. Reading that as "the endpoint is down" or "the handle is bad" is
wrong on both counts: the 400s are Meta's deleted-category-schema bug (permanent,
per-handle, correctly `UNRESOLVED`), and a 429 at one host says nothing about another.

MEASURED from the Mac: `pnpm ig:brands --run` resolved **208 handles in ~20 minutes** (6s
spacing, deliberate politeness against an undocumented endpoint) — 99 brands, 155 people,
47 needs-a-human, and **59 new BRAND targets created**, including Godrej, Amazon MGM
Studios, Kama Ayurveda, Danube Properties, JioHotstar, Gulf Oil and Dharmatic. The server,
running the identical code, had created **zero**.

**Do not "fix" this with a proxy or by moving it back to the server.** This is the second
capability pinned to a home IP and the reasoning rhymes with the first: sending must come
from the residential IP the accounts were logged in from, and lookups now must too, because
the datacenter IP's reputation is the thing being refused. A proxy converts a normal pattern
into an evasion pattern — the same argument that ruled out anti-detect browsers under
decision 1. **Run `pnpm ig:brands --run` from a home-IP machine, periodically, and let the
server keep detecting.** The 429 also produced a livelock worth knowing about: one throttled
handle held the entire per-pass budget every pass until ordering was changed to sort a
just-failed handle LAST (`orderForLookup`, plus `UNKNOWN_RETRY_AFTER_MS`).

**`SEND_ENABLED=false` lives in `withSendLock`**, which every path that drives a browser
passes through — the dispatcher, the dashboard's Send button, the on-demand dialog, the
CLI. Its first version was checked only inside the device agent, which left the other four
open on the server: the same one-rule-several-callers gap, in the guard whose entire job is
that hosting is safe STRUCTURALLY. Verified by execution both ways — floor down, the send
body never runs; floor up, it does.

**Why the server may never send.** A send drives a Chrome profile logged in BY HAND from a
home IP, which wrote `mid`, `ig_did`, `ig-u-rur` and a login event binding that browser to
the account from that network. Copying it to a datacenter is a cookie transplant: `sessionid`
is a bearer token with no channel binding, so it WORKS right up until enforcement lands
silently. On a multi-user product it is worse — every customer behind one datacenter IP.

**A powered-off device cannot send, and nothing pretends otherwise.** Tabish asked for
sending to continue "regardless of whether they close the url or turn off their devices";
the first half is already true (the tab was never the sender) and the second is impossible
without the transplant above. He chose queue-and-send-on-return after the risk was stated:
drafts stay READY, the dashboard shows when a device was last seen, and they go out on
reconnect under the ordinary pacing rules.

**Registration is invite-only and roles are enforced** — see the auth section. The random
subdomain is NOT a security control; a URL leaks through history, referrers and CDN logs.

**Postgres, not SQLite, on the server.** The WAL argument in `src/lib/db.ts` is about
SQLITE and does not apply: Postgres MVCC snapshots are per TRANSACTION at READ COMMITTED,
so each statement sees the latest commit — which is what makes two hosts sharing one
database safe. Do NOT set a session-level REPEATABLE READ; that reintroduces the frozen
snapshot through a different door.

**THE GENERATED PRISMA CLIENT IS BAKED WITH ITS SCHEMA'S PROVIDER.** Choosing an adapter at
runtime is not enough — found by running it:

> `The Driver Adapter @prisma/adapter-pg ... is not compatible with the provider sqlite
> specified in the Prisma schema.`

So the switch is a BUILD step. The server runs `prisma generate --config
prisma.postgres.config.ts` after every install; a laptop runs plain `prisma generate`. And
`pnpm test` regenerates the SQLite client first, because the suite builds temporary `.db`
files and points the real client at them.

`prisma/schema.postgres.prisma` is GENERATED by `scripts/make-postgres-schema.sh` and never
edited. `tests/schema-parity.test.ts` asserts a byte-identical model body and was
mutation-tested (an injected canary model failed it; removing it passed).

**Two bugs the server found that reading could not**, both worth the shape rather than the
detail: `commandExists` searched PATH for an ABSOLUTE path and so reported a correctly
installed RapidOCR as `engine: none`; and `rapidocr-read.py` printed line-delimited JSON
under a docblock claiming it matched the Swift helper, which prints an ARRAY — so the
engine ran, exited 0 with four correct observations, and the outcome was `failed`. The
first was caught in one command ONLY because the refusal names itself instead of returning
"no text found".

### DETECTION HAS ITS OWN CLOCK, AND IT IS NOT THE SEND SCHEDULE (2026-08-07)

Tabish: *"the schedule is for sending messages, not for detecting paid posts, paid posts
must be detected as fast as possible for the channels as target."*

Detection was stage 1 of `runSlot`, so it inherited 11:00/15:00/17:00/20:00 IST. Those four
times are a decision about DM volume and recipient experience; detection is an ANONYMOUS
public read with no session attached (decision 4) and cannot spam anyone, so nothing about
send safety argued for pacing it. MEASURED cost of the coupling on 404 real @viralbhayani
posts (57.7/day): the 20:00 -> 11:00 gap is **FIFTEEN HOURS**, about **20 posts a night**
sitting undetected. A hook line is age-bounded (`HOOK_MAX_AGE_HOURS`), so a slow read can
retire material before anything is written about it.

Now: `DETECT_INTERVAL_MINUTES = 15` on its own cron (`src/detection/cadence.ts`), worst-case
latency 15 hours -> 15 minutes, a 60x improvement. **Why not faster:** 5 watched channels x
~4 pages is ~18-20 requests a pass, so 15 minutes is ~1,900 requests/day against an
undocumented endpoint; 5 minutes would be ~5,700 to shave 10 minutes off an already-solved
problem. The risk here is a 429/IP block that blinds detection completely, and the point of
the change is to see MORE. If a 429 appears, raise the interval first.

`DETECT_LOOKBACK_HOURS = 6` for a routine pass (was 36 — sized for a 15-hour slot gap, and
absurd re-reading at 15-minute cadence), `DETECT_CATCHUP_LOOKBACK_HOURS = 36` kept for
`runSlot` and restart catch-up, because a slot must never plan against a stale corpus.
**Nothing about sending changed** — four slots, reply checks at 11:00/20:00, and the paced
dispatcher are untouched. Verified by watching the cron fire on its own clock, not by
reading the code.

### THE 13 AUGUST AUDIT — WHAT ACTUALLY READS EACH POST, MEASURED

An end-to-end audit of paid-post detection, 2026-08-13. Plan for the fixes:
`docs/specs/2026-08-13-tags-collab-and-labelling-plan.md`. Read the numbers before changing
anything here — several of them contradict what a reading of the code suggests.

**THE ACCURACY FIGURE IS MEASURED ON THE ONE CHANNEL WHERE THE MODEL NEVER RUNS.** This is
the finding that reframes every other number. `pnpm ig:accuracy` scores the SEMANTIC
classifier against @madovermarketing_mom's `#Collaboration` labels — but M.O.M's production
detector is `mom`, a deterministic hashtag rule, and `verdictSource` is **`'rules'` on 79 of
79 M.O.M posts, going back to March. The model has never judged a single one.** Meanwhile
@viralbhayani runs the model on every post, supplies **174 of 221** paid posts, and has **no
ground truth at all**. So the number is measured where it is not used and used where it is
not measured. It is not a coverage figure and never was; now it is not even a figure about
the channel it names.

**Measured 2026-08-13:** 95% correct · **100% recall (19/19)** · 83% precision, n=77. Recall
is intact. **Precision has DEGRADED** from the documented 92-94% (1 false alarm) to 83% (4),
and all four are M.O.M commentary about other brands' campaigns — McDonald's, Miu Miu,
Netflix, Rare Beauty. That is the documented hard case, not a new one.

**WHAT IS READ, PER CHANNEL:**

| | detector | model reads it | footage read (7d) |
|---|---|---|---|
| `@viralbhayani` | semantic | yes | 248 of 405 |
| `@bollywoodsocietyy` | semantic | yes | 199 of 407 |
| `@bollywoodchronicle` | semantic | yes | 264 of 482 |
| **`@madovermarketing_mom`** | **mom (regex)** | **NEVER — 0 of 79** | **0 of 35** |

**THE BLIND SPOT: posts where NOTHING was read** — judged ORGANIC by a rule, no model, no
frame text, since the 1 August cutoff:

| | total | nothing read | share |
|---|---|---|---|
| `@madovermarketing_mom` | 61 | 46 | **75.4%** |
| `@viralbhayani` | 735 | 36 | 4.9% |
| `@bollywoodsocietyy` | 695 | 21 | 3.0% |

@viralbhayani's 4.9% are one-word captions below `MIN_JUDGEABLE_CAPTION` (`Ruhanika`,
`Eisha`, `Farhana`) — auto-ORGANIC, and several had no frame read either.

**IN M.O.M's DEFENCE, THE RULE IS PERFECT ON ITS CORPUS and must not be "fixed" casually:**
18 CAMPAIGN posts carry `#Collaboration`, **0 ORGANIC posts do**, and there is no
`#sponsored`, `#ad`, `paid partnership`, `presented by` or `use code` anywhere in 79 posts.
The risk is not mislabelling — it is that there is NO SECOND LOOK. An undisclosed M.O.M paid
post is missed with certainty. Changing this is a decision with its own risk and is
deliberately OUT OF SCOPE of the tags/collab plan.

**~~WE FETCH TAGS AND COLLABS AND THROW THEM AWAY.~~ CORRECTED THE SAME DAY BY
RE-MEASURING — TAGS WERE NEVER DROPPED.** The audit read `pipeline.ts`'s seven `rawPayload`
keys, saw `taggedAccounts` was not among them, and concluded it was "fetched, validated and
dropped". **It has a COLUMN, and the pipeline has always written it.** MEASURED on the live
database: **460 of 2,713 rows carry tags**, including posts detected that morning —
@bollywoodchronicle 373 of 813, @viralbhayani 76 of 737. Looking at one store and drawing a
conclusion about another is the same shape as the findings the audit was making at the time,
which is why *"where CLAUDE.md states a measurement, re-measure"* is the standing rule.

**WHAT WAS GENUINELY MISSING WAS THE OTHER HALF: the evidence was captured at FIRST SIGHTING
and never refreshed.** `persist()` is reached only from `for (const post of fresh)`, and
`fresh` excludes every known shortcode — the identical structure that made the old "media
URLs are refreshed on every re-observation" claim false for a month. Tags and collaborators
can be EDITED after posting, so a brand tag added an hour later was invisible to us forever.

Fixed 2026-08-13: `src/detection/evidence.ts` (`evidenceRefresh`, PURE) compares the stored
evidence against what the feed now reports and returns **null when nothing moved**, which is
nearly always — without that comparison the known-post loop would write ~18,000 rows a day
to record that nothing had happened. `buildRawPayload` is the ONE writer of that JSON shape,
shared by the create and the refresh, because two builders of one shape is how the seven
keys and the column drifted apart to begin with. `taggedAccounts` also joined the upsert's
`update:` branch, which had been the one captured field the reconciler left behind.

**VERIFIED BY RUNNING IT, not by reading it.** A stored row's tags were deliberately set
wrong, and one real `pnpm ig:detect` pass corrected them. The same pass found **three
genuine divergences nobody had touched** — two @viralbhayani posts that had gained a
`@bollywoodpap` tag since we stored them, and a pinned M.O.M post whose `@thechitthi`
co-author had never been captured at all. A counter that only ever reads zero is not
evidence that a write path works.

`collabHandles` IS stored (in `rawPayload`) and **no classifier reads it** — see the tag
-evidence entry below for what happened when one was allowed to. Tabish decided 2026-08-13
that we collect both.

**AND THE INVERSE DOES NOT HOLD — tags are evidence, never a rule.** 7 M.O.M posts we
correctly call ORGANIC @-mention brands (`@appletv`, `@miumiu`, `@rarebeauty`, `@drink818`):
a marketing publication's editorial names brands constantly. Treating "@-tags the brand"
as sufficient already cratered precision **85% → 71%** once. A collab tag is stronger than a
caption mention — both parties opted in — and is still not proof.

### GIVING THE CLASSIFIER THE TAGS WAS BUILT, MEASURED, AND SWITCHED OFF (2026-08-13)

`tagsAsEvidence`, default **false**. Turning it on is Tabish's decision and should be
recorded as his. It is off because the harness said so, not because it is unfinished.

Three `pnpm ig:accuracy` runs over the same 77 posts, changing one input at a time:

| run | correct | recall | precision | false alarms |
|---|---|---|---|---|
| baseline, before any change | 96% | **100%** | 86% | 3 |
| new prompt, tags OFF | **97%** | **100%** | **90%** | 2 |
| new prompt, tags ON | 95% | **100%** | 83% | 4 |

**RECALL NEVER MOVED**, which is the one thing this project does not trade. What moved was
PRECISION, and it moved the WRONG WAY against the identical prompt — so the tag INPUT is the
cause, not the prompt edit. The mechanism is visible in the model's own reasons for the two
extra false alarms: *"American Eagle tagged"* and *"co-authored by brand"*. That is the
documented failure reproducing, smaller only because the prompt now forbids it explicitly.
A false CAMPAIGN is not free — it becomes the hook of a real message to a real prospect —
so the change failed the goal it was built for, which was to IMPROVE precision.

**WHY THE CODE IS KEPT RATHER THAN DELETED, stated honestly.** The measurement is on
@madovermarketing_mom, the only channel with ground truth — and `verdictSource` is `'rules'`
on 79 of 79 of its posts, so **the model never runs there in production**. Worse, only
**4 of 79** of its posts carry any tags, so the harness is very nearly blind to this input
by construction. The channels it would actually affect are the semantic ones, where the
correlation is real on two and INVERTS on the third:

| channel | tagged, of CAMPAIGN | tagged, of ORGANIC |
|---|---|---|
| `@viralbhayani` | 21.3% | 6.9% |
| `@bollywoodsocietyy` | 17.6% | 0.7% |
| `@bollywoodchronicle` | 20.0% | **46.3%** |

@bollywoodchronicle tags the celebrity in every paparazzi photograph, so a rule built on the
first two rows would be confidently wrong on the third. **Measured harm on a proxy,
unmeasured effect where it would run** — off is the conservative reading of that, and the
`--tags` control on the harness means the question can be re-asked in one `Setting` row
rather than re-implemented.

**With it OFF the user message is BYTE-IDENTICAL to before**, so classification is provably
unchanged rather than measured unchanged: `tagsForPrompt` returns null when there is nothing
to report, and `tagsForPost` returns null when the switch is off. Verified in both
directions by execution. `pnpm ig:accuracy` now defaults to tags OFF **to match production**
— a harness whose default disagrees with production measures a pipeline that does not exist.

**THE ORDERING CONSTRAINT, if this is ever switched on.** A post is judged twice — caption
alone, then with frame text — and `applyFrameSignal` attributes any difference between those
two verdicts to THE FOOTAGE. Tags belong to the post, not the frame, so they must reach
**every** `classifyCaption` call about a post or none: passing them to one call only would
record a tag-driven disagreement as `frame:disagreed-higher`, corrupting the single number
that says whether reading video earns its keep. `tests/rotation-fleet.test.ts  the PRODUCER of a ring, against a real database — `rotation.test.ts`
                       covers `nextSender` thoroughly and is handed a ring as a fixture, so the
                       whole suite asserted what rotation DOES with one and nothing asserted
                       that anything ever BUILDS one. Nothing did. Mutation-tested: deleting the
                       cohort+handle sort left all 19 green until the fixtures were inserted in
                       the OPPOSITE order to the answer they expect
tests/usable-name.test.ts  both tables are the REAL live display names, and the second — the
                       names that must SURVIVE — is the half carrying the weight: the naive rule
                       fails 15 of these
tests/person-category.test.ts  every category string is one Instagram actually returned. "Film
                       Director" never matched a set containing 'director'
tests/hook-staleness.test.ts  a frozen body's dated claim, in both directions, including the one
                       that must fail closed: a claim we can no longer date is STALE, not safe
tests/tag-evidence.test.ts` is a SOURCE
GREP over the call sites for exactly this, because the failure mode is a call site nobody
has written yet. It was mutation-tested in both directions, and its first version was
silently matching ZERO calls in `judge.ts` — a grep that matches nothing reports success.

**DETECTION IS HEALTHY, AND RUNS ON THE SERVER.** `schedulerHeartbeat` reads
`machine: linode-detect`; pm2 `ds-sales-agent` up 21h. The pm2 log shows `detection pass`
firing at 08:15, 08:30, 08:45, 09:00, 09:15, 09:30, 09:45, 10:00, 10:15 IST — **every 15
minutes, no misses.** Closing the laptop changes nothing; the Mac dashboard is a viewer.
Median latency post→detected: **@viralbhayani 18 min, M.O.M 15 min**, floor set by the cron.

**A DETECT PASS THAT FINDS NOTHING LEAVES NO RECORD, and that reads as an outage.** A first
pass at measuring cadence from `detectedAt` spacing showed "gaps" of 45-75 minutes overnight;
the pm2 log proves every pass fired. Rows are written only when a post is found, so the
DATABASE CANNOT DISTINGUISH "the watch stopped" from "nobody posted" — the same shape as the
20-hour outage nobody noticed. The heartbeat is the witness; do not read `detectedAt` spacing
as cadence.

**ZERO PAID POSTS IN A MORNING IS THE NORMAL PATTERN, not a fault.** @viralbhayani paid posts
by IST hour over 14 days: **00:00-08:59 → 84 posts, ZERO paid.** Commercial posting starts
~09:00, climbs from 11:00, peaks 16:00-20:00. A dashboard reading 0 paid at 10:00 IST is
reporting a quiet morning.

**BRAND DISCOVERY IS DEAD ON THE SERVER, still.** Every 15-minute pass logs
`brand lookup rate-limited status=429 ... looked=1 unreached=13` and halts. BRAND targets
created: **59 on 12 Aug** (the Mac run) and **0 since, by anything**. New prospects only
appear when somebody runs `pnpm ig:brands --run` from a home IP. Unresolved; needs a decision,
not a patch.

**THE REVIEW QUEUE IS THE ONLY INSTRUMENT THAT CAN MEASURE RECALL, and it is empty of
answers**: 20 posts, all unlabelled. Human labels are `verdictSource: 'human'` — the highest
authority verdict in the system and the only possible ground truth for video-only placements.
Which is why an irreversible label is a measurement risk, not a UI nicety: a wrong one is
counted as truth by any future recall figure. Hence the undo in the plan.

### THE GROUND TRUTH IS POISONED, AND BOTH FOUNDING CASES ARE IN IT (found 2026-08-13)

**READ THIS BEFORE QUOTING ANY RECALL FIGURE BUILT FROM HUMAN LABELS.**

23 posts carry a human label. **21 of them share a byte-identical `labelledAt`** —
`2026-08-08 11:04:04.042` — with a single `AuditLog` row, action **`post.labelled.bulk`**,
actor `cli:Tabish`, detail *"paid=false x21 (review queue cleared on Tabish's instruction)"*.
That was not 21 people-clicks, and **the script that wrote it does not exist in this repo**;
`labelPost` was never the only writer of `humanLabel`, whatever its docblock said.

Two of those 21 are the founding cases of the entire footage-reading feature:

| | | |
|---|---|---|
| `DbtNU9UzWYU` | the **Thane bus** | frame reads `THANE's First Double Decker Bus Inside View!` + **`SWITCH`** on the bumper |
| `Dbuk-oez_C0` | the second case | frame reads `SONY \| 24 AUG \| FRI \| SONY liv \| INDIAN GAME SHOW` |

CLAUDE.md documents both, at length, as **genuinely paid**. Both now read
`humanLabel: false`, `verdict: ORGANIC`, `verdictSource: 'human'` — the highest-authority
verdict in the system, asserting that the two posts this capability exists to catch were not
paid. Any future recall figure built from these labels would count them as correct misses.

**AND ALL 21 WERE UNREACHABLE FROM EVERY SCREEN.** The review queue filters
`humanLabel: null`; the posts table renders CAMPAIGN and REVIEW only. A post labelled
"ordinary" therefore vanished from the dashboard the instant it was answered, permanently,
with no control anywhere to revisit it. *A hard stop with no release is a bug wearing a
safety feature's clothes* — the sentence already in this file about the reply halt was true
here too.

**Fixed by shipping the release alongside the undo**, because a five-second window is
worthless if the only escape after it is editing the database: `/paid-posts` now has
**"Answers you have given"** (`src/app/paid-posts/settled.tsx`), listing every human answer
newest-first with the caption, what the classifier had said, and — unconditionally, unlike
the review queue — **what the footage said**, because that is the evidence most likely to
show an answer was wrong. Changing one goes through `labelPost`, still the one writer,
and leaves an honest audit row: a person looked again and decided differently.

**These 21 labels are NOT rewritten by this work, deliberately.** Labelling is Tabish's act,
not a model's, and silently "correcting" his ground truth would be the same category of
mistake as creating it. They are now visible and one click from correct.

### THE FREE FILTER WAS SILENTLY VETOING THE CLASSIFIER — the largest source of missed paid posts

Found 2026-08-07 when Tabish hand-picked five paid posts we had "missed". FOUR WERE ALREADY
`CAMPAIGN` at 92-95%. The fifth exposed something far worse than one post.

Stage 1 (`novelty.ts`) required **two or more rare hashtags** to let the model read a post.
MEASURED on the live 592-post corpus: **76 @viralbhayani posts were filtered and never read
by the model, and 49 of them failed for that one-rare-tag reason alone** — including
Tabish's post (`#Thane`, one rare tag) and obvious commercial copy like
*"#CommuneCircus, presented by Vartik T…"* and a Star Plus show launch. And the filtered
posts were recorded as **`verdict: 'ORGANIC'`** — a positive claim that the publisher was
NOT paid, about posts nothing had read. `/paid-posts` counted all 76 as judged-and-editorial.
Fourth appearance of *absence of data hardening into a negative verdict*.

The file's own header already argued the right principle — *"a missed paid post is invisible
and unappealable, a wasted call costs a fraction of a cent"* — and the code shipped a
threshold that made misses the common case.

**The veto is DELETED, not lowered.** Measured `rare>=1` too: 540 of 592 pass, so it would
still discard 9% while remaining able to veto a paid post. At the measured
**$0.0000239/post with 94% cache hit**, reading every never-read post on every channel is
**2.7 cents**. The economics the filter was built for do not exist. Scoring is KEPT and
still recorded (`rareTags`, `signals`) — the measurement was valuable, the veto was the bug.
A filtered post now returns `UNCLASSIFIED` / `verdictSource: 'none'`, never a verdict.

**Result: @viralbhayani 84 -> 99 CAMPAIGN (+18%)** on the day, **101 in-window after the 13:15
detection pass**, 689 posts classified for $0.012, and the 125 fake-ORGANIC rows (76 VB + 49
society) were reset and re-judged. In-window unjudged is **0** on every classifying channel.

### "TOO SHORT TO BE A PITCH" IS A VERDICT, NOT A FAILED CALL

`classifyCaption` returns null under 15 characters, and null means *the call failed* — so 27
posts (`#kajol`, `Om Shanti 🙏`, `RIP 💔`, two with no caption) sat in UNCLASSIFIED forever,
holding the unjudged count above zero on a screen where unjudged means A JOB TO DO. No
amount of re-running could clear them, because nothing was wrong. Now judged free as ORGANIC
with `verdictSource: 'rules'` — and that source is HONEST here where the stage-1 filter's was
not: this is a deterministic rule ABOUT THE POST (`tooShortToJudge`, `MIN_JUDGEABLE_CAPTION`,
exported and tested), not a decision to skip reading it. A paid placement needs a product, a
date, a link or a brief; none fit in eleven characters.

**`ig:classify` had its own copy of the stages and had to be fixed too** — it reported "27
reach the model" then classified zero. One rule, two callers, and the CLI was the wrong one
again.

### /paid-posts COUNTS THE WINDOW IT ACTUALLY JUDGES

The breakdown counted the WHOLE corpus, so it reported ~370 posts as "not judged" — every one
pre-cutoff history the classifier is deliberately never asked to read (Tabish's 1 Aug scope).
A permanent, un-clearable backlog. Now every figure is scoped to `detectionCutoff()` and the
page NAMES the window; the older corpus gets one quiet line saying it is kept on purpose.

**The rows are NOT deleted and must not be.** `buildVocabulary` learns each channel's normal
vocabulary from every stored caption; shrinking that baseline makes ordinary words look novel.
The fix for a confusing number was scope, never deletion. In-window unjudged is now **0** on
every classifying channel. `@priyanshu123321123` (a throwaway rehearsal RECIPIENT on the
passthrough detector) was unwatched — its posts could never be judged, so it sat permanently
"not judged" while its feed was read for nothing.

### The classifier is two stages, and the first one is free

`detectorKey: 'semantic'` (`detectors/semantic.ts`). Tabish's observation, verified
against the stored corpus: **a paid post carries hashtags atypical for that channel.**

Across 306 stored @viralbhayani posts there are 262 distinct hashtags, only **eight**
used 3+ times, and 229 used exactly once. Paid posts drag in vocabulary the channel
has never used — `#danielwellington`, `#jananayagan`, `#harrooftilara` — while
editorial recycles celebrity names.

`detectors/novelty.ts` scores that for nothing, and on the real corpus it filters
**387 of 719 unjudged posts (54%)** while losing **zero** known campaigns (5/5 M.O.M
survive). What it drops is unambiguously editorial ("#malaikaarora spotted with her
mystery friend").

**Novelty alone is NOT a verdict, and the same measurement proves it**: mean novelty
is 0.86 across all posts, and `#salmankhan` scores exactly as novel as
`#danielwellington` — the channel simply never repeats a name. What separates them is
whether the novel token is a *brand being promoted* or a *person being reported on*,
which is meaning. So stage 1 decides only "is this worth paying to read", and is
biased toward yes: a missed paid post is invisible and unappealable, a wasted call
costs a fraction of a cent. Captions with **no hashtags reach the model too** — 155 of
306 real posts have none, so a hashtag-only gate would blindfold it on half the channel.

**Cost.** `deepseek-v4-flash`, and three things are load-bearing:

- **`thinking: { type: 'disabled' }`.** Thinking mode is **on by default** at effort
  `high` and would emit a chain of thought before every one-line verdict, billing
  output tokens to deliberate about a photo caption.
- **The system prompt is a module-level constant and nothing is interpolated into
  it.** DeepSeek caches automatically, but a hit needs the prefix to match in FULL,
  and cached input is **$0.0028/1M against $0.14/1M** — 50x. Putting a date, a channel
  name or a post count in that string would destroy the cache on every call, forever,
  silently. Per-post content goes in the user message.
- Flash, not pro: pro is 3x on a miss for no benefit on a task this shaped.

`pnpm ig:classify` backfills stored posts. **Dry run is the default** — it is the only
command here that spends money and the volume is unbounded by construction, so a
mistyped handle must cost nothing. It reports exactly how many posts would reach the
model before any of it is spent, and prints the real token split and cost after.

### The prompt is the classifier, so it has a test — `pnpm ig:accuracy`

@madovermarketing_mom discloses with `#Collaboration`, so its rule verdict is a
**label, not an opinion**. The harness strips the disclosure hashtags before the model
sees the caption, so it cannot read the answer — a genuine held-out test.

> ## WHAT 98% DOES NOT MEAN — READ THIS BEFORE TRUSTING THE NUMBER
>
> **The harness scores CAPTIONS against CAPTION verdicts, so an entire class of miss is
> invisible to it.** It is not a coverage measure and must never be quoted as one.
>
> The case that proves it, 2026-08-07: Tabish flagged `DbtNU9UzWYU` (@viralbhayani) as
> paid. The model called it ORGANIC at 85% with a reason that is *correct on the evidence
> it was given* — "news of a new bus, no promotion or brand brief". The caption reads
> *"Thanekars have double reasons to celebrate! The super awesome #Thane just got its
> first double decker bus! Credit : @thane_street_story_"*. No brand, no campaign hashtag,
> no tagged advertiser, and it credits another creator.
>
> **The evidence was in the footage.** Fetching the reel's cover frame showed a **SWITCH**
> (Ashok Leyland's EV brand) double-decker centre-frame with the name across the bumper,
> under a supplied-looking title card: *"THANE's First Double Decker Bus 😍 Inside View!"*
>
> Three consequences, and the third is the one that bites:
>
> 1. `ig:accuracy` scored that post as a **correct ORGANIC**. The label it compares against
>    was itself derived from the caption, so the harness agreed with the classifier about a
>    post they were both wrong about. **A held-out test is only held out with respect to
>    what it measures.**
> 2. So **98% correct / 100% recall means "98% of what the caption can reveal"**, not "98%
>    of paid posts found". Recall on video-only placements is UNMEASURED, and by
>    construction unmeasurable by this harness.
> 3. Therefore **do not tune the prompt against a video-only miss.** There is nothing in
>    the text to learn from, so any edit that "catches" it is fitting noise — and this has
>    already been tried once here at real cost: an attempt to catch a dressed-as-commentary
>    post via "@-tags the brand's handle" cratered precision **85% → 71%**.
>
> What would close it is a different INPUT, not a better prompt — and that input EXISTS
> now: the text in the video's own frame, read locally and free (see "THE CAPTION IS NOT
> THE POST" above). It caught exactly this post, ORGANIC -> REVIEW.
>
> **The number below still means what it always meant.** `ig:accuracy` runs the production
> path now, so it measures whether reading the footage HARMS caption classification — and
> measured with footage off it is unchanged at 98%/100%/94%. What it still cannot measure
> is recall on placements that live only in the footage, because its labels are
> caption-derived: a post whose label came from its caption is no evidence about a post
> whose caption says nothing. That number can only come from human answers in the "Worth a
> look" queue on /paid-posts, and it does not exist yet. Never quote 98% as coverage.

**Edited again 2026-08-07, and the harness is what made it safe to.** As M.O.M's corpus
grew to 48 posts, recall regressed to 92% — one genuinely paid post
(`Dbss_t4k0tk`, Amazon NOW) was called ORGANIC because it was DRESSED as commentary
("A super creative marketing stunt to announce their new speed proposition"), the exact
framing the editorial protections exist to protect. The catchable signal, corroborated by
every one of Tabish's 33 known-paid posts: the brand's own campaign hashtag
(#AmazonNOW #FastNowFaydaNow) plus announcing the brand's new offering. **The first fix
attempt used "@-tags the brand's handle" as the signal and cratered precision 85% → 71%**
— M.O.M's genuine commentary tags handles too ("@drink818 has got their strategy spot
on") — which is exactly why no prompt edit ships without `pnpm ig:accuracy` before and
after. The narrowed rule (campaign-slogan hashtag + announcement, @-tag explicitly NOT
sufficient) measured **98% correct, 100% recall, 92% precision** — better than the
previous best on a larger n. Recall was never traded. **That recall is over CAPTIONS** — see
the warning box above before quoting it as coverage.

Measured 2026-08-03 while tightening the prompt: **67% → 85% → 96% correct**, false
alarms **9 → 4 → 1**, recall **100% throughout**. Without a number attached, "improving"
prompt wording is indistinguishable from breaking it.

The failure that produced those first two numbers is worth knowing: **M.O.M is a
marketing publication, so its EDITORIAL is commentary about other brands' advertising**
("How Uber entered football with a stroke of marketing genius"). The model read brand
names plus marketing language and called it promotion. The fix was telling it the
decisive question is *was this publisher paid*, not *does this mention a brand* — and
that writing ABOUT ads is a publisher's ordinary work.

**Protect recall, never trade it for precision.** A missed paid post is invisible and
unappealable; a false alarm becomes a draft a human reads before anything sends.

Verified on live @viralbhayani posts, the case no rule can reach: *"LV Man DJ
@sumitsethiofficial spotted at Kalina Airport #LVMan #KalinaAirport"* → **CAMPAIGN**
(Louis Vuitton menswear placement dressed as an airport spotting), while
*"#ShikharDhawan and his wifey #SophieShine giving us relationship goals"* → **ORGANIC**.
Identical syntax; only meaning separates them.

**A failed call is never recorded as a verdict.** No API key, a network error, or
malformed JSON all yield `UNCLASSIFIED` with `verdictSource: 'none'` — never a
fabricated `ORGANIC`, which would be indistinguishable later from a real judgement.
`verdictSource` (`rules` | `semantic` | `none`) exists so a `#Collaboration` fact is
never counted alongside a model's opinion.

`is_paid_partnership` is carried from the feed and overrides any heuristic. It is
`false` for both targets (neither uses Meta's native tool) but genuinely works —
validated 4/12 on `@bhuvan.bam22` with `sponsor_tags` populated. Free
future-proofing.

### Detection starts on 1 August 2026, in exactly two places

Set by Tabish 2026-08-03: *"we do not need to go back several posts or weeks... We start
only from 1st august posts and onwards."* It drops **381 of 746** stored posts from the
paid backlog.

`src/lib/cutoff.ts`, and it is deliberately NOT a global filter:

- **The classifier** — history is never sent to the model. A skipped post stays
  `UNCLASSIFIED`, which means *not judged* and has never meant *organic*.
- **`unusedCampaignCount`** — an old campaign must not count as "something new to say".

Where it must **not** apply, and this is the load-bearing part:

- **`buildVocabulary`.** The novelty filter learns how a channel writes from EVERY stored
  caption. Shrinking that baseline would make ordinary vocabulary look novel and degrade
  the free stage that saves half the model spend.
- **Storage.** Every slot still records everything. A corpus is cheap; a missing one
  cannot be reconstructed.

**The boundary is IST, not UTC** — like every other date boundary here. And a correction
worth keeping: at `HOOK_MAX_AGE_HOURS=72` from 3 August the hook window reaches back to
31 Jul 12:00 UTC, which is **earlier** than the cutoff (31 Jul 18:30 UTC = 1 Aug 00:00
IST). So the cutoff is the *binding* rule today, not a redundant check — reading
`hoursAgo(72)` and assuming otherwise is wrong by six and a half hours. `newMaterialFloor`
takes the later of the two so neither can be loosened by the other, and the hook *lookup*
uses the same floor as the *count*, because those two queries drifting apart has already
caused a bug here.

**`ig:classify` asks the detector now, and that fix stopped it spending money on our own
accounts.** It iterated every `TargetAccount` and ignored `detectorKey`, so it queued
`@bollywoodchronicle` and `@bollywoodsocietyy` — **accounts we own**, added as rehearsal
targets, 457 stored posts between them, 59 of which would have reached the model. Real
money, asking DeepSeek whether our own Bollywood pages run paid campaigns.
`passthrough.readiness()` already said *"this channel has no classifier set up"* in those
words; the script simply never asked. Third instance of this exact shape — see the
"Ask the detector, never compare the key" note under Style.

**AND THEN @bollywoodsocietyy was deliberately switched TO `semantic` on 2026-08-06**
(simple-sender plan step 9) — a recorded reversal, not a regression. The distinction:
**watching our own page for GROUND TRUTH is not prospecting it.** Our own pages are the
only channel where we know which posts were actually paid, so classifying them is what a
second accuracy harness is made of. Backlog classified the same day: 103 posts, $0.0019,
92% cache hit, 6 campaigns. Nothing about this makes it a recipient. The audit row
`target.detector.changed` records it.

**Tabish's known-paid list is stored as `KnownPaidPost`** (33 shortcodes, 9 brands,
2026-08-06). 0 of 33 are in the corpus and their captions cannot be fetched anonymously
(four endpoints probed, all dead) — so they are LABELS WITHOUT TEXT until a deeper feed
backfill of the pages that posted them. Ask Tabish which of our pages those are (one URL
names `bollywoodpaparazzii`). Three brand handles were verified against Instagram's own
profile data and imported as BRAND targets with pairs disabled (@crocsindia,
@nutellaindia, @luxindia); Adidas, U.S. Polo India, Rungta Steel, KFC, Bonkers and Titan
Eye+ could NOT be verified (Instagram's category-schema bug, mostly) and were deliberately
not guessed.

Note `readiness` is **optional** on the interface and an absent one means READY: `mom` does
not implement it because a deterministic rule set is always able to judge. Treating absent
as not-ready would have silently excluded the only channel with exact ground truth — the
one `pnpm ig:accuracy` measures everything against.

**Measured after the drain (2026-08-03):** 62 posts reached the model, cache hit **86%**
(baseline, so the prompt cache is intact), total spend **~$0.0016**. Paid campaigns went
**14 → 31**. `pnpm ig:accuracy` then read **97% correct, 100% recall, 86% precision** —
up from the documented 96%, with recall still perfect.

**The prompt was NOT edited.** One verdict looked arguable in isolation — an actor
celebrating his own series role, called CAMPAIGN at 85%. Read against all 25 CAMPAIGN
verdicts the pattern is clearly right: film and music promotion IS the dominant commercial
category on this channel (trailer launches, release dates, Netflix/Zee5 titles, a brand
ambassador announcement, a hospital's IVF event with a registration link). Studios pay
paparazzi accounts for exactly this. Editing a 97% prompt to fix one borderline call that
cannot be shown wrong is the "improving wording is indistinguishable from breaking it" trap
the accuracy harness exists to prevent — and recall is never traded for precision.

### No other data source helps. This was checked, not assumed

Asked 2026-08-03 whether a scraper or the Meta Graph API would beat the anonymous feed
endpoint. Both were investigated against `~/Desktop/social-scrapers` and the live docs:

- **Meta Graph `business_discovery`** is ToS-compliant and reads any public
  business/creator account — but the complete IG Media field reference contains **no
  branded-content, paid-partnership or sponsor field of any kind**. The only
  ad-adjacent fields (`boost_ads_list`, `boost_eligibility_info`) describe *your own*
  paid promotion of *your own* media and are unavailable through `business_discovery`.
  It also returns strictly LESS than we already have: caption + permalink + timestamp,
  where our endpoint adds `is_paid_partnership`, `sponsor_tags`, `coauthor_producers`
  and `usertags`. And it needs a Meta System-User token plus App Review.
- **A browser scraper** returns the same captions our HTTP call already returns, while
  adding a browser per channel per slot and — if it ever used a logged-in session —
  converting an IP-level risk into an account-ban risk. Decision 4 forbids that.

**The general point: no API will ever tell you a post was paid when the publisher did
not disclose it.** `is_paid_partnership` reflects Meta's native Branded Content tool —
a publisher choosing to tag a sponsor. Undisclosed is undisclosed at the source. That
is why the answer is a classifier and not a different endpoint.

**Reliability, measured.** Three consecutive full slots (4 channels x 4 pages, real
700ms inter-page delay): **48/48 HTTP 200, zero failures**, median 1090ms, 144 posts
per channel. The earlier PARTIAL runs were transport throws with no retry, not endpoint
unreliability. Keep `feed/user/<handle>/username/`.

### Resolving a brand has FOUR outcomes, not two

`src/detection/resolveBrand.ts`. `pnpm ig:brands` walks CAMPAIGN captions, pulls their
@mentions, and asks Instagram's anonymous profile endpoint what each one is.

A film-promotion caption tags its cast, its director, and often a politician at the
launch. Messaging those is useless and is the scattergun contact that gets accounts
reported. The endpoint separates them:

```
@royalcanin.india   is_business_account=true   "Grocery & Convenience Stores"  ← buyer
@elvish_yadav       is_business_account=false  "Artist"  21M followers          ← talent
```

The four outcomes exist because **two of them are different kinds of "don't know"**:

| | meaning | retry helps? |
|---|---|---|
| `BRAND` | professional account, category is not a person-role | — |
| `PERSON` | a person-role category, or a non-pro account WITH a category | — |
| `UNRESOLVED` | we READ the profile and could not tell, **and the model was not confident either** | **no** — the data is not there |
| `UNKNOWN` | we never got to look: rate-limited or network error | **yes** |

The first version collapsed `UNRESOLVED` into `PERSON`, and that is the bug this table
exists to prevent: **missing data hardening into a negative verdict.** A brand that
simply left its category blank would have been discarded permanently with nothing on
screen to say so. Caught 2026-08-03 when `@farhadsamji`, `@iamzahero`,
`@jas_manchester` and `@thisisdsp` were all filed PERSON on `category: null` alone.

`UNKNOWN` is cached but **never read back as an answer** — an unanswered lookup must
never become "not a brand".

**`UNRESOLVED` USED TO MEAN "a human must decide", AND SINCE 2026-08-08 THERE IS NO HUMAN
QUEUE.** Tabish: *"The channels which are undecided must also be decided on their own. How
can adidas not be recognized as anything? I do not want this option to select manually,
correct it."* The manual **company / not-a-company** buttons on the brands panel are
deleted along with `confirmBrand` and `dismissBrandCandidate`; a model answers first, and
`UNRESOLVED` now means the endpoint could not tell **and the model would not commit
either**. See the next section. The dashboard shows what was decided and why, rather than
asking.

**The endpoint is NOT rate-limited. It is partly broken, and that is a different
problem with a different fix.** This corrects an earlier entry here.

The original measurement — *"7 of 10 lookups returned HTTP 400 even at 2.5s spacing"* —
was recorded as aggressive rate limiting. **Re-measured 2026-08-03 and that reading was
wrong.** Interleaving a known-good control handle between eight lookups returned
**HTTP 200 every single time**, so nothing was throttling. The 400s are per-handle and
permanent, and the body says why:

```
{"message":"Asset asset://laser.provider/ig_business_category_subvertical
  has been deleted. You cannot use this schema","status":"fail"}
```

Instagram is serialising a business-category sub-vertical whose schema Meta deleted. It
fails for accounts that HAVE such a category — so it breaks on **precisely the accounts
most likely to be brands**. `@netflix_in`, `@tseries.official` and `@tilara.india` are
unreachable; a 40-follower private account resolves fine.

**Why the misdiagnosis was expensive.** Any non-OK status set `rateLimited`, which halts
the *entire run*. So one broken-schema handle stopped every remaining lookup, cached them
`UNKNOWN`, and reported "rate-limited". **Three consecutive `pnpm ig:brands --run` passes
made zero progress** — `not-yet-looked 10` each time — while the endpoint was healthy. A
per-item failure escalated to a run-wide stop has unbounded blast radius from one bad
row, and it wears the costume of the safe conservative choice. After the fix the same
command drained the queue to `not-yet-looked 0` and found `@royalcanin.india`,
`@amazondotin` and `@kalkifashion`.

`interpretLookupFailure` now separates the three cases: the schema bug is `UNRESOLVED`
and continues (retrying cannot help, so `UNKNOWN` would retry forever and never drain);
**429/401/403 still halt**, because continuing after being told to stop is what turns
throttling into an IP block; anything else retries that one handle. Both directions are
tested.

Lookups still run 6s apart. That was chosen for politeness against an undocumented
endpoint and the diagnosis changing does not make hammering it wise.

**Instagram's category taxonomy names PROFESSIONS, not just business types**, and two
wrong prospects reached the database before this was noticed. `@bharat_reshma`
("Fashion Designer", 938k followers) was filed **BRAND**; `@mind_shifters`
("Advertising/Marketing") was created as a prospect — an *agency*, the other side of the
table from a media seller, and `tests/detectors.test.ts` already asserted that exact
handle must be dropped as "the agency" in the hook-line path. **The rule existed in one
half of the system and not the other.**

Both are `is_business_account: true`, so the fix is the check ORDER as much as the list:
category is examined **before** account type, because a business-first test files a
designer and an agency as buyers. `classifyProfile` and `interpretLookupFailure` were
extracted as pure functions for this reason — the logic lived inside an `await fetch()`
and therefore had no tests at all, which is why both misses shipped.

**Never guess a handle.** Only real @mentions are resolved. A bare name like
"RoyalCanin" is not turned into `@royalcanin` — that handle returns **HTTP 404**,
measured. Messaging the wrong account is worse than messaging nobody.

**Pairs are created live, and discovering a prospect IS now deciding to message them**
(2026-08-08 — until then they were created DISABLED and a person flipped a chip). What
bounds "one run could otherwise queue hundreds of strangers" is no longer a switch: the
per-pass lookup bound (10), `MAX_NEW_BRAND_TOUCHES_PER_DAY` (2 first touches a day across
the fleet), and the per-target and per-sender caps. That is a real bound and a thinner one;
it is named in the exposure paragraph under "AUTOPILOT IS ONE SWITCH" rather than smoothed
over. `src/outreach/brandTarget.ts` is the ONE place a discovered brand becomes a
`TargetAccount`, shared by the CLI and the unattended pass, and it asks `routes.ts` which
routes may exist rather than hand-rolling the filter.

### @adidas is unreadable by rule, so a MODEL answers that one question

Built 2026-08-08 on Tabish's instruction (quoted in full under "AUTOPILOT IS ONE SWITCH").
`@adidas`, `@crocsindia` and `@bonkerscorner` all rendered as *"could not read this
account"* with manual buttons beside them, because Meta's deleted category sub-schema
returns HTTP 400 on precisely the accounts most likely to be brands.

**No rule over the readable fields can fix that, and it was MEASURED rather than assumed:**
`@tilara.india` (a brand) and `@adityathackeray` (a politician) are **byte-identical on
every field we can read anonymously**. What separates them is world knowledge plus the
sentence the handle was mentioned in — the same judgement the caption classifier already
makes one modality over. A rule would message the politician, so he is a required fixture
in `tests/decide-brand.test.ts`.

`src/detection/decideBrand.ts` — `deepseek-v4-flash`, thinking disabled, temperature 0,
`json_object`, and the **system prompt is a module-level constant with nothing interpolated
into it**, exactly as `semantic.ts` requires (the cache discount is 50× and destroying it is
silent and permanent). Brand spend is its own line on `/cost`: `'resolve'` is a fourth
`ModelPurpose`, so it can never be mistaken for classification spend.

**THE ASYMMETRY DECIDES THE DESIGN.** A wrong "company" puts a media-buying pitch in a
private person's DMs from a revenue account; a wrong skip costs one prospect, visibly and
retryably. So:

- **`'unsure'` is honoured REGARDLESS of the confidence number.** A model claiming 99%
  certainty that it is uncertain is still uncertain, and reading the number instead of the
  answer would let a formatting quirk decide a prospect.
- **`RESOLVE_CONFIDENCE_FLOOR = 90`, and a sub-floor PERSON is `UNRESOLVED`, not `PERSON`.**
  PERSON is a cached answer that never retries, so filing a low-confidence guess there would
  permanently discard a real prospect on evidence the model itself did not trust — *absence
  of data hardening into a negative verdict*, one door along, for the fifth time here.
- **A failed call decides NOTHING** — `null`, never a verdict. Same contract as
  `classifyCaption`. `Number(x) || 0` floors a missing confidence at **zero rather than
  NaN**, because NaN fails every `<` and would sail through the floor check as a confident
  BRAND — the one failure mode this file exists to prevent.

**Wired in through `applyModelToUnresolved`, and the ORDERING is the safety argument:**

- **The ENDPOINT wins whenever it answered.** BRAND, PERSON and MISSING pass through
  untouched. Instagram's category data is a FACT; the model's world knowledge is a
  judgement, and a judgement does not overrule a fact.
- **`UNKNOWN` passes through too, and that is the one nobody would notice being broken.**
  Both UNKNOWN and UNRESOLVED read as "we do not know" on screen, but UNKNOWN means the
  lookup NEVER HAPPENED, so it is retried. Deciding it here would swap a guess made with no
  profile facts for a lookup about to succeed — and cache it forever.

`decidedBy` (`endpoint` | `model` | null), `modelConfidence` and `modelReason` are recorded,
so an auto-created prospect is auditable months later. The brands panel is **"Decided
automatically"** with the model's reason in prose; confidence is carried and deliberately
NOT rendered (no confidence scores on a page a CEO reads). It filters `decidedBy: 'model'`
alone — endpoint-settled and historic human rows are excluded for the same reason
`verdictSource` keeps a `#Collaboration` fact apart from a model's opinion. Anything not
BRAND reads **"left alone"**, never "not a company": PERSON and UNRESOLVED are different
facts and neither is proof of a negative.

**AND IT RUNS AUTOMATICALLY, which is the half that would otherwise not have shipped.**
`src/detection/autoResolve.ts` runs at the end of **every detection pass** — it walks the
@mentions of in-window CAMPAIGN captions, skips everything already answered, and turns a
BRAND verdict into a prospect with nobody present. Bounded at **10 lookups a pass**, and the
bound counts **LOOKUPS ATTEMPTED, not brands created**: a pass that resolves ten people
spends exactly as much of a scarce endpoint as one that resolves ten brands. A real throttle
(`UNKNOWN`) stops the pass; Instagram's permanent 400 (`UNRESOLVED`) does not — reading those
two as one thing already cost three consecutive zero-progress runs against a healthy
endpoint. The pass **never fails a detection run** (decision 5, one layer along).

Tasks 10 and 11 built the resolver and wired it into `resolveBrand`, and **nothing called it
on the automatic path** — `@adidas` stayed unrecognised until a person ran `pnpm ig:brands
--run`. That is the exact shape of the 166-cover-frames finding: *a feature that works only
when someone runs a command is not running.* `tests/auto-resolve.test.ts` asserts the
pipeline calls it, for the same reason `tests/one-judging-path.test.ts` exists.

**A `settled` predicate would have looped forever without moving.** The plan treated an
UNRESOLVED row with `modelReason === null` as "the model has not been asked yet" — but
`resolveBrand` returns a cached UNRESOLVED *before* `applyModelToUnresolved` is reached, so
a row the model declined and a row the model never saw are indistinguishable by that field
(a failed call writes null too). Re-listing either would ask a cached question every fifteen
minutes, burning the whole per-pass bound on handles that cannot move and starving the new
mentions the pass exists to find. **The model gets one chance per handle.**

### Messaging a brand is a different proposition, with two guards of its own

Built 2026-08-03. Four confirmed buyers so far: `@royalcanin.india`, `@amazondotin`,
`@kalkifashion`, `@milano_icecream_bangalore`.

**The pitch inverts.** `variants.ts` offers a **partnership** to a fellow publisher — peer
to peer, media owner to media owner. A brand is not a peer: it is a buyer that has just
*proved it has budget* by paying a publisher. So `brandVariants.ts` offers **media buying**
— you are already buying reach on entertainment publishers, we own that inventory. Same
network numbers, different ask.

`MessageVariant.targetKind` keeps the two pools apart, and it is load-bearing rather than
tidy: variant selection is keyed on `senderId` alone, so without it the LRU would
eventually hand a media-buying body to `@madovermarketing_mom` and a publisher-partnership
pitch to Royal Canin. Nothing would report a problem — the message would simply be
addressed to the wrong kind of reader, which is only ever discovered by reading a sent DM.

**The first touch names the real placement.** `TargetAccount.discoveredFromCampaignId`
exists for this: *"I saw Royal Canin's placement with Mad Over Marketing last week."* A
verifiable fact about one recipient, which is what decision 3 asks for and what a template
can never be. Tabish initially chose a generic category-level opening and switched after
seeing both rendered side by side — the generic paragraph was identical for all four
brands, i.e. a template with no variation aimed at people who read pitches for a living.

It **degrades honestly**: no known publisher means no specific claim, so the opening drops
to a general observation rather than inventing a placement. Recency is banded ("last week",
"recently") not dated — a precise date reads as surveillance and is embarrassing when the
timestamp is off by a day. Both negatives are tested.

**`MAX_NEW_BRAND_TOUCHES_PER_DAY`, default 2.** Separate from `dailyCap` because they guard
different things: `dailyCap` protects the ACCOUNT (Instagram's per-sender heuristics), this
protects the PATTERN. Ten first-touches in one afternoon and ten across ten days are the
same volume and look nothing alike — the first is indistinguishable from a scraped list
being worked through. **Only first touches count**; a follow-up is a continuing
conversation already spaced by `cooldownDays`. Counted within a run as well as from the DB,
or every queued brand would pass the same stale check and a cap of 2 would send twenty.

**The persona gate — decision 3b, enforced rather than documented.** A brand pitch is
refused while that sender's persona is byte-identical to another sender's. All four
accounts still carry *Kapil Jain, Co-founder, Bollywood Society*, so **every account is
currently blocked from brand outreach** — the safe direction, and deliberately visible on
the dashboard rather than silent. Verified in all four directions against the live
database: blocks all four senders on brands, allows channels, releases when a persona is
made distinct, and the cap allows at 0–1 and blocks at 2.

`validatePersona` checks SHAPE and passes happily on four identical blocks; distinctness is
the property that was missing. **Do not satisfy this gate by generating personas** — who
fronts each brand is Tabish's to answer, and a plausible invented name in a real DM is
worse than a blocked send. Personas are now editable on the dashboard, because the reason
this survived weeks of use is that the persona was in every outgoing message and on no
screen.

**Two seeding gaps found, both the same shape.** `prisma/seed.ts` iterated its hardcoded
`SENDERS` list and `addSender` copied only the channel pool — so `@tabishmukaddam1`, added
via the dashboard and designated for brand outreach, had 12 channel variants and **zero**
brand variants. `plan.ts` throws when the pool it needs is empty, so the first brand pair
would have failed for the one account meant to send them. The seed now backfills every
sender in the database, and `addSender` copies both pools.

**A brand is addressed as a team.** `contactFirstName` means a PERSON's first name and we
do not know who runs a company's Instagram account, so it is null for brands and
`buildGreeting` produces "Hi Amazon India team,". It had been set to the company name,
which addressed a corporation as an individual. And `greetableName` trims Instagram display
names before "team": "Milano Ice Cream, Bangalore" produced **"Hi Milano Ice Cream,
Bangalore team,"** — ungrammatical, in the first line a prospect reads. Both were found by
rendering the real message to the real prospects, which the tests alone did not do.

---

## Layout

```
prisma/
  schema.prisma        19 models. SQLite: no arrays/enums → JSON + string unions.
                       `SenderAccount.fleetMember` is IDENTITY, not a switch — with the
                       route chips gone it is what keeps the burner out of automatic
                       outreach. `BrandLookup.decidedBy/modelConfidence/modelReason`
                       record WHO answered "is this a company"
  seed.ts              idempotent; renames legacy handles in place
  bespoke.ts           4 per-recipient messages — READ THE HEADER COMMENT
  variants.ts          12 fallback bodies — the CHANNEL pool (partnership)
  brandVariants.ts     6 follow-up bodies — the BRAND pool (media buying). A different
                       proposition, not reworded channel copy
src/
  detection/
    feed.ts            anonymous feed endpoint — NO CREDENTIALS, EVER. Also CAPTURES the
                       reel's cover-frame + video URLs (they EXPIRE, so a corpus without
                       them cannot be re-examined). `pickThumbnail` is pure: smallest frame
                       >=480px, largest as fallback, never null when anything exists
    cadence.ts         detection's OWN clock — 15 min, NOT the send slots. Tabish, 2026-08-07
    detectors/mom.ts   #Collaboration rules + brand extraction
    detectors/passthrough.ts   stores, judges nothing, and SAYS so
    detectors/novelty.ts       stage 1: hashtags atypical for THIS channel. Free, and it
                       SCORES ONLY — the veto was deleted 2026-08-07 after it silently
                       hid 76 posts from the model, 49 on one rare tag
    detectors/semantic.ts      stage 2: DeepSeek reads the caption. Cached prompt
    ocr.ts             READS THE TEXT IN THE PICTURE, locally and free — Apple Vision via
                       a Swift helper compiled once (tesseract fallback, measured worse:
                       it missed `SWITCH`). Groups text by SIZE and never by significance,
                       because a geometry fact must not assert a meaning claim. Four
                       outcomes: read / no-frame / unavailable / failed — only `read` may
                       reach a verdict. Fences the text as quoted evidence
    frameSignal.ts     PURE permission table. The footage may raise caption ORGANIC to
                       REVIEW and NOTHING else — never mints, overturns, clears or demotes
    decideBrand.ts     the model answers the ONE question Instagram's endpoint cannot:
                       is this @mention a company or a person. `interpretDecision` is
                       PURE. Floor 90, `'unsure'` honoured whatever the number says, a
                       failed call decides NOTHING. The asymmetry is the design — a wrong
                       "company" DMs a private person from a revenue account
    autoResolve.ts     and it RUNS, at the end of every detection pass, with nobody
                       present. Bounded at 10 LOOKUPS (not 10 brands — a pass that
                       resolves ten people spends the same scarce endpoint). Never fails
                       a detection run
    evidence.ts        the captured evidence about a post, built in ONE place and
                       REFRESHED when a publisher edits it. `evidenceRefresh` is PURE and
                       returns null when nothing moved — without that comparison the
                       known-post loop would write ~18,000 rows a day to say nothing had
                       happened. Media URLs are deliberately excluded from the comparison:
                       they rotate constantly and the BYTES on disk are the evidence
    tagEvidence.ts     who a post TAGS, as fenced evidence for the classifier. PURE
                       formatter, allowlisted handles, and a block that is OMITTED
                       ENTIRELY when there is nothing to say — so an untagged post's
                       prompt is byte-identical to before this existed. **OFF**
                       (`tagsAsEvidence`): measured precision 90% -> 83% with it on
    media.ts           frames as BYTES on disk (~/.ds-sales-agent/frames), because the
                       CDN URL is what expires — and the refresh the old design relied on
                       never ran. Saved for every new post on every channel; idempotent
    pipeline.ts        orchestration, idempotent on shortcode
  outreach/
    pacing.ts          PURE. When may the fleet send, and when must it STOP. Active
                       hours, the minimum gap, the circuit breaker
    rotation.ts        PURE ring. `fleetRingOrder` is the ring for a recipient in NO group —
                       the normal case, since `Category` has never had a row. Ordered cohort
                       then handle, and every member enabled: ability is the caller's
                       `unavailable` map, re-asked at delivery by gate.ts
    cohorts.ts         PURE ladder + its DB reader. Phase 9: a group of accounts sends
                       for 14 days before the next may send. ONE stored column; the soak
                       is DERIVED, and `live` means CAN SEND (session + ACTIVE), not an
                       arming bit. `mayArmAccount` keeps its name and is now the ladder's
                       ONLY enforcer — gate.ts calls it at delivery. Do not delete it
    availability.ts    WHICH ACCOUNTS ROTATION MUST SKIP — one reader, three callers (planner,
                       dashboard, ig:dedupe-drafts), so a page can never name an account the
                       planner will not use. Every fact is MACHINE-INDEPENDENT: there is no
                       `profileStatus` read, because the host that drafts has no Chrome
                       profiles at all and a filesystem answer there stops drafting fleet-wide
    usableName.ts      PURE. May this stored displayName be put in front of a prospect? The
                       obvious normalise-and-compare rule matches 47 of 68 live BRAND rows
                       including "Amazon MGM Studios" — this one refuses only a name with no
                       whitespace, all lower case, that normalises to the handle
    duplicateDrafts.ts PURE. Which of several drafts to one recipient survives. Reuses
                       `nextSender` on a ring narrowed to the senders that actually hold a
                       draft, so the keeper is always a draft that exists. NEVER discards the
                       last one — including when no account can send today
    discard.ts         `discardAttempt` — the ONE writer that turns a waiting draft into
                       SKIPPED. Extracted from the `skipAttempt` server action, which a
                       terminal cannot reach. What must not drift is the status guard INSIDE
                       the update: applied to a SENT row it would erase send history
    routes.ts          PURE. The ONE definition of which sender→target routes may EXIST,
                       since a pair row is a live route (2026-08-08). Never self-pair,
                       never pair one of OUR OWN PAGES to another — `addTarget` on a
                       fleet handle created exactly that. Takes HANDLES, because a sender
                       row and a target row for one account have different ids
    brandTarget.ts     the ONE creator of a BRAND TargetAccount, shared by the CLI and
                       the unattended pass. Asks routes.ts; `watchEnabled: false`
                       explicitly, against a schema default of TRUE
    qualityGate.ts     PURE. May a GENERATED body be sent. Bounds MEASURED from the 25
                       shipping bodies. Says out loud what it cannot check
    generate.ts        Phase 8. The model writes the middle. CONSTANT system prompt —
                       nothing interpolated, ever; the cache discount is 50x
    dispatcher.ts      the paced tick, and the fleet-wide SEND LOCK. One clipboard,
                       one send — every path that drives a browser goes through it
    challenge.ts       markChallenged — the ONE writer of CHALLENGED + challengedAt.
                       Four callers; a fifth forgetting the timestamp would make the
                       breaker read "nothing was flagged"
    sessionHealth.ts   markSessionInvalid — the ONE writer of sessionInvalidAt, the §3.5
                       fix. A send that hits a login form records the DEAD session; the
                       gate folds it into the existing no-session stop via sessionUsable;
                       cleared only by an identity-verified login or a delivered send
    importProspects.ts a pasted sheet → prospects. Parsing PURE and separate; the
                       writing half is small on purpose. DRY RUN BY DEFAULT
    brandGuards.ts     the two guards that exist only for brands: the new-brand daily
                       cap, and the persona gate (decision 3b, enforced not documented)
    brandPitch.ts      the FIRST message to a brand, from the campaign it was found in.
                       Names the real placement; never invents one
    governor.ts        pure safety gate — may we CREATE a message for this pair
    gate.ts            pure re-check — may an EXISTING draft still be sent now. TEN stops
                       since 2026-08-08 (the two switches went; every INVARIANT stayed).
                       Shared by sendNow and deliverWaiting; they drifted TWICE — the
                       second time deliverWaiting held on a switch the gate had dropped,
                       and /messages said "Clear to send" over it. OVERRIDABLE_BLOCKS is
                       now exactly [TARGET_REPLIED], typed and read via `isOverridable`
    onDemand.ts        "send a message now": force-draft to a chosen pair, and turn
                       every rule the governor would have refused on into a sentence
    replyCheck.ts      automatic reply detection, 11:00 and 20:00. The only writer of
                       repliedAt that does not need a human to remember
    browser/readThread.ts  opening and reading a real conversation. ONE implementation,
                       shared by ig:thread and replyCheck — which was NOT true until
                       2026-08-05 despite the docblock saying so. Observes DURING the
                       dwell and REPORTS whether it saw the whole thread
    browser/pruneProfile.ts  reclaim browser cache without touching device identity.
                       ALLOWLIST of deletable paths; asks the OS whether Chrome is open
    render.ts          message assembly, persona validation
    matching.ts        "is this text ours?" — pure, tested. Also the send guard
    plan.ts            DB-driven planner. `ensureFleetPairs` creates every fleet route
                       automatically (routes are not chosen any more). It has exactly ONE
                       .send() call site and it is hardcoded to manualAssistSender — the
                       planner CANNOT deliver, now asserted by tests rather than a comment
    deliver.ts         autopilot delivery of already-waiting drafts. Re-checks only what
                       can have MOVED since the query — never a second copy of a rule
    browser/
      profile.ts       one Chrome profile per account — READ THE HEADER COMMENT
      session.ts       Patchright launch, checkpoint + wrong-account detection, and WHO
                       THIS PROFILE IS. `identify` has three answers and `unknown` is the
                       load-bearing one: `readIdentityResponse` is PURE and returns
                       `no-answer` for anything that did not answer, because a dead endpoint
                       reading as "logged out" broke Connect, every send, AND wrote a
                       dead-session mark on a live session. Two endpoints, tried in order
      sendDm.ts        the actual send. Highest-risk file in the repo
    senders/manual.ts  prepares only, delivers nothing (the fallback)
    senders/browser.ts drives the profile and delivers (the default)
    browser/connect.ts dashboard login: open window, poll, close. Same flow as the CLI
  detection/exists.ts  anonymous "does this handle exist?" — used before adding
  detection/resolveBrand.ts  @mention → BRAND | PERSON | MISSING | UNRESOLVED | UNKNOWN.
                       FIVE outcomes — two of them are different kinds of "don't know".
                       `applyModelToUnresolved` asks decideBrand when the endpoint could
                       not tell: the ENDPOINT WINS whenever it answered, and UNKNOWN is
                       passed through untouched because it means the lookup never happened
  detection/enrichHandle.ts  facts about handles Instagram's category endpoint cannot
                       serve. Gathers, NEVER classifies — see the header for why
  lib/cutoff.ts        1 August onwards. Applies to the CLASSIFIER and to new-material
                       only — never to storage, never to buildVocabulary
  lib/urls.ts          the ONLY place Instagram URLs are built
  lib/platform.ts      the ONLY place we branch on macOS vs Windows
  lib/password.ts      scrypt from node:crypto. NOT bcrypt/argon2 — both are native
  lib/session.ts       dashboard sessions; tokens stored HASHED. requireUser() lives here
  lib/session-cookie.ts  just the cookie name. Imports NOTHING — middleware runs on Edge
  lib/safe-next.ts     sanitises ?next= . Rejects //evil.com, the case that gets missed
  worker/scheduler.ts  the watch itself: 4 IST slots, catch-up-on-boot, heartbeat — plus
                       DETECT-then-DRAFT every 15 min (2026-08-11) — except the DRAFT half
                       is gated on `autopilotEnabled` and therefore NEVER RUNS today, while
                       `runSlot` drafts unconditionally. The two paths disagree; see
                       finding 2 at the top of CLAUDE.md. Drafting takes the
                       SLOT LOCK: `noOverlap` is per TASK, and minute 0 is always a
                       multiple of 15, so the two collide four times a day by construction
  worker/index.ts      `pnpm worker` — the same scheduler as its own process
  scripts/             login, send, queued, agent, audit, preview, inspect, reclassify
    reply.ts           record a reply by hand — the only writer of repliedAt besides thread.ts
    thread.ts          read a real conversation back: send verification + reply detection.
                       DOM shape is OBSERVED (2026-07-31) and will drift — see --debug
    classify.ts        `pnpm ig:classify` — backfill stored posts. DRY RUN BY DEFAULT
    accuracy.ts        `pnpm ig:accuracy` — held-out test of the classifier prompt
    brands.ts          `pnpm ig:brands` — captions → brand targets. DRY RUN BY DEFAULT
    replies.ts         `pnpm ig:replies` — the scheduled reply check, on demand
instrumentation.ts     starts the scheduler inside the dashboard (hands-free)
src/
  middleware.ts        the front door. DENY BY DEFAULT — lists public paths, not private
  app/                 SEVEN pages (plus /settings) behind a sidebar, since the 2026-08-06
                       simple-sender redesign (docs/specs/2026-08-06-simple-sender-plan.md).
                       AUTOPILOT IS THE PRODUCT, so the landing page is Autopilot; the
                       mechanism that keeps pages short is /rules, the destination for
                       every rationale paragraph that used to sit beside a button. Retired
                       routes (/messages, /conversations, /channels, /prospects, /accounts,
                       /accounts/login) keep JSX-free redirect stubs so bookmarks land
    nav.tsx            the SIDEBAR. `GROUPS` is the single source of the IA. It also owns
                       SIGN-OUT, which used to render inside the amber health card
    page.tsx           **Autopilot** (landing) — is it sending, and if not exactly what is
                       stopping it: the switch, per-account readiness, uncertain sends,
                       replies waiting, the pace, the queue with each draft's refusal from
                       `recheckBeforeSend`, and manual send (the same queue, one draft
                       earlier). The alarm card holds the dot and the sentence, nothing else
    targets/           **Targets** — who we write to and whose posts we read; absorbed
                       Channels and Prospects. The list is the master view; the cards
                       answer "is reading their feed working". ONE LINE per recipient
                       instead of a chip per route — retired, or messaged by rotation with
                       N accounts ABLE to send. `sendersAble` is ability, so it reads zero
                       when the fleet is signed out even with the switch on
    senders/           **Senders** — our accounts; absorbed Accounts and Sign-ins. Three
                       signed-in states per row, from EVIDENCE (§3.5): signed in ·
                       needs signing in again (found logged out at X) · never signed in.
                       Ability is a SENTENCE, not a switch, since 2026-08-08 — "Sends
                       automatically while Autopilot is on" / "Needs a one-time sign-in";
                       a flagged row says neither, because it carries its own remedy and
                       "needs a sign-in" is simply wrong about it
    paid-posts/        **Paid posts** — the verdicts as a TABLE with a link per post
                       (`postUrl` in lib/urls.ts), and the brands panel.
                       UNCLASSIFIED is counted separately because it means NOT JUDGED.
                       The Posted column carries the IST HOUR — `12 Aug (16:42)` — because
                       @viralbhayani published 84 posts before 09:00 IST over 14 days and
                       ZERO were paid, so the hour is half the judgement. A post found far
                       behind publication says "found 15h later", and ONLY past an hour:
                       the measured split is bimodal (p50 8.2 min, and every outlier over
                       12h), so lateness means the WATCH had a gap, not a slow pass
    paid-posts/review.tsx    the queue, and a FIVE-SECOND window before a label is written
                       at all. The write is DEFERRED, never written-then-reversed — a
                       compensating delete would leave an audit trail saying a person
                       labelled and unlabelled a post, which is not what happened. It
                       flushes on unmount and on `pagehide`, because a label silently lost
                       because someone changed page is worse than one that lands. Verified
                       in a real browser in all three directions, with the writes
                       intercepted so no test could mint a `verdictSource: 'human'` verdict
    paid-posts/settled.tsx   **the release**, and the undo is worthless without it: every
                       human answer, with the footage shown UNCONDITIONALLY, and one
                       control to change it. 21 posts — including both founding cases —
                       were labelled `paid=false` by a bulk CLI in August and were
                       reachable from no screen at all
    rules/             **Rules** — one line per rule, values IMPORTED from the modules
                       that enforce them (pacing.ts, env, Setting rows, gate.ts), with
                       STOP_LABELS total over RESEND_BLOCKS so a new stop cannot be
                       missing a sentence
    analytics/         **Analytics** — found / sent / replied / reply rate, the coverage
                       caveat, open conversations, the activity feed and the history
    cost/              **Cost** — spend, calls, failures, cache hit, per channel
    coverage.tsx       the "counted from 2 of 5 channels" caveat. ONE component, two pages —
                       a caveat travelling with its number must not drift from it. Grouped
                       by REASON, never merged: two problems with two fixes are two sentences
    messages/waiting.tsx  a draft, and WHY IT CANNOT BE SENT — from `recheckBeforeSend`, the
                       same gate that would refuse it. Never re-derived, never summarised
    messages/remedy.ts where to fix each refusal. The gate says WHY, this says WHERE, and
                       `href: null` is a real answer. TOTAL over RESEND_BLOCKS, enforced
    on-demand.tsx      pick sender + channel, write, confirm what is being crossed, send.
                       On the Autopilot page, because it is an action rather than a place
    replies.tsx        a reply, its text, and the button that releases the halt
    brands.tsx         companies found in paid posts. **"Decided automatically"** since
                       2026-08-08 with the model's REASON in prose and no buttons — the
                       manual company / not-a-company queue is gone (Tabish). Filters
                       `decidedBy: 'model'` alone; confidence is carried and deliberately
                       not rendered; anything not BRAND reads "left alone", never "not a
                       company", because PERSON and UNRESOLVED are different facts
    messages/dispatcher.tsx  the pace, the halt, and what the last tick did. A toggle
                       that promises behaviour must show whether anything is behind it
    messages/uncertain.tsx   sends that cleared the composer and never appeared, with
                       the only two answers that settle one
    auth-actions.ts    sign up / in / out — the ONLY actions that work without a session
    auth-form.tsx      one form, two modes
    sign-in/, sign-up/ the only two public pages
  scripts/layout.ts    `pnpm ig:layout` — opens every page in a REAL BROWSER and asserts
                       geometry, that every asset loads, and that the stylesheet APPLIES.
                       Presence is not layout, and a 200 is not a stylesheet
tests/                 1,281 tests, fixtures captured from live posts
tests/rotation-fleet.test.ts  the PRODUCER of a ring, against a real database — `rotation.test.ts`
                       covers `nextSender` thoroughly and is handed a ring as a fixture, so the
                       whole suite asserted what rotation DOES with one and nothing asserted
                       that anything ever BUILDS one. Nothing did. Mutation-tested: deleting the
                       cohort+handle sort left all 19 green until the fixtures were inserted in
                       the OPPOSITE order to the answer they expect
tests/usable-name.test.ts  both tables are the REAL live display names, and the second — the
                       names that must SURVIVE — is the half carrying the weight: the naive rule
                       fails 15 of these
tests/person-category.test.ts  every category string is one Instagram actually returned. "Film
                       Director" never matched a set containing 'director'
tests/hook-staleness.test.ts  a frozen body's dated claim, in both directions, including the one
                       that must fail closed: a claim we can no longer date is STALE, not safe
tests/tag-evidence.test.ts  the tag block both ways, the injection payloads a handle could
                       carry, and a SOURCE GREP asserting every `classifyCaption` call
                       passes tags and every `judgeWithFrame` gets the same ones — because
                       the failure mode is a call site nobody has written yet, and because
                       tags reaching one of the two calls would be blamed on the FOOTAGE.
                       Mutation-tested both ways; its first version matched ZERO calls in
                       `judge.ts` and passed vacuously, which is why it counts them now
tests/evidence-refresh.test.ts  a re-observation that changes nothing must write NOTHING —
                       the negative direction carries the weight here, because this runs
                       over every post in the window every 15 minutes
tests/posted-label.test.ts  the IST hour, and `null` rather than a number for the 14 live
                       rows whose `detectedAt` PRECEDES their `postedAt`
tests/frame-signal.test.ts  the footage's permission table both ways, a sweep proving no
                       input combination ever demotes, and the injection payloads that
                       survived an earlier sanitiser (including a fake JSON verdict)
tests/one-route-rule.test.ts  a SOURCE GREP, because the failure mode is a call site nobody
                       has written yet and no behavioural test can fail for that: no file
                       may create a pair row unless it is a named permitted creator, every
                       governed creator must call routes.ts, and none may re-implement the
                       handle filter inline. Beside it, two BEHAVIOURAL tests in
                       fleet-pairs — a grep is satisfied by `void routeAllowed()`
tests/decide-brand.test.ts  both sides of the confidence floor, asserted against the
                       exported constant rather than a literal, and @adityathackeray as a
                       required fixture: a politician byte-identical to a brand on every
                       readable field is what a rule would have messaged
tests/cohorts-live.test.ts  the ladder's `live` derivation against a REAL temporary SQLite
                       file — it is assembled from a Prisma `select` (a stale column name
                       fails at RUNTIME while typecheck passes) and a filesystem read, so a
                       pure mirror of the predicate would agree with itself either way
tests/stopInventory.test.ts  the redesign's safety net: every stop is reachable, explains
                       itself in prose, AND has a decided remedy. Run before and after any
                       UI change
tests/labels.test.ts   no view model may hand a raw `displayName` to a screen
tests/media-capture.test.ts  which cover frame we keep, and why we keep one at all
tests/cadence.test.ts  detection's clock is independent of the send schedule; and
                       "too short to be a pitch" is a verdict, not a failed call
tests/identity.test.ts "who is this profile" in both directions, from the REAL measured
                       responses. The regression it guards: 200-with-HTML, a 200 carrying
                       `status: fail`, and a throttle must never read as "logged out"
docs/RUNBOOK.md        operator guide for macOS and Windows
docs/AUDIT-2026-07-31.md  38-finding end-to-end audit, and what was done about it
docs/HANDOFF.md        current state + how to pick this up in a new session
docs/specs/2026-08-13-handoff.md  what the 13 Aug repair session finished, what it left, the
                       ORDER to do the rest in, and the prompt for the next session. Read it
                       with the plan beside it — it corrects three of the plan's numbers
docs/PIPELINE.md       the pipeline diagram: its URL, and the rule that it must be
                       updated whenever the flow of operations changes
docs/specs/            design docs and plans
  2026-08-03-brand-outreach-design.md   Phase 1.5: message the BRANDS too. NOT BUILT
  2026-08-03-linode-hosting-plan.md     detection may move to a VPS; sending may not
```

---

## Commands

| | |
|---|---|
| **dashboard → Connect** | the normal way to log an account in. `pnpm ig:login <handle>` is the same flow from a terminal |
| ~~`pnpm burner on\|off\|status`~~ | **DELETED 2026-08-08.** Rehearsal mode is gone as a global mode: it braked by sweeping `OutreachPair.enabled`, the column routing stopped consulting the same day, and its hardcoded target `@priyanshu123321123` had already been deleted from the database, so it could only exit at its not-seeded guard. Rehearse with the **on-demand dialog** pointed at an account we own — a person pressing a button, not a mode that silently disabled every real route. The burner ACCOUNT `@tabishmukaddam1` still exists and is still the safe test recipient |
| `pnpm local` | **run the dashboard on this Mac.** Reads the SERVER's data through the tunnel, so what you see is live and what you change is real. `pnpm local offline` uses the old SQLite snapshot instead — frozen, and it says so. It refuses if the port is busy rather than printing a URL belonging to another process, and always names WHICH database and how fresh |
| `pnpm dev` / `pnpm start` | dashboard on **:3100** (127.0.0.1 only) — SEVEN pages behind a sidebar — sign in first. **Registration is INVITE-ONLY since 2026-08-08** (`SIGNUP_INVITE_CODE`; unset means closed), and a new account is a `viewer` until an operator approves it. The hosted copy runs the same thing on the Linode behind nginx. It was :3000 until 2026-08-04: another project on this machine binds `*:3000` on IPv6, and macOS resolves `localhost` to `::1` first, so `localhost:3000` silently served the wrong app |
| `pnpm worker` | the scheduled watch as a separate process. NOT needed on a laptop — the dashboard runs the same scheduler itself |
| `pnpm run:slot` | run one slot now |
| `pnpm send` | send the next prepared message by hand (clipboard + opens profile) |
| `pnpm queued` | every prepared message, plus what the safety gate held back |
| `pnpm ig:audit` | cross-check every dashboard number against the DB |
| `pnpm ig:reply <sender> <target>` | record that a target replied — halts all outreach to them. `--at <ISO>` sets or corrects the time |
| `pnpm ig:thread <sender> <target>` | open the real conversation and read it back. `--record-reply` records a detected reply; `--debug` dumps the DOM when the layout has drifted |
| `pnpm ig:replies` | check every open conversation for replies now — the same function the 11:00 and 20:00 slots run |
| `pnpm ig:classify` | classify stored posts. **Dry run by default**; `--run` spends money, `--limit N` bounds it, `--channel <handle>` narrows it |
| `pnpm ig:accuracy` | measure the classifier against EVERY label the system holds, PER CHANNEL, saying **unmeasured** where a channel has none. Run it after ANY prompt edit — and with **`--repeat 3`**, because the classifier is not deterministic and one run swings recall 95-100%. `--no-frames` and `--tags` are the two input controls; **both default to production** (frames on, tags off), because a harness whose default disagrees with production measures a pipeline that does not exist. It now prints how many posts carried tags at all — 4 of 79, which BOUNDS what it can say about that input |
| `pnpm ig:brands` | resolve @mentions in paid posts to messageable brand accounts. **Dry run by default.** **RUN THIS FROM A HOME-IP MACHINE, NOT THE SERVER (2026-08-12):** Instagram 429s the Linode on the profile endpoint and answers the Mac, so `autoResolveBrands` on the server halts on its first lookup every pass and creates nothing — measured, 59 targets from the Mac against 0 from the server, same code. Detection is unaffected; only this endpoint is throttled. See the hosting section. `--stuck` re-offers rows the model has never seen; `--reset <handles>` clears a bad verdict so it can be re-asked. It no longer prints "pairs DISABLED": false since the per-route switch went, and printed at the moment an operator decides to create prospects |
| `pnpm ig:enrich` | what we can still learn about handles Instagram will not classify. Facts only, NEVER a verdict. Dry run by default |
| `pnpm ig:dispatch` | what the paced dispatcher would do, and why nothing has gone out. **Reports only**; `--run` delivers one message now |
| `pnpm ig:prune-pairs` | remove routes belonging to accounts outside the rotation. **Dry run by default.** `mayPrunePair` refuses any pair carrying an attempt of ANY status, and the delete carries that condition itself — `OutreachAttempt.pairId` is `ON DELETE CASCADE`, so a bad delete erases the record of messages real people received. MEASURED: 72 such routes, 0 with history. **RUN IT ONLY AFTER THE routes.ts FIX IS DEPLOYED**, or the server's next brand discovery recreates them |
| `pnpm ig:dedupe-drafts` | one waiting draft per recipient, keeping whichever sender rotation would choose. **Dry run by default.** Discards through `discardAttempt` — the ONE writer, whose status guard is inside the update — so each removal is audited and a SENT row can never be touched. RUN IT ONLY AFTER THE ROTATION FIX IS DEPLOYED TO THE MACHINE THAT DRAFTS, or the next slot recreates every duplicate and the only lasting effect is the audit trail |
| `pnpm ig:import <file>` | import a prospect list. **Dry run by default**; `--run` creates them unwatched — but their ROUTES ARE LIVE since 2026-08-08, so importing sixty prospects is no longer inert. The dry run is the brake |
| `pnpm ig:prune` | free disposable browser cache from the sending profiles. **Dry run by default**; never touches `Cookies` or `Local State`, refuses if Chrome is open, verifies by hash afterwards |
| `pnpm ig:generate` | write a real message with the model and print it, with the quality gate's verdict. **Dry run by default** — `--run` spends about $0.0001 a message. Writes nothing, sends nothing |
| `pnpm ig:detect` | one detection pass now, on demand — the same function the 15-minute clock fires. `--lookback N` reaches further back, which also banks cover frames for re-observed posts |
| `pnpm ig:ocr` | read the text off saved cover frames and print it. **FREE and the default does real work** — Apple Vision runs locally, no API. `--reclassify` re-judges posts whose footage has text (~$0.00002 each) and may only escalate ORGANIC → REVIEW. `--shortcode X` for one post |
| `pnpm ig:frames` | how many cover frames are on disk; `--capture` downloads the ones whose URL is still alive. Costs nothing but bandwidth — **run it generously, URLs expire and judging can wait** |
| `pnpm agent status` | what is actually blocking each account. **Reshaped 2026-08-08**: it used to report `autopilot off` from `autoSendEnabled`, a bit no guard reads — so an operator could run the command naming that refusal, watch it succeed, and see nothing change. It now asks each stop of the thing that ENFORCES it: the fleet switch via `getSettings`, a **usable** session via `sessionUsable` (not `sessionPath` — a path in the database is not a live session), and the cohort ladder via the same `mayArmAccount` the gate calls at delivery, which was previously invisible from the CLI. `pnpm agent pause`/`resume` unchanged; **`pnpm agent autopilot on\|off` is DELETED** |
| `pnpm ig:layout` | open every dashboard page in a real browser and assert GEOMETRY, that every asset loads, that the stylesheet applies, and — since 2026-08-13 — a **QUERY BUDGET** per page (start the server with `DS_QUERY_COUNT=1`; the check FAILS rather than skips if counting is off). It found `/` issuing 559 queries on its first run. Needs `DS_LAYOUT_TOKEN` set to a session cookie value. Run after ANY UI change — presence, 200s and chunk-loading all passed once on a page whose layout was destroyed |
| `pnpm agent:device` | **the sending agent for YOUR machine.** Reads the shared database, sends from the Chrome profiles here, and reports this device's presence. Refuses to start when `SEND_ENABLED=false`, which is how the server is configured |
| `bash scripts/install-watch.sh` | keep that agent alive across crashes and logins (`install`/`status`/`uninstall`). `DS_WATCH_MODE=worker` for a laptop-only install that also owns the schedule |
| `bash scripts/install-tunnel.sh` | keep the SSH tunnel to the server's Postgres up. `status` asks whether the PORT answers, which is not the same question as whether launchd registered the job |
| `pnpm worker:heartbeat` | is the watch running, and what has the downtime cost? Exits non-zero only when posts are being lost permanently |
| `pnpm ig:copy-to-postgres` | one-off SQLite → Postgres row copy. **Dry run by default**; verifies counts AND re-reads sampled rows field by field, because a count cannot see a dropped column |
| `pnpm ig:migrate-data` | move frames and the OCR binary out of the credential directory. **Dry run by default**; copies, hash-verifies, compares the MODE, then unlinks |
| `pnpm test` | 1,131 tests. It regenerates the SQLite client first (the suite builds temporary `.db` files), so **it leaves the client pointed at SQLite if it fails partway** — `bash scripts/prisma-client-for-env.sh` restores it |
| `pnpm db:studio` | full raw data the dashboard omits |

---

## Gotchas that have already bitten

- **`skipDuplicates` IS A PROVIDER TRAP: IT EXISTS ON THE POSTGRES CLIENT AND NOT ON THE
  SQLITE ONE.** Found 2026-08-08 by running it. `createMany({ skipDuplicates: true })`
  appears **4 times** in the generated Postgres client and **ZERO** times in the SQLite one,
  so every call threw `Unknown argument` — while `pnpm typecheck` was perfectly happy,
  because typecheck runs against the Postgres schema and the suite regenerates SQLite.
  **Production is Postgres, where it would have worked BY LUCK**, and the SQLite harness is
  the only reason this was caught before the server. Two lessons, and the second is the
  general one: idempotency that depends on which provider generated the client is not
  idempotency (existing rows are subtracted instead, with the unique key as the backstop for
  the read-then-create race); and **typecheck and the test suite here run against DIFFERENT
  providers**, so agreement between them is not agreement about the code.
- **NEVER RUN A BARE `pnpm prisma generate`.** It re-bakes the client for whichever provider
  the schema config names, so running it while `DATABASE_URL` points at the server's Postgres
  leaves the **device agent unable to reach the server at all** — the generated client is
  baked with its schema's provider and refuses the other adapter outright
  (*"The Driver Adapter @prisma/adapter-pg … is not compatible with the provider sqlite"*).
  The fix is `bash scripts/prisma-client-for-env.sh`, which picks the right one from the
  environment. `pnpm test` regenerates SQLite as its first step and restores Postgres after,
  so a suite that dies partway leaves the client on the wrong provider — run the script,
  do not reach for `prisma generate`.
- **A NEW CRON ON THE SAME CLOCK AS AN OLD ONE COLLIDES BY CONSTRUCTION, AND `noOverlap`
  CANNOT HELP.** Putting `runOutreach()` on the 15-minute detect clock (2026-08-11) landed it
  on top of the four IST slots, because **minute 0 is always a multiple of 15** — four
  collisions a day, guaranteed, the same arithmetic that makes the pipeline's `upsert`
  `update:` branch fire 16 times a day. node-cron's `noOverlap` is **per TASK**, so it stops
  a task treading on itself and does nothing between two different tasks. The cost is not
  wasted work: two concurrent planners both read `hasPendingAttempt: false` for one pair,
  both draft it, and **two DMs land on one prospect seconds apart** — `hasPendingAttempt` is
  a read-then-write and cannot close that alone. The slot lock is the fix, exported from the
  one file it lives in and reused; a held lock skips planning and is deliberately NOT logged
  as a failure, because the slot holding it is doing the same planning anyway. **When adding
  a scheduled task, ask which existing schedules its interval divides.**
- **THIS REPO LIVES ON AN iCLOUD-SYNCED DESKTOP, AND iCLOUD IS NOT A BACKUP — IT
  CORRUPTED `.git` WHILE PRESERVING EVERY SOURCE FILE.** 2026-08-12: turning OFF iCloud
  Desktop sync moved the whole repo to `~/iCloud Drive (Archive)/Desktop/` and left an
  empty Desktop. Nothing was deleted, and the working tree came back complete — 24,796
  files, typecheck clean, 1,221 tests passing. **The git object store did not.** iCloud
  excluded `.git/HEAD` and `.git/config` (one-liners, rebuildable) and silently dropped
  **108 objects**, including blobs HEAD's own tree points at: `git ls-tree -r HEAD`
  returned **32 entries for a repo with thousands of files**, and `git add` failed with
  *"invalid object … for instrumentation.ts"* about a file sitting readable on disk. Also
  **19 tracked source files were missing from the archive entirely** (`next.config.ts`,
  `tsconfig.json`, `src/lib/session-cookie.ts`, `src/outreach/pacing.ts` …).
  **What made recovery possible was having a second copy that was not a sync client:** the
  deployed source on the Linode. 5 of the 19 came back from surviving git objects; the
  other 14 were `scp`'d from `/opt/ds-sales-agent` and proven byte-identical rather than
  assumed — after restoring them the ONLY files git reported as changed were the three of
  the in-flight fix, which is the check that distinguishes "restored" from "restored
  something else". A repo whose history cannot be read is not history, so the damaged
  `.git` was preserved under `/tmp` and the tree re-committed as a clean root.
  **Consequences to keep:** `~/.ds-sales-agent` (credentials) and `~/.ds-sales-agent-data`
  survived untouched, because they are OUTSIDE the synced folder — the sibling-directory
  split earning its keep a second time. A `.git` copy now lives at
  `~/ds-agent-git-backup-<date>`, outside Desktop, for the same reason. And `node_modules`
  came back partially populated, which presents as `Cannot find module '…/typescript/bin/tsc'`
  — the same `rm -rf node_modules && pnpm install` remedy as the entry below, but note that
  install regenerates the **SQLite** client, so `bash scripts/prisma-client-for-env.sh`
  afterwards or the device agent cannot reach the server.
- **`ERR_INVALID_PACKAGE_CONFIG` FROM A `package.json` THAT LOOKS PERFECTLY VALID MEANS
  `node_modules` IS DAMAGED, NOT YOUR CODE.** Hit 2026-08-07: every `tsx` script, `vitest`
  AND `pnpm install` itself started failing, first pointing at
  `zod/v4/core/package.json`. `cat` showed well-formed JSON and `JSON.parse` accepted it —
  but the file was mode **600** where its siblings were 644, and elsewhere in the store
  files had been truncated to **zero bytes** (75 of them; pnpm's own error was *"Unexpected
  end of JSON input while parsing empty string"*). It also SPREAD: deleting the named
  package moved the error to `effect`, then `sharp`.
  **Do not debug this as a code problem.** `rm -rf node_modules && pnpm install` fixed it in
  4 seconds. What is worth doing FIRST, and it is thirty seconds of work: confirm the damage
  is confined — `find src prisma tests -type f -size 0` returned 0, `git status` showed only
  expected edits, and `prisma/dev.db` was copied to /tmp before anything was deleted. Source,
  docs and the database were untouched; only the store was. Verify that rather than assume it,
  because the reflex when tooling breaks everywhere is to suspect the last edit.
- **A `Date` HANDED TO A NAIVE POSTGRES COLUMN CARRIES THE CLIENT'S TIMEZONE, AND THE
  CHECK THAT SHOULD CATCH IT AGREES WITH ITSELF.** Every timestamp column here is
  `timestamp WITHOUT time zone` (SQLite had no tz-aware type; the generated Postgres schema
  mirrors it on purpose). The `pg` driver serialises a JS `Date` into such a column using
  the CLIENT's LOCAL time — so the SQLite→Postgres copy, run from UTC+05:30, stored all
  **6,291 values 5.5 hours ahead**.
  **It hid because the driver applies the same offset on the way BACK OUT.** A JS-to-JS
  comparison from the copying machine round-trips perfectly: the migration's "timestamps
  compared as instants: match" was true and meaningless, and the first corrective dry run
  said *"6291 compared, 0 differ"* about values that were every one wrong. *A check that
  reads a value back the same way it wrote it is not verifying storage; it is verifying its
  own symmetry.* `::text` is the only view with nobody's timezone in it — MEASURED on one
  row read two ways: from the Mac `05:30:45Z` (right), from the SERVER `11:00:45Z` (wrong),
  and the server is what runs detection. **Bind timestamps as STRINGS and cast in SQL**
  (`$n::timestamp`); a string has no timezone for a driver to apply. Found by a dashboard
  printing "newest seen **-171 min ago**" — a negative age is impossible, which is the only
  reason it was caught. Two plausible fixes were wrong first (a time boundary caught correct
  server rows; `> now()` missed every row already more than 5.5 hours old); what identifies
  a copied row is the SQLite file itself. `pnpm ig:fix-timestamps`, mutation-tested.
- **A MODULE-LEVEL LATCH MEANS "FOREVER" THE DAY A RESIDENT PROCESS CALLS IT.** Found
  2026-08-11 by reading the server's pm2 log two hours after deploying. `resolveBrand.ts`
  had `let rateLimited = false`, set on a real 429 and documented as *"stop asking for the
  rest of the run"* — correct while the only caller was `pnpm ig:brands`, where the run IS
  the process. The 15-minute `autoResolve` cron made "the run" mean "the process lifetime".
  MEASURED: one handle 429'd at 14:15, and every pass for the next two hours logged an
  identical `looked=1 haltedEarly=true` while making **no request at all** — the latch
  short-circuits before the fetch, so a permanent stop is indistinguishable from a fresh
  throttle. Zero `purpose: 'resolve'` calls had ever run in production; the feature built
  for `@adidas` had never once executed. **`resetBrandResolverLimit()` existed with ZERO
  callers** — a reset nobody can trigger, this codebase's signature failure, inside the
  code written to be careful. Now a timestamp (`RATE_LIMIT_COOLDOWN_MS`, 30 min), the
  message names its expiry, recovery is logged, and `ig:brands --run` clears it because a
  person typing a command has decided to try. **A control probe is what settled it**: the
  same handle returned 400, not 429, from both the server and a laptop, so the endpoint was
  healthy and the latch was stale — the identical diagnostic that corrected `resolveBrand`'s
  rate-limit story in the first place.
- **A CACHE THAT ANSWERS FIRST MEANS A NEW JUDGE NEVER SEES THE BACKLOG.** Same day. The
  brand model was wired into `resolveBrand`'s FRESH path only, and the cache branch returned
  `cached: no category` before reaching it. MEASURED: all 30 `UNRESOLVED` rows were cached on
  2026-08-06 — days before the model existed — so `@adidas`, `@kfcindia` and `@nutella` were
  structurally unreachable by the thing built to decide them. Adding a judge to a pipeline is
  not the same act as offering it the rows that predate it. The fix distinguishes *the model
  ruled* from *the model never ran* with `decidedBy = 'model-declined'`, so a decline is not
  re-asked forever while a failure stays retryable, and both paths persist through ONE
  `persistResolution`. **The backfill command's first query was `decidedBy: { notIn: [...] }`,
  which selects NOTHING when the column is NULL** — SQL three-valued logic — so it would have
  printed *"Nothing stuck"* about a queue it never read: a confident all-clear, exit 0.
- **THE MODEL ANSWERED ABOUT A DIFFERENT ACCOUNT, AT 95% CONFIDENCE.** Found by READING all
  23 real verdicts rather than the headline counts. Asked about `@crocs` it replied
  *"instylemagazine is a publisher/media page"*; asked about `@titaneyeplus`, *"Vikas Khanna
  is a famous Indian chef"*. Neither entity appears in that handle's enrichment or captions —
  it substituted a subject, and both wrong rows had `(nothing gathered yet)` enrichment, so
  **thin evidence produces confabulation rather than the `unsure` the prompt asks for**. The
  confidence floor cannot catch this: the model is confident, just about the wrong thing.
  Two real brands were filed PERSON, which never retries. `src/detection/reasonSubject.ts`
  now rejects a reason whose subject is traceable to something other than the handle, and
  degrades it to unsure. Note what makes it hard: `@iamzahero → "Sonakshi Sinha"` and
  `@nowitsabhi → "Abhishek Banerjee"` are CORRECT — real people behind pseudonymous handles,
  structurally identical to the mistake. Verified in production: on re-ask `@crocs` resolved
  to company and `@titaneyeplus` **repeated the same confabulation and was caught**.
- **A CLIENT COMPONENT THAT IMPORTS A GUARD PULLS THE DATABASE INTO THE BROWSER.** Found
  2026-08-06. `waiting.tsx` is `'use client'` and imported `remedyFor` from a module that
  imports `RESEND_BLOCKS` from `gate.ts`. The trace — `waiting.tsx [Client] -> remedy.ts ->
  gate.ts -> profile.ts -> better-sqlite3` — could not resolve `fs`, which broke the client
  chunk build and returned **HTTP 500 on every route**, including ones importing none of it.
  `pnpm typecheck` passed throughout and `pnpm build` was not the thing that caught it. Same
  shape as the `lib/session-cookie.ts` lesson one runtime over: a module reachable from a
  restricted runtime must not import server-only code, and only RUNNING it tells you. The fix
  is to resolve on the server and pass data down — which is also what this codebase already
  says a page should do.
- **A 200 IS NOT A STYLESHEET, and geometry checks pass happily on an unstyled page.** Found
  while verifying `pnpm ig:layout`: `pnpm build` had been run while `pnpm start` was live — the
  trap already recorded below — so the HTML referenced a replaced chunk and
  `/_next/static/chunks/*.css` returned **HTTP 500 with the body "Internal Server Error"**. The
  dashboard rendered with NO CSS AT ALL, and the geometry check passed **seven of its nine
  assertions** on it: the rail was present, nothing overlapped, no error boundary, the heading
  was there. Almost every geometry assertion is vacuously true without CSS, because with no rail
  there is nothing to collide with. `ig:layout` now fetches every referenced asset AND asks the
  browser for a computed value only our own CSS sets.
- **AN ASSERTION ABOUT TODAY'S ARRANGEMENT IS NOT AN ASSERTION ABOUT THE PROPERTY.** Also found
  by mutation-testing `ig:layout`: reintroducing the exact CSS that destroyed `/` —
  `main { display: grid; grid-template-columns: 15rem 1fr }` — produced almost no failures,
  because splitting `/` left every page rendering exactly TWO children (the rail and one
  `div.page`), and a two-column grid with two children works. The bug had not been fixed; it had
  gone LATENT, and it returns the day any page renders a second block. The check now APPENDS a
  probe child and asserts *that* clears the rail, plus that `main` is not a grid or flex
  container at all. Ask what the check would say if the arrangement changed, not whether it
  passes now.
- **"The content column is readable" measured `main`, which is always full width.** So it could
  not fail. Under the grid bug the content was crushed into a 15rem column and the assertion
  stayed green. Measure the element that carries the text, not its container.
- **A CONTAINER THAT CHANGES COLOUR MUST CONTAIN ONLY THINGS THAT COLOUR IS ABOUT.** `/`'s
  health card was one `.status status-{health}` box holding the dot, the headline, "Last check
  read 168 posts", the next slot, Check-now and **Sign out**. `status-attention` is the ORDINARY
  state whenever a draft is waiting, so the dashboard routinely rendered an amber alarm
  containing good news and a piece of furniture. It is also invisible to a geometry check — the
  box was laid out perfectly.
- **`display: flex` ON RUNNING PROSE SEPARATES THE PUNCTUATION.** In a flex container every bare
  text node becomes its own anonymous flex item, so a paragraph ending in a linked clause
  rendered as `4 messages written and waiting.   Read them and decide   .` with the full gap
  before the full stop. Same family as the JSX `{' '}` bug below, and found the same way — by
  reading the text content, not by looking at the layout.
- **A guard can succeed and still be blind, and that is not `unreadable`.** The reply check
  read a thread, got a truthful SUBSET, and reported "no reply" — stamping verified silence.
  Every fail-closed path was designed against a read that FAILS; this one worked. When a check
  reads external state, ask what it would report having seen only part of it, and make
  "partial" its own outcome rather than a quiet member of the happy path.
- **A jitter added for behavioural realism decided a safety outcome.** `jitter(2000, 3500)` sat
  between opening a thread and reading it, and Instagram restructures the DOM at ~2528 ms. The
  guard's correctness was a coin flip. Randomness introduced for one purpose lands wherever it
  lands; if a random delay sits before a measurement, the measurement inherits it.
- **A fall-through `return { ok: true }` turns every new case into a permission.** Adding
  `incomplete` to a union made an incomplete read allow the send — fail-open, with no type
  error, because a fall-through return is valid code. Exhaustive `switch`/`never` on anything
  whose default answer is "go ahead".
- **Mutation-test the VERIFICATION, not just the logic.** The pruner's "device identity
  intact" check could be replaced with a constant `true` and break no test: every case
  asserted it on a happy path where it was true anyway. A check nobody can trigger is this
  codebase's signature failure, and it had reappeared inside the code written to prevent it.
- **A rule that matches digits does not see words.** The quality gate's figures allowlist —
  the most important check in the file — passed "eighty million followers". Enumerate the
  representations, not just the values.
- **Room in an exempt bucket is not room.** New sending accounts were being assigned to
  cohort 1 because it had space, and cohort 1 is the baseline that bypasses the soak. The
  first account of a 61-account expansion would have skipped the entire ladder. When one
  bucket is exempt from a rule, nothing new may be put in it.
- **A GUARD CAN CHECK A FACT THAT HAS NOTHING TO DO WITH WHAT IS SENT.** Observed in
  production 2026-08-05. A draft was prepared at 15:10, the account was given a new identity
  at 15:12, Send was pressed at 15:12:28 — the persona gate CHECKED THE ACCOUNT, found it
  distinct, and passed — and at 15:13 the message was delivered still saying *"I'm Kapil Jain,
  Co-founder of Bollywood Society"*. The gate guards the account; the body carries the persona
  frozen at draft time. Decision 3b exists so a recipient never gets a pitch signed by another
  company, and a message could do exactly that while the guard reported everything fine. When a
  guard checks live state about a message written earlier, ask what the MESSAGE says, not what
  the record says. `RESEND_BLOCKS.PERSONA_CHANGED_SINCE_DRAFT` is the stop; it refuses rather
  than silently re-rendering, because the stored body is what the send guards compare against
  and an operator may have edited it by hand.
- **A CSS layout that assumes a child count breaks exactly one page.** `main` was given
  `grid-template-columns: 15rem 1fr` for a sidebar. Every page renders two children — except
  `/`, which renders eleven, so children 3, 5, 7, 9 and 11 landed in column ONE underneath a
  sticky full-height rail. A fixed rail plus padding cannot care how many children there are.
  And it shipped because the verification asked whether the rail was PRESENT, whether a link
  was active, whether chunks loaded and whether an error boundary showed — **all five passed on
  a destroyed page.** Presence is not layout; assert geometry (bounding boxes must not
  intersect) in a real browser.
- **JSX drops the space between an expression and the next line's text.**
  `{x ? 'it' : 'them'}` then a newline then `under Your accounts` renders **"themunder"**. Use
  `{' '}`. It reached a live dashboard and was found in a screenshot.
- **"Nothing happened" needs a reason at every level, not just the top one.** The dispatcher
  recorded why the FLEET did not send (breaker, hours, gap) and, when the fleet WAS clear and
  every individual message was then held, recorded `0 message(s) sent` with a count and no
  reason. Its own docblock said the mechanism existed so *"autopilot is on and nothing has gone
  out" has no explanation anywhere* — it was one level short of its own claim. When you build a
  "why nothing happened" channel, walk down every layer that can independently say no.
- **A wrong number is worse than no number.** `ig:prune`'s dry run printed "24.3 GB unpruned,
  24.3 GB pruned" because the post-prune size is null in a dry run and fell back to the
  before-size. It read as "pruning achieves nothing" in the one command arguing that it does.

- **`instagram.com/<handle>/` returns HTTP 200 for an account that does not exist.** It
  serves the SPA shell and renders "Sorry, this page isn't available" client-side.
  `handleExists` read that status, so `'missing'` was **unreachable** and it answered
  `'exists'` for every handle anyone could type — `addTarget` has always shown "@x does not
  exist on Instagram" from a branch no input could reach. MEASURED 2026-08-05:
  `@instagram` and `@qqqq_nope_nope_12345` both 200, bodies 609,393 and 609,403 bytes, ten
  bytes apart. Exactly the `current_user` trap below, on a different path. What works is
  **`web_profile_info`** — measured 404 for a missing handle — with the caveat that a 400
  carrying Meta's deleted-schema message means the account EXISTS and its category cannot
  be serialised. Throttles stay `unknown`; absence of data must never harden into a
  negative verdict. Found by RUNNING the import, not by reading code that looked correct.
- **A lock that grants itself to its own pid must not be re-entered.** `acquireSendLock`
  treats a row naming our own pid as claimable — it has to, because a crash leaves one
  behind and pids get reused. That made a NESTED `withSendLock` succeed, and the inner
  `finally` then deleted the row while the outer call was still sending, leaving the send
  unprotected. Nesting is refused outright now: there is one clipboard, so a process asking
  to send while already sending is a bug upstream.
- **"Taking over a lock left by a process that is gone" was printed for our OWN live pid.**
  Both lock takeovers logged one message for three different situations, so a routine
  self-reclaim reported a crash that never happened — sending anyone debugging a wedged
  fleet after a ghost. Distinguish "unreadable row", "our own row", and "a dead holder".
- **A bound must count what you are trying to limit.** The dispatcher's per-tick bound
  first counted DELIVERED messages, so a run of failures drove Instagram once per waiting
  draft with the counter stuck at zero — an unbounded burst produced by the code meant to
  bound it. A failed send is exactly as much Instagram activity as a successful one.
- **`/api/v1/accounts/current_user/` does not work on instagram.com web.** It looks
  like the obvious "who am I" endpoint and it is a trap: measured 2026-07-31 against a
  genuinely logged-in profile it returns **HTTP 200 with `text/html`** (the SPA shell),
  because it is a mobile-API path www does not serve. `loggedInAs` was built on it, so
  it returned null for logged-in and logged-out sessions alike — the dashboard's
  Connect button polled forever, and `assertLoggedInAs` would have blocked every send
  from a perfectly good account. What works: `ds_user_id` from the session cookie,
  resolved via **`/api/v1/users/{id}/info/`**, which returns JSON with `user.username`.
  Verified positive *and* negative (the wrong-account guard still fires).
- **AND THEN `/api/v1/users/<id>/info/` DIED THE SAME WAY, and the check written to defend
  against that read the dead endpoint as "you are logged out".** Found 2026-08-06 when
  Connect on `@tabishmukaddam1` opened Chrome showing the account plainly signed in and the
  dashboard would not accept it. MEASURED on that live profile, page title `(1) Instagram` —
  an unread-DM badge only a signed-in session renders:

  | | |
  |---|---|
  | `www/api/v1/users/<id>/info/` | **200 `text/html`, 627,698 bytes** — the SPA shell. Adding `x-csrftoken` and a `referer` changes nothing, so it is the PATH, not the headers |
  | `i.instagram.com/.../info/` | 200 **JSON** with `{"status":"fail"}` and a translated "something went wrong" — a 200 carrying no answer |
  | `www/api/v1/accounts/edit/web_form_data/` | **200 JSON, `form_data.username`** — works with and without a csrf header. Now the first endpoint tried |

  The root cause is not the dead path — paths die. It is that `identify()` was
  `if (!res.ok() || !contentType.includes('json')) return { kind: 'logged-out' }`, so **"I
  could not ask" hardened into a positive claim about the account**, and `{kind:'unknown'}` /
  `IdentityCheckFailedError` — which exist for exactly this — were reachable only from a
  thrown exception, never from a bad *response*. Third appearance of that shape here, after
  `current_user` and `resolveBrand` reading one broken handle as a run-wide throttle.

  **The claim then travelled, and every consequence looked like a different bug.** Connect
  polled "Waiting for you to log in…" for twenty minutes at an account that was already
  logged in; every send threw `NotLoggedInError`; and §3.5 dutifully RECORDED the live
  session as dead (`sessionInvalidAt`, 09:58), which halts the account through the gate's
  `no-session` stop and tells the operator to perform the riskiest act in this design — a
  re-login — on evidence nobody gathered. A mechanism working perfectly on a false input.

  Fixed by giving the reading a third value that cannot become a verdict:
  `readIdentityResponse` (PURE, tested both directions) returns `logged-in` / `logged-out` /
  **`no-answer`**, and `logged-out` is now claimed ONLY from positive evidence — no session
  cookie at all, a 401/`login_required`, or a rendered login form. Two endpoints are tried in
  order, because one source of truth for identity is one point of failure for every send.
  **Mutation-tested:** with both endpoints pointed at dead paths, a signed-in account returns
  `unknown` with a diagnostic rather than `logged-out` — the failure above is now structurally
  unreachable. Verified live in both directions: signed-in profile → `logged-in`,
  session-less profile → `logged-out`.

  Two things measured on the way, both worth keeping. `input[name="password"]` and
  `form#loginForm` are **0 on Instagram's current DOM in BOTH states** — the obvious
  selectors for "is a login form showing" would never have fired; `input[type="password"]`
  is 1 logged-out and 0 signed-in. And the *page* is a better witness than any endpoint:
  title `(1) Instagram` vs `Instagram`.
- **THE SECOND CONNECT BUTTON NEVER POLLED, so a real login went unrecorded and the page
  called a signed-in account "expired".** Found 2026-08-07 when Tabish signed in to
  @bollywoodchronicle through the /senders row button. That button fired `connectAccount`
  once and said "reload this page" — nothing ever asked "done yet?", so `finish()` never
  ran, the window was never closed (**closing is what flushes cookies to disk**), nothing
  was recorded, and the page truthfully reported no session on disk about an account
  visibly signed in in the window next to it. The login-queue card had the correct
  start-then-poll flow all along: one flow, two callers, one of them wrong — the exact
  drift `gate.ts` and `readThread.ts` were extracted to stop, this time in the client.
  Both buttons now share `useConnect` (src/app/accounts/use-connect.ts), the ONE
  start-then-poll implementation; on `connected` the row refreshes itself. The orphaned
  login was finalised with `pnpm ig:login` (already-signed-in branch: identity verified
  against Instagram, then recorded).
- **A SUCCESSFUL CONNECT WAS REPORTED AS A FAILURE, by the client, in two places.** Found in
  the same 2026-08-06 investigation and independent of the endpoint above — so Connect would
  still have been unusable for an already-signed-in account after that fix. `startConnect`
  verifies identity and closes the window itself when the profile is already logged in, and
  `queue.tsx` handled only `error` and `closed`: `connected` fell through to
  `setState('waiting')` and started polling, `pollConnect` found no window in its Map
  (because the connect had already finished), returned the no-window fallback *"A session is
  already stored for this account. Press Connect to re-verify it."*, and the card rendered
  that as an **error**. Pressing the button again reproduced it forever. `group.tsx` had the
  mirror image: every non-error state printed *"A Chrome window is opening — sign in there"*,
  including `connected` (the window has already closed) and **`wrong-account`** — a different
  account holding the profile, which is safety-relevant and was hidden behind that sentence.
  Both now answer per state. A union type is only as good as the branches that read it, and
  `if (a || b)` on a six-member union silently lumps the other four into the else.
- **`pnpm ig:login` had TWO writers' worth of side effects, and the dashboard's copy of the
  same flow had already been fixed.** `recordLogin` wrote `sessionInvalidAt: null` inline
  rather than through `clearSessionInvalid` — so a session coming back to life produced a
  `sender.session.restored` audit row via the dashboard and NO row via the CLI, depending
  only on which of two identical flows the operator used. It also set `status: 'ACTIVE'`,
  which **silently released a CHALLENGED halt** while leaving `challengedAt` set — so the
  fleet breaker stayed tripped and the account read healthy. That exact bug is documented
  below for `checkConnect` ("CHALLENGED is never cleared as a side effect") and the CLI was
  never switched over: the third time in this codebase that a fix landed in one caller and
  not the other. It now routes through `clearSessionInvalid` and prints a warning instead of
  clearing the halt.
- **The dashboard binds `127.0.0.1` and must stay that way.** It served
  `Send from @<revenue account>`, the Autopilot toggle, Auto-send and Remove to the
  entire local network with no auth and no `middleware.ts` — measured: `curl` to the LAN
  IP returned 200 with those buttons in the HTML. `actions.ts` already reasons about
  exactly this for `AUTOPILOT_ENABLED` (*"anyone who can reach it can call this action"*)
  and that reasoning correctly hard-floors one switch and stops. Exposing the page means
  exposing a send button; if it must be reached remotely, tunnel (`ssh -L`), never rebind.
  **Auth exists now (2026-08-03) and does not change this.** Registration is OPEN by
  Tabish's explicit choice, so a signed-in stranger can send from a revenue account —
  the bind is still the thing limiting who that can be. See the auth section above.
- **Middleware runs in the EDGE runtime, where `node:crypto` does not exist.**
  `src/middleware.ts` imported `SESSION_COOKIE` from `lib/session.ts`, which imports
  `node:crypto` at module scope. `pnpm build` succeeded, `pnpm typecheck` passed, and
  every single request then returned **HTTP 500** with `Native module not found:
  node:crypto` — including `/sign-in`, so the dashboard was completely unreachable and
  nobody could sign in to discover why. The cookie NAME now lives in its own
  dependency-free module, `lib/session-cookie.ts`; keep it that way, because one import
  there takes the whole dashboard down. Same shape as the `require()` gotcha below:
  code that resolves in one runtime and throws in another, invisible to both build and
  typecheck. **Only a real request finds it** — which is why auth was verified against
  the running server and not just by the suite.
- **`tsconfig.tsbuildinfo` caches type errors across a build.** With `incremental: true`,
  `pnpm typecheck` kept reporting `'/sign-in' is not assignable to RouteImpl<'/sign-in'>`
  *after* `pnpm build` had regenerated `.next/types/routes.d.ts` and `AppRoutes` visibly
  contained `/sign-in`. The route type was correct and the error was stale. Deleting
  `tsconfig.tsbuildinfo` cleared it. Worth knowing before "fixing" a phantom type error
  with a cast — the cast would have been permanent and the diagnosis wrong.
- **One gate, two callers. Never re-inline it.** `deliverWaiting` re-checked eight
  conditions; `sendNow` checked three. The five it lacked included `optedOut` and *they
  replied* — so `removeTarget` promised a retired channel "can never be contacted again by
  accident" while a draft's Send button still delivered, and recording a reply halted
  autopilot but not the button beside it. Both now call `src/outreach/gate.ts`. The
  decision half is pure so both directions are testable; the DB half is queries only. If
  you add an `if` to the wrapper, it belongs in the pure function with a test.
- **A per-item failure must not halt the whole run, and this one wore a safety costume.**
  `resolveBrand` set a module-level `rateLimited` on ANY non-OK status, stopping every
  remaining lookup. Measured: **three consecutive `pnpm ig:brands --run` passes made zero
  progress**, each reporting "rate-limited", against a completely healthy endpoint — one
  permanently-broken handle blocking ten resolvable ones, indefinitely. Halting on a real
  throttle IS correct here (hammering after being told to stop is what earns an IP block),
  so the code read as conservative. The bug was the *inference*: one item's failure taken as
  evidence about the shared resource. Ask explicitly which it is, and default to per-item
  unless the response actually says otherwise. **The diagnostic that settled it was a
  control probe** — a known-good handle interleaved between the failing ones returned HTTP
  200 every time, which disproved a documented measurement in one minute.
- **A check and a write in two statements is not a guard.** `sendNow`'s idempotency read
  the status then wrote `SENDING` separately, under a comment asserting a double click
  could not double send. It could. Use `updateMany` with the status in the `where` and
  check `count`. This bit twice in one day: the first version of the slot lock in
  `runSlot` made the identical mistake (`findUnique` then `upsert`) and two concurrent
  slots both ran — caught only by running it. `create` on a primary key is the atomic
  test-and-set.
- **A needle taken from the greeting makes both send guards tautologies.**
  `distinctiveSlice` excluded the greeting from its primary path but its *fallback*
  reached for "longest line available", which for a short edited body IS the greeting —
  and the greeting renders in the thread header whether anything was delivered or not. So
  the post-send check could not fail and a paste that lost everything after the greeting
  passed the composer read-back. The ends are now excluded from the fallback too, with a
  20-character minimum, and `editAttemptBody` refuses a body the guards cannot verify. Note
  the shape of the miss: the suite's "falls back gracefully" test used a **single-line**
  body, so the fallback never reached the greeting and the gap was invisible.
- **2FA is not enforcement.** `/two_factor` sat in `CHECKPOINT_PATHS`, and
  `assertNoCheckpoint` runs five times inside one send — so a routine re-verification on a
  2FA-enabled account marked it `CHALLENGED` and halted every pair using it, with nothing
  retrying by design. Identical to the `/accounts/login` mistake documented right beside
  it, whose own comment warns that CHALLENGED for routine events teaches an operator to
  dismiss the one that matters. 2FA has its own state and is checked *before* the login
  paths, because IG's 2FA URL sits under `/accounts/login/`.
- **Enforcement is usually a modal, not a URL.** "Action Blocked", "We restrict certain
  activity" — Instagram's normal response to DM activity renders on the current URL, so
  URL-only detection missed it entirely: the send carried on, failed some later check, and
  was filed as an ordinary retryable failure with the account left ACTIVE and eligible next
  slot. That is retrying into a block. `assertNoEnforcement` checks the page as well, at
  the two points where it matters. Keep the phrase list narrow — a false positive halts a
  healthy revenue account. Verified against 1MB of real logged-in page text with no match.
- **`CHALLENGED` is never cleared as a side effect.** `checkConnect` set `status: 'ACTIVE'`
  whenever connect reported `connected`, and that is returned on two paths where no login
  happens — including a fallback that read a cookie off disk with no identity check. So a
  flagged account returned to ACTIVE on one click with nobody looking at it. Clearing is
  `clearChallenge`, explicit. (It also did not re-arm auto-send, back when that switch
  existed. Since 2026-08-08 ability is derived, so clearing a challenge DOES restore this
  account to sending if its session is live and its group is cleared — that is the switch
  removal working as specified, and it is worth knowing before clearing one.)
- **Validated config that nothing reads is worse than absent config.**
  `SEND_JITTER_MIN/MAX_SECONDS` were parsed, range-checked, cross-validated (`min <= max`)
  and documented in `.env` as "delay bounds between consecutive DMs" — and read by
  nothing. There was no delay between consecutive sends at all. At 1-2/day that is
  academic; the danger is that raising volume is exactly when someone would rely on it.
- **The platform branch lives in exactly one file.** `src/lib/platform.ts`. Three things
  were macOS-only and each was a total blocker on Windows: `pbcopy`, `Meta+V` (which is
  the *Super* key on Windows, so the paste silently did nothing), and `open`. Windows uses
  PowerShell `Set-Clipboard`, **not `clip.exe`** — `clip.exe` encodes from the console code
  page and corrupts `U+2014`, and the message bodies contain 48 em-dashes, so the
  read-back would have refused intermittently depending on whether the needle line
  happened to contain one.
- **`REPLIED` replaces `SENT`; it does not add to it.** Any count of delivered messages
  must be `{ in: ['SENT', 'REPLIED'] }`. `pnpm ig:audit` counted only `SENT`, so a
  delivered message *vanished from the total the moment someone answered it* — the best
  outcome quietly reducing the number, in the one tool whose job is cross-checking the
  dashboard. It had always been wrong and had never been observably wrong, because until
  replies became recordable nothing could hold status `REPLIED`.
  **Fixed in `ig:audit` and left wrong in three other places for three days**, which is
  why the status sets now live in `src/lib/constants.ts` as `DELIVERED_STATUSES` and
  `IN_FLIGHT_STATUSES` rather than being spelled out at each call site. Found 2026-08-03:
  the dashboard said "2 messages sent" when 3 had been; and the daily caps in `plan.ts`
  and `gate.ts` counted `'SENT'` alone, so **a reply LOOSENED a guard** — the per-target
  ones were unreachable (`TARGET_REPLIED` halts that target first) but the per-SENDER cap
  was not, because the reply guard is per-target while the cap is per-sender. A reply
  from target X bought that account one extra message to target Y.
- **The dashboard must count a ceiling the way the enforcer counts it.** `view-model.ts`
  measured `MAX_TOTAL_SENDS` against `SENT + REPLIED` while `plan.ts` measures it against
  `IN_FLIGHT_STATUSES`. With the ceiling at 6 and 2 sent + 1 replied + 3 drafted, the
  planner saw 6/6 and stopped preparing anything while the page saw 3/6 and rendered no
  blocker at all. Two days passed with `queued=0` on every run, a healthy-looking
  dashboard, and no reason given anywhere. A limit reported by a different rule than the
  one enforcing it is worse than no limit shown: it reads as headroom.
- **A run in progress is not a finished run.** `ScrapeRun` is created with zeros and
  updated at the end, and the header read the newest row by `startedAt` — so for the ~60s
  a slot takes it rendered "Last check read 0 posts". Zero parsed is defined as an ALARM
  (60 parsed / 0 paid is a quiet day), so the one number that must never appear falsely
  appeared four times a day. Check `finishedAt` before reporting counts.
- **A health signal read from one sample cannot show a trend.** The "last check hit a
  problem" blocker looked only at `lastRun`, so a channel failing at every slot for two
  days read exactly like one unlucky fetch — and on the next success it read like nothing
  had ever been wrong. Measured 2026-08-03: 8 of 12 consecutive slots `PARTIAL`
  (`fetch failed` on the anonymous feed for two channels) and the page never said so.
  Report degraded runs over a window.
- **Closing the laptop lid silently skipped slots, and catch-up could not help.**
  Verified 2026-07-31. Closing the *tab* is irrelevant — the scheduler lives in the
  Next server process, and its heartbeat kept advancing with no page open. Closing the
  *terminal* is irrelevant too — `pnpm start` ends up with `PPID 1` and no controlling
  TTY. But **sleep** was fatal: node-cron arms a `setTimeout`, macOS suspends it, and
  on wake `planBeat` compares how late the fire is against `missedExecutionTolerance`,
  which defaults to **1000 ms** and was never overridden. Anything slept through is
  filed as *missed* and emitted on `execution:missed` — a hook nothing was listening
  to. `catchUpIfMissed` could not cover it either: it runs only at `startScheduler`,
  and a lid-close suspends the process rather than restarting it. So the slot vanished
  with no log line and no retry, while the dashboard still said autopilot was ON.
  Confirmed by provoking a real late fire (a 7s synchronous stall produced three
  `execution:missed` events with `ctx.date` set), not by reading the types. The handler
  is now wired, reusing `CATCHUP_WINDOW_MINUTES` so waking on Wednesday cannot replay
  Monday's 11:00, and re-checking `ScrapeRun` so it never double-runs.
- **A liveness guard must ask the OS, not a clock.** The scheduler refused to start
  because it saw a heartbeat under 3 minutes old and concluded another scheduler was
  running. It was its own predecessor's: a `kill -9` restart gives the old process no
  chance to clear the record. So every quick restart left the dashboard with autopilot
  ON, nothing scheduled, and no retry. The pid is in the record — `process.kill(pid, 0)`
  answers the actual question. Freshness alone is not liveness.
- **Never `require()` in this codebase.** It is ESM. `require` exists in the Next
  server bundle and NOT in anything run through tsx, so a lazy
  `require('better-sqlite3')` inside `profileStatus()` threw in every CLI script and
  in the worker, was swallowed by a fail-closed `catch`, and reported every account
  as "not connected". The dashboard worked, so the Send button was fine while
  autopilot could never fire — an environment-dependent silent failure on the gate
  that decides whether unattended sending happens at all. Static `import`, always.
- **A guard that reads the whole page can be a tautology.** The post-send check read
  `body.textContent()` for the message — but the message sits in the composer whether
  Enter worked or not, so it could not fail. What distinguishes sent from not-sent is
  the composer *clearing*. Check the thing that changes, not the thing that is there
  either way.
- **`{{channel}}` must render the greeting name, not `displayName`.** `displayName` is
  an internal label; a target added as "Bollywood Chronicle (test target)" put exactly
  that into the message body.
- **One "busy" flag cannot serve two actions.** The Save button and the Send button
  shared one, and `editing` was in it — so opening the editor rendered Save as
  "Saving…", disabled, before any save had been attempted. Separate flags per action:
  a control must never report the state of something that has not started. Related:
  a confirmation rendered *inside* a block that the success path unmounts is never
  seen — the "Saved." message had to move outside the editor.
- **Never name a script after a pnpm built-in.** `pnpm login` and `pnpm audit` are
  pnpm's own commands — pnpm proxies `login`/`logout`/`whoami` to the npm registry.
  A script with either name is silently unreachable: `pnpm login bollywoodsocietyy`
  opened **npm's sign-in page**, an unrelated credential form, which is the worst
  possible failure for a command whose whole job is "type your password here". And
  `pnpm audit` ran pnpm's vulnerability scanner instead of our data check, so it
  looked like it worked. Both are now namespaced — **`pnpm ig:login`**,
  **`pnpm ig:audit`**. A colon can never collide, so prefix anything ambiguous. Use
  `pnpm run <name>` if you must check whether a bare name resolves to a script.
- **Never run `pnpm build` while `pnpm start` is running.** `next start` reads the
  build manifest at boot; rebuilding underneath it leaves the server serving HTML
  that references replaced chunks, and one returns HTTP 500. Symptom: `curl` gets
  200 but the browser shows "This page couldn't load". Rebuild first, then start.
- **Verifying a page with `curl -w "%{http_code}"` proves the server is alive, not
  that the page works.** Extract the `/_next/static/**.js` references from the HTML
  and request each one.
- **Prisma 7** removed `url` from the datasource: connection config lives in
  `prisma.config.ts`, and `PrismaClient` takes a driver adapter.
- **TypeScript 7** is the Go compiler and does not expose the API Next.js calls —
  `experimental.useTypeScriptCli: true` in `next.config.ts` handles it.
- **`og:description` scraping is dead** for detection. It needed 13 requests, gave
  day-precision dates only, and capped at 12 posts. The feed endpoint replaced it.
- **Fixture lookups by array index are fragile.** Reference by shortcode.

---

## Style

- Comments explain *why*, especially where a choice looks odd. Several decisions
  here are counter-intuitive and will be "fixed" by someone who does not know the
  research — the comment is the defence.
- The governor and matching logic are pure functions. Keep them that way; they are
  where a bug means spam sent to a real prospect.
- The dashboard is for a CEO. No confidence scores, signal arrays, variant labels,
  or detector keys on screen. Raw data belongs in Prisma Studio.
- **Never put a shell command on the page.** The "Needs you" list did, verbatim:
  `Send the next one: pnpm send`, `Raise the send limit (MAX_TOTAL_SENDS in .env)`,
  `Check which channels are failing: pnpm ig:audit`. Every one was a developer
  instruction for something the page could simply *do*, and a to-do list nothing can
  tick off is a nag rather than information. Deleted 2026-08-03; anything a person
  must act on renders on the thing it concerns — the account row, the channel card,
  the reply — beside a control that resolves it.
- **A notification that cannot be dismissed stops being read.** Whatever a banner
  reports must have a way out, or it gets ignored precisely when it matters.
- **A metric that covers part of the data must say which part.** "5 paid campaigns
  spotted" described one channel of five; the coverage line under the metrics names
  the four that are not judged.
- **Ask the detector, never compare the key.** `unclassified` and the coverage note
  both read `detectorKey === 'passthrough'`. Switching `@viralbhayani` to the semantic
  detector turned that false, and the card instantly rendered **"Paid campaigns found:
  0"** for a channel where half of ~62 posts/day are commercial — the exact misleading
  zero the flag exists to prevent, reintroduced by a hardcoded string comparison. Both
  now call `readiness()`, which is the detector's own statement about whether it can
  judge. The reason string is carried through too: "no classifier set up" and "the
  classifier has no API key" are different problems with different fixes and must
  never render as one sentence.
- **Render the real thing and read it.** The brand pitch had 18 passing assertions —
  recency banding, missing-publisher fallback, placeholder substitution, paragraph spacing
  — and one glance at a real message to a real prospect found two defects the suite could
  not catch: `Hi Amazon India,` (a corporation addressed as an individual) and `Hi Milano
  Ice Cream, Bangalore team,` (ungrammatical, in the first line a prospect reads). A test
  asserts what you thought to assert; reading recruits a different faculty. Tests prevent
  regression, reading prevents never-having-been-right, and they are not substitutes.
- **A REFUSAL MUST SAY WHY, ON THE THING IT REFUSES.** A waiting draft rendered its body and a
  "Send from @x" button and said nothing about whether that button would work. Measured
  2026-08-06: all four waiting drafts would have been refused — three `no-session`, one
  `target-replied` — so the most prominent control on the page could only produce an error, on a
  screen whose entire design principle is that *"nothing happened" with no explanation* is the
  failure this project keeps rediscovering. The dispatcher panel explained why the FLEET was
  idle; nothing explained why THIS message was. The reason now comes from `recheckBeforeSend` —
  the same function that refuses — and is rendered verbatim; only the "where to fix it" link is
  the UI's own. Never re-derive a verdict a guard already computes.
- **DUPLICATION IS A FAILURE OF THE SAME KIND AS SILENCE.** The redesign found the same reply on
  `/` three times (headline, card, history row), the whole draft tray on two pages, a route
  count twice on one row, and a reply block rendered twice on `/conversations` with two buttons
  doing the same thing. A reader who sees a fact twice learns to skip it, and an operator who
  presses the first of two identical buttons and sees the second still there concludes it did
  not work.
- **If the person a warning is FOR has to ask what it means, it has failed.** The
  persona-gate banner was accurate and assumed the reader knew that "persona" meant the
  signature at the bottom of every message. Tabish asked. It now shows the actual signature
  and names the specific mismatch. Accuracy is not the bar for a warning; being understood
  by the person who must act on it is.
- **The pipeline diagram is part of the deliverable, not a one-off.** Tabish keeps
  https://claude.ai/code/artifact/517b2e18-4c61-428c-a300-9b21de07d1c6 as his picture of
  how this works. **Whenever the flow of operations changes, update it in the same session
  and give him the link.** Re-publish by passing that URL as `url` — a conversation that did
  not originally publish it otherwise mints a new one and he loses the bookmark. Build it
  from the CODE: writing it the first time, reading `runSlot.ts` corrected two things the
  docs alone would have got wrong. See `docs/PIPELINE.md`.
- Report outcomes faithfully. If something is unverified, say it is unverified.
