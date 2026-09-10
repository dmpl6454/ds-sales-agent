import { prisma } from '@/lib/db'
import { DELIVERED_STATUSES } from '@/lib/constants'

/**
 * Phase 9 — the cohort ladder.
 *
 * ── WHY THIS IS THE ONLY PHASE THAT CHANGES EXPOSURE ──────────────────────
 *
 * Everything before this made the system safer at four accounts. This one multiplies the
 * number of real, revenue-generating Instagram business assets the automation touches by
 * sixteen, and each of the 61 new accounts needs a hand login that writes device identity
 * which cannot be rebuilt. The plan's own §4.3 says it plainly: *61 hand logins is the real
 * cost of this plan*.
 *
 * And the risk is not per-account. All 65 drive one code path from one residential IP against
 * overlapping recipients, which is a correlation surface that does not exist today. Rotation
 * hides volume from OUR metrics — each account looks quiet at 0.27 messages a day — while the
 * recipient's inbox and Meta's view of that inbox are unchanged.
 *
 * ── THE LADDER IS THE MECHANISM, NOT A CONVENTION ─────────────────────────
 *
 * A few accounts go live. They are watched for a stated period. Only then may the next few be
 * armed. The alternative is arming 61 accounts and finding out together, which is the shape of
 * failure this project has spent its whole history designing against.
 *
 * Written as code rather than left to whoever is doing the logins, because "we will go slowly"
 * is a plan and a refusal is a guarantee.
 *
 * ── WHERE IT IS ENFORCED, AFTER THE ONE-SWITCH CHANGE (2026-08-08) ─────────
 *
 * It used to hold at BOTH ends: the dashboard refused to arm a blocked cohort, and `gate.ts`
 * re-asked at delivery. Per-account arming is being REMOVED — Tabish's decision that autopilot
 * is one switch — so the arming end is disappearing and there will be no arming step left to
 * refuse at. `gate.ts` therefore becomes the SINGLE enforcement point, via `mayArmAccount` at
 * its evaluation site, returning `RESEND_BLOCKS.COHORT_NOT_CLEARED`.
 *
 * That is not a weakening, and the reason is worth stating: the arming check was a check on an
 * INTENTION recorded earlier, while the delivery check is asked about the message actually
 * about to go out. It is also the end that cannot be bypassed by editing the database, which is
 * why it was built as the backstop in the first place. But it is now load-bearing ALONE — do
 * not remove `mayArmAccount` as "unused" on the strength of its name. Nothing else asks the
 * ladder before a send.
 *
 * ── EVERYTHING IS DERIVED ─────────────────────────────────────────────────
 *
 * `SenderAccount.cohort` is the only stored field. How long a cohort has been sending, and
 * whether anything went wrong, is computed from `OutreachAttempt` and `challengedAt`. Phase 3
 * made the same choice for rotation and for the same reason: a stored "cohort 2 cleared on the
 * 12th" can drift from what actually happened, and this codebase has been bitten by exactly
 * that.
 */

/**
 * How many days a cohort must have been SENDING before the next may be armed.
 *
 * 14 is a floor I chose, not a number anyone measured, and it is stated that way on purpose.
 * The standing recommendation in CLAUDE.md is a **2-4 week soak** on a throwaway account before
 * touching the revenue accounts, and it has never been done — that risk was accepted, not
 * removed. 14 days is the bottom of that range applied per cohort.
 *
 * It is a `Setting`, so Tabish can raise or lower it without a code change, exactly like
 * `fleetMaxPerDay`. Lowering it is a decision about exposure and should be made deliberately.
 */
export const DEFAULT_COHORT_SOAK_DAYS = 14

/**
 * How many accounts belong in one cohort.
 *
 * 5 is deliberately small. 61 accounts in cohorts of 5 is thirteen steps, which sounds slow
 * until you weigh it against losing one of three revenue accounts. Also a `Setting`.
 */
export const DEFAULT_COHORT_SIZE = 5

export interface CohortMember {
  handle: string
  cohort: number
  status: string
  challengedAt: Date | null
  /**
   * A hand login was RECORDED for this account and nothing has since proved it dead
   * (`sessionPath` set, `sessionInvalidAt` null) — the same machine-independent fact
   * `readSenderAvailability` uses. Until 2026-09-10 this was `profileStatus(...).hasSession`,
   * a read of THIS Mac's disk, so on a second Mac holding one profile every group-1 account
   * read as signed out, `previous.live` was 0, and that Mac could never send its group-2
   * account: "group 1 has no account sending on its own yet" about a group delivering all day.
   * The ladder asks whether the FLEET's previous group is live; the disk answers for one Mac.
   */
  hasSession: boolean
  /** When this account's first message was DELIVERED, or null if it has never sent. */
  firstDeliveredAt: Date | null
}

export interface CohortState {
  cohort: number
  members: CohortMember[]
  /**
   * Accounts that can actually send: connected AND not halted.
   *
   * ONE SWITCH, 2026-08-08. This used to require `autoSendEnabled` as well, and that column
   * is no longer a control anywhere — Tabish's decision that autopilot is a single switch, so
   * per-account arming is gone. Ability is DERIVED now, and "can this account send" is a
   * question about a session and a status, not about a bit somebody remembered to flip.
   *
   * That makes rule 2 STRICTER in the only direction that matters. It never was the evidence:
   * an armed account with a dead session cannot send, and it counted as live. Now `live`
   * describes capability, and rule 4 — has this group actually DELIVERED something, measured
   * from `OutreachAttempt` — carries the whole evidential weight, which is where it always
   * belonged. Arming was a statement of intent; a delivered message is what was observed.
   */
  live: number
  /** Flagged by Instagram at any point, whether or not it has been cleared. */
  everChallenged: number
  /** Earliest delivery across the cohort. Null when nothing has been sent yet. */
  soakStartedAt: Date | null
  soakDays: number
}

export type LadderVerdict =
  | { ok: true; reason: 'baseline' | 'previous-cohort-cleared' }
  | { ok: false; reason: 'previous-cohort-not-live' | 'previous-cohort-still-soaking' | 'previous-cohort-flagged'; detail: string }

/**
 * May cohort N be armed? PURE, so both directions are testable without a fleet.
 *
 * The rules, in the order they are checked, and each one is a different question:
 *
 *  1. Cohort 1 is the BASELINE and always passes. Those accounts predate the ladder and one of
 *     them has done every send this project has ever made; a mechanism that retroactively
 *     disarmed them would be a gate nobody chose.
 *  2. The previous cohort must actually be LIVE — able to send: connected and not halted.
 *     Clearing cohort 3 while cohort 2 sits disconnected would let someone skip a rung by
 *     doing nothing, which is the failure mode of every staged rollout. Since the one-switch
 *     change this measures CAPABILITY rather than a per-account arming bit; the bit was never
 *     the evidence, which is what rule 4 is for.
 *  3. Nothing in ANY earlier cohort may have been flagged. `everChallenged`, not "currently
 *     challenged": a checkpoint that was cleared still happened, and it is evidence about the
 *     pattern rather than about the account. Clearing a halt un-blocks that account's own
 *     sending; it must not also buy permission to add five more.
 *  4. The previous cohort must have been sending for `soakDays`. Measured from its first
 *     DELIVERED message, because a cohort that CAN send and has sent nothing has not been
 *     observed at all — which is the same "freshness is not liveness" mistake as reading a
 *     heartbeat's age, and it would let thirteen rungs be climbed in a fortnight by logging
 *     accounts in and never sending from them.
 *
 *     This is the rule carrying the real evidential weight, and it carries MORE of it since
 *     rule 2 stopped asking about a per-account arming bit: a delivered message is something
 *     that happened, where arming was only ever something somebody intended.
 */
export function mayArmCohort(args: {
  cohort: number
  /** Every cohort's state, in any order. */
  states: readonly CohortState[]
  soakDays: number
  now: Date
}): LadderVerdict {
  const { cohort, states, soakDays, now } = args

  if (cohort <= 1) return { ok: true, reason: 'baseline' }

  // Rule 3 first in effect, since it looks at ALL earlier cohorts rather than just the last.
  const earlier = states.filter((s) => s.cohort < cohort)
  const flagged = earlier.filter((s) => s.everChallenged > 0)
  if (flagged.length > 0) {
    return {
      ok: false,
      reason: 'previous-cohort-flagged',
      /**
       * "group", not "cohort", in every operator-facing string. The page heading says
       * "Group 1" and this sentence renders directly underneath it — CLAUDE.md's rule is that
       * the dashboard is read by a CEO and internal vocabulary does not belong on it, and a
       * warning the reader has to translate has not done its job.
       */
      detail:
        `Instagram has questioned ${flagged.reduce((n, s) => n + s.everChallenged, 0)} account(s) in group ` +
        `${flagged.map((s) => s.cohort).join(', ')}. Clearing that halt lets those accounts send again; ` +
        `it does not clear this step, because being questioned is evidence about the pattern rather than about one account.`,
    }
  }

  const previous = states.find((s) => s.cohort === cohort - 1)
  if (!previous || previous.live === 0) {
    return {
      ok: false,
      reason: 'previous-cohort-not-live',
      detail: `group ${cohort - 1} has no account sending on its own yet — a step cannot be skipped by leaving it empty`,
    }
  }

  if (previous.soakStartedAt === null) {
    return {
      ok: false,
      reason: 'previous-cohort-still-soaking',
      detail: `group ${cohort - 1} is signed in but has not sent anything yet, so there is nothing to have watched`,
    }
  }

  const daysSoaked = (now.getTime() - previous.soakStartedAt.getTime()) / 86_400_000
  if (daysSoaked < soakDays) {
    const left = Math.ceil(soakDays - daysSoaked)
    return {
      ok: false,
      reason: 'previous-cohort-still-soaking',
      detail: `group ${cohort - 1} has been sending for ${Math.floor(daysSoaked)} of ${soakDays} days — ${left} more to go`,
    }
  }

  return { ok: true, reason: 'previous-cohort-cleared' }
}

/**
 * Which cohort a NEW account should join, given how many are already in the newest one.
 *
 * Fills the current cohort before opening the next. Opening one per account would make the
 * ladder meaningless — 61 cohorts of one, each waiting 14 days, is 2.3 years.
 *
 * ── A NEW ACCOUNT NEVER JOINS COHORT 1 ────────────────────────────────────
 *
 * FOUND BY RUNNING IT against the live database, which reported *"next new account joins
 * cohort 1"*. Cohort 1 has 4 members and the size is 5, so there was "room" — and cohort 1 is
 * the BASELINE, which `mayArmCohort` passes unconditionally because those accounts predate the
 * ladder. So the fifth account added would have been armable the moment it was logged in, with
 * no soak at all: the first account of the fleet expansion bypassing the entire mechanism built
 * to stage it.
 *
 * Room in the baseline is not room on the ladder. Once cohort 1 exists, new accounts start at 2.
 */
export function cohortForNewAccount(args: { existingCounts: ReadonlyMap<number, number>; cohortSize: number }): number {
  const { existingCounts, cohortSize } = args
  if (existingCounts.size === 0) return 1

  const highest = Math.max(...existingCounts.keys())
  const inHighest = existingCounts.get(highest) ?? 0
  const candidate = inHighest < cohortSize ? highest : highest + 1
  // Never the baseline: it is exempt from the soak by definition.
  return Math.max(candidate, 2)
}

// ── the database half: queries only, no decisions ───────────────────────────

/** Every cohort's live state, derived. */
export async function readCohortStates(now: Date = new Date()): Promise<CohortState[]> {
  const senders = await prisma.senderAccount.findMany({
    select: { handle: true, cohort: true, status: true, challengedAt: true, sessionPath: true, sessionInvalidAt: true },
    orderBy: [{ cohort: 'asc' }, { handle: 'asc' }],
  })

  /**
   * First delivery PER SENDER, from the attempts themselves.
   *
   * `_min: { sentAt: true }` grouped by sender, restricted to delivered statuses — `REPLIED`
   * REPLACES `SENT` rather than adding to it, so a bare `status: 'SENT'` would make a cohort's
   * soak clock RESET the moment someone answered, which is the best outcome available
   * silently un-graduating a cohort.
   */
  const firstSends = await prisma.outreachAttempt.groupBy({
    by: ['senderId'],
    where: { status: { in: [...DELIVERED_STATUSES] }, sentAt: { not: null } },
    _min: { sentAt: true },
  })
  const senderIds = await prisma.senderAccount.findMany({ select: { id: true, handle: true } })
  const handleById = new Map(senderIds.map((s) => [s.id, s.handle]))
  const firstByHandle = new Map<string, Date>()
  for (const row of firstSends) {
    const handle = handleById.get(row.senderId)
    if (handle && row._min.sentAt) firstByHandle.set(handle, row._min.sentAt)
  }

  const byCohort = new Map<number, CohortMember[]>()
  for (const s of senders) {
    const member: CohortMember = {
      handle: s.handle,
      cohort: s.cohort,
      status: s.status,
      challengedAt: s.challengedAt,
      hasSession: s.sessionPath !== null && s.sessionInvalidAt === null,
      firstDeliveredAt: firstByHandle.get(s.handle) ?? null,
    }
    byCohort.set(s.cohort, [...(byCohort.get(s.cohort) ?? []), member])
  }

  return [...byCohort.entries()]
    .sort(([a], [b]) => a - b)
    .map(([cohort, members]) => {
      const delivered = members.map((m) => m.firstDeliveredAt).filter((d): d is Date => d !== null)
      const soakStartedAt = delivered.length > 0 ? new Date(Math.min(...delivered.map((d) => d.getTime()))) : null
      return {
        cohort,
        members,
        // Can it send, not has somebody armed it — see the `live` docblock on CohortState.
        live: members.filter((m) => m.hasSession && m.status === 'ACTIVE').length,
        // Ever, not currently: a cleared checkpoint still happened.
        everChallenged: members.filter((m) => m.challengedAt !== null || m.status === 'CHALLENGED').length,
        soakStartedAt,
        soakDays: soakStartedAt === null ? 0 : (now.getTime() - soakStartedAt.getTime()) / 86_400_000,
      }
    })
}

/**
 * May this specific account send unattended right now, as far as the LADDER is concerned?
 *
 * KEEP THIS. The name reads like a dashboard helper and it is not: `gate.ts` calls it at the
 * moment of DELIVERY, which since per-account arming was removed makes it the only thing
 * standing between an un-soaked group and an unattended send. `setAccountAutopilot` in
 * actions.ts still calls it too as of this commit and is being deleted separately; when that
 * goes, this is down to one caller and is MORE load-bearing rather than less.
 */
export async function mayArmAccount(handle: string, now: Date = new Date()): Promise<LadderVerdict> {
  const [sender, states, soakDays] = await Promise.all([
    prisma.senderAccount.findUnique({ where: { handle }, select: { cohort: true } }),
    readCohortStates(now),
    cohortSoakDays(),
  ])
  if (!sender) return { ok: false, reason: 'previous-cohort-not-live', detail: `no sender @${handle}` }
  return mayArmCohort({ cohort: sender.cohort, states, soakDays, now })
}

/** The soak length, from `Setting` so it can be changed without a deployment. */
export async function cohortSoakDays(): Promise<number> {
  const row = await prisma.setting.findUnique({ where: { key: 'cohortSoakDays' } })
  const n = Number(row?.value)
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_COHORT_SOAK_DAYS
}

/** The cohort size, from `Setting`. */
export async function cohortSize(): Promise<number> {
  const row = await prisma.setting.findUnique({ where: { key: 'cohortSize' } })
  const n = Number(row?.value)
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : DEFAULT_COHORT_SIZE
}

/** Which cohort the next account added should join. */
export async function nextCohort(): Promise<number> {
  const [rows, size] = await Promise.all([
    prisma.senderAccount.groupBy({ by: ['cohort'], _count: { id: true } }),
    cohortSize(),
  ])
  return cohortForNewAccount({
    existingCounts: new Map(rows.map((r) => [r.cohort, r._count.id])),
    cohortSize: size,
  })
}
