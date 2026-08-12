/**
 * One interface, two implementations. Everything upstream — detection,
 * targeting, the governor, rendering, the dashboard, the audit trail — is
 * identical regardless of which one is active.
 *
 * That is deliberate: graduating from human-confirmed sending to autopilot is a
 * boolean on SenderAccount, not a rewrite.
 */

import type { FailureCode } from '@/lib/constants'

export interface SendRequest {
  attemptId: string
  senderHandle: string
  /** Playwright storageState path. Never a password. */
  sessionPath: string | null
  targetHandle: string
  body: string
}

export type SendOutcome =
  | { status: 'SENT'; threadUrl?: string }
  /** Queued for a human to confirm. Not a failure — the normal manual-mode path. */
  | { status: 'READY' }
  /**
   * `failureCode` is the queryable half of `error`. It exists so `not-in-thread` — the
   * composer cleared but the message never appeared — can be told apart from an ordinary
   * failure: that one is both a shadow-restriction signal AND the only failure where the
   * recipient may actually have the message. See FAILURE_CODES.
   *
   * `challenged` and `sessionInvalid` are EVIDENCE for the caller to record, mirroring
   * each other: the sender has no senderId and writes nothing to the database, so the
   * two delivery paths write the fact through the one writer each flag names —
   * `markChallenged` and `markSessionInvalid`. A flag the caller ignores is the
   * every-fifteen-minutes-forever bug this exists to end.
   */
  | { status: 'FAILED'; error: string; failureCode: FailureCode; challenged?: boolean; sessionInvalid?: boolean }

export interface OutreachSender {
  name: string
  send(req: SendRequest): Promise<SendOutcome>
}
