# The pipeline diagram

https://claude.ai/code/artifact/517b2e18-4c61-428c-a300-9b21de07d1c6

> ## ⚠ STALE SINCE 2026-08-18 EVENING, AND MORE SO SINCE 2026-08-19 — the SPINE changed too
>
> The drawing still shows twelve gate questions, the 7-day spacing, per-sender daily caps
> and the persona stops. The gate now asks EIGHT questions (the one volume rule is
> `pair-daily-cap`, 5/day per account→recipient), the message is one verbatim template
> with no greeting or signature, the fleet hourly allowance is gone (the gap paces
> instead), rotation hash-spreads fresh recipients across all six accounts, and the
> reply pause is two days.
>
> **2026-08-19 additionally changed the CLOCKS, which is the spine itself:**
>
> - **the reply reads are NOT at 11:00/20:00 on the server any more** — they run on the
>   DEVICE AGENT every 30 minutes inside 10:00-21:00 IST, under the send lock (the
>   server schedule still fires and still no-ops; the device is where the sessions are).
> - **the fleet gap is ONE minute** (5 → 3 → 1 on 2026-08-19), device tick every 30s — so
>   the send lane's ceiling line is wrong (~500-600/day of headroom, the architecture's
>   floor).
> - **the send path now bypasses FOUR recipient-side blockers** (hidden button → … menu,
>   the partnership interstitial, the "Turn on notifications" modal, and profiles with NO
>   door → the inbox-compose route), all in `messageEntry.ts`. A failed draft re-queues to
>   the BACK so the queue proceeds; 3 tries then park visibly.
> - **a sender leaving the rotation hands its queue off by rotation**
>   (`handOffWaitingDrafts`) — a new arrow the drawing has no notion of; and
>   @madaboutmarketingg is out (5 accounts in the ring, not 6).
> - the Message click has TWO doors now (the button, or the … menu's "Send message") —
>   one box, but its caption claims one.
>
> Rebuild the clock lanes and figure 3's rules panel from `agent/index.ts`,
> `pacing.ts`, `gate.ts`/`governor.ts` before trusting the drawing, and republish to the
> SAME URL above.

> ## REBUILT 2026-08-17 AFTERNOON, from the deployed code and the live database. Title unchanged: **Three Clocks**.
>
> Same URL, same 🔁 favicon, `force: true`. The previous version was written on 13 August and
> **the 17 August restructure invalidated its spine**, not merely its numbers: it said ELEVEN
> gate questions and there are now twelve, it drew a verdict set containing REVIEW which no
> longer exists, and it had no notion of the two target types.
>
> **What changed in the drawing, and why each is a mechanism rather than a number:**
>
> 1. **The footage can now MINT a paid verdict.** The old page drew it as able only to flag a
>    post for a human. Figure 2 now shows the raise arm ending in PAID, annotated *11 found this
>    way*, with the three things it still may never do written under the figure — it cannot
>    clear a paid post, overturn one, give an unjudged post a verdict, or touch a human answer.
> 2. **Two target types.** Figure 3 opens on `watched publisher → never messaged`, because
>    confusing the publisher with the prospect is the mistake the system made for months, and no
>    figure had ever drawn the distinction.
> 3. **Brand candidates come from two sources.** The caption's @mentions AND the accounts
>    Instagram tags, with the caption arm marked *asked first* — the bound is a lookup budget, so
>    ordering is the mechanism, not a preference.
> 4. **Twelve questions**, `target-is-watch-only` among them, with the single crossable stop
>    chipped and a note on why it is the only one that may be crossed.
>
> **Figures re-measured the same afternoon, from the live Postgres:** 2,617 posts since 1 Aug ·
> 328 judged paid · 1,267 with the video read · **11 paid that only the footage found** · 5 human
> answers (the 21 poisoned ones are cleared) · 91 companies live, 6 retired · **0 waiting drafts**
> · **1 delivered ever** · $0.18 across 7,014 model calls.
>
> **The "what is true today" table is the replacement for a "known wrong" section**, and it is
> deliberately not a to-do list: detection is NOT broken, the 98% figure is not comparable
> (78.6% where ground truth was built properly), the company classifier has no harness at all,
> and one page of three can actually send. A reader who takes only that table away has the
> honest state of the system.
>
> **Verified before publishing, and the checker was MUTATION-TESTED:** every `<text>` inside its
> own viewBox, no label straddling a box it does not belong to, no sideways scroll, and `body`
> painting its own ground — asserted in BOTH themes. Injecting a label 960px into a 900-wide
> frame and shifting a box 56px into its neighbour produced 6 failures across the two themes;
> restoring them passed. A checker that has never failed proves nothing.

> ## REBUILT 2026-08-13 EVENING, and the debt above is CLEARED. Title: **Three Clocks**.
>
> Same URL, same 🔁 favicon, `force: true`. Rebuilt from the code and the live database, not
> from the old page.
>
> **THE "KNOWN WRONG" SECTION IS GONE, BECAUSE ALL FIVE OF ITS ITEMS ARE NOW FIXED.** That is
> the trigger for this rebuild: a stale "known wrong" list is worse than none, since it is the
> part a reader trusts to be current. Rotation, the handle-in-prose defect and the ten-second
> dashboard were fixed in the afternoon; **drafting gated on Autopilot** and **the new-brand cap
> counting deliveries** were fixed in the evening, together, as the plan required.
>
> What replaces it is a section naming what is ACTUALLY wrong now, all three measured:
>
> 1. the accuracy figure is measured on the one channel where the classifier never runs;
> 2. **21 of the 24 human answers were written by a script in one second on 8 August**, including
>    both founding cases of the footage feature — Tabish's decision, surfaced not rewritten;
> 3. finding new companies does not work from the server (Instagram refuses the datacenter IP).
>
> **What is drawn.** Two figures, because the flow genuinely has two shapes worth a picture.
> *The three clocks* is now three LANES rather than a spine — look/judge/decide-who-paid/write
> on the 15-minute clock, ask-eleven-questions/send on the 10:00-21:00 clock, read-the-
> conversations at 11:00 and 20:00 — because the thing a reader most needs is which stage sits
> on which clock, and the two fifteens are the same number for unrelated reasons. *Who a message
> is written to* draws the brand decision with its two REFUSING arms given equal weight: **not
> sure — left alone** and **a profession — left alone** (8 of the 71 are people).
>
> The eleven gate questions are a numbered list rather than a figure, with the one crossable
> stop chipped. Eleven, not ten: `HOOK_STALE_SINCE_DRAFT` joined them.
>
> Figures re-measured the same evening: 2,382 posts since 1 Aug, 238 judged paid, 1,050 with the
> video read, 19 awaiting an answer, 71 companies found (8 of them people), 26 written and
> waiting, **0 delivered ever**, $0.12 across 4,776 questions, **1 page able to send**.
>
> **Verified before publishing**, and the checker was MUTATION-TESTED: an em-dash injected into
> a `<text>`, a box shifted 80px into its neighbour, and a label pushed past the frame each made
> it fail. It also checks both themes are defined at token level and that `body` paints its own
> ground. Then both themes were rendered in a real browser at 2x and READ — which is what caught
> an arm label crowding the box beside it in dark, invisible to every geometry assertion.
>
> ---
>
> ---
>
> ## REBUILT 2026-08-13, from the code and the live database. The debt below is CLEARED.
>
> The page was owed a rebuild from the 2026-08-11 one-switch session and did not get one for
> two days. It has now been rebuilt from source rather than from the old page, and it carries
> a **"Known wrong"** section naming the five things CLAUDE.md asserts that the running system
> does not do — rotation never running, drafting gated on Autopilot, the new-brand cap
> counting deliveries, six drafts addressing a company by its username, and the ten-second
> dashboard. A diagram that hides those would be worse than no diagram.
>
> Three figures, each carrying one claim: the **three cadences** (and which gate stops which),
> **rotation intended against rotation as it happens**, and the **judging permission table**.
>
> **The historical spec below is kept because it explains the shape of the 2026-08-08 change.**
> Read it as history now, not as a to-do list.
>
> **The trigger is the biggest kind: a whole class of control was DELETED from the flow, and
> a new automatic stage was added.** Tabish, 2026-08-08: *"The moment autopilot is turned on
> there must be no more switches. One switch to turn on the process (which gets tracked) and
> when the switch is turned off no sabotage or discrepancy should take place. The channels
> which are undecided must also be decided on their own. How can adidas not be recognized as
> anything? I do not want this option to select manually, correct it. Automated mode must
> simply send the messages."*
>
> ### What the CURRENT flow is
>
> ```
>   every 15 MINUTES, all day  ─┬─  1. LOOK      anonymous feed read; cover frames saved.
>   (detection's own clock,     │               A post we ALREADY have is re-checked too:
>    NOT the send schedule)     │               a publisher can add a brand tag or a
>                               │               co-author AFTER posting, and until
>                               │               2026-08-13 that edit was invisible forever
>                               │   2. JUDGE     caption first and ALONE, then the words on
>                               │               the video; the video may only raise a post
>                               │               to "worth a look"
>                               ├─  3. DECIDE WHO THE BRANDS ARE   ← NEW, and automatic
>                               │               @mentions in paid captions → is this a
>                               │               company or a person. Instagram's own answer
>                               │               wins when it gave one; when it cannot (it
>                               │               returns an error for @adidas), a model
>                               │               answers, and IT SAYS "not sure" RATHER THAN
>                               │               GUESSING. No human queue any more.
>                               └─  4. WRITE     ← MOVED HERE 2026-08-11 (was one of the
>                                               four daily slots). A post found at 11:20 no
>                                               longer waits until 15:00 to be written about
>
>   every 15 MINUTES, 10:00-21:00 IST ONLY
>       5. SEND      at most ONE message a tick, under one lock. Unchanged.
>
>   at 11:00 and 20:00 only
>       6. READ THE CONVERSATIONS   for replies. Unchanged.
> ```
>
> ### STILL OWED, and now with a second session's delta on top (2026-08-13)
>
> The rebuild below was owed from 2026-08-11 and did not happen. The tags/collabs session
> adds one small thing to draw and nothing that contradicts the above:
>
> - **Stage 1 now re-checks posts it already has.** One line in reader words: *"we look
>   again at posts we already saved, because a publisher can tag a brand after posting."*
>   It is not a new stage and does not deserve its own box — it is a property of LOOK.
> - **Nothing else in the flow moved.** The tag evidence built this session is switched
>   OFF (`tagsAsEvidence`, measured: precision 90% -> 83%), so the JUDGE box is unchanged.
>   Do not draw it.
> - **The "worth a look" box gains a way back.** Answering a post now waits five seconds
>   before it is written, and an answer already given can be changed — which matters
>   because 21 posts, including the Thane bus, are currently recorded as "not paid" by a
>   bulk script and were reachable from no screen.
>
> ### What must change ON THE PAGE
>
> 1. **The switch count. There is ONE.** The old page had "0 of 3 business pages armed" and
>    "4 of 43 routes on" in its figures strip — **both of those controls no longer exist**
>    and the numbers are meaningless now. Replace them with what actually decides: the one
>    Autopilot switch, and then **how many accounts CAN send** (which is 1 — only Bollywood
>    Chronicle is signed in). Ability is derived from a live sign-in, not from a switch.
> 2. **A new stage in the watch: deciding who the brands are.** It belongs on the spine
>    between judging and writing, because it is what creates a recipient. In reader words:
>    *"a paid post names the company that paid for it — we work out whether that name is a
>    company or a person, and only companies get written to."* Say that the model **answers
>    "not sure" and is believed** when it does, because that is the guard.
> 3. **The stop list is now 10, not 12** (`gate.ts`). The two that went are *"this account
>    is not switched on for automatic sending"* and *"this route is switched off"* — both
>    were switches. **Every other stop is unchanged and still enforced**, which is the point
>    to make on the page: nothing protecting the accounts was removed. Rebuild the list from
>    execution order with the greps below, as always.
> 4. **Only ONE stop may still be crossed by a person** — *"they have replied"*. The route
>    switch was the other one and it is gone with the chips.
> 5. **Writing is on the fast clock now.** The old page's spine implied the four daily slots
>    wrote the messages. Redraw so that looking, judging, deciding brands and writing all
>    hang off the 15-minute clock, and only SENDING and the reply reads sit on their own
>    schedules. This is the single most likely thing for a reader to get wrong, because the
>    two 15-minute clocks are the same number for unrelated reasons.
> 6. **State the exposure honestly, on the page.** A brand discovered at 11:20 can be
>    written to and sent to the same afternoon, with no human step in between. What holds it
>    back is the pacing and the caps, not a person. The old page's implicit reassurance —
>    routes are off until you turn them on — is false and must not survive the rebuild.
> 7. **The honest limit is unchanged and still belongs on the page**: your own computer is
>    the only thing that can send, so if it is off, messages wait.
>
> Figures must be RE-MEASURED before publishing; every number in the notes below is stale.
> Keep the same URL (pass it as `url`), the same 🔁 favicon, `force: true`, and run the
> existing ASCII + geometry checker.

> ## Rebuilt from the code 2026-08-08 (the hosting session). Same URL, same 🔁 favicon.
>
> **The trigger was the biggest one this file has ever had: the flow now spans TWO
> MACHINES.** Detection, judging and the dashboard moved to the Linode; sending stayed on
> a person's own computer, because that is where the Instagram sign-in legitimately lives.
> A diagram showing one machine doing everything would mislead a reader about the single
> most important fact in the system.
>
> What the page now shows, all of it from the code:
>
> 1. **Two columns with a line between them** — THE SERVER (always on, cannot send, holds
>    no sign-in) and YOUR OWN COMPUTER (the only machine that can send). They meet at one
>    shared notebook, which is the database, and the arrow across the boundary is labelled
>    *picks it up*.
> 2. **The reason the boundary exists is on the page in plain words**: Instagram remembers
>    the computer and the connection you signed in from, copying that to a rented server
>    would work right up until it does not, so the server never gets one.
> 3. **The honest limit is stated rather than buried**: if your computer is off, nothing
>    sends — messages wait. Closing the browser tab is fine, and the page says so, because
>    that is the thing a reader will assume is the same.
> 4. **The stop list is 12 questions in execution order**, in reader words, with the note
>    that only the FIRST "no" is reported, and that every one is asked AGAIN on the sending
>    computer rather than only when the message was written.
> 5. **The video-reading step is part of the flow now**, not a command someone runs. The
>    Thane bus is the example on the page because it is the case that proves the point.
> 6. **The front door**: a code to create an account, and a new account that can read
>    everything and change nothing until approved.
>
> Figures re-measured from the live Postgres the same day: 1,868 posts, 158 paid, 20 worth
> a look, 114 videos read, 2,077 questions, $0.05 lifetime, 6 waiting, 8 delivered ever,
> 4 of 43 routes on, 0 of 3 business pages armed.
>
> **Verified before publishing.** A checker asserts no mojibake anywhere and pure ASCII
> inside every SVG `<text>` — the previous rebuild passed a geometry check and still
> shipped `â€"` in three places — plus zero overlapping content boxes. It was
> MUTATION-TESTED: re-injecting one em-dash into the SVG made it fail, so it is catching
> something rather than passing vacuously. It caught a real em-dash on the first run.

**THE FLOWCHART — the one to keep current:**
**https://claude.ai/code/artifact/517b2e18-4c61-428c-a300-9b21de07d1c6** 🔁

> ## Rebuilt from the code 2026-08-11 (the one-switch session). REBUILT, not owed.
>
> Same URL, same 🔁 favicon, `force: true`. Three triggers fired at once — a control was
> removed, a stage moved between clocks, and a decision moved from a person to the system:
>
> 1. **ONE SWITCH, and the page opens with it.** Three of the four yeses are gone: the
>    per-account arming toggle, the chip per sender×channel route, and the manual
>    company/not-a-company buttons. The page says what ON means end to end and — the part
>    that needed saying, because it is what Tabish asked for — what OFF means: the
>    dispatcher stops at its next decision point, one in-flight message finishes, drafts
>    keep their Send buttons, **nothing else changes state**.
> 2. **THERE ARE THREE CLOCKS NOW AND THE DIAGRAM IS ORGANISED BY THEM**, because that is
>    the thing a reader most needs and the old layout hid: writing MOVED from the four IST
>    slots onto the 15-minute detect clock, so a post found at 02:00 is a draft by 02:15.
>    Sending stayed on its own 15-minute tick inside 10:00–21:00. Reply reads are still
>    11:00 and 20:00 only. A stage changing clock is a flow change even when the stage
>    itself is untouched.
> 3. **Brand decisions are a second figure, because the `@adidas` case is the whole point.**
>    Instagram's category lookup fails on precisely the accounts most likely to be brands,
>    so the page shows the endpoint answering when it can, the classifier answering the one
>    question it cannot, and the third arm that matters most: **not confident → left alone,
>    never written to and never queued for a person.**
> 4. **The stop list is TEN, not twelve.** `auto-send-off` and `pair-disabled` are gone and
>    the page says so and why. Exactly one stop is crossable by a person now.
> 5. Figures re-measured from the live Postgres the same day: 2,364 posts, 192 judged paid
>    in window, 11 worth a look, 463 videos read, $0.075 lifetime, **1 page able to send**.
>    That last number is deliberately the last thing on the page: two of the three business
>    pages have never been signed in, so they cannot send whatever the switch says.
>    `delivered ever` is 0 because the rehearsal history was deleted on 2026-08-08 at
>    Tabish's instruction — a real figure, not a bug, and left off rather than explained.
>
> **Verified before publishing**, both questions separately, because this file records that
> geometry passed once on a page that still shipped `â€"`: a checker asserts zero non-ASCII
> anywhere AND inside all 36 `<text>` elements, zero overlapping boxes, and every shape and
> label inside its `viewBox`. **MUTATION-TESTED** — an injected em-dash, a box shifted 80px
> into its neighbour, and a label pushed past the frame each made it fail, so it is catching
> something rather than passing vacuously. It also caught a corrupted CSS token I had
> introduced myself (`--hold: #d9b košík`), which no geometry check would ever have seen.

> ## Rebuilt from the code 2026-08-06 LATE EVENING (the connect-fix session).
>
> Same URL, same 🔁 favicon, `force: true`. **The send path gained a real branch and the
> page's headline claim had become false**, which is both triggers at once:
>
> 1. **The identity check is now TWO diamonds, not one** — *"Can we check who is signed
>    in?"* then *"Is it the right account?"* — because those were one box and a dead
>    Instagram address read as "signed out". The first arm is grey (**held, nothing
>    recorded**), the second amber (**signed out, recorded, account stops**). The colour
>    now carries the distinction the fix introduced, so the legend gained two entries:
>    *waits, nothing recorded* / *needs you*. Root cause is under Gotchas in CLAUDE.md.
> 2. **"Nothing sends because no account is signed in" was partly an artefact of that
>    bug.** `@tabishmukaddam1` was signed in the whole time. The page now says what is
>    actually true: autopilot is off, the rehearsal account is signed in and confirmed,
>    the three real pages never have been.
> 3. **The 12-stop list is on the page in execution order**, in reader words, with the
>    note that only the FIRST stop is reported — verified with the greps below.
> 4. Figures re-measured: 1,488 posts stored, 92 judged paid, 227 calls, $0.0057 lifetime,
>    6 of 43 routes on, 4 waiting, 8 delivered ever.
>
> **Verified before publishing**, because the last rebuild passed a geometry check and
> still said `â€"` in three places: a checker asserts pure ASCII, 18 shapes with zero
> overlaps, every spine arrow joining two shapes, and every exception arm landing on a
> box — and it was MUTATION-TESTED (shift a diamond 80px, insert one em-dash: it caught
> all three). Then both themes were rendered in a real browser and READ, which is what
> caught a muddled opening paragraph that claimed "two checks" and then described three.
>
> ## The previous note, 2026-08-06 EVENING (the simple-sender session)
>
> Same URL, same 🔁 favicon, published with `force: true` as this file prescribes. What
> changed on the page, and why a rebuild was owed:
>
> 1. **The send path gained a real branch** — §3.5 of the simple-sender plan. A send that
>    hits a login form now RECORDS the dead session on the account (`markSessionInvalid`),
>    the existing "not signed in" stop holds everything from that account, and only a hand
>    sign-in or a delivered message clears it. Before this, a dead session was filed as an
>    ordinary retry and the dispatcher drove a browser at it every 15 minutes forever. The
>    diagram now shows the "Did Instagram show a login form?" diamond.
> 2. **The stale headline sentence is fixed**: nothing sends because NO ACCOUNT IS SIGNED
>    IN — the persona gate released on 2026-08-05/06 and is no longer the cause.
> 3. **The cost strip carries the measured figures**: $0.0054 across 216 calls (3 failed),
>    1,461 posts stored, 90 judged paid.
> 4. **The send-time stop list has 12 entries** in gate execution order, including the
>    "found logged out" clause under stop 8, and notes the single template (built 2026-08-06,
>    switched off).

**The detailed reference, published 2026-08-06 on request:**
**https://claude.ai/code/artifact/6b36e2f5-f780-4071-b9d7-2e6ce1f3103d** 📋

TWO PAGES NOW EXIST AND THEY WILL DRIFT. That is the failure this file was written to
prevent, so the rule is explicit: **the flowchart is authoritative and is the one the
"update it in the same session" rule applies to.** The detailed page is a snapshot of
2026-08-05 that Tabish asked to keep after the flowchart replaced it; it is already behind
(it predates `PERSONA_CHANGED_SINCE_DRAFT` and the per-account channel names). Either bring
it forward when the flow changes, or say plainly that it is a snapshot — never leave it
looking current.

Tabish's picture of how this system works. **It is a flowchart** — boxes, diamonds, arrows,
minimal words — because he asked for exactly that on 2026-08-06 after two prose-and-cards
versions. Do not turn it back into an explainer. Written for a reader rather than a
developer: "Instagram objected", not `CHALLENGED`.

Nine shapes on one spine: paid post → write → four decisions → send → arrived? → delivered,
with a dashed loop back for the next tick. Every branch is a real branch in the code
(`pacing.ts` for the fleet gate, `gate.ts` for the rules, `replyCheck.ts` for the thread
read, `sendDm.ts` for the arrival check), and the strip underneath carries every ceiling.

---

## The rule

**Whenever the flow of operations changes, update the diagram in the same session and give
him the link.** He asked for this explicitly on 2026-08-04. A diagram that is quietly wrong
is worse than no diagram: it is the thing he will trust when reasoning about a change.

**Re-publish by passing that URL as `url`** to the `Artifact` tool. A conversation that did
not originally publish it will otherwise mint a brand-new URL, and he loses the one he has.
Keep the favicon 🔁 unchanged for the same reason — people find a tab by its icon.

## Last rebuilt 2026-08-06 — now an actual FLOWCHART

Same URL, same 🔁 favicon. What is new on the page:

- **the cohort ladder** as stop 4 of the send-time list — new accounts go live a few at a time
- **"a random pause decided whether a reply was seen"**, written for a reader: Instagram
  rearranges the conversation ~2.5s after it opens, and the system waited a random 2-3.5s
- **the post-send check is a delta now** — "one more occurrence than before it typed"
- **a body a recipient has already read is refused**, and the pool running out refuses rather
  than repeating
- **the generator exists and is off**, said plainly in the cost table rather than hidden
- the cost table carries the real lifetime figure ($0.0017 across 41 requests)

**A build lesson worth keeping.** The stop lists are numbered because the governor reports the
FIRST stop it hits — so they must be built from the code's **execution order**, not from the
`SKIP_REASONS` constant list. Those two disagree: the constants declare `COOLDOWN_ACTIVE` 7th
and `UNANSWERED_LIMIT` 9th, while the code checks the unanswered cap first. A diagram built
from the declaration list is wrong at positions 7-9, and it would look right.

Verify with:

```
grep -nE "reason: SKIP_REASONS\.[A-Z_]+" src/outreach/governor.ts
grep -nE "reason: RESEND_BLOCKS\.[A-Z_]+" src/outreach/gate.ts
```

## The 2026-08-05 rebuild after Phases 5-7

The thesis of that revision: **the system now runs on TWO CLOCKS**, and that is the first
thing on the page. Delivery left the slot, so "the check" (4×/day, looks and writes) and
"the sender" (every 15 min, 10:00-21:00, one message) are separate sequences with separate
stop rules. The previous version showed one sequence, which is now wrong in the way that
matters most — it implied a message goes out on the same clock that found the post.

Also new on the page: the fleet-wide halt when any account is questioned, the conversation
read before a follow-up, and the fact that **nothing is sending today** because every page
signs off as the same person.

**"1 per tick" beside "5 min between sends" reads as though a tick were 5 minutes.** He asked
how 3/hour was possible if a tick is 5 minutes — it is 15. Two different numbers sat in one
undifferentiated list and the reader joined them. The strip is now split into **rhythm** (a tick
every 15 min, 1 per tick, 5 min apart minimum, 10:00-21:00) and **ceilings** (3/hour, 2 per
recipient, 5 per account, 7 days), with the derived total called out separately.

**The daily maximum is 33, and it is EMERGENT rather than chosen.** 3 an hour across an
11-hour window. Nothing sets a daily total — `fleetMaxPerDay` is unlimited by Tabish's
decision — so 33 is a consequence of two other numbers and moves silently if either changes.
Worth saying out loud whenever the window or the hourly pace is touched.

**"Appeared in the thread" was jargon, and he asked what it meant.** That is the test failing,
not a question: CLAUDE.md's own rule is that a label the reader has to ask about has not done
its job. `thread` is Instagram's word. The diamonds now read **"Did it show up in the chat?"**
and **"Read the chat — have they replied?"**, and the box beside the first says *"You check it
/ never sent twice"* rather than *"Needs a human / never retried"*. Note the second rewrite
FLIPPED the branch sense — "still quiet?" and "have they replied?" take opposite yes/no arms —
so the arm labels had to swap with it. Renaming a decision is never only a text change.

**Two things that bit the 2026-08-06 rebuild, both found by LOOKING at a screenshot rather
than by the geometry check that had just passed:**

1. **Non-ASCII characters render as mojibake.** `10:00–21:00` came out `10:00â€"21:00`. The
   publish wrapper owns `<head>`, so the file cannot declare its own charset — use HTML
   entities (`&ndash;`, `&mdash;`) for anything outside ASCII.
2. Hand-authored SVG needs a real geometry assertion: every shape's `getBBox()` against every
   other, plus text inside the `viewBox`. It passed here (13 shapes, 0 overlaps) and still
   said `â€"` in three places, which is the whole point — geometry and legibility are
   different questions and only reading answers the second.

**A note for whoever rebuilds it next.** The artifact renders client-side, so a plain HTTP
fetch returns the shell and nothing else. **Re-confirmed 2026-08-05:** the fetch returns 200
with 13.8 KB of app shell and none of the page's own content, so the previous version cannot
be read from a session that did not publish it. `Artifact` will therefore refuse with *"this
session hasn't viewed the latest version"* and you must pass `force: true`.

That is safe HERE and would not be safe elsewhere: this page is DERIVED from the code, so
there is nothing in the old version to merge. Rebuild it, do not patch it.

## What counts as the flow changing

Anything that would make the diagram wrong, which is broader than "anything in the repo":

- the order of stages inside `runSlot` — detect → reply check → **one dispatch tick** → plan
- **which CLOCK a stage runs on.** Since 2026-08-11 there are three: detect-and-write every
  15 min all day, send every 15 min inside 10:00-21:00, reply reads at 11:00 and 20:00. A
  stage moving between them is a flow change even when the stage itself is untouched — that
  is exactly what happened when writing left the slots.
- anything about the DISPATCHER's own sequence: the breaker, active hours, the gap, the
  hourly pace, rotation, the just-in-time conversation read
- which slots do what (reply checking is **11:00 and 20:00 only**, not all four)
- a rule added, removed or **reordered** in `governor.ts`, `gate.ts` or `brandGuards.ts` —
  the diagram numbers them because the governor genuinely reports the *first* stop it hits
- a stop changing category: hard stop / a person may cross / brands only
- **a CONTROL being added or removed.** The 2026-08-08 one-switch change removed two stops
  and two whole classes of switch, and a diagram still showing "0 of 3 pages armed" would
  have had a reader reasoning about a control that does not exist.
- **a decision moving from a person to the system, or back.** Brand resolution stopped being
  a human queue on 2026-08-08; the page had shown a review step that is now automatic.
- how a message is written, or which variant pool it comes from
- a new entry point — on-demand send, brand discovery, `pnpm send`
- the cost model: who calls the model, or what it costs (brand resolution is a fourth
  purpose, `'resolve'`, and has its own line on /cost)

## Build it from the CODE, never from the docs

Writing it the first time, reading `runSlot.ts` corrected two things that memory and the
prose docs would have got wrong:

1. **Inside a slot the real order is detect → check replies → deliver → plan.** "Detect →
   draft → send" is the intuitive shape and it is wrong. Delivering *before* planning is
   load-bearing: without it, a message drafted while autopilot was off could never be sent by
   autopilot afterwards. **But since 2026-08-11 the slot is no longer where drafting normally
   happens** — detect-and-write runs every 15 minutes on its own cron, and planning there
   takes the SLOT LOCK, because minute 0 is always a multiple of 15 so the two collide four
   times a day by construction. `noOverlap` is per task and does not help. Two concurrent
   planners would both draft the same pair and put two DMs in one inbox.
2. **Reply checking runs at two slots, not four.** Reading inboxes opens a browser, so it is
   deliberately twice a day.
3. **Since Phase 5 the slot's delivery step is ONE tick, not the queue.** Reading `runSlot.ts`
   alone would still suggest "the slot delivers"; it delivers at most one message, and the
   15-minute dispatcher does the rest. A diagram drawn from the slot alone would imply a
   burst that can no longer happen.
4. **The planner does not send.** It writes drafts and stops. Drawing an arrow from "prepare"
   to "send" would put back the second, unpaced send path Phase 5 removed.

## Treatment

Utilitarian. He asked twice for "simple and understandable" and explicitly "do not bloat" —
it is a reference to consult, not a poster. Palette is pulled from the dashboard's own
`src/app/globals.css` so the diagram and the product read as one system. Any figure on the
page must be one that was actually measured; the cost numbers come from the real
`ig:classify` runs and were re-derived before publishing.

## Republished 2026-08-08 (the free-OCR session). Current.

Same URL, same 🔁 favicon, `force: true`. **The previous night's version made a claim that
is now false** — it said the picture check was "waiting on a key". There is no key: Tabish
rejected a paid vision API, and what shipped reads the words printed on the video LOCALLY,
offline, for nothing. On the page:

- the callout names the real mechanism in reader words: the caption mentions no brand, the
  frame says "THANE's First Double Decker Bus" with **SWITCH** on the bumper.
- the second diamond reads **"Do the words on the video sell something?"** — not "does the
  picture look like an ad", which described a model nobody is paying for.
- the figcaption states the ordering (caption judged first, alone) and the limit (the words
  can only move a post to "worth a look"), plus the two controls that were tested and
  correctly ignored: a salon sign behind a celebrity, sponsor boards at a chess match.
- a **"waiting for your answer"** row — the review queue is answerable now, and each answer
  is the only label that exists for a paid post the caption cannot reveal.
- figures re-measured: 1,326 posts since 1 Aug, 140 judged paid, 1,708 calls, $0.039
  lifetime, 206 pictures saved, 18 awaiting an answer.

Checks green before publishing: pure ASCII, 22 shapes across two figures, 0 overlaps, every
text inside its viewBox.

## The previous note, 2026-08-07 night — SUPERSEDED. Its central claim was wrong: it
## described a Gemini-based check "waiting on a key", reverted the next day for free local
## OCR. Kept only because it explains the shape.


Same URL, same 🔁 favicon, `force: true` (this session had not published it; the page is
derived from the code, so it was rebuilt, not patched — as this file prescribes). **The
watch gained a real branch**: when the caption says *ordinary*, the video's cover picture
is now judged too, and a commercial-looking picture flags the post for review. On the page:

- the watch figure has the new picture diamond, drawn in the accent colour, feeding an
  amber "Flagged for your review — from the footage" box. The caption beneath says the
  three load-bearing facts in reader words: it only flags, it never decides, and a visible
  brand is not proof of payment.
- a one-line "New (7 Aug)" callout at the top names the Thane bus as the reason.
- the figures table carries the picture check honestly: built, ~$0.0001 a picture,
  **waiting on a key**, 156 cover pictures saved including the Thane bus.
- figures re-measured: 1,310 posts since 1 Aug, 136 judged paid, 1,308 calls, $0.0267
  lifetime, 4 of 43 routes on, 6 waiting, 8 delivered ever.

Checks green before publishing: pure ASCII bytes, 22 shapes across two figures, 0
overlaps, every text inside its viewBox.

## The previous note, 2026-08-07 (the detection-cadence session).

Same URL, same 🔁 favicon, `force: true`. **Detection got its own clock**, so the page's
opening line was actively misleading — it read *"the loop runs every 15 minutes"*, one
sentence for two now-unrelated schedules. On the page:

- the sub-line names **two separate clocks**: paid posts looked for every 15 minutes all
  day; messages at most one every 15 minutes, 10:00-21:00 IST. Same number, unrelated
  reasons, and conflating them is what the sentence used to do.
- the start terminator says *"we look every 15 min, all day"* — the speed is the change.
- the tail explains WHY they are unlinked in a reader's terms: watching a public feed cannot
  bother anyone, and coupling them left posts unseen overnight for fifteen hours.
- figures re-measured: 1,224 posts since 1 Aug, 119 judged paid, 1,213 calls, $0.0247.

Checks green before publishing (pure ASCII, 18 shapes, 0 overlaps).

## The previous note, 2026-08-07 (the reply-auto-resume session).

Same URL, same 🔁 favicon, `force: true`. The flow genuinely changed — **Tabish removed
the manual reply-release: a reply pauses its target for one day, then messaging resumes on
its own** (`replyResumeHours` Setting, default 24; src/outreach/replyHalt.ts). On the page:

- the reply branch's box is now GREY ("Paused for a day / then resumes itself") — it no
  longer needs a person, so it left the amber needs-you family.
- stop 7 reads "They have not replied in the last day"; stop 9 now says the signature is
  the PAGE name and contacts (the persona-only-channel-name change, same day).
- figures re-measured: 1,623 posts, 108 judged paid, 476 calls, $0.0118 lifetime, 4 of 43
  routes on, 6 waiting; classifier at 98% / 100% recall / 92% precision (n=48).
- the tail says TWO accounts are signed in (burner + Bollywood Chronicle).

Geometry/ASCII checks all green before publishing (the mutation-tested checker from the
previous rebuild).
