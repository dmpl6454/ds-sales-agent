import { describe, it, expect } from 'vitest'
import { sendNowAnswer, gateRefusalMessage, SEND_NOW_BUSY, SEND_NOW_DB } from '@/app/send-now-message'
import { DELIVER_HELD, type DeliverOneResult } from '@/outreach/deliverResult'

/**
 * ── THE SENTENCES THE SEND BUTTON ANSWERS WITH (Stage 1.3) ────────────────────────────────────
 *
 * `sendNow` stopped carrying its own delivery and became a caller of `deliverOne`; what it says
 * to a person is the one thing that must not move. Every expected string below is the literal
 * the old inline code wrote (read off `git show HEAD~:src/app/actions.ts` at the time of the
 * change), so this is a regression pin against the old words and not against the new code's
 * idea of them. The pure mapper imports only the result TYPES and constants from a leaf module,
 * so it runs here with no database and no browser.
 *
 * The cases that did NOT exist before — the Send button now asks the anonymous page probe and
 * re-asks the sending Mac and the shutdown flag — are marked NEW and only constrain that a person
 * gets a sentence that says nothing was sent. The Send button does NOT read the conversation (a
 * browser drive the refactor must not add), so the read ladders are pinned below only as
 * "answered, though they cannot arrive": the mapper's switch is exhaustive over the ladder.
 *
 * MUTATION, applied by hand to `src/app/send-now-message.ts`, seen red, restored: dropping the
 * ` — nothing sent` suffix from the lost-claim sentence fails "a lost claim"; changing the
 * checkpoint sentence's "Open the account by hand" fails "a checkpoint".
 */

const who = { sender: 'bollywoodchronicle', target: 'tips' }
const drives = 0

describe('the sentences that existed before — byte for byte', () => {
  it('a gate refusal: whose draft, the gate\'s words, and where to press for the one stop that has a button', () => {
    expect(gateRefusalMessage('bollywoodchronicle', 'target-replied', '@tips replied')).toBe('@bollywoodchronicle: @tips replied.')
    expect(gateRefusalMessage('bollywoodchronicle', 'no-session', 'account is not connected')).toBe(
      '@bollywoodchronicle: account is not connected. Press Connect on its row, and log in in the Chrome window that opens.',
    )
    // With no detail the gate's reason stands in for it, as it always did.
    expect(gateRefusalMessage('bollywoodchronicle', 'not-waiting', undefined)).toBe('@bollywoodchronicle: not-waiting.')
  })

  it('a gate refusal reported from INSIDE deliverOne reads exactly like the first refusal', () => {
    const r: DeliverOneResult = { kind: 'held', reason: 'no-session', detail: 'account is not connected', drives }
    expect(sendNowAnswer(r, who).message).toBe(gateRefusalMessage(who.sender, 'no-session', 'account is not connected'))
    expect(sendNowAnswer(r, who).ok).toBe(false)
  })

  it('a lost claim: the status it is in now, then "nothing sent"', () => {
    const r: DeliverOneResult = { kind: 'held', reason: DELIVER_HELD.CLAIM_LOST, detail: 'already sending', drives }
    expect(sendNowAnswer(r, who).message).toBe('already sending — nothing sent')
    expect(sendNowAnswer({ ...r, detail: 'already gone' }, who).message).toBe('already gone — nothing sent')
  })

  it('a fleet allowance refusal: whose draft, the allowance\'s own words', () => {
    const r: DeliverOneResult = { kind: 'stop-tick', why: 'fleet-pace', detail: 'the fleet has already sent 9 message(s) today (limit 9)', drives }
    expect(sendNowAnswer(r, who).message).toBe('@bollywoodchronicle: the fleet has already sent 9 message(s) today (limit 9).')
    // A per-pair refusal arrives as a hold and reads the same.
    const pair: DeliverOneResult = { kind: 'held', reason: 'pair-daily-cap', detail: 'this account has already sent this recipient 5 message(s) today (limit 5)', drives }
    expect(sendNowAnswer(pair, who).message).toBe('@bollywoodchronicle: this account has already sent this recipient 5 message(s) today (limit 5).')
  })

  it('the database did not answer before the send could start', () => {
    const r: DeliverOneResult = { kind: 'stop-tick', why: 'db-fault', detail: 'anything', drives }
    expect(sendNowAnswer(r, who).message).toBe(
      'Nothing was sent — the database did not answer before the send could start. The message is back in the queue; try again in a minute.',
    )
    expect(SEND_NOW_DB).toBe(sendNowAnswer(r, who).message)
  })

  it('another message is being sent right now', () => {
    expect(SEND_NOW_BUSY).toBe('Another message is being sent right now. Nothing was sent — try again in a minute.')
  })

  it('sent', () => {
    expect(sendNowAnswer({ kind: 'sent', threadUrl: 'https://x', drives: 1 }, who)).toEqual({
      ok: true,
      message: 'Sent to @tips from @bollywoodchronicle.',
      refresh: true,
    })
  })

  it('a checkpoint: the account is halted, nothing was retried, and the result says so for the UI', () => {
    const r: DeliverOneResult = { kind: 'failed', ladder: 'challenged', failureCode: 'enforcement', parked: false, challenged: true, detail: 'x', attempts: 1, drives: 1 }
    expect(sendNowAnswer(r, who)).toEqual({
      ok: false,
      challenged: true,
      message:
        'Instagram showed a checkpoint for @bollywoodchronicle. Sending is halted for that account and nothing was retried. Open the account by hand before doing anything else.',
      refresh: true,
    })
  })

  it('a logged-out account', () => {
    const r: DeliverOneResult = { kind: 'failed', ladder: 'session-invalid', failureCode: 'logged-out', parked: false, sessionInvalid: true, detail: 'x', attempts: 1, drives: 1 }
    expect(sendNowAnswer(r, who).message).toBe(
      '@bollywoodchronicle is logged out of Instagram — the message was not sent and is still waiting. Sign the account in again (Connect on the accounts page), then send it.',
    )
  })

  it('the composer cleared and the message never appeared', () => {
    const r: DeliverOneResult = { kind: 'failed', ladder: 'not-in-thread', failureCode: 'not-in-thread', parked: true, detail: 'x', attempts: 1, drives: 1 }
    expect(sendNowAnswer(r, who).message).toBe(
      'The message was accepted by the composer but never appeared in the thread with @tips. ' +
        'It has NOT been re-queued and will not be retried: @tips may already have it. ' +
        'Open the conversation if you want to know which it was — nothing on the dashboard will ask you again, ' +
        'and @bollywoodchronicle will not write to them again.',
    )
  })

  it('the inbox route opened somebody else\'s conversation', () => {
    const r: DeliverOneResult = { kind: 'failed', ladder: 'recipient-parked', failureCode: 'recipient-unconfirmed', parked: true, detail: 'x', attempts: 3, drives: 1 }
    expect(sendNowAnswer(r, who).message).toBe(
      "Nothing was typed: Instagram's search opened a conversation that names somebody other than @tips. The message is parked — re-queue it once the thread can be checked by hand.",
    )
  })

  it('any other failure is the sender\'s own words, untouched', () => {
    const r: DeliverOneResult = { kind: 'failed', ladder: 'retry', failureCode: 'composer-mismatch', parked: false, detail: 'composer content does not match the drafted message', attempts: 1, drives: 1 }
    expect(sendNowAnswer(r, who)).toEqual({ ok: false, message: 'composer content does not match the drafted message', refresh: true })
  })
})

describe('state a person can see changed ⇒ the page is revalidated; a refusal that touched nothing ⇒ it is not', () => {
  it('a hold or a stop that drove nothing does not refresh', () => {
    expect(sendNowAnswer({ kind: 'held', reason: 'no-session', detail: 'x', drives: 0 }, who).refresh).toBe(false)
    expect(sendNowAnswer({ kind: 'stop-tick', why: 'fleet-pace', detail: 'x', drives: 0 }, who).refresh).toBe(false)
  })
  it('a hold after a browser opened does: page state may have moved (the rule is `drives > 0`)', () => {
    // Cannot arise for the button today — it opens no browser before the drive — but the rule is the
    // mapper's, and a future hold that follows a drive must revalidate the page.
    expect(sendNowAnswer({ kind: 'held', reason: 'no-session', detail: 'x', drives: 1 }, who).refresh).toBe(true)
  })
})

describe('NEW to the Send button (it asks the probe, and re-asks the Mac and the shutdown flag) — always a sentence that says nothing was sent', () => {
  it.each([
    [{ kind: 'held', reason: DELIVER_HELD.SENDER_NOT_ACTIVE, detail: '@bollywoodchronicle is challenged right now', drives }],
    [{ kind: 'held', reason: DELIVER_HELD.SENDER_GONE, detail: 'the sending account no longer exists', drives }],
    [{ kind: 'held', reason: DELIVER_HELD.FLAGGED_THIS_RUN, detail: 'this account was flagged by Instagram earlier in this run', drives }],
    [{ kind: 'stop-tick', why: 'shutdown', detail: 'x', drives }],
    [{ kind: 'stop-tick', why: 'role-changed', detail: 'x', drives }],
    [{ kind: 'stop-tick', why: 'autopilot-off', detail: 'x', drives }],
    [{ kind: 'failed', ladder: 'probe-gone', failureCode: 'profile-gone', parked: true, detail: 'x', attempts: 3, drives }],
  ] as [DeliverOneResult][])('%j', (r) => {
    const a = sendNowAnswer(r, who)
    expect(a.ok).toBe(false)
    expect(a.message).toMatch(/not sent|Nothing was sent|nothing was sent|parked/i)
  })

  it('the read ladders cannot arrive from the button, and are answered honestly if they ever do', () => {
    // The Send button does not read the conversation, so neither of these is produced for it. The
    // mapper is exhaustive over the ladder, and a result that arrives anyway must say what the row
    // now carries (`read-unreadable`) or what Instagram showed (`read-checkpoint`), never nothing.
    const unreadable: DeliverOneResult = { kind: 'failed', ladder: 'read-unreadable', failureCode: 'unreadable', parked: false, detail: 'the conversation with @tips could not be read', attempts: 1, drives: 1 }
    expect(sendNowAnswer(unreadable, who)).toEqual({ ok: false, message: 'the conversation with @tips could not be read', refresh: true })
    const checkpoint: DeliverOneResult = { kind: 'failed', ladder: 'read-checkpoint', failureCode: 'checkpoint', parked: false, challenged: true, detail: 'x', attempts: 0, drives: 1 }
    expect(sendNowAnswer(checkpoint, who)).toMatchObject({ ok: false, challenged: true })
  })
})
