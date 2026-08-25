import { prisma } from '@/lib/db'
import { env } from '@/lib/env'
import { routeAllowed, fleetHandles } from '@/outreach/routes'
import { readCategoryMemberships, categoriesFor } from '@/outreach/categories'
import type { BrandVerdict } from '@/detection/resolveBrand'
import { enrichHandle } from '@/detection/enrichHandle'

/**
 * THE ONE PLACE A DISCOVERED BRAND BECOMES A `TargetAccount`.
 *
 * Two callers: the `ig:brands` CLI (a person typed a command) and `autoResolve.ts` (the
 * detection pass, unattended). This repo has FIVE recorded cases of one rule with several
 * callers drifting — `gate.ts`, `readThread.ts`, the two Connect buttons, `judge.ts`, and
 * route creation itself (`tests/one-route-rule.test.ts` names all five) — so brand creation
 * lives here once rather than becoming the sixth.
 *
 * ── WHAT THIS FUNCTION ACTUALLY DECIDES, AND WHY IT IS THE RISKY ONE ──────
 *
 * A `TargetAccount{kind:'BRAND'}` row is a PROSPECT, and since the per-route switch was
 * removed (Tabish, 2026-08-08) a pair row IS a live route. So one call here is the
 * difference between "we noticed a company" and "a revenue account may cold-DM this company
 * unattended". Everything below that looks like housekeeping is the safety content:
 *
 *  - **Never ourselves.** `is-our-sender` refuses a handle that is one of our own sending
 *    accounts. A paid post can perfectly well @-mention one of our own pages, and without
 *    this the automatic path would create a prospect out of `@bollywoodsocietyy`.
 *  - **Routes go through the shared rule**, never a hand-rolled sender list. See below.
 *  - **Brands are messaged, not WATCHED.** `watchEnabled: false` explicitly, against a
 *    schema default of TRUE. A brand's own feed is never the source of a hook line — a cold
 *    first touch uses `brandPitch`, which names the placement we actually saw — so watching
 *    one buys nothing and costs four feed pages a pass, forever, per prospect. The column
 *    defaults true for CHANNELs and relying on that default here would silently enrol every
 *    auto-discovered brand into detection.
 *
 * The return value is a THREE-WAY outcome rather than a boolean, because the two refusals
 * mean different things to a caller counting what a pass did: `exists` is ordinary
 * deduplication (a brand appearing on two channels is the same row) and `is-our-sender` is
 * a safety refusal worth reporting.
 */
export type BrandTargetOutcome = 'created' | 'exists' | 'is-our-sender' | 'refused-unverified'

export async function createBrandTarget(
  verdict: Extract<BrandVerdict, { kind: 'BRAND' }>,
  campaign: { id: string; shortcode?: string; channelHandle?: string } | null,
  auditAction: 'brand.discovered' | 'brand.auto-decided' | 'brand.badge-door',
  actor: string,
  opts: {
    /**
     * A person deliberately admitted from a CAMPAIGN post's Instagram-asserted evidence
     * after passing `admitsAsTalent` (Tabish, 2026-08-19). Exempts the row from
     * `checkRecipientIsNotAPerson` — and ONLY rows created this way are exempt.
     */
    campaignTalent?: boolean
    isVerified?: boolean | null
    followerCount?: number | null
  } = {},
): Promise<BrandTargetOutcome> {
  const handle = verdict.handle

  // Deduplication is free: `TargetAccount.handle` is unique, so a brand seen on both
  // channels resolves to the SAME row and the existing cooldown, reply-halt and opt-out
  // rules cover it with no new logic.
  const existing = await prisma.targetAccount.findUnique({ where: { handle } })
  if (existing) return 'exists'

  /**
   * NEVER MESSAGE OURSELVES. Checked against every sending account, not just fleet
   * members: the burner is not a prospect either, and a `TargetAccount` row for it already
   * exists deliberately as the rehearsal recipient (`safeTargetIds()`), so this branch is
   * about the ones that do NOT yet have a row.
   */
  const sender = await prisma.senderAccount.findUnique({ where: { handle } })
  if (sender) return 'is-our-sender'

  /**
   * EVERY TARGET ROW MUST KNOW WHETHER IT IS VERIFIED, AT BIRTH.
   *
   * `gate.ts` refuses to message an unverified recipient (Tabish, 2026-08-20: "No message
   * is to be sent to any target that are unverified"), and it treats NULL as "not proven
   * verified" — so a row created without the fact would be permanently unmessageable, which
   * loses exactly the leads discovery exists to find. One enrichment call per CREATION
   * (rare, and already the same endpoint discovery just used) makes the invariant hold by
   * construction rather than by remembering to run the audit afterwards.
   */
  const verified =
    opts.isVerified !== undefined ? opts.isVerified : (await enrichHandle(handle)).isVerified

  /**
   * A MEASURED `false` IS REFUSED AT THE DOOR, NOT STORED AS A LIVE PROSPECT.
   *
   * The VERIFIED ONLY rule (Tabish, 2026-08-20) is enforced at the governor and the gate,
   * so an unverified row could never be MESSAGED — but this creator was still WRITING such
   * rows: measured 2026-08-22, six live PROSPECT rows carried `isVerified: false`
   * (@nifborivali, @carpisa.in, …), each admitted here after its own enrichment said no
   * badge, each then refused by the planner on every pass, forever. A row the rule
   * permanently refuses is not a lead, it is clutter that reads as one — the exact state
   * Tabish's 2026-08-20 cleanup retired 18 rows to remove, being recreated one door
   * earlier.
   *
   * ONLY a measured `false` refuses. NULL — the enrichment did not answer — still creates
   * the row: refusing on NULL would let a network blip discard a real lead permanently,
   * absence of data hardening into a verdict. A NULL row is visible, held by the gate, and
   * backfillable by `pnpm ig:audit-targets`, which is the designed remedy.
   *
   * The refusal is AUDITED so the lead is on the record: the "We message" column reads the
   * same fact from BrandLookup, and a person who believes the account is genuine can still
   * admit it deliberately.
   */
  if (verified === false) {
    await prisma.auditLog.create({
      data: {
        actor,
        action: 'brand.refused-unverified',
        entity: `TargetAccount:${handle}`,
        detail:
          `admission refused: Instagram shows no verified badge` +
          ` campaign=${campaign?.id ?? 'none'}` +
          (campaign?.shortcode ? ` post=${campaign.shortcode}` : ''),
      },
    })
    return 'refused-unverified'
  }

  const target = await prisma.targetAccount.create({
    data: {
      handle,
      displayName: verdict.displayName,
      /**
       * NULL, deliberately. `contactFirstName` means a PERSON's first name and we do not
       * know who runs a company's Instagram account.
       *
       * It was once set to the company name, which made `buildGreeting` produce
       * "Hi Amazon India," — addressing a corporation as an individual. Null produces
       * "Hi Amazon India team,", which is what you would write to a brand's social inbox.
       */
      contactFirstName: null,
      kind: 'BRAND',
      /**
       * A discovered brand is the SECOND kind of target: it exists because we saw it buying
       * placement, and writing to it is the whole point. Set explicitly rather than left to
       * the column default, so this row states what it is instead of inheriting it.
       */
      role: 'PROSPECT',
      /**
       * Brands are messaged, not watched. Pointing one at a real detector would fetch a
       * feed every detection pass for every prospect, forever, against an anonymous
       * endpoint whose only risk is an IP block.
       */
      detectorKey: 'passthrough',
      // Explicit against a default of TRUE — see the docblock. Not housekeeping.
      watchEnabled: false,
      optedOut: false,
      discoveredFromCampaignId: campaign?.id ?? null,
      brandCategory: verdict.category,
      campaignTalent: opts.campaignTalent ?? false,
      isVerified: verified,
      followerCount: opts.followerCount ?? null,
    },
  })

  /**
   * ROUTES THROUGH THE SHARED RULE (`routeAllowed`), like every other creator.
   *
   * A brand that got this far cannot be one of our own pages — the `is-our-sender` check
   * above refuses those — so this changes no outcome *today*. It is here because five paths
   * created pairs with five copies of the exclusion and only one of them applied it fully;
   * a creator that hand-rolls the filter is the drift, whether or not its own inputs happen
   * to make the difference invisible. `tests/one-route-rule.test.ts` asserts this rather
   * than trusting the comment.
   *
   * `cooldownDays` comes from `env.DEFAULT_COOLDOWN_DAYS` (7) and not a literal: the schema
   * column defaults to 5 and 7 is the value actually in force, so a hardcoded number here
   * would quietly give auto-discovered brands a different spacing from every other pair.
   */
  /**
   * ── A PROSPECT INHERITS THE FLEET OF THE CHANNEL THAT FOUND IT (2026-08-25) ──
   *
   * Tabish's rule is about PROVENANCE: *"Only targets obtained from them are to be messaged
   * using a new sender."* So the membership is not something a person tags on afterwards —
   * it comes from the paid post, whose channel is already in a fleet.
   *
   * Written BEFORE the routes below, and that order is the correctness of it: `routeAllowed`
   * reads the memberships, so a category applied afterwards would leave the new prospect
   * already wired to every sender of the OTHER fleet, and the gate would then have to hold
   * every one of those drafts forever.
   *
   * A channel in NO category yields a prospect in no category — the default — which is every
   * bollywood row today and is why this changes nothing for them.
   */
  if (campaign?.id) {
    const source = await prisma.detectedCampaign.findUnique({
      where: { id: campaign.id },
      select: { target: { select: { categories: { where: { enabled: true }, select: { categoryId: true } } } } },
    })
    for (const c of source?.target.categories ?? []) {
      await prisma.categoryTarget.upsert({
        where: { categoryId_targetId: { categoryId: c.categoryId, targetId: target.id } },
        create: { categoryId: c.categoryId, targetId: target.id },
        update: { enabled: true },
      })
    }
  }

  const senders = await prisma.senderAccount.findMany()
  const ourHandles = await fleetHandles(prisma)
  /* Loaded once for the whole loop below — a lookup per pair would be an N+1 over a list
     whose size is a product decision. See readCategoryMemberships. */
  const memberships = await readCategoryMemberships()
  await prisma.outreachPair.createMany({
    data: senders
      .filter((s) =>
        routeAllowed({
          senderHandle: s.handle,
          targetHandle: handle,
          senderCategories: categoriesFor(memberships.bySenderHandle, s.handle),
          targetCategories: categoriesFor(memberships.byTargetHandle, handle),
          ourHandles,
          senderIsFleetMember: s.fleetMember,
          targetOptedOut: target.optedOut,
          // Always false in practice — this function writes `role: 'PROSPECT'` a few lines
          // above, because a discovered brand is by definition someone to write to. Read
          // from the row anyway: the predicate is asked the whole question, and a literal
          // here would be a second statement of a fact the row already holds.
          targetIsWatchOnly: target.role === 'WATCH',
        }),
      )
      .map((s) => ({
        senderId: s.id,
        targetId: target.id,
        cooldownDays: env.DEFAULT_COOLDOWN_DAYS,
        enabled: true,
      })),
  })

  /**
   * The audit row is the only lasting record of WHY a company is in the outreach database,
   * and `actor` plus `auditAction` are what separate "a person ran ig:brands" from "a
   * detection pass decided this with nobody present". Months later that distinction is the
   * whole value of the row.
   */
  await prisma.auditLog.create({
    data: {
      actor,
      action: auditAction,
      entity: `TargetAccount:${handle}`,
      detail:
        `kind=BRAND category=${verdict.category ?? 'none'} campaign=${campaign?.id ?? 'none'}` +
        (campaign?.shortcode ? ` post=${campaign.shortcode}` : '') +
        (campaign?.channelHandle ? ` on=@${campaign.channelHandle}` : ''),
    },
  })

  return 'created'
}
