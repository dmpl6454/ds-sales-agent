# Tags, collabs, post times and an undoable label — 2026-08-13

Three changes, one audit behind them. Written after the 13 August end-to-end audit of the
paid-post pipeline (findings in CLAUDE.md, "THE 13 AUGUST AUDIT").

**The one sentence this plan must not violate: RECALL IS NEVER TRADED.** `pnpm ig:accuracy`
reads 100% recall today. Any step here that drops it is reverted, not tuned. A missed paid
post is invisible and unappealable; a false alarm becomes a draft a human reads.

---

## Why these three, and why together

The audit measured three separate things that all point at the same weakness — **we throw
away evidence, and then cannot tell how much we missed**:

| measured 2026-08-13 | |
|---|---|
| `taggedAccounts` parsed by `feed.ts`, written to `rawPayload` | **never** — dropped at `pipeline.ts` |
| `collabHandles` written to `rawPayload` | yes, and **read by no classifier** |
| M.O.M posts ever read by the model | **0 of 79** (`verdictSource='rules'`, since March) |
| M.O.M posts with nothing read at all (no model, no frame) since 1 Aug | **46 of 61 — 75.4%** |
| REVIEW queue, all unlabelled | 20 |
| accuracy | 95% correct · **100% recall** · 83% precision (n=77, was 92–94% precision) |

The review queue is the only instrument that can ever measure recall on placements the
caption cannot reveal. It has 20 rows and no answers in it, partly because answering one is
irreversible and therefore frightening. **That is why the undo ships alongside the evidence
work rather than after it** — the measurement depends on people being willing to label.

---

## Change 1 — Collect tags and collabs, and let them be EVIDENCE

### 1a. Persist what we already fetch (backend)

`src/detection/feed.ts` already parses `usertags` → `taggedAccounts` and
`coauthor_producers` → `collabHandles`. `src/detection/pipeline.ts` writes seven keys to
`rawPayload` and `taggedAccounts` is not one of them.

Add it. **No schema migration** — `rawPayload` is deliberately JSON rather than columns
("this is captured evidence about a post", `pipeline.ts:411`), and adding a column for a
field nothing queries by would be the wrong trade.

```
rawPayload: JSON.stringify({
  isPaidPartnership, sponsorHandles, collabHandles,
  taggedAccounts,            // ← add
  thumbnailUrl, videoUrl, videoDurationSeconds, capturedAt,
})
```

**These are REFRESHED on re-observation**, like the media URLs, via the known-post loop.
Tags can be edited after posting.

**Verify by running, not by reading.** Measured on the live feed 2026-08-13: 3 of 12
@viralbhayani posts carry usertags; 1 M.O.M post carries a coauthor. After the change, those
counts must appear in `rawPayload` within one detect pass. A count of zero means the write
did not happen — do not accept "no post had tags" without checking the live endpoint, which
is the mistake that let this sit unnoticed.

### 1b. Give them to the model as OBSERVATIONS (backend)

**THE HARD CONSTRAINT, AND IT IS NOT NEGOTIABLE.** `semantic.ts`'s system prompt is a
module-level constant with nothing interpolated into it, ever. Cached input is billed at
~1/50th of fresh input and a prefix miss is **silent and permanent**. Per-post facts go in
the **user message**. Cache hit is 94% today and is on `/cost` — watch it across this change.

Append to the user message only, as a fenced observation block:

```
Tagged in the media: @brandhandle, @personhandle
Collaborators (Instagram "collab" posts): @cohandle
Instagram's own paid-partnership flag: false
```

**They are evidence, not a rule, and the prompt must say so.** The rule reading is measurably
wrong: an earlier attempt to treat "@-tags the brand's handle" as sufficient **cratered
precision 85% → 71%**, because M.O.M's genuine commentary tags handles too — measured again
on 13 Aug, 7 M.O.M posts we correctly call ORGANIC mention brand handles
(`@appletv`, `@miumiu`, `@rarebeauty`, `@drink818`). A collab tag is stronger evidence than a
caption @-mention (both parties opted in), and it is still not proof — publishers collab with
other publishers.

The prompt addition must be phrased as a **restriction on raising**, the same shape as the
frame rule, so it cannot make caption judgement more conservative and cost recall.

### 1c. `is_paid_partnership` already overrides — leave it alone

It is carried and honoured. Measured `false` on 12/12 live posts for both channels; neither
uses Meta's native tool. It costs nothing and is free future-proofing.

### 1d. Gate the whole thing on the harness

```
pnpm ig:accuracy            # BEFORE — record correct / recall / precision
<make the change>
pnpm ig:accuracy            # AFTER
pnpm ig:accuracy --no-frames  # control: did the prompt edit alone move caption judgement?
```

**Ship only if recall stays 100%.** Precision improving is the goal (83% today, 4 false
alarms, all M.O.M commentary about other brands' campaigns — exactly what a "was the
publisher paid" signal should help disambiguate). If recall drops, revert the prompt edit and
keep 1a: storing the evidence is valuable on its own, and a stored field costs nothing.

### 1e. What this does NOT do

It does not make M.O.M reach the model. That is a separate decision with its own risk (M.O.M's
rule is currently perfect on its corpus: 18 CAMPAIGN posts carry `#Collaboration`, 0 ORGANIC
posts do) and it is **out of scope here** — flagged in CLAUDE.md, not silently changed.

---

## Change 2 — Show when the post went up, with the hour in brackets

Frontend only, plus one view-model field.

Today `/paid-posts` renders `p.dayLabel` — a date with no time. An operator cannot tell a
post that went up in the commercial window from one at 3am, and the audit showed that
distinction is real: **across 14 days @viralbhayani published 84 posts before 09:00 IST and
not one was paid.**

- `buildPaidPostsView` gains `postedLabel`, formatted **once, in the view model** (this
  codebase puts interpretation there, never in the page).
- Format: `12 Aug (16:42)` — date, then the **IST** hour in brackets. IST because every date
  boundary in this system is IST, and a UTC hour here would be a different day for the reader.
- The `<td>` carries a `title` with the full timestamp, so precision is available without
  cluttering the column.
- **Also show detection latency where it is interesting**: `postedAt → detectedAt`. Median is
  18 min; an outlier of 1,000+ minutes means the post was found late and its hook may have
  aged out. Render only when it exceeds a threshold, so the common case stays quiet.

Apply the same treatment to the **"Worth a look"** review queue, where the operator is
deciding: knowing a post went up at 16:42 is part of the judgement.

---

## Change 3 — A five-second undo on labelling

### The problem, from the operator

A post that was genuinely paid was ticked off as ordinary. Today's two labels are stamped
10:03 and 10:04 IST and there is **no way back from the UI** — `labelPost` writes
`humanLabel`, `labelledBy`, `labelledAt` and `verdictSource: 'human'`, and nothing reverses it.

### Why this matters more than an ordinary mis-click

A human label is not cosmetic. It is `verdictSource: 'human'` — the **highest-authority
verdict in the system**, and the only possible ground truth for video-only placements. A wrong
one is worse than no label: it will be counted as truth by any future recall measurement, and
it silently poisons the one instrument that could tell us what we are missing.

### The shape

- **Optimistic UI + a 5-second window.** The row leaves the queue immediately (that
  responsiveness is the point) and a toast appears: *"Marked ordinary. Undo"* with a visible
  countdown.
- **The write is DEFERRED, not written-then-reversed.** Nothing reaches the database until the
  window closes. This matters: a compensating delete would leave an audit trail saying a
  person labelled a post and then unlabelled it, which is not what happened — they mis-clicked.
- If the operator navigates away or the tab closes inside the window, the write **still
  commits** — `sendBeacon`/`flush` on unmount. A label silently lost because someone changed
  page is worse than one that lands.
- Pressing Undo restores the row to the queue in place.
- **After the window, undo is gone.** A label older than five seconds is corrected by
  re-labelling, which is a deliberate act and leaves an honest audit trail.

### What must not break

- `labelPost` stays the **ONE writer** of `humanLabel`. The deferral lives in the client; the
  server action is unchanged in what it writes. Do not add a second write path.
- `requireOperator()` stays the first statement — `tests/action-authorisation.test.ts` asserts
  every action is guarded and that the guard precedes any `prisma.` call.
- An audit row is written when the label **commits**, never when it is staged.

---

## Order of work

1. **1a — persist `taggedAccounts`.** Smallest, zero risk, immediately verifiable against the
   live feed. Ship alone.
2. **Change 2 — post times.** Frontend, no safety surface.
3. **Change 3 — undo.** Unblocks the review queue, which is what makes measurement possible.
4. **1b — prompt evidence,** gated on `pnpm ig:accuracy` before/after/control.

Reason for that order: 1, 2 and 3 cannot lower recall. 4 can, so it goes last and behind the
harness, when the other three are already delivering value.

---

## Verification, every step

```
pnpm typecheck
pnpm test                    # 1233 today; must not fall
pnpm build
pnpm ig:layout               # needs DS_LAYOUT_TOKEN; geometry in a real browser
pnpm ig:accuracy             # gate for step 4 — recall must stay 100%
```

Plus: **read the rendered page.** Both bugs found on 12 August (the "Clear to send" false
promise and the table scrolling the page body) came from reading real output, not from tests.

## Out of scope, deliberately

- Making M.O.M reach the model (§1e).
- Kimi K3 / a vision API. The free local reader is not finished: **157 of 405** @viralbhayani
  posts and **all 35** M.O.M posts have no frame text, on a server where RapidOCR is installed
  and working. Finish the free path before paying per image. The genuine gap a vision model
  closes is a placement with *no on-screen text*; OCR cannot see those.
- The brand-lookup 429 on the server. Real and unresolved — `autoResolve` halts on its first
  lookup every pass and has created **zero** targets, while the 12 Aug Mac run created 59.
  It needs a decision, not a patch.
