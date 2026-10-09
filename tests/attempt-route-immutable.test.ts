import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

/**
 * AN ATTEMPT'S ROUTE NEVER CHANGES AFTER IT IS WRITTEN (2026-10-09).
 *
 * `pairId`, `senderId` and `targetId` are fixed when the planner writes a draft for a route.
 * Every safety argument downstream leans on that:
 *
 *   - the two READY→SENDING claims (`deliver.ts`, `sendNow`) condition on STATUS only. That is
 *     enough exactly because no row can be moved onto another pair between a tick reading the
 *     queue and claiming it — otherwise the old page's browser drives under the new page's row;
 *   - `recordDelivered` writes by id, unconditionally, and must stay that way (a delivery fact
 *     may never be droppable) — so the row it lands on must be the pair that drove it;
 *   - the touch number, the bytes and the variant were all chosen for THAT route.
 *
 * The one writer that ever broke it was the sender hand-off, which re-pointed waiting drafts
 * onto another page and so turned a follow-up into that page's first message (`handOff.ts`).
 * It releases them now. This pins the invariant rather than the one call site, because the
 * failure mode is a re-point somebody writes next year: no `update` / `updateMany` data block,
 * and no `upsert` update block, may name any of the three columns — or the `pair`, `sender` and
 * `target` relations, which write those columns just as well. Creating a row with them is of
 * course allowed.
 */

const SRC = join(process.cwd(), 'src')
/**
 * The three scalar columns, AND the three relations that write them. Prisma accepts the route
 * either way — `pairId: x` or `pair: { connect: { id: x } }` — so a checker that knows only the
 * scalars passes the relation form of the very re-point it exists to refuse.
 */
const ROUTE_KEYS = ['pairId', 'senderId', 'targetId', 'pair', 'sender', 'target'] as const

/* Newlines kept, so a finding names the right line. */
const stripComments = (t: string) =>
  t.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' ')).replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) {
      if (relative(SRC, p) === 'generated') continue
      out.push(...sourceFiles(p))
    } else if (/\.(ts|tsx)$/.test(name)) {
      out.push(p)
    }
  }
  return out
}

/** The text from an opening `(` or `{` to its match. Skips quoted strings; good enough for code. */
function balanced(src: string, open: number): string | null {
  const close = src[open] === '(' ? ')' : '}'
  const opener = src[open]
  let depth = 0
  for (let i = open; i < src.length; i++) {
    const c = src[i]
    if (c === '"' || c === "'" || c === '`') {
      const q = c
      for (i++; i < src.length && src[i] !== q; i++) if (src[i] === '\\') i++
      continue
    }
    if (c === opener || (opener === '(' && c === '{') || (opener === '{' && c === '(')) depth++
    else if (c === close || (opener === '(' && c === '}') || (opener === '{' && c === ')')) {
      depth--
      if (depth === 0) return src.slice(open, i + 1)
    }
  }
  return null
}

/** The object literal that is the value of `key:` inside a call's arguments, or null. */
function literalValueOf(args: string, key: string): string | null {
  const m = new RegExp(`\\b${key}\\s*:\\s*`).exec(args)
  if (!m) return null
  const at = m.index + m[0].length
  return args[at] === '{' ? balanced(args, at) : null
}

interface Finding {
  where: string
  problem: string
}

/** PURE over one file's text — exported to the self-test below, so the checker is checked. */
function findReRoutes(file: string, text: string): { checked: number; findings: Finding[] } {
  const src = stripComments(text)
  const findings: Finding[] = []
  let checked = 0
  const call = /\boutreachAttempt\.(update|updateMany|upsert)\s*\(/g
  for (let m = call.exec(src); m; m = call.exec(src)) {
    const method = m[1]!
    const line = src.slice(0, m.index).split('\n').length
    const where = `${file}:${line} ${method}`
    const args = balanced(src, m.index + m[0].length - 1)
    if (!args) {
      findings.push({ where, problem: 'could not read the call' })
      continue
    }
    const block = literalValueOf(args, method === 'upsert' ? 'update' : 'data')
    if (block === null) {
      findings.push({ where, problem: 'its data is not an object literal, so it cannot be checked' })
      continue
    }
    checked++
    /*
     * A spread is followed back to a LOCAL `const name = { … }` literal in the same file and that
     * literal is checked too (replyCheck.ts builds the reply fields once and spreads them into
     * each guarded write). Anything else spread in — a parameter, an import, a computed object, a
     * literal that itself spreads a variable — cannot be read here and is refused, as before.
     */
    const blocks = [block]
    for (const sp of block.matchAll(/\.\.\.\s*([A-Za-z_$][\w$]*)/g)) {
      const literal = localLiteral(src, sp[1]!)
      if (literal === null || /\.\.\.\s*[A-Za-z_$]/.test(literal)) {
        findings.push({ where, problem: 'it spreads a variable into its data, so it cannot be checked' })
      } else {
        blocks.push(literal)
      }
    }
    for (const key of ROUTE_KEYS) {
      if (blocks.some((b) => new RegExp(`(?<![.\\w$])${key}\\s*[:,}]`).test(b))) {
        findings.push({ where, problem: `it rewrites ${key} — an attempt's route is fixed when it is written` })
      }
    }
  }
  return { checked, findings }
}

/** The object literal a `const name = { … }` (optionally typed) initialises, if exactly one exists. */
function localLiteral(src: string, name: string): string | null {
  const decl = new RegExp(`\\bconst\\s+${name.replace(/\$/g, '\\$')}\\s*(?::[^=]+)?=\\s*\\{`, 'g')
  const hits = [...src.matchAll(decl)]
  if (hits.length !== 1) return null
  const h = hits[0]!
  return balanced(src, h.index! + h[0].length - 1)
}

describe("an attempt's route is never rewritten", () => {
  it('no update in src names pairId, senderId or targetId, or writes the pair, sender or target relation', () => {
    let checked = 0
    const findings: Finding[] = []
    for (const f of sourceFiles(SRC)) {
      const r = findReRoutes(relative(process.cwd(), f), readFileSync(f, 'utf8'))
      checked += r.checked
      findings.push(...r.findings)
    }
    // Not vacuous: there are ~35 such writes today, and a grep that matches none passes anything.
    expect(checked, 'the scan found almost no updates — the pattern has stopped matching').toBeGreaterThan(20)
    expect(findings.map((x) => `${x.where}: ${x.problem}`)).toEqual([])
  })

  /** The checker against the exact shape the hand-off used to write — it must refuse it. */
  it('the checker catches the re-point the hand-off used to write', () => {
    const headShape = `
      await prisma.$transaction([
        prisma.outreachAttempt.update({
          where: { id: attempt.id },
          data: {
            pairId: newPair.id,
            senderId: choice.senderId,
            touchNumber: deliveredOnNewPair + 1,
            status: 'READY',
          },
        }),
      ])`
    const r = findReRoutes('fixture.ts', headShape)
    expect(r.checked).toBe(1)
    expect(r.findings.map((x) => x.problem).join(' | ')).toMatch(/pairId.*senderId/)
  })

  it('follows a spread to its local literal: a re-point hidden there is caught, a clean one passes', () => {
    const hidden = `
      const moved = { pairId: newPair.id, status: 'READY' }
      await prisma.outreachAttempt.update({ where: { id }, data: { ...moved } })`
    expect(findReRoutes('fixture.ts', hidden).findings.map((x) => x.problem).join(' | ')).toMatch(/rewrites pairId/)
    const clean = `
      const reply = { repliedAt: now, replyText: t, ...(vouch ? { replyCheckedAt: now } : {}) }
      await prisma.outreachAttempt.update({ where: { id }, data: { ...reply, status: 'REPLIED' } })`
    expect(findReRoutes('fixture.ts', clean)).toEqual({ checked: 1, findings: [] })
    const opaque = `
      await prisma.outreachAttempt.update({ where: { id }, data: { ...args.fields } })
      const wrap = { ...other }
      await prisma.outreachAttempt.update({ where: { id }, data: { ...wrap } })`
    expect(findReRoutes('fixture.ts', opaque).findings.map((x) => x.problem)).toEqual([
      'it spreads a variable into its data, so it cannot be checked',
      'it spreads a variable into its data, so it cannot be checked',
    ])
  })

  /**
   * The same re-point written as a RELATION write. `pair: { connect: { id } }` moves the row
   * exactly as `pairId: id` does, and the scalar-only checker let it through (run, and it
   * passed). Every nested operation on the three relations is refused, not just `connect`:
   * connectOrCreate / create / upsert can point the row at a new route, disconnect / set
   * unhook it, and the one harmless op (a nested `update` of the related row) is written
   * just as well through that row's own model — telling them apart textually is not worth
   * the risk of reading one wrong.
   */
  it('catches a re-point written as a relation write, for every nested operation', () => {
    const ops = {
      connect: '{ connect: { id: newPair.id } }',
      connectOrCreate: "{ connectOrCreate: { where: { id: x }, create: { handle: 'h' } } }",
      disconnect: '{ disconnect: true }',
      set: '{ set: [{ id: x }] }',
    }
    for (const [op, value] of Object.entries(ops)) {
      for (const rel of ['pair', 'sender', 'target']) {
        for (const [method, block] of [
          ['update', 'data'],
          ['updateMany', 'data'],
          ['upsert', 'update'],
        ] as const) {
          const extra = method === 'upsert' ? `create: { status: 'READY' }, ` : ''
          const text = `await prisma.outreachAttempt.${method}({ where: { id }, ${extra}${block}: { ${rel}: ${value}, status: 'READY' } })`
          const r = findReRoutes('fixture.ts', text)
          expect(r.checked, `${method} ${rel} ${op}`).toBe(1)
          expect(r.findings.map((x) => x.problem), `${method} ${rel} ${op}`).toEqual([
            `it rewrites ${rel} — an attempt's route is fixed when it is written`,
          ])
        }
      }
    }
  })

  it("catches the hand-off's old re-point in relation form, and one hidden behind a local spread", () => {
    const relational = `
      await prisma.outreachAttempt.update({
        where: { id: attempt.id },
        data: { pair: { connect: { id: newPair.id } }, sender: { connect: { id: choice.senderId } }, status: 'READY' },
      })`
    expect(findReRoutes('fixture.ts', relational).findings.map((x) => x.problem).join(' | ')).toMatch(/rewrites pair .*rewrites sender/)
    const hidden = `
      const moved = { target: { connect: { id: other.id } }, status: 'READY' }
      await prisma.outreachAttempt.update({ where: { id }, data: { ...moved } })`
    expect(findReRoutes('fixture.ts', hidden).findings.map((x) => x.problem)).toEqual([
      "it rewrites target — an attempt's route is fixed when it is written",
    ])
  })

  /** The relation names are whole keys: a field that merely starts with one is not a re-point. */
  it('does not mistake pairId-shaped or longer keys, or a where-clause relation filter, for a relation write', () => {
    const fine = `
      await prisma.outreachAttempt.update({ where: { id, pair: { senderId: s } }, data: { status: 'SENT', targetHandle: t, senderName: n } })
      await prisma.outreachAttempt.updateMany({ where: { target: { optedOut: true } }, data: { status: 'SKIPPED' } })`
    expect(findReRoutes('fixture.ts', fine)).toEqual({ checked: 2, findings: [] })
  })

  it('and lets an ordinary status write, a value READ from senderId, and a create through', () => {
    const fine = `
      await prisma.outreachAttempt.update({ where: { id, senderId: s }, data: { status: 'SENT', sentBy: rec.senderId } })
      await prisma.outreachAttempt.create({ data: { pairId, senderId, targetId, status: 'READY' } })`
    expect(findReRoutes('fixture.ts', fine)).toEqual({ checked: 1, findings: [] })
  })
})
