# Handoff — paste this into a new Claude session

Updated 2026-07-31, after the end-to-end audit and its remediation. Everything below was
verified, not remembered. If any of it disagrees with the code, the code is right and this
file is stale.

**Read `docs/RUNBOOK.md` if you are operating this rather than changing it.**

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
| Working | end to end, including a cron-fired unattended send |
| Tests | 170 pass; typecheck and build clean |
| Audit | 38 findings in `docs/AUDIT-2026-07-31.md`; 33 fixed on branch `fix/audit-remediation` |
| Dashboard bind | **127.0.0.1 only** — it used to answer on the LAN with live Send buttons |
| Mode | **rehearsal ON** (`pnpm burner status`) — only accounts we own are reachable |
| Dashboard | `pnpm start` → :3000. The scheduler runs inside it |

Accounts:

```
@tabishmukaddam1      connected ✓   auto-send ON    ← trial account, the only live one
@bollywoodsocietyy    not connected, auto-send off  ← real, revenue-generating
@madaboutmarketingg   not connected, auto-send off  ← real, revenue-generating
@bollywoodchronicle   not connected, auto-send off  ← real; ALSO a test target
```

Plus one rehearsal target, added so a first-touch send was possible without loosening any
guard. It is one of our own sender accounts, so
`safeTargetIds()` treats it as safe:

```
@bollywoodsocietyy    also a TargetAccount now; pair from @tabishmukaddam1 is ENABLED
```

Three messages have ever been sent, all from the trial account, all verified by
reading the thread rather than from our own logs:

```
11:23  @tabishmukaddam1 → @priyanshu123321123   one click from the dashboard
12:27  @tabishmukaddam1 → @bollywoodchronicle   unattended, but from a HAND-RUN slot
14:00  @tabishmukaddam1 → @bollywoodsocietyy    CRON-FIRED, on the clock, 77.5s
```

The 14:00 one closed a real gap: until then no slot had ever fired on its own
schedule and delivered anything. Today's `11:00` ScrapeRun row started at **11:40** —
that was catch-up-on-boot, not cron. A temporary `14:00` slot proved it, a `14:15` net
slot correctly sent nothing (ceiling reached), and both were removed after.

**The lifetime ceiling is full: 6 of 6** (2 SENT + 1 REPLIED + 3 READY). Nothing further
can be drafted or sent until `MAX_TOTAL_SENDS` is raised, which is deliberately a visible
act. Confirmed by observation: the 15:00 and 17:00 slots both fired on time and correctly
sent nothing, logging `lifetime send ceiling reached`.

`.env`: `DRY_RUN=0`, `AUTOPILOT_ENABLED=true`, `MAX_TOTAL_SENDS=6`,
`MAX_PER_TARGET_PER_DAY=2`, `DEFAULT_COOLDOWN_DAYS=7`, `SLOTS` back to the four.

## What changed in the remediation

All on branch `fix/audit-remediation`, one commit per theme, each verified in both
directions before committing.

- **The dashboard is loopback-only.** It served `Send from @<revenue account>`, Autopilot,
  Auto-send and Remove to the whole LAN with no auth. Verified: localhost 200, LAN refused.
- **One gate, two callers** (`src/outreach/gate.ts`). `sendNow` checked three conditions
  where `deliverWaiting` checked eight; the five missing included `optedOut` and *they
  replied*. Verified the attended path now reports `target-replied` for
  `@bollywoodchronicle`, where it previously returned ok and would have sent.
- **Atomic claims.** `sendNow`'s idempotency was a check-then-act. So was the first
  version of the new slot lock — two concurrent slots both ran until it used `create` on
  the primary key. Caught by running it.
- **Both send guards were tautologies for short bodies.** The needle fell back to the
  greeting, which renders in the thread header. Fixed, with the missing test.
- **2FA no longer marks an account CHALLENGED**, and in-page "Action Blocked" modals are
  now detected — previously invisible, so the send was filed as retryable and the account
  stayed eligible next slot.
- **`CHALLENGED` needs an explicit human acknowledgement**; it used to clear as a side
  effect of pressing Connect.
- **Windows support**: `pbcopy` → PowerShell `Set-Clipboard` (not `clip.exe`, which
  corrupts the 48 em-dashes in the bodies), `Meta+V` → `ControlOrMeta+V`, `open` →
  `cmd start`. Verified on macOS that the paste still works end-to-end against the real
  composer via DRY_RUN. **The win32 branches are unverified on an actual Windows machine.**
- Plus: discarded-draft campaign burn, `hasSession` fail-open, missing audit rows for
  autopilot sends, dead `SEND_JITTER` config, abandoned connect windows, and six smaller
  inconsistencies.

## What changed in the session before it

- **Reply detection exists.** `repliedAt` was read in six places and written in none,
  so `TARGET_REPLIED` — the governor's hardest stop — had never been able to fire.
  `pnpm ig:reply` and `pnpm ig:thread` now write it. `@bollywoodchronicle` had replied
  `"Hi"` and we had never noticed; it is recorded, and the governor now reports
  `target-replied` for that pair. Verified in both directions against live threads.
- **Slots slept through are recovered.** node-cron's `execution:missed` was unhandled
  and `catchUpIfMissed` only runs at startup, so closing the laptop lid skipped slots
  silently. Now wired, bounded by `CATCHUP_WINDOW_MINUTES`, re-checking `ScrapeRun`.
- **`pnpm ig:audit` undercounted sends** — it counted `status:'SENT'` only, and
  `REPLIED` replaces `SENT`, so an answered message vanished from the total.

## The honest status

The **mechanism** is proven: paste, composer read-back, thread confirmation, the
delivery gates, the lifetime ceiling, autopilot, and now the schedule. The
**approach** is not. All three sends were from a throwaway account, to recipients we
own, and the 2–4 week soak on an aged account that the research recommended has never
been done. So the first send from a real revenue account is still the real test. Do
not let anyone — including yourself — round that up to "it's validated".

Nor should "the cron path works" be rounded up to "it runs unattended". Four slots fired
on time on 2026-07-31 (14:00, 14:15, 15:00, 17:00), which is real evidence — but on a
laptop that happened to be awake, and only one of them had anything eligible to send.
Slept-through slots are now recovered rather than skipped, which is strictly better, but a
machine asleep across a whole catch-up window still misses the slot entirely.

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

1. ~~Let a slot fire completely untouched.~~ **Done** — 14:00 cron-fired and sent, and
   14:15 / 15:00 / 17:00 then fired on time too.
2. **Decide `MAX_TOTAL_SENDS`.** It is full at 6/6, so nothing can be sent at all
   until it moves. Raise it as a considered number, not as unblocking.
3. **Verify the Windows path on a Windows machine.** Two things need measuring there, on
   a throwaway account: whether PowerShell `Set-Clipboard` + `ControlOrMeta+V` actually
   delivers, and whether ordinary Chrome destroys a profile the way it does on macOS —
   Windows uses DPAPI, so it may not, and `CLAUDE.md`/`RUNBOOK.md` currently say "assume
   it does" precisely because nobody has looked.
4. **Decide whether reply detection runs automatically.** `pnpm ig:thread` works but
   is manual. Wiring it into every slot means a browser session per pair per slot —
   a genuine increase in automation volume against these accounts. That trade is
   Tabish's call; it was deliberately not taken.
5. **Fix the shared persona** (CLAUDE.md decision 3b). All four senders currently
   introduce themselves as "Kapil Jain, Co-founder, Bollywood Society", so three
   revenue accounts would send byte-identical intro and signature blocks. Needs real
   names per brand — do not invent them.
6. **Only then**: `pnpm burner off`, connect one real account, watch it closely for
   days before the second. They graduate one at a time on purpose.
7. Widening to sponsor brands (Tilara, Royal Canin, The Leela, Dr Hiranandani) is what
   turns four routing pairs into a real pipeline.

## Does it keep running if I close things?

Verified, not reasoned about:

| | |
|---|---|
| close the browser tab | **no effect** — the scheduler is in the server process, not the page |
| close the terminal | **no effect** — `pnpm start` detaches (`PPID 1`, no TTY) |
| **close the laptop lid** | **stops** while asleep; slots due during sleep are now replayed on wake if younger than `CATCHUP_WINDOW_MINUTES` (240). Before this session they were skipped silently |
| quit the app / reboot | catch-up-on-boot covers the most recent missed slot, same window |

So the laptop must be awake at 11:00 / 15:00 / 17:00 / 20:00 IST, or the slot is
recovered late rather than on time. A machine that is asleep across a whole window
still misses it — for genuine unattended operation this belongs on something that
does not sleep, which is a hosting decision nobody has made yet.

## Commands

```
pnpm start          dashboard on :3000, and the scheduler with it
pnpm run:slot       run one slot immediately (detect → deliver → plan)
pnpm queued         every prepared message and what the gate held back
pnpm burner status  which routes are live; on|off toggles rehearsal mode
pnpm ig:audit       cross-check dashboard numbers against the DB
pnpm ig:reply       record that a target replied (halts outreach to them)
pnpm ig:thread      read a real conversation back — verify a send, detect a reply
pnpm build          rebuild. NEVER while pnpm start is running
pnpm test           124 tests
pnpm db:studio      raw data the dashboard deliberately omits
```

Everything an operator needs — connect an account, add or remove accounts and
channels, edit a message, toggle auto-send and autopilot — is on the dashboard.
The terminal is the developer path.
