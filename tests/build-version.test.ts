import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readBuildVersionAt } from '../src/lib/buildVersion'

/**
 * Which build am I? The rungs, in order: the sha baked at build time, the `.version` stamp the
 * installer / deploy writes, git, then 'unknown'. Each rung exists for a machine that lacks the
 * ones above it (2026-09-08): the server has no git, an installed Mac has no git, and a bundle
 * built elsewhere cannot trust the serving machine's disk.
 */
describe('buildVersion precedence', () => {
  it('the baked sha wins over everything on disk', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bv-'))
    writeFileSync(join(dir, '.version'), 'fromfile\n')
    expect(readBuildVersionAt(dir, ' baked1 ')).toEqual({ version: 'baked1', source: 'baked' })
  })
  it('the .version stamp answers where nothing is baked', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bv-'))
    writeFileSync(join(dir, '.version'), 'abc1234\n')
    expect(readBuildVersionAt(dir, undefined)).toEqual({ version: 'abc1234', source: 'stamp' })
    expect(readBuildVersionAt(dir, '')).toEqual({ version: 'abc1234', source: 'stamp' })
  })
  it('no stamp, no git → unknown, never a guess', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bv-'))
    expect(readBuildVersionAt(dir, undefined)).toEqual({ version: 'unknown', source: 'unknown' })
  })
  it('the presence heartbeat carries the version and /senders reads it', () => {
    const agent = readFileSync('src/agent/index.ts', 'utf8')
    expect(agent).toMatch(/version: buildVersionInfo\(\)\.version/)
    expect(agent).toMatch(/versionSource: buildVersionInfo\(\)\.source/)
    const page = readFileSync('src/app/senders/page.tsx', 'utf8')
    expect(page).toMatch(/readInstallerBuild\(\)/)
    expect(page).toMatch(/d\.version/)
  })
  it('a development checkout is never told to re-run the installer', () => {
    const page = readFileSync('src/app/senders/page.tsx', 'utf8')
    expect(page).toMatch(/b\.source === 'git'/)
  })
  it('the image, the installer and the launcher agree on the stamp', () => {
    expect(readFileSync('scripts/build-dmg.sh', 'utf8')).toMatch(/Contents\/Resources\/VERSION/)
    expect(readFileSync('scripts/dmg/install.sh', 'utf8')).toMatch(/cp "\$RES\/VERSION" "\$DEST\/\.version"/)
    expect(readFileSync('scripts/dmg/launcher.sh', 'utf8')).toMatch(/\$RES\/VERSION/)
  })
})
