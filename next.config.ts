import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
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
