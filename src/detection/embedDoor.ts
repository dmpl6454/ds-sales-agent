/**
 * embedDoor.ts — the ONE gated way production asks Instagram's embed pages. Nothing else calls `fetchEmbed`
 * except `pnpm ig:embed-check`, a person's probe, which deliberately touches no gate and no setting.
 *
 * What stands between a caller and a request, in order:
 *
 *   1. THE SWITCH AND THE MACHINE. `embedReads` is off by default, and even when it is on only a machine that may
 *      send (`SEND_ENABLED`) asks. The server never does: it is refused on these pages (measured 26 Nov, 302 to
 *      the login page), and a datacenter address knocking on them every pass is noise nobody needs. "Not asked"
 *      is its own outcome, so a caller falls back to exactly what it did before this file existed.
 *   2. THE GATE. `anonGate`'s `embed` scope: a refusal — being sent to the login page, a 429/401, a login page
 *      served as the answer — closes the door for 15, 30, then 60 minutes, and while it is closed nothing is
 *      requested at all. One request per cooldown finds out whether it has reopened.
 *   3. THE PROOF, for the badge only. Before this door's word about ANY account is used, it must have read — in
 *      the last twelve hours, in this process — "verified" on an account we hold as verified AND "not verified"
 *      on one we hold as not. That is rule 66 pointed both ways: a field that says true about everything would
 *      admit everybody (VERIFIED ONLY broken), and one that says false about everything would refuse every lead
 *      for good (a measured `false` is persisted and never asked again). Two extra requests, twice a day. If the
 *      proof fails the door's badge readings are not used for half an hour and an alarm says why.
 *
 * NOTHING HERE IS EVER A VERDICT EXCEPT `read`. A page with no data for the handle (a missing account, a gated
 * one and an empty shell look alike), a reading the parser would not commit to, a timeout, an odd status: all
 * `nothing`. Callers already treat that as "could not tell".
 */
import { anonGateCheck, anonGateRecordSuccess, anonGateRecordThrottle } from './anonGate'
import {
  fetchEmbed,
  embedUserAgent,
  installedChromeMajor,
  profileEmbedUrl,
  postEmbedUrl,
  type EmbedAnswer,
  type EmbedFetchOptions,
} from './embedFetch'
import { parseProfileEmbed, parsePostEmbed, normaliseHandle, type BadgeBasis } from './embedParse'
import { env } from '@/lib/env'
import { log } from '@/lib/logger'
import { embedClient } from '@/lib/platform'
import { getSettings } from '@/lib/settings'

/** The probe's spacing: never two embed requests closer than this, whoever asked. */
export const EMBED_SPACING_MS = 2_000
/** How long a proof of the badge reading stands. */
export const EMBED_PROOF_MAX_AGE_MS = 12 * 60 * 60_000
/** After a failed proof, how long before it is tried again. */
export const EMBED_PROOF_RETRY_MS = 30 * 60_000
/** The hourly ceiling when the setting cannot be read. The setting's own default. */
export const EMBED_MAX_PER_HOUR_FALLBACK = 40
const HOUR_MS = 60 * 60_000

/**
 * Accounts whose answer we hold, MEASURED through this door on 26 Nov 2026: the first two read verified, the last
 * two read not verified (@marketingmentalist has not posted since 2020). A label can go stale — an account can
 * gain or lose the badge — which is why there are two of each and one of each is enough.
 */
export const EMBED_CONTROLS_VERIFIED: readonly string[] = ['netflix_in', 'sonytvofficial']
export const EMBED_CONTROLS_UNVERIFIED: readonly string[] = ['marketingmentalist', 'chumbak_official']

export type EmbedProfileOutcome =
  | { kind: 'read'; isVerified: boolean; fullName: string | null; followers: number | null; basis: BadgeBasis }
  /** The switch is off, or this machine is not one that may ask. No request. */
  | { kind: 'not-asked'; why: 'switched-off' | 'not-a-sending-machine' }
  /** The door is closed (it refused just now, or it is still cooling off). */
  | { kind: 'refused'; reason: string; until: Date; status: number }
  /** We asked, or could not ask, and learned nothing about this account. Never a verdict. */
  | { kind: 'nothing'; reason: string; status: number | null }

export type EmbedPostOutcome =
  | { kind: 'read'; owner: string | null; mentions: string[]; captionText: string; atSigns: number }
  | { kind: 'not-asked'; why: 'switched-off' | 'not-a-sending-machine' }
  | { kind: 'refused'; reason: string; until: Date; status: number }
  | { kind: 'nothing'; reason: string; status: number | null }

// ── seams (tests replace these; production never does) ─────────────────────────────────────────────

type Fetcher = (url: string, opts: EmbedFetchOptions) => Promise<EmbedAnswer>
interface Seams {
  fetch: Fetcher
  now: () => number
  sleep: (ms: number) => Promise<void>
  /** null = ask the real switch and the real machine. */
  allowed: (() => Promise<EmbedProfileOutcome & { kind: 'not-asked' } | null>) | null
  userAgent: string | null
  /** null = the `embedMaxPerHour` setting. */
  maxPerHour: number | null
}
const realSeams = (): Seams => ({
  fetch: fetchEmbed,
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  allowed: null,
  userAgent: null,
  maxPerHour: null,
})
let seams: Seams = realSeams()
let lastRequestAt = 0
let provenAt: number | null = null
let proofFailedAt: number | null = null
let proofFailure: string | null = null
let requestsMade = 0
/** When each of the last hour's requests was made — the hourly ceiling counts these. In-process, like the proof. */
let recentRequests: number[] = []

/** Tests only. Pass nothing to restore the real door and forget everything it remembered. */
export function setEmbedDoorForTests(overrides?: Partial<Seams>): void {
  seams = { ...realSeams(), ...(overrides ?? {}) }
  lastRequestAt = 0
  provenAt = null
  proofFailedAt = null
  proofFailure = null
  requestsMade = 0
  recentRequests = []
}

/** How many embed requests this process has made. For a pass's summary line. */
export function embedRequestsMade(): number {
  return requestsMade
}

type NotAsked = { kind: 'not-asked'; why: 'switched-off' | 'not-a-sending-machine' }

/**
 * `person` is a human at a terminal asking to SEE what the door would say before deciding to switch it on
 * (`pnpm ig:embed-evidence`, dry run). It skips the switch and nothing else: the machine rule, the gate, the
 * hourly ceiling and the proof all still apply.
 */
async function notAllowed(person = false): Promise<NotAsked | null> {
  if (seams.allowed) return seams.allowed()
  if (!env.SEND_ENABLED) return { kind: 'not-asked', why: 'not-a-sending-machine' }
  if (person) return null
  try {
    const settings = await getSettings()
    return settings.embedReads ? null : { kind: 'not-asked', why: 'switched-off' }
  } catch {
    // A switch we could not read is a switch that is off.
    return { kind: 'not-asked', why: 'switched-off' }
  }
}

type Asked =
  | { kind: 'page'; body: string }
  | { kind: 'refused'; reason: string; until: Date; status: number }
  | { kind: 'nothing'; reason: string; status: number | null }

/** One gated, spaced request. Records a refusal on the gate; a 200 is handed back for the caller to judge. */
async function ask(url: string): Promise<Asked> {
  const gate = anonGateCheck('embed')
  if (!gate.ok) {
    return { kind: 'refused', reason: `embed pages refused until ${gate.until.toISOString()}`, until: gate.until, status: 429 }
  }
  let transport: EmbedFetchOptions['transport'] = 'curl'
  let maxPerHour = seams.maxPerHour ?? EMBED_MAX_PER_HOUR_FALLBACK
  if (!seams.allowed) {
    try {
      const settings = await getSettings()
      transport = settings.embedTransport
      if (seams.maxPerHour === null && Number.isFinite(settings.embedMaxPerHour)) maxPerHour = settings.embedMaxPerHour
    } catch {
      transport = 'curl'
    }
  }
  /* THE HOURLY CEILING. Not Instagram refusing — us — so nothing is recorded on the gate; but it is reported the
     way a closed door is, because what a caller must do is the same: stop this pass, blame no candidate. */
  const hourAgo = seams.now() - HOUR_MS
  recentRequests = recentRequests.filter((t) => t > hourAgo)
  if (recentRequests.length >= maxPerHour) {
    const until = new Date((recentRequests[0] ?? seams.now()) + HOUR_MS)
    return { kind: 'refused', reason: `this hour's ${maxPerHour} embed requests are spent`, until, status: 429 }
  }
  const wait = lastRequestAt + EMBED_SPACING_MS - seams.now()
  if (wait > 0) await seams.sleep(wait)
  lastRequestAt = seams.now()
  requestsMade++
  recentRequests.push(lastRequestAt)
  const client = embedClient()
  const userAgent = seams.userAgent ?? embedUserAgent(client.os, await installedChromeMajor(client.os))
  const a = await seams.fetch(url, { userAgent, transport, curlPath: client.curlPath })

  const refuse = (status: number, reason: string): Asked => {
    const until = anonGateRecordThrottle('embed', status)
    return { kind: 'refused', reason, until, status }
  }
  if (a.kind === 'login-redirect') return refuse(a.status, 'sent to the login page')
  if (a.kind === 'redirect-refused') return { kind: 'nothing', reason: `HTTP ${a.status}, a redirect that is not followed`, status: a.status }
  if (a.kind === 'no-answer') return { kind: 'nothing', reason: `no answer (${a.error})`, status: null }
  if (a.status === 429 || a.status === 401) return refuse(a.status, `HTTP ${a.status}`)
  if (a.status === 403 && /require_login|wait a few minutes/i.test(a.body)) return refuse(a.status, 'HTTP 403 with require_login')
  if (a.status !== 200) return { kind: 'nothing', reason: `HTTP ${a.status}`, status: a.status }
  return { kind: 'page', body: a.body }
}

/** A 200 that turned out to be a login page: that is the door refusing, and it is recorded as that. */
function wall(reason: string): Asked & { kind: 'refused' } {
  const until = anonGateRecordThrottle('embed', 200)
  return { kind: 'refused', reason: `served a login page (${reason})`, until, status: 429 }
}

/** Ask about one account with no proof required — the proof itself is made of these. */
async function askProfile(handle: string): Promise<EmbedProfileOutcome> {
  const url = profileEmbedUrl(handle)
  if (url === null) return { kind: 'nothing', reason: 'not a handle', status: null }
  const a = await ask(url)
  if (a.kind !== 'page') return a
  const r = parseProfileEmbed(a.body, handle)
  if (r.kind === 'wall') return wall(r.reason)
  // The door answered: whatever it said about this handle, it is not refusing us.
  anonGateRecordSuccess('embed')
  if (r.kind === 'no-profile-data') return { kind: 'nothing', reason: `the embed page has no profile data for this handle (${r.reason})`, status: null }
  if (r.isVerified === null) return { kind: 'nothing', reason: `the embed page does not say (${r.undecided ?? 'no reason'})`, status: null }
  return { kind: 'read', isVerified: r.isVerified, fullName: r.fullName, followers: r.followers, basis: r.basis }
}

type Proof = { ok: true } | { ok: false; outcome: EmbedProfileOutcome & { kind: 'refused' | 'nothing' } }

/** See point 3 in the header. */
async function ensureProven(): Promise<Proof> {
  const now = seams.now()
  if (provenAt !== null && now - provenAt < EMBED_PROOF_MAX_AGE_MS) return { ok: true }
  if (proofFailedAt !== null && now - proofFailedAt < EMBED_PROOF_RETRY_MS) {
    return { ok: false, outcome: { kind: 'nothing', reason: `the embed badge reading is not trusted right now (${proofFailure ?? 'the last proof failed'})`, status: null } }
  }
  const sawWanted = async (controls: readonly string[], want: boolean): Promise<{ saw: boolean; notes: string[]; refused: (EmbedProfileOutcome & { kind: 'refused' }) | null }> => {
    const notes: string[] = []
    for (const control of controls) {
      const o = await askProfile(control)
      if (o.kind === 'refused') return { saw: false, notes, refused: o }
      if (o.kind === 'read') {
        notes.push(`@${control} read ${o.isVerified ? 'verified' : 'not verified'}`)
        if (o.isVerified === want) return { saw: true, notes, refused: null }
      } else if (o.kind === 'nothing') {
        notes.push(`@${control}: ${o.reason}`)
      }
    }
    return { saw: false, notes, refused: null }
  }
  const yes = await sawWanted(EMBED_CONTROLS_VERIFIED, true)
  if (yes.refused) return { ok: false, outcome: yes.refused }
  const no = yes.saw ? await sawWanted(EMBED_CONTROLS_UNVERIFIED, false) : { saw: false, notes: [] as string[], refused: null }
  if (no.refused) return { ok: false, outcome: no.refused }
  if (yes.saw && no.saw) {
    provenAt = seams.now()
    proofFailedAt = null
    proofFailure = null
    log.step('embed badge reading proven on accounts whose answer we hold', { controls: [...yes.notes, ...no.notes].join('; ') })
    return { ok: true }
  }
  proofFailedAt = seams.now()
  proofFailure = !yes.saw
    ? `no account held as verified read verified: ${yes.notes.join('; ') || 'nothing came back'}`
    : `no account held as NOT verified read not verified: ${no.notes.join('; ') || 'nothing came back'}`
  log.alarm('the embed badge reading failed its proof — it is not used until a proof passes', {
    why: proofFailure,
    retryInMinutes: Math.round(EMBED_PROOF_RETRY_MS / 60_000),
  })
  return { ok: false, outcome: { kind: 'nothing', reason: `the embed badge reading is not trusted right now (${proofFailure})`, status: null } }
}

/**
 * What Instagram's embed page says about this account's badge, name and followers — or why we do not know.
 * Only `read` may be acted on.
 */
export async function readProfileEmbed(handleInput: string): Promise<EmbedProfileOutcome> {
  const refusedHere = await notAllowed()
  if (refusedHere) return refusedHere
  const handle = normaliseHandle(handleInput)
  if (handle === null) return { kind: 'nothing', reason: 'not a handle', status: null }
  const proof = await ensureProven()
  if (!proof.ok) return proof.outcome
  return askProfile(handle)
}

/** The @mentions Instagram links in this post's caption — or why we do not know. Only `read` may be acted on. */
export async function readPostEmbed(shortcode: string, opts: { person?: boolean } = {}): Promise<EmbedPostOutcome> {
  const refusedHere = await notAllowed(opts.person === true)
  if (refusedHere) return refusedHere
  const url = postEmbedUrl(shortcode)
  if (url === null) return { kind: 'nothing', reason: 'not a post shortcode', status: null }
  const a = await ask(url)
  if (a.kind !== 'page') return a
  const r = parsePostEmbed(a.body)
  if (r.kind === 'wall') return wall(r.reason)
  anonGateRecordSuccess('embed')
  if (r.kind === 'no-caption') return { kind: 'nothing', reason: `the embed page shows no caption (${r.reason})`, status: null }
  return { kind: 'read', owner: r.owner, mentions: r.mentions, captionText: r.captionText, atSigns: r.atSigns }
}
