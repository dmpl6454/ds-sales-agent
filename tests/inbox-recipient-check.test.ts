import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

/**
 * AUDIT C1 (2026-10-09) — the SHAPE of the inbox route's recipient check, as greps.
 *
 * The decision and the refusal are driven behaviourally in `tests/thread-recipient.test.ts`.
 * What only the source can show is WHERE they sit, and every way this goes wrong is a call
 * site: the check moved after the success return, a caller that never passes the sender, a
 * private copy on one path (this repo's most repeated defect — a door fixed for sending and
 * not for reading), a catch on the read path that swallows a checkpoint, or a new writer of
 * the failure code downstream of the composer, where "nothing was typed" — the reason its
 * reservation is released — would no longer be true. No behavioural test can fail for a
 * call site nobody has written yet.
 */

const root = join(import.meta.dirname, '..')
const read = (p: string) => readFileSync(join(root, p), 'utf8')
const stripComments = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')

const ENTRY = 'src/outreach/browser/messageEntry.ts'
const SEND = 'src/outreach/browser/sendDm.ts'
const READ = 'src/outreach/browser/readThread.ts'

/** The body of `export async function <name>(` up to the next top-level `export`. */
function body(src: string, name: string): string {
  const start = src.indexOf(`export async function ${name}(`)
  expect(start, `${name} must exist`).toBeGreaterThan(-1)
  const end = src.indexOf('\nexport ', start + 1)
  return src.slice(start, end === -1 ? undefined : end)
}

describe('the check sits between Chat and the success return', () => {
  const src = stripComments(read(ENTRY))
  const fn = body(src, 'openThreadViaInbox')

  it('openThreadViaInbox requires a confirmed recipient after Chat and before returning true', () => {
    const chat = fn.indexOf("'the Chat button'")
    const check = fn.indexOf('await requireConfirmedRecipient(page, targetHandle, senderHandle)')
    const ok = fn.lastIndexOf('return true')
    expect(chat).toBeGreaterThan(-1)
    expect(check).toBeGreaterThan(chat)
    expect(ok).toBeGreaterThan(check)
  })

  /**
   * The checkpoint-preemption regression: the session's own errors must come out ahead of the
   * refusal, or a /challenge/ redirect after Chat is filed as an unconfirmed recipient and the
   * flagged account is driven again on the next tick. Behaviourally pinned too.
   */
  it('requireConfirmedRecipient asks for enforcement BEFORE it throws the refusal', () => {
    const fn2 = body(src, 'requireConfirmedRecipient')
    const confirm = fn2.indexOf('confirmInboxThreadRecipient(page, targetHandle, senderHandle)')
    const enforce = fn2.indexOf('await assertNoEnforcement(page, senderHandle)')
    const refuse = fn2.indexOf('throw new RecipientUnconfirmedError')
    expect(confirm).toBeGreaterThan(-1)
    expect(enforce).toBeGreaterThan(confirm)
    expect(refuse).toBeGreaterThan(enforce)
  })

  /** Returning an object would make both callers' `if (!viaInbox)` always false — fail-open. */
  it('still answers a boolean, so a refusal can only arrive as a throw', () => {
    expect(fn).toMatch(/Promise<boolean>/)
  })
})

describe('both callers take the checked door, from the one implementation', () => {
  it('send and read paths both pass the sender', () => {
    expect(stripComments(read(SEND))).toMatch(/await openThreadViaInbox\(page, targetHandle, senderHandle\)/)
    expect(stripComments(read(READ))).toMatch(/await openThreadViaInbox\(page, targetHandle, senderHandle\)/)
  })

  it('and neither defines its own copy of the check', () => {
    for (const f of [SEND, READ]) {
      const s = stripComments(read(f))
      expect(s).not.toMatch(/function (decideThreadRecipient|confirmInboxThreadRecipient|requireConfirmedRecipient|readThreadRecipientEvidence)\b/)
      expect(s).not.toMatch(/class RecipientUnconfirmedError/)
    }
  })

  /** Nothing may be accepted, passed or typed for a recipient the door has not confirmed. */
  it('on the send path the inbox route runs before the interstitial, the Accept and the composer', () => {
    const s = stripComments(read(SEND))
    const inbox = s.indexOf('await openThreadViaInbox(page, targetHandle, senderHandle)')
    expect(s.indexOf('await passBusinessInterstitial(page, targetHandle)')).toBeGreaterThan(inbox)
    expect(s.indexOf('await acceptMessageRequest(page, targetHandle)')).toBeGreaterThan(inbox)
    expect(s.indexOf('await copyToClipboard(body)')).toBeGreaterThan(inbox)
  })

  it('and so on the read path', () => {
    const s = stripComments(read(READ))
    const inbox = s.indexOf('await openThreadViaInbox(page, targetHandle, senderHandle)')
    expect(s.indexOf('await passBusinessInterstitial(page, targetHandle)')).toBeGreaterThan(inbox)
    expect(s.indexOf('await acceptMessageRequest(page, targetHandle)')).toBeGreaterThan(inbox)
  })
})

describe('the read path turns a refusal into unreadable, and nothing else', () => {
  const s = stripComments(read(READ))
  const fn = body(s, 'openAndReadThread')

  it('checks for a dead page before the inbox route, exactly as the send path does', () => {
    const gone = fn.indexOf("Sorry, this page isn't available")
    const inbox = fn.indexOf('await openThreadViaInbox(page, targetHandle, senderHandle)')
    expect(gone).toBeGreaterThan(-1)
    expect(inbox).toBeGreaterThan(gone)
  })

  /**
   * A catch-all here would file a checkpoint, a login form or a 2FA prompt — which the inbox
   * route raises AHEAD of its refusal — as an unreadable thread, and the sweep would drive the
   * flagged account again. Only the refusal is mapped; everything else is rethrown.
   */
  it('maps only RecipientUnconfirmedError, marks it doorRefused, and rethrows everything else', () => {
    const inbox = fn.indexOf('await openThreadViaInbox(page, targetHandle, senderHandle)')
    const after = fn.slice(inbox, inbox + 700)
    expect(after).toMatch(/catch \(e\) \{\s*if \(e instanceof RecipientUnconfirmedError && !deadlineFired\)/)
    expect(after).toMatch(/reason: 'unreadable'[^}]*doorRefused: true/)
    expect(after).toMatch(/throw e\s*\}/)
  })
})

describe("'recipient-unconfirmed' is written only by the door's own handlers", () => {
  /**
   * Its reservation is released because the refusal happens BEFORE anything is typed. A writer
   * anywhere downstream of the composer would make that release unsound — a second message on
   * top of one that may have landed — so the set of files that may carry the code is closed.
   */
  it('appears in code only where it is defined, released, mapped and parked', () => {
    const files: string[] = []
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name)
        if (statSync(p).isDirectory()) {
          if (name !== 'generated') walk(p)
        } else if (/\.tsx?$/.test(name) && stripComments(readFileSync(p, 'utf8')).includes("'recipient-unconfirmed'")) {
          files.push(relative(root, p))
        }
      }
    }
    walk(join(root, 'src'))
    expect(files.sort()).toEqual([
      'src/app/actions.ts',
      'src/lib/constants.ts',
      'src/outreach/deliver.ts',
      'src/outreach/reservations.ts',
      'src/outreach/senders/browser.ts',
    ])
  })
})
