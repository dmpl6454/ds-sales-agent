/**
 * deploy-worker-on-box.sh — the box-side worker deploy, driven in a fake box with pm2, pgrep,
 * renice and ionice stubbed to RECORD rather than act (the launcher tests' pattern).
 *
 * The script runs as root on the production server, so the cases that carry the weight are the
 * refusals: each must leave every file exactly as it was and call pm2 not at all.
 *
 * Mutations, each applied by hand and seen red (15 Oct 2026):
 *   - delete the SEND_ENABLED=false check            → "refuses on a Mac" goes red (files copied, pm2 called)
 *   - delete the lockfile `cmp`                      → "refuses a lockfile change" goes red
 *   - delete the schema `cmp` loop                   → "refuses a schema change" goes red
 *   - drop `grep -v '^src/generated/'`               → "keeps generated, env, node_modules" goes red
 *   - replace `pm2 restart ds-sales-worker` with `pm2 restart all` → "restarts only the worker" goes red
 *   - make `die` always print "Nothing on the box was changed." (the first version did) → "a failure
 *     after the copy names the rollback" goes red (applied by hand, saw red, restored, review 15 Oct)
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRIPT = join(__dirname, '..', 'scripts', 'deploy-worker-on-box.sh')
const SHA = 'a'.repeat(40)

let root: string
let box: string
let backups: string
let bin: string
let pm2Log: string
let tarball: string

function write(path: string, body: string) {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, body)
}

function makeCommit(opts: { lock?: string; schema?: string } = {}) {
  const top = join(root, 'commit', `ds-sales-agent-${SHA}`)
  write(join(top, 'package.json'), '{"name":"ds-sales-agent"}\n')
  write(join(top, 'pnpm-lock.yaml'), opts.lock ?? 'lock-v1\n')
  write(join(top, 'prisma', 'schema.prisma'), opts.schema ?? 'schema-v1\n')
  write(join(top, 'src', 'worker', 'index.ts'), 'export const NEW_WORKER = true\n')
  write(join(top, 'src', 'detection', 'graphFeed.ts'), 'export const graph = 1\n')
  write(join(top, 'scripts', 'deploy.sh'), '#!/bin/sh\n')
  write(join(top, '.env.example'), 'SEND_ENABLED=true\n')
  tarball = join(root, 'commit.tgz')
  execFileSync('tar', ['czf', tarball, '-C', join(root, 'commit'), `ds-sales-agent-${SHA}`])
}

function run(args: string[], extraEnv: Record<string, string> = {}) {
  return spawnSync('bash', [SCRIPT, ...args], {
    encoding: 'utf8',
    env: {
      // NODE_ENV is required by the project's ProcessEnv type; the script never reads it.
      NODE_ENV: 'test',
      PATH: `${bin}:/usr/bin:/bin`,
      HOME: root,
      DS_BOX_DIR: box,
      DS_BACKUP_DIR: backups,
      DS_TARBALL: tarball,
      DS_SKIP_WAIT: '1',
      ...extraEnv,
    },
  })
}

function pm2Calls(): string[] {
  return existsSync(pm2Log) ? readFileSync(pm2Log, 'utf8').trim().split('\n').filter(Boolean) : []
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dwob-'))
  box = join(root, 'opt', 'ds-sales-agent')
  backups = join(root, 'opt', 'ds-backups')
  bin = join(root, 'bin')
  pm2Log = join(root, 'pm2.log')
  mkdirSync(bin, { recursive: true })
  // pm2 records every call; `jlist` answers like the real one for the status line.
  write(
    join(bin, 'pm2'),
    `#!/bin/sh\necho "$*" >> "${pm2Log}"\nif [ "$1" = restart ] && [ -n "$PM2_FAIL_RESTART" ]; then exit 1; fi\nif [ "$1" = jlist ]; then echo '[{"name":"ds-sales-worker","pm2_env":{"status":"online","restart_time":3}}]'; fi\n`,
  )
  for (const noop of ['pgrep', 'renice', 'ionice']) write(join(bin, noop), '#!/bin/sh\nexit 0\n')
  for (const f of readdirSync(bin)) chmodSync(join(bin, f), 0o755)

  // The box as deploy.sh leaves it.
  write(join(box, '.env'), 'DATABASE_URL="postgresql://x"\nSEND_ENABLED=false\nMETA_GRAPH_TOKEN=secret\n')
  write(join(box, 'pnpm-lock.yaml'), 'lock-v1\n')
  write(join(box, 'prisma', 'schema.prisma'), 'schema-v1\n')
  write(join(box, 'src', 'worker', 'index.ts'), 'export const OLD_WORKER = true\n')
  write(join(box, 'src', 'old', 'removed-from-repo.ts'), 'stale\n')
  write(join(box, 'src', 'generated', 'client.ts'), 'generated on the box\n')
  write(join(box, 'node_modules', 'pkg', 'index.js'), 'module\n')
  write(join(box, '.next-a', 'BUILD_ID'), 'served\n')
  makeCommit()
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('deploy-worker-on-box.sh refuses, and a refusal changes nothing', () => {
  it('without a full 40-character commit id', () => {
    const r = run(['main'])
    expect(r.status).not.toBe(0)
    expect(r.stderr).toMatch(/40-character commit id/)
    expect(pm2Calls()).toEqual([])
    expect(readFileSync(join(box, 'src', 'worker', 'index.ts'), 'utf8')).toContain('OLD_WORKER')
  })

  it('on a machine whose .env does not say SEND_ENABLED=false (a Mac)', () => {
    write(join(box, '.env'), 'SEND_ENABLED=true\n')
    const r = run([SHA])
    expect(r.status).not.toBe(0)
    expect(r.stderr).toMatch(/SEND_ENABLED=false/)
    expect(pm2Calls()).toEqual([])
    expect(readFileSync(join(box, 'src', 'worker', 'index.ts'), 'utf8')).toContain('OLD_WORKER')
  })

  it('when the dependency lockfile differs (installing would break the running dashboard)', () => {
    makeCommit({ lock: 'lock-v2\n' })
    const r = run([SHA])
    expect(r.status).not.toBe(0)
    expect(r.stderr).toMatch(/lockfile differs/)
    expect(r.stderr).toMatch(/Nothing on the box was changed/) // true here: the copy never started
    expect(pm2Calls()).toEqual([])
    expect(existsSync(join(box, 'src', 'detection', 'graphFeed.ts'))).toBe(false)
    expect(existsSync(join(box, 'src', 'old', 'removed-from-repo.ts'))).toBe(true)
  })

  it('when the Prisma schema differs (the client would need regenerating)', () => {
    makeCommit({ schema: 'schema-v2\n' })
    const r = run([SHA])
    expect(r.status).not.toBe(0)
    expect(r.stderr).toMatch(/schema\.prisma differs/)
    expect(pm2Calls()).toEqual([])
    expect(readFileSync(join(box, 'src', 'worker', 'index.ts'), 'utf8')).toContain('OLD_WORKER')
  })
})

describe('deploy-worker-on-box.sh deploys the worker and only the worker', () => {
  it('copies the commit, removes stale source, stamps the version', () => {
    const r = run([SHA])
    expect(r.status, r.stderr).toBe(0)
    expect(readFileSync(join(box, 'src', 'worker', 'index.ts'), 'utf8')).toContain('NEW_WORKER')
    expect(existsSync(join(box, 'src', 'detection', 'graphFeed.ts'))).toBe(true)
    expect(existsSync(join(box, 'src', 'old', 'removed-from-repo.ts'))).toBe(false)
    expect(readFileSync(join(box, '.version'), 'utf8').trim()).toBe(SHA.slice(0, 7))
    expect(r.stdout).toMatch(/Rollback:\s+tar xzf .*source-.*\.tgz/)
  })

  it('keeps the box-only files: .env, the generated client, node_modules, the served build', () => {
    run([SHA])
    expect(readFileSync(join(box, '.env'), 'utf8')).toContain('META_GRAPH_TOKEN=secret')
    expect(readFileSync(join(box, '.env'), 'utf8')).toContain('SEND_ENABLED=false')
    expect(existsSync(join(box, 'src', 'generated', 'client.ts'))).toBe(true)
    expect(existsSync(join(box, 'node_modules', 'pkg', 'index.js'))).toBe(true)
    expect(existsSync(join(box, '.next-a', 'BUILD_ID'))).toBe(true)
  })

  it('backs up the previous source, without the .env secrets', () => {
    run([SHA])
    const files = readdirSync(backups)
    expect(files).toHaveLength(1)
    const listing = execFileSync('tar', ['tzf', join(backups, files[0]!)], { encoding: 'utf8' })
    expect(listing).toContain('./src/worker/index.ts')
    expect(listing).not.toMatch(/\.env(\n|$)/)
    expect(listing).not.toContain('node_modules')
  })

  it('a failure after the copy names the rollback, and never claims nothing changed', () => {
    const r = run([SHA], { PM2_FAIL_RESTART: '1' })
    expect(r.status).not.toBe(0)
    expect(readFileSync(join(box, 'src', 'worker', 'index.ts'), 'utf8')).toContain('NEW_WORKER') // the tree did change
    expect(r.stderr).toMatch(/pm2 could not restart ds-sales-worker/)
    expect(r.stderr).toMatch(/Roll back with:\s+tar xzf .*source-.*\.tgz -C .* && pm2 restart ds-sales-worker --update-env/)
    expect(r.stderr).not.toMatch(/Nothing on the box was changed/)
  })

  it('restarts only ds-sales-worker by name, and never a global pm2 command', () => {
    run([SHA])
    const calls = pm2Calls()
    expect(calls).toContain('restart ds-sales-worker --update-env')
    for (const c of calls) {
      expect(c).not.toMatch(/\ball\b/)
      expect(c).not.toMatch(/ds-sales-agent/) // the dashboard is left serving its build
      expect(c.split(' ')[0]).toMatch(/^(restart|save|jlist)$/)
    }
  })
})
