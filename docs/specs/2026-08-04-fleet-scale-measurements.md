# Measured findings — 2026-08-04, before the scale plan

Everything here was measured against the live system, not inferred. These feed the plan and
several of them change it.

## 1. Paid-post volume per target — this sets the whole safety envelope

| target | posts/day | **paid posts/day** |
|---|---|---|
| `@viralbhayani` | 58 median, 75 peak | **11 median, 14 peak** |
| `@madovermarketing_mom` | ~3 | 1–3 median 1 |

Under uncapped rotation `@viralbhayani` would receive **11–14 DMs/day into one inbox**. With 63
senders each account sends **0.27/day** — trivially safe per account, dangerous per recipient.
That asymmetry is the single most important fact in this design: **rotation solves sender risk
and does nothing for recipient risk**, and recipient reports are what get accounts banned.

Resolved: per-recipient cap stays, no per-sender cap, throughput scales via target count.

## 2. The 63 channels are all real, and 61 are new

All 63 handles from `BollywoodTargetChannels.pdf` return HTTP 200 anonymously. 0 missing,
0 unknown. Combined reach **60,488,000 followers**.

- Already senders: `@bollywoodchronicle`, `@bollywoodsocietyy`
- **Also already TARGETS**: the same two. They were added as rehearsal targets. Going live as
  senders means those two target rows should be retired — otherwise they are simultaneously
  sender and recipient, and the "never message itself" rule is the only thing separating them.
- New senders to add: **61**

> A methodology note worth keeping. My first validation reported all 10 sampled handles as
> non-existent. The bug was mine: `handleExists` returns a plain string union
> (`'exists' | 'missing' | 'unknown'`), and I read `r.exists`, which is always `undefined`. The
> check **could only ever fail** — the tautology shape CLAUDE.md documents, reproduced in a
> throwaway script within an hour of writing about it. Re-run correctly: 63/63 exist.

## 3. Chrome profiles: 86% of a profile is disposable

Measured on the two real profiles:

| profile | size | note |
|---|---|---|
| `bollywoodsocietyy` | **91 MB** | logged in, lightly used |
| `tabishmukaddam1` | **604 MB** | has done every send |

Inside the 604 MB one:

```
421.4 MB  Default/Cache          ← disposable
 97.4 MB  Default/Code Cache     ← disposable
  1.6 MB  Default/GPUCache       ← disposable
   20 KB  Default/Cookies        ← THE DEVICE IDENTITY. mid, ig_did, datr.
    7 KB  Local State            ← irreplaceable
```

**Projection at 65 profiles:** 22 GB at the average, ~39 GB if they all trend to the heavy
end. Free disk is **32 GB**. So the fleet fills the disk without intervention.

**The fix is safe and large:** pruning `Cache`, `Code Cache` and `GPUCache` takes a profile from
604 MB to ~84 MB — 65 profiles becomes **~5.5 GB**. It must never touch `Cookies` or
`Local State`, which are 27 KB combined and hold the device identity the whole send design
depends on. Prune only with Chrome closed for that profile.

## 4. Slot duration: healthy is under 90s, but there are 6-hour runs

Measured across the last 15 finished runs:

```
healthy   24s · 26s · 39s · 42s · 81s        (status OK)
hung      3957s · 7574s · 11512s · 12782s · 14713s · 19230s · 22025s · 24674s   (PARTIAL)
```

**24,674 s = 6.85 hours.** Root cause: `src/detection/feed.ts` has retry with exponential
backoff but **no request timeout**. `src/detection/exists.ts` already uses
`AbortSignal.timeout(12_000)`; the feed fetch has nothing. Worst case per slot is
`targets × maxPages(6) × attempts(4)` = **216 unbounded requests**.

**And the slot lock makes this worse rather than better.** `SLOT_LOCK_STALE_MS` is 30 minutes,
with the comment *"a slot that has not finished in this long is presumed dead, not running"*.
That presumption is false here: a slot with no fetch timeout is **hung but alive**. So after 30
minutes a second slot claims the lock and runs concurrently with the first. At 4 accounts that
is survivable; at 65 accounts driving browsers, two concurrent runs could drive the same Chrome
profile twice at once.

This is the "freshness is not liveness" lesson from CLAUDE.md — already learned once for the
scheduler heartbeat, present again here in a different guard.

**Both fixes are prerequisites for the fleet, not nice-to-haves:**
1. `AbortSignal.timeout` on the feed fetch (bounds a slot).
2. A whole-slot deadline, and a lock that proves liveness rather than assuming it from age.

## 5. threadUrl is recorded on 1 of 7 delivered attempts

Not necessarily a bug — hand-sends may not capture it — but the thread URL is the only durable
proof a message landed. Worth confirming which paths record it before scaling delivery.

## 6. Current scale, for reference

4 senders · 9 targets · 31 pairs · 845 posts · 31 CAMPAIGN · 338 tests passing.

`OutreachPair` is one row per sender×target. At 65 senders × 60 targets that is **3,900 pairs**,
each carrying its own `cooldownDays`, `maxUnansweredTouches` and `bespokeBody`. The planner
currently performs ~7 awaits per pair per slot: **27,300 queries per slot**. That does not hold.

## 7. SQLite is fine at this scale — but it is in the WRONG journal mode

Measured: `journal_mode = delete`, `busy_timeout = 5000ms`, database **1.2 MB** (970 posts).

`delete` mode takes an **exclusive lock on the whole database for every write**, and readers and
writers block each other. Three processes already share that file — the Next.js dashboard, the
embedded scheduler, and any CLI script — and a slot driving a fleet adds far more writes. The
symptom will be intermittent `SQLITE_BUSY` after 5 seconds, which will look like random
unexplained failures rather than a lock problem.

**`journal_mode = WAL` is a one-line prerequisite** — one writer concurrent with many readers.

Size is emphatically not the issue and **Postgres is not a prerequisite for this work**:

| | now | projected |
|---|---|---|
| database size | 1.2 MB | ~50 MB/yr at ~120 posts/day |
| `OutreachPair` rows | 31 | **3,900** at 65×60 |
| planner queries per slot | ~220 | **~27,300** ← the real bottleneck |

The bottleneck is the planner's per-pair loop (~7 awaits × pairs), not the storage engine. That
reorders the work: **WAL + planner restructuring now; Postgres stays deferred** with the
hosting work where it belongs.

Indexes on the hot tables are reasonable already (`OutreachAttempt` on `pairId_sentAt`,
`status`, `sentAt`), but nothing indexes `OutreachAttempt` by target, which every rotation and
per-recipient-cap query will need.
