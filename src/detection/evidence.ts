import { readStringArray, writeStringArray } from '@/lib/json'
import type { FeedPost } from './feed'

/**
 * THE CAPTURED EVIDENCE ABOUT A POST — built in ONE place, and refreshed when it moves.
 *
 * ── WHAT THE 13 AUGUST AUDIT GOT WRONG, AND WHAT IT GOT RIGHT ───────────────
 *
 * The audit recorded that `taggedAccounts` was "fetched, validated and dropped", on the
 * evidence that `pipeline.ts` writes seven keys to `rawPayload` and this is not one of
 * them. That inference is wrong, and re-measuring is what showed it: `taggedAccounts` is a
 * first-class COLUMN on `DetectedCampaign` and the pipeline has always written it.
 * MEASURED on the live database 2026-08-13: 460 of 2,713 rows carry tags, including posts
 * detected that morning. Looking at one store and concluding about another is the same
 * shape as the finding the audit was making at the time.
 *
 * WHAT IS GENUINELY MISSING is the other half of that sentence, and it is the half nothing
 * checked: **the evidence is captured at FIRST SIGHTING and never refreshed.** `persist()`
 * is reached only from `for (const post of fresh)`, and `fresh` excludes every shortcode
 * already stored — the exact structure that made the old "media URLs are refreshed on every
 * re-observation" claim false for a month. Tags and collaborators can be EDITED after
 * posting; a brand added to a post an hour after it went up is invisible to us forever.
 *
 * ── WHY THIS IS A MODULE AND NOT TWO INLINE OBJECT LITERALS ─────────────────
 *
 * Refreshing means a second place that builds `rawPayload`, and two builders of one shape
 * is how the seven keys and the column drifted apart in the first place. `buildRawPayload`
 * is therefore the ONE writer, called by both the create and the refresh, for the same
 * reason `markChallenged`, `markSessionInvalid`, `labelPost` and `frameTextSummaryLine` are
 * each single writers. A future key added here reaches both paths or neither.
 *
 * ── AND A REFRESH THAT ALWAYS WRITES IS NOT A REFRESH, IT IS A WRITE LOOP ───
 *
 * The known-post loop runs over every post in the fetched window on every pass — 4 channels
 * x up to 48 posts, every 15 minutes. Writing each one unconditionally would be ~18,000
 * row updates a day to record that nothing changed, on a database two hosts share. So
 * `evidenceRefresh` is PURE and compares first: it returns `null` when the evidence is
 * unchanged, and a payload only when it actually moved. `capturedAt` deliberately does NOT
 * take part in that comparison — it is a clock, and including it would make every post
 * differ from itself on every pass, which is precisely the write loop being avoided.
 */

/** The `rawPayload` shape. Every producer of it goes through here. */
export interface RawPayloadShape {
  /** `null` only on a post the official read path served — it does not report the flag. */
  isPaidPartnership: boolean | null
  sponsorHandles: string[]
  collabHandles: string[]
  thumbnailUrl: string | null
  videoUrl: string | null
  videoDurationSeconds: number | null
  capturedAt: string
  /**
   * Present (and true) only when the post was stored from a source that reports no tag
   * evidence at all — the official Graph API fallback (src/detection/graphFeed.ts). The
   * empty lists beside it mean "not reported", not "none", and the first anonymous read of
   * the post replaces the whole payload (see `evidenceRefresh`).
   */
  evidenceIncomplete?: true
}

/**
 * The exact bytes `buildRawPayload` writes for a post the official read path stored. The pipeline
 * finds such rows with a string `contains` on `rawPayload` (one query, both providers), so the
 * marker must be byte-identical to what `JSON.stringify` emits — `tests/official-read-pipeline.test.ts`
 * asserts it against a real payload rather than trusting this comment.
 */
export const EVIDENCE_INCOMPLETE_MARKER = '"evidenceIncomplete":true'

/**
 * `taggedAccounts` is NOT in here, and that is deliberate rather than an oversight
 * repeated. It has its own column, it is the one field of this set a query might ever
 * want, and duplicating it into the JSON would create two sources of truth for one fact —
 * which is the thing this module exists to prevent.
 *
 * A post from the official read path is stored with the paid-partnership flag as `null` and
 * `evidenceIncomplete: true`: writing its `false` would assert a fact the API never stated,
 * and "absence is not false" is the mistake this codebase has made five times. A complete
 * post's payload is byte-for-byte what it always was — the marker key is only added when set.
 */
export function buildRawPayload(post: FeedPost, capturedAt: Date): string {
  const payload: RawPayloadShape = {
    isPaidPartnership: post.evidenceIncomplete ? null : post.isPaidPartnership,
    sponsorHandles: post.sponsorHandles,
    collabHandles: post.collabHandles,
    thumbnailUrl: post.thumbnailUrl,
    videoUrl: post.videoUrl,
    videoDurationSeconds: post.videoDurationSeconds,
    capturedAt: capturedAt.toISOString(),
    ...(post.evidenceIncomplete ? { evidenceIncomplete: true as const } : {}),
  }
  return JSON.stringify(payload)
}

/** What a re-observation found stored. Only the fields the comparison reads. */
export interface StoredEvidence {
  taggedAccounts: string | null
  rawPayload: string | null
}

export interface EvidenceUpdate {
  taggedAccounts: string
  rawPayload: string
  /**
   * What actually moved, for the log. An unexplained write is a write nobody can audit.
   * `completed` is the first anonymous read of a post the official API stored: its evidence
   * was never reported, so the whole payload is replaced even if every list is still empty.
   */
  changed: ('tags' | 'collaborators' | 'sponsors' | 'paid-partnership-flag' | 'completed')[]
}

/**
 * Has this post's captured evidence changed since we stored it? PURE.
 *
 * Returns `null` when nothing moved — the common case by a very long way, and the reason
 * this is a comparison rather than an unconditional write.
 *
 * ── WHAT COUNTS AS A CHANGE, AND WHY THE MEDIA URLS DO NOT ──────────────────
 *
 * Only the four EVIDENCE fields are compared: tags, collaborators, sponsor tags and
 * Instagram's own paid-partnership flag. Those are facts about the post that a publisher
 * can edit, and each one bears on whether the publisher was paid.
 *
 * The CDN URLs are excluded on purpose even though they rotate constantly. They are not
 * evidence — the bytes on disk are, which is the whole reason `media.ts` exists and the
 * reason the old refresh claim was worth so little. Comparing them would make almost every
 * post differ on almost every pass and turn this into the write loop described above,
 * while buying nothing: a rotated URL for a frame we already hold is not a new fact. They
 * are still WRITTEN when something else changed, because the freshest URL costs nothing
 * once a row is being updated anyway.
 */
export function evidenceRefresh(stored: StoredEvidence, post: FeedPost, now: Date): EvidenceUpdate | null {
  /**
   * ── A POST WHOSE SOURCE REPORTS NO EVIDENCE NEVER REFRESHES IT (15 Oct 2026) ──────────
   *
   * The official Graph API fallback (src/detection/graphFeed.ts) serves a post with EMPTY tags,
   * collaborators and sponsors because the API does not return them — not because the publisher
   * removed them. Compared like an anonymous read, every re-observation of a tagged post would
   * report "tags changed" and write `[]` over the real stored tags, on every 15-minute pass, for
   * as long as the fallback serves. Tags are what discovery mints prospects from; erasing them is
   * not a cosmetic loss. So such a post says nothing about evidence, ever, here: `null`, no write.
   *
   * (The media URLs could in principle refresh from it, but nothing refreshes URLs on their own —
   * the bytes on disk are the evidence, and `saveFrame` still banks them in the pipeline.)
   *
   * MUTATION (applied by hand, saw red, restored): deleting this line fails
   * tests/official-read-pipeline.test.ts "a Graph-served re-observation leaves stored tags untouched".
   */
  if (post.evidenceIncomplete) return null

  const previous = parseRawPayload(stored.rawPayload)
  const changed: EvidenceUpdate['changed'] = []

  /**
   * And the other direction: a row the official API STORED carries a payload marked incomplete.
   * The first anonymous read replaces it whole — even when its lists are empty too, because
   * "the API did not say" and "the feed says none" are different facts, and only the second may
   * stay on record. One write per such post, then ordinary comparison.
   *
   * The PIPELINE does more than this for such a row (review, 15 Oct 2026): unless a person has
   * labelled it, it re-judges the post from the complete read — caption with its @mentions, tags,
   * collaborators, sponsors — and rewrites caption, brands and verdict through `persist`, so this
   * function is reached for an incomplete row only when a human answer must be left standing. Then
   * the pipeline writes the full caption beside what this returns, and the verdict stays the person's.
   */
  if (previous.incomplete) changed.push('completed')

  if (!sameHandles(readStringArray(stored.taggedAccounts), post.taggedAccounts)) changed.push('tags')
  if (!sameHandles(previous.collabHandles, post.collabHandles)) changed.push('collaborators')
  if (!sameHandles(previous.sponsorHandles, post.sponsorHandles)) changed.push('sponsors')
  /**
   * `previous.isPaidPartnership` is `null` for a row stored before the payload existed.
   * Absence is NOT `false` — that is the mistake this codebase has now made five times —
   * so an unknown flag is left alone rather than reported as having changed to false.
   */
  if (previous.isPaidPartnership !== null && previous.isPaidPartnership !== post.isPaidPartnership) {
    changed.push('paid-partnership-flag')
  }

  if (changed.length === 0) return null

  return {
    taggedAccounts: writeStringArray(post.taggedAccounts),
    rawPayload: buildRawPayload(post, now),
    changed,
  }
}

/**
 * Order and case are not evidence. Instagram returns tags in whatever order it likes, and
 * a re-ordered list is the same set of accounts — comparing raw would report a change on
 * every pass and write forever, which is the failure mode this comparison exists to avoid.
 */
function sameHandles(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  const norm = (v: readonly string[]) => [...v].map((h) => h.toLowerCase().replace(/^@/, '')).sort()
  const [x, y] = [norm(a), norm(b)]
  return x.every((v, i) => v === y[i])
}

/**
 * Read back the evidence keys of a stored payload.
 *
 * Forgiving like `readStringArray`, and for the same reason: a hand-edited or truncated
 * cell must cost one comparison, never a detection pass. A row with no payload at all
 * reports its flag as `null` — "we do not know" — never `false`.
 */
function parseRawPayload(raw: string | null): {
  collabHandles: string[]
  sponsorHandles: string[]
  isPaidPartnership: boolean | null
  /** Stored by the official read path, so its lists are "not reported" rather than "none". */
  incomplete: boolean
} {
  const none = { collabHandles: [], sponsorHandles: [], isPaidPartnership: null, incomplete: false }
  if (!raw) return none
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return none
    const rec = parsed as Record<string, unknown>
    return {
      collabHandles: Array.isArray(rec.collabHandles)
        ? rec.collabHandles.filter((v): v is string => typeof v === 'string')
        : [],
      sponsorHandles: Array.isArray(rec.sponsorHandles)
        ? rec.sponsorHandles.filter((v): v is string => typeof v === 'string')
        : [],
      isPaidPartnership: typeof rec.isPaidPartnership === 'boolean' ? rec.isPaidPartnership : null,
      incomplete: rec.evidenceIncomplete === true,
    }
  } catch {
    return none
  }
}
