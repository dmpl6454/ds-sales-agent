import { DEFAULT_CATEGORY_SLUG, effectiveCategories } from './senderCategories'

/**
 * WHICH STANDARD MESSAGE DOES THIS ROUTE SEND? — one rule, three callers.
 *
 * ── TABISH'S RULE, 2026-08-26 ─────────────────────────────────────────────
 *
 * *"a separate template message would be sent for the marketing and brand category.
 * Autopilot is going to remain on which I will provide keep it empty for now"*
 *
 * So the second fleet gets its OWN copy, he writes it, and until he does it is EMPTY —
 * while autopilot stays on and `@madaboutmarketing` is about to be connected. That last
 * sentence is the whole design problem: the moment a marketing sender exists, the planner
 * will reach 35 live marketing prospects, and the question "what does it say to them?"
 * has to have an answer that is neither *the bollywood pitch* nor *nothing*.
 *
 * ── AN UNSET TEMPLATE REFUSES. IT NEVER FALLS BACK ────────────────────────
 *
 * Both fallbacks are worse than a refusal and both are the shapes this codebase keeps
 * paying for:
 *
 *   fall back to the DEFAULT copy → a marketing-trade company receives the entertainment
 *     network's pitch from the marketing page. The fleets exist precisely so that does not
 *     happen, and it would be INVISIBLE — a well-formed message to a real company, wrong
 *     only in what it says. *"Absence of data hardening into a verdict."*
 *
 *   render the empty string → `distinctiveSlice` returns null on it, which refuses every
 *     send in the system with no sentence naming the cause. A sending outage pointing at
 *     nothing, hours later. That is the `MAX_TOTAL_SENDS` shape.
 *
 * So a fleet with no copy is a NAMED refusal — at the governor, so no draft is written that
 * can never be sent, and at the gate, so anything written before this rule is caught. The
 * remedy is one textarea on the Autopilot page, and the refusal says so.
 *
 * ── THE DEFAULT FLEET AND A SECOND FLEET ARE NOT SYMMETRICAL ──────────────
 *
 * This asymmetry is deliberate and is the thing most likely to be "simplified":
 *
 *   | fleet          | no Setting row means                        |
 *   |----------------|---------------------------------------------|
 *   | bollywood      | the SHIPPED copy (`SINGLE_TEMPLATE_MIDDLE`) |
 *   | anything else  | NO COPY EXISTS — refuse                     |
 *
 * The default fleet has shipped copy in the source, so "unset" there means *nobody has
 * overridden it* and the effective body is never empty — which is why `defaultBody` is a
 * plain `string` here rather than a nullable one. A second fleet has no shipped copy by
 * construction: nobody has written its pitch yet. Collapsing the two would reinstate the
 * silent fallback above.
 *
 * ── WHICH FLEET IS "THIS ROUTE'S" FLEET ───────────────────────────────────
 *
 * The INTERSECTION of the sender's effective categories and the recipient's — the same set
 * intersection `sameCategory` already computes, so the two can never disagree about which
 * fleet a route belongs to.
 *
 *   | sender      | recipient              | route fleet | template   |
 *   |-------------|------------------------|-------------|------------|
 *   | (none)      | (none)                 | bollywood   | default    |
 *   | marketing   | marketing              | marketing   | marketing  |
 *   | marketing   | [bollywood, marketing] | marketing   | marketing  |
 *   | (none)      | [bollywood, marketing] | bollywood   | default    |
 *   | marketing   | (none)                 | ∅           | REFUSED    |
 *
 * Row 3 is the point of using the intersection rather than the recipient's own membership:
 * a company BOTH fleets found ("unless they are present common elsewhere") hears the pitch
 * of whichever page is writing, because the copy is that page's proposition and reading it
 * as anything else would put the entertainment pitch under the marketing page's name.
 *
 * TWO refusals that are not "not set", and both fail closed rather than choosing:
 *
 *   `different-fleet` — the sets do not intersect. `gate.ts` and `routes.ts` already refuse
 *     this and it should never reach here; answering it anyway means a caller that forgot
 *     the category check gets a refusal instead of a template.
 *
 *   `ambiguous` — the intersection holds two or more fleets, which needs a SENDER in two
 *     fleets. Two fleets' copy are both candidates and picking one silently is exactly the
 *     failure above wearing a tidier hat. Unreachable today (no sender is in any category)
 *     and named rather than assumed.
 *
 * PURE. No I/O, no clock.
 */

export type FleetTemplate =
  | { ok: true; slug: string; body: string }
  | { ok: false; slug: string | null; reason: 'not-set' | 'ambiguous' | 'different-fleet'; detail: string }

/**
 * The Setting row that holds one fleet's copy.
 *
 * A key PER SLUG rather than a hardcoded `marketingTemplateBody`, for the same reason
 * `sameCategory` is a set intersection rather than a pair of booleans: a third fleet costs
 * one `Category` row and one of these, and nothing in this file changes.
 *
 * The DEFAULT fleet keeps its existing key (`singleTemplateBody`) and its existing meaning.
 * Migrating it here would rewrite the one row an operator has already been editing, to gain
 * nothing.
 */
export function fleetTemplateKey(slug: string): string {
  return `templateBody:${slug.trim().toLowerCase()}`
}

/** The fleets this route belongs to: sender ∩ recipient, over the EFFECTIVE sets. */
export function routeFleets(
  senderCategories: readonly string[],
  targetCategories: readonly string[],
): string[] {
  const target = new Set(effectiveCategories(targetCategories))
  return effectiveCategories(senderCategories).filter((s) => target.has(s))
}

export function templateForRoute(args: {
  senderCategories: readonly string[]
  targetCategories: readonly string[]
  /** The EFFECTIVE default-fleet body — the saved override or the shipped copy. Never empty. */
  defaultBody: string
  /** Per-slug copy for NON-default fleets. Absent or blank means nobody has written it yet. */
  bodies: ReadonlyMap<string, string | null | undefined>
}): FleetTemplate {
  const fleets = routeFleets(args.senderCategories, args.targetCategories)

  if (fleets.length === 0) {
    return {
      ok: false,
      slug: null,
      reason: 'different-fleet',
      detail:
        'this page and this recipient belong to different fleets, so there is no standard ' +
        'message that covers the two of them',
    }
  }

  if (fleets.length > 1) {
    return {
      ok: false,
      slug: null,
      reason: 'ambiguous',
      detail:
        `this page sends for more than one fleet (${fleets.join(' and ')}) and each has its ` +
        `own standard message, so which one to send is not decided — put the page in a ` +
        `single fleet`,
    }
  }

  const slug = fleets[0]!

  if (slug === DEFAULT_CATEGORY_SLUG) return { ok: true, slug, body: args.defaultBody }

  const raw = args.bodies.get(slug)
  const body = typeof raw === 'string' ? raw.trim() : ''
  if (body.length === 0) {
    return {
      ok: false,
      slug,
      reason: 'not-set',
      detail:
        `the ${slug} fleet has no standard message written yet, and its recipients are ` +
        `never sent the other fleet's copy — write it on the Autopilot page and these go out`,
    }
  }

  return { ok: true, slug, body }
}

/**
 * THE STANDARD MESSAGE (2026-08-18, Tabish's copy, verbatim) — the DEFAULT fleet's.
 *
 * *"we need only a single template message to be sent, no signature name whatsoever …
 * and no there must be no space after hi, it is all continuous."*
 *
 * This IS the whole message. Nothing is prepended or appended — no greeting (the "Hi," is
 * the template's own first characters, deliberately with no space after the comma), no
 * closing line, no signature block.
 *
 * MOVED HERE FROM `compose.ts` ON 2026-08-26, and the move is not tidying. Once a second
 * fleet has copy of its own, "which body does this route send" is a RULE rather than a
 * constant, and the shipped default is one input to it. Leaving the constant in the
 * composer would have meant the composer resolving one fleet's body itself and being handed
 * the other's — two ways to answer one question, which is the drift `gate.ts`,
 * `readThread.ts` and `judge.ts` were each extracted to stop. `compose.ts` re-exports it, so
 * every existing importer is unchanged.
 *
 * ── THE CONSTRAINT THAT SHAPES THIS COPY, AND IT IS NOT EDITORIAL ─────────
 *
 * `distinctiveSlice` needs a line of at least `MIN_NEEDLE_CHARS` (40) to build the needle
 * both send guards search for — the composer read-back and the thread delta. A single-line
 * body takes `proseLines`' single-line branch (nothing is dropped by position), so the rule
 * when editing this copy is simply: **keep it over 40 characters.** Below that,
 * `distinctiveSlice` returns null and null refuses every send in the system.
 * `checkTemplateBody` applies the same floor at save time so an unsendable template cannot
 * be stored — and it applies to EVERY fleet's copy, not only this one.
 */
export const SINGLE_TEMPLATE_MIDDLE = `Hi,We’re an Entertainment & Pop Culture Media Network generating over 300M views every day. We work with films, songs, celebrities, and brands to amplify campaigns and deliver extended reach at scale. Let’s connect - +916000189766 - Kapil`

/**
 * The parts of `RuntimeSettings` this rule needs, STRUCTURALLY.
 *
 * Named as a shape rather than imported from `lib/settings.ts` so this module stays pure and
 * importable from anywhere — `settings.ts` constructs a Prisma client transitively, and a
 * pure rule that opens a database connection to be loaded is the trap `tests/pool-bounds`
 * was written for.
 */
export interface TemplateSettings {
  singleTemplateBody: string | null
  fleetTemplateBodies: ReadonlyMap<string, string>
}

/**
 * The DEFAULT fleet's effective body: the saved override, or the shipped copy.
 *
 * Never empty by construction — `setSingleTemplateBody` deletes the row rather than storing
 * a blank one, and `getSettings` treats whitespace-only as unset. That is why
 * `templateForRoute` takes a plain `string` for it and only a SECOND fleet can be "not set".
 */
export function defaultFleetBody(settings: Pick<TemplateSettings, 'singleTemplateBody'>): string {
  const override = settings.singleTemplateBody?.trim()
  return override && override.length > 0 ? override : SINGLE_TEMPLATE_MIDDLE
}

/**
 * ONE CALL, THREE CALLERS — the planner (which refuses to draft), the gate (which refuses
 * to send) and the composer (which writes the bytes).
 *
 * They are not allowed to disagree about which fleet a route belongs to or which copy that
 * fleet has, so none of them resolves either half itself. Same discipline as `crossSpacing`
 * and `materialAllowance`: the caller loads the facts, the pure rule decides.
 */
export function templateForSettings(
  settings: TemplateSettings,
  senderCategories: readonly string[],
  targetCategories: readonly string[],
): FleetTemplate {
  return templateForRoute({
    senderCategories,
    targetCategories,
    defaultBody: defaultFleetBody(settings),
    bodies: settings.fleetTemplateBodies,
  })
}
