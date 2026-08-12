import Database from 'better-sqlite3'
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3'
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '@/generated/prisma/client'
import { env } from './env'

/**
 * Prisma 7 requires a driver adapter — there is no built-in engine any more.
 *
 * The singleton guard matters in Next dev: hot reload re-evaluates modules, and
 * without it every edit opens another SQLite handle until the process runs out.
 */

/**
 * How long a write waits for the lock before throwing SQLITE_BUSY.
 *
 * Was 5000 (better-sqlite3's default) and is now 15000, because the thing a write can
 * be waiting behind is a SEND: `deliverWaiting` holds no transaction across the browser
 * work, but a slot, the dashboard and a CLI script all share this one file, and 40
 * seconds of browser driving overlaps whatever else is happening. Fifteen seconds is
 * chosen against the ~40s a send takes rather than against a query.
 */
const BUSY_TIMEOUT_MS = 15_000

/** "file:./prisma/dev.db" -> "./prisma/dev.db". Prisma's URL form, better-sqlite3's path form. */
function sqlitePath(url: string): string {
  return url.startsWith('file:') ? url.slice('file:'.length) : url
}

/**
 * The journal mode this database MUST be in, and why it is not WAL.
 *
 * ── WAL WAS TRIED, AND MEASURED, AND REVERTED ─────────────────────────────
 *
 * Phase 0 switched this file to `journal_mode = WAL` to reduce `SQLITE_BUSY`, on the
 * reasoning that a contended write could roll back the transaction recording a DELIVERED
 * message and leave the recipient holding a DM our records said we never sent.
 *
 * WAL did fix that contention. It also broke something worse, and it took a page that
 * would not load to find it. MEASURED 2026-08-04, reproducibly, and confirmed against a
 * falsifiable prediction:
 *
 *   A long-lived process pins a WAL read snapshot at its FIRST query and never releases
 *   it. Writes made by ANOTHER process after that moment are invisible to it until it
 *   restarts.
 *
 * The experiment: restart the dashboard, then make external writes and read them back.
 * Write #1 was visible; #2, #3, #4, #5 were not. Restart again and make three writes
 * BEFORE the first query — all three visible, and the next one invisible. It reproduced
 * identically through the plain `sqlite3` CLI, so it is not this codebase's doing; WAL
 * simply exposes it, because a rollback-journal reader takes a fresh shared lock per read
 * and therefore always sees the latest commit.
 *
 * ── WHY THAT IS THE WORSE FAILURE ─────────────────────────────────────────
 *
 * THREE PROCESSES SHARE THIS FILE BY DESIGN — the dashboard, the scheduler embedded in
 * it, and any CLI script. Under WAL:
 *
 *   - the dashboard never sees what `pnpm worker` detected, drafted or sent;
 *   - the worker never sees a persona edited, autopilot switched off, or an account
 *     marked CHALLENGED from the dashboard.
 *
 * That second one is a SAFETY guard reading stale data and not knowing it — including
 * the Phase 0 fix that re-reads a sender's live status immediately before driving its
 * browser, which is precisely the check that must never be stale. A guard that reads a
 * frozen snapshot is the "guard nobody can trigger" failure this project keeps finding,
 * arriving through the storage engine instead of through the code.
 *
 * Between "a write may contend and retry" and "a guard silently reads the past", the
 * second is far more dangerous. So: rollback journal, and the double-send risk is
 * addressed where it actually belongs — `recordDelivered` commits the SENT row ALONE and
 * retries it, and never returns an attempt to READY when delivery could not be ruled out.
 * WAL was the belt; that is the braces, and the braces are what hold.
 *
 * The symptom that led here is worth recording too: under WAL the server began returning
 * `SQLITE_CORRUPT: database disk image is malformed` on ordinary reads, while
 * `integrity_check`, `quick_check` and `foreign_key_check` on the file all came back
 * clean with every row present. Corruption reported by one connection against a healthy
 * file means the connection's view, not the data.
 *
 * IF WAL IS EVER RECONSIDERED: it is only safe once every long-lived process is proven to
 * see another process's writes. Test that first, with the experiment above.
 */
const REQUIRED_JOURNAL_MODE = 'delete'

/**
 * Put the database file into the journal mode above, if it is not already.
 *
 * READ FIRST, WRITE ONLY IF NEEDED. The first version wrote the pragma AND ran `ANALYZE`
 * unconditionally on this short-lived connection at EVERY process start — every CLI
 * script, every worker, every dashboard boot. On a WAL database that is actively
 * hostile: the closing connection can checkpoint and truncate the `-wal` file underneath
 * another process's reader mid-query. Now, on a database already in the right mode, this
 * opens, reads one pragma, and closes, writing nothing.
 */
function prepareDatabaseFile(url: string): void {
  const db = new Database(sqlitePath(url))
  try {
    const current = db.pragma('journal_mode', { simple: true })
    if (current !== REQUIRED_JOURNAL_MODE) {
      const mode = db.pragma(`journal_mode = ${REQUIRED_JOURNAL_MODE}`, { simple: true })
      if (mode !== REQUIRED_JOURNAL_MODE) {
        console.warn(
          `[db] journal_mode is "${String(mode)}", expected "${REQUIRED_JOURNAL_MODE}" — ` +
            `processes may not see each other's writes`,
        )
      }
    }
  } finally {
    db.close()
  }
}

/**
 * Refresh the query planner's statistics. NOT run at startup.
 *
 * It used to be, and that was the mistake above: `ANALYZE` writes `sqlite_stat1` on every
 * process start, so a CLI script was writing to the database purely to boot. The
 * statistics matter — the planner is going from 31 `OutreachPair` rows to a few thousand,
 * and stale statistics are how a query that was instant starts doing full scans with
 * nothing in the code having changed — but they are a maintenance task, not a
 * per-process one. Run it deliberately, after a bulk import or a migration.
 */
export async function refreshStatistics(): Promise<void> {
  await prisma.$executeRawUnsafe('ANALYZE')
}

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient }

/**
 * WHICH DATABASE IS THIS? Decided by the URL, and by nothing else.
 *
 * Added 2026-08-08 when the app stopped being one process on one laptop. The server runs
 * Postgres (several processes across two hosts genuinely share it); a laptop keeps SQLite,
 * which is simpler and has no service to run. One codebase, two providers, and the URL is
 * the only switch — a separate `DB_PROVIDER` variable could disagree with the URL, and
 * two sources of truth for "where is the data" is how a migration writes to the wrong one.
 *
 * PURE and exported so the same answer is available to scripts that must not construct a
 * client just to ask.
 */
export function isPostgresUrl(url: string): boolean {
  return url.startsWith('postgres://') || url.startsWith('postgresql://')
}

function createClient(): PrismaClient {
  /**
   * ── POSTGRES: THE WAL PROBLEM DOES NOT EXIST HERE ─────────────────────────
   *
   * Everything in the docblock above about `journal_mode = delete` is about SQLITE. The
   * failure it describes — a long-lived process pinning a read snapshot at its first query
   * and never seeing another process's writes — is a WAL-mode SQLite behaviour, and it is
   * precisely why this project reverted WAL after measuring it.
   *
   * Postgres does not have that failure. MVCC snapshots are per TRANSACTION, not per
   * connection, at the default READ COMMITTED isolation, so each statement sees the latest
   * commit. That is what makes several hosts sharing one database safe at all, and it is
   * the reason the move is an improvement rather than a workaround.
   *
   * DO NOT set a session-level `REPEATABLE READ` or `SERIALIZABLE` isolation here without
   * re-reading that docblock. It would reintroduce exactly the frozen-snapshot behaviour —
   * a guard reading the past — through a different door.
   */
  if (isPostgresUrl(env.DATABASE_URL)) {
    const adapter = new PrismaPg({ connectionString: env.DATABASE_URL })
    return new PrismaClient({
      adapter,
      log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
    })
  }

  prepareDatabaseFile(env.DATABASE_URL)
  const adapter = new PrismaBetterSqlite3({
    url: env.DATABASE_URL,
    // Per-CONNECTION, unlike journal_mode, so it has to be set here rather than once on
    // the file. This is the adapter's own connection — the one every query runs on.
    timeout: BUSY_TIMEOUT_MS,
  })
  return new PrismaClient({
    adapter,
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  })
}

export const prisma: PrismaClient = globalForPrisma.prisma ?? createClient()

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma
