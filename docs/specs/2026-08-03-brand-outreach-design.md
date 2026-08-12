# Phase 1.5 — messaging the brands, not just the channels

**Status:** design, not built. Written 2026-08-03 after Tabish clarified the intent.
**Decision needed before any code:** §7.

---

## 1. What changes

Today the agent watches two publisher channels and, when one runs a paid post, pitches
**that publisher**. The brands inside the post (`RoyalCanin`, `@amazondotin`) are only
*material* — they supply the hook line and nothing more.

The intended motion is different, and larger:

> A paid post is detected → message the **channel** that posted it, and if a brand is
> identified in that post, message **that brand's own Instagram account** too, with the
> same cooldown, reply-halt and cap logic. A brand already contacted is never contacted
> again, even when it later appears on the other channel. No brand identified → channel
> only.

That is the real sales motion: a brand paying for influencer placement on M.O.M is a
brand with a live media budget, which is exactly who Digital Sukoon's 200-page network
is for.

`TargetAccount.kind` is already `CHANNEL | BRAND` and the schema comment already says
*"Phase 1.5 flips `kind` to BRAND for sponsors discovered in campaigns."* Nothing
creates one: `addTarget` hardcodes `kind: 'CHANNEL'` ([actions.ts:612](../../src/app/actions.ts#L612)).

---

## 2. The good news: dedup is already solved

The requirement *"if that brand appears on the other channel, it must not be messaged
again"* needs **no new logic**. It falls out of two things that already exist:

- `TargetAccount.handle` is `@unique`. One brand → one row, no matter how many channels
  or posts surface it.
- The governor already keys every rule off the pair and the target: `cooldownDays`,
  `touchesSoFar`, `TARGET_REPLIED`, `optedOut`, `maxUnansweredTouches`.

So "seen again on Viral Bhayani" resolves to the *same* `TargetAccount`, and the second
contact is refused by the same `cooldown-active` / `unanswered-touch-limit` rules that
already govern channels. The discovery step must **upsert on handle**, never create.

The residual gap is a brand with several accounts — `@nykaa`, `@nykaabeauty`,
`@nykaafashion`. Handle-exact dedup treats those as three prospects. That is arguably
correct (three different inboxes, three different teams) and is certainly better than
fuzzy matching, where a false merge silently drops a real prospect forever. **Do not
build fuzzy brand matching.** If it bites, add an explicit manual alias table.

---

## 3. The hard part: a brand name is not a handle

Measured against the live database on 2026-08-03, across every `CAMPAIGN` post we hold:

| Brand token | Form | Resolvable? |
|---|---|---|
| `@amazondotin` | @mention | **yes** — it is a handle |
| `RoyalCanin` | hashtag word | no |
| `TheLeela` | hashtag word | no |
| `Tilara` | hashtag word | no |
| `BlackandWhiteNonAlc` | hashtag word | no |

**1 of 5 — 20% — can be resolved automatically.** The other 80% are marketing words
pulled from `#RoyalCanin`. `#TheLeela` might be `@theleela`, `@theleelapalaces`,
`@theleelacoorg`, or none of them.

This is the constraint the whole design has to respect, because the failure mode is not
"we miss a prospect". It is **messaging the wrong account** — a stranger receiving a
cold pitch about a campaign they had nothing to do with, from a revenue account, with
no way to tell it was a mistake. That is a spam report, and spam reports are the thing
this project exists to avoid.

### The rule

- **`@mention` → resolve automatically.** It is already a handle. Confirm with the
  existing anonymous `handleExists()` before creating anything.
- **Bare word → never guess.** It goes to a review queue with the post, the caption and
  a link, and a human types the handle or dismisses it.

At current volume that is roughly one review item per working day for M.O.M — small,
and the alternative is unbounded risk on 80% of prospects.

---

## 4. What this does to volume — the thing to watch

This is the first change that can move the system from 1–2 messages/day into double
digits, and CLAUDE.md's first rule is that volume never rises quietly.

Today the target list is **fixed at 2 real channels**. After this change it **grows
with every paid post, forever**. M.O.M alone yields ~5 campaigns/week → ~5 new brand
prospects/week → ~20/month → ~240/year, each with its own first touch, its own
follow-ups and its own 7-day cooldown.

Practitioner figures put aged healthy business accounts at 25–35 cold DMs/day and we
operate at 1–2, so the headroom is real. But headroom is not a plan. Required:

- **`MAX_NEW_BRAND_TOUCHES_PER_DAY`**, a new setting, default **1**. Separate from
  `SenderAccount.dailyCap`, because the cap protects the *account* and this protects the
  *pattern* — a burst of first-touches to strangers reads differently from a steady drip.
- Brand targets **queue**; they do not all become eligible at once. Oldest-discovered
  first, so the queue drains predictably rather than favouring whatever was detected last.
- The dashboard must show the queue depth. "47 brands waiting" is a number someone needs
  to see before it is 400.

---

## 5. One sender per brand, always

Three of our pages pitching the same brand is precisely the cross-account repetition
pattern decision 3 exists to prevent, and it is more visible to a brand's social team
than to a publisher — they will notice three Bollywood pages in one inbox.

So: **exactly one designated sender for brand outreach.** Not a rotation. The other two
accounts continue to handle channels.

This collides with **open decision 3b**: all four senders currently carry the identical
persona block (*Kapil Jain, Co-founder, Bollywood Society*), so a pitch from
`@madaboutmarketingg` introduces itself as the co-founder of a different brand. For
channels that is embarrassing. For brands — who receive pitches for a living and check —
it reads as a copy-paste operation.

**3b must be resolved before brand outreach goes live.** It is a business identity
question (who fronts each brand) and it is Tabish's to answer. Do not generate personas.

---

## 6. What the message says

To a channel we pitch partnership. To a brand we pitch **media buying** — a different
proposition needing its own variant pool, not a reworded version of the channel pitch.

The hook is strong and genuinely per-recipient: we watched them spend money on a
specific placement, on a specific date, on a named publisher. *"Saw your Royal Canin
piece with M.O.M at PetFed last week"* is not a merge field — it is a fact about that
one recipient, and it is exactly the personalisation decision 3 asks for.

Bespoke bodies do not scale here the way they do for four channel pairs. Two options:

- **(a) Generated per brand from the campaign, reviewed before first send.** The material
  is real, so the output is genuinely bespoke. Costs a review step.
- **(b) A brand-specific variant pool + campaign hook.** Cheaper, weaker; closer to the
  templating decision 3 warns about.

Recommend **(a)**, with the review queue from §3 doing double duty: the human resolving
the handle also approves the message.

---

## 7. Decisions needed before code

1. **Who fronts each brand?** (decision 3b) — blocking, per §5.
2. **Which single account does brand outreach?**
3. **`MAX_NEW_BRAND_TOUCHES_PER_DAY`** — 1 to start?
4. **Message authoring** — generated-and-reviewed (a), or variant pool (b)?
5. **Do we message brands found on Viral Bhayani?** Today we cannot: VB runs the
   `passthrough` detector, which extracts **no brands at all**, so this feature is
   **M.O.M-only** until a semantic classifier exists for VB. Worth stating plainly —
   VB is 62 posts/day against M.O.M's 3, so most of the commercial volume is invisible
   to it.

---

## 8. Proposed phasing

Each phase is separately useful and separately abandonable.

**1.5a — discovery only, sends nothing.**
Resolve `@mention` brands to `TargetAccount{kind:'BRAND'}`; queue bare words for review.
Pairs created **disabled**, per "adding is never the same act as sending". Run it for two
weeks and *look at the queue*: how many brands, how good the resolution, how much review.
This answers the volume question with data instead of an estimate.

**1.5b — one sender, one brand a day, each enabled by hand.**
The first brand send is a real first: a cold DM to a company that has never heard of us,
from a revenue account. Treat it like the first channel send.

**1.5c — automatic within the cap.**

### Reply detection is the gating problem for 1.5c

`TARGET_REPLIED` is the hardest stop in the system and the only writer is a **manual**
command (`pnpm ig:thread`), one browser session per pair. That is fine for 5 targets. At
50 brand targets it is the bottleneck, and the failure is the worst one available: a
brand replies, nobody records it, and follow-ups keep firing into a live conversation.

CLAUDE.md already flags that wiring `ig:thread` into every slot means a browser session
per pair per slot — a real increase in automation against these accounts, deliberately
not taken. Brand outreach does not resolve that tension, it sharpens it. **1.5c should
not ship until reply detection scales**, and that is its own design problem.

---

## 9. Schema

Almost nothing is needed, which is a good sign.

- `TargetAccount.kind = 'BRAND'` — exists.
- `TargetAccount.detectorKey` — brands are messaged, not watched. Add a `'none'` detector
  rather than pointing them at `passthrough`, or four scrapes a day will fetch feeds for
  hundreds of brands for no reason.
- **New, small:** `TargetAccount.discoveredFromCampaignId` (nullable) — which campaign
  surfaced this brand, so the first message can reference it and so the audit trail can
  answer "why is this company in our database?".
- **New model `BrandCandidate`** — the review queue: token, source campaign, status
  (`PENDING | RESOLVED | DISMISSED`), resolved handle. Unresolved candidates must not be
  silently dropped; a dismissed one must not come back every slot.
