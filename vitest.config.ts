import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Detection and governor tests are pure functions — no DB, no network.
    // Anything needing the DB belongs in an explicitly-named integration test.
    globals: false,

    /**
     * THE SUITE IS SQLITE-SHAPED, AND MUST NOT INHERIT A REAL DATABASE URL.
     *
     * The few tests that touch a database build a TEMPORARY SQLite file with
     * `better-sqlite3` and point the real client at it — deliberately, because the Phase 2
     * reservation bug was found by running the real Prisma client and NOT by a unit test
     * that mirrored the implementation's arithmetic.
     *
     * That only works if the generated client is the SQLite one, so `pnpm test` runs
     * `prisma generate` first. And it only works if `.env`'s `DATABASE_URL` does not leak
     * in: once this machine became a DEVICE pointed at the server's Postgres, every test
     * that had not overridden the variable picked the pg adapter against a sqlite client
     * and died on the mismatch.
     *
     * A default here is also the safer direction on its own terms: a test run must never
     * be one forgotten override away from writing to a production database.
     */
    env: {
      DATABASE_URL: 'file:./prisma/test-default.db',
    },
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
})
