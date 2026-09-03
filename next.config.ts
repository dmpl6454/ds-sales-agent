import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  /**
   * ── THE BUILD OUTPUT DIRECTORY ALTERNATES ON THE SERVER (2026-09-03) ────────────
   *
   * `next start` reads its manifest and chunks from the dist dir for the life of the
   * process, so building INTO the directory being served replaces chunks underneath a live
   * server (the documented "never build while pm2 is serving" rule). The deploy used to
   * stop pm2, build for ~2 minutes, then start — and every 5xx the hosted dashboard served
   * today was one of those windows (Cloudflare 502s at 04:51Z and 07:31Z, a truncated
   * response at 09:17Z that Safari rendered as "This page couldn't load").
   *
   * `scripts/deploy.sh` now builds into the OTHER of `.next-a` / `.next-b` while the
   * current one keeps serving, then reloads the cluster workers with this variable pointing
   * at the new one. Unset (a laptop, `pnpm local`, the tests) it is plain `.next`.
   */
  distDir: process.env.NEXT_DIST_DIR || '.next',
  // Native or server-only packages. Bundling them fails: Prisma and better-sqlite3
  // load native bindings, and patchright ships a prebuilt core bundle with optional
  // requires that a bundler cannot resolve statically. External is not an
  // optimisation here — the build errors without it.
  serverExternalPackages: [
    '@prisma/client',
    'better-sqlite3',
    '@prisma/adapter-better-sqlite3',
    'patchright',
    'patchright-core',
  ],
  typedRoutes: true,
  experimental: {
    // Server Actions are how the dashboard confirms sends; keep bodies small.
    serverActions: { bodySizeLimit: '1mb' },
    // TypeScript 7 is the Go-based compiler; it does not expose the JS compiler
    // API Next.js normally calls. Shelling out to the tsc CLI gives the same
    // type checking (`pnpm typecheck` uses it too) without downgrading to TS 6.
    useTypeScriptCli: true,
  },
}

export default nextConfig
