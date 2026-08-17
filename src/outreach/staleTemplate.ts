/**
 * DOES THIS STORED BODY STILL HAVE THE SHAPE THE CURRENT RENDERER PRODUCES?
 *
 * ── WHY THIS EXISTS ───────────────────────────────────────────────────────
 *
 * A drafted body is rendered ONCE and frozen. That is deliberate — the composer read-back
 * compares against exactly the stored bytes, and an operator may have edited them by hand —
 * but it means a change to `renderMessage` leaves every waiting draft carrying the previous
 * copy, indefinitely, with nothing on any screen saying so.
 *
 * MEASURED 2026-08-17, the day the merged opener shipped: **46 of 46 waiting drafts still
 * carried the two-element join**, the oldest written on 11 August. Every one was blocked by
 * an unrelated stop (`no-session` 31, `persona-changed-since-draft` 15), so the queue looked
 * healthy while none of it was sendable and none of it said why.
 *
 * ── THE PROPERTY, AND WHY IT IS THIS ONE ──────────────────────────────────
 *
 * `renderMessage` builds `opener = `${buildGreeting(target)} ${introLine(persona)}``, ONE
 * line. Before 2026-08-17 the array held a bare `''` between them and `join('\n')` turned it
 * into a blank line, so Instagram — which previews only the FIRST line in the inbox list —
 * showed every recipient `Hi Crocs India team,` and nothing else.
 *
 * So the current renderer CANNOT emit the greeting standing alone on line 1. A body that
 * does is provably pre-merge. That is a structural fact about the writer, not a guess about
 * the text, which is why this reads the opener rather than pattern-matching the copy.
 *
 * ── THREE OUTCOMES, AND `unknown` IS THE LOAD-BEARING ONE ─────────────────
 *
 * The destructive direction here is `stale` — the caller discards. So anything this cannot
 * read must NOT resolve to `stale`, and a two-valued boolean would make that the fall-through
 * default the first time somebody added a case. `unknown` is therefore its own member:
 *
 *   `stale`    line 1 is exactly the greeting → the old two-element join
 *   `current`  line 1 carries more than the greeting → the merged opener
 *   `unknown`  we cannot tell — an empty body, or an opener that does not begin with the
 *              greeting at all, which is what a HAND-EDITED body looks like
 *
 * A hand-edited body is precisely the case where discarding throws away a person's work, and
 * it is indistinguishable from a rendering we do not recognise. Both are `unknown`, both are
 * kept, and the caller reports them rather than swallowing them — *absence of data must never
 * harden into a verdict*, which this codebase has now produced five times in other places.
 *
 * PURE. No database, no clock. The caller supplies the greeting the current renderer would
 * produce for that recipient, from `buildGreeting` itself — writer and probe sharing bytes,
 * for the same reason `signatureBlock` backs the persona staleness probe in `gate.ts`.
 */

import { isGreetingOnlyLine } from '@/outreach/render'

export type OpenerShape = 'stale' | 'current' | 'unknown'

export interface OpenerVerdict {
  shape: OpenerShape
  /** Prose for a CLI line or an audit row. Never a bare code. */
  detail: string
}

export interface OpenerInput {
  /** `OutreachAttempt.renderedBody` — the exact bytes the send guards compare against. */
  renderedBody: string | null
  /**
   * What `buildGreeting(target)` returns for this recipient TODAY.
   *
   * Passed in rather than computed here so this module stays pure and so the comparison is
   * against the real writer. Computing a second greeting here is how a probe and its writer
   * drift apart, which `readThread.ts` did for weeks under a comment claiming they had not.
   */
  greetingNow: string
}

export function classifyOpener(input: OpenerInput): OpenerVerdict {
  const body = input.renderedBody ?? ''
  const greeting = input.greetingNow.trim()

  if (body.trim() === '') {
    return { shape: 'unknown', detail: 'the stored body is empty, so its shape cannot be read' }
  }
  if (greeting === '') {
    return { shape: 'unknown', detail: 'no greeting could be built for this recipient, so there is nothing to compare against' }
  }

  const lines = body.split('\n')
  const first = (lines[0] ?? '').trim()

  /**
   * THE TEST IS "IS LINE 1 A GREETING AND NOTHING ELSE", NOT "DOES IT EQUAL TODAY'S
   * GREETING", and the difference was found by running this against the live queue.
   *
   * Equality looked right and quietly under-reported. `usableBrandName` shipped in the same
   * period and changed what `buildGreeting` returns for every recipient whose display name
   * was a raw handle — @agoracitycentre now greets as "Hi there," while its frozen body still
   * says "Hi agoracitycentre team,". Those five drafts carry the WORST copy in the queue (the
   * raw-handle greeting this project fixed twice) and equality filed all five as
   * "probably edited by hand", which is both wrong and the one explanation that stops a
   * reader acting on it.
   *
   * The structural fact does not depend on the greeting at all: the old join put a greeting
   * ALONE on line 1 and the current renderer never does, because the opener continues into
   * `introLine` and ends in a full stop. So the pattern is the honest probe, and it is
   * imported from `render.ts` rather than restated here.
   */
  if (isGreetingOnlyLine(first)) {
    const changed = first !== greeting
    return {
      shape: 'stale',
      detail:
        `line 1 is the greeting "${first}" standing alone, which is the pre-2026-08-17 join — Instagram previews only that line` +
        (changed ? `; the greeting has since changed to "${greeting}", so this body is doubly out of date` : ''),
    }
  }

  /**
   * The merged opener starts WITH the greeting and continues on the same line. Requiring the
   * prefix rather than merely "line 1 differs from the greeting" is what keeps a hand-edited
   * body out of `current` as well as out of `stale`: an operator who rewrote the opening is
   * reported, not quietly filed as up to date.
   */
  if (first.startsWith(greeting) && first.length > greeting.length) {
    return { shape: 'current', detail: 'the greeting and the introduction share line 1, which is the current shape' }
  }

  return {
    shape: 'unknown',
    detail: `line 1 does not begin with the greeting "${greeting}" — this body was probably edited by hand, so it is left alone`,
  }
}
