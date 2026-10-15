/**
 * What `deliverOne` can tell its two callers — types and constants only, no imports of
 * anything that touches the database or a browser.
 *
 * A LEAF ON PURPOSE, for the reason `src/lib/constants.ts` and `src/outreach/shutdown.ts` are
 * leaves: the dashboard's Send button maps these results to sentences
 * (`src/app/send-now-message.ts`, PURE, unit-tested), and a module that imported `deliverOne.ts`
 * to get a constant would pull the whole browser stack into a test that is only about words
 * — the same trap `failure-list-cap.test.ts` records for `deliver.ts` and
 * `MAX_DELIVERY_ATTEMPTS`. `deliverOne.ts` re-exports everything here, so the names its callers
 * import still come from the one function that produces them.
 *
 * ── WHO SAYS WHAT ─────────────────────────────────────────────────────────────────────────
 *
 * `deliverOne` owns what HAPPENED: every state transition, claim, settle and audit row. Its
 * callers own how to SAY it: the dispatcher's loop writes its `DeliverResult.outcomes` lines
 * (the dashboard's "why nothing was sent" tape), the Send button writes its `SendNowResult`
 * sentence. The two vocabularies differ today and must keep differing — one is a log line for
 * an operator watching a queue, the other an answer to a person who just pressed a button —
 * which is why the result is structured rather than a string.
 */

/**
 * WHO IS ASKING, and the only thing the two callers are allowed to differ by.
 *
 * `unattended: true` is the dispatcher: no human is present, so the autopilot switch is
 * re-asked, the gate drops any override, the hour bucket is claimed, and a retryable failure
 * parks at the retry cap. `unattended: false` is the Send button: a person is present and chose
 * THIS draft, so the switch does not apply, `overrides` (already narrowed to
 * OVERRIDABLE_BLOCKS by the gate, never trusted as given) travel to the gate, the hour bucket is
 * skipped, and the failure leaves the draft intact for them to retry or send by hand.
 */
export type DeliverMode =
  | { unattended: true }
  | { unattended: false; operator: string; overrides?: readonly string[] }

/** Why a tick should stop rather than carry on to the next draft. */
export type StopWhy =
  /** The switch went off while the tick evaluated. Unattended only — a person substitutes for it. */
  | 'autopilot-off'
  /** SIGTERM landed: nothing new may start a drive. */
  | 'shutdown'
  /** Another Mac was selected while the tick evaluated. */
  | 'role-changed'
  /** The FLEET's hourly pace or daily cap is spent — true of every remaining draft, not just this one. */
  | 'fleet-pace'
  /** A database error between the claim and the drive: the draft went back, the next claim would meet the same fault. */
  | 'db-fault'

/**
 * Which branch of the failure ladder handled a `failed` result.
 *
 * The caller needs more than `failureCode` and `parked` to find its sentence: a `recipient-unconfirmed`
 * that parked on FIRST sight (a mismatch) and one that parked at the retry cap after a transient
 * door miss are both `parked: true` under the same code and read differently to a person.
 */
export type FailedLadder =
  /** The pre-send read hit a checkpoint. The account is halted; nothing was written about the draft. Unattended only: the Send button does not read. */
  | 'read-checkpoint'
  /** The pre-send read drove a browser and came back unusable (`unreadable` / `incomplete`). Unattended only, like the read itself. */
  | 'read-unreadable'
  /** The anonymous probe said the recipient's page no longer exists. No browser was driven. */
  | 'probe-gone'
  /** The drive hit an Instagram checkpoint. The account is halted. */
  | 'challenged'
  /** The drive found a login form where a session was expected. The session is recorded dead. */
  | 'session-invalid'
  /** The drive itself met "Sorry, this page isn't available". Unattended only — see deliverOne's header. */
  | 'drive-gone'
  /** The inbox route opened somebody else's conversation. Parked on first sight. */
  | 'recipient-parked'
  /** The composer cleared and the message never appeared. Parked; the recipient may have it. */
  | 'not-in-thread'
  /** Everything else: the ordinary retryable failure (and its cap, for the unattended caller). */
  | 'retry'

/**
 * The reasons a `held` result carries that are NOT a gate verdict. Everything else in
 * `held.reason` is a `RESEND_BLOCKS` value (or the pre-send read's own reason), and a caller may
 * render those through the gate's sentence format. These four are `deliverOne`'s own checks and
 * already read as sentences.
 *
 * `CLAIM_LOST` means the draft was taken by someone else before this call could write it: a
 * concurrent claim at the READY→SENDING step, or a discard / edit landing while the dispatcher's
 * pre-send read was running (the unreadable-read write is conditional on the row still waiting).
 * Its `detail` says what the row is now: `already being sent` (the dispatcher's claim),
 * `already <status>` (the button's claim, and the read's conditional write).
 *
 * The disk check's hold deliberately uses the gate's own `'no-session'` string instead of a
 * fifth entry here: it IS that stop, asked earlier and for free, so every caller that renders a
 * `no-session` refusal (with its "press Connect" hint) renders this one the same way.
 */
export const DELIVER_HELD = {
  FLAGGED_THIS_RUN: 'flagged-this-run',
  SENDER_GONE: 'sender-gone',
  SENDER_NOT_ACTIVE: 'sender-not-active',
  CLAIM_LOST: 'claim-lost',
} as const

export type DeliverOneResult =
  /** Nothing was claimed or driven for a rule's sake, or a guard stood in the way. `drives` may be 1 for the dispatcher: its read can be what held it. */
  | { kind: 'held'; reason: string; detail: string; drives: number }
  | { kind: 'sent'; threadUrl: string | null; drives: number }
  | {
      kind: 'failed'
      ladder: FailedLadder
      failureCode: string
      /** The row now sits in FAILED, where nothing automatic picks it up. */
      parked: boolean
      challenged?: boolean
      sessionInvalid?: boolean
      /** What the row now carries as its `error` — the sender's own words, the read's, or the probe's. */
      detail: string
      /** The attempt count the row carries after this outcome. */
      attempts: number
      drives: number
    }
  /** The tick (or the button press) must end here; see `StopWhy`. `detail` is the hold sentence for the two that hold. */
  | { kind: 'stop-tick'; why: StopWhy; detail: string; drives: number }
