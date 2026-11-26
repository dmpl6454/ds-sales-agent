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
 * "READ" FROM A READ THAT WAS NOT WHOLE (review, 26 Nov 2026). A post is marked read — and never asked again — only
 * when the page showed the WHOLE stored caption, the caption element ended on the page, and every "@handle" in it
 * was a link. Otherwise what it did find is still written (each mention is a real link), the post is marked
 * `embedPartialAt` instead, and it is asked again after a day while it is inside the window: a later read, or a
 * fixed parser, can still add what this one missed.
 *
 * AND THE ACCOUNT THAT SIGNED THE CAPTION. When the page's caption is signed by an account other than the channel
 * we stored the post under, the post is a collaboration and that account is a co-author: it is written where a
 * complete read writes a collaborator — `rawPayload.collabHandles` (discovery reads it) and `brands` as `@handle`
 * (crediting reads it) — and never into `taggedAccounts`, which is for accounts the caption names.
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

/**
 * PURE. Did the page show the WHOLE caption we stored, not just its beginning? Letters and digits only, as
 * `captionsAgree` compares. A page that cut the caption short ("… more") fails this and is not a complete read.
 */
export function wholeCaptionShown(stored: string, embedText: string): boolean {
  const a = squash(stored)
  return a.length > 0 && squash(embedText).includes(a)
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
  read: {
    mentions: readonly string[]
    owner: string | null
    /** The account that signed the caption when it is not the channel the post is stored under. */
    collaborator: string | null
    /** False = write what was found, mark it partial, and ask again later. */
    complete: boolean
  },
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
  const before = payload as Record<string, unknown>

  const mentions = [...new Set(read.mentions.map((m) => m.toLowerCase()))]
  const collaborator = read.collaborator === null ? null : read.collaborator.toLowerCase()
  const haveTag = new Set(tags.map((t) => t.toLowerCase()))
  const newTags = [...tags, ...mentions.filter((m) => !haveTag.has(m))]
  // "@handle" unless the list already names that account, with or without the "@".
  const haveBrand = new Set(brands.map((b) => b.toLowerCase().replace(/^@/, '')))
  const toBrand = [...mentions, ...(collaborator ? [collaborator] : [])].filter((m, i, all) => !haveBrand.has(m) && all.indexOf(m) === i)
  const newBrands = [...brands, ...toBrand.map((m) => `@${m}`)]
  const priorCollabs = Array.isArray(before.collabHandles) ? before.collabHandles.filter((c): c is string => typeof c === 'string') : []
  const collabHandles =
    collaborator && !priorCollabs.some((c) => c.toLowerCase() === collaborator) ? [...priorCollabs, collaborator] : priorCollabs
  const newPayload = JSON.stringify({
    ...before,
    collabHandles,
    ...(read.complete ? { [EMBED_READ_KEY]: now.toISOString() } : { embedPartialAt: now.toISOString() }),
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
  /** Read, the caption agreed, but the read was not whole: what it found is written, and it is asked again later. */
  incomplete: number
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
  preview: Array<{ shortcode: string; publisher: string; mentions: string[]; collaborator: string | null; complete: boolean }>
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
    incomplete: 0,
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
    if (outcome.kind === 'refused') {
      // A fact about this HOST, not this post: stop, and do not send the post to the back for a day.
      summary.haltedEarly = true
      // Whose refusal it was, in words: a log reading "Instagram refused" about our own ceiling sends a person
      // looking for a throttle that does not exist (review, 26 Nov 2026).
      summary.stopped = outcome.byUs ? `stopped by this Mac\u2019s own limit (${outcome.reason})` : `Instagram refused (${outcome.reason})`
      break
    }
    summary.asked += 1
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
    const owner = outcome.owner === null ? null : outcome.owner.toLowerCase()
    const mentions = outcome.mentions.map((m) => m.toLowerCase()).filter((m) => m !== publisher && m !== owner)
    const collaborator = owner !== null && owner !== publisher ? owner : null
    const unlinked = outcome.unlinkedAt.map((h) => h.toLowerCase()).filter((h) => h !== publisher && h !== owner)
    const whole = wholeCaptionShown(row.caption, outcome.captionText)
    const complete = outcome.closed && whole && unlinked.length === 0
    if (!complete) {
      log.step('post embed read was not whole — what it found is kept, and it is asked again after a day', {
        shortcode: row.shortcode,
        ...(outcome.closed ? {} : { cut: 'the page stopped before the caption ended' }),
        ...(whole ? {} : { caption: 'the page did not show the whole stored caption' }),
        ...(unlinked.length > 0 ? { unlinked: unlinked.map((h) => `@${h}`).join(' ') } : {}),
      })
    }
    const stored: RowEvidence = { taggedAccounts: row.taggedAccounts, brands: row.brands, rawPayload: row.rawPayload ?? '' }
    const merged = mergeEmbedMentions(stored, { mentions, owner, collaborator, complete }, now())
    if (merged === null) {
      summary.unreadable += 1
      unread.note(row.shortcode)
      log.step('a stored row was not in the shape the embed merge expects — left alone', { shortcode: row.shortcode })
      continue
    }
    const found = mentions.length > 0 || collaborator !== null
    if (!complete) {
      summary.incomplete += 1
      unread.note(row.shortcode)
    }
    if (dryRun) {
      if (found) {
        summary.restored += 1
        summary.mentionsRestored += mentions.length
        summary.preview.push({ shortcode: row.shortcode, publisher, mentions, collaborator, complete })
      } else if (complete) summary.nothingToRestore += 1
      continue
    }
    // An incomplete read that found nothing writes nothing: there is nothing to keep, and no "read" to record.
    if (!complete && !found) continue
    // The condition is IN the statement: a complete read may have replaced this row since we read it.
    const written = await prisma.detectedCampaign.updateMany({
      where: { id: row.id, taggedAccounts: stored.taggedAccounts, brands: stored.brands, rawPayload: stored.rawPayload },
      data: merged,
    })
    if (written.count === 0) {
      summary.changedUnderUs += 1
      continue
    }
    if (!found) {
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
          detail:
            (mentions.length > 0 ? `Instagram's embed page links ${mentions.map((m) => `@${m}`).join(' ')} in this post's caption; added to its tags` : 'no caption mention') +
            (collaborator ? `; the caption is signed by @${collaborator}, recorded as a collaborator` : '') +
            ` (publisher @${publisher}${complete ? '' : ', read not whole — asked again later'})`,
        },
      })
      .catch(() => undefined) // the row is written; a missing audit line must not undo or repeat it
  }
  return summary
}
