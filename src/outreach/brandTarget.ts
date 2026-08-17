import { prisma } from '@/lib/db'
import { env } from '@/lib/env'
import { routeAllowed, fleetHandles } from '@/outreach/routes'
import type { BrandVerdict } from '@/detection/resolveBrand'

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
export type BrandTargetOutcome = 'created' | 'exists' | 'is-our-sender'

export async function createBrandTarget(
  verdict: Extract<BrandVerdict, { kind: 'BRAND' }>,
  campaign: { id: string; shortcode?: string; channelHandle?: string } | null,
  auditAction: 'brand.discovered' | 'brand.auto-decided',
  actor: string,
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
  const senders = await prisma.senderAccount.findMany()
  const ourHandles = await fleetHandles(prisma)
  await prisma.outreachPair.createMany({
    data: senders
      .filter((s) =>
        routeAllowed({
          senderHandle: s.handle,
          targetHandle: handle,
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
