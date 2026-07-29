import type { OutreachSender, SendOutcome, SendRequest } from './types'
import { log } from '@/lib/logger'

/**
 * The default sender: prepares everything, delivers nothing.
 *
 * The attempt is marked READY and appears in the dashboard tray with the exact
 * body and a deep link that opens the thread. A human taps send.
 *
 * This is the validation gate, not a permanent mode — it exists to prove that a
 * message renders correctly and lands with the right person before any account
 * starts doing it unattended. At Phase 1 volume (peak 2 DMs/day) it costs about a
 * minute a week.
 */
export const manualAssistSender: OutreachSender = {
  name: 'manual-assist',

  async send(req: SendRequest): Promise<SendOutcome> {
    log.step('queued for human confirmation', {
      sender: req.senderHandle,
      target: req.targetHandle,
      chars: req.body.length,
    })
    return { status: 'READY' }
  },
}

/** Opens the DM thread with a handle. Works on desktop web and mobile app. */
export function threadDeepLink(targetHandle: string): string {
  return `https://ig.me/m/${targetHandle}`
}
