/**
 * embedEvidence.ts — put back, on a paid post we already hold, the @mentions Instagram shows on its embed page.
 *
 * ── WHY ──────────────────────────────────────────────────────────────────────────────────────────
 *
 * Since 15 Oct posts arrive through Meta's official read, which hands over a caption with the "@" taken out and no
 * tags (measured on the box 26 Nov: 0 official-read captions credited by an "@handle" in 14 days). A company is
 * found, and an existing company is credited, by the handles Instagram ASSERTS on a paid post — and for six weeks
 * there have been none. MEASURED the same day from the Mac Studio: `/p/<shortcode>/embed/captioned/` still returns
 * the caption with its @mentions LINKED to accounts, to a visitor with no login.
 *
 * So for each official-read paid post inside the window this asks that page once and, when the page is provably
 * about this post, writes what it asserts onto the row. Only a Mac can ask (the server is sent to the login page),
 * so the device agent runs this at the front of its brand pass; `pnpm ig:embed-evidence` is the same function
 * behind a dry run.
 *
 * ── WHERE THE HANDLES GO, AND WHY THERE ───────────────────────────────────────────────────────────
 *
 *   `taggedAccounts`   every consumer already reads it: discovery's candidates, the "which paid posts name this
 *                      company" rule (planner, gate, and the build the Mac ran before this one), the "We message"
 *                      column, search. A new column or a new key would have needed a new arm in each, and the
 *                      arm somebody forgets is a rule enforced in one place and reported by another.
 *   `brands`           as "@handle", the way a complete read stores an asserted account. `followUpSubject` counts
 *                      those entries as OTHER ADVERTISERS on the post; without them a five-advertiser round-up
 *                      reads as a one-subject post and its event is offered to a person as "your placement" —
 *                      the 4 Sept defect, by the same door.
 *   `rawPayload`       `embedReadAt`, `embedMentions`, `embedOwner`: where the handles came from and when. Read by
 *                      nothing but this file (to not ask twice) and a person.
 *
 * The official-read marker stays in `rawPayload`, byte for byte: it is what lets a later anonymous read replace
 * this row whole with the real thing, and what stops an official re-read from wiping tags.
 *
 * ── WHAT IT REFUSES TO WRITE ──────────────────────────────────────────────────────────────────────
 *
 * EVIDENCE ABOUT A DIFFERENT POST. The page's caption must contain the beginning of the caption we stored for this
 * shortcode (`captionsAgree`) — a removed post, a login shell and an "unavailable" page all fail that — or nothing
 * is recorded at all, not even "nothing found".
 * "NOTHING FOUND" FROM A PAGE THAT DID NOT ANSWER. Only a caption that agreed and linked no account is recorded
 * as read-and-empty. A page with no caption, an odd status or a timeout is retried after a day, in this process's
 * memory only: a failure is never written down as a fact about the post.
 * A STALE WRITE. The row is updated only if it still holds exactly what was read (the three strings are in the
 * `where`), because a complete read can replace the row between our read and our write.
 */
import { prisma } from '@/lib/db'
import { log } from '@/lib/logger'
import { daysAgo } from '@/lib/time'
import { detectionCutoff } from '@/lib/cutoff'
import { browserShutdownRequested } from '@/outreach/shutdown'
import { readPostEmbed, type EmbedPostOutcome } from './embedDoor'
import { EVIDENCE_INCOMPLETE_MARKER } from './evidence'
import { createFailureMemory } from './lookupCooldown'

/** How far back a post is worth asking about: the window the material allowance counts over. */
export const EMBED_EVIDENCE_WINDOW_DAYS = 7
/** The text in `rawPayload` that says this row's embed page has been read. */
export const EMBED_READ_KEY = 'embedReadAt'
const SPACING_MS = 4_000

/** Posts whose page did not answer usefully: not asked again for a day. Keyed by shortcode, so it is capped. */
const unread = createFailureMemory(undefined, { maxEntries: 5_000 })

/** Test seam. */
export function resetEmbedEvidenceMemory(): void {
  unread.reset()
}

const squash = (s: string): string => s.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')

/**
 * PURE. Is this embed page's caption the caption we stored for the post?
 *
 * The stored caption is Meta's (no "@"); the page's is Instagram's (with them), and it starts with the publisher's
 * username. Letters and digits only, so "@", emoji, spacing and line breaks do not matter. The BEGINNING of the
 * stored caption must appear in the page's — a page may cut a long caption short, never rewrite its start. A
 * stored caption too short to be told from an accident must be the whole tail of the page's.
 */
export function captionsAgree(stored: string, embedText: string): boolean {
  const a = squash(stored)
  const b = squash(embedText)
  if (a.length === 0 || b.length === 0) return false
  if (a.length < 12) return b.endsWith(a)
  return b.includes(a.slice(0, 60))
}

export interface RowEvidence {
  taggedAccounts: string
  brands: string
  rawPayload: string
}

function stringArray(json: string): string[] | null {
  try {
    const v: unknown = JSON.parse(json || '[]')
    return Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : null
  } catch {
    return null
  }
}

/**
 * PURE. The row's three evidence strings with the embed's mentions merged in — or null when the stored strings
 * are not what this expects (unreadable JSON, no official-read marker), in which case nothing may be written.
 */
export function mergeEmbedMentions(
  stored: RowEvidence,
  read: { mentions: readonly string[]; owner: string | null },
  now: Date,
): RowEvidence | null {
  const tags = stringArray(stored.taggedAccounts)
  const brands = stringArray(stored.brands)
  if (tags === null || brands === null) return null
  let payload: unknown
  try {
    payload = JSON.parse(stored.rawPayload)
  } catch {
    return null
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null

  const mentions = [...new Set(read.mentions.map((m) => m.toLowerCase()))]
  const haveTag = new Set(tags.map((t) => t.toLowerCase()))
  const newTags = [...tags, ...mentions.filter((m) => !haveTag.has(m))]
  // "@handle" unless the list already names that account, with or without the "@".
  const haveBrand = new Set(brands.map((b) => b.toLowerCase().replace(/^@/, '')))
  const newBrands = [...brands, ...mentions.filter((m) => !haveBrand.has(m)).map((m) => `@${m}`)]
  const newPayload = JSON.stringify({
    ...(payload as Record<string, unknown>),
    [EMBED_READ_KEY]: now.toISOString(),
    embedMentions: mentions,
    embedOwner: read.owner,
  })
  // The marker is found by its exact bytes in three places. A row that never had it is not an official-read row
  // and is not ours to touch; a rewrite that lost it would orphan the row. One check, on what would be WRITTEN.
  if (!newPayload.includes(EVIDENCE_INCOMPLETE_MARKER)) return null
  return { taggedAccounts: JSON.stringify(newTags), brands: JSON.stringify(newBrands), rawPayload: newPayload }
}

export interface EmbedEvidenceSummary {
  /** Official-read paid posts in the window whose embed page has not been read. */
  waiting: number
  asked: number
  /** Posts that gained at least one mention. */
  restored: number
  mentionsRestored: number
  /** Read, the caption agreed, and it links no account: recorded, and not asked again. */
  nothingToRestore: number
  /** The page was not this post's caption: nothing recorded. */
  notThisPost: number
  /** No caption on the page, an odd status, or no answer: retried after a day. */
  unreadable: number
  /** The row changed between our read and our write: nothing written, asked again next pass. */
  changedUnderUs: number
  coolingOff: number
  haltedEarly: boolean
  /** Why the pass stopped before its budget, when it did. */
  stopped: string | null
  /** What a dry run would have written. */
  preview: Array<{ shortcode: string; publisher: string; mentions: string[] }>
}

export async function postEmbedPass(opts: {
  maxReads: number
  dryRun?: boolean
  /** Tests only. */
  spacingMs?: number
  /** Tests only: the reader. Production always uses the gated door. */
  read?: (shortcode: string) => Promise<EmbedPostOutcome>
  now?: () => Date
}): Promise<EmbedEvidenceSummary> {
  const dryRun = opts.dryRun ?? false
  const spacingMs = opts.spacingMs ?? SPACING_MS
  const read = opts.read ?? readPostEmbed
  const now = opts.now ?? (() => new Date())
  const summary: EmbedEvidenceSummary = {
    waiting: 0,
    asked: 0,
    restored: 0,
    mentionsRestored: 0,
    nothingToRestore: 0,
    notThisPost: 0,
    unreadable: 0,
    changedUnderUs: 0,
    coolingOff: 0,
    haltedEarly: false,
    stopped: null,
    preview: [],
  }

  const floorMs = Math.max(daysAgo(EMBED_EVIDENCE_WINDOW_DAYS, now()).getTime(), detectionCutoff().getTime())
  /* The marker `contains` is the query pipeline.ts already runs on both providers. Whether the page was read is
     tested in JS: a second `contains` under NOT is one more thing that could differ between SQLite and Postgres,
     and the window is a few hundred rows. */
  const rows = await prisma.detectedCampaign.findMany({
    where: { verdict: 'CAMPAIGN', postedAt: { gte: new Date(floorMs) }, rawPayload: { contains: EVIDENCE_INCOMPLETE_MARKER } },
    orderBy: [{ postedAt: 'desc' }, { id: 'desc' }],
    select: { id: true, shortcode: true, caption: true, taggedAccounts: true, brands: true, rawPayload: true, target: { select: { handle: true } } },
  })
  const pending = rows.filter((r) => !(r.rawPayload ?? '').includes(`"${EMBED_READ_KEY}"`))
  const { queue, coolingOff } = unread.order(pending, (r) => r.shortcode)
  summary.waiting = pending.length
  summary.coolingOff = coolingOff

  for (const row of queue) {
    if (summary.asked >= opts.maxReads) {
      summary.haltedEarly = true
      summary.stopped = 'this pass’s budget'
      break
    }
    if (browserShutdownRequested()) {
      summary.stopped = 'the agent is stopping'
      break
    }
    const outcome = await read(row.shortcode)
    if (outcome.kind === 'not-asked') {
      // The switch is off or this is not a machine that asks: say so once and spend nothing.
      summary.stopped = outcome.why === 'switched-off' ? 'embed reads are switched off' : 'this machine does not ask embed pages'
      break
    }
    summary.asked += 1
    if (outcome.kind === 'refused') {
      // A fact about this HOST, not this post: stop, and do not send the post to the back for a day.
      summary.haltedEarly = true
      summary.stopped = `Instagram refused (${outcome.reason})`
      break
    }
    if (spacingMs > 0) await new Promise((r) => setTimeout(r, spacingMs))
    if (outcome.kind === 'nothing') {
      summary.unreadable += 1
      unread.note(row.shortcode)
      log.step('post embed said nothing usable — asked again after a day', { shortcode: row.shortcode, reason: outcome.reason })
      continue
    }

    if (!captionsAgree(row.caption, outcome.captionText)) {
      summary.notThisPost += 1
      unread.note(row.shortcode)
      log.step('post embed did not show this post’s caption — nothing recorded', { shortcode: row.shortcode })
      continue
    }
    const publisher = row.target.handle.toLowerCase()
    const mentions = outcome.mentions.filter((m) => m !== publisher && m !== outcome.owner)
    const stored: RowEvidence = { taggedAccounts: row.taggedAccounts, brands: row.brands, rawPayload: row.rawPayload ?? '' }
    const merged = mergeEmbedMentions(stored, { mentions, owner: outcome.owner }, now())
    if (merged === null) {
      summary.unreadable += 1
      unread.note(row.shortcode)
      log.step('a stored row was not in the shape the embed merge expects — left alone', { shortcode: row.shortcode })
      continue
    }
    if (dryRun) {
      if (mentions.length > 0) {
        summary.restored += 1
        summary.mentionsRestored += mentions.length
        summary.preview.push({ shortcode: row.shortcode, publisher, mentions })
      } else summary.nothingToRestore += 1
      continue
    }
    // The condition is IN the statement: a complete read may have replaced this row since we read it.
    const written = await prisma.detectedCampaign.updateMany({
      where: { id: row.id, taggedAccounts: stored.taggedAccounts, brands: stored.brands, rawPayload: stored.rawPayload },
      data: merged,
    })
    if (written.count === 0) {
      summary.changedUnderUs += 1
      continue
    }
    if (mentions.length === 0) {
      summary.nothingToRestore += 1
      continue
    }
    summary.restored += 1
    summary.mentionsRestored += mentions.length
    await prisma.auditLog
      .create({
        data: {
          actor: 'embed-evidence',
          action: 'post.embed-mentions',
          entity: `DetectedCampaign:${row.shortcode}`,
          detail: `Instagram's embed page links ${mentions.map((m) => `@${m}`).join(' ')} in this post's caption; added to its tags (publisher @${publisher})`,
        },
      })
      .catch(() => undefined) // the row is written; a missing audit line must not undo or repeat it
  }
  return summary
}
