import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

/**
 * NO SCREEN READS THE ENV-FLOORED SWITCH, AND NO ENFORCER READS THE UN-FLOORED ONE — audit H8.
 *
 * `settings.autopilotEnabled` is `env.AUTOPILOT_ENABLED && row`: the ENFORCEMENT value, and false
 * on the hosted Linode by design. `settings.autopilotFleetWide` is the raw row: the DISPLAY value.
 * The hosted queue read the first and said "Autopilot is off" under a switch card reading the
 * second and saying ON. The two directions fail differently and both are pinned here:
 *
 *   a screen reading the floored value  → the hosted page contradicts itself (H8 itself);
 *   an enforcer reading the raw row     → a floored host ARMS ITSELF and sends unattended — the
 *                                          dangerous direction, which no behavioural test can catch
 *                                          for a call site nobody has written yet.
 *
 * And the gate's witness (`QueueWitness`): `recheckBeforeSend` asks THIS disk unless told
 * otherwise, and only the queue's display may tell it otherwise. A Send button trusting another
 * Mac's heartbeat about a profile would open a login form on a Mac without it and write
 * `sessionInvalidAt` on a live session — so no enforcement caller may pass a third argument, and
 * `predictResendForQueue` may be imported by the queue's view model alone.
 *
 * SOURCE GREPS, because the failure mode is a line somebody writes later. Files are DISCOVERED, not
 * listed (a hand-kept list is how `visible-channels.test.ts` once checked one file of six), the
 * allowlists are EXACT FILES rather than `src/app/**` (which holds server actions and API routes),
 * and the strip is checked for swallowing code — a block-comment strip treats `/*` inside a string
 * (a glob like 'src/** /*.ts') as a comment start and eats real code up to the next `*\/`, which
 * is the permissive direction for a guard whose whole job is to see it.
 */

const repo = join(__dirname, '..')
const rel = (p: string) => relative(repo, p).split(sep).join('/')

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) return rel(p) === 'src/generated' ? [] : walk(p)
    return /\.(ts|tsx)$/.test(name) ? [p] : []
  })
}

/** Comments out, newlines kept so a failure names a real line. `://` survives (URLs). */
const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/(^|[^:])\/\/.*$/gm, '$1')

const files = walk(join(repo, 'src')).map((p) => ({ path: rel(p), code: strip(readFileSync(p, 'utf8')) }))
const inFile = (path: string) => files.find((f) => f.path === path)!.code
const hits = (re: RegExp) =>
  files.flatMap((f) =>
    f.code
      .split('\n')
      .flatMap((line, i) => (re.test(line) ? [`${f.path}:${i + 1}: ${line.trim()}`] : [])),
  )

describe('the walk can see what it is looking for', () => {
  it('found the source tree, and the strip did not swallow code', () => {
    expect(files.length).toBeGreaterThan(100)
    expect(files.map((f) => f.path)).toContain('src/app/view-model/messages-page.ts')
    expect(inFile('src/app/view-model/messages-page.ts')).toMatch(/computeMessagesPage/)
    expect(inFile('src/outreach/gate.ts')).toMatch(/export async function predictResendForQueue/)
  })
})

describe('no screen reads the env-floored switch', () => {
  /**
   * Anywhere under src/app, after deleting the two tokens that NAME the setting rather than read
   * it — the key `setAutopilot` writes and the audit subject. That catches
   * `settings.autopilotEnabled`, `(await getSettings()).autopilotEnabled` and
   * `const { autopilotEnabled } = …` alike.
   *
   * ALLOWLIST of non-display reads under src/app: none. A future entry must name its file and why.
   */
  const ALLOWED_READS: Record<string, string> = {}

  it('no `autopilotEnabled` read remains under src/app', () => {
    /* Non-vacuity: the write site exists, so the token deletion below is doing real work. */
    expect(inFile('src/app/actions.ts')).toMatch(/SETTING_KEYS\.autopilotEnabled/)
    const found = files
      .filter((f) => f.path.startsWith('src/app/') && !(f.path in ALLOWED_READS))
      .flatMap((f) =>
        f.code
          .replace(/SETTING_KEYS\.autopilotEnabled/g, '')
          .replace(/'Setting:autopilotEnabled'/g, '')
          .split('\n')
          .flatMap((line, i) => (/\bautopilotEnabled\b/.test(line) ? [`${f.path}:${i + 1}: ${line.trim()}`] : [])),
      )
    expect(found, 'a screen is reading the ENV-FLOORED switch — false on the hosted Linode by design').toEqual([])
  })

  it('`env.AUTOPILOT_ENABLED` appears under src/app once — the switch tooltip, a fact about THIS machine', () => {
    const found = hits(/env\.AUTOPILOT_ENABLED/).filter((h) => h.startsWith('src/app/'))
    expect(found).toHaveLength(1)
    expect(found[0]).toMatch(/^src\/app\/view-model\.ts:\d+: allowedByEnv: env\.AUTOPILOT_ENABLED,/)
  })
})

describe('no enforcer reads the un-floored switch', () => {
  /**
   * EXACT files. The raw row is a DISPLAY value: read in settings.ts, rendered from view-model.ts.
   * Anywhere else — an action that sends, an API route, the dispatcher, the agent — would let a
   * host whose `.env` forbids unattended sending arm itself from a web page.
   */
  it('`autopilotFleetWide` lives in exactly settings.ts and view-model.ts', () => {
    const where = new Set(hits(/\bautopilotFleetWide\b/).map((h) => h.split(':')[0]))
    expect([...where].sort()).toEqual(['src/app/view-model.ts', 'src/lib/settings.ts'])
  })

  /** And the enforcers still read the FLOORED value (audit H8 §D — unchanged and pinned). */
  it.each([
    ['src/outreach/deliver.ts', /settings\.autopilotEnabled/],
    ['src/outreach/deliver.ts', /\(await getSettings\(\)\)\.autopilotEnabled/],
    ['src/outreach/dispatcher.ts', /autopilotEnabled: settings\.autopilotEnabled/],
    ['src/agent/index.ts', /\(await getSettings\(\)\)\.autopilotEnabled/],
    ['src/outreach/plan.ts', /autopilotEnabled: settings\.autopilotEnabled/],
  ])('%s still enforces the floored value', (file, re) => {
    expect(inFile(file)).toMatch(re)
  })
})

describe('only the queue may ask the gate about another Mac’s disk', () => {
  /** Each `name(` call in `code`, with its top-level argument count (commas at paren depth 1). */
  function calls(code: string, name: string): { line: number; args: number }[] {
    const out: { line: number; args: number }[] = []
    for (const m of code.matchAll(new RegExp(`\\b${name}\\s*\\(`, 'g'))) {
      const before = code.slice(Math.max(0, m.index! - 30), m.index!)
      if (/function\s+$/.test(before)) continue /* the definition, not a call */
      let depth = 1
      let commas = 0
      let nonEmpty = false
      for (let i = m.index! + m[0].length; i < code.length && depth > 0; i += 1) {
        const c = code[i]!
        if ('([{'.includes(c)) depth += 1
        else if (')]}'.includes(c)) depth -= 1
        else if (c === ',' && depth === 1) commas += 1
        if (depth > 0 && !/\s/.test(c)) nonEmpty = true
      }
      out.push({ line: code.slice(0, m.index!).split('\n').length, args: nonEmpty ? commas + 1 : 0 })
    }
    return out
  }

  /**
   * Every enforcement caller — the Send button (actions.ts), the dispatcher's loop (deliver.ts),
   * `pnpm send` — passes TWO arguments, so the witness defaults to THIS disk. A trailing comma
   * would read as a third here; there is none today and adding one is not worth the ambiguity.
   */
  it('no caller outside gate.ts passes recheckBeforeSend a third argument', () => {
    const sites = files
      .filter((f) => f.path !== 'src/outreach/gate.ts')
      .flatMap((f) => calls(f.code, 'recheckBeforeSend').map((c) => ({ ...c, path: f.path })))
    const byFile = new Set(sites.map((s) => s.path))
    for (const f of ['src/app/actions.ts', 'src/outreach/deliver.ts', 'src/scripts/send.ts']) {
      expect(byFile, `${f} no longer calls recheckBeforeSend — this guard has gone stale`).toContain(f)
    }
    expect(
      sites.filter((s) => s.args !== 2).map((s) => `${s.path}:${s.line} (${s.args} args)`),
      'an enforcement caller is handing the gate a witness — only the queue may',
    ).toEqual([])
  })

  it('inside gate.ts the only witnessed call is predictResendForQueue’s', () => {
    const gate = inFile('src/outreach/gate.ts')
    const sites = calls(gate, 'recheckBeforeSend')
    expect(sites).toHaveLength(1)
    const predict = gate.slice(gate.indexOf('export async function predictResendForQueue'))
    expect(predict).toMatch(/recheckBeforeSend\(attempt, \{ unattended: true \}, \{ kind: 'sending-mac'/)
  })

  it('predictResendForQueue is used by the queue’s view model and nothing else', () => {
    const where = new Set(hits(/\bpredictResendForQueue\b/).map((h) => h.split(':')[0]))
    expect([...where].sort()).toEqual(['src/app/view-model/messages-page.ts', 'src/outreach/gate.ts'])
  })

  it('the queue asks the prediction, never this disk', () => {
    const mp = inFile('src/app/view-model/messages-page.ts')
    expect(mp).toMatch(/predictResendForQueue\s*\(/)
    expect(mp).not.toMatch(/recheckBeforeSend\s*\(/)
  })
})
