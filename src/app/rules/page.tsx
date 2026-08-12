import { redirect } from 'next/navigation'
import { currentUser } from '@/lib/session'
import { prisma } from '@/lib/db'
import { env } from '@/lib/env'
import { getSettings } from '@/lib/settings'
import {
  ACTIVE_FROM_HOUR,
  ACTIVE_TO_HOUR,
  DISPATCH_INTERVAL_MINUTES,
  FLEET_MAX_PER_HOUR,
  FLEET_MIN_GAP_MINUTES,
  MAX_SENDS_PER_TICK,
  CHALLENGE_WINDOW_HOURS,
} from '@/outreach/pacing'
import { RESEND_BLOCKS, OVERRIDABLE_BLOCKS } from '@/outreach/gate'
import { cohortSize, cohortSoakDays } from '@/outreach/cohorts'
import { Nav } from '../nav'

export const dynamic = 'force-dynamic'

/**
 * `/rules` — what the system will and will not do, one line per rule.
 *
 * This page is WHY the other pages are short. Every operational screen used to carry the
 * rationale beside its buttons — pacing, the four switches, why UNCLASSIFIED is not
 * organic — and ~18,700 words of it is what made the dashboard "dumped with confusing
 * information" (Tabish, 2026-08-06, third time). A refusal stays where it refuses; the
 * REASONING lives here.
 *
 * The numbers are IMPORTED from the modules that enforce them — `pacing.ts`, `env`,
 * `Setting` rows, `gate.ts` — never retyped, because a limit reported by a different rule
 * than the one enforcing it is worse than no limit shown (`MAX_TOTAL_SENDS` was measured
 * two different ways for two days and the dashboard rendered headroom that did not exist).
 */

/**
 * Plain words for every stop in the gate, TOTAL over RESEND_BLOCKS like
 * `messages/remedy.ts` — a stop added later without a sentence here is a compile error,
 * never a silently missing line.
 */
const STOP_LABELS: Record<(typeof RESEND_BLOCKS)[keyof typeof RESEND_BLOCKS], string> = {
  [RESEND_BLOCKS.NOT_WAITING]: 'the message is not waiting any more (already sent, or being sent)',
  [RESEND_BLOCKS.SENDER_NOT_ACTIVE]: 'Instagram flagged the account',
  [RESEND_BLOCKS.TARGET_OPTED_OUT]: 'the recipient is retired — never contacted again',
  [RESEND_BLOCKS.TARGET_REPLIED]: 'they replied — paused for a day, then resumes',
  [RESEND_BLOCKS.NO_SESSION]: 'the account is not signed in',
  [RESEND_BLOCKS.TARGET_DAILY_CAP]: 'the recipient reached today’s cap',
  [RESEND_BLOCKS.SENDER_DAILY_CAP]: 'the account reached today’s cap',
  [RESEND_BLOCKS.PERSONA_NOT_DISTINCT]: 'the account shares its identity with another account',
  [RESEND_BLOCKS.COHORT_NOT_CLEARED]: 'the account’s onboarding group is not cleared yet',
  [RESEND_BLOCKS.PERSONA_CHANGED_SINCE_DRAFT]: 'the account’s identity changed after the message was written',
}

export default async function RulesPage() {
  const user = await currentUser()
  if (!user) redirect('/sign-in')

  const settings = await getSettings()
  const [groupSize, soakDays] = await Promise.all([cohortSize(), cohortSoakDays()])
  const caps = await prisma.senderAccount.aggregate({ _min: { dailyCap: true }, _max: { dailyCap: true } })
  const capMin = caps._min.dailyCap ?? 5
  const capMax = caps._max.dailyCap ?? 5
  const perAccount = capMin === capMax ? `${capMax}` : `${capMin}–${capMax}`

  const overridable = new Set<string>(OVERRIDABLE_BLOCKS)
  const neverCrossed = Object.entries(STOP_LABELS)
    .filter(([code]) => !overridable.has(code))
    .map(([, label]) => label)

  const rows: Array<{ group: string; lines: string[] }> = [
    {
      group: 'Spacing',
      lines: [
        `${env.DEFAULT_COOLDOWN_DAYS} days between messages to the same recipient from the same account.`,
        'A follow-up must reference a paid post not used before for that conversation — fresh material is what makes a second message new rather than a repeat, which is what Instagram penalises.',
        'At most 3 unanswered messages to one recipient, ever.',
      ],
    },
    {
      group: 'Volume',
      lines: [
        `${settings.maxPerTargetPerDay} per recipient per day, whoever sends.`,
        `${perAccount} per account per day.`,
        `${FLEET_MAX_PER_HOUR} per hour across all accounts together.`,
        settings.fleetMaxPerDay === Number.POSITIVE_INFINITY
          ? 'No fleet-wide daily cap — chosen deliberately, one setting away from binding.'
          : `${settings.fleetMaxPerDay} per day across all accounts together.`,
        env.MAX_TOTAL_SENDS === null
          ? 'No lifetime ceiling — chosen deliberately.'
          : `${env.MAX_TOTAL_SENDS} messages lifetime, counting ones still waiting.`,
      ],
    },
    {
      group: 'Hours and pace',
      lines: [
        `${ACTIVE_FROM_HOUR}:00–${ACTIVE_TO_HOUR}:00 IST only.`,
        `At most ${MAX_SENDS_PER_TICK} message every ${DISPATCH_INTERVAL_MINUTES} minutes, and never two sends within ${FLEET_MIN_GAP_MINUTES} minutes of each other.`,
        'Nothing is refused by pacing — a held message keeps its Send button and waits its turn.',
      ],
    },
    {
      group: 'Replies',
      lines: [
        'A reply halts every account writing to that recipient until a person takes over.',
        'Before a follow-up is sent, its own conversation is read; a thread that cannot be read fully holds the send.',
        'A reply is the outcome we want — it is never treated as “do not contact”.',
      ],
    },
    {
      group: 'Accounts',
      lines: [
        `An Instagram checkpoint on any one account pauses the whole fleet for ${CHALLENGE_WINDOW_HOURS} hours — every account sends the same way from the same connection, so a flag on one is a warning about all.`,
        /**
         * ONE SWITCH, 2026-08-08: "before the next may be ARMED" named the per-account toggle,
         * which is gone. The LADDER is not gone — `gate.ts` asks `mayArmAccount` at the moment
         * of delivery — so this line must still state the rule, in terms of what now happens:
         * the next group starts sending by itself, with nobody switching anything on.
         */
        `New accounts join a group of ${groupSize}; each group sends for ${soakDays} days before the next group starts sending.`,
        'Each account sends from its own Chrome profile, signed in once by hand. No passwords are stored anywhere.',
        'A message accepted by Instagram that never appears in the conversation is parked for a person to check — never re-sent automatically.',
      ],
    },
    {
      group: 'Watching',
      lines: [
        'Reading channels never uses a login, so detection can never put an account at risk.',
        'Posts from before 1 August 2026 are stored but not judged or pitched.',
        'A post nobody judged is “not judged” — that has never meant “ordinary”.',
      ],
    },
    {
      group: 'You may cross, with a reason shown',
      lines: [
        'Send-now can cross timing rules after showing what is being crossed: spacing, nothing new to say, a draft already waiting, the unanswered-message cap, the route being off — and “they replied”, which shows the reply itself first.',
      ],
    },
    {
      group: 'Never crossed, by anyone',
      lines: neverCrossed.map((l) => `${l.charAt(0).toUpperCase()}${l.slice(1)}.`),
    },
  ]

  return (
    <>
      <Nav current="/rules" email={user.email} />
      <div className="page">
        <header className="page-head">
          <h1>Rules</h1>
          <p className="page-sub">What the system will and will not do. The numbers come from the code that enforces them.</p>
        </header>
        {rows.map((r) => (
          <section className="group" key={r.group}>
            <h2>{r.group}</h2>
            <ul className="plain-list">
              {r.lines.map((l) => (
                <li key={l}>{l}</li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </>
  )
}
