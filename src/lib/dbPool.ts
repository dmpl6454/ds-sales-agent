/**
 * ── HOW MANY POSTGRES CONNECTIONS ONE CLIENT MAY HOLD ─────────────────────────────────
 *
 * Its own module, and NOT part of `db.ts`, for the reason `paceClock.ts` is its own module:
 * `db.ts` constructs a real PrismaClient at import time, so anything that merely wants to
 * READ these numbers — a test, a script, a future health check — would open a database
 * connection just to ask. That is absurd in general and self-defeating here, where the
 * numbers exist because connections are the scarce thing. (Found by running it: the first
 * version of `tests/pool-bounds.test.ts` imported `db.ts`, built a client against whatever
 * `DATABASE_URL` happened to be set, and broke an unrelated test that owns its own temp
 * database. The suite named it; reading the diff would not have.)
 *
 * ── WHY THESE ARE SET AT ALL ──────────────────────────────────────────────────────────
 *
 * `PrismaPg` forwards its config straight to `new pg.Pool(config)`, whose defaults are
 * `max: 10, min: 0`. That is per POOL, and there is one pool per PrismaClient, and `db.ts`
 * caches the client on `globalThis` only OUTSIDE production — so a production Next build
 * holds one pool PER ROUTE BUNDLE. Eight bundles is eighty connections from one process,
 * against a server `max_connections` of 100 that six other pm2 apps also draw on.
 *
 * MEASURED 2026-08-22 on the live Linode: 98 of 100 slots in use, 83 of them held against
 * `ds_sales_agent` and 82 idle. The scheduler had been throwing at the TOP LEVEL on every
 * 15-minute pass since 14:15 IST — `detection pass threw`, `dispatcher tick threw`, `slot
 * threw`, all of them *"Too many database connections opened"*. The planner's last
 * successful run was 14:02 IST and **no draft was written for the next 158 minutes**, so the
 * fleet sat silent while every screen and the device agent's own log showed healthy,
 * truthful per-draft hold reasons — because those holds WERE real, and the missing half was
 * drafts that never came into existence. Nothing reported the starvation except the server's
 * error log.
 *
 * THE CULPRIT WAS NOT THE SERVER, and that is the part worth keeping. The tunnel forwards to
 * `localhost:5432`, which resolves to `::1` on the Linode, so every connection arriving from
 * a developer's Mac appears as `::1` — 82 of them, against 0 from the server's own
 * `127.0.0.1`. A `pnpm local` DEV dashboard started at 13:19 IST, a VIEWER that this project
 * documents as unable to send, had eaten the entire connection budget of the machine that
 * does the detecting and the drafting. Restarting the server changed nothing, which is what
 * proved it: **a control probe beat the obvious diagnosis again.**
 *
 * `max` is the load-bearing half. It bounds the worst case even when a connection is checked
 * out and never given back, which `idleTimeoutMillis` cannot reach. At 5, a twelve-bundle
 * build tops out near 60 rather than 120, and 5 concurrent statements already exceeds what a
 * ONE-CPU Postgres can run in parallel — so this costs no latency it did not already owe.
 * `idleTimeoutMillis` is stated explicitly rather than left to match today's pg default,
 * because a pool quietly declining to hand connections back is precisely what this cost us.
 *
 * DO NOT delete these to "let the pool size itself". The default is 10 per bundle and the
 * budget is shared with other applications on the box.
 */
export const POSTGRES_POOL_MAX = 5

/** How long an unused connection may sit in the pool before it is given back. */
export const POSTGRES_POOL_IDLE_MS = 10_000
