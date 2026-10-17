import { prisma } from '@/lib/db'
import { sessionRecorded } from './sessionHealth'
import { cache } from 'react'
import { DEVICE_PRESENCE_KEY } from './devicePresence'

/**
 * ── AN ACCOUNT NO ONLINE MAC HOLDS IS NOT ELECTABLE (17 October 2026) ────────────────────
 *
 * MEASURED on the box, 17 Oct ~05:40 IST. Tabish's Mac — the only machine that ever held
 * @bollywoodchronicle's Chrome profile — is gone; its last `devicePresence` entry is weeks old
 * (`mergePresence` keeps other devices' entries, so it is still in the row). The sending Mac
 * (`activeDevice = DMPLs Mac Studio`) lists paparazzii, societyy, madaboutmarketingg and
 * totalfilmii and NOT chronicle. Chronicle's row still reads ACTIVE, not invalid, session
 * recorded — every fact this reader asked — so rotation kept electing it and the planner kept
 * writing it drafts: 147 first touches and 45 follow-ups waiting, last delivery 22 September.
 * The Studio holds every one ("no-session — this Mac holds no signed-in profile"). And because
 * the new-brand bound is a fleet-wide DEPTH (`maxWaitingNewBrandDrafts` 150, counted by
 * `readNewBrandTouchCounts`), chronicle's undeliverable drafts filled it: every pass read
 * `new-brand-daily-cap=377`, `queued=0`, and the four accounts that CAN send were starved.
 * Zero sends from ~10:00 UTC on 16 October. The planner (server) and the sender (a Mac)
 * disagreed about which accounts exist, and only the planner's view was being asked.
 *
 * The witness is `Setting.devicePresence` — a DATABASE row every device agent writes every
 * 30 s, so the Linode planner and a Mac read the same fact and this file stays
 * machine-independent (its header's whole argument). An account is electable only if SOME
 * entry written within `SESSION_HOLDER_WINDOW_MS` lists it in `handles` — counted PER HANDLE
 * from a persisted history, not per entry (see `SESSION_HOLDER_SEEN_KEY` below).
 *
 * WHY 72 HOURS AND NOT `PRESENCE_FRESH_MS` (2 min). Fresh-within-two-minutes is "is this Mac
 * beating now", which is the dispatcher's question. Rotation's is "does a Mac still exist that
 * can send for this account". A lid closed overnight or a weekend away must not flip every
 * account out of rotation and back — that would release and re-write drafts (and re-claim
 * posts) every time somebody's Mac slept, and the ring would spin. Three days is past any
 * ordinary absence and well short of the five weeks this outage sat undetected. If every Mac
 * is gone for longer, every account reads unavailable and the queue empties — truthful: nothing
 * could send, and a Mac's first heartbeat makes its accounts electable on the next pass.
 *
 * ABSENCE OF THE ROW IS NOT A VERDICT. No row, an unparseable row, or a row with no entry that
 * carries a `handles` array means this deployment has no witness (a fresh install, a laptop
 * that never ran the device agent, every test that seeds no presence) — and then nothing
 * changes. Absence of data hardening into "nobody holds anything" would stop drafting
 * fleet-wide, which is the exact failure this file's header was written about.
 *
 * THIS ALSO NARROWS `eligibleFleetSenders`, deliberately. The ring rule's "every page has
 * written" counts only pages that COULD write; a page no Mac holds cannot, so counting it made
 * ring-complete unreachable for every recipient chronicle had not reached — the same reason a
 * signed-out page is excluded there.
 *
 * Deliberately NOT here: whether the holder is the SELECTED Mac (`activeDevice`). A standby Mac
 * that holds an account is a Mac a person can switch to with one click; a Mac that has not been
 * online for three days is not. That is the Stage 4 question and has its own risk.
 */
export const SESSION_HOLDER_WINDOW_MS = 72 * 3_600_000

/** The sentence rotation, the dashboard and the planner's release all carry. ONE string. */
export const NOT_HELD_BY_AN_ONLINE_MAC = 'signed in on no Mac that has been online in the last 3 days'

/**
 * ── THE WINDOW IS PER HANDLE, NOT PER ENTRY (17 Oct 2026, review) ─────────────────────────
 *
 * A Mac that is still BEATING rewrites its own entry every 30 s (`mergePresence` drops the old
 * one), so the entry's `at` is always fresh while its `handles` list carries no history at all.
 * Keyed on the entry alone, the 72 h window covered only a Mac that stopped writing: ONE beat
 * listing fewer handles — `hasSessionCookie` fails closed, so a full disk (measured twice on
 * this fleet) or a torn copy of a Cookies file Chrome is writing makes a live Mac publish
 * `handles: []` — un-held those accounts at once, and the planner's release then SKIPped their
 * whole queue, permanently, on one snapshot. A same-name twin whose entry `mergePresence` prunes
 * after two minutes lost its accounts the same way.
 *
 * So the window is applied to WHEN EACH HANDLE WAS LAST LISTED by any entry, and that history is
 * persisted (`Setting.sessionHolderSeen`, `{handle: ISO}`) so an overwritten or pruned entry, or
 * one bad beat, cannot remove an account: it stays held until no read in 72 h has listed it.
 * The planner is the one writer (`recordSessionHolderHistory`, once a pass); every reader merges
 * the stored history with the presence row it reads, so a reader between passes agrees with it.
 *
 * Note what the history is NOT: it never makes the rule fire where it was inert. Whether the
 * deployment has a witness is still asked of the PRESENCE row alone — no entry with `handles`
 * means no change, whatever the history says.
 */
export const SESSION_HOLDER_SEEN_KEY = 'sessionHolderSeen'

/** PURE. A stored history, or `null` when it is absent or unreadable — never a guess. */
export function parseHolderHistory(raw: string | null | undefined): Record<string, string> | null {
  if (typeof raw !== 'string') return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const out: Record<string, string> = {}
    for (const [h, at] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof at === 'string' && Number.isFinite(new Date(at).getTime())) out[h.toLowerCase()] = at
    }
    return out
  } catch {
    return null
  }
}

/**
 * PURE. The history after reading `entries`: for every handle, the latest `at` of any entry that
 * lists it, merged with what was stored. A date ahead of `now` (a Mac whose clock runs fast) is
 * clamped to `now`, or one entry could hold an account for 72 h past a time that never came.
 * Handles last listed beyond the window are dropped — the verdict for a dropped handle and a
 * stale one is the same (`not-held`), so pruning is neutral and keeps the row bounded.
 */
export function mergeHolderHistory(
  history: Readonly<Record<string, string>> | null,
  entries: readonly unknown[],
  now: number,
): Record<string, string> {
  const latest = new Map<string, number>()
  const note = (h: string, t: number) => {
    const k = h.toLowerCase()
    if (t > (latest.get(k) ?? -Infinity)) latest.set(k, t)
  }
  for (const [h, at] of Object.entries(history ?? {})) {
    const t = new Date(at).getTime()
    if (Number.isFinite(t)) note(h, Math.min(t, now))
  }
  for (const e of entries) {
    if (e === null || typeof e !== 'object') continue
    const { at, handles } = e as { at?: unknown; handles?: unknown }
    if (!Array.isArray(handles) || typeof at !== 'string') continue
    const t = new Date(at).getTime()
    if (!Number.isFinite(t)) continue
    for (const h of handles) if (typeof h === 'string') note(h, Math.min(t, now))
  }
  const out: Record<string, string> = {}
  for (const k of [...latest.keys()].sort()) {
    const t = latest.get(k)!
    if (now - t <= SESSION_HOLDER_WINDOW_MS) out[k] = new Date(t).toISOString()
  }
  return out
}

/**
 * PURE. Which handles a Mac has listed within the window — or `null` when the presence row is no
 * witness at all (no entry carries a `handles` array). Lower-cased: a handle is case-insensitive
 * on Instagram, and the presence row and the sender row are written by different code.
 * `history` is the stored per-handle record (above); without one this is the entries alone.
 */
export function onlineSessionHolders(
  entries: readonly unknown[],
  now: number,
  history: Readonly<Record<string, string>> | null = null,
): Set<string> | null {
  const witness = entries.some(
    (e) => e !== null && typeof e === 'object' && Array.isArray((e as { handles?: unknown }).handles),
  )
  if (!witness) return null
  return new Set(Object.keys(mergeHolderHistory(history, entries, now)))
}

/**
 * PURE. The one question, three answers — `no-witness` must stay distinct from `not-held`,
 * because only the second is evidence about the account.
 */
export function sessionHolderVerdict(
  entries: readonly unknown[],
  handle: string,
  now: number,
  history: Readonly<Record<string, string>> | null = null,
): 'held' | 'not-held' | 'no-witness' {
  const held = onlineSessionHolders(entries, now, history)
  if (held === null) return 'no-witness'
  return held.has(handle.toLowerCase()) ? 'held' : 'not-held'
}

/** The two rows, raw, in ONE query. Request-cached like `getSettings`: a page asks several times. */
const readHolderRows = cache(async () =>
  prisma.setting.findMany({ where: { key: { in: [DEVICE_PRESENCE_KEY, SESSION_HOLDER_SEEN_KEY] } } }),
)

function parsePresence(raw: string | undefined): unknown[] {
  if (raw === undefined) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

/**
 * Which handles a Mac seen within the window holds, from the shared rows — `null` = no witness,
 * and the rule is inert. The ONE database reader of this fact: rotation, the planner's release
 * and every screen that says whether an account can send ask it, so none can disagree.
 */
export async function readSessionHolders(now: number = Date.now()): Promise<Set<string> | null> {
  const rows = await readHolderRows()
  const presence = parsePresence(rows.find((r) => r.key === DEVICE_PRESENCE_KEY)?.value)
  const history = parseHolderHistory(rows.find((r) => r.key === SESSION_HOLDER_SEEN_KEY)?.value)
  return onlineSessionHolders(presence, now, history)
}

/**
 * Persist the history — the planner, once a pass, and nothing else (written on a loop, so its
 * key is in `PULSE_IGNORED_SETTING_KEYS`, rule 47). Writes nothing when the presence row is no
 * witness, so a deployment with no device agent never grows the row.
 *
 * `hadHistory` says whether a usable history existed BEFORE this read. The planner's release
 * waits for it: on the very first pass after deploy the history is seeded from one snapshot of
 * the presence row, and a release is never decided on one snapshot.
 */
export async function recordSessionHolderHistory(now: number = Date.now()): Promise<{ hadHistory: boolean }> {
  const rows = await prisma.setting.findMany({ where: { key: { in: [DEVICE_PRESENCE_KEY, SESSION_HOLDER_SEEN_KEY] } } })
  const presence = parsePresence(rows.find((r) => r.key === DEVICE_PRESENCE_KEY)?.value)
  const prior = parseHolderHistory(rows.find((r) => r.key === SESSION_HOLDER_SEEN_KEY)?.value)
  if (onlineSessionHolders(presence, now, prior) === null) return { hadHistory: prior !== null }
  const value = JSON.stringify(mergeHolderHistory(prior, presence, now))
  await prisma.setting.upsert({
    where: { key: SESSION_HOLDER_SEEN_KEY },
    update: { value },
    create: { key: SESSION_HOLDER_SEEN_KEY, value },
  })
  return { hadHistory: prior !== null }
}

/**
 * WHICH ACCOUNTS ROTATION MUST SKIP, AND WHY — one definition, every caller.
 *
 * ── WHY IT IS SHARED ──────────────────────────────────────────────────────
 *
 * Three places need this answer and they must not disagree: the planner (deciding whose
 * turn it is to be written to), `pnpm ig:dedupe-drafts` (deciding which duplicate survives)
 * and the dashboard (telling an operator who is next). If the page computed availability
 * its own way it could name a different account than the planner will actually use — the
 * exact drift `gate.ts` was extracted to stop, and `/messages` renders these sentences.
 *
 * ── EVERY FACT HERE IS MACHINE-INDEPENDENT ────────────────────────────────
 *
 * There is deliberately no `profileStatus` read. MEASURED 2026-08-13: the planner runs on
 * the Linode (`schedulerHeartbeat` → `machine: linode-detect`), and that host has no
 * `~/.ds-sales-agent` directory at all — Chrome profiles live on each operator's own device
 * and the server may never send. A filesystem check here answers `false` for every account
 * on the one machine that drafts, which would resolve every recipient to `all-unavailable`
 * and stop drafting fleet-wide, silently. `sessionRecorded` says why the weaker claim is
 * the right one.
 *
 * The reasons are sentences because a refusal that reads "every sender is unavailable —
 * bollywoodsocietyy: never signed in; madaboutmarketingg: never signed in" is actionable
 * and "nothing happened" is not.
 */
export async function readSenderAvailability(now: number = Date.now()): Promise<Map<string, string>> {
  const unavailable = new Map<string, string>()
  const [senders, held] = await Promise.all([
    prisma.senderAccount.findMany({
      select: { id: true, handle: true, status: true, sessionPath: true, sessionInvalidAt: true },
    }),
    /* `null` = this deployment has no witness; the rule is then inert (see the top of the file). */
    readSessionHolders(now),
  ])
  for (const s of senders) {
    if (s.status === 'CHALLENGED') unavailable.set(s.id, 'flagged by Instagram')
    else if (s.status !== 'ACTIVE') unavailable.set(s.id, s.status.toLowerCase())
    /**
     * §3.5: two different facts, two different fixes, so two different sentences. A dead
     * session was PROVED dead by a real send that met a login form; "never signed in" means
     * no hand login was ever recorded for this account at all.
     */
    else if (s.sessionInvalidAt !== null) unavailable.set(s.id, 'logged out — needs signing in again')
    else if (!sessionRecorded(s)) unavailable.set(s.id, 'never signed in')
    /**
     * Asked LAST, so the sentence names the more specific cause when there is one: a flagged
     * or signed-out account is fixable on a Mac that exists, and saying "no Mac holds it"
     * would send a person looking for the wrong thing. Only the planner's release reads THIS
     * reason (plan.ts), so the order is also what keeps that release narrow.
     */
    else if (held !== null && !held.has(s.handle.toLowerCase())) unavailable.set(s.id, NOT_HELD_BY_AN_ONLINE_MAC)
  }
  return unavailable
}

/**
 * THE SENDERS THE RING RULE COUNTS AS "ALL OUR PAGES" (crossSpacing.ts, 2026-08-19).
 *
 * "All pages have written to this recipient" is only meaningful over pages that COULD
 * write — counting a signed-out account would make ring-complete unreachable and the
 * 7-day rest would never fire. Machine-independent on purpose: the governor asks on the
 * Linode and the gate asks on the Mac, and a filesystem fact here would make the two
 * enforcers disagree (the trap this file's header documents). Built ON
 * readSenderAvailability so "who rotation skips" and "who the ring counts" never drift.
 *
 * FLEET-WIDE, deliberately, with the HANDLE carried: which of these pages may write to a
 * given recipient is a question about that recipient, and `crossSpacingVerdict` answers it
 * through the same fleet filter rotation uses (M12). Returning bare ids is how the ring
 * rule came to count a marketing page as one of "all" for every bollywood recipient.
 */
export async function eligibleFleetSenders(): Promise<{ id: string; handle: string }[]> {
  const [fleet, unavailable] = await Promise.all([
    prisma.senderAccount.findMany({ where: { fleetMember: true, status: 'ACTIVE' }, select: { id: true, handle: true } }),
    readSenderAvailability(),
  ])
  return fleet.filter((s) => !unavailable.has(s.id))
}
