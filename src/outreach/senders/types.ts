/**
 * One interface, two implementations. Everything upstream — detection,
 * targeting, the governor, rendering, the dashboard, the audit trail — is
 * identical regardless of which one is active.
 *
 * That is deliberate: graduating from human-confirmed sending to autopilot is a
 * boolean on SenderAccount, not a rewrite.
 */

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
  | { status: 'FAILED'; error: string; challenged?: boolean }

export interface OutreachSender {
  name: string
  send(req: SendRequest): Promise<SendOutcome>
}
