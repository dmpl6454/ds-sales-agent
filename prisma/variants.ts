/**
 * Twelve hand-written message bodies.
 *
 * Written by hand, not generated at runtime. Two reasons: the pitch should be
 * editorially owned rather than paraphrased by a model on every send, and it
 * removes the last reason for this project to hold an LLM API key.
 *
 * Each body is the MIDDLE of the message only. `renderMessage()` supplies the
 * greeting, the "I'm <name>, <title>." line, the hook line, the closing line and
 * the signature block. Do not repeat any of those here.
 *
 * `{{brand}}` is substituted with the detected sponsor when one is known, and
 * falls back to "your brand partners". `{{channel}}` becomes the recipient's
 * display name.
 *
 * All claims are load-bearing and come from the agency deck: 200+ pages,
 * 169.2M followers (75.6M Instagram / 93.6M Facebook), 300M+ views per day,
 * 10B+ views per month.
 */

export interface VariantSeed {
  label: string
  body: string
}

export const MESSAGE_VARIANTS: VariantSeed[] = [
  {
    label: 'partnership-first',
    body: `I'm reaching out to explore a long-term strategic partnership rather than a one-off campaign.

Through our Bollywood and paparazzi network we generate over 30 crore (300M) views a day, which gives film studios and entertainment brands consistent visibility at scale rather than a single spike.

We'd love to discuss an annual collaboration covering your upcoming film releases, trailers, music launches and celebrity moments through our owned media ecosystem.

If you're open to it, I'd appreciate 20 minutes to walk you through a tailored plan.`,
  },
  {
    label: 'numbers-first',
    body: `Some context on scale before I make the ask: we operate 200+ owned pages across Instagram, Facebook, YouTube and Snapchat — 169.2M followers combined, and over 10 billion views a month.

Most brands come to us for a single campaign. The ones who see compounding returns commit to a calendar.

That's what I'd like to discuss with {{channel}}: an annual collaboration rather than a one-off, so your releases and launches land against consistent reach instead of starting from zero each time.

Would 20 minutes work to share a tailored plan?`,
  },
  {
    label: 'insight-first',
    body: `One pattern we see constantly: a campaign performs, everyone is pleased, and then the audience momentum built over those two weeks is allowed to decay before the next push.

Continuity is what fixes that, and it's why I'm writing about a partnership rather than a placement.

Our network delivers 30 crore (300M) views daily across Bollywood, paparazzi and entertainment properties we own outright — so we can plan around your release calendar instead of reacting to it.

Could I take 20 minutes to show you what an annual structure would look like?`,
  },
  {
    label: 'owned-media',
    body: `The distinction I'd stress is that this is owned media, not bought placement. We run the 200+ pages ourselves, which means guaranteed slots, no auction pricing, and editorial control over how a story lands.

At 30 crore (300M) views a day, that's meaningful reach for film releases, trailers, music launches and celebrity moments.

I'd like to propose an annual collaboration built around your calendar rather than a one-off campaign.

Would you have 20 minutes for a tailored walkthrough?`,
  },
  {
    label: 'annual-calendar',
    body: `Every studio and entertainment brand we work with has the same rhythm: announcement, first look, trailer, music, release week, then the long tail.

Buying that campaign by campaign is expensive and inconsistent. Planning it once, annually, is neither.

Our network reaches 30 crore (300M) views a day across 200+ owned Bollywood and paparazzi properties, and we'd like to build a calendar-led partnership around your slate.

If there's interest, I'd value 20 minutes to take you through a plan shaped to your releases.`,
  },
  {
    label: 'category-breadth',
    body: `Our strength is that the categories sit under one roof: paparazzi and celebrity spottings, film and OTT marketing, music and audio integration on reels, and brand content across 200+ owned pages.

That combination is what produces 30 crore (300M) views a day and why a single partnership can cover a full campaign arc rather than one beat of it.

I'd like to discuss an annual collaboration with {{channel}} across your releases, launches and celebrity moments.

Would 20 minutes be possible?`,
  },
  {
    label: 'credibility',
    body: `We've run campaigns with production houses and brands across the Hindi entertainment ecosystem — Coke Studio, Titan Eye+ and Salman Khan Films among them — through pages we own including Movified, Telly Drama, Crazy 4 Bolly, Bollywood Shots and Dubai Paps.

Combined, that's 169.2M followers and 30 crore (300M) views a day.

I'd like to explore an annual partnership rather than another one-off campaign, structured around your release calendar.

Could I have 20 minutes to walk you through it?`,
  },
  {
    label: 'efficiency',
    body: `A practical reason to consider an annual structure: per-campaign buying means renegotiating rates, re-briefing creative and rebuilding audience momentum every time.

An annual partnership removes all three. Fixed economics, a standing brief, and reach that accumulates.

We deliver 30 crore (300M) views a day across 200+ owned pages, so the scale is there to make continuity worth structuring.

I'd welcome 20 minutes to show you what that would look like for {{channel}}.`,
  },
  {
    label: 'direct-ask',
    body: `I'll be direct: I'd like 20 minutes with you to propose an annual collaboration rather than a single campaign.

The substance is straightforward. We own 200+ Bollywood, paparazzi and entertainment pages producing 30 crore (300M) views a day, and we can commit that reach against your release calendar for a year instead of quoting it project by project.

If the idea is worth exploring, I'll come with a tailored plan and firm numbers.`,
  },
  {
    label: 'release-arc',
    body: `A film release is really six or seven distinct moments — casting news, first look, trailer, music, release week, box office milestones, and the streaming window.

Each one benefits from reach that is already warm. Ours is: 30 crore (300M) views a day across 200+ owned pages, in Bollywood and paparazzi specifically.

I'd like to propose an annual partnership that covers the whole arc rather than a single beat.

Would 20 minutes work for a tailored walkthrough?`,
  },
  {
    label: 'multi-platform',
    body: `Audiences don't sit on one platform, and our network doesn't either — 100+ Instagram pages (75.6M followers), 100+ Facebook pages (93.6M), plus YouTube and Snapchat.

That's 30 crore (300M) views a day, and it means a single campaign can be amplified across every surface simultaneously rather than platform by platform.

I'd like to discuss an annual collaboration covering your releases, trailers, music launches and celebrity moments.

Could I take 20 minutes of your time?`,
  },
  {
    label: 'brief',
    body: `Briefly: we own 200+ Bollywood and paparazzi pages doing 30 crore (300M) views a day, and I think there's a strong annual partnership here rather than a one-off campaign.

Film releases, trailers, music launches, celebrity moments — planned once, across the year, through media we control end to end.

Worth 20 minutes? I'll bring a plan built around your calendar.`,
  },
]
