import { DELIVER_HELD, type DeliverOneResult } from '@/outreach/deliverResult'

/**
 * What a person reads after pressing Send — PURE, because it has to be tested in every
 * direction and a server action cannot be.
 *
 * `sendNow` used to carry these sentences inline, interleaved with the claim, the drive and the
 * failure ladder; since Stage 1.3 the delivery is `deliverOne` and the Send button is a caller
 * of it, so what is left of `sendNow` is: the first refusal, the lock, and THIS — the mapping
 * from "what happened" to "what we say". Every sentence below that existed before is
 * byte-for-byte the one `sendNow` wrote; `tests/send-now-message.test.ts` pins each.
 *
 * Imports only the result TYPES and constants from a leaf module, so a test about words opens no
 * database and no browser (the trap `failure-list-cap.test.ts` records for `deliver.ts`).
 *
 * `refresh` says whether state a person can see changed — a claim, a park, a recorded reply,
 * a halted account — so the action revalidates the page exactly when the old inline code did,
 * and not for a refusal that touched nothing.
 */
export interface SendNowAnswer {
  ok: boolean
  message: string
  /** true when the account hit an Instagram checkpoint. Nothing may retry. */
  challenged?: boolean
  refresh: boolean
}

/** The lock was refused: somebody else is sending, or this machine is not allowed to. Nothing was claimed. */
export const SEND_NOW_BUSY = 'Another message is being sent right now. Nothing was sent — try again in a minute.'

/**
 * A database error before the drive could start. Nothing was driven and the draft is waiting.
 * The same sentence for a refused lock acquisition and for a fault between the claim and the
 * drive, because to the person they are the same fact.
 */
export const SEND_NOW_DB =
  'Nothing was sent — the database did not answer before the send could start. The message is back in the queue; try again in a minute.'

/**
 * A gate refusal, as the Send button has always said it: whose draft, the gate's own words, and
 * — for the one stop with a button that fixes it — where to press. The same format answers the
 * first refusal (before the lock) and a hold `deliverOne` reports from inside it, so the person
 * cannot tell which of the two asked.
 */
export function gateRefusalMessage(senderHandle: string, reason: string, detail: string | undefined): string {
  const fix = reason === 'no-session' ? ` Press Connect on its row, and log in in the Chrome window that opens.` : ''
  return `@${senderHandle}: ${detail ?? reason}.${fix}`
}

export function sendNowAnswer(r: DeliverOneResult, who: { sender: string; target: string }): SendNowAnswer {
  switch (r.kind) {
    case 'sent':
      return { ok: true, message: `Sent to @${who.target} from @${who.sender}.`, refresh: true }

    case 'held': {
      // Page state moved only if a browser opened. The Send button does not read, so for it this
      // is false — a refusal that touched nothing does not revalidate the page, as it never did.
      const refresh = r.drives > 0
      if (r.reason === DELIVER_HELD.CLAIM_LOST) {
        return { ok: false, message: `${r.detail} — nothing sent`, refresh }
      }
      if (
        r.reason === DELIVER_HELD.FLAGGED_THIS_RUN ||
        r.reason === DELIVER_HELD.SENDER_GONE ||
        r.reason === DELIVER_HELD.SENDER_NOT_ACTIVE
      ) {
        return { ok: false, message: `${r.detail}. Nothing was sent.`, refresh }
      }
      return { ok: false, message: gateRefusalMessage(who.sender, r.reason, r.detail), refresh }
    }

    case 'stop-tick': {
      const refresh = r.drives > 0
      switch (r.why) {
        case 'fleet-pace':
          return { ok: false, message: `@${who.sender}: ${r.detail}.`, refresh }
        case 'db-fault':
          return { ok: false, message: SEND_NOW_DB, refresh }
        case 'shutdown':
          return { ok: false, message: 'This Mac is shutting down — nothing was sent. The message is still waiting.', refresh }
        case 'role-changed':
          return {
            ok: false,
            message: 'This Mac is no longer the selected sending Mac — nothing was sent. The message is still waiting.',
            refresh,
          }
        case 'autopilot-off':
          // The Send button never asks the switch, so this cannot arrive; the case keeps the switch exhaustive.
          return { ok: false, message: 'Autopilot is off — nothing was sent.', refresh }
        default: {
          const exhaustive: never = r.why
          throw new Error(`unhandled stop: ${String(exhaustive)}`)
        }
      }
    }

    case 'failed':
      switch (r.ladder) {
        case 'challenged':
        case 'read-checkpoint':
          return {
            ok: false,
            challenged: true,
            message: `Instagram showed a checkpoint for @${who.sender}. Sending is halted for that account and nothing was retried. Open the account by hand before doing anything else.`,
            refresh: true,
          }
        case 'session-invalid':
          return {
            ok: false,
            message:
              `@${who.sender} is logged out of Instagram — the message was not sent and is still waiting. ` +
              `Sign the account in again (Connect on the accounts page), then send it.`,
            refresh: true,
          }
        case 'not-in-thread':
          return {
            ok: false,
            message:
              /* This used to end `the message is waiting under "check the thread"` and named a
                 section removed on 2026-08-24. A refusal that sends a person to a screen which
                 cannot answer it is worse than one that says plainly there is nothing to press. */
              `The message was accepted by the composer but never appeared in the thread with @${who.target}. ` +
              `It has NOT been re-queued and will not be retried: @${who.target} may already have it. ` +
              `Open the conversation if you want to know which it was — nothing on the dashboard will ask you again, ` +
              `and @${who.sender} will not write to them again.`,
            refresh: true,
          }
        case 'recipient-parked':
          return {
            ok: false,
            message:
              `Nothing was typed: Instagram's search opened a conversation that names somebody other than @${who.target}. ` +
              `The message is parked — re-queue it once the thread can be checked by hand.`,
            refresh: true,
          }
        /*
         * NEW to the Send button (Stage 1.3): the anonymous probe, asked before a drive as the
         * dispatcher always did. It can only HOLD — it parks a draft aimed at a deleted page
         * with NO browser drive, which is strictly fewer drives than the button used to make.
         *
         * The Send button does NOT read the thread (Stage 1.3 review): the read is a browser
         * drive, and the refactor adds none. So `read-unreadable` and `read-checkpoint` cannot
         * arrive here; they are answered below only so this switch stays exhaustive.
         */
        case 'probe-gone':
          return {
            ok: false,
            message: `@${who.target}'s Instagram page no longer exists (anonymous probe: not found), so nothing was sent. The message is parked and will not be retried.`,
            refresh: true,
          }
        /*
         * `retry` is the ordinary failure — the sender's own words, the draft left intact to retry
         * or send by hand. `drive-gone` and `read-unreadable` are unattended-only (see deliverOne's
         * header) and cannot arrive here; if either ever does, the words the row now carries are
         * still the honest answer.
         */
        case 'retry':
        case 'drive-gone':
        case 'read-unreadable':
          return { ok: false, message: r.detail, refresh: true }
        default: {
          const exhaustive: never = r.ladder
          throw new Error(`unhandled failure ladder: ${String(exhaustive)}`)
        }
      }

    default: {
      const exhaustive: never = r
      throw new Error(`unhandled delivery result: ${JSON.stringify(exhaustive)}`)
    }
  }
}
