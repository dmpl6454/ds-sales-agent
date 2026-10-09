import { describe, it, expect, afterAll } from 'vitest'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

/**
 * WHICH BUILD IS THE DASHBOARD SERVING? (audit H7, 2026-10-09)
 *
 * `deploy.sh` used to answer from the `.active-dist` marker, which it wrote BEFORE the reload
 * and the health check — and which the documented rollback never rewrote. After a rollback or a
 * failed check the marker named the directory NOT being served, so the next deploy unpacked over
 * and then `rm -rf`'d the live build. `scripts/active-dist.sh` asks pm2 instead. These run the
 * real script against a fake `pm2` on PATH, in both directions, and pin the deploy's ORDER:
 * the marker after the 200, `pm2 save` last.
 */

const SCRIPT = resolve('scripts/active-dist.sh')
const NODE_DIR = dirname(process.execPath)
const roots: string[] = []

afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})

function run(opts: { jlist?: string | null; marker?: string; dirs?: string[] }): string {
  const root = mkdtempSync(join(tmpdir(), 'ds-active-dist-'))
  roots.push(root)
  const app = join(root, 'app')
  mkdirSync(app)
  for (const d of opts.dirs ?? []) mkdirSync(join(app, d))
  if (opts.marker !== undefined) writeFileSync(join(app, '.active-dist'), opts.marker + '\n')
  const bin = join(root, 'bin')
  mkdirSync(bin)
  if (opts.jlist !== null && opts.jlist !== undefined) {
    writeFileSync(join(root, 'jlist.json'), opts.jlist)
    writeFileSync(join(bin, 'pm2'), `#!/bin/sh\n[ "$1" = jlist ] && cat '${join(root, 'jlist.json')}'\n`)
    chmodSync(join(bin, 'pm2'), 0o755)
  }
  const r = spawnSync('bash', [SCRIPT, app], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${NODE_DIR}:/usr/bin:/bin` },
  })
  expect(r.status).toBe(0)
  return r.stdout.trim()
}

const proc = (env: Record<string, unknown>) =>
  JSON.stringify([{ name: 'ds-sales-worker', pm2_env: {} }, { name: 'ds-sales-agent', pm2_env: env }])

describe('scripts/active-dist.sh', () => {
  it('believes pm2 over a stale marker — the rollback case that deleted the live build', () => {
    expect(run({ jlist: proc({ NEXT_DIST_DIR: '.next-b' }), marker: '.next-a', dirs: ['.next-a', '.next-b'] })).toBe('.next-b')
  })

  it('reads the env pm2 keeps under pm2_env.env as well', () => {
    expect(run({ jlist: proc({ env: { NEXT_DIST_DIR: '.next-a' } }), marker: '.next-b', dirs: ['.next-a', '.next-b'] })).toBe('.next-a')
  })

  it('falls back to the marker when pm2 names a directory that does not exist', () => {
    expect(run({ jlist: proc({ NEXT_DIST_DIR: '.next-b' }), marker: '.next-a', dirs: ['.next-a'] })).toBe('.next-a')
  })

  it('falls back to the marker when the web process is absent, pm2 answers garbage, or pm2 is not installed', () => {
    expect(run({ jlist: JSON.stringify([{ name: 'ds-sales-worker', pm2_env: {} }]), marker: '.next-a', dirs: ['.next-a'] })).toBe('.next-a')
    expect(run({ jlist: 'not json at all', marker: '.next-b', dirs: ['.next-b'] })).toBe('.next-b')
    expect(run({ jlist: null, marker: '.next-a' })).toBe('.next-a')
  })

  it('never hands deploy.sh a path outside the three dist names — it ends in rm -rf', () => {
    expect(run({ jlist: proc({ NEXT_DIST_DIR: '..' }), marker: '.next-a', dirs: ['.next-a'] })).toBe('.next-a')
    expect(run({ jlist: null, marker: '../../etc' })).toBe('.next')
    expect(run({ jlist: null })).toBe('.next')
  })
})

describe('deploy.sh uses it, in the right order', () => {
  const deploy = readFileSync('scripts/deploy.sh', 'utf8')
  const code = deploy
    .split('\n')
    .filter((l) => !l.trim().startsWith('#'))
    .join('\n')

  it('both halves ask the script, and neither reads the marker as the answer', () => {
    expect(code).toMatch(/REMOTE_ACTIVE="\$\(ssh "\$HOST" "bash '\$DIR\/scripts\/active-dist\.sh'/)
    expect(code).toMatch(/ACTIVE=\\\$\(bash scripts\/active-dist\.sh "\$DIR"\)/)
    expect(code).not.toMatch(/ACTIVE=\\\$\(cat \.active-dist/)
  })

  it('writes the marker only after the 200, and before the old build is removed', () => {
    const ok = code.indexOf('"\\$CODE" == "200"')
    const marker = code.indexOf('> .active-dist')
    const removeOld = code.indexOf('rm -rf "\\$ACTIVE"')
    expect(ok).toBeGreaterThan(-1)
    expect(code.split('> .active-dist').length - 1).toBe(1)
    expect(marker).toBeGreaterThan(ok)
    expect(removeOld).toBeGreaterThan(marker)
  })

  it('saves the pm2 dump last, after the new build answered and the old one is gone', () => {
    const save = code.indexOf('pm2 save')
    expect(save).toBeGreaterThan(code.indexOf('rm -rf "\\$ACTIVE"'))
    expect(save).toBeLessThan(code.lastIndexOf('REMOTE'))
  })

  it('refuses to unpack a prebuilt dist over the directory being served', () => {
    expect(code).toMatch(/if \[\[ "\\\$TARGET" == "\\\$ACTIVE" \]\]; then/)
  })
})
