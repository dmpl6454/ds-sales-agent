import 'dotenv/config'
import { defineConfig, env } from 'prisma/config'

// Prisma 7 moved connection config out of schema.prisma.
// Note: the `adapter` option was REMOVED in v7 — migrations work with driver
// adapters automatically, so only the datasource URL is needed here.
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed.ts',
  },
  datasource: {
    url: env('DATABASE_URL'),
  },
})
