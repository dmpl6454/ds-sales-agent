# Make it a simple end-to-end sender

**Written** 2026-08-06 after Tabish said the UI is *"bloated with information"* and *"dumped with
confusing information"*, and asked for seven specific pages. **Status: proposed, nothing built.**

This is the third UI pass. The first two added structure (a sidebar, then nine single-job pages)
and both times the complaint stayed the same, so the problem is not the number of pages. It is
the **volume of prose on operational screens.**

---

## 0. The measurement, so "simple" is not a feeling

Operator-facing words in `src/app`, comments and code excluded:

| file | words |
|---|---|
| `accounts.tsx` | 2,505 |
| `settings/form.tsx` | 1,204 |
| `channels.tsx` | 1,082 |
| `accounts/login/queue.tsx` | 1,011 |
| `prospects/list.tsx` | 995 |
| `autopilot.tsx` | 949 |
| `messages/waiting.tsx` | 946 |
| **total across the dashboard** | **~18,700** |

That is roughly 37 printed pages of text in a tool whose stated audience is a CEO. (Upper bound
— the counter also catches tooltips and button titles.) Every paragraph was written for a good
reason; the mistake is *where* they live.

**The diagnosis:** two different kinds of sentence are mixed on every screen.

- **A refusal** — "this cannot be sent: the account is not connected." Load-bearing. Never cut.
- **A rationale** — "Messages go out one at a time, a few minutes apart… fourteen messages
  arriving in one hour from fourteen different pages is what gets accounts reported." True,
  important, and it does not belong beside a button.

**The fix is the Rules page Tabish asked for.** It is not a seventh page of content; it is the
*destination for every rationale paragraph currently sitting on an operational screen.* That one
move is what makes the other six pages short, and it loses nothing.

---

## 1. Seven pages, one job each — and AUTOPILOT IS THE PRODUCT

Corrected by Tabish 2026-08-06: *"the manual sending is just a simple feature, the main selling
point is autopilot."* That changes which page is the front door.

The landing page is **Autopilot**, and its job is to answer one question: *is it sending, and if
not, exactly what is stopping it.* Manual send is not a separate page — it is the same queue with
a button on it, which is what "just a simple feature" should look like.

| page | one job | what it shows | rationale moves to Rules |
|---|---|---|---|
| **Autopilot** *(landing)* | is it sending, and if not why | the switch · per-account readiness · what the last tick did · the queue, each draft with its refusal reason and a Send button | pacing, the four switches |
| **Paid posts** | what we found | table: date · channel · brand · **link to the post** · verdict | why UNCLASSIFIED ≠ organic |
| **Senders** | our accounts | row per account, **is it still signed in** (§3.5), add / remove | device identity, cohorts |
| **Targets** | who we write to | row per target, add / remove, watch toggle | rotation, watch cost |
| **Rules** | what the system will and will not do | every rule as one line | *this page is the rationale* |
| **Analytics** | is it working | found / sent / replied / reply rate, over time | — |
| **Cost** | what detection costs | spend, calls, cache hit, per-channel | why failed calls are counted |

Nine pages become seven. Gone: **Today** (a dumping ground; Autopilot answers the question it was
trying to), **Messages** and **Conversations** (the queue folds into Autopilot, the history into
Analytics), **Channels** and **Prospects** (become Targets), **Sign-ins** (becomes Senders).

**Why Autopilot rather than a neutral "Today":** if unattended sending is the product, then the
dashboard's first screen is the product's status. Everything else on the old landing page was a
number that belongs on Analytics.

**Word budget: ~2,000 total, ~250 per operational page.** A number, so it can be checked.

### Rules is a list, not an essay

One line per rule, grouped, no paragraphs. It is generated from the code where possible so it
cannot drift:

```
SPACING      7 days between messages to the same recipient from the same account
VOLUME       2 per recipient per day · 5 per account per day · 3 per hour across the fleet
HOURS        10:00–21:00 IST only
PACE         one message every 15 minutes, at most
NEW MATERIAL a follow-up must reference a campaign not used before for that pair
HARD STOPS   they replied · retired · account flagged · not connected · caps spent
YOU MAY CROSS  spacing · nothing new to say · route off · they replied (with a reason shown)
NEVER CROSSED  account flagged · retired · not connected · caps · identity mismatch
```

---

## 2. The one thing I would push back on

> *"No super custom messages currently."*

This reverses **decision 3** in `CLAUDE.md`, which is the highest-leverage safety control in the
system and was chosen from measured research: Meta's written spam policy penalises **repetition**,
and templates with merge fields do not count as variation — the research found an aged account
sending only ~20 spintax-varied messages that was still blocked.

**At today's volume the risk is genuinely low** (1–2 messages a day, and nothing is sending at
all right now). **At 65 accounts it is not**, because rotation means one recipient hears the same
template from a different page each time, which is the exact pattern that gets reported.

**What I recommend, and it still gives you one simple message:** a single template with **one
variable line** — the paid post we actually saw. Not a custom message; one sentence naming a real
observation. It is also what makes a *second* message to the same person a new message rather
than a repeat, which is the rule that lets us follow up at all.

There is also a hard technical constraint: the send guards need a distinctive line to confirm
delivery (`distinctiveSlice` / `bodyAppearedSince`). A body byte-identical across touches to the
same recipient breaks the post-send check and trips `VariantsExhaustedError`. Follow-ups must
differ in at least that one line — which the hook already does for free.

**Say the word and I will drop the hook line too.** It is your call and I will record it as
yours; I am not going to make it quietly.

### The message shape

One template, six blocks, replacing 13 channel variants + 7 brand variants + the bespoke bodies:

```
Hi Viral Bhayani,                                    ← greeting

I'm Kapil Jain, Co-founder of Bollywood Society.     ← who is writing

I saw your paid post with Crocs recently.            ← THE ONLY VARIABLE LINE
                                                        (omitted when we have no observation —
                                                        never invented)

We run a network of 200 entertainment and lifestyle
pages with 169.2M followers and around 300M views a  ← what we are (fixed)
day, and we place brand campaigns across them.

I'd like to connect and see whether there is         ← the ask (fixed)
something worth doing together.

Kapil Jain                                           ← signature (fixed, unchanged)
Co-founder, Bollywood Society
+91 60000 189766
kapil@digitalsukoon.com
```

Rules for it, all enforced by existing code:

- **Every figure must already be in the quality gate's allowlist.** No new numbers invented.
- **The hook degrades to nothing**, never to a guess — `brandPitch.ts` already does this.
- **Personas untouched**, as instructed. The shared phone/email across all four accounts is still
  a cross-account fingerprint the gate cannot see; unchanged and still flagged.

---

## 3. Your campaign list — what it gives us, measured

33 unique Instagram shortcodes across 9 brands (35 URLs: one is a LinkedIn post, one duplicate).

**Brands: Crocs · Adidas · U.S. Polo · Rungta Steel · Nutella · KFC · Bonkers · Lux · Titan Eye+**

### What it gives us immediately

Nine companies that **demonstrably paid Digital Sukoon's network.** That is the single most
valuable thing in the message: they are exactly the `kind: 'BRAND'` prospects this system exists
to reach, and they arrive already qualified. Import them as brand targets, pairs disabled.

### What it cannot give us yet, and this was measured not assumed

**0 of the 33 are in our stored corpus**, and we cannot fetch their captions anonymously. Probed
today against a real shortcode:

| endpoint | result |
|---|---|
| `/p/<code>/?__a=1&__d=dis` | **404** |
| `/p/<code>/` and scrape `og:description` | 200, 609,603 bytes of SPA shell, **no og: tags** |
| `/api/v1/media/<shortcode>/info/` | **302** |
| shortcode → numeric id → `/api/v1/media/<id>/info/` | **302** on both `www` and `i` hosts |

A session cookie would fix it and **decision 4 forbids that** — detection is anonymous precisely
so an IP-level risk never becomes an account-ban risk.

### So one question, and it unlocks the rest

**Which of our pages posted these?** One URL is `instagram.com/bollywoodpaparazzii/...`, so the
list spans several pages in the network, not just Bollywood Society. Give me the handles and a
one-off deeper feed backfill of those pages picks up the captions — at which point your 33
shortcodes become **labels**, and we get a real accuracy harness for a second channel. Today
`pnpm ig:accuracy` measures the classifier against one channel only (`@madovermarketing_mom`'s
`#Collaboration` disclosures). A second, differently-worded source is worth more than any prompt
edit.

Failing that, pasting the captions works just as well.

**Stored regardless**, so the labels are never lost: a `KnownPaidPost` row per shortcode
(shortcode, brand, url, who told us). Cheap, and it means the harness can be built the day the
captions arrive.

---

## 3.5 THE LOGGED-OUT ACCOUNT — the plan did not cover this, and it is the worst bug for autopilot

Raised by Tabish: *"when trying to send using tabishmukaddam1 it stated that he has logged out,
does the plan take such stuff into consideration."* **It did not.** The plan said "reconnect
indicator" because it was asked for — and built on today's data it would have been *wrong*, which
is worse than not having one.

### What is actually broken, traced in the code

`profileStatus().hasSession` checks whether a `sessionid` cookie exists **in a file on disk**. Its
own docblock says so: *"whether it is valid can only be answered by loading Instagram… a cheap
filesystem check must not be allowed to imply more than it knows."* The dashboard then renders it
as **"connected"**, which implies exactly that.

For `@tabishmukaddam1` today: the cookie file is present, so `hasSession: true`, so the dashboard
says connected — and two real send attempts failed with *"Chrome profile for @tabishmukaddam1 is
not logged in."* Both statements are live simultaneously.

And the failure is **not recorded anywhere**:

```
sendDm → session.ts throws NotLoggedInError
       → senders/browser.ts catches it
       → returns { status: 'FAILED', failureCode: 'navigation' }
       → nothing is written to SenderAccount
```

Three consequences, and the third is the one that matters:

1. **`failureCode: 'navigation'` means four different things** — 2FA wanted, session expired,
   wrong account logged in, and could-not-reach-Instagram. Only the last is retryable. They are
   indistinguishable to every query.
2. **No column records it.** `SenderAccount` has `sessionSavedAt` (when we saved one) and nothing
   for *when we learned one was dead*.
3. **Autopilot switch #4 is `hasSession`.** So a dead session arms the account, and the paced
   dispatcher drives a browser at it **every fifteen minutes, forever, failing every time**, with
   the dashboard reporting everything fine and the circuit breaker silent — it watches
   `challenged` and `not-in-thread`, not `navigation`. That is the product's core loop burning
   itself out invisibly.

This is the same failure this codebase has now hit four times: **freshness is not liveness.** The
scheduler trusted a heartbeat's age instead of asking the OS; `hasSession` once accepted
`ds_user_id`, an identifier that outlives a session; the reply check treated a partial read as
silence. Same shape, new place.

### The fix — record the evidence, never poll

A liveness poll on page render is the wrong answer: it drives a browser (~10 MB of profile cache
per session, measured) to re-learn something a send already proved.

| | |
|---|---|
| 1 | **`markSessionInvalid(handle, reason)` — ONE writer**, exactly like `markChallenged`. Adds `sessionInvalidAt` + `sessionInvalidReason` to `SenderAccount`. Called from the `NotLoggedInError` and `WrongAccountError` arms. |
| 2 | **Split the failure code.** `logged-out` and `two-factor` come out of `navigation`. `FAILURE_CODES` is a closed set of 8 pinned in `stopInventory`, so this is a deliberate widening with the test updated. |
| 3 | **Feed it to the gate as an INPUT, not a new stop.** `senderHasSession` becomes `hasSession && sessionInvalidAt === null`. Autopilot then stops on the existing `NO_SESSION`, whose remedy already points at the sign-in queue. No new rule, no wider stop inventory. |
| 4 | **Cleared only by proof**: a successful hand login, or a successful send. Never by a page load, and never as a side effect — the same discipline as `clearChallenge`, which is explicit and does not re-arm auto-send. |
| 5 | **Three states on Senders**, from evidence: `signed in` · `needs signing in again — found logged out at 11:45` · `never signed in`. |
| 6 | **Optional per-account "Check now"** that drives one browser and updates the mark. On demand only. |

**Verify both directions:** an account with a live session must still send (or the whole fleet is
bricked by a fail-closed default), and an account marked invalid must be refused at both drafting
and delivery. This is the guard-that-can-never-fire trap in reverse, so it needs the trigger state
manufactured deliberately.

**This moves to the front of the build order.** It is worth more than any page.

---

## 4. @bollywoodsocietyy as a classified target

It is **already** a `CHANNEL` target with `watchEnabled: true` — but `detectorKey: 'passthrough'`,
so all **389** of its stored posts are `UNCLASSIFIED`. It judges nothing, which is why it shows
"not classified" everywhere.

The change is one column: `passthrough` → `semantic`. Then `pnpm ig:classify --channel
bollywoodsocietyy --run` judges the backlog. **Cost: 389 posts × ~$0.00004 ≈ $0.02**, and the
novelty filter drops roughly half before they reach the model.

**This deliberately reverses a documented guard, so it must be recorded.** CLAUDE.md notes that
`ig:classify` once queued our own accounts and *"would have spent real money asking DeepSeek
whether our own Bollywood pages run paid campaigns"* — treated then as a bug. It is now the
point: our own pages are the only channel where we have ground truth. The distinction to write
down is **watching our own page for GROUND TRUTH is not the same as prospecting it**, and nothing
about this makes it a recipient.

---

## 5. The links you asked for do not exist yet

`src/lib/urls.ts` builds profile and inbox URLs and has **no `postUrl`**, so nothing in the
system can link to a detected post. `DetectedCampaign.shortcode` is stored and unique, so this is
a four-line helper — but it has to go in `urls.ts`, which is the only place Instagram URLs are
built, because the CLI and the dashboard drifted apart once before.

---

## 6. Build order

Each step ships on its own and leaves the app working.

| | step | risk |
|---|---|---|
| **1** | **The logged-out fix (§3.5).** `markSessionInvalid`, the split failure codes, the gate input, the three states. Autopilot stops burning ticks. | medium — touches the gate, so verify both directions |
| 2 | `postUrl()` + **Paid posts** page: table with links. Nothing else moves. | none |
| 3 | **Rules** page. Move every rationale paragraph off the operational screens onto it. | low — deletion of prose only |
| 4 | **Cost** page split out of Paid posts. | none |
| 5 | **Senders** and **Targets** — the two halves of today's Accounts + Prospects. The §3.5 indicator lands here. | medium |
| 6 | **Autopilot** landing page: the switch, per-account readiness, last tick, and the queue with Send. Retire Today / Messages / Conversations. | medium |
| 7 | **Analytics**. | low |
| 8 | Import the 9 brands as targets, pairs disabled. Record the 33 known-paid posts. | low |
| 9 | `@bollywoodsocietyy` → `semantic`, classify the backlog. | low, costs ~$0.02 |
| 10 | The single message template, behind a flag, **off by default**. Render real messages and read them before switching it on. | **highest** |

Step 1 is first because it is the only item that changes whether the product works. Step 10 is
last because Phase 3 and Phase 8 both shipped copy changes switched off — a change to what a real
prospect reads should be turned on by a person on a day they chose.

---

## 7. What does not change

Non-negotiable, and the safety net that proves it stays green:

- **Every refusal keeps its home.** `tests/stopInventory.test.ts` runs before and after every
  step — 57 assertions: every stop reachable, explaining itself in prose, with a decided remedy.
- **No guard is removed, loosened or reordered.** Cutting words is not cutting rules. If a
  sentence being deleted is the only place a refusal appears, it is not bloat and it stays.
- **`pnpm ig:layout`** after every step — geometry, assets, and that the stylesheet applies.
- **Personas untouched.** Left as Kapil Jain, per instruction.
- **Detection stays anonymous.** No session on a feed or media endpoint, ever.
