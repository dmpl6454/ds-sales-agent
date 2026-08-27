/**
 * The always-on local dashboard process — see scripts/install-dashboard.sh for the design.
 *
 * ── NODE, NOT BASH, AND THAT IS MEASURED RATHER THAN STYLISTIC ──────────────
 *
 * This repo lives on the Desktop, which macOS treats as a privacy-protected folder, and
 * TCC treats EVERY binary a launchd job spawns as its own privacy client. On this Mac the
 * only chain with a Desktop grant is the one the watch job has exercised for weeks —
 * caffeinate → pnpm → node. A dashboard job that reached the repo through /bin/bash was
 * refused outright ("Operation not permitted", exit 126) on install day, in BOTH the
 * bash-first and caffeinate-first arrangements. So every file this runner touches is
 * touched by node.
 *
 * The same constraint decides two shapes below:
 *
 *   - `next` is spawned as `process.execPath <script>`, never via the `.bin` shim —
 *     the shim's shebang would put /usr/bin/env and a shell back in the chain.
 *   - a Prisma-client mismatch REFUSES rather than regenerates: `prisma generate`
 *     spawns engine binaries that are their own TCC clients, and a mismatched client
 *     means a `pnpm test` is mid-run anyway — its own finally-step restores the client,
 *     and launchd's ThrottleInterval paces our retries until it does.
 */
import { existsSync, readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { connect } from 'node:net'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
const PORT = 3100

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function databaseUrl(): string {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL
  try {
    const env = readFileSync(join(repo, '.env'), 'utf8')
    const line = env.split('\n').find((l) => l.startsWith('DATABASE_URL='))
    return line ? line.slice('DATABASE_URL='.length).replace(/"/g, '').trim() : ''
  } catch {
    return ''
  }
}

/** True when something already answers on the port — waited for, never fought over. */
function portBusy(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = connect({ port, host: '127.0.0.1' })
    sock.once('connect', () => {
      sock.destroy()
      resolve(true)
    })
    sock.once('error', () => resolve(false))
  })
}

async function refuse(message: string): Promise<never> {
  console.error(message)
  // Exit rather than spin: launchd's ThrottleInterval paces the retries, and
  // `install-dashboard.sh status` points a person at this log.
  await sleep(60_000)
  process.exit(1)
}

async function main() {
  const url = databaseUrl()
  const wantPostgres = url.startsWith('postgres://') || url.startsWith('postgresql://')
  const marker = readFileSync(join(repo, 'src/generated/prisma/internal/class.ts'), 'utf8')
  const clientIsPostgres = marker.includes('"activeProvider": "postgresql"')
  if (wantPostgres !== clientIsPostgres) {
    await refuse(
      `the generated Prisma client is ${clientIsPostgres ? 'postgresql' : 'sqlite'} but DATABASE_URL wants ` +
        `${wantPostgres ? 'postgresql' : 'sqlite'} — a test run probably holds the client; ` +
        `bash scripts/prisma-client-for-env.sh restores it (pnpm test does so itself when it finishes)`,
    )
  }

  if (!existsSync(join(repo, '.next', 'BUILD_ID'))) {
    await refuse('no production build at .next/ — run: pnpm build && bash scripts/install-dashboard.sh restart')
  }

  // A hand-run `pnpm local` (dev) owns :3100 legitimately. A KeepAlive job that exited on
  // a busy port would steal the port back the moment the person stopped their dev server.
  while (await portBusy(PORT)) {
    console.log(`port ${PORT} is busy (probably a hand-run dashboard) — waiting`)
    await sleep(30_000)
  }

  const child = spawn(
    process.execPath,
    [join(repo, 'node_modules', 'next', 'dist', 'bin', 'next'), 'start', '-H', '127.0.0.1', '-p', String(PORT)],
    {
      cwd: repo,
      stdio: 'inherit',
      env: {
        ...process.env,
        // Forced here, not merely inherited from the plist: a viewer must never become a
        // second detector (the lesson recorded in scripts/local.sh), and a server that
        // cannot be measured by `pnpm ig:layout` is a server nobody measures.
        EMBEDDED_SCHEDULER: 'false',
        DS_QUERY_COUNT: process.env.DS_QUERY_COUNT ?? '1',
      },
    },
  )
  process.on('SIGTERM', () => child.kill('SIGTERM'))
  process.on('SIGINT', () => child.kill('SIGINT'))
  child.on('exit', (code) => process.exit(code ?? 1))
}

main().catch(async (e) => {
  console.error(e)
  await sleep(60_000)
  process.exit(1)
})
