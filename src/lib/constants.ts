/**
 * SQLite has no enum type, so status columns are plain strings. These unions are
 * the single source of truth for the allowed values — every write goes through
 * them so a typo becomes a compile error instead of a silently invalid row.
 */

/**
 * ── A POST IS PAID OR IT IS ORDINARY. THERE IS NO IN BETWEEN (2026-08-17) ──
 *
 * Tabish: *"no more indecisiveness, either a post is paid or unpaid/ordinary, no in between
 * or borderline or worth a look or manual."*
 *
 * `REVIEW` is GONE. It meant "a person should look at this", and it had two producers:
 *
 *   the confidence floor      a CAMPAIGN under 70% was downgraded. MEASURED: **0 rows** in
 *                             the entire corpus ever carried `downgraded:confidence-below-70`.
 *                             The band never fired once.
 *   the footage               `applyFrameSignal` raised a caption ORGANIC to REVIEW when the
 *                             video's text disagreed. **18 of the 26 live REVIEW rows.**
 *
 * So removing it forces a real decision about the second one, and the decision is Tabish's:
 * **footage-flagged posts become CAMPAIGN.** That trades precision for recall, which is the
 * direction this project always chooses — *a missed paid post is invisible and unappealable,
 * a false alarm becomes a row a person crosses off in one click.* The cross on `/paid-posts`
 * is that corrective, and it is the only labelling control that now exists.
 *
 * `UNCLASSIFIED` survives and is NOT a third verdict. It means NOT JUDGED — a failed call, no
 * API key, a caption too short to be a pitch — and it has never meant "ordinary". Collapsing
 * it into ORGANIC would be *absence of data hardening into a negative verdict*, which is the
 * failure this codebase has now produced five times.
 */
export const VERDICTS = ['CAMPAIGN', 'ORGANIC', 'UNCLASSIFIED'] as const
export type Verdict = (typeof VERDICTS)[number]

export const ATTEMPT_STATUSES = [
  'QUEUED', // created by the planner, not yet surfaced
  'READY', // written and waiting to be sent
  // A lock, not a phase. Set for the ~40 seconds the browser is driving, so a
  // second click (or the worker racing the dashboard) cannot send the same message
  // twice. Anything counting messages in flight MUST include it — the whole point
  // is that a SENDING row might already be delivered.
  'SENDING',
  'SENT', // delivered and confirmed present in the thread
  'SKIPPED', // superseded or cancelled before sending
  'FAILED', // send attempted and failed
  'REPLIED', // target replied — halts all senders to this target
] as const
export type AttemptStatus = (typeof ATTEMPT_STATUSES)[number]

/**
 * Statuses meaning "the recipient has this message".
 *
 * ALWAYS use this to count delivered messages. `REPLIED` REPLACES `SENT`, it does
 * not add to it — so a bare `status: 'SENT'` count *drops a message the moment
 * someone answers it*, which makes the best outcome available silently decrement
 * your headline number. That had been wrong in `ig:audit` since the beginning and
 * was never observably wrong, because until replies became recordable nothing
 * could hold status REPLIED. It was then fixed there and left wrong in the
 * dashboard, which is why this now lives in one place instead of four.
 */
export const DELIVERED_STATUSES = ['SENT', 'REPLIED'] as const

/**
 * Statuses meaning "this message exists and may reach a human" — delivered, or
 * drafted and still reachable by a Send button.
 *
 * This is what a lifetime ceiling must count. Counting only delivered messages
 * would let the planner draft every pair before the ceiling bound: with a ceiling
 * of 1 and four routing pairs, four messages get written and the ceiling binds
 * after the damage is on disk. `SENDING` is included because a browser mid-send
 * might already have delivered.
 */
export const IN_FLIGHT_STATUSES = ['SENT', 'REPLIED', 'SENDING', 'READY', 'QUEUED'] as const

/**
 * How many delivery failures one draft may accumulate before it stops being offered to the
 * loop and parks in `FAILED`. Three, matching the counter the incident reached before a
 * person stepped in — enough to ride out a transient (a slow render, a network blip), few
 * enough that a structural refusal (an account that cannot be messaged) stops costing a
 * browser drive per minute against a revenue account.
 *
 * ── WHY IT LIVES HERE AND NOT IN `deliver.ts` (2026-08-24) ─────────────────
 *
 * The SCREEN now reads it too: the failures list shows only drafts that have exhausted the
 * cap, so the page and the enforcer must agree by construction rather than by a literal 3
 * typed twice — the `DELIVERED_STATUSES` lesson, which drifted across four call sites before
 * it moved into this file. `deliver.ts` re-exports it, so the enforcer's own import is
 * unchanged; the reason for the move is that `deliver.ts` reaches the browser stack, and a
 * view model importing it to read one number would pull Patchright into the Next server
 * bundle. Same reasoning as `dbPool.ts`: a number you want to READ must cost nothing to read.
 */
export const MAX_DELIVERY_ATTEMPTS = 3

export const SENDER_STATUSES = ['ACTIVE', 'PAUSED', 'CHALLENGED'] as const
export type SenderStatus = (typeof SENDER_STATUSES)[number]

/**
 * Why a send failed, in a form that can be queried. `OutreachAttempt.failureCode`.
 *
 * `error` holds prose for a human and always will. This exists because ONE of these is
 * categorically different from the rest and the difference is invisible in a sentence:
 *
 *   not-in-thread   The composer CLEARED — Instagram accepted the keystroke — and the
 *                   message then never appeared in the conversation. Two things are true
 *                   at once and both matter: it is what a shadow restriction looks like
 *                   from the outside, and it is the ONLY failure where the recipient may
 *                   actually have the message. Retrying it risks retrying into a
 *                   restriction AND sending a duplicate, which is why it must never be
 *                   counted alongside "the paste did not land".
 *
 *   still-staged    Enter did nothing; the text is still in the composer. Certainly not
 *                   delivered, and safe to retry.
 *   composer-mismatch  The read-back before Enter did not match the drafted body. Nothing
 *                   was sent, by design — this is the guard working.
 *   no-composer     The thread opened but no message box was found. A DOM change, or the
 *                   account cannot message this person.
 *   no-message-button  The profile has no Message button.
 *   enforcement     An "Action Blocked"-class notice. The account is halted separately.
 *   logged-out      A login form — or the WRONG account — where a session was expected.
 *                   Not retryable by machine: only a hand login fixes it. Split out of
 *                   `navigation` 2026-08-06, where it was indistinguishable from a
 *                   network blip and so was retried every fifteen minutes forever while
 *                   the dashboard said "connected". The sender also writes the evidence
 *                   to `SenderAccount.sessionInvalidAt` via `markSessionInvalid`.
 *   two-factor      Instagram asked for a 2FA code. Not enforcement, not retryable by
 *                   machine — a human enters the code. Split out of `navigation` with
 *                   `logged-out`, because the two human fixes are different.
 *   navigation      Could not reach the profile or the thread. The one transient code —
 *                   the only member of the old `navigation` family a retry can help.
 *   unknown         A failure that predates this column, or one nothing has classified.
 *
 * A code that is not in this list must never be written: `failureCode` is the field a
 * later retry policy will read, and an unrecognised value would fall through whatever
 * `switch` reads it — silently, in the permissive direction.
 */
export const FAILURE_CODES = [
  'not-in-thread',
  'still-staged',
  'composer-mismatch',
  'no-composer',
  'no-message-button',
  'enforcement',
  'logged-out',
  'two-factor',
  'navigation',
  'unknown',
] as const
export type FailureCode = (typeof FAILURE_CODES)[number]

export const TARGET_KINDS = ['CHANNEL', 'BRAND'] as const
export type TargetKind = (typeof TARGET_KINDS)[number]

export const RUN_STATUSES = ['OK', 'PARTIAL', 'FAILED'] as const
export type RunStatus = (typeof RUN_STATUSES)[number]

/**
 * Which ChannelDetector handles a target. Registry lives in src/detection/detectors.
 *
 * `semantic` was MISSING here while `@viralbhayani` ran on it in production — this list
 * said `['mom', 'passthrough']` and the schema comment agreed. It was inert only because
 * nothing validates the string on write and `getDetector` falls back to `passthrough`
 * rather than throwing, which is exactly what made it invisible.
 *
 * The danger is not the omission itself, it is the next `switch`: a hardcoded
 * `detectorKey === 'passthrough'` check already rendered **"Paid campaigns found: 0"**
 * for a channel where roughly half of ~62 posts/day are commercial. A union that lies
 * about the registry is how that happens again. `tests/detectors.test.ts` now asserts the
 * two cannot diverge.
 */
export const DETECTOR_KEYS = ['mom', 'semantic', 'passthrough'] as const
export type DetectorKey = (typeof DETECTOR_KEYS)[number]

/**
 * What a `@mention` in a paid caption turned out to be. Mirrors `BrandLookup.kind`.
 *
 * FIVE values, not four. `UNRESOLVED` existed in `resolveBrand.ts` and in four live rows
 * while both the schema comment and this file omitted it — and it is the one that most
 * needs saying out loud, because two of these are different kinds of "don't know":
 *
 *   BRAND       professional account, category is not a person-role
 *   PERSON      a person-role category, or a non-pro account WITH a category
 *   MISSING     the handle does not exist (HTTP 404)
 *   UNRESOLVED  we READ the profile and the data is not there. Retrying will NOT help;
 *               a human must decide. Never a negative verdict.
 *   UNKNOWN     we never got to look — rate-limited or a network error. Retrying WILL
 *               help. Cached, but NEVER read back as an answer.
 *
 * Collapsing `UNRESOLVED` into `PERSON` is the bug this list exists to prevent: a brand
 * that simply left its category blank was discarded permanently with nothing on screen
 * to say so. Absence of data must never harden into a negative verdict.
 */
export const BRAND_LOOKUP_KINDS = ['BRAND', 'PERSON', 'MISSING', 'UNRESOLVED', 'UNKNOWN'] as const
export type BrandLookupKind = (typeof BRAND_LOOKUP_KINDS)[number]

/**
 * Which pool a `MessageVariant` belongs to — the channel pitch or the brand pitch.
 *
 * A channel is pitched a partnership; a brand is pitched media buying. Different
 * proposition, different reader. Variants are keyed by `senderId` alone, so without this
 * discriminator every media-buying body would be reachable for a publisher and vice
 * versa — the pool would silently become one pool.
 */
export const VARIANT_TARGET_KINDS = ['CHANNEL', 'BRAND'] as const
export type VariantTargetKind = (typeof VARIANT_TARGET_KINDS)[number]

/**
 * Instagram's own limits, for reference and for the guards in the governor.
 * Meta cut the hard outbound cap to 200/hour in Oct 2024. Community-observed
 * safe cold-DM volume is ~20/day for an aged, warmed account. Phase 1 peaks at
 * 2 DMs/day total, i.e. ~3% of capacity across three senders.
 */
export const IG_LIMITS = {
  hardCapPerHour: 200,
  safeColdDmsPerAccountPerDay: 20,
} as const

/** The publisher channels being watched in Phase 1. */
export const TARGET_HANDLES = {
  mom: 'madovermarketing_mom',
  viralbhayani: 'viralbhayani',
} as const

/**
 * Follower counts, for display only. A point-in-time snapshot (2026-07-29) rather
 * than a live figure — it exists so the dashboard can show scale at a glance, and
 * fetching it every render would be an Instagram request bought for nothing.
 */
export const FOLLOWER_SNAPSHOT: Record<string, string> = {
  madovermarketing_mom: '1.5M',
  viralbhayani: '15.6M',
}
