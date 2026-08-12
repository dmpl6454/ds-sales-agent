# Hosting this on Linode

**Status:** plan, not executed. Written 2026-08-03 against `~/Desktop/DEPLOY-PLAYBOOK.md`.
**Headline:** the dashboard and detection can move. **Sending cannot, and must not.**

---

## 1. Why this is not an ordinary deploy

The playbook is a good runbook and most of it applies — §6 provisioning, §9 Nginx +
Cloudflare, §10 pm2, §12 GitHub Actions, §14 manual migrations. But it was written for
the Dashmani monorepo: Postgres, `apps/api` + several Next frontends,
`NEXT_PUBLIC_*` baked at build. This repo is one Next app on SQLite, so the shape is
simpler.

What is *not* simpler is that this app drives a real Chrome browser as a logged-in
Instagram user, and five of its load-bearing properties are properties of **the machine
it runs on**:

| Property | Why a VPS breaks it |
|---|---|
| **Home residential IP** | CLAUDE.md decision 1: *"Same home residential IP the accounts normally use. No VPS, no VPN."* A Linode is a datacenter IP. A known account appearing from hosting infrastructure is exactly the device/network discontinuity the whole design exists to avoid — and it is the one signal research confirmed as a pass/fail gate rather than a score. |
| **`headless: false`** | Required, always; headless Chrome differs measurably. On a headless VPS this needs Xvfb, which is not the surface any of this was verified on. |
| **Hand-logged-in Chrome profiles** | They carry device identity (`mid`, `ig_did`, `ig-u-rur`) written by *your* login from *your* IP. Copying them to a server is a session transplant in all but name — the exact thing CLAUDE.md forbids, and it *works* right up until enforcement lands silently. |
| **`~/.ds-sales-agent` is a credential file** | Patchright hardcodes `--password-store=basic`, so the cookie-encryption key is a public constant, not machine-bound. Anyone with a copy of that directory decrypts the session cookies offline. Putting it on a shared VPS makes that a real exposure rather than a theoretical one. |
| **No auth, binds `127.0.0.1`** | There is no `middleware.ts` and no login. Today that is safe only because of the bind. Behind Nginx it becomes a `Send from @<revenue account>` button on the public internet. |

None of these are solvable by configuration. **Do not deploy the send path.**

---

## 2. What is actually gained

Worth being honest, because the answer shapes how much work is justified.

- **Detection survives a closed laptop.** Real. The `execution:missed` handler catches
  slept-through slots, but only inside `CATCHUP_WINDOW_MINUTES` (currently 240). A laptop
  shut overnight still loses the 20:00 slot.
- **Detection gets a different IP.** Also real, and currently useful: 8 of the 12 slots
  before 2026-08-03 came back `PARTIAL` with `fetch failed` against the anonymous feed —
  IP rate limiting, the one exposure decision 4 accepts. A datacenter IP would likely
  clear that.
- **The dashboard is reachable from anywhere.** Only if you add auth. See §4.

What is *not* gained: nothing about sending gets better, and several things get worse.

---

## 3. Two shapes. Start with the first

### B1 — Linode runs detection. Everything else stays home. **Recommended.**

```
Linode                             Home Mac
──────                             ────────
Postgres  ◄──── SSH tunnel ──────  dashboard (127.0.0.1:3000, unchanged)
detection scheduler                sending (Chrome profiles, home IP)
(anonymous, no credentials)        scheduler: delivery only
```

Detection is anonymous HTTP with no credentials, so it moves with no safety
implications at all. The dashboard and the Send button stay exactly where they are —
still bound to localhost, still no auth needed, still synchronous.

Cost: the SQLite → Postgres migration (§5) and a tunnel. Nothing else changes.

### B2 — Linode also runs the dashboard

Then the Send button is on a machine that cannot send, and delivery has to become
**asynchronous**: the button marks an attempt as requested, a home agent polls, sends,
and writes back; the UI polls for the outcome. That is a genuinely different interaction
model, and it dissolves a property worth keeping — today one click means one send,
enforced by an atomic `updateMany` claim in a single process. Across two hosts that
claim still works, but "did it send?" stops being answerable in the same request.

It also *requires* auth (§4), and it puts the queue of pending sends on a public host.

**Do B1 first.** B2 only if you genuinely need the dashboard from outside the house, and
then treat the async send path as its own design.

---

## 4. Auth is not optional if anything is exposed

`actions.ts` already reasons about exactly this for `AUTOPILOT_ENABLED` — *"anyone who
can reach it can call this action"* — and correctly hard-floors that one switch in the
environment. That reasoning covers one switch. It does not cover `sendNow`,
`setAccountAutopilot`, `removeSender`, `removeTarget`, or `clearChallenge`.

Measured previously: `curl` to the LAN IP returned 200 with the send buttons in the HTML.

If the dashboard is ever reachable beyond localhost it needs, at minimum: a
`middleware.ts` gate on every route and every server action, a single strong credential
in the environment, and HTTPS terminated by Cloudflare (playbook §9). The safer answer
for one operator is **not to expose it at all** — `ssh -L 3000:localhost:3000 dashmani`
gives you the page from anywhere with no new attack surface. CLAUDE.md already says
this: *tunnel, never rebind.*

---

## 5. SQLite → Postgres

Required for B1 and B2 both: two hosts cannot share a SQLite file safely.

The schema anticipated it — *"Postgres later = change provider + adapter only"* — and
that is close to true. Mechanically:

1. `schema.prisma`: `provider = "postgresql"`.
2. `src/lib/db.ts`: swap `PrismaBetterSqlite3` for the Postgres adapter; drop
   `better-sqlite3`. Prisma 7 takes the adapter on the client, and `prisma.config.ts`
   keeps only the datasource URL — both already wired that way, so this is a two-line change.
3. `prisma migrate` against the new database; then `prisma/seed.ts` (idempotent).
4. Copy existing rows across. At ~750 posts and ~30 attempts this is a script, not a
   migration tool.

What stays ugly but harmless: the JSON-string columns (`brands`, `signals`) and
string-union statuses exist because SQLite has no arrays or enums. On Postgres they
would idiomatically be `text[]` and enums. **Do not convert them in the same change.**
Migrating the host and changing column semantics at once means a failure could be
either, and `readStringArray`/`readRecord` already isolate the difference.

Playbook §5 has the Postgres ownership trap worth re-reading: create the database owned
by the app user, or `prisma migrate` fails with `permission denied for table X`.

---

## 6. Process split

The scheduler currently does detect → deliver → plan in one `runSlot`. Split by
environment, not by fork:

- **`SEND_ENABLED=false`** (Linode) — `runSlot` runs detection and planning, and skips
  `deliverWaiting` entirely. Drafts accumulate as READY, which is exactly what already
  happens when autopilot is off.
- **`SEND_ENABLED=true`** (home) — delivery runs as it does today.

One flag, checked in one place, and the failure mode is the safe one: a misconfigured
server prepares messages and sends nothing. It must be a hard floor like
`AUTOPILOT_ENABLED` — environment only, never settable from the dashboard.

The heartbeat already prevents two schedulers double-firing (`schedulerHeartbeat` plus a
`process.kill(pid, 0)` liveness check), but that check is **pid-based and therefore
host-local**: a Linode pid means nothing on the Mac. Two hosts running schedulers will
each see the other's heartbeat and misjudge liveness. The record needs a host identity
before this split ships, or slot locking has to move into the database
(`ScrapeRun` + the existing `create`-on-primary-key test-and-set already gives most of it).

---

## 7. Concrete sequence for B1

Mapped onto the playbook.

**On the Linode** — new box (§6) or alongside Dashmani (§11). If alongside: fresh
`/opt/ds-sales-agent`, fresh Postgres user and database, fresh pm2 name
(`ds-sales-agent-worker`, not `worker`), a different port, and **keypair #3 with its own
`Host github.com-dssales` alias** — `Host github.com` is already taken by Dashmani.
Memory: one Next app plus Postgres is comfortable at 2GB; §11's 4GB warning applies only
if Dashmani's apps are already there.

1. Provision Postgres user + database (§5 / §11 step 1).
2. Clone (§11 steps 2–4), `.env` with `SEND_ENABLED=false`, `AUTOPILOT_ENABLED=false`.
3. `prisma migrate deploy`, then seed, then the row copy from §5.
4. `pm2 start` **`pnpm worker` only** — not the dashboard. The server has no page to
   serve in B1, which also means no Nginx, no Cloudflare, no TLS and no auth work at all.
5. `pm2 save && pm2 startup`.
6. Firewall (§6 step 4): 22 only. Postgres 5432 stays closed; the Mac reaches it through
   the SSH tunnel, not the internet.

**On the Mac**

7. `DATABASE_URL` points at `localhost:<tunnelport>`; an autossh tunnel keeps it up.
8. `.env` keeps `SEND_ENABLED=true`.
9. The dashboard runs exactly as now, bound to `127.0.0.1`.

**Verify** — CLAUDE.md's rule: a 200 proves the server is alive, not that the page works.
Extract the `/_next/static/**.js` references and fetch each one. Then confirm a slot on
the Linode writes a `ScrapeRun` the Mac's dashboard can see, and that
`deliverWaiting` never runs there.

---

## 8. What must not happen

- **The Chrome profiles never leave the Mac.** Not backed up to the server, not in a
  synced folder, not in a repo. `~/.ds-sales-agent` is a password file (§1).
- **No `sessionid` on the server, ever.** Detection is anonymous by decision 4; attaching
  a cookie converts an IP-level risk into an account-ban risk.
- **No `pnpm build` while `pnpm start` runs** — `next start` reads the build manifest at
  boot, and rebuilding underneath it serves HTML referencing replaced chunks. The
  playbook's deploy script (§13) already builds then restarts; keep that order.
- **Migrations stay manual on production** (§14). Never `db push` at deploy time.
- **The dashboard is never bound to `0.0.0.0`** without the auth work in §4.
