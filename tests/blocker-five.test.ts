import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * BLOCKER 5 — THEY MESSAGED US FIRST, so the conversation opens on a REQUEST and not a
 * composer. Found by Tabish from a screenshot, 2026-08-21.
 *
 * *"Accept message request from Soham Rockstar Entertainment (sohamrockstrent)?"* with
 * **Block · Delete · Accept** and no composer anywhere. The send timed out looking for one and
 * was filed `no-composer` — a name asserting the account cannot be messaged, about an account
 * that had literally just messaged us. MEASURED: @sohamrockstrent collected six parked drafts
 * at three attempts each on this door, eighteen browser drives at one revenue profile.
 *
 * ── WHY THIS FILE IS GREPS ────────────────────────────────────────────────
 *
 * The behaviour needs a real Instagram DOM, so what is testable without one is the SHAPE, and
 * the shape is where every previous blocker went wrong: fixed on the send path and not the
 * read path (recorded four times in CLAUDE.md), or a click that could land on a destructive
 * button. Both are properties of the source, and neither can fail for a caller nobody has
 * written yet — the same instrument as `tests/one-judging-path.test.ts`.
 */

const root = join(import.meta.dirname, '..')
const read = (p: string) => readFileSync(join(root, p), 'utf8')

const ENTRY = 'src/outreach/browser/messageEntry.ts'
const SEND = 'src/outreach/browser/sendDm.ts'
const READ = 'src/outreach/browser/readThread.ts'

describe('blocker 5 lives in the shared module and both paths take it', () => {
  it('the door is defined once, in messageEntry', () => {
    expect(read(ENTRY)).toMatch(/export async function acceptMessageRequest/)
  })

  /**
   * The defect this repo has produced four times: a recipient-side door solved for sending and
   * not for reading, so the thread can never be checked for a reply afterwards. For blocker 5
   * it is worse than usual — an unaccepted request IS a message someone sent us, so the thread
   * most likely to hold a real enquiry would be the one permanently unreadable.
   */
  it('BOTH the send path and the read path call it', () => {
    expect(read(SEND)).toMatch(/acceptMessageRequest\(page, targetHandle\)/)
    expect(read(READ)).toMatch(/acceptMessageRequest\(page, targetHandle\)/)
  })

  it('and both import it from the shared module rather than re-implementing it', () => {
    for (const f of [SEND, READ]) {
      expect(read(f)).toMatch(/acceptMessageRequest,/)
      /* No private copy: only messageEntry may define it. */
      expect(read(f)).not.toMatch(/async function acceptMessageRequest/)
    }
  })
})

describe('only the safe button is ever clicked', () => {
  const src = read(ENTRY)
  const fn = src.slice(src.indexOf('export async function acceptMessageRequest'), src.indexOf('export async function passBusinessInterstitial'))

  /**
   * Delete throws away an inbound message from a real company — the most valuable thing this
   * system can receive — and Block severs the relationship permanently. Neither is undoable
   * from here, so neither may ever appear as a click target. Same discipline as blocker 3,
   * where "Not Now" is the only button ever pressed.
   */
  it('never references Delete or Block as something to click', () => {
    expect(fn).not.toMatch(/getByRole\('button', \{ name: \/\^?delete/i)
    expect(fn).not.toMatch(/getByRole\('button', \{ name: \/\^?block/i)
    expect(fn).not.toMatch(/hasText: \/\^Delete\$\//)
    expect(fn).not.toMatch(/hasText: \/\^Block\$\//)
  })

  /**
   * ANCHORED, not a substring. The panel's own prose contains "Accept message request from …",
   * so a `hasText` match on "Accept" would click whichever element carried the sentence. The
   * exact-username lesson from blocker 4, one dialog along.
   */
  it('matches Accept exactly, so the surrounding prose cannot be clicked', () => {
    expect(fn).toMatch(/\/\^accept\$\/i/)
    expect(fn).toMatch(/\/\^Accept\$\//)
  })

  /**
   * A bare "Accept" is not enough evidence on its own — the panel must also read like a
   * message request. Refusing on doubt costs one `no-composer`; clicking the wrong Accept
   * changes account state nothing here can see or undo.
   */
  it('confirms the panel really is a message request before clicking', () => {
    expect(fn).toMatch(/accept message request\|wants to send you a message/)
    expect(fn).toMatch(/if \(!looksLikeRequest\) return false/)
  })

  /** It reports whether it acted, so the caller can re-check for dialogs on the transition. */
  it('returns a boolean rather than swallowing the outcome', () => {
    expect(fn).toMatch(/Promise<boolean>/)
    expect(fn).toMatch(/return true/)
  })
})
