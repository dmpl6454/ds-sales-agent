/**
 * Bespoke first messages — one written from scratch per recipient.
 *
 * Why these exist rather than a template with merge fields:
 *
 * Meta's written spam policy states that repetitive content *lowers the frequency
 * threshold at which restrictions are applied*. That makes message uniqueness a
 * first-class safety control, not copywriting polish — and at one or two messages a
 * day it is the control that matters most, because volume is already far below
 * anything that binds. A shared skeleton with substituted names does not count as
 * variation; neither does spintax. Research turned up an aged account that sent
 * only ~20 spintax-varied messages and was still blocked.
 *
 * So each of these was written against what that specific recipient actually
 * published, observed on 2026-07-29/30:
 *
 *   @madovermarketing_mom — a marketing publication that ALSO takes branded work,
 *     disclosed with #Collaboration. Recent: Black & White Non-Alc (built around
 *     cricket's own rhythm, "Fan Standard Time"), Royal Canin at PetFed (vets
 *     explaining pet nutrition across three cities), The Leela Coorg (sensory
 *     marketing, sanctuary as the story). Editorially they cover Uber/football,
 *     a Dublin airport ad, Hamilton→Ferrari, Coldplay's sustainability report.
 *
 *   @viralbhayani — India's largest paparazzi/entertainment feed, ~62 posts/day.
 *     Mixes genuine celebrity coverage with undisclosed film and brand promotion:
 *     Jana Nayagan, Asambhauuu, Ohh My Dog, a Hiranandani Hospital IVF event.
 *
 * No two of these share an opening, a structure, or a closing line. The persona
 * block at the end is the only constant, and that is deliberate — it is who we are.
 *
 * IMPORTANT: `renderMessage()` supplies the greeting and the signature. These
 * bodies are the middle only. They must NOT repeat the greeting, the "I'm Kapil
 * Jain…" line, the closing line, or the contact block.
 */

export interface BespokeSeed {
  /** sender handle → target handle */
  sender: string
  target: string
  /** Why this message is written the way it is. Shown to the operator, never sent. */
  note: string
  body: string
}

/**
 * The burner rehearsal message.
 *
 * Deliberately obvious as a test. It has to exercise the same machinery as a real
 * send — multi-line body, punctuation, an em dash, roughly the same length, the same
 * greeting and signature assembly — because the point is to prove the paste, the
 * composer read-back, and the thread confirmation all work on realistic input. But
 * it must never read as a genuine pitch: if it somehow reached the wrong account,
 * being unmistakably a test is what keeps that harmless.
 *
 * One draft per sender, so each account's own Chrome profile gets proven separately.
 */
const BURNER_BODY = `This is a delivery test from our outreach system — nothing to action.

I am checking that a multi-line message arrives intact: that the line breaks survive, that punctuation and dashes come through unmangled — and that the whole body lands as one message rather than several.

If you are reading this and it looks like one clean message, the test passed.`

const BURNER_DRAFTS: BespokeSeed[] = ['bollywoodsocietyy', 'madaboutmarketingg', 'bollywoodchronicle'].map((sender) => ({
  sender,
  target: 'priyanshu123321123',
  note: `Rehearsal on the burner from @${sender}. Proves this account's Chrome profile can actually deliver, before it is pointed at a real prospect.`,
  body: BURNER_BODY,
}))

export const BESPOKE_DRAFTS: BespokeSeed[] = [
  ...BURNER_DRAFTS,
  {
    sender: 'bollywoodsocietyy',
    target: 'madovermarketing_mom',
    note: 'Leads on their editorial eye, then makes the distribution offer. Cites the Black & White Non-Alc piece and their Royal Canin work specifically.',
    body: `Your Black & White Non-Alc piece was the one that made me want to write. Building the idea around cricket's own rhythm rather than around the product is a harder brief than it looks, and the Royal Canin work at PetFed had the same instinct — put the explanation where the audience already is.

That is roughly the problem we solve on the distribution side. We own around 200 pages across Instagram, Facebook, YouTube and Snapchat in the Bollywood and paparazzi space — about 30 crore views a day — and most of what we run is entertainment: film releases, trailers, music launches, celebrity moments.

The reason I am writing to you rather than pitching a campaign is that you sit on both sides of this. You publish the case studies and you take branded work. An annual arrangement between us could cover the amplification layer for the brands you already work with, instead of each of us solving reach separately every time.

I would rather show you the page list and the numbers than describe them. Twenty minutes, whenever suits.`,
  },
  {
    sender: 'madaboutmarketingg',
    target: 'madovermarketing_mom',
    note: 'Different angle entirely — opens on the Tilara/Leela craft, frames the ask as capacity rather than partnership. Deliberately shares no sentence structure with the Bollywood Society draft, since MOM may receive both.',
    body: `I have been following how you handle branded work — the Tilara film and The Leela Coorg piece both read like editorial first and disclosure second, which is rare and probably why they perform.

I run distribution at Digital Sukoon. We own roughly 200 entertainment and paparazzi pages doing about 30 crore views a day, and the part that might be useful to you is capacity rather than creative: when you take on a brand, the reach is something you have to assemble each time. We already have it standing.

Worth saying plainly that this is not a request to feature us. It is an offer to be the amplification layer behind the work you are already doing, on an annual basis, so the economics are fixed rather than renegotiated per campaign.

If that is interesting, I would value twenty minutes to walk through what we own and what it costs.`,
  },
  {
    sender: 'bollywoodsocietyy',
    target: 'viralbhayani',
    note: 'Peer-to-peer between two paparazzi networks. Acknowledges his scale honestly and proposes complementary distribution rather than pitching him as a client.',
    body: `We are in the same business, which is why I think this is worth a conversation rather than a pitch.

You have built the feed that the rest of the ecosystem reacts to — the volume and the speed on celebrity coverage are genuinely hard to match. On our side we own around 200 pages across Instagram, Facebook, YouTube and Snapchat, roughly 30 crore views a day, weighted towards film, music and OTT rather than daily spottings.

Those two things are complementary rather than competing. When a studio comes to either of us for a release, they usually end up buying both kinds of reach anyway, just separately and at worse rates. An annual arrangement between us would let us go to them together.

I would rather discuss it directly than in a message. Twenty minutes at your convenience.`,
  },
  {
    sender: 'bollywoodchronicle',
    target: 'viralbhayani',
    note: 'Opens on the film-promotion overlap that is visibly a large share of his output. No structural overlap with the Bollywood Society draft, since he may receive both.',
    body: `A large share of what moves through your feed is film promotion — release weeks, trailer drops, first looks. That overlaps almost exactly with what we distribute.

We operate around 200 owned pages in the Bollywood and entertainment space, about 30 crore views a day across Instagram, Facebook, YouTube and Snapchat. Studios come to us for the same release calendar they come to you for.

The straightforward version of the idea: rather than both of us selling into the same studios independently, we put together a combined annual proposition. Your reach on the celebrity and paparazzi side, ours across the owned network, quoted once instead of campaign by campaign.

If it is worth exploring I will come with the page list and firm numbers. Twenty minutes is all I need.`,
  },
]
