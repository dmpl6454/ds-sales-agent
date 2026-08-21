import { describe, expect, it } from 'vitest'
import { parseThreadTimestamp, parseInboxAge } from '@/outreach/browser/threadDates'
import { triageInboxRow, snippetIsReplyText, matchInboxRowToTarget, shouldRecordInboxReply } from '@/outreach/inboxTriage'
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
    '%s is a state, stored as NULL text for the full read to backfill',
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
