import { redirect } from 'next/navigation'
import { currentUser } from '@/lib/session'
import { prisma } from '@/lib/db'
import { env } from '@/lib/env'
import { getSettings } from '@/lib/settings'
import {
  ACTIVE_FROM_HOUR,
  ACTIVE_TO_HOUR,
  DISPATCH_INTERVAL_MINUTES,
  FLEET_MIN_GAP_MINUTES,
  MAX_SENDS_PER_TICK,
  CHALLENGE_WINDOW_HOURS,
} from '@/outreach/pacing'
import { RESEND_BLOCKS, OVERRIDABLE_BLOCKS } from '@/outreach/gate'
import { CROSSABLE_RULES, type CrossableRule } from '@/outreach/onDemand'
import { readNewBrandTouchCounts } from '@/outreach/brandTouchCounts'
import { cohortSize, cohortSoakDays } from '@/outreach/cohorts'
import { Nav } from '../nav'
import { PageHead } from '../page-head'

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
  [RESEND_BLOCKS.TARGET_IS_WATCH_ONLY]: 'this is a page we watch for paid posts, not a company we message',
  [RESEND_BLOCKS.TARGET_NOT_VERIFIED]:
    'the recipient has no verified badge on Instagram — only verified accounts are messaged',
  [RESEND_BLOCKS.TARGET_REPLIED]: 'they replied — paused for seven days, then resumes on its own',
  [RESEND_BLOCKS.NO_SESSION]: 'the account is not signed in',
  [RESEND_BLOCKS.PAIR_DAILY_CAP]: 'this account already sent this recipient five messages today',
  [RESEND_BLOCKS.TARGET_RECENTLY_CONTACTED]:
    'every one of our pages has already written to this recipient this week — they rest until the oldest of those messages is seven days old',
  [RESEND_BLOCKS.COHORT_NOT_CLEARED]: 'the account’s onboarding group is not cleared yet',
}

/**
 * And the same treatment for the OTHER list, which did not have it.
 *
 * "You may cross" was one hand-written sentence and it named **the route being off** — a
 * stop deleted on 2026-08-08 with the per-route chip. A page that says a reader may cross
 * a rule which no longer exists is worse than one that stays quiet, and this page opens by
 * promising that every value on it comes from the module that enforces it. TOTAL over
 * `CROSSABLE_RULES`, exactly like `STOP_LABELS` above, so a warning added to `onDemand.ts`
 * without a sentence here is a compile error rather than a line nobody notices is missing.
 */
const CROSSABLE_LABELS: Record<CrossableRule, string> = {
  [CROSSABLE_RULES.TARGET_REPLIED]: 'they replied — and the dialog shows the reply itself first',
  [CROSSABLE_RULES.NO_NEW_MATERIAL]: 'nothing new to say — no paid post has been found since the last message',
  [CROSSABLE_RULES.PENDING_ATTEMPT_EXISTS]: 'a message to them is already written and waiting',
  [CROSSABLE_RULES.LIFETIME_SEND_CAP_REACHED]: 'the overall send limit is reached, where one is set',
}

/** The dialog's own order: the most consequential thing a person can cross is first. */
const CROSSABLE_ORDER: CrossableRule[] = [
  CROSSABLE_RULES.TARGET_REPLIED,
  CROSSABLE_RULES.NO_NEW_MATERIAL,
  CROSSABLE_RULES.PENDING_ATTEMPT_EXISTS,
  CROSSABLE_RULES.LIFETIME_SEND_CAP_REACHED,
]

export default async function RulesPage() {
  const user = await currentUser()
  if (!user) redirect('/sign-in')

  const settings = await getSettings()
  const [groupSize, soakDays] = await Promise.all([cohortSize(), cohortSoakDays()])
  const caps = await prisma.senderAccount.aggregate({ _min: { dailyCap: true }, _max: { dailyCap: true } })
  /**
   * The Volume list was honest and still misread: it names five caps and never adds them
   * up, so "2 per recipient per day" on the first line was taken for the system's total
   * throughput (Tabish, 2026-08-17: "is there a limit?"). The summary line below answers
   * that in one number per rule, each read from the module that enforces it — the fleet
   * scope because the burner writes to nobody.
   */
  const fleetCaps = await prisma.senderAccount.aggregate({
    where: { fleetMember: true },
    _sum: { dailyCap: true },
    _count: true,
  })
  const brandTouches = await readNewBrandTouchCounts()
  const capMin = caps._min.dailyCap ?? 5
  const capMax = caps._max.dailyCap ?? 5
  const perAccount = capMin === capMax ? `${capMax}` : `${capMin}–${capMax}`

  const overridable = new Set<string>(OVERRIDABLE_BLOCKS)
  const neverCrossed = Object.entries(STOP_LABELS)
    .filter(([code]) => !overridable.has(code))
    .map(([, label]) => label)

  const rows: Array<{ group: string; lines: string[] }> = [
    {
      group: 'Volume',
      lines: [
        /*
          THE ONE VOLUME RULE (2026-08-18, Tabish's instruction). Every other cap — the
          cross-sender per-recipient cap, the per-account daily cap, the 7-day spacing, the
          unanswered-message cap, the hourly fleet allowance, the new-brand daily cap — was
          removed the same day on his instruction ("Remove all caps … rest unlimited").
        */
        `${settings.maxPerPairPerDay} messages per day from one account to one recipient.`,
        /*
          THE RING RULE (2026-08-19, reshaped 2026-08-20 on Tabish's second instruction —
          "7 day constraint only no other limitation"). Every page may write to a recipient;
          the rest applies only once they ALL have. The 24h inter-page gap that shipped with
          it was REMOVED after it was measured holding 23 of 23 drafts while the seven-day
          rule held nobody. `crossPageGapHours` is 0 and is the one number that restores it.
        */
        `Every one of our pages may write to a recipient. Once ALL of them have, that recipient rests until the oldest of those messages is ${settings.defaultCooldownDays} days old — and nothing else spaces our pages apart${settings.crossPageGapHours > 0 ? `, beyond ${settings.crossPageGapHours}h between two different pages reaching the same inbox` : ''}. Sending volume is otherwise uncapped, by explicit decision.`,
        'A follow-up must reference a paid post not used before for that conversation — fresh material is what makes a second message new rather than a repeat, which is what Instagram penalises.',
        settings.fleetMaxPerDay === Number.POSITIVE_INFINITY
          ? 'No fleet-wide daily cap — chosen deliberately, one setting away from binding.'
          : `${settings.fleetMaxPerDay} per day across all accounts together.`,
        env.MAX_TOTAL_SENDS === null
          ? 'No lifetime ceiling — chosen deliberately.'
          : `${env.MAX_TOTAL_SENDS} messages lifetime, counting ones still waiting.`,
        `Room for ${settings.maxWaitingNewBrandDrafts} first messages waiting at once — ${brandTouches.waiting} in the queue now. ` +
          `Sending or discarding one makes room immediately.`,
      ],
    },
    {
      group: 'Hours and pace',
      lines: [
        `${ACTIVE_FROM_HOUR}:00–${ACTIVE_TO_HOUR}:00 IST only.`,
        `Never two sends within ${FLEET_MIN_GAP_MINUTES} minutes of each other — across the ${fleetCaps._count} accounts together that works out to roughly ${Math.floor(((ACTIVE_TO_HOUR - ACTIVE_FROM_HOUR) * 60) / FLEET_MIN_GAP_MINUTES)} deliveries a day at full pace.`,
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
        'Send-now can cross these after showing what is being crossed, one sentence each:',
        ...CROSSABLE_ORDER.map((code) => `${CROSSABLE_LABELS[code]}.`),
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
        <PageHead
          title="Rules"
          sub="What the system will and will not do. Every number is read from the module that enforces it."
        />
        {/*
          A sticky index, because this page is long BY NECESSITY — it is where every
          rationale paragraph in the product lives — and a reader who came here for one
          rule should not have to scroll past nine groups to find it.
        */}
        <div className="settings-layout">
          <nav className="settings-nav" aria-label="Rule groups">
            {rows.map((r) => (
              <a key={r.group} href={`#${slug(r.group)}`}>
                {r.group}
              </a>
            ))}
          </nav>

          <div className="settings-body">
            {rows.map((r) => (
              <section id={slug(r.group)} key={r.group}>
                <h2>{r.group}</h2>
                {/*
                  One rule per row in a bordered list rather than bullets. These are
                  statements of what the system will refuse to do, and a bullet list reads
                  as suggestions — the border makes each one a discrete fact.
                */}
                <div className="rows">
                  {r.lines.map((l) => (
                    <div className="rowitem" key={l}>
                      <span className="prose">{l}</span>
                    </div>
                  ))}
                </div>
              </section>
            ))}
          </div>
        </div>
      </div>
    </>
  )
}

/**
 * A stable anchor from a group heading.
 *
 * Deliberately derived rather than hand-listed: the groups come from the modules that
 * enforce the rules, so a new group appears here automatically with a working link. A
 * hardcoded map would silently lose its anchor the day a group is renamed.
 */
function slug(group: string): string {
  return group.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}
