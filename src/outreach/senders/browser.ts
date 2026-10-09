import type { OutreachSender, SendOutcome, SendRequest } from './types'
import { env } from '@/lib/env'
import { log } from '@/lib/logger'
import { sendDm } from '@/outreach/browser/sendDm'
import { RecipientUnconfirmedError, refusalMayRetry } from '@/outreach/browser/messageEntry'
import { recordSendStarted } from '@/outreach/paceClock'
import {
  CheckpointError,
  IdentityCheckFailedError,
  NotLoggedInError,
  TwoFactorRequiredError,
  WrongAccountError,
} from '@/outreach/browser/session'

/**
 * The automated sender: drives the sending account's own logged-in Chrome profile
 * and actually delivers the message.
 *
 * Everything upstream is unchanged. The governor still decides whether a message is
 * permitted, rendering still writes it from scratch, and the audit trail is the
 * same. This swaps out only the last step.
 *
 * Failure policy — the part that matters:
 *
 *   A checkpoint is NEVER retried. If Instagram shows a challenge, a suspension
 *   notice, or a login form where a session was expected, the account is marked
 *   CHALLENGED and every pair using it stops. Retrying into a checkpoint is how a
 *   recoverable flag becomes a ban, and it is the one mistake this project cannot
 *   afford to make. Whoever reads this next: an automatic retry here is not an
 *   improvement.
 *
 *   Everything else fails soft and leaves the draft in place, because a message
 *   that failed to send is recoverable and a message sent twice is not.
 */
export const browserSender: OutreachSender = {
  name: 'chrome-profile',

  async send(req: SendRequest): Promise<SendOutcome> {
    log.step('sending from Chrome profile', {
      sender: req.senderHandle,
      target: req.targetHandle,
      chars: req.body.length,
      dryRun: env.DRY_RUN,
    })

    /**
     * THE PACE CLOCK IS STAMPED HERE — the moment a message drive actually begins.
     *
     * This function is the ONE implementation every delivered message passes through
     * (the dispatcher's `deliverWaiting` and the dashboard's operator send both call it,
     * and both hold the fleet send lock, so the stamp cannot race). Before `sendDm` so
     * the gap stays a PERIOD rather than idle time bolted onto a ~47s drive; a failed
     * drive still counts, because the bound paces BROWSER DRIVES, not deliveries.
     *
     * It moved here from `withSendLock` on 2026-08-21: stamping on lock ACQUISITION let
     * a dispatch tick that then delivered nothing reset the clock — twelve consecutive
     * minutes of "the last message went out 0 minute(s) ago" with zero sends, measured
     * in watch.log the same evening the lock-level stamp shipped.
     */
    await recordSendStarted(new Date())

    try {
      const result = await sendDm({
        senderHandle: req.senderHandle,
        targetHandle: req.targetHandle,
        body: req.body,
        dryRun: env.DRY_RUN,
      })

      if (result.ok) return { status: 'SENT', threadUrl: result.threadUrl }
      return { status: 'FAILED', error: result.reason, failureCode: result.failureCode }
    } catch (err) {
      if (err instanceof CheckpointError) {
        log.warn('INSTAGRAM CHECKPOINT — stopping, not retrying', {
          sender: req.senderHandle,
          url: err.url,
          kind: err.kind,
        })
        return { status: 'FAILED', error: err.message, failureCode: 'enforcement', challenged: true }
      }
      /**
       * A 2FA prompt is NOT enforcement, so `challenged` stays absent.
       *
       * This used to arrive as a CheckpointError because `/two_factor` was in
       * CHECKPOINT_PATHS - so a routine re-verification on a 2FA-enabled account marked
       * it CHALLENGED and halted every pair using it, with nothing retrying by design.
       * The draft is kept and a human enters the code.
       */
      if (err instanceof TwoFactorRequiredError) {
        log.warn('Instagram asked for a 2FA code — the account is NOT flagged', {
          sender: req.senderHandle,
        })
        // Its own code, not `navigation`: a retry cannot type the code, a human can.
        return { status: 'FAILED', error: err.message, failureCode: 'two-factor' }
      }
      /**
       * The session is DEAD (or belongs to someone else) — a login form where a session
       * was expected. `sessionInvalid: true` is the evidence flag the caller must record
       * through `markSessionInvalid`, exactly as `challenged: true` is recorded through
       * `markChallenged` above.
       *
       * These were `failureCode: 'navigation'` — the retryable code — so the dispatcher
       * drove a browser at the dead session every fifteen minutes forever while
       * `hasSession` (a cookie-on-disk check) kept the dashboard saying "connected".
       */
      if (err instanceof NotLoggedInError) {
        return { status: 'FAILED', error: err.message, failureCode: 'logged-out', sessionInvalid: true }
      }
      if (err instanceof WrongAccountError) {
        return { status: 'FAILED', error: err.message, failureCode: 'logged-out', sessionInvalid: true }
      }
      // Could not reach Instagram to confirm identity. Not a checkpoint, not an expiry -
      // just try again next slot.
      if (err instanceof IdentityCheckFailedError) {
        return { status: 'FAILED', error: err.message, failureCode: 'navigation' }
      }
      /**
       * The inbox route opened a conversation that could not be confirmed as this recipient's
       * (audit C1, 2026-10-09). A question about the RECIPIENT, never the sender: no
       * `challenged`, no `sessionInvalid` — the account is fine and must not be halted or
       * sent to a re-login over it. Nothing was typed or accepted, so the reservation is
       * released (`recipient-unconfirmed` is in DEFINITELY_NOT_DELIVERED). The handle goes into
       * `error` only, which nothing regex-tests; the error's own message names nobody.
       *
       * The VERDICT travels on as `recipientRetryable` (review of C1): only a `mismatch` — a
       * conversation naming somebody else — parks on first sight. `unknown` and `ambiguous` are
       * what a transient miss at the profile door looks like, and parking them retired a
       * healthy route over one slow render; they take the ordinary retry path instead.
       */
      if (err instanceof RecipientUnconfirmedError) {
        const retryable = refusalMayRetry(err.verdict)
        log.warn(
          retryable
            ? 'the inbox route could not confirm the recipient — nothing typed, the draft goes back to be retried'
            : 'the inbox route opened somebody else’s conversation — nothing typed, the draft is parked',
          { sender: req.senderHandle, target: req.targetHandle, verdict: err.verdict.kind },
        )
        return {
          status: 'FAILED',
          error: `${err.message} (@${req.targetHandle})`,
          failureCode: 'recipient-unconfirmed',
          ...(retryable ? { recipientRetryable: true } : {}),
        }
      }
      return { status: 'FAILED', error: err instanceof Error ? err.message : String(err), failureCode: 'unknown' }
    }
  },
}
