import type { OutreachSender, SendOutcome, SendRequest } from './types'
import { env } from '@/lib/env'
import { log } from '@/lib/logger'
import { sendDm } from '@/outreach/browser/sendDm'
import { CheckpointError, NotLoggedInError, WrongAccountError } from '@/outreach/browser/session'

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

    try {
      const result = await sendDm({
        senderHandle: req.senderHandle,
        targetHandle: req.targetHandle,
        body: req.body,
        dryRun: env.DRY_RUN,
      })

      if (result.ok) return { status: 'SENT', threadUrl: result.threadUrl }
      return { status: 'FAILED', error: result.reason }
    } catch (err) {
      if (err instanceof CheckpointError) {
        log.warn('INSTAGRAM CHECKPOINT — stopping, not retrying', {
          sender: req.senderHandle,
          url: err.url,
          kind: err.kind,
        })
        return { status: 'FAILED', error: err.message, challenged: true }
      }
      if (err instanceof NotLoggedInError) {
        return { status: 'FAILED', error: err.message }
      }
      if (err instanceof WrongAccountError) {
        return { status: 'FAILED', error: err.message }
      }
      return { status: 'FAILED', error: err instanceof Error ? err.message : String(err) }
    }
  },
}
