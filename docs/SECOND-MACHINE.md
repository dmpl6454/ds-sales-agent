# Setting this up on a second Mac

Written 2026-08-17 by cloning the repository into a temporary directory and doing exactly
this, in this order. Every command below was RUN, not recalled. Where something does not work
yet, it says so.

There are **two different things** you might want, and they need different setup. Decide which
before you start, because the second one can send messages to real companies.

| | |
|---|---|
| **A. Read-only** — look at what the live system is doing | the tunnel, and nothing else |
| **B. A sending device** — this Mac drives Instagram | a hand login per account, from your home IP |

---

## 0. Before anything: what this software does

It sends cold DMs from Instagram accounts that are **real revenue-generating business
assets**. Read `CLAUDE.md`'s section *"The one rule that overrides everything"* before you run
anything with `--run` or `SEND_ENABLED=true`. The short version:

- **Never transplant a session cookie between machines.** Log in by hand, once per account, in
  that account's own Chrome profile. This is the single load-bearing safety choice in the
  whole design and it is why a second machine cannot simply copy the first one's profiles.
- **Never open one of these Chrome profiles with ordinary Chrome.** It cannot decrypt the
  cookies and DELETES the rows it cannot read, destroying device identity that cannot be
  rebuilt.
- Sending must come from the **home residential IP** the accounts normally use. No VPN, no
  VPS, no proxy.

---

## 1. Install

```bash
git clone https://github.com/dmpl6454/ds-sales-agent.git
cd ds-sales-agent
pnpm install          # postinstall generates the Prisma client for SQLite
cp .env.example .env
```

Requires **Node 22+** and **pnpm 10+**. Verified on Node 22.22 / pnpm 10.33.

**Now open `.env` and set `SIGNUP_INVITE_CODE` to any string.** An unset code means signup is
CLOSED — correct on a server, a dead end on a laptop, and the symptom is that you start the
app and can never create the account that would let you in.

**If this machine will ever talk to the shared database, give it its own `DS_DEVICE_NAME`**
(uncomment the line in `.env`; unset means the hostname). The sending Mac is chosen by this
name, so two machines with one name would BOTH act as it — two dispatchers sending from the
same accounts on two networks. Never copy another machine's `.env` without changing it.

Check it worked:

```bash
pnpm typecheck        # clean
pnpm test             # 1,567 passing / 78 files
```

Both pass on a clean clone with no database and no API key. If they do not, stop here — the
problem is the install, not the configuration.

---

## 2. Choose a database

### A local one, to learn on (safe, isolated, recommended first)

```bash
pnpm db:push          # creates prisma/dev.db from the schema
pnpm db:seed          # 3 senders, 3 targets, 7 routes, bespoke first messages
pnpm dev              # http://127.0.0.1:3100
```

Nothing here touches the real system. The seeded accounts have no Instagram session, so
nothing can send even if you turn everything on.

### The live one, through the tunnel (what the team actually uses)

You need SSH access to the Linode and the database password.

```bash
bash scripts/install-tunnel.sh install    # keeps 127.0.0.1:15432 open
bash scripts/install-tunnel.sh status     # asks whether the PORT answers
```

Then set in `.env`:

```
DATABASE_URL="postgresql://dsagent:<password>@127.0.0.1:15432/ds_sales_agent"
```

and run `bash scripts/prisma-client-for-env.sh` — **the generated Prisma client is baked with
its schema's provider**, so switching databases is a build step, not a runtime setting. Never
run a bare `pnpm prisma generate`; that script picks the right one from `DATABASE_URL`.

```bash
pnpm local            # the dashboard here, reading the SERVER's live data
```

**`pnpm local` is the normal way to run against live data.** It sets
`EMBEDDED_SCHEDULER=false`, because a viewer must not become a second detector, and it prints
which database it opened and how fresh it is.

> **`pnpm test` regenerates the SQLite client and restores yours on the way out.** If the
> suite dies partway it can leave the client on the wrong provider, and the symptom is the
> device agent being unable to reach the server at all. The fix is
> `bash scripts/prisma-client-for-env.sh`.

---

## 3. If this Mac is going to SEND

Everything above is read-only. This section is not.

```bash
pnpm ig:login <handle>     # or press Connect on /senders
```

That opens **that account's own Chrome profile** at `~/.ds-sales-agent/chrome-profiles/<handle>`
and waits for you to log in by hand. Do it from the home IP. Do it once per account.

Then:

```bash
pnpm agent status          # what is actually blocking each account, asked of the
                           # thing that ENFORCES each stop rather than a stored bit
pnpm agent:device          # the sending agent for THIS machine
```

`pnpm agent:device` refuses to start when `SEND_ENABLED=false`, which is how the server is
configured and how you should configure this until you have watched what it drafts.

**`~/.ds-sales-agent` is as sensitive as a password file.** Chrome's cookie-encryption key
here is a public constant, not a Keychain entry, so anyone with a copy of that directory can
decrypt the sessions offline. It must never go into a synced folder, a backup you share, or a
screen recording. Frames, logs and the OCR binary live in the SIBLING directory
`~/.ds-sales-agent-data` precisely so the dangerous set stays small and explicit.

---

## 4. What will NOT work on a second Mac, and why

| | |
|---|---|
| **Someone else's Instagram sessions** | Not copyable, by design. Each Mac logs in by hand. A transplanted `sessionid` works right up until enforcement lands silently. |
| **Cover frames from another machine** | Frame stores are PER MACHINE. The server holds ~1,300; a fresh Mac holds none. Anything reading frames must run where they are, and `rejudgeUnusedEvidence` deliberately leaves a row alone rather than record a local absence as a fact about the post. |
| **`pnpm ig:brands --run` from a datacenter** | Instagram 429s the Linode on the profile endpoint and answers a home Mac. This command must be run from a home IP. |
| **`pnpm build` while the app is running** | Standing rule. `next start` reads the build manifest at boot; rebuilding underneath it serves HTML referencing replaced chunks. Stop it first. |
| **Deploying with `prisma migrate deploy`** | The server has **no `_prisma_migrations` table** — its schema was never managed by `prisma migrate`. A migrate would try to replay everything against a populated database. |

---

## 5. The commands worth knowing on day one

Every command that costs money or changes real state is a **DRY RUN BY DEFAULT** and needs
`--run`. That is a deliberate pattern, not a coincidence.

| | |
|---|---|
| `pnpm ig:detect` | one detection pass now |
| `pnpm ig:accuracy --repeat 3` | measure the classifier. **Use `--repeat`** — it is not deterministic and one run swings recall 95-100% |
| `pnpm ig:ocr` | read the text off saved cover frames. Free, and the default does real work |
| `pnpm queued` | every prepared message, and what the safety gate held back |
| `pnpm ig:dispatch` | what the paced dispatcher would do, and why nothing has gone out |
| `pnpm ig:layout` | opens every page in a real browser and asserts geometry, assets and a query budget. Needs `DS_QUERY_COUNT=1` on the server and `DS_LAYOUT_TOKEN` set to a session cookie value |
| `pnpm worker:heartbeat` | is the watch running, and what has downtime cost |

---

## 6. Verified on a clean clone, 2026-08-17

```
git clone            336 files
pnpm install         ok — postinstall generated the SQLite client
cp .env.example .env
pnpm typecheck       clean
pnpm test            1,567 passing / 78 files
pnpm db:push         schema created
pnpm db:seed         3 senders · 3 targets · 7 routing pairs
```

What that run FOUND, and this document exists because of it: `.env.example` was missing
`SIGNUP_INVITE_CODE`, `SEND_ENABLED` and `MAX_TOTAL_SENDS`. The first locks a new operator out
of their own install with nothing on screen to say why. `tests/env-example.test.ts` is now
total over the environment schema so it cannot drift again.
