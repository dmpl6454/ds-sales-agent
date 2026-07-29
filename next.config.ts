import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  // The generated Prisma client and better-sqlite3 are native/server-only.
  // Keeping them external stops Next from trying to bundle them for the client.
  serverExternalPackages: ['@prisma/client', 'better-sqlite3', '@prisma/adapter-better-sqlite3'],
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
