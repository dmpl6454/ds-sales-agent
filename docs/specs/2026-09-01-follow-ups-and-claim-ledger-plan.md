# Follow-ups on new material, a per-recipient claim ledger, and the reply-halt scope

Plan written 2026-09-01 from Tabish's instruction, with every premise MEASURED first.
Autopilot stays ON throughout — nothing here may pause the fleet, and every phase ships
inert or behind existing rules until the copy that activates it is written.

---

## 0. WHAT WAS MEASURED, SO NOBODY RE-DERIVES IT

**The @dorothy screenshot (four messages under one paid post) is NOT a breach and NOT a
column bug — it is the claim ledger collapsing.** Verified against the live DB:

```
@dorothy   namingPosts=4  delivered7d=4  — allowance held EXACTLY
  posts:  DcnuZ7WTUdB@varindertchawla 10:30 · DcntdNxKYsH@viralbhayani 10:22
          DcnuO0KzTwc@voompla 10:28    · DcnwkuCTxwE@instantbollywood 10:49   (29 Aug)
  sends:  4 pages, 01:02–01:47 (30 Aug) — ALL FOUR claimed DcnwkuCTxwE
```

One syndicated campaign, four watched channels, four copies → allowance of 4 (Tabish's own
one-message-per-paid-post rule; the syndication multiplier is documented since 25 Aug).
The four sends are legal. What is wrong is that **all four messages CLAIMED the same
newest copy**: `pickHook` excludes campaigns already used **by this pair**
(`usedCampaignIds(pairId)`, compose.ts), so a post used by page A is still "fresh" for
pages B, C, D. The provenance column truthfully renders those claims — four messages
stacked under one post, em-dashes under its three siblings.

Same shape verified for @keerthysureshofficial (3/3), @sonymusic_south (2/2), @sikhya (2/2).

**Fleet-wide compliance: ZERO breaches.** A quick sweep flagged @pharsfilm and @tabutiful,
and both evaporated under the as-of-send-time check (the sweep had used TODAY'S 7-day
window; the allowance is evaluated against the window at each send). Every delivery to
every multi-message recipient of the last 72h was within its allowance at its own moment.

**The reply halt is TARGET-scoped today.** `gate.ts` queries `pair: { targetId }` with
`replyPostedAt >= replyHaltFloor(...)` — one reply from any thread halts EVERY page to that
recipient for `replyResumeHours` (168h). The ring does NOT continue through other senders.
That was the deliberate 2026-08-03 design ("a human takes over"), restated here because
Tabish asked whether the ring continues: **it does not.**

**The wall this plan releases:** the planner's dominant skip is
`identical-to-a-message-they-already-have=1808` (~49% of all skips) — every pair that
already delivered the single template can never send again until a follow-up message with
DIFFERENT bytes exists. That second template is Phase 2.

---

## PHASE 1 — THE CLAIM LEDGER BECOMES PER-RECIPIENT

**Rule:** a paid post may fund exactly ONE delivered message to a given recipient, across
the whole fleet. Claim = `OutreachAttempt.campaignId`.

- `compose.ts` — `pickHook` currently filters by `usedCampaignIds(pairId)` (IN_FLIGHT
  statuses). Add `claimedCampaignIds(targetId)` with the SAME status set
  (`IN_FLIGHT_STATUSES` — an undelivered draft's claim must block a second claim, and a
  discarded draft must release it, exactly the semantics `usedCampaignIds` already has) and
  filter on the UNION of both. Keep the pair-scoped read too: the per-pair new-material
  rule (`NO_NEW_MATERIAL`) still needs it.
- **The allowance is untouched.** `materialAllowance` stays count-vs-count; volume does not
  change by one message. Only WHICH post each message cites changes — @dorothy's four
  messages come to cite four different posts, one each.
- **UI effect, free:** `/paid-posts` "Message sent" becomes at most one message per post
  per recipient (the attribution partition already built on 31 Aug needs no change), and
  the "Why" column stops showing four rows pointing at one post while three sibling posts
  show nothing.
- **Tests:** extend `tests/naming-linkage.test.ts` or a new `claim-ledger.test.ts` —
  behavioural, real SQLite: two pairs to one recipient, two naming posts → the second
  draft claims the SECOND post. MUTATION: scope the exclusion back to `pairId` → both
  claim the newest → must fail. Also the release direction: a SKIPPED draft's claim frees
  its post.
- Callers of `campaignsNamingHandleRows` are FOUR (plan.ts, compose.ts ×2, scripts
  generate/preview — see the 22 Aug entry). Touch only the claim selection; do not fork
  the linkage.

## PHASE 2 — THE FOLLOW-UP MESSAGE ON NEW MATERIAL (the second template)

**Rule:** a recipient we have already messaged, who is NOT reply-halted, and for whom a
NEW unclaimed naming post exists, may receive ONE follow-up per such post — the existing
allowance already says exactly this; what is missing is a body that differs.

- **Settings:** `followUpBody` (default fleet) and `followUpBody:<slug>` per fleet —
  mirror `fleetTemplateKey` (fleetTemplate.ts). **Unset REFUSES follow-ups and only
  follow-ups**; first touches are untouched. Ship the refusal first (the marketing-fleet
  pattern): the feature is INERT until Tabish writes copy in the UI.
- **The body:** Tabish's spec — custom, mentions the paid post the follow-up is for,
  "let's talk tomorrow" register, **continuous spacing exactly like the current template**
  ("Hi,We're…"). One varying token only, `{{post}}`, rendered by the SYSTEM as the post
  reference (e.g. `your placement with @instantbollywood on 30 Aug`) — the renderer adds
  the only thing that varies, typed braces in the textarea are refused
  (`checkTemplateBody`'s rule). A `checkFollowUpBody` validator runs the REAL render and
  the REAL `distinctiveSlice` on save — writer and probe share bytes — and refuses a body
  whose needle collapses (the fleet-wide-outage-from-a-textarea trap, documented 17 Aug).
- **Bytes differ by construction:** each follow-up cites a different claimed post, so
  `IDENTICAL_TO_A_SENT_MESSAGE` stops holding those pairs — this is what releases the
  1,808 wall, gradually, at the pace new paid posts arrive, still under allowance + the
  1-minute gap + rotation. State this in the session record: the volume ceiling is
  UNCHANGED (allowance), only reachability changes.
- **Eligibility, enforced at BOTH ends** (governor writes, gate re-checks — never one):
  `touchesSoFar >= 1` AND an unclaimed naming post exists (Phase 1 ledger) AND not
  reply-halted AND every existing rule (verified-only, opted-out, fleet template, caps,
  spacing) — the existing stops all still apply; the ONLY new stops are
  `FOLLOW_UP_TEMPLATE_NOT_SET` (both ends; NOT overridable — it is about what the message
  says, the fleetTemplate precedent). `tests/stopInventory.test.ts` is total over both
  stop tables and will demand cases + remedies; `remedy.ts` needs the WHERE (the editor).
- **Rotation:** unchanged — `whoseTurn` elects the page; the elected pair's follow-up
  carries its own claimed post. A page that already delivered to the recipient CAN be
  elected again now (its bytes differ) — this is intended and is the release.
- **Reply-halted recipients get NO follow-ups in this phase.** A replied thread belongs to
  a person. Phase 3 is where that policy is decided, not here by accident.

## PHASE 3 — REPLY-HALT SCOPE (A DECISION, NOT YET A CHANGE)

Tabish asked whether, after a reply, other senders may continue per ring rule. VERIFIED:
today they may not (target-scoped halt). Before changing it, the risk must be put to him
in one paragraph and his answer recorded, per this repo's standing practice:

> The recipient who replied is the one engaged human in the funnel. Other pages
> cold-messaging them mid-conversation is the "repeated unwanted contact" pattern aimed at
> the person who engaged — and every page signs with the same phone and email, so "a
> different page" is transparent to exactly this reader. The safer variant of what he
> wants is (c): the halt stays fleet-wide for the STANDARD message, but a NEW paid post
> may trigger ONE follow-up during the hold — the follow-up has genuinely new content and
> reads as attentiveness rather than repetition.

Options to put to him: **(a)** keep as is; **(b)** pair-scoped halt, ring continues with
first-touch copy; **(c)** fleet-wide halt + follow-up-on-new-post allowed during the hold
(from the rotation-elected page). Implement as `replyHaltScope` / `followUpDuringReplyHold`
Setting rows so the choice is one write, enforced through `replyHalt.ts` — the ONE module
every halt site already reads (gate, governor, plan, three view models; never a UI mirror).

## PHASE 4 — THE UI TELLS THE TRUTH ABOUT FOLLOW-UPS

- **Sent list (`/analytics` + landing):** a `follow-up` chip beside the To cell when
  `touchNumber > 1` (`SentMessage` already carries what is needed or add `touchNumber`) —
  the "Why" column already names the claimed post with zero extra queries
  (`loadProvenancePosts`).
- **`/paid-posts` "Message sent":** annotate follow-ups (`@page → @recipient · follow-up ·
  2h ago`). After Phase 1 each post row shows at most one message per recipient.
- **Autopilot page:** a SECOND editor box for the follow-up copy per fleet, separate
  component from the standard-template form (two boxes that look alike and mean opposite
  things by being empty is why fleetTemplate got its own — same rule), with the honest
  empty state: *"No follow-up message is written. Recipients with new paid posts wait;
  nothing falls back to sending the first message twice — Instagram silently drops a
  verbatim repeat (measured: touch 2 fails 83%)."*
- **Waiting/held reasons:** rows held as identical whose recipient HAS an unclaimed naming
  post should read "a follow-up is possible once the follow-up message is written" —
  otherwise the feature ships invisible (nothing renders an absence).
- `pnpm ig:layout` after every UI change; budgets are ceilings (/ 160, /paid-posts 120,
  /analytics 125) — reuse the batched loaders, never a per-row query.

## PHASE 5 — VERIFICATION AND DEPLOY ORDER

1. Full suite + mutation tests per phase (the pattern: prove the failing direction).
2. Typecheck, `pnpm build`, `pnpm ig:layout` ALL GREEN locally.
3. Commit; `bash scripts/deploy.sh`; restart device agent (check watch.log for an
   in-flight drive first); `bash scripts/install-dashboard.sh restart` after local build.
4. Phase 2 activates only when Tabish writes the copy — then VERIFY LIVE: watch the first
   follow-up deliver end-to-end (real thread URL), confirm its bytes cite its claimed
   post, confirm the pair's next draft is held identical again until another new post.
5. Record everything in CLAUDE.md with the measurements; update the pipeline diagram if
   the flow picture changes (docs/PIPELINE.md rule).

**Traps for the implementer** (all documented in CLAUDE.md, restated because each has
bitten): never bare `prisma generate` (client/provider trap — `scripts/
prisma-client-for-env.sh`); `pnpm test` leaves the right client only if it FINISHES;
enforcement always at both ends; new SKIP_REASONS/RESEND_BLOCKS entries must satisfy
stopInventory totality + remedies; SQLite vs Postgres provider differences make live
tests the only honest check for conditional writes; the agent runs SOURCE via tsx — a
restart picks up code without a build, but the dashboard needs `pnpm build`.