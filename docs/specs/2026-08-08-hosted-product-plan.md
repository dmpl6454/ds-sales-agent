# Hosting this as a product, and making the watch survive a closed laptop

**Written 2026-08-08.** Supersedes the "detection only" shape in
`2026-08-03-linode-hosting-plan.md`, which assumed one operator on one Mac. Tabish's
instruction this session: *"let us host it on our linode server with a random url (free)
… We need people with url access to sign up, then connect channels using their devices
(mac or windows) and then the sending should continue regardless of whether they close
the url or turn off their devices."*

Everything below was measured this session against the live database and the live server,
not remembered.

---

## 0. What was measured before any of this was planned

| | |
|---|---|
| **Nothing was running.** `schedulerHeartbeat` last written `2026-08-07T09:58Z`; no node process on the Mac | ~20 h stale |
| **The outage cost, exactly.** 108 posts arrived in ONE burst at `2026-08-08 05:00Z` — catch-up-on-boot, not steady state | **9 CAMPAIGN + 1 REVIEW** recovered |
| **The margin.** VB posts 49–75/day (mean ~64, measured over 8 days); the feed is 48 deep | the window fills in **~18 h**; the outage was ~17 h |
| **The feed works from the Linode.** `HTTP 200`, `status: ok`, 12 real items with live captions, 1.34 s | detection genuinely can move |
| **The Linode is nearly full.** 1967 MB RAM, **~630 MB available**; 5 PM2 apps + Postgres + WordPress/MySQL resident | 1.5 GB swap, 746 MB already used |
| **Frames live inside the credential directory.** `~/.ds-sales-agent/frames`, 314 files, 15 MB | that directory decrypts to IG session cookies |
| **19 REVIEW rows await a human answer** | the only labels that can measure footage-only recall |

The recovery-margin figure is the one that decides the priority order: **more downtime
than about a day means permanent, unrecoverable loss**, because a post that scrolls out of
a 48-item feed window can never be re-scraped.

---

## 1. The split, and the one thing that cannot move

```
LINODE 172.105.53.101                    EACH USER'S OWN MAC / WINDOWS
─────────────────────                    ────────────────────────────
dashboard (public URL, invite-gated)     the agent — one small process
Postgres                                 their Chrome profiles
detection cron, every 15 min             their Instagram sessions
OCR (RapidOCR) + classifier              drives the browser, from THEIR IP
                                         re-runs gate.ts at delivery
SEND_ENABLED=false  ← hard env floor     SEND_ENABLED=true
never drives a browser
never holds an IG session
```

**Why sending cannot move to the server.** Stated to Tabish this session and accepted.
The Chrome profile carries device identity — `mid`, `ig_did`, `ig-u-rur` — written by a
hand login from a home IP, plus a login event from that IP. Copying it to a datacenter is
a cookie transplant in all but name: `sessionid` is a bearer token with **no channel
binding**, so a transplant *works*, right up until enforcement lands silently. Research
(18 agents, 2026-07-30) confirmed device + network continuity is a **pass/fail gate, not a
score**. On a multi-user product it is worse still: every customer's account would appear
from one datacenter IP, a correlation surface far beyond the 65-sender problem decision 1
already worries about.

**The requirement that is impossible, and what ships instead.** "Sending continues when
they turn off their devices" cannot be satisfied without that transplant — a powered-off
device has no browser and no session. Tabish chose **queue-and-send-on-return**:

- Closing the URL: **already fine.** The tab is not the sender; the schedule is.
- Device asleep/off: drafts wait as `READY`, the dashboard says *"waiting for your device —
  last seen 2 h ago"*, and the agent sends them on reconnect under the ordinary pacing
  rules. **Nothing is lost, nothing is dropped, nothing is rushed on return.**

This is written down because it is the product's one honest limitation, and a page that
implied otherwise would be lying to a customer about whether their messages went out.

---

## 2. Order of work

Priority is set by what is *unrecoverable*, not by what is hardest.

### Phase 1 — stop losing posts (today, before anything else)

1. **`launchd` agent on the Mac** — `KeepAlive`, `RunAtLoad`, so a crash or a login
   restarts the watch. This is the stop-gap that protects the corpus while the rest is
   built; it is NOT the answer, because launchd cannot wake a sleeping Mac.
2. **A stale heartbeat is an ALARM on `/`**, not a quiet line. It currently renders as
   ordinary text; it must render as the alarm state with what was lost — "no detection
   pass in 20 h; at ~64 posts/day the 48-post feed window fills in ~18 h."
   *A toggle that promises behaviour must show whether anything is behind it* — and the
   same is true of a watch.

### Phase 2 — the frame store leaves the credential directory

`~/.ds-sales-agent` decrypts offline to Instagram session cookies (Patchright hardcodes
`--password-store=basic`, so the key is a public constant). Frames are ordinary public
images; keeping them there means any future contact-sheet UI, backup or screen-share
widens the blast radius of the one directory this project treats as a password file.

Move to `~/.ds-sales-agent-data/frames` — **outside** the profile root — with a one-time
migration that copies, verifies by hash, then unlinks. `framePathFor` is the only writer,
so this is a one-line change plus the migration.

### Phase 3 — `judgePost()`, the one judging path

There are **three** callers of the caption/frame stages today and they already disagree:

| caller | novelty | too-short | caption | frame |
|---|---|---|---|---|
| `pipeline.ts` | ✅ | ✅ | ✅ | ❌ *(no `applyFrameSignal`)* |
| `ocr.ts --reclassify` | — | — | ✅ | ✅ |
| `classify.ts` | ✅ | ✅ | ✅ | ❌ |

Extract `judgePost()` — vocabulary → too-short → caption → frame → `applyFrameSignal` —
and switch all three to it. This is the fourth time in this codebase that one rule with
two callers has drifted (`gate.ts`, `readThread.ts`, the two Connect buttons); the
extraction is what stops `classify.ts` becoming the fourth diverging caller.

**Gate the frame call on `optedOut`.** Measured: 64% of OCR runs are our own retired
pages. Reading a frame for a channel we will never message spends CPU and, once the
classifier is involved, money.

### Phase 4 — RapidOCR, MEASURED before it is trusted

Tabish chose bundling a cross-platform engine over accepting tesseract's 29% loss.
**It does not ship on a claim.** Before any Linode verdict is trusted:

1. Run RapidOCR over the **same 60 frames** Apple Vision was measured on.
2. Ask the founding question directly: **does it read `SWITCH` on `DbtNU9UzWYU`?**
   Vision does, at confidence 1.00. Tesseract does not — that is the whole reason
   tesseract was rejected.
3. Record the engine on **every** result and show it on `/paid-posts`. A verdict must
   never be compared across engines without knowing which read the frame.

If RapidOCR misses `SWITCH`, it is not an upgrade on tesseract and the honest answer is
frames are read on the Mac. **The measurement decides, not the plan.**

`framesRead` on `/paid-posts` also stops collapsing five states into one number:
read-with-text / read-no-text / no-frame / no-engine / failed are five different
situations with five different remedies.

### Phase 5 — Postgres, then the host

SQLite cannot be shared by two hosts. The schema anticipated this — *"Postgres later =
change provider + adapter only"*. Mechanically: provider swap, adapter swap,
`migrate deploy`, seed, then a row copy (1,833 posts and ~30 attempts is a script, not a
migration tool).

**Do NOT convert the JSON-string columns or string-union statuses in the same change.**
They exist because SQLite has no arrays or enums; on Postgres they would idiomatically be
`text[]` and enums. Migrating the host and changing column semantics at once means a
failure could be either.

The heartbeat's liveness check is `process.kill(pid, 0)` and therefore **host-local** — a
Linode pid means nothing on a Mac. The record needs a host identity before two machines
run schedulers, or the Mac will read the Linode's heartbeat and misjudge liveness.

### Phase 6 — the front door

Registration is OPEN today and `sendNow` checks the safety gate, not who is asking. Before
the dashboard is reachable from anywhere:

- `SIGNUP_INVITE_CODE` in the server env; signup without it is refused.
- `User.role` — `viewer` (read every page) | `operator` (send, arm, connect, remove).
  `User` was deliberately shaped to take this column without a painful migration.
- Every send-ish action checks role as its first statement, after `requireUser()`.
  Middleware is a router filter; an action is a POST endpoint.
- A random subdomain on Cloudflare, TLS terminated there. **The URL's secrecy is not a
  security control** — it leaks through history, referrers and logs.

### Phase 7 — the agent

One process the user runs on their own machine. It:

- authenticates to the server with a per-user token (hashed at rest, like `Session`),
- polls for attempts marked `REQUESTED` for accounts *it* holds profiles for,
- claims atomically (`updateMany` with status in the `where` — a check-then-write is not
  a guard, and this bit twice already),
- **re-runs `gate.ts` locally at delivery** — every guard runs where the send happens,
- writes the outcome back, including `CHALLENGED` and `sessionInvalidAt`.

The server proposes; the device disposes. A compromised server still cannot make a device
send something its own gate refuses.

---

## 3. What must not happen

- **No Chrome profile ever leaves the user's machine.** Not to the server, not to a
  backup, not to a synced folder.
- **No `sessionid` on the server, ever.** Detection is anonymous by decision 4; attaching
  a cookie converts an IP-level risk into an account-ban risk.
- **Frame text never mints or clears a CAMPAIGN.** `applyFrameSignal` may raise ORGANIC to
  REVIEW and nothing else. Its labels are caption-derived; a frame-driven CAMPAIGN is
  measured by nothing that exists.
- **Recall is never traded for precision.** `pnpm ig:accuracy` before AND after any prompt
  edit, plus `--no-frames` as the control.
- **No paid vision API.** Tabish refused one and was right — it was never what solved this.
- **Autopilot stays OFF** and the revenue accounts stay unarmed through all of the above.
  Hosting is not a decision to start sending.

---

## 4. MEASUREMENTS TAKEN THIS SESSION

Recorded here because a number with no provenance gets quoted as if it meant something
else — which is exactly what happened to "98% accuracy" before the warning box was added.

### RapidOCR vs Apple Vision — 321 real frames, 2026-08-08

| engine | content recall | the founding case (`SWITCH` on the Thane bumper) |
|---|---|---|
| vision | baseline | reads it, confidence 1.00 |
| **rapidocr** | **87.1%** | **READS IT, confidence 0.83** |
| tesseract | 71% | **misses it entirely** |

**The first attempt at that recall figure said 27.1% and was WRONG.** RapidOCR emits
`THANE'sFirstDoubleDeckerBusInsideView!` where Vision emits the same words spaced, so
splitting on whitespace made one engine's single token unmatchable against the other's
seven — a FORMATTING difference reading as a reading failure. Comparing normalised
CONTENT gives 87.1%. Measure the property that matters (can the classifier recover the
characters?), not an artefact of how an engine chunks its output.

Had the first number been trusted, an engine that reads the decisive token would have been
rejected. Same shape as `resolveBrand` reading one broken handle as a run-wide throttle.

**What decided it was the founding case and the controls, not the aggregate.** RapidOCR
recovered every decisive token: `SWITCH`, `THANE`, `Double Decker` (founding case);
`DESSANGE`, `Sambhal` (the editorial control that must NOT flag); `SONY`, `GAME SHOW`
(the second real find). An engine with a good average that cannot read the one token the
feature exists to catch is a regression with a good average.

What RapidOCR loses is dense small text — cast lists, fine print — and several "missed"
Vision words are themselves garbage (`siltd`, `sisis`, `froccer`), so recall on
*meaningful* text is higher than 87%.

Speed: **0.61 frames/second** on the Linode (ONNX, no GPU, shared 2 GB box) against
Vision's ~5/s locally. Fine for a background pass, not for a request.

### Classifier accuracy — control run, frames OFF

```
n=55   correct 95%   recall 100%   precision 84%   (3 FPs)
```

**Recall was not traded, which is the only figure that must never move.**

Against the previously documented `98% / 100% / 92% (n=48)`, and the honest reading is
that **these are different test sets, not a before-and-after**: the corpus grew from 48 to
55 as M.O.M kept posting. Comparing them directly would be treating a growing benchmark as
a fixed one.

**The prompt was NOT edited this session** — verified per-commit against
`src/detection/detectors/semantic.ts`; the only diff is display text for the review queue,
never the model's system prompt. So the change is new data, not a regression introduced
here.

All three false alarms are the SAME documented class: M.O.M is a marketing publication, so
its editorial is commentary about other brands' advertising (McDonald's outlet opening,
a Miu Miu PR box, a Netflix billboard stunt). CLAUDE.md already records that an earlier
attempt to fix exactly this cratered precision 85% → 71%, and a second attempt dropped
recall to 87%. **Do not tune for it.**

### The outage, and what it cost

| | |
|---|---|
| heartbeat stale | ~20 h (last beat `2026-08-07T09:58Z`) |
| posts recovered in one burst on restart | **108**, of which **9 CAMPAIGN + 1 REVIEW** |
| feed depth / busiest channel rate | 48 posts / 49–75 a day (8 days, mean ~64) |
| therefore the window turns over in | **~18 hours** — the outage cleared it by about one |

### Frames nothing had read

**166 posts detected in one day had a cover frame on disk that nothing had looked at.**
The pipeline saved frames and classified captions; only `ig:ocr --reclassify` read them.
After `judgePost()`: 51 judged, **114 correctly skipped as retired channels** (the
`optedOut` gate, matching the measured 64%), 5 calls failed and left untouched.
