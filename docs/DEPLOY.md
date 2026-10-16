# The deployment, as it actually is

**Written 2026-08-08 from the live server**, not from a plan. Everything here was verified
by running it. Where something is not done, it says so.

---

## The shape

```
LINODE 173.230.131.144                     A USER'S OWN MAC / WINDOWS
─────────────────────                     ─────────────────────────
dashboard        :3100 (127.0.0.1)        pnpm agent:device
nginx  → TLS, Cloudflare origin cert      their Chrome profiles
Postgres 16      ds_sales_agent           their Instagram sessions
detection cron   every 15 min             drives the browser from THEIR IP
RapidOCR         /opt/ds-ocr-venv         re-runs gate.ts at delivery

SEND_ENABLED=false      ← hard floor      SEND_ENABLED=true
AUTOPILOT_ENABLED=false ← hard floor
```

**The server can never send, and that is structural rather than a setting.**
`SEND_ENABLED=false` is checked inside `withSendLock`, which every path that drives a
browser passes through — the dispatcher, the dashboard's Send button, the on-demand
dialog and the CLI. Verified by execution in both directions: with the floor down the send
body never runs; with it up it does.

The reason is not caution. A send drives a Chrome profile logged in **by hand from a home
IP**, which wrote durable device identifiers (`mid`, `ig_did`, `ig-u-rur`) and a login
event binding that browser to the account from that network. Copying the profile to a
datacenter is a cookie transplant in all but name: `sessionid` is a bearer token with no
channel binding, so it *works* — right up until enforcement lands silently.

---

## What is running

| | |
|---|---|
| `pm2` processes | `ds-sales-agent` — the dashboard, a two-worker CLUSTER (`node_modules/next/dist/bin/next start`); `ds-sales-worker` — detection, its own process since 2 Sept |
| port | 3100, bound to 127.0.0.1; nginx is the only thing in front |
| nginx vhost | `/etc/nginx/sites-available/ds-sales-agent` |
| TLS | the existing Cloudflare origin cert, shared with the other subdomains |
| database | Postgres 16.14, `ds_sales_agent`, **owned by `dsagent`** |
| OCR | RapidOCR in `/opt/ds-ocr-venv` (`RAPIDOCR_PYTHON` in `.env`) |
| survives reboot | yes — `pm2 save` + `pm2 startup systemd` |

**Only ONE scheduler runs.** A separate `pnpm worker` was started and correctly declined:
*"another scheduler is already running — not starting a second"*. The dashboard's embedded
scheduler holds it. That guard is why beats now carry a `machine` field — a pid means
nothing across hosts, and without it a laptop sharing this database would read the
server's beat, find no such local pid, and start a second scheduler.

---

## STILL TO DO — the one thing that needs you

**The DNS record does not exist.** Everything behind it is verified working; the hostname
simply does not resolve yet, and creating it needs a Cloudflare login this session did not
have.

In Cloudflare → `digitalsukoon.com` → DNS, add:

```
Type   A
Name   e035e4d46c            (i.e. e035e4d46c.digitalsukoon.com)
IPv4   173.230.131.144
Proxy  Proxied (orange cloud)   ← required; the origin cert only validates behind CF
TTL    Auto
```

Verified already, with the Host header set so nginx matched without DNS:

```
https /sign-in : 200
https / (anon) : 307 -> /sign-in
http           : 301 -> https
invite gate    : present on /sign-up
```

**The subdomain being unguessable is NOT a security control.** A URL leaks through browser
history, referrer headers and CDN logs. What protects this is the invite code, the role
check, and `SEND_ENABLED=false`.

---

## Getting in

1. `SIGNUP_INVITE_CODE` is in `/opt/ds-sales-agent/.env` (mode 600). Read it there.
2. The **first account created bootstraps as `operator`** — otherwise a fresh deployment
   has nobody who can approve anybody.
3. Everyone after is a **`viewer`**: they see every page and can change nothing until an
   operator promotes them.

The database already carries `tabish@dashmani.com` as an operator, migrated from the
laptop with all 4,354 rows.

---

## Running it on your own Mac

```bash
pnpm local            # the dashboard here, reading the SERVER's live data
pnpm local offline    # ...reading the old SQLite snapshot instead
```

Then open `http://127.0.0.1:3100`.

**`live` is the default and is almost always what you want.** The dashboard runs on this
machine but the data is the server's, through the SSH tunnel — so it shows exactly what the
hosted copy shows, and anything you change is real.

**It works with the server down.** If the tunnel is unreachable, `pnpm local` falls back to
the local snapshot and starts anyway, with a loud warning that you asked for live data and
are not getting it. It used to `exit 1` and tell you to type a second command — which made
a LOCAL tool depend on a REMOTE host, on a machine holding perfectly good local data.

**It does not run a scheduler.** `EMBEDDED_SCHEDULER=false` is set, because a viewer must
not become a second detector. Found by running it: the "frozen" snapshot had grown from
1,851 posts to 1,891, because earlier local runs had been detecting into it.

**`offline` reads `prisma/dev.db`**, the SQLite file this project used until the migration.
It is a FROZEN SNAPSHOT from the morning of 2026-08-08 and never updates. Useful for poking
about without touching anything real; misleading the moment you forget which one you are in
— which is why every run prints the database it opened and how fresh it is.

Nothing else needs starting. The device agent and the tunnel are launchd jobs:

```bash
bash scripts/install-watch.sh status     # is the sending agent alive?
bash scripts/install-tunnel.sh status    # can this machine reach the database?
pnpm worker:heartbeat                    # is the WATCH running, and what has downtime cost?
```

**The Prisma client is per-provider, and switching databases regenerates it.** `pnpm local`
does that from `DATABASE_URL` so you never have to think about it. `pnpm test` needs the
SQLite client and restores this machine's own on the way out — running the tests must not
leave the machine unable to reach its database, which it did once.

---

## Deploying a change

There is no CI. `Host github.com` on this box is already taken by dashmani-platform, and
this repo's HTTPS remote wants credentials, so the current path is an archive:

```bash
bash scripts/deploy.sh

**Zero-downtime since 3 Sept.** The build goes into the other of `.next-a` / `.next-b`
(`NEXT_DIST_DIR`, read by `next.config.ts`) while the current one keeps serving; only a
successful build reloads the two cluster workers onto it, one at a time (`pm2 reload
--update-env`). Measured through Cloudflare during a deploy: 55 polls, 55 × 200. Before this,
every 5xx the hosted dashboard ever served was a deploy window (pm2 stop → ~2 min build → start).
The old dist is removed only after the new one answers; until then rollback is
`NEXT_DIST_DIR=<old> pm2 reload ds-sales-agent --update-env` on the server. Never reintroduce a
`pm2 stop` before the build, and never build into the dist being served.
```

**Memory on this shared box, and the three caps (4 Sept).** The Linode is 2 GB / 1 vCPU and
hosts nine services plus Postgres, MySQL and php-fpm; measured 4 Sept it had **914 MB in swap**
and was paging. That day the kernel OOM-killed `next-server` twice (773 MB and 607 MB anon-rss)
*with the 450 MB pm2 ceiling live* — pm2 samples memory every ~30 s and a render pile-up on a
paging box outran it. A single render peaks at only +22..32 MB heap; the memory came from
ten-plus renders alive at once after one took >60 s and nginx returned 504. Worse, the unit
carried systemd's default `OOMPolicy=stop`, so killing ONE process stopped the WHOLE pm2
service — every app on the box (HR, API, portal…) went down with ours and was resurrected a
minute later. Three layers now, all applied by `deploy.sh`:

| layer | where | what it does |
|---|---|---|
| **V8 heap cap** | web: `--node-args="--max-old-space-size=300"` · worker: `NODE_OPTIONS=--max-old-space-size=512` | deterministic; a runaway worker throws inside the process and pm2 restarts just it while its sibling serves |
| pm2 ceiling | `--max-memory-restart 450M` (web) / 700M (worker) | RSS backstop, ~30 s sampling |
| **systemd drop-in** | `/etc/systemd/system/pm2-root.service.d/oom.conf` → `OOMPolicy=continue` | if the kernel ever acts, ONE process dies and pm2 restarts it — the other teams' apps stay up |

**The carrier differs by pm2 mode and getting it wrong is silent.** In CLUSTER mode pm2 injects
env into `process.env` from JavaScript *after* Node starts, so `NODE_OPTIONS` is inert for a
V8 startup flag — it must be `node_args` (`pm2 reload --node-args` applies it with a rolling
restart; verify with `pm2 jlist` → `pm2_env.node_args`). In FORK mode env is the real environ
and is inherited down `pnpm → tsx → node`, so `NODE_OPTIONS` is right there. The first attempt
set `NODE_OPTIONS` on the cluster and pm2 dutifully stored it while the workers ran uncapped.

What the caps cannot do is make a paging machine crisp: at idle the box commits ~1.7 GB of
2 GB before our web renders anything (dashmani-platform 401 MB, MySQL 360 MB in swap, three
idle `dashmani_prod` Postgres backends at 86-123 MB each). The structural answer is a larger
Linode; the code-side answers are the single-flight view memo, pulse-based refresh and paged
lists shipped the same day.

**USE THE SCRIPT.** The hand-typed archive command below is kept only because it explains
what the script does; typing it sprang two traps in one command on 2026-08-18 and took the
dashboard down for ten minutes:

- **`tar` never deletes.** Three files removed from the repo hours earlier were still on
  the server, still importing settings that no longer existed, and `next build` typechecks
  everything it FINDS — so a deploy of correct code failed on code that was not in the repo.
  The script removes stale files explicitly, comparing `git ls-files` against the server
  with `LC_ALL=C sort` on both sides (macOS and GNU sort disagree on punctuation, and a
  mismatched sort makes `comm` list files as present in both directions — acting on that
  output deletes live files).
- **A pipe masks the build's exit code.** `pnpm build 2>&1 | tail -1 && pm2 start` takes its
  status from `tail`, which always succeeds, so pm2 started with no production build. That
  exact failure was already documented here from the previous time it happened — a rule
  written down is not a rule enforced. The script checks the build directly, leaves the
  server STOPPED on failure, and prints the log.

The archive form, for reference only:

```bash
# from the repo, with a clean working tree
tar czf /tmp/ds-agent.tgz --exclude=node_modules --exclude=.next --exclude=.git \
    --exclude='prisma/dev.db*' --exclude='*.tsbuildinfo' --exclude='.env' .
scp /tmp/ds-agent.tgz linode:/tmp/
ssh linode 'cd /opt/ds-sales-agent && cp .env /root/.env.server-backup &&
  tar xzf /tmp/ds-agent.tgz && pnpm install &&
  pnpm exec prisma generate --config prisma.postgres.config.ts &&
  pnpm build && pm2 restart ds-sales-agent'
```

**`--exclude='.env'` IS THE MOST IMPORTANT FLAG IN THAT COMMAND, and it was missing until
2026-08-11.** The archive is made from a laptop, so shipping `.env` overwrites the SERVER's
environment with the DEVELOPER's. Measured, on a real deploy that day — all four of these
landed on the server at once:

| server needs | the laptop's `.env` set it to | consequence |
|---|---|---|
| `SEND_ENABLED=false` | **`true`** | the hard floor in `withSendLock` that makes hosting safe STRUCTURALLY, gone |
| `AUTOPILOT_ENABLED=false` | **`true`** | the env floor under the one switch, gone |
| `DATABASE_URL` → `localhost:5432` | `127.0.0.1:**15432**` | that is the laptop's SSH TUNNEL port. Nothing on the server listens there, so every query failed |
| `DS_DEVICE_NAME=linode-detect` | `tabish-mac` | the server started identifying itself as the laptop |

The first two are the ones that matter: the whole hosting argument is that a datacenter IP
must never drive a Chrome profile logged in from a home IP, and `SEND_ENABLED=false` is what
enforces it in code rather than by intention. A deploy silently raising it is the single
worst outcome available here, and it fails SILENTLY — the dashboard still serves 200.

The database error was the only loud symptom, and it is what led to finding the other three.
**Check all four after any deploy — and `DRY_RUN`, a fifth that is not on the table above because
it fails in the QUIET direction** — before trusting that a green page means a good deploy:

```bash
ssh linode "grep -E '^(SEND_ENABLED|AUTOPILOT_ENABLED|DS_DEVICE_NAME|DATABASE_URL|DRY_RUN)' \
  /opt/ds-sales-agent/.env | sed 's/:[^:@]*@/:***@/'"
```

**`DRY_RUN` must read false (`0`) on the box.** `DRY_RUN` DEFAULTS TRUE and a laptop's `.env` carries
`DRY_RUN=1` (this repo's own does), so a shipped `.env` — or a box that never set it — has the
planner mark every draft it writes `SKIPPED` with `error: 'DRY_RUN'` instead of leaving it `READY`
(`plan.ts`, "would have queued"). Nothing errors, `planLastOkAt` stays fresh, detection is healthy,
and the selected Mac's queue simply stops refilling: the drafts the server is for never exist. It
does not make the box send — `SEND_ENABLED=false` still forbids that, and since Stage 1.4 a host
with it false schedules no dispatcher and a DRY_RUN host that is not the selected Mac writes no
`dispatchState` — it makes the box useless in a way no screen reports.

**RESTARTING FASTER THAN THE STALENESS WINDOW GUARANTEES NO SCHEDULER.** Also measured that
day, and it cost four restarts to understand. `startScheduler` runs ONCE at boot and refuses
when it sees another scheduler's heartbeat under 3 minutes old. A `pm2 restart` leaves the
dying process's beat behind, and — because the beat is judged on FRESHNESS when the machine
label does not match, since one host cannot ask another's kernel about a pid — a restart
inside 3 minutes reads its own predecessor as alive, declines, and then never retries. The
dashboard serves perfectly with nothing detecting, drafting or dispatching behind it.

So: **restart at most once every 3 minutes, and verify the heartbeat afterwards rather than
the HTTP status.** The evidence that a scheduler is actually running is a `schedulerHeartbeat`
row whose `pid` is the live process and whose `at` is under a minute old:

```bash
ssh linode "tail -25 /root/.pm2/logs/ds-sales-agent-out.log | grep 'watching 4 slots'"
# and, from a laptop with the tunnel up, the independent check:
#   SELECT value FROM "Setting" WHERE key = 'schedulerHeartbeat';
```

Same lesson as everything else in this file: a file on disk is not a running process, and an
HTTP 200 is not a working system.

**`prisma generate --config prisma.postgres.config.ts` is not optional.** The generated
client is BAKED with its schema's provider — `pnpm install`'s postinstall generates the
SQLite one, and the Postgres adapter then refuses to load:

> `The Driver Adapter @prisma/adapter-pg ... is not compatible with the provider sqlite
> specified in the Prisma schema.`

Found by running it, not by reading. Regenerate after every install.

**A FILE ON DISK IS NOT A RUNNING PROCESS.** Found here on day one: the OCR fix was
`scp`'d to the server and verified with a fresh `tsx` run — which loads from disk every
time and therefore passed — while the long-running dashboard kept the OLD module in memory
and went on writing `frame:no-ocr-engine` for another 45 minutes. Node caches modules at
require time; a 67-minute uptime with 0 restarts means it is running whatever it loaded at
boot. **Always `pnpm build && pm2 restart`, and check `pm2 describe` shows the restart.**
Verifying a fix in a new process says nothing about the process actually serving — the
same "freshness is not liveness" trap this codebase keeps finding, applied to code rather
than data.

**Build BEFORE restarting, never while running.** `next start` reads the build manifest at
boot; rebuilding underneath it serves HTML referencing replaced chunks, and one returns
HTTP 500 while `curl` still gets 200 on the page itself.

**Schema changes are manual**, exactly as the playbook requires. `prisma migrate dev`
offered to reset this data once already, on drift unrelated to the change being made.

---

## Detection reads nothing

When the landing page says no paid posts are being found, the first question is **this address,
this identity, or everyone?** On 4 Sept it took a day to learn it was the identity, because nobody
asked Instagram under a second one. `pnpm ig:probe` asks: it prints what the detection passes last
recorded, then makes **one request per identity** (the app identity in use, an unverified newer app
version, and the retired web identity as a control), 6 s apart, and says what came back.

Run it on **both** hosts and read the two outputs side by side:

```bash
pnpm ig:probe                                         # on the Mac, in the repo directory
ssh -n linode "cd /opt/ds-sales-agent && pnpm ig:probe"   # on the box — -n, or ssh eats the rest of a script
```

`--offline` prints only the stored evidence and asks nothing. `--handle <username>` reads another
account (default @viralbhayani). `--ua "Instagram … Android (…)"` adds one candidate: the app
identity with that User-Agent. `--graph` adds one request through the official API when the box is
configured for it (next section). Exit 0 means the identity in use was served; 1 means it was not.

**It records nothing.** It closes no gate and writes no evidence row, so the detection pass carries
on exactly as it was — even when the probe is refused. If this host's gate is already closed it says
so and asks anyway: one request per identity (three by default, four with `--ua`), once, against an
address Instagram has told to wait. A redirect, if Instagram answers with one, is followed the way the
detection pass follows it. That is the price of the answer, and the reason it never runs on a loop.

**A blip is not a verdict.** If the identity in use got no answer, or Instagram's own 5xx, the probe
does not say "the identity is the fix" even when another candidate was served — probe again.

| What the probe shows | What it means |
|---|---|
| the identity in use **served**, yet the page says nothing is read | the pass is not running, or not running this build — check `pm2 describe ds-sales-worker` and its log (by name — never a global pm2 command) |
| **401 / 429 / the login wall** on the identity in use | this IP or this identity is refused. Served on the other host: this address, and it lifts by itself. Refused there too: see the last row |
| **400** whose body says **update** or **SecFetch** | how the request presents itself, not a rate limit — waiting will not fix it. Try `--ua` with a current Instagram for Android User-Agent |
| **200 with items on one candidate and not another** | the identity is the fix: one edit, `FEED_HEADERS` in `src/detection/feed.ts`. Probe both hosts again before deploying it |
| a web page, JSON in another shape, or no posts | the endpoint or its answer changed — not a rate limit |
| no answer on any candidate | this host cannot reach Instagram (network, DNS, firewall) |
| **every identity refused, on both hosts** | a platform wall on anonymous reads. The official read fallback below is the remaining path, and turning it on is Tabish's decision |

The "newer version" candidate is a **guess** at a current app version, not read off a device. It
exists so that served-against-refused can tell a version gate from a wall; a real User-Agent from a
current Instagram for Android, passed with `--ua`, is better evidence than it.

---

## Official read fallback (dormant)

**What it is.** When Instagram refuses the anonymous feed, the server can read a watched channel
through Meta's Instagram Graph API **Business Discovery** instead (`src/detection/graphFeed.ts`,
chosen per channel by `src/detection/feedSource.ts`). It is an authenticated API with a token a
person mints through the business's own Meta app ("Post Automation 2", which already has the
three permissions it needs at advanced access). It is **not** an Instagram web session and sends
no cookie — decision 4 is about the anonymous feed, and still holds for it.

**It is off.** With `META_GRAPH_TOKEN` and `META_IG_USER_ID` unset (the state of every host
today) nothing about detection changes, and a test proves it request for request. Turning it
on is **Tabish's decision**, because of what it loses:

- **no tags, no collaborators, no sponsor tags, no paid-partnership flag** on the posts it reads
  — prospects are minted from tags, so a channel read this way finds paid posts but mints no
  prospects from their tags (stored tags are never erased: the evidence-wipe guard in
  `evidence.ts` and `pipeline.ts`);
- **captions without their @mentions** — Meta's documentation says the `@` is removed from a
  caption read this way (not yet seen in a real answer; nothing has been called). Brand
  discovery and the mention rules key on `@`, so these posts mint nothing from the caption either;
- **what comes back, and what does not.** When the anonymous feed returns, each such post it reads
  is judged again from the complete read — caption with its mentions, tags, brands and verdict
  rewritten — unless a person labelled it, in which case only its caption and tags are filled in
  and the person's answer stands. The feed reaches back for them only as far as that pass already
  looks (6 hours on the 15-minute pass, 36 on a slot's catch-up). **A post the official API stored
  earlier than that keeps its incomplete evidence for good**, because chasing a post past the feed's
  reach would cost extra pages on every pass;
- **Business and Creator accounts only** — a personal account on the watch list cannot be read
  this way, and age-gated accounts are not returned;
- **an hourly budget** of roughly 200 calls (Meta's documented per-user figure); the server caps
  itself at 60 calls a pass and pauses for 30 minutes on a rate-limit answer.

**MEASURED ON THE BOX, 15 OCT 2026, by a person with curl** (the code itself has not run against
it yet). The anonymous app identity answered `401 {"message":"Please wait a few minutes before you
try again.","require_login":true}` on the FIRST request from both the box and DMPLs Mac Studio, so
the refusal is the identity, not one address. The official path answered from the box: a
system-user token (Business Settings → System users, which does not expire) sees three Pages with
Instagram professional accounts — @bollywoodchronicle, @bollywoodsocietyy and @madaboutmarketingg —
and with @madaboutmarketingg's IG user id, Business Discovery returned media for **13 of the 14
watched pages**. The 14th, @marketingmentalist (personal, silent since 2020), answered `110 / 2207013
"Invalid user id"`. Those three error shapes are rows in `tests/graph-feed.test.ts`; every other
response shape the code handles is still from Meta's documentation. **The token and id were put in
the box's `.env` that day by the operator during the outage** — the decision above, taken under it,
which Tabish may reverse by removing the two lines.

**The person's steps, on the box only:**

1. Generate a token for an Instagram professional account the business owns, through the existing
   app, with `instagram_basic`, `instagram_manage_insights` and `pages_read_engagement` (plus
   `pages_show_list` and `business_management` to list the Pages). **Prefer a system-user token**
   (Business Settings → System users → generate, with the Page and its Instagram account assigned to
   that system user): it does not expire, and it is what the box uses. A long-lived Facebook User
   token from the Graph API Explorer works too but **expires** (about 60 days, per Meta's
   documentation) — put a date in the calendar; an expired token shows on the landing page (below).
2. Find that Instagram professional account's **IG user id** (the numeric id, e.g. from the Graph
   API Explorer: the Page's `instagram_business_account` field).
3. Put both in **`/opt/ds-sales-agent/.env` on the box** — never in the repo, never on a Mac, and
   never pasted into chat:
   ```
   META_GRAPH_TOKEN="…"
   META_IG_USER_ID="1784…"
   ```
   Both or neither: the process refuses to start with only one, and refuses a non-numeric id —
   so check the worker came back. **The dashboard reads the same `.env`**, so a half-set pair also
   stops it at its next reload: check `pm2 describe ds-sales-agent` too (by name). And the dashboard
   then HOLDS the token in memory as well — its "Check now" button runs a detection pass in that
   process, which may use the official API with its own per-pass budget and pause.
4. Restart the worker **by name**: `pm2 restart ds-sales-worker` (never a global pm2 command).
5. On the box: `pnpm ig:probe --graph`. It reads one page of one channel through the official API
   and says in a sentence what came back (it calls `probeOfficialRead`, which records nothing). It
   **also** makes its usual anonymous requests first — one per identity, three by default, possibly
   into a gate the box has already closed; there is no flag that asks only the official API. The
   probe command ships with the detection-outage work — if the box's build predates it, deploy
   first.

**Turning it off** is the reverse: remove both lines and restart the worker **and the dashboard** by
name (`pm2 restart ds-sales-worker`, then `pm2 reload ds-sales-agent`), or the dashboard keeps the
token in memory until its next reload. A token that
expires shows on the landing page as *"The official read token is invalid or expired — reading
has stopped until it is replaced"*; the remedy is step 1 again.

### Reading back a blind stretch: `pnpm ig:backfill` (16 Oct 2026)

The routine pass reads back only to the newest post it already holds (or 6 hours, if it holds none
that recent), so when **neither** door served for a while — the anonymous feed walled, the fallback not
yet configured — the posts of that stretch are never read, however many passes follow. The official
API pages back through a channel's whole history, so they can still be read. Two pieces:

- **Automatic, for a gap at the edge.** A channel with nothing stored inside the lookback has its
  official read reach back to its newest stored post (at most 36 hours) with a 150-post bound. Whatever
  that leaves unread — a gap older than 36 hours, a read the call cap or the bound cut short, or a
  gapped channel the anonymous feed served (it is never deepened) — is **logged by name** with the dry
  run that reads it: `part of what this channel is missing was not read …`, `remedy: pnpm ig:backfill
  --hours N --channel <handle> (as of <time>; add the hours since)`. Run it later and add the hours
  that have passed, or the oldest end stays unread.
- **By hand, for a gap already in the middle** (today's case: the newest stored post is fresh, so the
  automatic rule cannot see it). `--hours` is required, a whole number from 1 to 168 (the 7-day
  material window); `--channel <handle>` (repeatable) reads only those watched channels. **Run on the
  box, one line at a time — the console mangles multi-line pastes.**

  First, the dry run (reads, writes nothing):
  ```
  cd /opt/ds-sales-agent && pnpm ig:backfill --hours 48
  ```
  It prints, per channel, how many posts it found in the window and how many are not stored, the
  official calls it spent, **how long `--run` would take** (~7 s a post — 8 Sept's measurement), and the
  line to store them. The worker can stay up for it, but its calls come out of the **same Meta hourly
  budget** (~200) the worker's official read is using right now: a large dry run can push the worker
  into a rate limit, which pauses its official read for 30 minutes — posts delayed, not lost. Use the
  smallest `--hours` that covers the gap.

  Then store them. This stops the worker, runs the backfill and starts the worker again — **detached**,
  so closing the console (or the session dropping) cannot kill the run and leave the worker stopped;
  `Ctrl-C` stops only the `tail`:
  ```
  cd /opt/ds-sales-agent && setsid sh -c 'pm2 stop ds-sales-worker && pnpm ig:backfill --hours 48 --run; pm2 start ds-sales-worker' > /tmp/ig-backfill.log 2>&1 < /dev/null & tail -F /tmp/ig-backfill.log
  ```
  **While it runs the worker is stopped — no detection, no drafting, no slots** — for the time the dry
  run estimated (48 hours of the busiest channels is ~1,500 posts, about three hours). A smaller
  `--hours`, or `--channel`, shortens it. `--run` **refuses while the worker runs on this host** (961 MB:
  two detection processes means two OCR children and two heaps, and a backfill overlapping the 15-minute
  pass would judge posts twice) and prints that same line. Afterwards check the worker came back:
  `pm2 describe ds-sales-worker` (by name). The log stays at `/tmp/ig-backfill.log`.

What a run reports and costs: the same per-channel lines `ig:detect` prints, the official calls used
against the run's cap of **200** (Meta documents roughly 200 an hour for this account — a week of every
channel is ~260–280 calls, **more than one run**), and every channel it did **not** take back the full
N hours, with why, in two lists: what a re-run can finish — with the exact line that re-reads **only
those** channels (`--channel …`; a bare re-run would spend the same calls on the same channels in the
same order) — and what re-running will not help (a personal account, a token to replace, the 600-post
per-channel bound). A backfill reads **through the official API only**: the anonymous feed is not asked
and not deepened, so it works whether or not the anonymous feed answers. It stores the window it was
asked for (not the older posts on its last page). Re-running is safe: storage is idempotent on shortcode.

**What a backfilled post is worth, stated.** It is stored like any official read — no tags, no
collaborators, and (per Meta's documentation) a caption with its `@`s removed — and is completed only if
the anonymous feed reads it again **inside a pass's 6-hour lookback**, which for a post from a blind
stretch never happens. So until a person (or a future completion path) fills in its evidence, a
backfilled paid post funds a message only where the classifier's **brand name** exactly names a
verified prospect (materialAllowance's brand-string arm); its caption mentions and tags cannot credit
anyone, and brand discovery mints nobody from it. Worth measuring after the first run: how many
backfilled CAMPAIGN rows link to a live prospect.

---

## Deploying the worker from the box itself (no Mac)

`scripts/deploy.sh` needs a Mac holding the management SSH key, and builds the web tier there. When
no such Mac exists (15 Oct 2026: the Mac that held it was gone), the detection worker can still be
updated from a root console on the box, because it runs from source and needs no build:

```bash
curl -fsSL https://raw.githubusercontent.com/dmpl6454/ds-sales-agent/<sha>/scripts/deploy-worker-on-box.sh -o /tmp/dwob.sh && bash /tmp/dwob.sh <sha>
```

`<sha>` is the full 40-character commit the suite passed on — never a branch name. The script
downloads that commit (the repo is public), refuses unless `.env` says `SEND_ENABLED=false`, refuses
if the lockfile or the Prisma schema differs from what is installed (either needs a full deploy),
backs up the current source to `/opt/ds-backups/`, copies the files, sweeps stale ones the way
`deploy.sh` does, restarts **only** `ds-sales-worker` by name, and prints the rollback line. The
dashboard keeps serving its previous build — its screens catch up at the next full deploy.

**What this does not replace.** A full deploy (web tier) and every DMG build still need a Mac: one
with a git checkout, the management key in the box's `authorized_keys`, and — for a notarised DMG —
the Developer ID signing identity and the `ds-notary` keychain profile, both of which lived on the
Mac that is gone. Setting up a replacement is a person's job (a new Developer ID certificate from
that Mac's own certificate request; Apple allows five per team).

---

## The database

```
postgresql://dsagent:***@127.0.0.1:5432/ds_sales_agent
```

**Owned by `dsagent`, not `postgres`** — verified by asking the catalogue, and by executing
`CREATE`/`ALTER`/`DROP` as the app user. A postgres-owned database fails `prisma migrate`
partway through with `permission denied for table X`, which is the worst moment to find out.

Reaching it from a laptop is an SSH tunnel, never an open port:

```bash
ssh -f -N -L 15432:localhost:5432 linode
# then DATABASE_URL="postgresql://dsagent:***@127.0.0.1:15432/ds_sales_agent"
```

5432 is not exposed and must not be.

---

## What is deliberately not running

- **Autopilot is OFF.** Hosting is not a decision to start sending. Note that since
  2026-08-08 the per-account arming switch no longer exists — that one toggle is the whole
  control, and what additionally stops the revenue accounts is that two of the three have
  no Instagram sign-in anywhere. `SEND_ENABLED=false` means this server cannot send
  regardless of either fact.
- **No Instagram session exists on this server**, and none may be put there.
- **No Chrome profile** has been copied here, and none may be.
