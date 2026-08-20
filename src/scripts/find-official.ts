/**
 * `pnpm ig:find-official` — for in-window CAMPAIGN posts that name NOBODY (no caption
 * mention, no tag, no collab), try to find the advertiser's OFFICIAL page from the brand
 * NAMES the post carries (caption-extracted names, then OCR frame text). DRY RUN BY
 * DEFAULT; `--run` creates targets for identity-grade matches only.
 *
 * ── THE BAR (officialHandle.ts) ─────────────────────────────────────────────
 *
 * Auto-accept ONLY a verified badge + covering name, or ≥ officialMinFollowers + business
 * + EXACT name. Everything that merely exists is printed under NEEDS A HUMAN — a
 * constructed handle was measured wrong 4/10 with 3 of 4 wrong handles EXISTING, and a
 * wrong "official page" puts a media-buying pitch in a stranger's inbox from a revenue
 * account. `--accept <handle>` on a later invocation admits a near-miss deliberately,
 * audited as the operator's act.
 *
 * RUN FROM A HOME IP — the Linode is 429'd on the profile endpoint. A throttle halts the
 * run; a dead candidate is that candidate's fact and never halts anything.
 */
import { prisma } from '@/lib/db'
import { detectionCutoff } from '@/lib/cutoff'
import { enrichHandle } from '@/detection/enrichHandle'
import { candidateHandlesFor, isOfficialMatch } from '@/detection/officialHandle'
import { brandCandidatesFor, excludedHandles } from '@/detection/brandCandidates'
import { createBrandTarget } from '@/outreach/brandTarget'
import { getSettings } from '@/lib/settings'

const LOOKUP_SPACING_MS = 6_000

/**
 * OCR frame text → possible brand-name tokens. Deliberately crude and HIGH-precision-
 * hostile — that is fine, because nothing here auto-accepts: junk tokens cost printed
 * lines and bounded lookups, never a message. Frame names are only consulted when the
 * caption-extracted list is empty (lower-trust source, lower priority).
 */
const OCR_STOPWORDS = new Set([
  'THE', 'AND', 'FOR', 'NEW', 'FIRST', 'INSIDE', 'VIEW', 'LIVE', 'NOW', 'OUT', 'JAN', 'FEB',
  'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC', 'MON', 'TUE', 'WED',
  'THU', 'FRI', 'SAT', 'SUN', 'INDIA', 'OFFICIAL', 'EPISODE', 'SEASON', 'TRAILER', 'TEASER',
])
function frameBrandTokensLocal(frameText: string | null): string[] {
  if (frameText === null) return []
  const out = new Set<string>()
  for (const raw of frameText.split(/[|•·\n\r,;:!?"“”]+/)) {
    const t = raw.trim()
    // A brand mark on a frame is short, lettered, and not a stopword or a time/date.
    if (/^[A-Za-z][A-Za-z0-9&.' -]{2,24}$/.test(t) && !OCR_STOPWORDS.has(t.toUpperCase()) && !/^\d/.test(t)) {
      out.add(t)
    }
  }
  return [...out].slice(0, 3)
}

async function main(): Promise<void> {
  const run = process.argv.includes('--run')
  const limitArg = process.argv.indexOf('--limit')
  const lookupBudget = limitArg > -1 ? Number(process.argv[limitArg + 1]) || 15 : 15
  const acceptArg = process.argv.indexOf('--accept')

  const settings = await getSettings()

  /** Deliberate admission of a printed near-miss: a person read the evidence and decided. */
  if (acceptArg > -1) {
    const handle = (process.argv[acceptArg + 1] ?? '').replace(/^@/, '').toLowerCase()
    if (!handle) throw new Error('--accept needs a handle')
    const e = await enrichHandle(handle)
    if (!e.reachable) throw new Error(`@${handle} is not reachable: ${e.reason ?? 'unknown'}`)
    const outcome = await createBrandTarget(
      { kind: 'BRAND', handle, displayName: e.fullName ?? handle, category: null, followers: e.followers },
      null,
      'brand.discovered',
      'cli:find-official-accept',
    )
    if (outcome === 'created') {
      await prisma.targetAccount.update({
        where: { handle },
        data: { isVerified: e.isVerified, followerCount: e.followers },
      })
    }
    console.log(`@${handle}: ${outcome} (verified=${e.isVerified ?? '?'} followers=${e.followers ?? '?'})`)
    await prisma.$disconnect()
    return
  }

  const [posts, excluded, existingTargets, senders, lookedBefore] = await Promise.all([
    prisma.detectedCampaign.findMany({
      where: { verdict: 'CAMPAIGN', postedAt: { gte: detectionCutoff() } },
      select: {
        id: true,
        shortcode: true,
        caption: true,
        taggedAccounts: true,
        rawPayload: true,
        brands: true,
        frameText: true,
        target: { select: { handle: true } },
      },
      orderBy: { postedAt: 'desc' },
    }),
    excludedHandles(),
    prisma.targetAccount.findMany({ select: { handle: true } }),
    prisma.senderAccount.findMany({ select: { handle: true } }),
    prisma.brandLookup.findMany({ select: { handle: true } }),
  ])
  const alreadyKnown = new Set<string>([
    ...existingTargets.map((t) => t.handle.toLowerCase()),
    ...senders.map((s) => s.handle.toLowerCase()),
    ...lookedBefore.map((l) => l.handle.toLowerCase()),
    ...excluded,
  ])

  /** Posts where Instagram itself asserts NOBODY — the population this command exists for. */
  const anonymous = posts.filter(
    (p) => brandCandidatesFor({ caption: p.caption, taggedAccounts: p.taggedAccounts, rawPayload: p.rawPayload }, excluded).length === 0,
  )

  /** brand name → the posts that carry it (caption names first, frame tokens as fallback). */
  const names = new Map<string, { source: 'caption' | 'frame'; shortcodes: string[]; campaignId: string; channel: string }>()
  for (const p of anonymous) {
    let fromCaption: string[] = []
    try {
      fromCaption = (JSON.parse(p.brands) as string[]).filter((b) => typeof b === 'string' && b.length >= 3)
    } catch {
      /* a malformed brands column is that row's problem, not the run's */
    }
    const list: Array<{ name: string; source: 'caption' | 'frame' }> =
      fromCaption.length > 0
        ? fromCaption.map((name) => ({ name, source: 'caption' as const }))
        : frameBrandTokensLocal(p.frameText).map((name) => ({ name, source: 'frame' as const }))
    for (const { name, source } of list) {
      const key = name.toLowerCase()
      const row = names.get(key)
      if (row) row.shortcodes.push(p.shortcode)
      else names.set(key, { source, shortcodes: [p.shortcode], campaignId: p.id, channel: p.target.handle })
    }
  }

  console.log(
    `${run ? 'RUN' : 'DRY RUN'} — ${anonymous.length} in-window CAMPAIGN posts name nobody; ` +
      `${names.size} distinct brand names to try, lookup budget ${lookupBudget} (6s apart, home IP)`,
  )

  let looked = 0
  let created = 0
  const needsHuman: string[] = []
  /** Caption names first: the trustworthy source spends the bounded budget before OCR tokens. */
  const ordered = [...names.entries()].sort((a, b) =>
    a[1].source === b[1].source ? 0 : a[1].source === 'caption' ? -1 : 1,
  )
  outer: for (const [key, info] of ordered) {
    for (const candidate of candidateHandlesFor(key)) {
      if (alreadyKnown.has(candidate)) continue
      if (looked >= lookupBudget) break outer
      const e = await enrichHandle(candidate)
      looked += 1
      await new Promise((r) => setTimeout(r, LOOKUP_SPACING_MS))
      if (!e.reachable) {
        if ((e.reason ?? '').includes('429')) {
          console.log(`HALT: throttled after ${looked} lookups — re-run later, nothing is lost`)
          break outer
        }
        continue
      }
      // VERIFIED ONLY (Tabish, 2026-08-20). The badge plus a covering name, nothing else.
      const match = isOfficialMatch({ brandName: key, fullName: e.fullName, isVerified: e.isVerified })
      const evidence = `"${key}" (${info.source}, ${info.shortcodes.length} post(s), e.g. ${info.shortcodes[0]}) → @${candidate}: ${e.fullName ?? '—'}, verified=${e.isVerified ?? '?'}, followers=${e.followers ?? '?'}`
      if (match) {
        console.log(`  OFFICIAL MATCH  ${evidence}`)
        if (run) {
          const outcome = await createBrandTarget(
            { kind: 'BRAND', handle: candidate, displayName: e.fullName ?? key, category: null, followers: e.followers },
            { id: info.campaignId, shortcode: info.shortcodes[0], channelHandle: info.channel },
            'brand.discovered',
            'cli:find-official',
          )
          if (outcome === 'created') {
            await prisma.targetAccount.update({
              where: { handle: candidate },
              data: { isVerified: e.isVerified, followerCount: e.followers },
            })
            created += 1
          }
          console.log(`    -> ${outcome}`)
        }
        continue outer // one official page per brand name is the point
      }
      // Exists, plausibly related, fails the bar: a person decides, never a fuzzy accept.
      if (e.isVerified !== true) needsHuman.push(`${evidence}\n    admit with: pnpm ig:find-official --accept ${candidate}`)
    }
  }

  if (needsHuman.length > 0) {
    console.log(`\nNEEDS A HUMAN (${needsHuman.length}) — existence is not identity; read before admitting:`)
    for (const line of needsHuman) console.log(`  ${line}`)
  }
  console.log(`\nlooked=${looked} created=${created} names=${names.size} anonymousPosts=${anonymous.length}`)
  if (!run) console.log('Dry run created nothing. --run creates identity-grade matches only.')
  await prisma.$disconnect()
}

main().catch(async (err) => {
  console.error(err)
  await prisma.$disconnect()
  process.exit(1)
})
