import type { OutreachSender, SendOutcome, SendRequest } from './types'
import { log } from '@/lib/logger'

/**
 * The default sender: prepares everything, delivers nothing.
 *
 * The attempt is marked READY and appears in the dashboard tray with the exact
 * body and a link to the recipient's profile. A human sends it.
 *
 * This is the validation gate, not the destination — it exists to prove a message
 * renders correctly and lands with the right person before any account does it
 * unattended. Automating the send is the goal (CLAUDE.md decision 1); the
 * requirements for that phase are recorded there.
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
