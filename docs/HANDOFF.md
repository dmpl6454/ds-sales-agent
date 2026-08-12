# This file is closed. Read `CLAUDE.md`.

**Stopped 2026-08-08, by instruction.** Everything that was still true in this file has
been folded into `CLAUDE.md`, and forward work now lives in `docs/specs/<date>-<name>.md`.

## Why it was retired

It was an append-only log of sessions, and that shape guarantees the failure it eventually
produced: **two entries from 2026-08-07 contradicted each other** — one describing a
Gemini vision stage as built and "BLOCKED ON TABISH, one thing: a Gemini API key", the next
recording that he refused a key and that free local OCR solved it instead. Both were true
when written. Read together by someone new, they are a coin flip, and the reader has no way
to know which paragraph won.

`CLAUDE.md` does not have that problem because it is **edited**, not appended: when a
decision reverses, the old text is either removed or explicitly marked as history with the
reason. A reader arriving cold gets the current state and the argument for it, not a
chronology to reconstruct.

## Where things are now

| you want | read |
|---|---|
| how any of this works, and what not to "fix" | **`CLAUDE.md`** — all of it, including Gotchas |
| the hosting plan and every measurement behind it | `docs/specs/2026-08-08-hosted-product-plan.md` |
| what the device agent is and why sending cannot move to a server | `src/agent/README.md` |
| operator instructions, macOS and Windows | `docs/RUNBOOK.md` |
| the pipeline diagram, and the rule that it must be kept current | `docs/PIPELINE.md` |
| earlier design work | `docs/specs/` |

## The one habit worth keeping from it

Each session ended by writing down **what was measured**, not what was believed. Keep
doing that — put it in the spec for the work, or in `CLAUDE.md` if it changes how the
system should be understood. Do not start a new append-only log.
