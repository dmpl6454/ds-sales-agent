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
 *   4. ONE KEY IS NOT THE HOST (review, 26 Nov 2026). A login page, no answer or a 5xx for ONE account or post may be
 *      about that one (Instagram gates some accounts for logged-out visitors), and closing the door on it made that
 *      one key — always first in a newest-first queue — close the door again every pass. So before the door is
 *      closed for anything but a 429/401, a control account's page is asked: if it answers, the failure belongs to
 *      the key (a `nothing` the caller sends to the back of its queue); if it does not, it belongs to the door.
 *   5. THE CEILING AND THE SPACING ARE THIS MAC'S. The requests of the last hour are kept in a small file under the
 *      data directory, so the agent and a person's command running beside it share one ceiling and one spacing.
 *      Two processes writing in the same instant can lose one entry; that is the whole error, and it is stated.
 *
 * Refusals come in two kinds, and both make a caller STOP its pass without blaming the key it was on: Instagram
 * refusing (`byUs: false`, recorded on the gate) and this file refusing (`byUs: true` — the ceiling, a proof that
 * failed, a control that did not answer — recorded nowhere, because Instagram said nothing).
 *
 * NOTHING HERE IS EVER A VERDICT EXCEPT `read`. A page with no data for the handle (a missing account, a gated
 * one and an empty shell look alike), a reading the parser would not commit to, a timeout, an odd status: all
 * `nothing`. Callers already treat that as "could not tell".
 */
import fs from 'node:fs'
import { dirname, join } from 'node:path'
import { anonGateCheck, anonGateRecordSuccess, anonGateRecordThrottle, hydrateAnonGate } from './anonGate'
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
import { DATA_ROOT } from '@/lib/paths'
import { embedClient } from '@/lib/platform'
import { getSettings } from '@/lib/settings'

/** The probe's spacing: never two embed requests from this Mac closer than this, whoever asked (point 5). */
export const EMBED_SPACING_MS = 2_000
/** How long a proof of the badge reading stands. */
export const EMBED_PROOF_MAX_AGE_MS = 12 * 60 * 60_000
/** After a failed proof, how long before it is tried again. */
export const EMBED_PROOF_RETRY_MS = 30 * 60_000
/** The hourly ceiling when the setting cannot be read. The setting's own default. */
export const EMBED_MAX_PER_HOUR_FALLBACK = 40
const HOUR_MS = 60 * 60_000
/** Where this Mac's last hour of embed requests is kept (point 5). Public request times only — nothing else. */
export const EMBED_LEDGER_FILE = join(DATA_ROOT, 'embed-requests.json')
/** How often a process re-reads the gate's persisted cooldown, so it sees one another process recorded. */
const HYDRATE_EVERY_MS = 5 * 60_000
/** How long a "could not confirm" halt is reported to last. Nothing is recorded; the next pass asks again. */
const UNCONFIRMED_HALT_MS = 15 * 60_000

/**
 * Accounts whose answer we hold, MEASURED through this door on 26 Nov 2026: the first two read verified, the last
 * two read not verified (@marketingmentalist has not posted since 2020). One of each kind that READS is enough, so
 * a page that cannot be read is tolerated; one that reads the OPPOSITE of what we hold fails the proof and raises
 * an alarm (review, 26 Nov 2026: a contradiction is evidence of a broken reader before it is evidence of a stale
 * label, and it is a person who decides the label is stale — by editing this list).
 */
export const EMBED_CONTROLS_VERIFIED: readonly string[] = ['netflix_in', 'sonytvofficial']
export const EMBED_CONTROLS_UNVERIFIED: readonly string[] = ['marketingmentalist', 'chumbak_official']

type NotAsked = { kind: 'not-asked'; why: 'switched-off' | 'not-a-sending-machine' }
/** The door is closed. `byUs` = this file closed it (ceiling, proof, an unconfirmed failure); else Instagram did. */
export type EmbedRefusal = { kind: 'refused'; reason: string; until: Date; status: number; byUs: boolean }
type Nothing = { kind: 'nothing'; reason: string; status: number | null }

export type EmbedProfileOutcome =
  | { kind: 'read'; isVerified: boolean; fullName: string | null; followers: number | null; basis: BadgeBasis }
  /** The switch is off, or this machine is not one that may ask. No request. */
  | NotAsked
  | EmbedRefusal
  /** We asked, or could not ask, and learned nothing about this account. Never a verdict. */
  | Nothing

export type EmbedPostOutcome =
  | {
      kind: 'read'
      owner: string | null
      mentions: string[]
      captionText: string
      atSigns: number
      /** "@handle" words in the caption no link goes to. See `parsePostEmbed`. */
      unlinkedAt: string[]
      /** False when the page stopped before the caption element ended. */
      closed: boolean
    }
  | NotAsked
  | EmbedRefusal
  | Nothing

// ── the Mac-wide ledger (point 5) ─────────────────────────────────────────────────────────────────

export interface Ledger {
  read(): number[]
  write(at: number[]): void
}

/** The file, with an in-memory copy for when it cannot be read or written — a ledger problem never stops a read. */
function fileLedger(file: string): Ledger {
  let memory: number[] = []
  return {
    read() {
      try {
        const v: unknown = JSON.parse(fs.readFileSync(file, 'utf8'))
        const at = (v as { at?: unknown } | null)?.at
        if (Array.isArray(at)) return at.filter((n): n is number => typeof n === 'number' && Number.isFinite(n))
      } catch {
        /* missing or unreadable: this process's own memory stands in */
      }
      return memory
    },
    write(at) {
      memory = at
      try {
        fs.mkdirSync(dirname(file), { recursive: true })
        const tmp = `${file}.${process.pid}.tmp`
        fs.writeFileSync(tmp, JSON.stringify({ at }))
        fs.renameSync(tmp, file)
      } catch {
        /* the in-memory copy still bounds this process */
      }
    },
  }
}

function memoryLedger(): Ledger {
  let at: number[] = []
  return { read: () => at, write: (v) => void (at = v) }
}

// ── seams (tests replace these; production never does) ─────────────────────────────────────────────

type Fetcher = (url: string, opts: EmbedFetchOptions) => Promise<EmbedAnswer>
interface Seams {
  fetch: Fetcher
  now: () => number
  sleep: (ms: number) => Promise<void>
  /** null = ask the real switch and the real machine. */
  allowed: (() => Promise<NotAsked | null>) | null
  userAgent: string | null
  /** null = the `embedMaxPerHour` setting. */
  maxPerHour: number | null
  ledger: Ledger
  /** Re-reads the gate's persisted cooldown. */
  hydrate: () => Promise<void>
}
const realSeams = (): Seams => ({
  fetch: fetchEmbed,
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  allowed: null,
  userAgent: null,
  maxPerHour: null,
  ledger: fileLedger(EMBED_LEDGER_FILE),
  hydrate: hydrateAnonGate,
})
let seams: Seams = realSeams()
let provenAt: number | null = null
let proofFailedAt: number | null = null
let proofFailure: string | null = null
let requestsMade = 0
let hydratedAt: number | null = null

/**
 * Tests only. Pass nothing to restore a fresh door and forget everything it remembered. A test door keeps its
 * ledger in memory and does not re-read the gate unless the test hands it a ledger or a hydrate of its own —
 * a suite must never write into this machine's real data directory.
 */
export function setEmbedDoorForTests(overrides?: Partial<Seams>): void {
  seams = { ...realSeams(), ledger: memoryLedger(), hydrate: async () => undefined, ...(overrides ?? {}) }
  provenAt = null
  proofFailedAt = null
  proofFailure = null
  requestsMade = 0
  hydratedAt = null
}

/** Tests only: the real file ledger, on a file the test owns — how two processes are shown to share one ceiling. */
export function embedFileLedgerForTests(file: string): Ledger {
  return fileLedger(file)
}

/** How many embed requests this process has made. For a pass's summary line. */
export function embedRequestsMade(): number {
  return requestsMade
}

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

/** A failure about ONE url that might be about the door instead — see point 4. Not yet judged. */
type KeyFailure = { kind: 'key-failure'; reason: string; status: number | null; login: boolean }
type Asked = { kind: 'page'; body: string } | EmbedRefusal | Nothing | KeyFailure

function byUs(reason: string, until: Date): EmbedRefusal {
  return { kind: 'refused', reason, until, status: 429, byUs: true }
}

/** Instagram refused this host: recorded on the gate, so nothing is asked until the cooldown ends. */
function refuseHost(status: number, reason: string): EmbedRefusal {
  const until = anonGateRecordThrottle('embed', status)
  return { kind: 'refused', reason, until, status: status === 200 ? 429 : status, byUs: false }
}

async function maybeHydrate(): Promise<void> {
  const now = seams.now()
  if (hydratedAt !== null && now - hydratedAt < HYDRATE_EVERY_MS) return
  hydratedAt = now
  try {
    await seams.hydrate()
  } catch {
    /* an unreadable cooldown row is not a cooldown */
  }
}

/** One gated, spaced, counted request. A 429/401 is recorded at once; a failure that may be the key's is not. */
async function ask(url: string): Promise<Asked> {
  await maybeHydrate()
  const gate = anonGateCheck('embed')
  if (!gate.ok) {
    return { kind: 'refused', reason: `embed pages refused until ${gate.until.toISOString()}`, until: gate.until, status: 429, byUs: false }
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
  /* THE HOURLY CEILING, this Mac's (point 5). Not Instagram refusing — us — so nothing is recorded on the gate; but
     it is reported the way a closed door is, because what a caller must do is the same: stop, blame no key. */
  const now = seams.now()
  // A time more than a minute ahead is a clock that moved, not a request: it is dropped rather than obeyed for ever.
  const recent = seams.ledger.read().filter((t) => t > now - HOUR_MS && t <= now + 60_000)
  if (recent.length >= maxPerHour) {
    const oldest = recent.reduce((a, b) => Math.min(a, b), now)
    return byUs(`our own ceiling: this Mac\u2019s ${maxPerHour} embed requests an hour are spent`, new Date(oldest + HOUR_MS))
  }
  const last = recent.reduce((a, b) => Math.max(a, b), 0)
  const wait = last + EMBED_SPACING_MS - now
  if (wait > 0) await seams.sleep(wait)
  const at = seams.now()
  seams.ledger.write([...recent, at].slice(-Math.max(2 * maxPerHour, 100)))
  requestsMade++
  const client = embedClient()
  const userAgent = seams.userAgent ?? embedUserAgent(client.os, await installedChromeMajor(client.os))
  const a = await seams.fetch(url, { userAgent, transport, curlPath: client.curlPath })

  if (a.kind === 'login-redirect') return { kind: 'key-failure', reason: 'sent to the login page', status: a.status, login: true }
  if (a.kind === 'redirect-refused') return { kind: 'nothing', reason: `HTTP ${a.status}, a redirect that is not followed`, status: a.status }
  if (a.kind === 'no-answer') return { kind: 'key-failure', reason: `no answer (${a.error})`, status: null, login: false }
  // Told to stop: asking a control first would be asking again after being told to stop.
  if (a.status === 429 || a.status === 401) return refuseHost(a.status, `HTTP ${a.status}`)
  if (a.status === 403 && /require_login|wait a few minutes/i.test(a.body)) return refuseHost(a.status, 'HTTP 403 with require_login')
  if (a.status >= 500) return { kind: 'key-failure', reason: `HTTP ${a.status}`, status: a.status, login: false }
  if (a.status !== 200) return { kind: 'nothing', reason: `HTTP ${a.status}`, status: a.status }
  // A page longer than the cap is cut, and a cut page can lose the object the verdict needs: nothing is read off it.
  if (a.capped) return { kind: 'nothing', reason: 'the page was longer than the 3 MB that are kept, so it is not read', status: null }
  return { kind: 'page', body: a.body }
}

/** See point 4. `isControl` is the control's own request, which is never confirmed against itself. */
async function judgeKeyFailure(f: Omit<KeyFailure, 'kind'>, isControl: boolean): Promise<EmbedRefusal | Nothing> {
  if (isControl) {
    if (f.login) return refuseHost(f.status ?? 200, f.reason)
    return byUs(`a control page did not answer either (${f.reason})`, new Date(seams.now() + UNCONFIRMED_HALT_MS))
  }
  const control = EMBED_CONTROLS_VERIFIED[0] ?? 'netflix_in'
  const c = await askProfile(control, true)
  if (c.kind === 'refused') return c
  if (c.kind === 'read') {
    return { kind: 'nothing', reason: `${f.reason} — for this one only: @${control}\u2019s page answered at the same time`, status: f.login ? 403 : f.status }
  }
  // The control said something we could not read: we cannot tell the key from the door, so nobody is blamed.
  return byUs(`${f.reason}, and @${control}\u2019s page could not confirm the door works (${c.kind === 'nothing' ? c.reason : c.kind})`, new Date(seams.now() + UNCONFIRMED_HALT_MS))
}

/** Ask about one account with no proof required — the proof itself, and point 4's confirmation, are made of these. */
async function askProfile(handle: string, isControl: boolean): Promise<EmbedProfileOutcome> {
  const url = profileEmbedUrl(handle)
  if (url === null) return { kind: 'nothing', reason: 'not a handle', status: null }
  const a = await ask(url)
  if (a.kind === 'key-failure') return judgeKeyFailure(a, isControl)
  if (a.kind !== 'page') return a
  const r = parseProfileEmbed(a.body, handle)
  if (r.kind === 'wall') return judgeKeyFailure({ reason: `served a login page (${r.reason})`, status: 200, login: true }, isControl)
  // The door answered: whatever it said about this handle, it is not refusing us.
  anonGateRecordSuccess('embed')
  if (r.kind === 'no-profile-data') return { kind: 'nothing', reason: `the embed page has no profile data for this handle (${r.reason})`, status: null }
  if (r.isVerified === null) return { kind: 'nothing', reason: `the embed page does not say (${r.undecided ?? 'no reason'})`, status: null }
  return { kind: 'read', isVerified: r.isVerified, fullName: r.fullName, followers: r.followers, basis: r.basis }
}

type Proof = { ok: true } | { ok: false; outcome: EmbedRefusal }

/** See point 3. A proof that fails stops the CALLER's pass (a refusal by us), never benches the key it was on. */
async function ensureProven(): Promise<Proof> {
  const now = seams.now()
  if (provenAt !== null && now - provenAt < EMBED_PROOF_MAX_AGE_MS) return { ok: true }
  if (proofFailedAt !== null && now - proofFailedAt < EMBED_PROOF_RETRY_MS) {
    return {
      ok: false,
      outcome: byUs(`the embed badge reading is not trusted right now (${proofFailure ?? 'the last proof failed'})`, new Date(proofFailedAt + EMBED_PROOF_RETRY_MS)),
    }
  }
  type Saw = { saw: boolean; notes: string[]; refused: EmbedRefusal | null; contradiction: string | null }
  const sawWanted = async (controls: readonly string[], want: boolean): Promise<Saw> => {
    const notes: string[] = []
    for (const control of controls) {
      const o = await askProfile(control, true)
      if (o.kind === 'refused') return { saw: false, notes, refused: o, contradiction: null }
      if (o.kind === 'read') {
        notes.push(`@${control} read ${o.isVerified ? 'verified' : 'not verified'}`)
        if (o.isVerified === want) return { saw: true, notes, refused: null, contradiction: null }
        return { saw: false, notes, refused: null, contradiction: `@${control} is held as ${want ? '' : 'NOT '}verified and read ${o.isVerified ? 'verified' : 'not verified'}` }
      }
      if (o.kind === 'nothing') notes.push(`@${control}: ${o.reason}`)
    }
    return { saw: false, notes, refused: null, contradiction: null }
  }
  const fail = (why: string): Proof => {
    proofFailedAt = seams.now()
    proofFailure = why
    log.alarm('the embed badge reading failed its proof — it is not used until a proof passes', {
      why,
      retryInMinutes: Math.round(EMBED_PROOF_RETRY_MS / 60_000),
    })
    return { ok: false, outcome: byUs(`the embed badge reading is not trusted right now (${why})`, new Date(proofFailedAt + EMBED_PROOF_RETRY_MS)) }
  }
  const yes = await sawWanted(EMBED_CONTROLS_VERIFIED, true)
  if (yes.refused) return { ok: false, outcome: yes.refused }
  if (yes.contradiction) return fail(yes.contradiction)
  if (!yes.saw) return fail(`no account held as verified could be read: ${yes.notes.join('; ') || 'nothing came back'}`)
  const no = await sawWanted(EMBED_CONTROLS_UNVERIFIED, false)
  if (no.refused) return { ok: false, outcome: no.refused }
  if (no.contradiction) return fail(no.contradiction)
  if (!no.saw) return fail(`no account held as NOT verified could be read: ${no.notes.join('; ') || 'nothing came back'}`)
  provenAt = seams.now()
  proofFailedAt = null
  proofFailure = null
  log.step('embed badge reading proven on accounts whose answer we hold', { controls: [...yes.notes, ...no.notes].join('; ') })
  return { ok: true }
}

/**
 * What Instagram's embed page says about this account's badge, name and followers — or why we do not know.
 * Only `read` may be acted on.
 */
export async function readProfileEmbed(handleInput: string): Promise<EmbedProfileOutcome> {
  const refusedHere = await notAllowed()
  if (refusedHere) return refusedHere
  /* THE HANDLE AS WRITTEN, OR NOTHING (review, 26 Nov 2026). `normaliseHandle` strips trailing dots, so
     "netflix_in.." — what a caption reading "@netflix_in..." yields — would be read as @netflix_in's page, and its
     badge answered under the dotted name: a second prospect for a company we hold, or a PROSPECT row for a watched
     competitor ("@viralbhayani.."). The feed refused such a mismatch by comparing usernames; this does the same. */
  const asWritten = handleInput.trim().replace(/^@/, '').toLowerCase()
  const handle = normaliseHandle(handleInput)
  if (handle === null || handle !== asWritten) return { kind: 'nothing', reason: 'not an Instagram handle as written', status: null }
  const proof = await ensureProven()
  if (!proof.ok) return proof.outcome
  return askProfile(handle, false)
}

/** The @mentions Instagram links in this post's caption — or why we do not know. Only `read` may be acted on. */
export async function readPostEmbed(shortcode: string, opts: { person?: boolean } = {}): Promise<EmbedPostOutcome> {
  const refusedHere = await notAllowed(opts.person === true)
  if (refusedHere) return refusedHere
  const url = postEmbedUrl(shortcode)
  if (url === null) return { kind: 'nothing', reason: 'not a post shortcode', status: null }
  const a = await ask(url)
  if (a.kind === 'key-failure') return judgeKeyFailure(a, false)
  if (a.kind !== 'page') return a
  const r = parsePostEmbed(a.body)
  if (r.kind === 'wall') return judgeKeyFailure({ reason: `served a login page (${r.reason})`, status: 200, login: true }, false)
  anonGateRecordSuccess('embed')
  if (r.kind === 'no-caption') return { kind: 'nothing', reason: `the embed page shows no caption (${r.reason})`, status: null }
  return {
    kind: 'read',
    owner: r.owner,
    mentions: r.mentions,
    captionText: r.captionText,
    atSigns: r.atSigns,
    unlinkedAt: r.unlinkedAt,
    closed: r.closed,
  }
}
