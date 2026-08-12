# The deployment, as it actually is

**Written 2026-08-08 from the live server**, not from a plan. Everything here was verified
by running it. Where something is not done, it says so.

---

## The shape

```
LINODE 172.105.53.101                     A USER'S OWN MAC / WINDOWS
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
| `pm2` process | `ds-sales-agent` — the dashboard, which also runs the scheduler |
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
IPv4   172.105.53.101
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
**Check all four after any deploy**, before trusting that a green page means a good deploy:

```bash
ssh linode "grep -E '^(SEND_ENABLED|AUTOPILOT_ENABLED|DS_DEVICE_NAME|DATABASE_URL)' \
  /opt/ds-sales-agent/.env | sed 's/:[^:@]*@/:***@/'"
```

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
