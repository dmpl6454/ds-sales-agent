# Two fleets per sender, a ring that passes the turn, and follow-ups that wait a day

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development.

**Goal:** A sender may hold bollywood, marketing, both, or no fleet; every bollywood page also
sends for marketing; the ring passes the turn to the next page whose route is clear; a follow-up
from one page waits for the next IST day; once a recipient has replied nobody sends them the
standard message again. Before any of that, `followUpSubject` stops naming the publisher and its
events.

**Architecture:** Pure rules with several callers, enforced at BOTH the governor (refuses to
write) and the gate (refuses to send), mirrored in `rest-tally` so the dashboard predicts what
the enforcers do. Data migration is separate from the semantic change and runs after deploy.

---

## MEASURED BEFORE ANYTHING CHANGED (2026-09-04)

| | |
|---|---|
| Categories in the database | **`marketing` only** — there is NO `bollywood` row; bollywood is the absence of a membership |
| CategorySender rows | **1** — `marketing → @madaboutmarketingg`. The four bollywood pages hold none |
| marketing CategoryTarget | 156 rows, **145 live prospects** |
| Fleet senders | societyy, chronicle, paparazzii, totalfilmii (bollywood by absence) + madaboutmarketingg (marketing) |
| Targets in more than one category | **0** |
| Live prospects | 812 — BrandLookup kinds: PERSON 423, BRAND 186, UNKNOWN 116, UNRESOLVED 56, no row 30, MISSING 1 |
| `campaignTalent` | TRUE on 612; **only 423 of those are a PERSON verdict — 189 are companies carrying the flag** |
| Same-day pair deliveries, 14d | 1,966 pair-days: 1,950 ×1, **11 ×2, 5 ×3+** |
| Targets that ever replied | **116** (162 target,sender reply pairs) |
| `followUpBody:marketing` | **CLEARED 2026-09-04 10:02Z**, and the audit row's claimed backup DOES NOT EXIST — no Setting, no audit detail holds it |
| Recoverable? | **YES, from the delivered bytes.** All 19 delivered marketing follow-ups reconstruct to one template, **byte-identical to the default `followUpBody`** |
| Subjects the bug produced | good: MaybellineIndia, Nykaa, Taneira, Mirzapur The Movie, Sebamed · **wrong: Social Samosa, Festive Marketing Camp, Realize** |

**The founding post, `DcyE65LPYMj`** (publisher @officialsocialsamosa):
`brands = ["@socialsamosaevents","Realize","itsbevygood","plumbodylovin","supersox_india","farmleyin"]`

Walked through the current rule for recipient @farmleyin: `@socialsamosaevents` drops on the `@`;
**`itsbevygood`, `plumbodylovin`, `supersox_india`, `farmleyin` all drop on the all-lowercase
filter**; only `Realize` survives, so a five-advertiser round-up reads as a one-subject post,
`exactMine` is empty because the recipient's own bare handle was already deleted, `campaignTalent`
is true, and the talent arm speaks **"your Realize placement"** — the sponsor of the publisher's
own event — to a gifting partner. Each of the three fixes below independently stops this post.

---

## Task 1 — `followUpSubject`: count what you cannot speak, strip every competitor, and ask whether the account is a person

**Files:** Modify `src/detection/ownMarks.ts`, `src/outreach/followUpTemplate.ts`,
`src/outreach/compose.ts`, `src/outreach/plan.ts`, `src/app/view-model/rest-tally.ts`.
Test: `tests/follow-up-template.test.ts`.

- [ ] **1.1 `ownMarks.ts` — a channel's name can be a SUBSTRING of its handle.**
  `isOwnMark` only tests `token.includes(handle)`. The brand string `"Social Samosa"` squashes to
  `socialsamosa` and the handle is `officialsocialsamosa`, so the containment runs the OTHER way
  and the publisher's own name survived its own post. Add, beside `isOwnMark` and NOT inside it
  (`view-model.ts` display behaviour must not move):

```ts
/**
 * IS THIS TOKEN THE NAME OF A CHANNEL WE WATCH?
 *
 * `isOwnMark` answers it for the publisher of the post and only in one direction — a token
 * CONTAINING the handle (`thefilmygyan`). MEASURED on DcyE65LPYMj: the brand string
 * "Social Samosa" squashes to `socialsamosa` while the handle is `officialsocialsamosa`, so
 * the containment runs the other way and the publisher's own name survived its own post and
 * was spoken to a recipient as their placement.
 *
 * So this adds the REVERSE containment, bounded by the same slack: a token that the handle or
 * display name contains, within `AFFIX_SLACK` characters, is that channel's own name wearing
 * or missing a prefix (`official`, `the`, `real`). Bounded, because an unbounded reverse
 * containment would let a 3-letter token match every channel.
 */
export function isChannelMark(token: string, channel: { handle: string; displayName: string | null }): boolean {
  if (isOwnMark(token, channel)) return true
  const t = normaliseMark(token)
  if (t.length < 6) return false
  const AFFIX_SLACK = 8
  for (const raw of [channel.handle, channel.displayName ?? '']) {
    const c = normaliseMark(raw)
    if (c.length >= 6 && c.includes(t) && c.length <= t.length + AFFIX_SLACK) return true
  }
  return false
}

/**
 * EVERY CHANNEL WE WATCH IS A COMPETITOR, not just the one that published this post.
 *
 * `stripOwnMarksFromBrands` removes the PUBLISHER's marks. A round-up published by one watched
 * page can name another watched page, and a brand string is enough to make it a subject — which
 * is how "Social Samosa" reached a recipient. The list is every WATCH row, so a competitor's
 * name can never become somebody's placement whichever of them posted it.
 */
export function stripChannelMarksFromBrands(
  brands: readonly string[],
  channels: readonly { handle: string; displayName: string | null }[],
): string[] {
  return brands.filter((b) => !channels.some((c) => isChannelMark(b, c)))
}
```

- [ ] **1.2 `followUpTemplate.ts` — the new signature.** `campaignTalent` is replaced by
  `isPerson`, and `watchChannels` is REQUIRED so the compiler names all four call sites.

```ts
export function followUpSubject(
  brands: readonly string[],
  publisher: { handle: string; displayName: string | null },
  recipient: { handle: string; displayName: string | null; isPerson: boolean },
  watchChannels: readonly { handle: string; displayName: string | null }[],
): string | null {
  const mineSquashed = [recipient.handle, recipient.displayName]
    .filter((s): s is string => typeof s === 'string')
    .map(squashName)
    .filter((s) => s.length > 0)

  /**
   * ── COUNT WHAT YOU CANNOT SPEAK (2026-09-04) ──────────────────────────────
   *
   * The all-lowercase filter used to run HERE, before the partition, and it deleted the bare
   * handles Social Samosa's posts store as brand strings — `supersox_india`, `farmleyin`,
   * `itsbevygood`, `plumbodylovin`. MEASURED on DcyE65LPYMj: a five-advertiser round-up
   * became a ONE-subject post, `exactMine` was empty because the recipient's own name had
   * already been deleted, and the talent arm spoke the event sponsor's name to a gifting
   * partner. 14 such messages were delivered to five companies.
   *
   * A lowercase token is still never SPOKEN — it is a hashtag artefact or a bare handle, not
   * a title. But it is EVIDENCE that the post names another advertiser, and throwing evidence
   * away before the partition is what made a crowded post look empty. So candidates are kept
   * for COUNTING and `speakable` decides what may be named.
   */
  const candidates = stripChannelMarksFromBrands(brands, [publisher, ...watchChannels]).filter((raw) => {
    const b = raw.trim()
    return b.length >= MIN_SUBJECT_LENGTH && !b.includes('@')
  })
  const speakable = (b: string) => b.trim() !== b.trim().toLowerCase()

  const exactMine = candidates.filter((b) => mineSquashed.includes(squashName(b)))
  const stemMine = candidates.filter((b) => {
    const s = squashName(b)
    return (
      !mineSquashed.includes(s) &&
      mineSquashed.some((mine) => mine.length >= 4 && s.length >= 4 && (s.includes(mine) || mine.includes(s)))
    )
  })
  const others = candidates.filter((b) => !exactMine.includes(b) && !stemMine.includes(b))

  if (stemMine.length === 1) return speakable(stemMine[0]!) ? stemMine[0]!.trim() : null
  if (stemMine.length > 1) return null

  /**
   * ── AND THE TALENT ARM ASKS WHETHER THE ACCOUNT IS A PERSON (2026-09-04) ──
   *
   * `campaignTalent` is set by the badge door on admission and is TRUE on 612 of 812 live
   * prospects — but only 423 of those carry a PERSON verdict. **189 are companies wearing the
   * flag**, so the flag alone was the vacuous test the @tips lesson warns about, one field
   * along. @farmleyin, @hkvitals, @itsbevygood, @plumbodylovin and @supersox_india are all
   * `campaignTalent: true` and all are brands; every one received a wrong subject.
   *
   * The talent argument is about a PERSON: someone in a paid campaign post is there because of
   * the thing promoted, so the film or product is what they were in. A company on a co-branded
   * post is not. So the arm reads `BrandLookup.kind === 'PERSON'` — the account's own verdict —
   * and NOT-KNOWN never admits: UNKNOWN, UNRESOLVED, MISSING and a missing row are all `false`,
   * because absence of data becoming a positive verdict is this codebase's most repeated defect.
   */
  if (recipient.isPerson && exactMine.length === 0 && others.length === 1 && speakable(others[0]!)) {
    return others[0]!.trim()
  }
  return null
}
```

- [ ] **1.3 Feed `isPerson` and `watchChannels` at all four call sites.**
  Add to `src/outreach/compose.ts` a shared loader, exported so `plan.ts` and `rest-tally.ts`
  reuse it rather than each writing a query (one rule, several callers):

```ts
/** Every WATCH row's name and handle — the competitor list `followUpSubject` strips. */
export async function readWatchChannels(): Promise<{ handle: string; displayName: string | null }[]> {
  return prisma.targetAccount.findMany({ where: { role: 'WATCH' }, select: { handle: true, displayName: true } })
}

/** Which of these handles carry a PERSON verdict. Absence is FALSE, never unknown-admits. */
export async function readPersonHandles(handles: readonly string[]): Promise<Set<string>> {
  if (handles.length === 0) return new Set()
  const rows = await prisma.brandLookup.findMany({
    where: { handle: { in: [...new Set(handles)] }, kind: 'PERSON' },
    select: { handle: true },
  })
  return new Set(rows.map((r) => r.handle))
}
```
  `pickFollowUpHook` and `describableCampaignCount` take `isPerson` on their `target` argument and
  a `watchChannels` argument; `plan.ts` loads both once per pass beside its other preloads;
  `rest-tally.ts` loads both once per render (+2 queries, both batched, no per-row query).

- [ ] **1.4 Tests — `tests/follow-up-template.test.ts`.** Add, with the REAL post as the fixture:

```ts
const SS_BRANDS = ['@socialsamosaevents', 'Realize', 'itsbevygood', 'plumbodylovin', 'supersox_india', 'farmleyin']
const SS_PUBLISHER = { handle: 'officialsocialsamosa', displayName: 'officialsocialsamosa' }
const WATCH = [SS_PUBLISHER, { handle: 'madovermarketing_mom', displayName: 'Mad Over Marketing (M.O.M)' }]

it('refuses the publisher’s event sponsor as a gifting partner’s subject (DcyE65LPYMj, delivered 14×)', () => {
  expect(followUpSubject(SS_BRANDS, SS_PUBLISHER, { handle: 'farmleyin', displayName: 'Farmley', isPerson: false }, WATCH)).toBeNull()
})
it('counts a lowercase co-advertiser it can never speak', () => {
  // farmleyin is in the brands list as a bare handle: the post names them, so another
  // advertiser's name is not their subject even if the recipient WERE a person.
  expect(followUpSubject(SS_BRANDS, SS_PUBLISHER, { handle: 'farmleyin', displayName: 'Farmley', isPerson: true }, WATCH)).toBeNull()
})
it('never speaks a watched channel’s own name, whoever published the post', () => {
  expect(followUpSubject(['Social Samosa', 'Tanishq'], { handle: 'madovermarketing_mom', displayName: 'Mad Over Marketing (M.O.M)' },
    { handle: 'tanishqjewellery', displayName: 'Tanishq', isPerson: false }, WATCH)).toBe('Tanishq')
  expect(followUpSubject(['Social Samosa'], { handle: 'madovermarketing_mom', displayName: 'Mad Over Marketing (M.O.M)' },
    { handle: 'someone', displayName: 'Someone', isPerson: true }, WATCH)).toBeNull()
})
it('a company carrying campaignTalent is not talent (189 live rows do)', () => {
  expect(followUpSubject(['Toxic'], SS_PUBLISHER, { handle: 'hkvitals', displayName: 'HK Vitals', isPerson: false }, WATCH)).toBeNull()
})
it('a real person on a campaign post still gets the subject', () => {
  expect(followUpSubject(['Toxic'], { handle: 'viralbhayani', displayName: 'Viral Bhayani' },
    { handle: 'tarasutaria', displayName: 'Tara Sutaria', isPerson: true }, WATCH)).toBe('Toxic')
})
it('their own product line survives other names beside it', () => {
  expect(followUpSubject(['Titan Raga', 'Something Else'], { handle: 'viralbhayani', displayName: 'Viral Bhayani' },
    { handle: 'titan', displayName: 'Titan', isPerson: false }, WATCH)).toBe('Titan Raga')
})
```

- [ ] **1.5 Run:** `pnpm vitest run tests/follow-up-template.test.ts`. Expect PASS.
- [ ] **1.6 Mutation-test each of the three.** (a) move the lowercase filter back into `candidates`
  → the DcyE65LPYMj cases must FAIL; (b) pass only `[publisher]` instead of the watch list → the
  watched-channel case must FAIL; (c) replace `recipient.isPerson` with `true` → the company case
  must FAIL. Restore after each.
- [ ] **1.7 Commit** `fix(follow-up): count lowercase co-advertisers, strip every watched channel, gate talent on a PERSON verdict`

---

## Task 2 — A sender holds bollywood, marketing, both, or none

**Files:** Modify `src/outreach/senderCategories.ts`, `src/outreach/fleetTemplate.ts`,
`src/outreach/followUpTemplate.ts`, `src/outreach/routes.ts`, `src/outreach/categories.ts`,
`src/outreach/governor.ts`, `src/outreach/gate.ts`, `src/app/actions.ts`,
`src/app/view-model/accounts-page.ts`, the `/senders` fleet control.
Create: `src/scripts/sender-fleets.ts`. Test: `tests/sender-categories.test.ts`.

- [ ] **2.1 Split the two semantics.** `effectiveCategories` is correct for a TARGET and wrong for
  a SENDER, and today the difference is invisible because no sender has a membership.

```ts
/**
 * A TARGET with no membership is a bollywood recipient — the 2026-08-25 no-migration decision,
 * and ~500 live rows still depend on it. UNCHANGED.
 */
export function effectiveCategories(slugs: readonly string[]): string[] { /* unchanged */ }

/**
 * A SENDER with no membership WRITES TO NOBODY (2026-09-04, Tabish: "either Bollywood or
 * marketing or both or none (that is not assigned or signed in)").
 *
 * This is the asymmetry, and it is the thing most likely to be "simplified" back: empty means
 * BOLLYWOOD for a recipient and NO FLEET for a page. A page nobody has assigned is a page that
 * has not been given a job, and giving it the default fleet is how an unassigned account starts
 * cold-DMing companies — the same reasoning that makes an unknown fleet slug refuse rather than
 * fall back.
 *
 * SAFE ONLY BECAUSE THE MEMBERSHIPS ARE WRITTEN FIRST. `pnpm ig:sender-fleets --run` gives every
 * current fleet page its explicit rows, and that migration is ADDITIVE and inert under the old
 * rule (a bollywood page with an explicit `bollywood` row reads identically). Ship the code,
 * deploy, then run it — in that order, or every page writes to nobody for the gap.
 */
export function senderFleets(slugs: readonly string[]): string[] {
  return [...new Set(slugs.map((s) => s.trim().toLowerCase()).filter(Boolean))]
}
```
  `sameCategory`, `routeFleets` and `crossCategoryDetail` take `senderFleets` on the sender side
  and `effectiveCategories` on the target side. `ringMembersFor` follows automatically.

- [ ] **2.2 A page with no fleet refuses BY ITS OWN NAME, not as "different fleet".**
  `routeFleets` returning `[]` today reads *"this page and this recipient belong to different
  fleets"*, which sends someone looking for a category mismatch that does not exist. Add
  `SKIP_REASONS.SENDER_HAS_NO_FLEET` (`'this-page-has-no-fleet'`) and
  `RESEND_BLOCKS.SENDER_HAS_NO_FLEET`, both NOT overridable (it is about WHO the page writes for,
  not timing), both remedied by the /senders fleet control. `templateForRoute` and
  `followUpForRoute` return `reason: 'no-sender-fleet'` when the SENDER's list is empty and
  `'different-fleet'` only when both sides are non-empty and disjoint.

- [ ] **2.3 The dual-fleet route stays a refusal, deliberately.** MEASURED: 0 targets sit in more
  than one category, so `ambiguous` fires for nobody today. With pages in both fleets it becomes
  reachable the moment a company is put in both, and the answer is still a refusal rather than a
  guess: two fleets have two different pitches and picking one silently is the fallback this
  codebase keeps paying for. State it in the docblock; do not add a precedence rule.

- [ ] **2.4 The UI takes a SET of fleets.** `/senders` renders a checkbox per fleet per account
  (not a dropdown — a dropdown cannot express "both" or "none") with the current state checked,
  and a row with none reads **"No fleet — writes to nobody"** rather than showing a bollywood
  chip it does not have. `setSenderFleets(handle, slugs[])` replaces the single-slug write, is
  `requireOperator()`-guarded as its first statement, refuses an unknown slug outright, and writes
  the memberships BEFORE creating routes (third time in this codebase — `routeAllowed` READS them).

- [ ] **2.5 The migration.** `src/scripts/sender-fleets.ts`, DRY RUN BY DEFAULT:
  creates the `bollywood` Category row (it does not exist), gives the four bollywood pages
  **bollywood AND marketing**, leaves @madaboutmarketingg marketing-only, touches no non-fleet
  account, prints the pair rows `ensureFleetPairs` will then create (~4 × 145 = ~580), and audits
  every write.
- [ ] **2.6 Tests:** sender-empty writes to nobody; sender in both reaches a bollywood target with
  the bollywood copy and a marketing target with the marketing copy; a marketing-only page is
  still refused a bollywood target; membership-before-routes ordering. Mutation-test 2.1 by making
  `senderFleets` fall back to the default — the writes-to-nobody case must fail.
- [ ] **2.7 Commit** `feat(fleets): a sender holds any set of fleets, and none means none`

---

## Task 3 — The ring passes the turn to the next page whose route is clear

**Files:** Modify `src/outreach/categories.ts`, `src/app/view-model/rest-tally.ts`.
Test: `tests/rotation-fleet.test.ts`.

- [ ] **3.1 Add the reply halt to the blocked-route map.** `readBlockedRoutes` already makes a
  parked FAILED attempt a per-(target,sender) blocker and `nextSender` already walks past a
  blocked member — so the parked half of this is done and **the reply halt is the missing half.**
  It gains the two facts it needs, required rather than defaulted:

```ts
export async function readBlockedRoutes(args: {
  targetIds?: readonly string[]
  /** The reply halt's own window and scope — the SAME values the gate enforces. */
  replyHalt: { scope: ReplyHaltScope; resumeHours: number; now?: Date }
}): Promise<Map<string, Map<string, string>>>
```
  and a second query alongside the FAILED one:

```ts
prisma.outreachAttempt.findMany({
  where: {
    replyPostedAt: { gte: replyHaltFloor(args.replyHalt.resumeHours, args.replyHalt.now) },
    replyHandledAt: null,
    ...(targetIds ? { targetId: { in: [...new Set(targetIds)] } } : {}),
  },
  select: { pair: { select: { targetId: true, senderId: true } } },
})
```
  filed as *"they replied to this page, so it is holding for a week"*. When the scope Setting is
  `target` the halt is fleet-wide and no page is clear, so the map is deliberately NOT written —
  skipping to another page would be the widening Tabish did not choose.

- [ ] **3.2 The exposure, stated in the docblock and in CLAUDE.md — not a side effect.**

```
 * ── WHAT THIS WIDENS, AND IT IS THE POINT (2026-09-04, Tabish) ────────────
 *
 * Until now the turn advanced only on a DELIVERY, so a page that could not deliver held the
 * recipient: a reply halts that page for seven days, an uncertain send parks its route
 * permanently, and rotation went on electing it while the other pages sat idle. MEASURED:
 * 116 recipients have replied to some page.
 *
 * The turn now passes to the next page in the ring whose route to THIS recipient is clear.
 * **So a recipient mid-conversation with page A will hear from page B inside the same week.**
 * That is the trade Tabish chose and it is stated rather than smoothed over: the reply halt
 * stays PAIR-scoped exactly as decided on 1 September, and the whole content of that decision
 * is that the other pages keep writing. What changes here is only that they no longer have to
 * wait behind the halted one to do it.
 *
 * `replyHaltScope=target` restores the fleet-wide halt in one Setting row, and this function
 * writes no reply blocker under it — see above.
```

- [ ] **3.3 Mirror it in the rest tally** so the panel that explains a hold names the page that is
  actually next, and drop the `all-unavailable` bucket's stale wording where a route rather than
  the account is the cause.
- [ ] **3.4 Test against a real SQLite file:** three pages, a reply on page A's pair inside the
  window → the turn elects page B; the reply handled → A is elected again; scope `target` → the
  whole ring holds. **Mutation-test:** delete the reply query from `readBlockedRoutes` — the
  first case must fail.
- [ ] **3.5 Commit** `feat(rotation): the turn passes to the next page whose route is clear`

---

## Task 4 — A follow-up from one page waits for the next IST day

**Files:** Modify `src/outreach/governor.ts`, `src/outreach/gate.ts`, `src/outreach/plan.ts`,
`src/app/view-model/rest-tally.ts`, `src/app/messages/remedy.ts`, `src/app/rules/*`.
Test: `tests/governor.test.ts`, `tests/stopInventory.test.ts`.

- [ ] **4.1 The rule.** A follow-up is refused when this page has already delivered to this
  recipient today (IST). Governor: `SKIP_REASONS.FOLLOW_UP_SAME_DAY` → `'follow-up-waits-for-tomorrow'`.
  Gate: `RESEND_BLOCKS.FOLLOW_UP_SAME_DAY`. **NOT overridable**, for the reason `PAIR_DAILY_CAP`
  is not: crossing a spacing rule sends one extra message, crossing a daily rule has no bound.
  Refusal sentence: *"@x already wrote to them today — a second message from the same page waits
  for tomorrow."* The day boundary is the existing IST helper the pair cap already uses, so the
  two cannot name different days across midnight.

```
 * ── WHY A DAY AND NOT A GAP (2026-09-04, Tabish) ──────────────────────────
 *
 * MEASURED over 14 days: 16 pair-days carried more than one delivery and 5 carried three or
 * more — @madaboutmarketingg wrote to @supersox_india at 14:26, 14:36 and 14:48 on 2 September.
 * With one page in the marketing ring, a second paid post detected the same afternoon becomes a
 * second message the same afternoon, and from the recipient's side that is one page writing
 * three times in twenty minutes.
 *
 * Tabish: *"madabout (if it is sole or others in the ring are exhausted) sends the follow up
 * message the very next day (not the same day)."* A FIRST touch is untouched — it is the only
 * message that pair has ever sent.
```

- [ ] **4.2 Rest tally + remedy + rules page.** `stopInventory` is TOTAL over `RESEND_BLOCKS` and
  `remedy.ts` is TOTAL over it too, so both fail until the new stop has a label and a remedy;
  the remedy is `href: null` with the clock phrase *"tomorrow"* — nothing a person can press
  releases it, and offering a button would imply a fault.
- [ ] **4.3 Test both directions** and **mutation-test** by deleting the governor arm — the
  same-day case must fail. **Commit** `feat(follow-up): a second message from one page waits for tomorrow`

---

## Task 5 — Once they have replied, nobody sends them the standard message again

**Files:** Modify `src/outreach/compose.ts`, `src/outreach/governor.ts`, `src/outreach/gate.ts`,
`src/outreach/plan.ts`. Test: `tests/deliver-challenged.test.ts` or a new `tests/replied-only-follow-ups.test.ts`.

- [ ] **5.1 One shared predicate, two callers**, in `src/outreach/followUpTemplate.ts`:

```ts
/**
 * IS THIS MESSAGE A FOLLOW-UP? Two facts, and the second is new (2026-09-04, Tabish).
 *
 * The pair's own history is the obvious one: a page that has written before writes a follow-up.
 * The other is about the RECIPIENT: *"if the 7 day period has passed and they have replied then
 * we don't need to ever send the normal message to them again ever."* A company that has
 * answered any of our pages is in a conversation, and the standard message is an introduction —
 * introducing ourselves to someone already talking to us reads as a machine, and with the ring
 * change above a second page now reaches them mid-conversation by design.
 *
 * So a recipient who has EVER replied only ever receives follow-ups, from every page, forever.
 * A page with nothing describable to cite therefore writes nothing at all, which is the same
 * instruction's other half.
 *
 * Computed identically by the composer (which bytes to write) and the gate (which template to
 * check), from DB facts both can read — never stored on the draft, because a draft written
 * before the reply would then carry a stale answer.
 */
export function isFollowUp(args: { touchesSoFar: number; targetHasEverReplied: boolean }): boolean {
  return args.touchesSoFar > 0 || args.targetHasEverReplied
}
```

- [ ] **5.2 Wire it.** `plan.ts` preloads, per recipient, whether any attempt carries a
  non-null `replyPostedAt` (one batched `groupBy`, no query per pair) and passes
  `targetHasEverReplied` to the governor; the governor's follow-up arms
  (`NO_NEW_MATERIAL`, `NO_DESCRIBABLE_POST`, `NO_FOLLOW_UP_TEMPLATE`) key on `isFollowUp(...)`
  rather than `touchesSoFar > 0`; `composeForPair` picks the follow-up copy on the same predicate;
  `gate.ts` replaces `isFollowUp: (thisDraft?.touchNumber ?? 1) > 1` with the same call over the
  same two facts. `touchNumber` keeps counting the pair's own history and is not overloaded.
- [ ] **5.3 Test:** a never-written pair whose recipient replied to ANOTHER page gets the
  follow-up template and is refused when no post can be described; the same pair with no reply
  anywhere gets the standard message. **Mutation-test** by dropping the `targetHasEverReplied`
  arm. **Commit** `feat(follow-up): a recipient who has replied never gets the standard message again`

---

## Task 6 — Restore the marketing follow-up copy, re-rendered against the live pairs

- [ ] **6.1 State the honest position first.** The 4 September audit row claims the body was
  backed up and **no backup exists** — not in a Setting, not in any audit detail. It is
  recoverable anyway and from stronger evidence: all 19 delivered marketing follow-ups
  reconstruct to one template, **byte-identical to the default `followUpBody`**.
- [ ] **6.2 Re-render BEFORE restoring.** A script that walks every live marketing pair holding a
  follow-up, computes the subject with the FIXED rule, and prints sender → recipient → subject,
  including post `DcyE65LPYMj`. Required outcome: **zero subjects naming a watched channel, its
  events or its sponsors**, and the known-good ones (Maybelline, Nykaa, Taneira, Sebamed,
  Mirzapur The Movie) still named.
- [ ] **6.3 Restore** `followUpBody:marketing` to the reconstructed body with an audit row naming
  the evidence it came from. **Discard** any waiting marketing follow-up draft whose stored body
  cites a subject the fixed rule now refuses, through `discardAttempt` (the one writer).

---

## Task 7 — Green, deployed, and shipped

- [ ] **7.1** `pnpm typecheck` (read the exit code directly, never through a pipe) and `pnpm test`.
- [ ] **7.2** `bash scripts/prisma-client-for-env.sh` afterwards — the suite leaves the SQLite client.
- [ ] **7.3** `pnpm ig:layout` with `DS_QUERY_COUNT=1` and `DS_LAYOUT_TOKEN` — ALL PASSED, and the
  per-page query budgets still under their ceilings after the rest-tally preloads. A budget is a
  ceiling over a bounded design; do not raise one to make the check pass.
- [ ] **7.4** `bash scripts/deploy.sh`, then run `pnpm ig:sender-fleets --run` against production
  **after** the deploy, then restore the marketing follow-up body, then verify autopilot delivers.
- [ ] **7.5** `bash scripts/build-dmg.sh` from the final commit, verify `spctl` accepts it, and
  confirm the hosted download serves the same bytes.
- [ ] **7.6** Verify live: autopilot ON, deliveries flowing, marketing ring now five pages, no
  same-day second message from one page, `/senders` showing the fleet checkboxes, `/` and
  `/targets` naming the right next page.
- [ ] **7.7** Update `CLAUDE.md` and memory only once all of the above is green.
