import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * THE MEMORY CAP BELONGS ON THE REAL PROCESS, AND THE CEILING MUST CLEAR THE WORKING SET.
 *
 * Two sizing defects were live on the 961 MB box on 9 Sept 2026 and neither could fail a
 * behavioural test, because both live in the deploy script:
 *
 *   - pm2 started the worker as `/usr/bin/pnpm worker`, so `--max-memory-restart` measured a
 *     0.6 MB wrapper and SIGINT never reached node (rule 15 in CLAUDE.md, and the blind spot
 *     that hid another team's API hang on the shared box);
 *   - the single-worker web ceiling was 350M against a measured 415-546 MB working set, so
 *     pm2 soft-reloaded the dashboard 57 times in a day, each time running two Next processes.
 *
 * A source grep is the shape this repo uses when the failure mode is a value somebody edits
 * back. Comments are stripped first so a rule mentioned in prose cannot satisfy it.
 */
const deploy = readFileSync(join(__dirname, '..', 'scripts', 'deploy.sh'), 'utf8')
const code = deploy
  .split('\n')
  .filter((l) => !l.trim().startsWith('#'))
  .join('\n')

describe('the detection worker is pm2-managed as the real node process', () => {
  const startLine = code.split('\n').find((l) => l.includes('pm2 start') && l.includes('ds-sales-worker'))

  it('starts src/worker/index.ts directly, under node, with the tsx loader and a ceiling', () => {
    expect(startLine).toBeDefined()
    expect(startLine).toContain('pm2 start src/worker/index.ts')
    expect(startLine).toContain('--interpreter node')
    expect(startLine).toContain('--max-memory-restart')
    expect(code).toMatch(/WORKER_NODE_ARGS="--import tsx /)
  })

  it('never puts the pnpm wrapper between pm2 and the worker', () => {
    expect(code).not.toMatch(/pm2 start (\/usr\/bin\/)?pnpm/)
    expect(code).not.toMatch(/pm2 start[^\n]* -- worker/)
    expect(code).not.toMatch(/NODE_OPTIONS=[^\n]*pm2 restart ds-sales-worker/)
  })

  it('rebuilds a worker whose live definition differs from the one this script wants', () => {
    expect(code).toMatch(/"\\\$HAVE_WORKER" == "\\\$WANT_WORKER"/)
    expect(code).toMatch(/pm2 delete ds-sales-worker/)
  })
})

describe('the web memory ceiling', () => {
  it('sits above the measured single-worker working set (415-546 MB RSS)', () => {
    const m = code.match(/WEB_MEM_DEFAULT=\\\$\(\( WEB_WORKERS == 1 \? (\d+) : (\d+) \)\)/)
    expect(m).not.toBeNull()
    expect(Number(m![1])).toBeGreaterThanOrEqual(550)
  })

  it('is applied when it CHANGES, not only when it is absent', () => {
    expect(code).toMatch(/"\\\$CURRENT_MEM" != "\\\$WEB_MAX_MEM_BYTES"/)
    expect(code).not.toMatch(/"\\\$CURRENT_MEM" == "0"/)
  })
})
