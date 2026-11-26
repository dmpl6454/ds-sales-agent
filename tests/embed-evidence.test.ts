import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * PUTTING THE @MENTIONS BACK ON A PAID POST — WHAT IS WRITTEN, AND WHAT IS REFUSED — 26 Nov 2026.
 *
 * `postEmbedPass` writes handles onto stored posts, and those handles decide who a company-discovery pass looks at
 * and which companies a paid post credits. So the things pinned here are the ways it could write something that
 * is not true of the post:
 *
 *   - a page about a DIFFERENT post (or a removed one) must record nothing — not even "nothing found";
 *   - a page that did not answer must never be written down as "this post mentions nobody";
 *   - the official-read marker must survive the write byte for byte, or the row can never be completed;
 *   - a row a complete read replaced while we were asking must not be overwritten with the old payload;
 *   - a refusal is about the HOST: it stops the pass and benches no post.
 *
 * The database here is a small in-memory stand-in that implements the filters the pass uses, the conditional
 * `updateMany` included; the reader is a stub. The real door is `tests/embed-door.test.ts`.
 */

interface Row {
  id: string
  shortcode: string
  verdict: string
  postedAt: Date
  caption: string
  taggedAccounts: string
  brands: string
  rawPayload: string | null
  target: { handle: string }
}
const rows: Row[] = []
const audits: Array<{ actor: string; action: string; entity: string; detail: string }> = []
/** Set to make the next write lose its race: the row changes after the read. */
let changeRowBeforeWrite: ((row: Row) => void) | null = null

vi.mock('@/lib/db', () => ({
  prisma: {
    detectedCampaign: {
      findMany: async (args: { where: { verdict: string; postedAt: { gte: Date }; rawPayload: { contains: string } } }) =>
        rows
          .filter((r) => r.verdict === args.where.verdict && r.postedAt >= args.where.postedAt.gte && (r.rawPayload ?? '').includes(args.where.rawPayload.contains))
          .sort((a, b) => b.postedAt.getTime() - a.postedAt.getTime() || (a.id < b.id ? 1 : -1))
          .map((r) => ({ ...r })),
      updateMany: async (args: { where: { id: string; taggedAccounts: string; brands: string; rawPayload: string }; data: Partial<Row> }) => {
        const row = rows.find((r) => r.id === args.where.id)
        if (!row) return { count: 0 }
        if (changeRowBeforeWrite) {
          changeRowBeforeWrite(row)
          changeRowBeforeWrite = null
        }
        if (row.taggedAccounts !== args.where.taggedAccounts || row.brands !== args.where.brands || row.rawPayload !== args.where.rawPayload) return { count: 0 }
        Object.assign(row, args.data)
        return { count: 1 }
      },
    },
    auditLog: { create: async (args: { data: (typeof audits)[number] }) => void audits.push(args.data) },
  },
}))

const { postEmbedPass, captionsAgree, mergeEmbedMentions, resetEmbedEvidenceMemory, EMBED_READ_KEY } = await import('@/detection/embedEvidence')
const { EVIDENCE_INCOMPLETE_MARKER } = await import('@/detection/evidence')
type Outcome = import('@/detection/embedDoor').EmbedPostOutcome

const NOW = new Date('2026-11-26T06:00:00Z')
const OFFICIAL = JSON.stringify({ isPaidPartnership: null, sponsorHandles: [], collabHandles: [], thumbnailUrl: null, videoUrl: null, videoDurationSeconds: null, capturedAt: '2026-11-25T10:00:00.000Z', evidenceIncomplete: true })
const COMPLETE = JSON.stringify({ isPaidPartnership: false, sponsorHandles: [], collabHandles: [], thumbnailUrl: null, videoUrl: null, videoDurationSeconds: null, capturedAt: '2026-11-25T10:00:00.000Z' })

let n = 0
function post(over: Partial<Row> & { shortcode: string }): Row {
  n++
  const row: Row = {
    id: `c${String(n).padStart(3, '0')}`,
    verdict: 'CAMPAIGN',
    postedAt: new Date(NOW.getTime() - n * 3_600_000),
    caption: 'Festive camp with itsbevygood and plumbodylovin, see you there',
    taggedAccounts: '[]',
    brands: '["Festive Marketing Camp"]',
    rawPayload: OFFICIAL,
    target: { handle: 'officialsocialsamosa' },
    ...over,
  }
  rows.push(row)
  return row
}

const asked: string[] = []
let pages: Record<string, Outcome> = {}
const read = async (shortcode: string): Promise<Outcome> => {
  asked.push(shortcode)
  return pages[shortcode] ?? { kind: 'nothing', reason: 'the embed page shows no caption (x)', status: null }
}
const readOf = (
  mentions: string[],
  captionText = 'officialsocialsamosa Festive camp with @itsbevygood and @plumbodylovin, see you there',
  owner: string | null = 'officialsocialsamosa',
  more: { unlinkedAt?: string[]; closed?: boolean } = {},
): Outcome => ({
  kind: 'read', owner, mentions, captionText, atSigns: mentions.length, unlinkedAt: more.unlinkedAt ?? [], closed: more.closed ?? true,
})
const run = (maxReads = 10, dryRun = false) => postEmbedPass({ maxReads, dryRun, spacingMs: 0, read, now: () => NOW })

beforeEach(() => {
  rows.length = 0
  audits.length = 0
  asked.length = 0
  pages = {}
  n = 0
  changeRowBeforeWrite = null
  resetEmbedEvidenceMemory()
})

describe('what is written when the page is this post’s', () => {
  it('adds the mentions to the tags, to brands as @handle, and records where they came from', async () => {
    const row = post({ shortcode: 'DcyE65LPYMj' })
    pages['DcyE65LPYMj'] = readOf(['itsbevygood', 'plumbodylovin'])
    const s = await run()
    expect(s).toMatchObject({ waiting: 1, asked: 1, restored: 1, mentionsRestored: 2, nothingToRestore: 0 })
    expect(JSON.parse(row.taggedAccounts)).toEqual(['itsbevygood', 'plumbodylovin'])
    expect(JSON.parse(row.brands)).toEqual(['Festive Marketing Camp', '@itsbevygood', '@plumbodylovin'])
    const payload = JSON.parse(row.rawPayload ?? '{}') as Record<string, unknown>
    expect(payload.embedMentions).toEqual(['itsbevygood', 'plumbodylovin'])
    expect(payload.embedOwner).toBe('officialsocialsamosa')
    expect(payload[EMBED_READ_KEY]).toBe(NOW.toISOString())
    expect(payload.capturedAt).toBe('2026-11-25T10:00:00.000Z')
    // the marker, byte for byte: three places find official-read rows by these exact bytes
    expect(row.rawPayload).toContain(EVIDENCE_INCOMPLETE_MARKER)
    expect(audits).toHaveLength(1)
    expect(audits[0]).toMatchObject({ action: 'post.embed-mentions', entity: 'DetectedCampaign:DcyE65LPYMj' })
    expect(audits[0]?.detail).toContain('@itsbevygood @plumbodylovin')
  })

  it('makes the existing "which paid posts name this company" rule credit the company, with no new rule', async () => {
    const { mentionsHandleExactly } = await import('@/outreach/materialAllowance')
    const row = post({ shortcode: 'A1' })
    expect(mentionsHandleExactly(row, 'itsbevygood')).toBe(false)
    pages['A1'] = readOf(['itsbevygood'])
    await run()
    expect(mentionsHandleExactly(row, 'itsbevygood')).toBe(true)
    expect(mentionsHandleExactly(row, 'itsbevy')).toBe(false)
  })

  it('never writes the publisher or the caption’s owner as a mention', async () => {
    const row = post({ shortcode: 'A1', target: { handle: 'OfficialSocialSamosa' } })
    pages['A1'] = readOf(['officialsocialsamosa', 'socialsamosaevents', 'itsbevygood'], undefined, 'socialsamosaevents')
    await run()
    expect(JSON.parse(row.taggedAccounts)).toEqual(['itsbevygood'])
  })

  it('keeps tags and brands already there, and does not add an account twice', async () => {
    const row = post({ shortcode: 'A1', taggedAccounts: '["ItsBevyGood","older_tag"]', brands: '["@PlumBodyLovin","itsbevygood","Camp"]' })
    pages['A1'] = readOf(['itsbevygood', 'plumbodylovin', 'farmleyin'])
    await run()
    expect(JSON.parse(row.taggedAccounts)).toEqual(['ItsBevyGood', 'older_tag', 'plumbodylovin', 'farmleyin'])
    expect(JSON.parse(row.brands)).toEqual(['@PlumBodyLovin', 'itsbevygood', 'Camp', '@farmleyin'])
  })

  it('a caption that links nobody is recorded as read, so it is never asked again — and nothing else changes', async () => {
    const row = post({ shortcode: 'Dcc4pQ8sX0N', caption: 'A plain caption about a film, no accounts named in it at all', target: { handle: 'taranadarsh' } })
    pages['Dcc4pQ8sX0N'] = readOf([], 'taranadarsh A plain caption about a film, no accounts named in it at all', 'taranadarsh')
    const first = await run()
    expect(first).toMatchObject({ asked: 1, restored: 0, nothingToRestore: 1 })
    expect(row.taggedAccounts).toBe('[]')
    expect(row.brands).toBe('["Festive Marketing Camp"]')
    expect(row.rawPayload).toContain(`"${EMBED_READ_KEY}"`)
    expect(audits).toHaveLength(0)
    asked.length = 0
    const second = await run()
    expect(second).toMatchObject({ waiting: 0, asked: 0 })
    expect(asked).toEqual([])
  })
})

describe('what is refused', () => {
  it('a page showing a DIFFERENT caption records nothing at all', async () => {
    const row = post({ shortcode: 'A1' })
    const before = { ...row }
    pages['A1'] = readOf(['somebody_else'], 'otherpublisher A completely different post about something else entirely @somebody_else')
    const s = await run()
    expect(s).toMatchObject({ asked: 1, notThisPost: 1, restored: 0, nothingToRestore: 0 })
    expect(row).toEqual(before)
    expect(audits).toHaveLength(0)
    // and it is not asked again straight away
    asked.length = 0
    expect(await run()).toMatchObject({ waiting: 1, coolingOff: 1, asked: 0 })
  })

  it('a page that did not answer is never recorded as "mentions nobody"', async () => {
    const row = post({ shortcode: 'A1' })
    const before = { ...row }
    const s = await run() // the stub's default: nothing usable
    expect(s).toMatchObject({ asked: 1, unreadable: 1, nothingToRestore: 0 })
    expect(row).toEqual(before)
    expect(row.rawPayload).not.toContain(EMBED_READ_KEY)
  })

  it('a row a complete read replaced while we were asking is left alone', async () => {
    const row = post({ shortcode: 'A1' })
    pages['A1'] = readOf(['itsbevygood'])
    changeRowBeforeWrite = (r) => {
      r.rawPayload = COMPLETE
      r.taggedAccounts = '["real_usertag"]'
    }
    const s = await run()
    expect(s).toMatchObject({ changedUnderUs: 1, restored: 0 })
    expect(row.rawPayload).toBe(COMPLETE)
    expect(row.taggedAccounts).toBe('["real_usertag"]')
    expect(audits).toHaveLength(0)
  })

  it('a stored row that is not in the expected shape is left alone', async () => {
    const row = post({ shortcode: 'A1', taggedAccounts: 'not json' })
    pages['A1'] = readOf(['itsbevygood'])
    const s = await run()
    expect(s.restored).toBe(0)
    expect(row.taggedAccounts).toBe('not json')
  })

  it('only official-read paid posts inside seven days are ever asked about', async () => {
    post({ shortcode: 'COMPLETE1', rawPayload: COMPLETE })
    post({ shortcode: 'ORGANIC01', verdict: 'ORGANIC' })
    post({ shortcode: 'OLDPOST01', postedAt: new Date(NOW.getTime() - 8 * 86_400_000) })
    post({ shortcode: 'NOPAYLOAD', rawPayload: null })
    post({ shortcode: 'WANTED001' })
    await run()
    expect(asked).toEqual(['WANTED001'])
  })
})

describe('the pass is bounded, and a refusal is about the host', () => {
  it('asks the newest first and stops at its budget', async () => {
    for (const code of ['NEWEST', 'SECOND', 'THIRD', 'FOURTH']) post({ shortcode: code })
    const s = await run(2)
    expect(asked).toEqual(['NEWEST', 'SECOND'])
    expect(s).toMatchObject({ waiting: 4, asked: 2, haltedEarly: true })
  })

  it('a refusal stops the pass at once and benches no post', async () => {
    for (const code of ['NEWEST', 'SECOND', 'THIRD']) post({ shortcode: code })
    pages['NEWEST'] = { kind: 'refused', reason: 'sent to the login page', until: new Date(NOW.getTime() + 900_000), status: 302, byUs: false }
    const s = await run()
    expect(asked).toEqual(['NEWEST'])
    expect(s).toMatchObject({ haltedEarly: true, unreadable: 0 })
    expect(s.stopped).toMatch(/refused/)
    // next pass: NEWEST is still first — it was not sent to the back for a day
    asked.length = 0
    pages = { NEWEST: readOf([]), SECOND: readOf([]), THIRD: readOf([]) }
    const again = await run(1)
    expect(asked).toEqual(['NEWEST'])
    expect(again.coolingOff).toBe(0)
  })

  it('with embed reads switched off it asks nothing and says why', async () => {
    post({ shortcode: 'A1' })
    pages['A1'] = { kind: 'not-asked', why: 'switched-off' }
    const s = await run()
    expect(s).toMatchObject({ asked: 0, restored: 0, stopped: 'embed reads are switched off' })
    pages['A1'] = { kind: 'not-asked', why: 'not-a-sending-machine' }
    expect((await run()).stopped).toBe('this machine does not ask embed pages')
  })

  it('a post that failed is sent to the back, so the next pass reaches the others', async () => {
    for (const code of ['BROKEN', 'GOOD01', 'GOOD02']) post({ shortcode: code })
    pages = { GOOD01: readOf([]), GOOD02: readOf([]) }
    await run(1)
    expect(asked).toEqual(['BROKEN'])
    asked.length = 0
    const s = await run(2)
    expect(asked).toEqual(['GOOD01', 'GOOD02'])
    expect(s.coolingOff).toBe(1)
  })

  it('a dry run writes nothing and shows what it would have written', async () => {
    const row = post({ shortcode: 'A1' })
    const before = { ...row }
    pages['A1'] = readOf(['itsbevygood', 'plumbodylovin'])
    const s = await run(10, true)
    expect(row).toEqual(before)
    expect(audits).toHaveLength(0)
    expect(s.preview).toEqual([{ shortcode: 'A1', publisher: 'officialsocialsamosa', mentions: ['itsbevygood', 'plumbodylovin'], collaborator: null, complete: true }])
    expect(s).toMatchObject({ restored: 1, mentionsRestored: 2 })
  })
})

describe('captionsAgree — is this page about this post', () => {
  const stored = 'Festive camp with itsbevygood and plumbodylovin, see you there 🎉\n#FestiveMarketingCamp'
  it('the same caption with its "@" back, behind the publisher’s name, agrees', () => {
    expect(captionsAgree(stored, 'officialsocialsamosa Festive camp with @itsbevygood and @plumbodylovin, see you there 🎉 #FestiveMarketingCamp')).toBe(true)
  })
  it('a caption the page cut short still agrees, because its beginning is there', () => {
    const long = 'Trailer out now for the biggest release of the year, starring everyone you have ever heard of and then some more people besides'
    expect(captionsAgree(long, 'publisher Trailer out now for the biggest release of the year, starring everyone you have ever heard of...')).toBe(true)
  })
  it('a different post does not', () => {
    expect(captionsAgree(stored, 'officialsocialsamosa A different post entirely, about something else @itsbevygood')).toBe(false)
    expect(captionsAgree(stored, 'This post is unavailable')).toBe(false)
  })
  it('works on a caption that is not in Latin letters', () => {
    const hindi = 'नई फिल्म का ट्रेलर आ गया है, जल्द ही सिनेमाघरों में'
    expect(captionsAgree(hindi, `viralbhayani ${hindi}`)).toBe(true)
    expect(captionsAgree(hindi, 'viralbhayani कुछ और ही लिखा है यहाँ पर बिल्कुल अलग')).toBe(false)
  })
  it('an empty caption on either side agrees with nothing', () => {
    expect(captionsAgree('', 'publisher something')).toBe(false)
    expect(captionsAgree('🎉🎉', 'publisher something')).toBe(false)
    expect(captionsAgree(stored, '')).toBe(false)
  })
  it('a very short caption must be the whole tail of the page’s, not a chance substring', () => {
    expect(captionsAgree('New drop', 'publisher New drop')).toBe(true)
    expect(captionsAgree('New drop', 'publisher A new drop of rain fell on the film set today')).toBe(false)
  })
})

describe('a read that is not whole is kept, and never recorded as read (review, 26 Nov)', () => {
  const LONG = 'Festive camp with itsbevygood and plumbodylovin, see you there on the lawns at noon with music and food'
  const partialCases: Array<[string, Outcome, string | undefined]> = [
    ['the page stopped before the caption ended', readOf(['itsbevygood'], undefined, 'officialsocialsamosa', { closed: false }), undefined],
    ['an "@" word nothing links to', readOf(['itsbevygood'], undefined, 'officialsocialsamosa', { unlinkedAt: ['farmleyin'] }), undefined],
    ['the page cut the caption short', readOf(['itsbevygood'], 'officialsocialsamosa Festive camp with @itsbevygood and @plumbodylovin, see you there on the lawns at noon … more'), LONG],
  ]

  it.each(partialCases)('%s: what it found is written, marked partial, and the post is asked again after a day', async (_n, outcome, caption) => {
    const row = post({ shortcode: 'A1', ...(caption ? { caption } : {}) })
    pages['A1'] = outcome
    const s = await run()
    expect(s).toMatchObject({ asked: 1, restored: 1, incomplete: 1 })
    expect(JSON.parse(row.taggedAccounts)).toEqual(['itsbevygood'])
    const payload = JSON.parse(row.rawPayload ?? '{}') as Record<string, unknown>
    expect(payload[EMBED_READ_KEY]).toBeUndefined()
    expect(payload.embedPartialAt).toBe(NOW.toISOString())
    expect(row.rawPayload).toContain(EVIDENCE_INCOMPLETE_MARKER)
    expect(audits[0]?.detail).toMatch(/read not whole/)
    // not read again within the day...
    asked.length = 0
    await run()
    expect(asked).toEqual([])
    // ...but still waiting: a later whole read can finish it
    resetEmbedEvidenceMemory()
    pages['A1'] = readOf(['itsbevygood', 'plumbodylovin'], `officialsocialsamosa ${row.caption}`)
    await run()
    expect(asked).toEqual(['A1'])
    expect(JSON.parse(row.rawPayload ?? '{}')[EMBED_READ_KEY]).toBe(NOW.toISOString())
    expect(JSON.parse(row.taggedAccounts)).toEqual(['itsbevygood', 'plumbodylovin'])
  })

  it('a read that is not whole and found nothing writes nothing at all', async () => {
    const row = post({ shortcode: 'A1' })
    const before = { ...row }
    pages['A1'] = readOf([], undefined, 'officialsocialsamosa', { unlinkedAt: ['somebody'] })
    const s = await run()
    expect(s).toMatchObject({ incomplete: 1, restored: 0, nothingToRestore: 0 })
    expect(row).toEqual(before)
    expect(audits).toHaveLength(0)
  })

  it('an unlinked "@" that is the publisher or the caption\'s owner does not make a read partial', async () => {
    const row = post({ shortcode: 'A1' })
    pages['A1'] = readOf(['itsbevygood'], undefined, 'officialsocialsamosa', { unlinkedAt: ['officialsocialsamosa'] })
    const s = await run()
    expect(s).toMatchObject({ incomplete: 0 })
    expect(JSON.parse(row.rawPayload ?? '{}')[EMBED_READ_KEY]).toBe(NOW.toISOString())
  })
})

describe('a caption signed by another account is a collaborator (review, 26 Nov)', () => {
  it('records the signer in the collaborators and as @handle in brands, with nothing else linked', async () => {
    const row = post({ shortcode: 'A1' })
    pages['A1'] = readOf([], 'socialsamosaevents Festive camp with itsbevygood and plumbodylovin, see you there', 'SocialSamosaEvents')
    const s = await run()
    expect(s).toMatchObject({ restored: 1, mentionsRestored: 0 })
    const payload = JSON.parse(row.rawPayload ?? '{}') as Record<string, unknown>
    expect(payload.collabHandles).toEqual(['socialsamosaevents'])
    expect(JSON.parse(row.brands)).toContain('@socialsamosaevents')
    expect(audits[0]?.detail).toMatch(/signed by @socialsamosaevents/)
  })

  it('the publisher signing its own caption is not a collaborator', async () => {
    const row = post({ shortcode: 'A1' })
    pages['A1'] = readOf([])
    await run()
    expect(JSON.parse(row.rawPayload ?? '{}').collabHandles ?? []).toEqual([])
    expect(audits).toHaveLength(0)
  })
})

describe('whose refusal stopped the pass is said in words (review, 26 Nov)', () => {
  it('our own ceiling is not reported as Instagram refusing', async () => {
    post({ shortcode: 'A1' })
    pages['A1'] = { kind: 'refused', reason: 'our own ceiling: this Mac’s 40 embed requests an hour are spent', until: NOW, status: 429, byUs: true }
    const s = await run()
    expect(s.stopped).toMatch(/^stopped by this Mac’s own limit/)
    expect(s.stopped).not.toMatch(/Instagram/)
    expect(s).toMatchObject({ haltedEarly: true, asked: 0 })
  })

  it('Instagram refusing is reported as Instagram', async () => {
    post({ shortcode: 'A1' })
    pages['A1'] = { kind: 'refused', reason: 'HTTP 429', until: NOW, status: 429, byUs: false }
    expect((await run()).stopped).toMatch(/^Instagram refused/)
  })
})

describe('mergeEmbedMentions — the pure half', () => {
  const stored = { taggedAccounts: '[]', brands: '[]', rawPayload: OFFICIAL }
  it('refuses a row that is not an official-read row', () => {
    expect(mergeEmbedMentions({ ...stored, rawPayload: COMPLETE }, { mentions: ['a_brand'], owner: null, collaborator: null, complete: true }, NOW)).toBeNull()
  })
  it('refuses unreadable stored JSON rather than guessing', () => {
    expect(mergeEmbedMentions({ ...stored, brands: '{"not":"an array"}' }, { mentions: ['a_brand'], owner: null, collaborator: null, complete: true }, NOW)).toBeNull()
    expect(mergeEmbedMentions({ ...stored, taggedAccounts: '[1,2]' }, { mentions: ['a_brand'], owner: null, collaborator: null, complete: true }, NOW)).toBeNull()
    expect(mergeEmbedMentions({ ...stored, rawPayload: `garbage ${EVIDENCE_INCOMPLETE_MARKER}` }, { mentions: ['a_brand'], owner: null, collaborator: null, complete: true }, NOW)).toBeNull()
  })
  it('lower-cases what it adds, because the tag prefilter on Postgres is case-sensitive', () => {
    const m = mergeEmbedMentions(stored, { mentions: ['A_Brand', 'a_brand'], owner: null, collaborator: null, complete: true }, NOW)
    expect(m && JSON.parse(m.taggedAccounts)).toEqual(['a_brand'])
    expect(m && JSON.parse(m.brands)).toEqual(['@a_brand'])
  })
  it('keeps every key the payload already had', () => {
    const m = mergeEmbedMentions(stored, { mentions: [], owner: null, collaborator: null, complete: true }, NOW)
    const before = JSON.parse(OFFICIAL) as Record<string, unknown>
    const after = JSON.parse(m?.rawPayload ?? '{}') as Record<string, unknown>
    for (const k of Object.keys(before)) expect(after[k]).toEqual(before[k])
  })
})
