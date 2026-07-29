/**
 * Real og:description strings captured from both target channels on 2026-07-29
 * by fetching /p/{shortcode}/ logged out.
 *
 * Counts, handles, dates, hashtags and @mentions are verbatim. A few long
 * caption middles are elided with a plain-prose stand-in — the head, the tail and
 * every signal-bearing token are exactly as Instagram returned them, which is
 * what the parser and detectors actually key on.
 *
 * These are the ground truth for the detection suite. If Instagram changes the
 * og:description shape, the parser tests here fail loudly — which is the point.
 */

export interface PostFixture {
  shortcode: string
  og: string
  /** What a human says this post is. */
  truth: 'PAID' | 'ORGANIC'
  note: string
}

// ── @madovermarketing_mom ────────────────────────────────────────────────────
// MOM discloses paid work with #Collaboration and names the brand alongside it.

export const MOM_POSTS: PostFixture[] = [
  {
    shortcode: 'DbX5F9FE-_X',
    og: '184 likes, 2 comments - madovermarketing_mom on July 29, 2026: "Cricket runs on its own clock, and this campaign leaned all the way into it. @blackandwhite_nonalc turned waiting for the over to change into the point of the ad.\n\n#Collaboration #MagicOfSharing #FanStandardTime #BlackandWhiteNonAlc". ',
    truth: 'PAID',
    note: 'TWO campaign slogans (#MagicOfSharing, #FanStandardTime) alongside the real brand — the slogan-leak case found on the first live run',
  },
  {
    shortcode: 'DbXfC7Pk7FQ',
    og: '301 likes, 0 comments - madovermarketing_mom on July 28, 2026: "Tilara travelled thousands of kilometres with a single question: what does a roof really need to survive an Indian summer? The answer turned into a campaign that put the product where the problem lives. @tilara.india\n\n#Collaboration #HarRoofTilara #Tilara #SustainableRoofing #ExperientialMarketing". ',
    truth: 'PAID',
    note: 'handle has a country suffix (@tilara.india) that must fuzzy-match #Tilara',
  },
  {
    shortcode: 'DbVMqWgTOOg',
    og: '117 likes, 1 comments - madovermarketing_mom on July 28, 2026: "Pet parents today are doing their homework, but nutrition advice online is a mess of contradictions. @royalcanin.india went the other way and built the campaign around precision instead of promises.\n\n#Collaboration #RoyalCanin #UniqueNeedsPreciseNutrition #ExperientialMarketing #PetNutrition\n\n[pet marketing, social-first marketing, marketing campaign, advertising, storytelling]". ',
    truth: 'PAID',
    note: 'longest observed caption (1368 chars live); trailing SEO keyword block',
  },
  {
    shortcode: 'DbVAgeNE2rE',
    og: '2,166 likes, 30 comments - madovermarketing_mom on July 28, 2026: "What do you get when a sanctuary becomes the story rather than the setting? A campaign that sells stillness. @theleelacoorgforestsanctuary @theleela @mind_shifters\n\n#WhereStillnessFindsYou #Collaboration #TheLeela #TheLeelaCoorgForestSanctuary". ',
    truth: 'PAID',
    note: 'three mentions: two are the same brand at different granularity, one is the agency (@mind_shifters) which must be excluded',
  },
  {
    shortcode: 'DbXrjZDExLb',
    og: '520 likes, 0 comments - madovermarketing_mom on July 29, 2026: "Good ol’ advertising 🤌🏻". ',
    truth: 'ORGANIC',
    note: 'short editorial post, no hashtags at all',
  },
  {
    shortcode: 'DbXPBatExCh',
    og: '787 likes, 3 comments - madovermarketing_mom on July 28, 2026: "How Uber entered the world of football with a stroke of marketing genius 🤌🏻". ',
    truth: 'ORGANIC',
    note: 'editorial ABOUT a brand — must not be read as a partnership with it',
  },
  {
    shortcode: 'Cvg0aZ9ST-P',
    og: '173K likes, 824 comments - madovermarketing_mom on August 3, 2023: "Fix you but for the environment 🌎\n\n#Coldplay #ChrisMartin #Music #sustainability #Marketing". ',
    truth: 'ORGANIC',
    note: 'HAS hashtags but none disclose — the key false-positive trap. Also tests K-suffix counts.',
  },
  {
    shortcode: 'DHIFJQ8y4hI',
    og: '56K likes, 389 comments - madovermarketing_mom on March 12, 2025: "Lewis moving to Ferrari is more than just a driver swap, it is a story of brand deals and big money collaborations!\n\nPopcorn out lights out and away we go 🏁". ',
    truth: 'ORGANIC',
    note: 'pinned post from 2025; caption contains the word "collaborations" as prose, not a hashtag',
  },
]

// ── @viralbhayani ────────────────────────────────────────────────────────────
// Never discloses. Roughly half of these are paid, and nothing structural says so.

export const VIRALBHAYANI_POSTS: PostFixture[] = [
  {
    shortcode: 'DbXtbIoKUhL',
    og: '2,417 likes, 34 comments - viralbhayani on July 29, 2026: "The Roar Gets Louder. The Celebrations Get Bigger. Blockbuster #JanaNayagan is running successfully in cinemas now. \n#JanNetalnTheaters\n#OneLastTimeWithThalapathy". ',
    truth: 'PAID',
    note: 'film campaign, zero disclosure',
  },
  {
    shortcode: 'DbXjd_fK8cr',
    og: '111 likes, 29 comments - viralbhayani on July 29, 2026: "World IVF Day Celebration!\n\nDr L H Hiranandani Hospital, Powai invites you to a FREE Interactive Fertility Awareness Program!\n\n📅2nd August 2026 | 11 AM - 1PM\n\nLearn from leading specialists and get your questions answered.". ',
    truth: 'PAID',
    note: 'brand/event promo, zero disclosure, brand named only in prose',
  },
  {
    shortcode: 'DbXsQgtKuZi',
    og: '798 likes, 32 comments - viralbhayani on July 29, 2026: "ASAMBHAUUU – Where the impossible becomes possible.\nGet ready for a heartwarming tale packed with love, laughter, and emotions, as an extraordinary bond between a man and his family unfolds.". ',
    truth: 'PAID',
    note: 'film promo, zero disclosure',
  },
  {
    shortcode: 'DbXt6aCTWir',
    og: '1,856 likes, 46 comments - viralbhayani on July 29, 2026: "The ageless diva #malaikaarora spotted with her mystery friend". ',
    truth: 'ORGANIC',
    note: 'genuine paparazzi spotting',
  },
  {
    shortcode: 'DbXqWUJzL-f',
    og: '5,227 likes, 20 comments - viralbhayani on July 29, 2026: "How cute 🥰 and thoughtful of #athiyashetty ❤️✈️ who went to the airport to receive her husband #klrahul". ',
    truth: 'ORGANIC',
    note: 'genuine paparazzi spotting',
  },
  {
    shortcode: 'DbXm57iKFJC',
    og: '2,309 likes, 37 comments - viralbhayani on July 29, 2026: "Bhushan Kumar’s T-Series has bagged the music rights for both parts of Ramayana in a ₹75 crore refundable advance deal.". ',
    truth: 'ORGANIC',
    note: 'trade news, names a company but is not an ad for it',
  },
]

export const ALL_POSTS = [...MOM_POSTS, ...VIRALBHAYANI_POSTS]
