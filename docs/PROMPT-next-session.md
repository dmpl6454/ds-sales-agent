# EXECUTED 2026-08-06 — all ten steps are built. Kept for the record; docs/HANDOFF.md is current.

# (Original prompt below)

---

Continue the DS AI Sales Agent at `~/Desktop/AI Sales Agent`, branch `feat/dashboard-auth`.

**Read, in this order, all of it:**

1. `CLAUDE.md` — especially **Gotchas** and **Decisions that must not be quietly reversed**. It is
   not boilerplate; nearly every line records a failure that already happened, several
   counter-intuitive enough that a competent person will undo them.
2. `docs/HANDOFF.md` — current state.
3. **`docs/specs/2026-08-06-simple-sender-plan.md` — this is your task.** Implement it in the build
   order in §6.

## What you are doing and why

Tabish has said three times that the dashboard is confusing. Two previous passes added
*structure* (a sidebar, then nine single-job pages) and the complaint did not change, because the
problem is not the page count — it is **~18,700 words of operator-facing text** across `src/app`,
measured. Nine pages become seven, and the mechanism that makes them short is the **Rules** page,
which is the destination for every *rationale* paragraph now sitting beside a button.

**AUTOPILOT IS THE PRODUCT.** Tabish's words: *"the manual sending is just a simple feature, the
main selling point is autopilot."* So the landing page is **Autopilot**, and its one job is *is it
sending, and if not, exactly what is stopping it.* Manual send is the same queue with a button on
it — nothing more.

## Start with step 1. It is the only thing that changes whether the product works

**A logged-out account is invisible to the dashboard and autopilot keeps driving a browser at it
every fifteen minutes, forever, failing every time.** Verified in the code and in the live data,
2026-08-06:

- `profileStatus().hasSession` is a **filesystem check** — does a `sessionid` cookie exist on
  disk. Its own docblock says validity "can only be answered by loading Instagram". The dashboard
  renders it as **"connected"**.
- For `@tabishmukaddam1` right now: cookie present → `hasSession: true` → dashboard says connected,
  **and** two real sends today failed with *"Chrome profile for @tabishmukaddam1 is not logged
  in."* Both true at once.
- `NotLoggedInError` is caught in `src/outreach/senders/browser.ts` and becomes
  `{ status: 'FAILED', failureCode: 'navigation' }`. **Nothing is written to `SenderAccount`.**
- `failureCode: 'navigation'` conflates four different things — 2FA wanted, session expired, wrong
  account, could-not-reach-Instagram. Only the last is retryable.
- Autopilot switch #4 *is* `hasSession`, and the circuit breaker watches `challenged` and
  `not-in-thread`, **not** `navigation`. So nothing stops the loop and nothing reports it.

§3.5 of the plan has the design. The shape that matters: **record the evidence, never poll.**
`markSessionInvalid` as the ONE writer (exactly like `markChallenged`), feed it to `gate.ts` as an
*input* so the existing `NO_SESSION` stop fires rather than adding a new rule, and clear it only on
proof — a real login or a real send, never a page load.

This is the fourth appearance of **freshness is not liveness** in this codebase. Read the other
three in CLAUDE.md before you design it.

## Non-negotiable, on every step

- **Run `npx vitest run tests/stopInventory.test.ts` before and after every step.** 57 assertions:
  every stop reachable, explaining itself in prose, with a decided remedy. **If a stop loses its
  rendering path, stop and say so.** Cutting words is not cutting rules — if a sentence being
  deleted is the only place a refusal appears, it is not bloat and it stays.
- **Run `pnpm ig:layout` after any UI change.** Needs `DS_LAYOUT_TOKEN` set to a valid session
  cookie value; mint one by inserting a `Session` row with `hashToken()` from `lib/session.ts`.
  Geometry in a real browser at 1440px and 800px, every asset fetched, and a computed value only
  our own CSS sets. **Presence is not layout and a 200 is not a stylesheet** — both of those passed
  once on a page that was completely broken.
- **`pnpm build` and `pnpm typecheck` prove almost nothing about a UI change.** Two defects last
  session were invisible to both and only appeared on a real request: a `'use client'` module
  reaching `gate.ts` pulled `better-sqlite3 → fs` into the browser bundle (**HTTP 500 on every
  route**), and a CSS chunk 500'd so the dashboard rendered unstyled. **Open the pages.**
- **Read the rendered text, not the diff.** Eight defects last session were found only that way: a
  reply shown three times, `@bollywoodchroniclereplied` (the JSX `{' '}` bug), `Read them and
  decide   .` (`display: flex` splits punctuation off prose), a shell command on screen.
- **Verify both directions on every guard.** Manufacture the trigger state deliberately. A guard
  that only ever runs on the passing case is this codebase's signature failure, seventeen instances
  deep.
- **Stop the server before `pnpm build`.** Building under a live `pnpm start` leaves it serving
  replaced chunks and one returns 500.
- **Throwaway scripts:** prefix `_`, put in `src/scripts/`, delete when done.

## Do not change

- Any guard's behaviour. No rule added, removed, loosened or reordered except the one explicit
  change in §3.5, which is an input to an existing stop rather than a new stop.
- **Personas.** Tabish said leave them. The shared phone/email across all four accounts is still a
  cross-account fingerprint that `checkPersonaDistinct` cannot see, and it is flagged in CLAUDE.md
  — do not "fix" it by inventing personas.
- **`journal_mode = delete`.** Do not switch to WAL. Measured and reverted.
- **Detection stays anonymous.** No session cookie on a feed or media endpoint, ever.
- Port **3100**, `127.0.0.1` only.

## Two things to raise with Tabish, not decide alone

1. **The single message template (step 10) reverses decision 3.** Meta penalises repetition and
   templates with merge fields do not count as variation. The plan's recommendation is one template
   with **one variable line** — the paid post we actually saw — which also keeps the send guards
   working, because a body identical across touches to the same recipient breaks
   `distinctiveSlice` / `bodyAppearedSince`. He has been told; if he confirms "drop the hook line
   too", do it and record that it was his call.
2. **His campaign list needs one answer.** 33 known-paid shortcodes across 9 brands. **0 of 33 are
   in our corpus**, and captions cannot be fetched anonymously — four endpoints probed, all dead
   (`?__a=1` → 404; the post page → 609,603 bytes of SPA shell, no `og:` tags; both media-info
   routes → 302). Ask **which of our pages posted them** (one URL is
   `instagram.com/bollywoodpaparazzii/...`, so it spans several), then a one-off deeper feed
   backfill of those pages gets the captions and his shortcodes become **labels** — a second
   accuracy harness, worth more than any prompt edit. Store the shortcodes now regardless so the
   labels are not lost.

## Verified state, 2026-08-06 13:40 IST

```
tests    886 passing · typecheck 0 · production build clean · pnpm ig:layout all green
tree     the nine-page redesign is UNCOMMITTED on feat/dashboard-auth
db       4 senders (all group 1) · 9 targets · 31 pairs · 1395 posts · 79 CAMPAIGN · 97 modelCalls
attempts READY 1 · SENT 7 · REPLIED 1 · SKIPPED 32
spend    $0.0031 lifetime
```

**Nothing can send right now.** Three accounts have never been signed in; `@tabishmukaddam1`'s
session is dead (see step 1). The persona gate is **released** — each account has its own channel
name — so `persona-not-distinct` is no longer the binding stop anywhere. That corrects every older
note claiming the personas are why nothing sends.

The one remaining READY draft (`@tabishmukaddam1 → @bollywoodchronicle`) was prepared by hand with
its warnings acknowledged. Leave it alone.

## One outstanding item that is not in the plan

`docs/PIPELINE.md` records that the pipeline flowchart has **two stale figures** — it still says
nothing sends because every page shares one identity, and its cost strip reads $0.0017/41 calls
against a real $0.0031/97. The *flow* is unchanged, so it was deliberately not rebuilt. If the
build order changes the flow of operations, the rule in that file applies: rebuild it from the
code in the same session, re-publish to the same URL with `force: true`, keep the 🔁 favicon, and
give Tabish the link.
