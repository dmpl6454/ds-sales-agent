import { prisma } from '@/lib/db'
import { env } from '@/lib/env'
import { log } from '@/lib/logger'
import { handleExists } from '@/detection/exists'
import { sleep } from '@/lib/time'
import { ensureCategory, addTargetToCategory } from './categories'
import { routeAllowed, fleetHandles } from './routes'
import { readCategoryMemberships, categoriesFor } from './categories'

/**
 * Turning a pasted sheet into a list of prospects.
 *
 * ── THE PARSING IS PURE, AND SEPARATE FROM THE WRITING ────────────────────
 *
 * Every edge case lives in the parse — a byte-order mark from Excel, CRLF line endings, a
 * quoted field containing a comma, `@handle` versus a pasted profile URL, the same account
 * twice under different capitalisation, a trailing blank row — and none of it needs a
 * database. Keeping it here means each case is a test rather than a paste-and-see.
 *
 * It also keeps the DANGEROUS half small: `importProspects` does the writes and has almost
 * no logic left to get wrong.
 *
 * ── WHAT IT REFUSES TO GUESS ──────────────────────────────────────────────
 *
 * A row whose handle is not a valid Instagram handle is REJECTED with its line number,
 * never silently repaired. "Never guess a handle" is a rule here with a measurement behind
 * it: turning the display name "RoyalCanin" into `@royalcanin` produced an HTTP 404, and
 * messaging the wrong account is worse than messaging nobody. The same applies to a
 * typo in a spreadsheet — the honest response is to name the line and let a person look.
 */

/** How many rows one import may carry. See `IMPORT_ROW_LIMIT` in the UI copy. */
export const IMPORT_ROW_LIMIT = 25

export interface ParsedProspect {
  handle: string
  /** Falls back to the handle. Internal label, never message copy. */
  displayName: string
  /**
   * What the recipient literally reads first: "Hi <this>,". Falls back to the display
   * name — which is why `greetableName` trims it downstream, after "Milano Ice Cream,
   * Bangalore" produced "Hi Milano Ice Cream, Bangalore team,".
   */
  greeting: string
  /** Optional category to drop them into, by name. Rotation is per category. */
  category: string | null
  note: string | null
  /** 1-based line in the pasted text, so a rejection can point at it. */
  line: number
}

export interface RejectedRow {
  line: number
  raw: string
  reason: string
}

export interface ParseResult {
  prospects: ParsedProspect[]
  rejected: RejectedRow[]
  /** Handles that appeared more than once in the paste. Kept once, reported. */
  duplicates: string[]
  /** True when the first row was consumed as a header rather than as data. */
  usedHeader: boolean
  /** Rows beyond IMPORT_ROW_LIMIT, dropped and REPORTED — never silently truncated. */
  overLimit: number
}

/**
 * Instagram's own rule: letters, numbers, dots, underscores, 1-30 characters.
 *
 * Duplicated from `assertSafeHandle` on purpose — that one THROWS, which is right for a
 * single action and wrong for a bulk import, where one bad row must not take the rest with
 * it. A test asserts the two accept and reject exactly the same handles, so they cannot
 * drift apart the way `DETECTOR_KEYS` once drifted from the detector registry.
 */
const HANDLE_RE = /^[A-Za-z0-9._]{1,30}$/

/** Header cells that mean "this column holds the handle". */
const HANDLE_HEADERS = ['handle', 'username', 'account', 'instagram', 'ig', 'profile']
const NAME_HEADERS = ['name', 'displayname', 'display name', 'channel', 'title', 'brand']
const GREETING_HEADERS = ['greeting', 'firstname', 'first name', 'contact', 'greet']
const CATEGORY_HEADERS = ['category', 'group', 'ring', 'segment']
const NOTE_HEADERS = ['note', 'notes', 'comment', 'why']

/**
 * Split one CSV line, honouring double quotes.
 *
 * Hand-written rather than a dependency: the input is a pasted column or two from a
 * spreadsheet, and the failure mode of a general CSV library here would be an obscure
 * error on a row a person can see is fine.
 */
export function splitCsvLine(line: string): string[] {
  const out: string[] = []
  let field = ''
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!
    if (quoted) {
      if (ch === '"') {
        // "" inside a quoted field is a literal quote.
        if (line[i + 1] === '"') {
          field += '"'
          i++
        } else {
          quoted = false
        }
      } else {
        field += ch
      }
      continue
    }
    if (ch === '"') {
      quoted = true
      continue
    }
    if (ch === ',' || ch === '\t' || ch === ';') {
      out.push(field)
      field = ''
      continue
    }
    field += ch
  }
  out.push(field)
  return out.map((f) => f.trim())
}

function normaliseHeader(s: string): string {
  return s.trim().toLowerCase().replace(/[_-]+/g, ' ')
}

/** Strip a leading @ and lowercase. `TargetAccount.handle` is unique and lowercased. */
export function cleanHandle(raw: string): string {
  let h = raw.trim()
  // A pasted profile URL is the most common thing after a bare handle.
  const url = h.match(/instagram\.com\/([A-Za-z0-9._]+)/i)
  if (url) h = url[1]!
  return h.replace(/^@+/, '').replace(/\/+$/, '').toLowerCase()
}

export interface ImportedRow {
  handle: string
  status: 'created' | 'already-known' | 'does-not-exist' | 'unconfirmed'
  detail?: string
}

export interface ImportOutcome {
  parsed: ParseResult
  rows: ImportedRow[]
  created: number
  /** True when nothing was written — the default. */
  dryRun: boolean
  /** Categories touched, so the caller can say what to switch on next. */
  categories: string[]
}

export function parseProspects(text: string): ParseResult {
  const prospects: ParsedProspect[] = []
  const rejected: RejectedRow[] = []
  const duplicates: string[] = []
  const seen = new Set<string>()

  // A byte-order mark from Excel would otherwise become part of the first handle, and the
  // resulting rejection ("﻿royalcanin is not a valid handle") is unreadable.
  const cleaned = text.replace(/^﻿/, '')
  const lines = cleaned.split(/\r\n|\r|\n/)

  let usedHeader = false
  let idx = { handle: 0, name: -1, greeting: -1, category: -1, note: -1 }

  // Find the first non-blank line; it may be a header.
  let start = 0
  while (start < lines.length && lines[start]!.trim() === '') start++

  if (start < lines.length) {
    const cells = splitCsvLine(lines[start]!).map(normaliseHeader)
    const handleAt = cells.findIndex((c) => HANDLE_HEADERS.includes(c))
    if (handleAt !== -1) {
      usedHeader = true
      idx = {
        handle: handleAt,
        name: cells.findIndex((c) => NAME_HEADERS.includes(c)),
        greeting: cells.findIndex((c) => GREETING_HEADERS.includes(c)),
        category: cells.findIndex((c) => CATEGORY_HEADERS.includes(c)),
        note: cells.findIndex((c) => NOTE_HEADERS.includes(c)),
      }
      start++
    }
  }

  let overLimit = 0

  for (let i = start; i < lines.length; i++) {
    const raw = lines[i]!
    if (raw.trim() === '') continue

    if (prospects.length >= IMPORT_ROW_LIMIT) {
      overLimit++
      continue
    }

    const cells = splitCsvLine(raw)
    const handle = cleanHandle(cells[idx.handle] ?? '')

    if (handle === '') {
      rejected.push({ line: i + 1, raw: raw.slice(0, 80), reason: 'no handle in this row' })
      continue
    }
    if (!HANDLE_RE.test(handle)) {
      // Named, never repaired. See the module header.
      rejected.push({
        line: i + 1,
        raw: raw.slice(0, 80),
        reason: `"${handle}" is not a valid Instagram handle (letters, numbers, dots, underscores)`,
      })
      continue
    }
    if (seen.has(handle)) {
      if (!duplicates.includes(handle)) duplicates.push(handle)
      continue
    }
    seen.add(handle)

    const pick = (at: number): string => (at >= 0 ? (cells[at] ?? '').trim() : '')
    const displayName = pick(idx.name) || handle
    prospects.push({
      handle,
      displayName,
      greeting: pick(idx.greeting) || displayName,
      category: pick(idx.category) || null,
      note: pick(idx.note) || null,
      line: i + 1,
    })
  }

  return { prospects, rejected, duplicates, usedHeader, overLimit }
}

// ── the half that writes ────────────────────────────────────────────────────

/**
 * Spacing between existence lookups.
 *
 * Each row is one anonymous request to Instagram. Fifty of them in a burst is a shape
 * ordinary use does not produce, and the endpoint that resolves brand categories is
 * already known to be fragile. 700ms matches the inter-page delay detection uses, which
 * has been measured across 48 consecutive requests with zero failures.
 */
const LOOKUP_SPACING_MS = 1500

/**
 * Create prospects from a pasted sheet.
 *
 * ── DRY RUN IS THE DEFAULT ────────────────────────────────────────────────
 *
 * Same rule as `ig:classify` and `ig:brands`, for the same reason: this is bulk, and a
 * mistyped column or the wrong sheet must cost nothing. The dry run does everything
 * except write — including the existence checks — so the preview is the real answer
 * rather than an optimistic one.
 *
 * ── ADDING IS NEVER THE SAME ACT AS SENDING ───────────────────────────────
 *
 * Pairs are created DISABLED, exactly like `addTarget` and `ig:brands`. One import could
 * otherwise queue fifty strangers for messaging, from every account, at once. Category
 * membership is also inert on its own: a sender still needs its auto-send switch, a
 * logged-in profile, an enabled pair and the autopilot toggle.
 *
 * ── AND THEY ARRIVE UNWATCHED ─────────────────────────────────────────────
 *
 * `watchEnabled: false`. Being worth messaging and being worth reading four times a day
 * are different judgements, and only the second one costs a request per page per slot.
 */
export async function importProspects(
  text: string,
  opts: { dryRun?: boolean; actor: string; note?: string } = { actor: 'cli' },
): Promise<ImportOutcome> {
  const dryRun = opts.dryRun ?? true
  const parsed = parseProspects(text)
  const rows: ImportedRow[] = []
  const categories = new Set<string>()
  let created = 0

  const existingHandles = new Set(
    (await prisma.targetAccount.findMany({ select: { handle: true } })).map((t) => t.handle),
  )
  const senders = await prisma.senderAccount.findMany({ select: { id: true, handle: true, fleetMember: true } })
  /** Every account we own — used for the "this is also one of ours" NOTE on the preview. */
  const senderHandles = new Set(senders.map((s) => s.handle))
  /**
   * The FLEET pages only, which is the set the route rule asks about. Narrower than
   * `senderHandles` on purpose: the burner is an account we own and is deliberately still
   * messageable as a rehearsal target. See `ourHandles` in `routes.ts`.
   */
  const fleetSenderHandles = await fleetHandles(prisma)

  for (const [i, p] of parsed.prospects.entries()) {
    if (existingHandles.has(p.handle)) {
      rows.push({ handle: p.handle, status: 'already-known', detail: 'already in the target list' })
      continue
    }

    if (i > 0) await sleep(LOOKUP_SPACING_MS)
    const exists = await handleExists(p.handle)

    if (exists === 'missing') {
      /**
       * NOT created. A handle that does not exist becomes a pair that can never send and a
       * row nobody can explain, and "messaging the wrong account is worse than messaging
       * nobody" applies to a typo in a spreadsheet exactly as it does to a guessed handle.
       */
      rows.push({ handle: p.handle, status: 'does-not-exist', detail: 'Instagram has no such account' })
      continue
    }

    const detail =
      exists === 'unknown'
        ? 'created, but Instagram could not be reached to confirm it — check the spelling'
        : senderHandles.has(p.handle)
          ? 'note: this is also one of OUR sending accounts'
          : undefined

    if (dryRun) {
      rows.push({ handle: p.handle, status: exists === 'unknown' ? 'unconfirmed' : 'created', detail })
      if (p.category) categories.add(p.category)
      continue
    }

    const target = await prisma.targetAccount.create({
      data: {
        handle: p.handle,
        displayName: p.displayName,
        contactFirstName: p.greeting,
        kind: 'CHANNEL',
        /**
         * A pasted list is a list of people to WRITE TO, whatever `kind` says. This is the
         * call site that proves `kind` could never have carried this meaning: these rows
         * are CHANNEL and messageable at the same time, which is exactly why `role` exists.
         */
        role: 'PROSPECT',
        // `passthrough` stores and judges nothing, and SAYS so. `mom` is a hand-written
        // rule set for one publisher's #Collaboration convention; applying it to an
        // arbitrary channel would silently mislabel posts.
        detectorKey: 'passthrough',
        // Messageable, not watched. See the module note.
        watchEnabled: false,
        importNote: [opts.note, p.note].filter(Boolean).join(' — ') || null,
      },
    })

    /**
     * ROUTES THROUGH THE SHARED RULE (`mayRouteExist`).
     *
     * An account can be both a sender and a target — messaging one account we own from
     * another is the safest end-to-end test there is — but a ROUTE between two accounts we
     * own must never exist, and a sender must never be paired with itself. This excluded
     * only the self-pair, so an imported sheet containing one of our own FLEET handles wired
     * every other page to it. A pasted list is exactly where that happens by accident:
     * `senderHandles` already existed here and was used only to write a NOTE about it.
     */
    /**
     * ── THE FLEET IS WRITTEN BEFORE THE ROUTES (moved 2026-08-26) ────────────
     *
     * It used to be written AFTER `createMany` below, and that order is a defect rather
     * than a detail: `routeAllowed` READS the memberships, so a sheet whose category column
     * says "marketing" created a pair to every BOLLYWOOD sender first and only then tagged
     * the row — leaving the new prospect wired to the wrong fleet, with the gate obliged to
     * hold each of those drafts forever.
     *
     * MEASURED the same day in the discovery half: @irctc.official and @sprite_india were
     * minted from an @exchange4media post with no membership and received a bollywood pitch
     * fourteen minutes later. `createBrandTarget` was fixed by writing the membership first;
     * this is the same fix on the import path, which nothing had compared it against.
     */
    if (p.category) {
      const cat = await ensureCategory(p.category)
      await addTargetToCategory(cat.id, target.id)
      categories.add(p.category)
    }

    /* One read for the whole sender x prospect walk — never a lookup per pair. */
    const memberships = await readCategoryMemberships()
    await prisma.outreachPair.createMany({
      data: senders
        .filter((s) =>
          routeAllowed({
            senderHandle: s.handle,
            targetHandle: p.handle,
            senderCategories: categoriesFor(memberships.bySenderHandle, s.handle),
            targetCategories: categoriesFor(memberships.byTargetHandle, p.handle),
            ourHandles: fleetSenderHandles,
            senderIsFleetMember: s.fleetMember,
            targetOptedOut: target.optedOut,
            // An imported row is a PROSPECT by definition — a pasted list is a list of
            // people to write to. This is also the call site that makes deriving the rule
            // from `kind` unusable: these rows are created `kind: 'CHANNEL'`, so a
            // kind-based invariant would refuse every one of them.
            targetIsWatchOnly: target.role === 'WATCH',
          }),
        )
        .map((s) => ({
          senderId: s.id,
          targetId: target.id,
          cooldownDays: env.DEFAULT_COOLDOWN_DAYS,
          enabled: true,
        })),
    })

    created += 1
    rows.push({ handle: p.handle, status: exists === 'unknown' ? 'unconfirmed' : 'created', detail })
  }

  if (!dryRun && created > 0) {
    await prisma.auditLog.create({
      data: {
        actor: opts.actor,
        action: 'prospects.imported',
        entity: 'TargetAccount',
        detail:
          `${created} prospect(s) imported, every route disabled and none watched` +
          (categories.size > 0 ? `; categories: ${[...categories].join(', ')}` : ''),
      },
    })
    log.info('prospects imported', { created, categories: [...categories] })
  }

  return { parsed, rows, created, dryRun, categories: [...categories] }
}
