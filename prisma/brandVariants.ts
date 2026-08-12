/**
 * Message bodies for BRANDS — a different proposition from the channel pitch.
 *
 * WHY THIS FILE IS SEPARATE FROM variants.ts
 *
 * `variants.ts` pitches a PARTNERSHIP to a fellow publisher: "we generate 300M views a
 * day, let's work together". That is peer-to-peer, media owner to media owner.
 *
 * A brand is not a peer. It is a buyer that has just PROVED it has budget by paying a
 * publisher for placement. So the ask inverts: you are already buying reach on
 * entertainment publishers, and we sell the same reach directly. Same network numbers,
 * completely different proposition — which is why reusing the channel pool would be wrong
 * even if `MessageVariant.targetKind` did not exist to prevent it.
 *
 * These are FOLLOW-UPS. The first touch is a bespoke body built from the actual campaign
 * the brand was discovered in (`brandFirstTouch` in src/outreach/brandPitch.ts) — it names
 * the real publisher and the real placement, because that is a verifiable fact about that
 * one recipient rather than a merge field. Reusing the bespoke body for a follow-up would
 * be the exact repetition decision 3 exists to prevent.
 *
 * Each body is the MIDDLE of the message only. `renderMessage()` supplies the greeting,
 * the "I'm <name>, <title>." line, the closing line and the signature block. Do not
 * repeat any of those here.
 *
 * `{{brand}}` becomes the recipient's own name; `{{channel}}` also resolves to the
 * recipient (the placeholder is shared with the channel pool and `renderMessage` fills it
 * from the greeting name, never from `displayName` — an internal label once leaked into a
 * live message that way).
 *
 * WHO WE ARE PITCHING TO, AND WHO WE ARE NOT
 *
 * Only accounts resolved as BRAND: a professional account whose Instagram category is a
 * business type, not a profession and not an agency. A fashion designer appeared in the
 * placement; they did not buy it. An advertising agency is the other side of the table.
 * Both were briefly created as prospects on 2026-08-03 and both are now excluded.
 *
 * All claims are load-bearing and come from the agency deck: 200+ pages, 169.2M followers
 * (75.6M Instagram / 93.6M Facebook), 300M+ views per day, 10B+ views per month.
 */

export interface BrandVariantSeed {
  label: string
  body: string
}

export const BRAND_MESSAGE_VARIANTS: BrandVariantSeed[] = [
  {
    label: 'direct-vs-intermediary',
    body: `You are already investing in placement on entertainment publishers, so I will be brief about why we might be worth a conversation.

We own the inventory rather than broker it: 200+ pages across Instagram, Facebook, YouTube and Snapchat, 169.2M followers combined, and over 30 crore (300M) views a day. Buying from us is buying the reach directly.

For a brand running placements at your frequency, that usually means a materially better rate per view and one calendar instead of a series of separate negotiations.

Could I send a short plan with indicative numbers for {{brand}}?`,
  },
  {
    label: 'calendar-not-campaign',
    body: `Most brands reach us for one campaign. The ones who see compounding returns commit to a calendar instead.

The reason is simple: a single placement spikes and decays, while a sustained presence across 200+ owned pages — 10 billion views a month — keeps you visible between launches, when your competitors have gone quiet.

I would like to propose an annual plan for {{brand}} rather than another one-off, priced as media buying rather than influencer fees.

Would 20 minutes be useful?`,
  },
  {
    label: 'audience-overlap',
    body: `The audience you just paid to reach is the audience we own.

Our 200+ pages sit in exactly that space — Bollywood, entertainment, lifestyle and paparazzi coverage — with 75.6M followers on Instagram alone and 300M+ views a day across the network.

So rather than pitching you something new, I am offering the same audience at media-buying rates, with the frequency and the creative control that comes from dealing with the owner.

Happy to share a plan built around {{brand}}'s next few months if that is useful.`,
  },
  {
    label: 'rate-and-scale',
    body: `Two numbers that usually decide whether this conversation is worth having.

We operate 200+ owned pages with 169.2M combined followers and serve over 10 billion views a month. Because the inventory is ours, the cost per view we can offer a brand buying directly is not comparable to a per-post influencer rate.

If {{brand}} is spending on entertainment placement with any regularity, a direct buy is very likely the cheaper route to the same people.

I can put indicative pricing in front of you this week — worth a look?`,
  },
  {
    label: 'always-on',
    body: `A placement works while it runs. The gap afterwards is where most brand spend quietly leaks.

We solve that with volume rather than a bigger single buy: 200+ pages, 300M+ views a day, so a brand can hold presence continuously instead of appearing in bursts and starting from zero each time.

For {{brand}} that would mean a rolling calendar across our network, planned around your launches rather than around ours.

Would you like me to sketch what a quarter of that looks like?`,
  },
  {
    label: 'proof-then-ask',
    body: `A quick note on what we actually are, since a cold message deserves the specifics.

Digital Sukoon owns and operates 200+ pages — 75.6M followers on Instagram, 93.6M on Facebook, 10B+ views a month. We are the publisher, not an agency reselling someone else's audience, which is why brands buying directly from us see rates closer to media buying than to influencer marketing.

If placement is part of how {{brand}} goes to market, I think there is a straightforward case here.

May I send a one-page plan?`,
  },
]
