import type { NextConfig } from 'next'
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'


// ── THE BUILD KNOWS ITS OWN COMMIT; THE SERVER MAY NOT (2026-09-08) ─────────
// The web tier is built on the maintainer's Mac and shipped as a directory (the Linode cannot
// build it: OOM-killed three times), so a `git rev-parse` at RUNTIME on the server would name
// nothing — there is no git there. The commit is read here, at build time, and baked into the
// bundle as DS_BUILD_SHA; `src/lib/buildVersion.ts` reads it first. Never a stale constant:
// falls back to a `.version` stamp, then 'unknown'.
function buildSha(): string {
  try {
    const v = readFileSync('.version', 'utf8').trim()
    if (v) return v
  } catch {
    /* no stamp */
  }
  try {
    return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || 'unknown'
  } catch {
    return 'unknown'
  }
}

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
  env: { DS_BUILD_SHA: buildSha() },
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
  // Turbopack walks upward for lockfiles to guess the workspace root, and on this
  // machine it finds one two directories up (in the Windows user profile) before
  // reaching this project's own pnpm-workspace.yaml — so it silently roots itself
  // there instead. Routing then resolves against the wrong tree: middleware still
  // runs (it needs no file resolution), but every app page 404s, including ones
  // that exist and compile fine. Pin the root explicitly, as Next's own warning
  // instructs, rather than guessing.
  turbopack: {
    root: process.cwd(),
  },
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
