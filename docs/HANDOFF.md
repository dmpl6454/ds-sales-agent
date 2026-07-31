# Handoff — paste this into a new Claude session

Written 2026-07-31, HEAD `ad847c4`. Everything below was verified, not remembered.
If any of it disagrees with the code, the code is right and this file is stale.

---

I'm continuing work on the DS AI Sales Agent at `~/Desktop/AI Sales Agent`
(private repo `dmpl6454/ds-sales-agent`).

**Read `CLAUDE.md` in the repo root first — all of it, including the Gotchas
section.** It is not boilerplate. Most of it records failures that already
happened, several of them counter-intuitive enough that a reasonable person
would undo them. Then read `docs/HANDOFF.md` (this file) for current state.

## What it does

Watches Instagram publisher channels four times a day (11:00 / 15:00 / 17:00 /
20:00 IST), detects paid/branded posts, writes a partnership pitch from scratch
per recipient, and **sends it as an Instagram DM** — unattended, or on one click
from the dashboard at http://localhost:3000.

Sending drives a real Chrome profile per account, logged in once by hand, via
Patchright. There is no Instagram API for cold DMs; this is the only path.

## The one rule

**Account safety outranks throughput.** Three of the four sending accounts are
revenue-generating business assets. Never raise volume, shorten a delay, or
disable a guard to make something work. Never retry into an Instagram
checkpoint. If a change increases account exposure, say so out loud rather than
shipping it quietly.

## Exact state right now

| | |
|---|---|
| Working | end to end, including a fully unattended send |
| Tests | 124 pass; typecheck and build clean |
| Mode | **rehearsal ON** (`pnpm burner status`) — only accounts we own are reachable |
| Dashboard | `pnpm start` → :3000. The scheduler runs inside it |

Accounts:

```
@tabishmukaddam1      connected ✓   auto-send ON    ← trial account, the only live one
@bollywoodsocietyy    not connected, auto-send off  ← real, revenue-generating
@madaboutmarketingg   not connected, auto-send off  ← real, revenue-generating
@bollywoodchronicle   not connected, auto-send off  ← real; ALSO a test target
```

Two messages have ever been sent, both from the trial account, both verified in
the recipient's thread rather than from our own logs:

```
05:53  @tabishmukaddam1 → @priyanshu123321123   one click from the dashboard
06:57  @tabishmukaddam1 → @bollywoodchronicle   FULLY UNATTENDED (sentBy=autopilot:…)
```

`.env`: `DRY_RUN=0`, `AUTOPILOT_ENABLED=true`, `MAX_TOTAL_SENDS=6`,
`MAX_PER_TARGET_PER_DAY=2`, `DEFAULT_COOLDOWN_DAYS=7`.

## The honest status

The **mechanism** is proven: paste, composer read-back, thread confirmation, the
delivery gates, autopilot. The **approach** is not. Both sends were from a
throwaway account, and the 2–4 week soak on an aged account that the research
recommended has never been done. So the first send from a real revenue account
is still the real test. Do not let anyone — including yourself — round that up
to "it's validated".

## Things that will waste your time if you don't know them

All of these are in CLAUDE.md with full reasoning. Short version:

- **This codebase is ESM. Never `require()`.** A lazy `require()` works in the
  Next server bundle and throws in anything run through `tsx`. That exact bug
  made autopilot silently unable to send while the dashboard button worked.
- **Never open a Chrome profile in `~/.ds-sales-agent/chrome-profiles/` with
  ordinary Chrome.** Patchright uses `--use-mock-keychain`, so normal Chrome
  cannot decrypt those cookies and **deletes them** — destroying the device
  identity the whole safety design rests on. Unrecoverable.
- **Never name a pnpm script after a built-in.** `pnpm login` opened *npm's*
  sign-in page. Scripts are namespaced `ig:login`, `ig:audit`.
- **`/api/v1/accounts/current_user/` returns 200 + HTML even when logged in.**
  Use `ds_user_id` → `/api/v1/users/{id}/info/`.
- **Rebuild before starting, never during.** `next start` reads the manifest at
  boot.
- **`curl` returning 200 does not mean the page works.** Extract the
  `/_next/static/**.js` refs and request each one.

## How I work on this, and why

Verify against reality rather than reasoning about it. On this project seven
confident claims turned out to be wrong, and every one was caught by running
something, not by thinking harder — including two guards that were silently
broken while looking perfectly healthy.

The specific trap: **verifying the negative case and assuming the positive.** A
logged-out check returning null looks correct. A post-send guard that passes on
a successful send looks correct. Neither tells you the other direction works.
When something is load-bearing, test it succeeding *and* failing.

Concretely, that means: read the recipient's thread to confirm a send, not the
log. Run scripts in the environment that will actually run them. Drive the real
dashboard with a browser rather than reading the JSX.

## Suggested next steps, in order

1. **Let a slot fire completely untouched.** Both proven sends were triggered by
   hand or by a hand-run slot. Leave the dashboard running with something fresh
   waiting for `@tabishmukaddam1` and let 15:00 / 17:00 / 20:00 do it alone.
2. **Reconsider `MAX_TOTAL_SENDS`** — raised to 6 purely for test headroom.
3. **Only then**: `pnpm burner off`, connect one real account, watch it closely
   for days before the second. They graduate one at a time on purpose.
4. Reply detection is still manual and is the weakest link — an unrecorded reply
   means the agent keeps preparing cold follow-ups into a live conversation.
5. Widening to sponsor brands (Tilara, Royal Canin, The Leela, Dr Hiranandani)
   is what turns four routing pairs into a real pipeline.

## Commands

```
pnpm start          dashboard on :3000, and the scheduler with it
pnpm run:slot       run one slot immediately (detect → deliver → plan)
pnpm queued         every prepared message and what the gate held back
pnpm burner status  which routes are live; on|off toggles rehearsal mode
pnpm ig:audit       cross-check dashboard numbers against the DB
pnpm test           124 tests
pnpm db:studio      raw data the dashboard deliberately omits
```

Everything an operator needs — connect an account, add or remove accounts and
channels, edit a message, toggle auto-send and autopilot — is on the dashboard.
The terminal is the developer path.
