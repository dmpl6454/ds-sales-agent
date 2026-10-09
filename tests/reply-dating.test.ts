import { describe, expect, it } from 'vitest'
import { parseThreadTimestamp, parseInboxAge, plausibleReplyDate } from '@/outreach/browser/threadDates'
import { triageInboxRow, snippetIsReplyText, matchInboxRowToTarget, matchInboxRow, threadIdFrom, shouldRecordInboxReply } from '@/outreach/inboxTriage'
import type { InboxRow } from '@/outreach/browser/inboxScan'

/**
 * REPLY DATING AND INBOX TRIAGE — the inputs are REAL, captured from
 * @bollywoodchronicle's live inbox and the @indiagatefoods thread on 2026-08-21,
 * not invented. The probe that captured them found six undetected replies in ten
 * minutes, so these fixtures are the population this code exists for.
 *
 * The failure directions differ and both are pinned:
 *   - a FALSE REPLY halts a target for seven days (expensive) → triage errs toward
 *     'ours-last';
 *   - an UNDATABLE reply does not halt (Tabish's rule) → the parsers return null for
 *     anything they do not positively recognise, and prose can never become a date.
 */

const NOW = new Date('2026-08-21T18:10:00') // local clock, as the page's separators are

describe('parseThreadTimestamp — the separators observed live', () => {
  it('"18:04" — a bare clock is today', () => {
    const d = parseThreadTimestamp('18:04', NOW)!
    expect(d.getHours()).toBe(18)
    expect(d.getMinutes()).toBe(4)
    expect(d.getDate()).toBe(NOW.getDate())
  })

  it('"12:39" before our own message parsed the same way', () => {
    expect(parseThreadTimestamp('12:39', NOW)!.getHours()).toBe(12)
  })

  it('a clock LATER than now belongs to yesterday, not the future', () => {
    const d = parseThreadTimestamp('23:55', NOW)!
    expect(d.getTime()).toBeLessThan(NOW.getTime())
    expect(d.getDate()).toBe(NOW.getDate() - 1)
  })

  it('"Yesterday 14:21"', () => {
    const d = parseThreadTimestamp('Yesterday 14:21', NOW)!
    expect(d.getDate()).toBe(NOW.getDate() - 1)
    expect(d.getHours()).toBe(14)
  })

  it('a weekday name means the most recent such day strictly before today', () => {
    // NOW is a Friday (2026-08-21). "Wed 09:15" must be 2026-08-19.
    const d = parseThreadTimestamp('Wed 09:15', NOW)!
    expect(d.getDate()).toBe(19)
    expect(d.getHours()).toBe(9)
  })

  it('a weekday naming TODAY rolls back a full week — today renders a bare clock instead', () => {
    const d = parseThreadTimestamp('Fri 09:15', NOW)!
    expect(d.getDate()).toBe(14)
  })

  it('"19 August 2026, 14:21" — the full form', () => {
    const d = parseThreadTimestamp('19 August 2026, 14:21', NOW)!
    expect(d.getFullYear()).toBe(2026)
    expect(d.getMonth()).toBe(7)
    expect(d.getDate()).toBe(19)
    expect(d.getHours()).toBe(14)
  })

  it('"August 19, 2026, 2:21 pm" — the US spelling', () => {
    const d = parseThreadTimestamp('August 19, 2026, 2:21 pm', NOW)!
    expect(d.getDate()).toBe(19)
    expect(d.getHours()).toBe(14)
  })

  it('a date without a year takes the current year, rolling back if in the future', () => {
    const past = parseThreadTimestamp('19 Aug, 14:21', NOW)!
    expect(past.getFullYear()).toBe(2026)
    const future = parseThreadTimestamp('25 Dec, 10:00', NOW)!
    expect(future.getFullYear()).toBe(2025)
  })

  it('prose and furniture never become dates', () => {
    for (const t of [
      'New messages',
      'Verified',
      'View Profile',
      'call me at 18:00', // a reply CONTAINING a time is not a separator
      'Hi, this will cost you 8k per post',
      '060001 89766', // the phone number in the thread header
      '',
    ]) {
      expect(parseThreadTimestamp(t, NOW)).toBeNull()
    }
  })
})

describe('parseInboxAge — the row ages observed live', () => {
  it.each([
    ['41m', 41 * 60_000],
    ['1h', 3_600_000],
    ['9h', 9 * 3_600_000],
    ['2d', 2 * 86_400_000],
    ['3w', 21 * 86_400_000],
  ])('%s', (text, ms) => {
    expect(parseInboxAge(text, NOW)!.getTime()).toBe(NOW.getTime() - ms)
  })

  it('an eight-day-old age is OUTSIDE a seven-day window — the release direction', () => {
    const d = parseInboxAge('2w', NOW)!
    const floor = new Date(NOW.getTime() - 7 * 86_400_000)
    expect(d.getTime()).toBeLessThan(floor.getTime())
  })

  it('anything else is null, never a guess', () => {
    for (const t of ['Unread', '·', '2 new messages', 'now', 'Active now', '']) {
      expect(parseInboxAge(t, NOW)).toBeNull()
    }
  })
})

// ── triage, on the rows the probe actually returned ──────────────────────────

const TEMPLATE =
  "Hi,We're an Entertainment & Pop Culture Media Network generating over 300M views every day. We work with films and brands on promotions. Do write back to know about our plans and pricing if you seek a placement for your brand. - Kapil"

const row = (displayName: string, snippet: string, ageText: string | null, unread = false): InboxRow => ({
  displayName,
  snippet,
  threadUrl: null,
  ageText,
  unread,
  folder: 'primary',
})

describe('triageInboxRow — ours/theirs from the snippet', () => {
  it('"You sent an attachment." is ours — the common case, measured on 30+ live rows', () => {
    expect(triageInboxRow(row('Sanya Malhotra', 'You sent an attachment.', '44m'), [TEMPLATE])).toBe('ours-last')
  })

  it('the reply text itself is theirs — @indiagatefoods, live', () => {
    expect(
      triageInboxRow(
        row('India Gate Foods', 'Thank you for sharing your details with us. Please note that our relevant team will get in touch with you if any suitable opportunity arises.', '1m', true),
        [TEMPLATE],
      ),
    ).toBe('theirs-last')
  })

  it('"2 new messages" is theirs — @jomedy, live', () => {
    expect(triageInboxRow(row('Jomedy', '2 new messages', '7h', true), [TEMPLATE])).toBe('theirs-last')
  })

  it('"<Name> sent an attachment." is theirs — @lalitpandit, live', () => {
    expect(triageInboxRow(row('Lalit Pandit', 'Lalit sent an attachment.', '9h', true), [TEMPLATE])).toBe('theirs-last')
  })

  /**
   * The insurance: if Instagram ever renders OUR text send as a bare snippet with no
   * "You" prefix, the snippet opens one of our delivered bodies and must read as ours —
   * a false reply halts the target for seven days, which is the expensive direction.
   */
  it('a snippet that opens one of our own bodies is ours even without the prefix', () => {
    expect(
      triageInboxRow(row('Zee 5', "Hi,We're an Entertainment & Pop Culture Media Network generating over 300M…", '1h'), [TEMPLATE]),
    ).toBe('ours-last')
  })

  it('an empty snippet is noise, never a reply', () => {
    expect(triageInboxRow(row('Whoever', '', '1h'), [TEMPLATE])).toBe('noise')
  })

  /**
   * BOTH of these were RECORDED AS REPLIES on the first live run (2026-08-21, undone
   * with an audit row each): presence text and a system notice are nobody's words.
   * A false reply halts a target for seven days — the expensive direction.
   */
  it('presence text is noise — the @shirin_tuli_sharma false reply', () => {
    expect(triageInboxRow(row('Shirin', 'Active', '5h'), [TEMPLATE])).toBe('noise')
    expect(triageInboxRow(row('Shirin', 'Active now', '5h'), [TEMPLATE])).toBe('noise')
    expect(triageInboxRow(row('Shirin', 'Active 3h ago', '5h'), [TEMPLATE])).toBe('noise')
  })

  it('a system notice is noise — the @rajnieshduggall false reply', () => {
    expect(
      triageInboxRow(
        row('Rajniesh', "This account can't receive your message because they don't allow new message requests from everyone.", '11h'),
        [TEMPLATE],
      ),
    ).toBe('noise')
  })
})

describe('snippetIsReplyText — states are not words', () => {
  it('real text is stored', () => {
    expect(snippetIsReplyText('Yes and spotting Abhi kaise karein')).toBe(true)
  })
  it.each(['2 new messages', 'Lalit sent an attachment.', 'You sent an attachment.', 'Liked a message'])(
    '%s is a state, stored as NULL text — a marker nothing fills in',
    (s) => expect(snippetIsReplyText(s)).toBe(false),
  )
})

/**
 * MEASURED across two live runs before this existed: @medlinkstrichology's "MedLinks
 * sent an attachment." re-recorded on EVERY sweep, walking down the target's attempt
 * list one row per run. The decision is per PAIR — the row describes one sender's
 * thread — and a state snippet can never be "new" twice.
 */
describe('shouldRecordInboxReply — once per thread state, again only for new words', () => {
  it('a pair with no recorded reply records', () => {
    expect(shouldRecordInboxReply({ snippet: 'MedLinks sent an attachment.', pairReplyTexts: [] })).toBe(true)
  })

  it('a state snippet never records twice — the @medlinkstrichology loop', () => {
    expect(shouldRecordInboxReply({ snippet: 'MedLinks sent an attachment.', pairReplyTexts: [null] })).toBe(false)
    expect(shouldRecordInboxReply({ snippet: '2 new messages', pairReplyTexts: [null] })).toBe(false)
  })

  it('the same words never record twice', () => {
    expect(shouldRecordInboxReply({ snippet: 'Regarding?', pairReplyTexts: ['Regarding?'] })).toBe(false)
  })

  it('genuinely NEW words on an already-replied pair DO record — an active conversation', () => {
    expect(shouldRecordInboxReply({ snippet: 'Send over the rate card', pairReplyTexts: ['Regarding?'] })).toBe(true)
  })

  it('a truncated snippet of already-recorded words does not re-record', () => {
    expect(
      shouldRecordInboxReply({
        snippet: 'Thank you for sharing your details with us. Please note…',
        pairReplyTexts: ['Thank you for sharing your details with us. Please note that our relevant team will get in touch.'],
      }),
    ).toBe(false)
  })
})

describe('matchInboxRowToTarget — a display name is not an identity', () => {
  const targets = [
    { id: '1', handle: 'indiagatefoods', displayName: 'India Gate Foods' },
    { id: '2', handle: 'zee5', displayName: 'Zee 5' },
    { id: '3', handle: 'shrivastavasparsh', displayName: 'Sparsh Shrivastava' },
    { id: '4', handle: 'lego.in', displayName: 'LEGO' },
    { id: '5', handle: 'lego.uk', displayName: 'LEGO' },
  ]

  it('matches by display name when unique', () => {
    expect(matchInboxRowToTarget('India Gate Foods', targets)?.handle).toBe('indiagatefoods')
  })

  it('matches a row titled with the raw handle — observed live (@shrivastavasparsh)', () => {
    expect(matchInboxRowToTarget('shrivastavasparsh', targets)?.handle).toBe('shrivastavasparsh')
  })

  it('an AMBIGUOUS display name matches nobody — a wrong halt is a wrong verdict', () => {
    expect(matchInboxRowToTarget('LEGO', targets)).toBeNull()
  })

  it('a stranger matches nobody and is reported, not guessed', () => {
    expect(matchInboxRowToTarget('Shaikh Zaib', targets)).toBeNull()
  })

  /**
   * Stored displayNames are often just the handle (the usableBrandName gap), so the
   * inbox title "India Gate Foods" must reach handle `indiagatefoods` by separator
   * stripping — measured live: it sat in "unmatched" while its reply went unrecorded.
   * And the same rule must NOT stretch: "Kama Ayurveda" is not `kamaayurvedaindia`.
   */
  it('a spaced title matches its squashed handle exactly — @indiagatefoods, live', () => {
    const t = [...targets, { id: '6', handle: 'indiagatefoods', displayName: 'indiagatefoods' }]
    expect(matchInboxRowToTarget('India Gate Foods', t)?.handle).toBe('indiagatefoods')
  })

  it('squashing never becomes a prefix guess — Kama Ayurveda stays unmatched', () => {
    const t = [...targets, { id: '7', handle: 'kamaayurvedaindia', displayName: 'kamaayurvedaindia' }]
    expect(matchInboxRowToTarget('Kama Ayurveda', t)).toBeNull()
  })
})

/**
 * ── A PARSED DATE MUST BE ONE THAT COULD BE TRUE (2026-08-22) ─────────────
 *
 * THE INCIDENT, and it is the only time the reply halt has ever been crossed. @drongofilms
 * wrote *"Hi Kunal this side, saw your poster 'vibe', we can amplify your content"* — a live
 * lead. The sweep observed it at 11:14 IST and `parseThreadTimestamp` dated it **19 May**,
 * three months earlier. The halt keys on the reply's own date and an old date does not hold
 * it (Tabish's rule), so the fleet sent that recipient another message NINE MINUTES later.
 * Six of 41 stored replies carried a date earlier than the message they answer.
 *
 * The rule that makes any parser mistake harmless: a reply cannot predate the message it
 * answers, and cannot postdate the moment we saw it. Both bounds are DB facts. Outside that
 * window the parse is discarded and the LOWER bound used — conservative for the halt, and it
 * preserves Tabish's rule exactly, because a thread we last wrote to a month ago clamps to
 * that old send and still does not halt.
 */
describe('plausibleReplyDate — a date that cannot be true is not a date', () => {
  const observed = new Date('2026-08-22T05:44:19Z')
  const lastSent = new Date('2026-08-20T05:24:41Z')

  it('a plausible parse is kept as-is', () => {
    const parsed = new Date('2026-08-22T05:30:00Z')
    expect(plausibleReplyDate({ parsed, lastSentAt: lastSent, observedAt: observed })).toBe(parsed)
  })

  it('THE INCIDENT: a date before the message it answers is discarded, and the halt holds', () => {
    const parsed = new Date('2026-05-19T09:39:00Z') // what the thread actually gave us
    const got = plausibleReplyDate({ parsed, lastSentAt: lastSent, observedAt: observed })!
    expect(got).toEqual(lastSent)
    /* And that lands inside a seven-day window measured from the observation, so the halt
       that failed on 22 August would now hold. */
    const floor = new Date(observed.getTime() - 7 * 86_400_000)
    expect(got.getTime()).toBeGreaterThanOrEqual(floor.getTime())
  })

  it('a date after we saw it is discarded too — nothing is written in the future', () => {
    const parsed = new Date('2026-08-25T00:00:00Z')
    expect(plausibleReplyDate({ parsed, lastSentAt: lastSent, observedAt: observed })).toEqual(lastSent)
  })

  it('an unparsed date falls back to our last send, not to the observation', () => {
    expect(plausibleReplyDate({ parsed: null, lastSentAt: lastSent, observedAt: observed })).toEqual(lastSent)
  })

  /**
   * TABISH'S RULE IS PRESERVED, which is the half that keeps this honest. A reply appearing
   * in a thread we last wrote to five weeks ago clamps to that old send, lands OUTSIDE the
   * window, and does not halt — because it may well be answering that old conversation.
   */
  it('an old thread stays old — the permissive direction he chose is intact', () => {
    const longAgo = new Date('2026-07-15T00:00:00Z')
    const got = plausibleReplyDate({ parsed: null, lastSentAt: longAgo, observedAt: observed })!
    const floor = new Date(observed.getTime() - 7 * 86_400_000)
    expect(got.getTime()).toBeLessThan(floor.getTime())
  })

  it('with no send to answer, only a self-consistent parse survives', () => {
    const parsed = new Date('2026-08-22T05:00:00Z')
    expect(plausibleReplyDate({ parsed, lastSentAt: null, observedAt: observed })).toBe(parsed)
    expect(plausibleReplyDate({ parsed: new Date('2026-08-25T00:00:00Z'), lastSentAt: null, observedAt: observed })).toBeNull()
    expect(plausibleReplyDate({ parsed: null, lastSentAt: null, observedAt: observed })).toBeNull()
  })
})

/** Both recorders must clamp — a rule that reaches one write site is this repo's oldest defect. */
describe('both reply write sites clamp', () => {
  it('the thread path and the inbox path both call plausibleReplyDate', async () => {
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const src = readFileSync(join(import.meta.dirname, '..', 'src/outreach/replyCheck.ts'), 'utf8')
    expect([...src.matchAll(/plausibleReplyDate\(/g)].length).toBeGreaterThanOrEqual(2)
    /* And neither may write a raw parse straight into the column. */
    expect(src).not.toMatch(/replyPostedAt: newest\.approxAt/)
    expect(src).not.toMatch(/replyPostedAt: parseInboxAge/)
  })
})

describe('matchInboxRow — the thread link is the identity, the name is the fallback', () => {
  const targets = [
    { id: 'n', handle: 'mynykaa', displayName: 'mynykaa' },
    { id: 'm', handle: 'maybelline_ind', displayName: 'maybelline_ind' },
    { id: 'g', handle: 'indiagatefoods', displayName: 'India Gate Foods' },
  ]
  const byThread = new Map([['111634473567083', targets[0]!]])

  it('reads the id out of every spelling a thread URL arrives in', () => {
    expect(threadIdFrom('/direct/t/111634473567083/')).toBe('111634473567083')
    expect(threadIdFrom('https://www.instagram.com/direct/t/111634473567083')).toBe('111634473567083')
    expect(threadIdFrom('/direct/inbox/')).toBeNull()
    expect(threadIdFrom(null)).toBeNull()
  })

  it("matches @mynykaa's row titled \"Nykaa\" by its link — the name could never match (MEASURED: a week unrecorded)", () => {
    expect(matchInboxRowToTarget('Nykaa', targets)).toBeNull()
    expect(matchInboxRow({ displayName: 'Nykaa', threadUrl: '/direct/t/111634473567083/' }, targets, byThread)?.handle).toBe('mynykaa')
  })

  it('falls back to the name rules when the row has no link, or a link we never wrote to', () => {
    expect(matchInboxRow({ displayName: 'India Gate Foods', threadUrl: null }, targets, byThread)?.handle).toBe('indiagatefoods')
    expect(matchInboxRow({ displayName: 'India Gate Foods', threadUrl: '/direct/t/999/' }, targets, byThread)?.handle).toBe('indiagatefoods')
    // A stranger's inbound row: unknown thread, unmatchable name — reported for a person, never guessed.
    expect(matchInboxRow({ displayName: 'Maybelline New York - India', threadUrl: '/direct/t/999/' }, targets, byThread)).toBeNull()
  })
})
