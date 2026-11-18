import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { groupTodayBySender, type DeliveredRow, type PageCounts } from '@/app/view-model/today-by-sender'

/**
 * TODAY, BY SENDING PAGE (18 Nov 2026). The assembly is PURE and tested in both directions here; the page half is a
 * source grep, because the failure this codebase keeps producing is a correct function nobody renders.
 *
 * Four of these cases exist because a review of the first version found each one wrong or misleading: the day's
 * stopped drafts were not said, the per-page counts came from the capped list, a reply found today read as one that
 * "came in" today, and the total and the rows were read on two clocks.
 */

const day = new Date('2026-11-17T18:30:00.000Z') // midnight IST, 18 Nov
const at = (hhmm: string, d = '2026-11-18') => new Date(`${d}T${hhmm}:00.000+05:30`)
const senders = [
  { id: 's1', handle: 'bollywoodpaparazzii' },
  { id: 's2', handle: 'totalfilmii' },
  { id: 's3', handle: 'bollywoodsocietyy' },
  { id: 's4', handle: 'madaboutmarketingg' },
]
const row = (over: Partial<DeliveredRow> & { id: string; senderId: string }): DeliveredRow => ({
  sentAt: at('12:00'),
  touchNumber: 1,
  status: 'SENT',
  repliedAt: null,
  threadUrl: null,
  targetHandle: `company_${over.id}`,
  ...over,
})
const none = new Map<string, number>()
/** Counts as the uncapped group-by would give them for exactly these rows. */
function countsOf(rows: readonly DeliveredRow[]): Map<string, PageCounts> {
  const m = new Map<string, PageCounts>()
  for (const r of rows) {
    if (!r.sentAt) continue
    const c = m.get(r.senderId) ?? { sent: 0, lastSentAt: null }
    c.sent += 1
    if (!c.lastSentAt || r.sentAt > c.lastSentAt) c.lastSentAt = r.sentAt
    m.set(r.senderId, c)
  }
  return m
}
const base = {
  dayStart: day,
  repliesBySender: none,
  waitingBySender: none,
  stoppedBySender: none,
  senders,
}

describe('groupTodayBySender', () => {
  it('gives each page its own messages, newest first, with follow-ups and replies marked', () => {
    const rows = [
      row({ id: 'a', senderId: 's1', sentAt: at('07:22') }),
      row({ id: 'b', senderId: 's1', sentAt: at('12:55'), touchNumber: 2 }),
      row({ id: 'c', senderId: 's2', sentAt: at('09:10'), status: 'REPLIED', threadUrl: 'https://www.instagram.com/direct/t/1' }),
      row({ id: 'd', senderId: 's1', sentAt: at('10:00'), repliedAt: at('11:00') }),
    ]
    const out = groupTodayBySender({
      ...base,
      total: 4,
      rows,
      deliveredBySender: countsOf(rows),
      repliesBySender: new Map([['s2', 1]]),
      waitingBySender: new Map([['s1', 3]]),
    })
    expect(out.pages.map((p) => p.handle)).toEqual(['bollywoodpaparazzii', 'totalfilmii'])
    const pap = out.pages[0]!
    expect([pap.sent, pap.waiting, pap.repliesFound, pap.stopped]).toEqual([3, 3, 0, 0])
    expect(pap.messages.map((m) => m.id)).toEqual(['b', 'd', 'a'])
    expect(pap.messages.map((m) => m.followUp)).toEqual([true, false, false])
    expect(pap.messages.find((m) => m.id === 'd')!.replied).toBe(true)
    expect(pap.lastSentAt).toEqual(at('12:55'))
    const tf = out.pages[1]!
    expect(tf.repliesFound).toBe(1)
    expect(tf.messages[0]!.replied).toBe(true)
    expect(tf.messages[0]!.threadUrl).toBe('https://www.instagram.com/direct/t/1')
    expect(out.repliesFound).toBe(1)
    expect(out.capped).toBe(false)
  })

  it('lists a page that only has a waiting draft, a found reply or a stopped draft, and leaves out a page with nothing today', () => {
    const out = groupTodayBySender({
      ...base,
      total: 0,
      rows: [],
      deliveredBySender: new Map(),
      repliesBySender: new Map([['s3', 2], ['s4', 0]]),
      waitingBySender: new Map([['s2', 1], ['s4', 0]]),
      stoppedBySender: new Map([['s1', 38], ['s4', 0]]),
    })
    expect(out.pages.map((p) => [p.handle, p.sent, p.waiting, p.repliesFound, p.stopped])).toEqual([
      ['bollywoodpaparazzii', 0, 0, 0, 38],
      ['bollywoodsocietyy', 0, 0, 2, 0],
      ['totalfilmii', 0, 1, 0, 0],
    ])
    expect(out.stopped).toBe(38)
  })

  /* REVIEW 18 Nov: the 18 Nov morning itself — 40 written, 40 stopped, 0 delivered — read "nothing has gone out". */
  it('reports the day’s stopped drafts, page by page', () => {
    const out = groupTodayBySender({
      ...base,
      total: 0,
      rows: [],
      deliveredBySender: new Map(),
      stoppedBySender: new Map([['s1', 38], ['s2', 2]]),
    })
    expect(out.stopped).toBe(40)
    expect(out.pages.map((p) => [p.handle, p.stopped])).toEqual([['bollywoodpaparazzii', 38], ['totalfilmii', 2]])
  })

  it('orders pages by messages sent today, then by handle, so the order holds between refreshes', () => {
    const rows = [row({ id: 'a', senderId: 's3' }), row({ id: 'b', senderId: 's2' }), row({ id: 'c', senderId: 's2' })]
    const out = groupTodayBySender({ ...base, total: 3, rows, deliveredBySender: countsOf(rows), waitingBySender: new Map([['s1', 1]]) })
    expect(out.pages.map((p) => p.handle)).toEqual(['totalfilmii', 'bollywoodsocietyy', 'bollywoodpaparazzii'])
  })

  /* REVIEW 18 Nov: the per-page counts came from the 400-row list, so a page that sent only in the morning of a big
     day vanished from the section while it had sent a hundred. */
  it('takes per-page counts from the uncapped figures, so a page whose messages fell off the list is still there', () => {
    const listed = [row({ id: 'a', senderId: 's1', sentAt: at('20:00') }), row({ id: 'b', senderId: 's1', sentAt: at('20:01') })]
    const out = groupTodayBySender({
      ...base,
      total: 504,
      rows: listed,
      deliveredBySender: new Map([
        ['s1', { sent: 400, lastSentAt: at('20:01') }],
        ['s2', { sent: 104, lastSentAt: at('02:10') }],
      ]),
    })
    expect(out.pages.map((p) => [p.handle, p.sent, p.messages.length])).toEqual([
      ['bollywoodpaparazzii', 400, 2],
      ['totalfilmii', 104, 0],
    ])
    expect(out.pages[1]!.lastSentAt).toEqual(at('02:10'))
    expect(out).toMatchObject({ total: 504, shown: 2, capped: true })
  })

  it('never reports a total smaller than the rows it shows', () => {
    const rows = [row({ id: 'a', senderId: 's1' }), row({ id: 'b', senderId: 's1' })]
    const behind = groupTodayBySender({ ...base, total: 1, rows, deliveredBySender: countsOf(rows) })
    expect(behind).toMatchObject({ total: 2, shown: 2, capped: false })
  })

  /* The chip is THIS PAGE's history, the same rule as the history table on the same page (messages/sent.tsx): a
     review weighed "carried the follow-up copy" and kept the shared rule so two lists never disagree. */
  it('marks a follow-up by this page’s own count, as the history table does', () => {
    const rows = [
      row({ id: 'm1', senderId: 's1', touchNumber: 1 }),
      row({ id: 'm2', senderId: 's1', touchNumber: 2 }),
      row({ id: 'm3', senderId: 's1', touchNumber: 5 }),
    ]
    const out = groupTodayBySender({ ...base, total: 3, rows, deliveredBySender: countsOf(rows) })
    const byId = new Map(out.pages.flatMap((p) => p.messages).map((m) => [m.id, m.followUp]))
    expect([byId.get('m1'), byId.get('m2'), byId.get('m3')]).toEqual([false, true, true])
    expect(readFileSync('src/app/messages/sent.tsx', 'utf8')).toMatch(/r\.touchNumber > 1/)
  })

  it('skips a row it cannot place on a day or on a known page', () => {
    const rows = [row({ id: 'a', senderId: 's1', sentAt: null }), row({ id: 'b', senderId: 'gone' }), row({ id: 'c', senderId: 's2' })]
    const out = groupTodayBySender({ ...base, total: 1, rows, deliveredBySender: countsOf(rows) })
    expect(out.pages.map((p) => [p.handle, p.sent])).toEqual([['totalfilmii', 1]])
    expect(out.shown).toBe(2)
  })
})

describe('and it reaches the Analytics page', () => {
  const page = readFileSync('src/app/analytics/page.tsx', 'utf8')
  const vm = readFileSync('src/app/view-model/today-by-sender.ts', 'utf8')

  it('the page builds it from the uncapped day count and renders every page and every message', () => {
    expect(page).toMatch(/buildTodayBySender\(\{\s*dayStart,\s*deliveredToday:\s*usage\.today/)
    expect(page).toMatch(/today\.pages\.map\(/)
    expect(page).toMatch(/p\.messages\.map\(/)
    /* The page each message came from is the row's heading, and the recipient is on each line. */
    expect(page).toMatch(/@\{p\.handle\}/)
    expect(page).toMatch(/to @\{m\.targetHandle\}/)
    /* A capped list announces its cap where the cap is visible. */
    expect(page).toMatch(/today\.capped \?/)
    /* The day's stopped drafts are said, on the section and per page. */
    expect(page).toMatch(/today\.stopped > 0/)
    expect(page).toMatch(/p\.stopped > 0/)
  })

  /* REVIEW 18 Nov: ONE clock. The day total and the rows read at two moments straddle midnight IST. */
  it('hands fleetUsage and the section the same midnight IST, from one clock', () => {
    expect(page).toMatch(/const now = new Date\(\)\s*\n\s*const dayStart = istDayStart\(now\)/)
    expect(page).toMatch(/fleetUsage\(now\)/)
    expect(vm).not.toMatch(/new Date\(\)/)
    expect(vm).not.toMatch(/setHours\(/)
  })

  /* REVIEW 18 Nov: a reply is dated by when the check RECORDED it. */
  it('says a reply was found today, never that it came in today', () => {
    expect(page).not.toMatch(/c[oa]me in/)
    expect(page).toMatch(/The reply check found/)
    expect(page).toMatch(/\{p\.repliesFound === 1 \? 'reply' : 'replies'\} found/)
  })

  it('per-page counts come from an uncapped group-by, not from the capped list', () => {
    expect(vm).toMatch(/groupBy\(\{ by: \['senderId'\], where: delivered, _count: \{ _all: true \}, _max: \{ sentAt: true \} \}\)/)
    expect(vm).not.toMatch(/p\.sent \+= 1/)
  })
})
