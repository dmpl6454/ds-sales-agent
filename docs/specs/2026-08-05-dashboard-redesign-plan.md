# The dashboard is confusing and dull — a plan to fix it

**Written** 2026-08-05, after Tabish said the UI is "confusing to use and quite dull" and asked
for separate pages and a sidebar.

**Status: A–G all built.** A and B on 2026-08-05; C, D, E, F and G on 2026-08-06. Nine pages,
each with one job, and the sidebar lists all nine. The safety net held: `tests/stopInventory.test.ts`
was run before and after every step and no stop lost its rendering path — it is now 55 assertions
rather than 40, because two things were added to it (every gate stop must have a decided REMEDY,
and every refusal sentence must read as prose on the card).

**What the redesign found, none of it visual.** Content moves are where a warning gets lost, and
reading the rendered pages rather than the diff is what caught these:

| | |
|---|---|
| a waiting draft said nothing about whether it could be sent | all four would have been refused; the button was the only control and it could only error |
| the same reply was on `/` **three times** | headline, full card, and a history row |
| `/messages` and `/` each rendered the whole draft tray | two copies, neither with a reason |
| internal labels were on every screen | *"Burner (test target) replied"*, `Send from Tabish (trial)` |
| sign-out and "last check read 168 posts" sat inside the amber alarm card | good news wearing an alarm's colour |
| a client component pulled `better-sqlite3` into the browser | HTTP 500 on **every** route, invisible to typecheck |
| the CSS chunk 500'd and the dashboard rendered unstyled | and the geometry check passed 7 of 9 on it |
| `pre` blocks, a JSX space, `display:flex` on prose | three separate defects, all found by reading text rather than looking at layout |

Read §0 before agreeing to any of it: this UI carries safety copy, and a redesign that loses a
warning is worse than a dull dashboard.

---

## 0. The one thing that makes this risky

**Every refusal in this system is a sentence on a screen.** The governor has 11 stops, `gate.ts`
has 11, `brandGuards` has 2, the dispatcher has 6 pacing reasons plus per-message holds, and
each one exists because *"nothing happened" with no explanation is the failure this whole
project keeps rediscovering.*

Three of those explanations were added or fixed **today**, and one of them — the dispatcher
saying why an individual message was held — had never reached a screen at all despite a docblock
claiming it did.

So the redesign's hardest requirement is not visual. It is: **no warning, reason, or control
loses its home.** A pretty dashboard that silently drops "they replied" or "this group is not
cleared yet" would undo work that took two sessions to get right.

**Mitigation, and it should be built first:** an inventory test. Enumerate every stop constant
(`SKIP_REASONS`, `RESEND_BLOCKS`, the brand guards, the pacing reasons, `EnsureResult.reason`)
and assert each has a rendering path. It will not prove the copy is good; it will prove nothing
vanished. Nothing else in this plan should start before it exists.

---

## 1. Why the current UI is confusing — specifics, not adjectives

Measured against the running app, 2026-08-05:

| | |
|---|---|
| pages | 6 behind auth (`/`, `/accounts`, `/accounts/login`, `/messages`, `/prospects`, `/settings`) |
| nav | 5 links in a **horizontal bar**, no sidebar, no sense of place |
| `/` | carries metrics, channels, brands, replies, on-demand send and the "needs you" state — **six unrelated jobs on one page** |
| `/accounts` | account cards, personas, per-account arming, and a chip per sender×target route — **20 chips today, 3,900 at 65×60** |
| `/messages` | the tray, the dispatcher panel, the uncertain-sends panel and reply coverage |
| styling | one `globals.css`, utilitarian, no component vocabulary — every panel is `.group` or `.panel` |

Four concrete problems:

1. **`/` is a dumping ground.** It answers "how is it going", "who do we message", "who has
   replied" and "send something now" in one scroll. None of those is the same question.
2. **There is no sense of place.** A horizontal bar of five links does not say where you are or
   what else exists. A sidebar does, and it has room for state (a red dot on Accounts when
   something needs a login).
3. **The route chips do not scale and never did.** `/prospects` was built in Phase 7 precisely
   because a chip per route is the wrong control; `/accounts` still has them.
4. **Nothing is ever "done".** There is no single place that answers *what must I do next*, so
   the answer is spread across five pages. The old "Needs you" list was deleted for good reason
   (it put shell commands on screen) and nothing replaced the idea.

---

## 2. Proposed information architecture

A **sidebar** with two groups, because the system genuinely has two halves — the watch, and the
outreach — plus setup.

```
┌────────────────────┬──────────────────────────────────────────┐
│  Instagram Outreach│                                          │
│                    │                                          │
│  Today          ●  │   one screen per job                     │
│                    │                                          │
│  OUTREACH          │                                          │
│   Messages      3  │                                          │
│   Conversations 1  │                                          │
│   Prospects    60  │                                          │
│                    │                                          │
│  THE FLEET         │                                          │
│   Accounts      4  │                                          │
│   Sign-ins      3  │                                          │
│                    │                                          │
│  WATCHING          │                                          │
│   Channels      5  │                                          │
│   Paid posts   61  │                                          │
│                    │                                          │
│  Settings          │                                          │
└────────────────────┴──────────────────────────────────────────┘
```

Nine destinations, each with **one** job. Counts and a dot in the sidebar are the "what needs
me" signal, which removes the need for a to-do list nobody can tick off.

| page | its one job | comes out of |
|---|---|---|
| **Today** | is it working, and what needs me | `/` metrics + the blockers |
| **Messages** | drafts waiting, send or discard | `/messages` tray |
| **Conversations** | who replied, who is mid-conversation, coverage | `/messages` replies + coverage |
| **Prospects** | who we message, rotation group, watch | `/prospects` (mostly as-is) |
| **Accounts** | the sending accounts, personas, arming | `/accounts` minus routes |
| **Sign-ins** | the login queue and the group ladder | `/accounts/login` (as-is) |
| **Channels** | what we watch and whether reading works | `/` channels card |
| **Paid posts** | what detection found, and what it cost | `/` metrics + new |
| **Settings** | the safety knobs | `/settings` (as-is) |

**Deliberately NOT in the sidebar:** the on-demand send. It is an action, not a place — it
belongs as a button on Messages, and it already has its own dialog.

**Where the route chips go:** deleted from Accounts. Routes are edited on **Prospects** (per
recipient, which is the control that scales) and summarised on Accounts as "sending to 14 of 60".

---

## 3. Visual direction

Utilitarian, not decorative — Tabish asked twice for "simple and understandable" and explicitly
"do not bloat", and the pipeline diagram follows the same rule. What is missing is not ornament,
it is **hierarchy**.

- **A real type scale.** Today almost everything is 15–16px. Give the page one clear heading
  size, one sub, one body, one caption, and stop.
- **State encoded in form, not only in words.** A pill for ARMED / WAITING / QUESTIONED, a left
  severity stripe on a blocked row. The dashboard is scanned, not read.
- **Semantic colour separate from the accent.** `--good/--warn/--bad` already exist in
  `globals.css` and are barely used; the accent is `--accent` and should not double as "fine".
- **One component vocabulary**: `Card`, `Row`, `Pill`, `Stat`, `Reason`. Today every panel is a
  bespoke arrangement of `.group`, which is why it reads as flat.
- **Keep both themes.** The tokens exist; the dark theme is currently the better of the two.

---

## 4. Phasing — each step shippable, none of it a big-bang rewrite

| | | risk |
|---|---|---|
| **A** | **The inventory test.** Every stop constant must have a rendering path. | none — pure addition |
| **B** | **The shell.** Sidebar + layout + type scale + component vocabulary, with existing pages dropped in unchanged. | low — no page logic moves |
| **C** | **Split `/`** into Today / Channels / Paid posts. | medium — content moves |
| **D** | **Split `/messages`** into Messages / Conversations. | medium |
| **E** | **Move routes off Accounts** onto Prospects; add the summary. | medium |
| **F** | **State-as-form pass**: pills, stripes, semantic colour. | low |
| **G** | Re-run the inventory test, then read every page signed in and assert on content. | — |

**B is the step that delivers most of what was asked** — a sidebar, a sense of place, and a
less flat look — while touching no page logic. If time is short, do A and B.

---

## 5. What I would push back on

1. **"Cleaner" must not mean "quieter".** Several of these screens are deliberately wordy
   because the warning has to be understood, not just accurate — CLAUDE.md records a persona
   warning that was correct and had to be rewritten because Tabish asked what it meant. Trimming
   copy to look tidy is the most likely way this redesign does damage.
2. **Nine sidebar entries is more places, not fewer.** That is the right trade — one page with
   six jobs is the actual confusion — but it is worth saying out loud, because "simpler" and
   "fewer pages" are not the same thing.
3. **Nothing here fixes the reason the dashboard feels dead.** Nothing is sending, because every
   account shares one persona. The most effective UI change available today is one screen that
   says so in one sentence with the fix next to it, and that is step B's Today page.

---

## 6. Not in this plan, deliberately

Roles on open signup (still the gap that matters if this is ever reachable off localhost),
Postgres, the Linode move, and any change to what the guards actually do.
