import { prisma } from '@/lib/db'
import { memoView, viewKey, invalidateViews } from '@/lib/viewMemo'
import { env } from '@/lib/env'
import { ACTIVE_FROM_HOUR, ACTIVE_TO_HOUR } from '@/outreach/pacing'
import { readStringArray } from '@/lib/json'
import {
  istDayStart,
  istDateKey,
  daysAgo,
  istStamp,
  istPostedLabel,
  latenessLabel,
  relativeLabel as relative,
} from '@/lib/time'
/**
 * `operatorName` — never a raw `displayName`.
 *
 * `displayName` is an internal label. The live values include "Bollywood Chronicle (test
 * target)", "Burner (test target)" and "Tabish (trial)", and every one of them reached the
 * screen: the headline read "Burner (test target) replied" and an account row offered
 * "Send from Tabish (trial)". `tests/labels.test.ts` fails if a raw one comes back.
 */
import { validatePersona, prettifyBrand, operatorName } from '@/outreach/render'
import { FOLLOWER_SNAPSHOT, DELIVERED_STATUSES, IN_FLIGHT_STATUSES } from '@/lib/constants'
// Host-aware "is this account signed in" — DB record on the hosted dashboard, disk on a
// sending machine. Never read profileStatus directly for a page: the Linode has no profiles.
import { sessionIsUsable } from './view-model/session-view'
import { postUrl } from '@/lib/urls'
import { isConnecting } from '@/outreach/browser/connect'
import { getSettings } from '@/lib/settings'
import { visibleChannelFilter, ourOwnPageHandles } from '@/detection/visibleChannels'
import { detectionCutoff } from '@/lib/cutoff'
import { readLabelledSet } from '@/detection/labels'
import { replyHaltFloor } from '@/outreach/replyHalt'
import { mentionsHandleExactly, brandStringsNameProspect } from '@/outreach/materialAllowance'
// A publisher's own watermark/series code is not a third party — see ownMarks.ts.
import { stripOwnMarksFromBrands } from '@/detection/ownMarks'
import { readHeartbeat, readPassHealth, machineId } from '@/worker/scheduler'
import { assessWatch, watchHealthSentence } from '@/detection/watchHealth'
import { getDetector } from '@/detection/detectors'
/**
 * The SAME function the planner's guard calls, deliberately. A page that computed
 * "personas are shared" its own way could disagree with the rule actually blocking the
 * send — and `MAX_TOTAL_SENDS` was measured two different ways for two days, rendering
 * headroom that did not exist.
 */

/**
 * Everything the CEO page shows, assembled in one place.
 *
 * The page itself does no querying and no interpretation — it renders sentences
 * this file produces. Keeping the judgement here (what counts as "healthy", how
 * an event reads in English) means the view stays a view, and the wording can be
 * changed without touching layout.
 */

export type Health = 'healthy' | 'attention' | 'broken'

export interface CeoView {
  health: Health
  /** Last check, phrased so it cannot be mistaken for the 7-day totals below. */
  lastCheckLabel: string
  /** One plain sentence. Never a stack trace, never a status code. */
  headline: string
  nextSlotLabel: string
  nowLabel: string

  replies: ReplyCard[]
  week: { detected: number; sent: number; replies: number; checked: number }
  activity: ActivityDay[]
  channels: ChannelCard[]
  accounts: AccountCard[]
  brands: BrandsPanel

  /**
   * Messages written and ready to send.
   *
   * A COUNT since step C, not cards. The full tray — every body, the Send button, the refusal
   * reason — is on `/messages`, and `/` rendered a second copy of it with no reason attached.
   * `src/app/awaiting.tsx` was that second copy and is deleted: it also still told operators to
   * "press Connect under Your accounts", a section that no longer exists.
   */
  awaitingCount: number

  autopilot: AutopilotState

  /**
   * Detection health, stated rather than implied.
   *
   * `week.detected` counts only what a detector actually judged. On a channel whose
   * classifier is unconfigured that number is 0 — and a bare 0 reads as "they run no
   * paid campaigns", which is false and is the reason this field exists. The screen
   * has to be able to say "not looked at" in words.
   */
  detection: DetectionHealth
}

export interface DetectionHealth {
  /** Channels whose posts are stored but never judged, with the reason. */
  unclassifiedChannels: { name: string; handle: string; reason: string }[]
  /** Checks in the last two days that could not read every channel. */
  degradedRuns: number
  /** True when at least one channel is genuinely being classified. */
  anyClassifying: boolean
}

export interface RouteToggle {
  targetHandle: string
  targetName: string
  enabled: boolean
  /** Target is marked never-contact; the route cannot be turned on. */
  targetRetired: boolean
}

export interface SchedulerState {
  /** A scheduler process has beaten within the last few minutes. */
  running: boolean
  /** 'dashboard' (embedded) or 'worker' (separate process). */
  host: string | null
  /**
   * ── WHICH MACHINE IS BEATING, AND WHY `host` ALONE CANNOT SAY ──────────────────────
   *
   * `host` distinguishes *embedded in a dashboard* from *a separate worker*. It was the
   * whole answer while one machine ran everything. Since hosting (2026-08-08) the watch
   * runs on the LINODE and the dashboard is also served from there, so the beat reads
   * `host: 'dashboard'` — and a second dashboard opened on a Mac read that and rendered
   * *"watch running INSIDE THIS DASHBOARD"*. MEASURED 2026-08-13: the live beat is
   * `{"host":"dashboard","machine":"linode-detect"}` while the Mac dashboard, which
   * correctly declined to schedule anything, told its reader the watch was inside it.
   *
   * That is not cosmetic. CLAUDE.md opens on a 20-hour outage nobody noticed, and the
   * reader of this sentence is deciding whether closing this window stops the watch. The
   * answer is machine-dependent and only `machine` carries it, so it is carried here.
   *
   * `null` for a heartbeat written before the field existed — treated as "not this one",
   * the same conservative direction `startScheduler` already takes.
   */
  machine: string | null
  /** Is the beating process on the machine rendering this page? */
  here: boolean
  lastBeatLabel: string | null
}

export interface AutopilotState {
  /** The dashboard toggle. Sending happens by itself when this and an armed account line up. */
  on: boolean
  /**
   * The pacing clause of the ON sentence, derived from the SAME constants the dispatcher
   * enforces. The client component hardcoded "only between 10:00 and 21:00 IST" for a
   * window Tabish removed on 19 Aug — a screen asserting a rule the enforcer does not
   * hold, this file's most-recorded failure — and a client component may not import
   * pacing.ts itself (the waiting.tsx → gate.ts → better-sqlite3 trap), so the truth
   * travels as data.
   */
  paceClause: string
  /**
   * AUTOPILOT_ENABLED in .env. A hard floor — with this false the toggle cannot be
   * switched on at all, so a compromised or misclicked dashboard cannot start
   * unattended sending on a deployment that never opted in.
   */
  allowedByEnv: boolean
  /**
   * Is anything actually going to fire at the slot times?
   *
   * Kept beside the toggle deliberately. "Autopilot is ON" with no scheduler running
   * is a claim the system cannot honour, and that combination existed for a whole day
   * without the page mentioning it.
   */
  scheduler: SchedulerState
  /** "Next check at 15:00" — answers "when will this actually send?" on screen. */
  nextSlotLabel: string
  /** Accounts that are armed AND have a logged-in Chrome profile. */
  readyHandles: string[]
  /** Armed, but no hand login yet — the toggle will not help these. */
  needLoginHandles: string[]
}

export interface ReplyCard {
  /** Stable React key. It no longer carries a control — see `replies.tsx`. */
  attemptId: string
  targetName: string
  targetHandle: string
  senderName: string
  whenLabel: string
  /**
   * When the halt on this recipient releases, in IST — "frees 31 Aug 2026, 12:49".
   *
   * REQUIRED SINCE THE BUTTONS WENT (2026-08-25). `whenLabel` is the OBSERVATION clock
   * (`repliedAt`, when the sweep found the reply); the seven days are counted from
   * `replyPostedAt` (when they WROTE it). Measured on the live corpus those two differ by
   * up to 24 hours, so an age is not a release date — and with no control left on the
   * card, the release date is the only thing worth saying.
   */
  freesLabel: string
  /** The sending page's handle — "who wrote to them" is half of what makes the row actionable. */
  senderHandle: string
  /**
   * A direct link to THAT conversation, not to the inbox. Every one of the 75 stored replies
   * carries a `threadUrl` (measured 2026-08-25), which is what makes this worth rendering
   * rather than a generic "open Instagram".
   */
  threadUrl: string | null
  /**
   * What they actually said, from `replyText`.
   *
   * This used to read `attempt.error` — a column for send failures — because no field
   * for reply content existed. A message that failed and was later marked replied
   * would have rendered its own error string as the recipient's words.
   */
  preview: string | null
}

export interface ActivityEvent {
  timeLabel: string
  sentence: string
  kind: 'sent' | 'reply' | 'detected'
}

export interface ActivityDay {
  dayLabel: string
  events: ActivityEvent[]
  /**
   * HOW MANY WENT OUT THAT DAY, against how many this feed is showing.
   *
   * ── A CAPPED FEED WHOSE OLDEST ROW READS AS THE DAY'S FIRST EVENT ─────────
   *
   * MEASURED 2026-08-21. The fleet ran all night at ~30/hour — 280 delivered, first at
   * **00:01:43 IST** — and Tabish read the feed and asked why the first message of the day
   * was at **07:51**. It was not: `recentSends` is `take: 40`, and 07:51:32 is exactly the
   * 40th-newest send. The feed was showing the newest forty of two hundred and eighty and
   * saying nothing about it, so its bottom row became a start time.
   *
   * Every figure was correct — the counter said 280 — and the page still supported a false
   * conclusion, which is the same shape as the `take: 50` `sentToday` fixed the day before:
   * a bounded list read as a complete record. There the cap corrupted a number; here it
   * corrupts an INFERENCE, which no assertion about a number could have caught.
   *
   * So a day in this feed states its own total. `shown < total` renders the sentence that
   * makes the truncation impossible to misread.
   */
  shown: number
  total: number
}

export interface ChannelCard {
  name: string
  handle: string
  followers: string
  campaignsThisWeek: number
  postsThisWeek: number
  postsLogged: number
  lastContactedLabel: string
  halted: boolean
  /**
   * True when this channel's posts are deliberately NOT classified.
   *
   * This matters more than it looks. @viralbhayani never discloses paid posts, so
   * our verdict count for them is 0 — and showing a bare "0 paid campaigns" would
   * tell a reader they do no paid work, which is the opposite of the truth
   * (roughly half their output is commercial). The card says "not classified"
   * instead of a number that would actively mislead.
   */
  unclassified: boolean
  /**
   * WHY it is not classified, from the detector itself.
   *
   * Was a single hardcoded sentence on the card ("this channel never labels its paid
   * posts"), which is true of a passthrough channel and false of one whose classifier
   * merely lacks an API key. Two different problems with two different fixes must not
   * render as the same sentence.
   */
  unclassifiedReason: string | null
  /** Retired: kept for its history, never contacted again. */
  retired: boolean
  /** Has this channel ever been sent a message? Governs delete vs retire. */
  everContacted: boolean
}

export interface AccountCard {
  handle: string
  name: string
  /**
   * Raw SenderAccount.status. Needed because clearing a CHALLENGED halt is now an
   * explicit operator act with its own control, so the UI has to know the difference
   * between "broken because Instagram flagged it" and "broken because details are
   * invalid" — `state` collapses both to 'broken'.
   */
  status: string
  /** A hand login has happened, so this account CAN send unattended. */
  canSendAutomatically: boolean
  /** A Chrome window is open right now waiting for this account to be logged in. */
  connecting: boolean
  /** Which channels this account is allowed to message. */
  routes: RouteToggle[]
  sentThisWeek: number
  /**
   * ready  — logged in and healthy: sends by itself while Autopilot is on
   * setup  — nothing wrong, but a sign-in is outstanding
   * broken — needs a human: locked by Instagram, or invalid details
   *
   * Three states rather than two because green beside "not logged in yet" reads
   * as healthy at a glance, which is precisely what a status light must not do.
   *
   * ONE SWITCH, 2026-08-08: `ready` no longer means "armed", and `setup` no longer
   * has "autopilot off" as one of its causes — there is no per-account switch to be off.
   */
  state: 'ready' | 'setup' | 'broken'
  note: string

}

/**
 * Companies discovered inside paid posts — the other half of the scope Tabish set on
 * 2026-08-03: *"Message channels that posted and the brands (their instagram channels)."*
 *
 * They are `kind: 'BRAND'` and the channels panel filters `kind: 'CHANNEL'`, so before
 * this they existed in the database and appeared nowhere on screen.
 */
export interface BrandCard {
  handle: string
  name: string
  /** Instagram's own category — "Grocery & Convenience Stores". Display only. */
  category: string | null
  /** The publisher whose paid post surfaced this company, in prose. */
  discoveredOn: string | null
  /** Is any route to this brand switched on? Discovery never enables one. */
  enabled: boolean
  /** Messages delivered to this brand so far. */
  sent: number
  retired: boolean
}

/**
 * A handle the MODEL decided about, and what it decided — a record, not a queue.
 *
 * ── WHAT THIS REPLACED, AND WHY THE OLD REASONING WAS RIGHT ────────────────
 *
 * `UnresolvedBrandCard` carried FACTS for a human to judge, and it was correct to. Meta deleted
 * the schema behind `ig_business_category_subvertical`, so Instagram's category endpoint returns
 * HTTP 400 for accounts that HAVE a business category — precisely the accounts most likely to be
 * brands. 18 of 19 turned out to be live professional accounts, @tilara.india and @netflix_in
 * among them. And no verdict could be read off what remained: measured 2026-08-03, the readable
 * fields are IDENTICAL for @tilara.india (a brand) and @adityathackeray (a politician).
 *
 * That argument bounded what could be done with THOSE FIELDS. It was never an argument that the
 * question is unanswerable — and the missing piece was an INPUT, the paid post the handle
 * appeared in, which the endpoint never had. Same shape as the caption-vs-footage finding: a
 * classifier reading the only thing it is given, and the evidence sitting somewhere else.
 *
 * Tabish, on finding @adidas in that queue: *"How can adidas not be recognized as anything? I do
 * not want this option to select manually, correct it."*
 *
 * So the queue is answered before anyone sees it, and this reports what happened. The reason is
 * carried because an automatic decision nobody can inspect is worse than a manual one: a prospect
 * created by a model months ago still has to be explicable today.
 */
export interface AutoDecidedBrandCard {
  handle: string
  /** 'company' — added as a prospect; 'left-alone' — the model was not confident. */
  outcome: 'company' | 'left-alone'
  /** One line, in prose. The only part of this that reaches a screen. */
  reason: string | null
  /**
   * 0-100, and deliberately NOT rendered: "no confidence scores on the dashboard" is a
   * standing rule here, because a number invites an operator to second-guess a threshold
   * rather than read the sentence. Carried so the panel can start showing it if that is ever
   * asked for, and so a reader of this type is not left wondering where it went.
   */
  confidence: number | null
}

/**
 * How many brand cards the panel shows.
 *
 * Bounded because the list is CONTEXT — "which companies have we found" — and not an
 * inventory. Unbounded, it was 145 of the page's 174 queries and grew with every discovery;
 * at 500 brands the page was a minute. Prisma Studio is where the whole table lives.
 */
export const BRAND_CARDS_SHOWN = 40

export interface BrandsPanel {
  confirmed: BrandCard[]
  /**
   * How many BRAND rows exist in total.
   *
   * Shown next to the list, the way the posts table says "showing the newest 100 of 223". A
   * truncated list with no total reads as the whole set, which is the silent degradation this
   * bound would otherwise introduce while fixing the slow one.
   */
  confirmedTotal: number
  /**
   * What the model decided about handles Instagram could not classify, newest first.
   *
   * A RECORD, not a queue: nothing here is waiting on anybody. It replaced `undecided`, which
   * was a work list with two buttons on every row (one switch, 2026-08-08).
   */
  autoDecided: AutoDecidedBrandCard[]
  /** How many new brands may be contacted for the first time today. */
  newTouchCap: number
  /** How many of that allowance is already used. */
  newTouchesUsedToday: number
}


/**
 * ── STEP C OF THE REDESIGN: `/` WAS SIX JOBS, AND IS NOW THREE PAGES ────────
 *
 * `buildCeoView` still assembles everything, and the three builders below hand each page its
 * slice. That is deliberately NOT three independent query sets.
 *
 * The risk in this redesign is stated in the plan's §0: *every refusal in this system is a
 * sentence on a screen, and a redesign that loses a warning is worse than a dull dashboard.*
 * Three separate assemblies would be three places for a reason to be dropped, and two of them
 * would drift — which has already happened twice in this codebase, once when `view-model.ts`
 * counted `MAX_TOTAL_SENDS` differently from `plan.ts` (two silent days), and once when
 * `deliverWaiting` checked eight conditions and `sendNow` checked three.
 *
 * So there is ONE assembly and three projections. The cost is that each page runs the other
 * pages' queries — measured at ~200 ms on the live database, against a `force-dynamic` page on
 * localhost. If that ever matters, split the QUERIES and keep one definition of each SENTENCE.
 */
/**
 * One sentence about whether a channel's judging has ever been checked.
 *
 * Deliberately does NOT quote a percentage. The harness reports per-channel figures and
 * they move between identical runs (recall on M.O.M measures 95-100% over three); putting a
 * single sample on a page a CEO reads would be the over-precision this whole file argues
 * against. What a reader needs here is whether the number exists at all.
 */
function accuracyNoteFor(labels: number, stored: number): string {
  if (labels === 0) {
    return 'Never checked for accuracy — no post here has a known right answer, so how well it is judged is unknown.'
  }
  const share = stored > 0 ? Math.round((labels / stored) * 100) : 0
  if (share >= 50) return `Accuracy is checked against ${labels} posts here, which is most of them.`
  return `Accuracy is checked against only ${labels} of ${stored} posts here, so the figure is thin.`
}

/**
 * ── ONE COMPUTATION SERVES EVERY PAGE FOR TEN SECONDS (2026-09-02) ────────────
 *
 * `buildCeoView` is 55 queries plus heavy JS and is recomputed by `/`, `/targets`,
 * `/paid-posts` and `/analytics` on every request. On the Linode's single vCPU that is
 * 5.3s cold / 2.0s warm PER PAGE (measured on the server, load 0.4 — the DB answered in
 * milliseconds; the time is Prisma hydration and JS). A sidebar click therefore took 4-6
 * seconds, which Tabish reported as "very slow to open that section".
 *
 * So the result is shared across requests for a short window. Ten seconds is well inside
 * the staleness the pages already accept: `auto-refresh.tsx` re-renders every 30-45s. A
 * plain in-memory memo, NOT `unstable_cache`, because it keeps the Date objects the labels
 * are built from (a serialising cache would hand them back as strings). One in-flight
 * promise is shared, so a burst of tabs computes once. The autopilot toggle invalidates it
 * explicitly, so ON/OFF never reads ten seconds stale. Off under vitest: tests mutate the
 * database and rebuild the view in the same second.
 *
 * THE MECHANISM MOVED TO `src/lib/viewMemo.ts` ON 2026-09-04, when two OOM kills of the web
 * process (773 MB and 607 MB anon-rss against a +22..32 MB per-render peak) showed that the
 * PILE-UP of concurrent renders, not any one render, was what ate the heap. Every page
 * builder shares that one memo and its two-at-a-time admission control now; this file keeps
 * the reasoning and the key, and nothing else about caching.
 */
export function invalidateCeoView(): void {
  /* Kept under its old name for callers that know only this view; it now drops every view. */
  invalidateViews()
}

export async function buildCeoView(): Promise<CeoView> {
  return memoView(viewKey('ceoView'), computeCeoView)
}

async function computeCeoView(): Promise<CeoView> {
  const dayStart = istDayStart()
  const weekStart = daysAgo(7)
  const settings = await getSettings()

  const [senders, targets, lastRun, weekSent, weekReplies, weekChecked, recentSends, unreadReplies, awaitingRaw] =
    await Promise.all([
      prisma.senderAccount.findMany({
        orderBy: { handle: 'asc' },
        include: { pairs: { include: { target: true } } },
      }),
      /**
       * CHANNEL CARDS — and `role: 'WATCH'` with our own pages excluded, not bare `kind`.
       *
       * This read every CHANNEL row with no filter at all, so @bollywoodsocietyy and
       * @bollywoodchronicle rendered as watched-channel cards on `/` and `/paid-posts`,
       * each stating a post count and an accuracy note about a page we own. `nav.tsx` was
       * the only place that filtered, which is the one-rule-several-callers shape again.
       */
      prisma.targetAccount.findMany({
        where: { role: 'WATCH', handle: { notIn: [...ourOwnPageHandles()] } },
        include: { pairs: { include: { sender: true } } },
        orderBy: { handle: 'asc' },
      }),
      prisma.scrapeRun.findFirst({ orderBy: { startedAt: 'desc' } }),
      // DELIVERED_STATUSES, not 'SENT': a replied-to message is still a message we sent.
      prisma.outreachAttempt.count({
        where: { status: { in: [...DELIVERED_STATUSES] }, sentAt: { gte: weekStart } },
      }),
      prisma.outreachAttempt.count({ where: { repliedAt: { gte: weekStart } } }),
      /**
       * How many of the week's delivered messages have had their conversation READ at
       * all. A reply rate over messages nobody looked at is not a rate — with coverage
       * at 10% it understated reality tenfold, which is what Tabish reported on
       * 2026-08-21 ("the number of replies and reply rate is wrong substantially").
       * The rate's denominator is this count, and the page says so.
       */
      prisma.outreachAttempt.count({
        where: {
          status: { in: [...DELIVERED_STATUSES] },
          sentAt: { gte: weekStart },
          OR: [{ replyCheckedAt: { not: null } }, { repliedAt: { not: null } }],
        },
      }),
      prisma.outreachAttempt.findMany({
        where: { sentAt: { gte: daysAgo(14) } },
        include: { pair: { include: { sender: true, target: true } }, campaign: true },
        orderBy: { sentAt: { sort: 'desc', nulls: 'last' } },
        take: 40,
      }),
      /**
       * Replies still needing a human. `replyHandledAt: null` is the whole point.
       *
       * This previously had NO filter of any kind, so once anyone replied the card
       * and its to-do sat on the dashboard permanently — there was no "handled"
       * state and no control to dismiss it. A notification that can never be cleared
       * stops being read, which defeats the one event here that represents revenue.
       */
      prisma.outreachAttempt.findMany({
        // Only ACTIVE halts — replies inside the one-day resume window (Tabish,
        // 2026-08-07). Older ones released themselves and left the card with them.
        where: { replyPostedAt: { gte: replyHaltFloor(settings.replyResumeHours) }, replyHandledAt: null },
        include: { pair: { include: { sender: true, target: true } } },
        orderBy: { repliedAt: 'desc' },
      }),
      prisma.outreachAttempt.findMany({
        // SENDING is included so a send interrupted by a crash stays visible rather
        // than vanishing from the tray with no way to reach it.
        where: { status: { in: ['READY', 'QUEUED', 'SENDING'] } },
        include: { pair: { include: { sender: true, target: true } } },
        orderBy: { queuedAt: 'asc' },
      }),
    ])

  const weekDetected = await prisma.detectedCampaign.count({
    // Scoped like every other figure a person reads — see visibleChannels.ts.
    where: { verdict: 'CAMPAIGN', detectedAt: { gte: weekStart }, ...(await visibleChannelFilter()) },
  })

  /**
   * Every reply in the feed's window, handled or not.
   *
   * Separate from `unreadReplies` on purpose. That query is filtered `replyHandledAt: null`
   * because it drives what needs a person; this one drives HISTORY, and history must not change
   * when someone ticks a box. Same window as `recentSends` so the two halves of the feed cover
   * the same period — a reply from three weeks ago appearing above sends from three days ago is
   * the kind of thing that makes a feed unreadable.
   */
  const repliesInWindow = await prisma.outreachAttempt.findMany({
    where: { repliedAt: { gte: daysAgo(14) } },
    include: { pair: { include: { sender: true, target: true } } },
    orderBy: { repliedAt: 'desc' },
  })

  // ── Health ────────────────────────────────────────────────────────────────
  /**
   * ONE read, serving both the health ladder below and the autopilot card further down.
   * Two reads would be two answers to "is the watch alive" a few milliseconds apart, and
   * a page contradicting itself about that is exactly what this alarm is for.
   */
  const heartbeat = await readHeartbeat()
  const challenged = senders.filter((s) => s.status === 'CHALLENGED')
  const paused = senders.filter((s) => s.status === 'PAUSED')
  const personaBroken = senders.filter((s) => validatePersona(s).length > 0)

  /**
   * IS THE WATCH RUNNING — asked of the HEARTBEAT, not of `ScrapeRun`.
   *
   * This was `!lastRun || startedAt older than 26 hours`, and that check could no longer
   * fire in time. Detection moved to its OWN 15-minute clock on 2026-08-07 and writes no
   * `ScrapeRun` row — those rows are written by the four send SLOTS. So the alarm was
   * watching a table detection had stopped touching, with a threshold sized for a
   * four-times-a-day cadence. MEASURED on 2026-08-08: the watch was dead 20 hours, ~108
   * posts were missed, 9 of them paid, and this branch had not fired — a slot was not yet
   * 26 hours late.
   *
   * Two clocks write to two tables, so "is detection running?" had two answers and the
   * alarm read the wrong one. The heartbeat is the right witness: it is written every 60s
   * by whichever process holds the schedule, and it is what `readHeartbeat` already
   * exposes for the autopilot card.
   *
   * The threshold is no longer a chosen number either. `assessWatch` derives it from the
   * measured feed depth and the busiest channel's measured posting rate, because the
   * deadline is a property of how fast the feed window turns over — about 18 hours — not
   * of anyone's preference.
   */
  const watch = assessWatch({
    lastBeatAt: heartbeat ? new Date(heartbeat.beat.at) : null,
    fresh: heartbeat?.fresh ?? false,
    now: new Date(),
  })

  /**
   * A HEARTBEAT IS NOT PROOF THE WORK SUCCEEDED (2026-08-22). The Linode ran out of
   * Postgres connections and every 15-minute pass threw at the top level for 1h45m —
   * while the heartbeat stayed seconds fresh, so `assessWatch` above saw nothing and the
   * planner silently wrote no draft for 158 minutes. Each pass stamps its own last
   * success now; a fresh heartbeat beside a stale stamp is the signature this rung
   * exists to catch. Absent stamps (a deployment's first minutes) never alarm.
   */
  const passes = await readPassHealth()

  /**
   * The ceiling must be counted the way the PLANNER counts it, or the page reports
   * a limit that is not the one being enforced.
   *
   * This read `['SENT','REPLIED']` while `plan.ts` reads IN_FLIGHT_STATUSES, so with
   * MAX_TOTAL_SENDS=6 and 2 sent + 1 replied + 3 drafted, the planner saw 6/6 and
   * refused to prepare anything while the page saw 3/6 and rendered no blocker at
   * all. Measured 2026-08-03, after two days in which the agent correctly drafted
   * nothing and the dashboard offered no reason why.
   */
  const totalInFlight = await prisma.outreachAttempt.count({
    where: { status: { in: [...IN_FLIGHT_STATUSES] } },
  })
  const ceilingReached = env.MAX_TOTAL_SENDS !== null && totalInFlight >= env.MAX_TOTAL_SENDS

  /**
   * ONE sentence, and nowhere to put a shell command.
   *
   * This replaced a "Needs you" list that read, verbatim:
   *     Send the next one: pnpm send
   *     Raise the send limit when ready (MAX_TOTAL_SENDS in .env)
   *     Check which channels are failing: pnpm ig:audit
   * on a page whose stated audience is a CEO. Every one of those was a developer
   * instruction for something the page could simply DO, and a to-do list that cannot
   * be ticked off is a nag, not information.
   *
   * So each condition now renders where it belongs — on the account row, the channel
   * card, the reply — beside a control that resolves it. What survives here is a
   * single summary line, because a page still has to answer "is this working?" above
   * the fold.
   *
   * Severity, not a list: `broken` means something a person must fix before anything
   * can happen; `attention` means it is working and something is waiting.
   */
  const degradedRuns = await prisma.scrapeRun.count({
    where: { startedAt: { gte: daysAgo(2) }, status: { not: 'OK' }, finishedAt: { not: null } },
  })

  let health: Health = 'healthy'
  let headline = 'Watching normally. Nothing to send right now.'

  if (challenged.length > 0) {
    health = 'broken'
    headline = `Instagram has locked ${challenged.map((s) => operatorName(s.displayName)).join(' and ')}. Open the account and clear the prompt.`
  } else if (personaBroken.length > 0) {
    health = 'broken'
    headline = `Contact details on ${operatorName(personaBroken[0]!.displayName)} are incomplete, so nothing can be written.`
  } else if (watch.severity !== 'ok') {
    /**
     * ABOVE the replies and the waiting drafts, deliberately. A missed paid post is the
     * only thing on this ladder that is UNRECOVERABLE — a reply keeps until it is read
     * and a draft keeps until it is sent, but a post that scrolls out of the feed window
     * is gone, and no endpoint will hand it back.
     *
     * `broken` for both stopped states rather than only the lossy one, because the whole
     * failure this replaces is that the previous, milder wording was true and ignored.
     */
    health = 'broken'
    headline = watchHealthSentence(watch) ?? 'The watch is not running.'
  } else if (passes.detectStale || passes.planStale) {
    /**
     * Below the dead-process rung (that one is unrecoverable loss; this one is work
     * failing while the process lives) and above replies and drafts, because nothing
     * downstream can happen while the passes fail: no detection means no material, no
     * planning means no drafts, however healthy everything else looks.
     */
    health = 'broken'
    const failing =
      passes.detectStale && passes.planStale
        ? 'finding paid posts and writing messages'
        : passes.detectStale
          ? 'finding paid posts'
          : 'writing messages'
    const lastOk = passes.detectStale ? passes.detectOkAt : passes.planOkAt
    const minutes = lastOk ? Math.round((Date.now() - lastOk.getTime()) / 60_000) : null
    headline =
      `The watch process is running, but ${failing} keeps failing — last succeeded ` +
      `${minutes !== null ? `${minutes} minutes ago` : 'unknown'}. The server's own log says why.`
  } else if (unreadReplies.length > 0) {
    // A reply outranks a waiting draft: it is the only event here that is revenue.
    health = 'attention'
    headline =
      unreadReplies.length === 1
        ? `${operatorName(unreadReplies[0]!.pair.target.displayName)} replied. Outreach to them is on hold until you have answered.`
        : /**
             ── ROWS ARE NOT RECIPIENTS, AND THESE ARE NEVER CHANNELS (2026-08-26) ──
             This read `${unreadReplies.length} channels replied` and was wrong twice.
             `unreadReplies` is one row per REPLY, and 78 rows spanned 63 distinct
             recipients — a 24% overstatement of how many parties are held. And "channel"
             names the one role that structurally cannot appear here: a channel is a
             `role: 'WATCH'` publisher we read and never message (`TARGET_IS_WATCH_ONLY`).
             Every row in this set is a PROSPECT. The panel 40px below already said 63.
           */
          `${new Set(unreadReplies.map((r) => r.pair.targetId)).size} recipients replied. Outreach to them is on hold.`
  } else if (awaitingRaw.length > 0) {
    health = 'attention'
    headline = `${awaitingRaw.length} message${awaitingRaw.length === 1 ? '' : 's'} written and ready to send.`
  } else if (env.DRY_RUN) {
    health = 'attention'
    headline = 'Practice mode: watching and deciding, but writing nothing to send.'
  } else if (ceilingReached) {
    health = 'attention'
    headline = `Send limit reached — ${totalInFlight} of ${env.MAX_TOTAL_SENDS} used or waiting. Nothing new is being prepared.`
  } else if (paused.length > 0) {
    health = 'attention'
    headline = `${paused.map((s) => operatorName(s.displayName)).join(', ')} is paused.`
  }

  // ── Replies ───────────────────────────────────────────────────────────────
  // Built by `toReplyCards`, shared with `/conversations`. Step D moved the CARD to that page
  // and left the headline here, so two files now describe the same reply — through one function,
  // because two mappings of the same row is how a preview once came to be read out of `error`.
  const replies = toReplyCards(unreadReplies, settings.replyResumeHours)

  // ── Activity, as sentences, grouped by day ────────────────────────────────
  const events: { at: Date; event: ActivityEvent }[] = []

  for (const a of recentSends) {
    if (!a.sentAt) continue
    const brand = a.campaign ? readStringArray(a.campaign.brands).map(prettifyBrand)[0] : null
    const hook = brand ? `, referencing their ${brand} campaign` : ''
    events.push({
      at: a.sentAt,
      event: {
        timeLabel: timeOnly(a.sentAt),
        kind: 'sent',
        sentence: `Messaged ${operatorName(a.pair.target.displayName)} as ${operatorName(a.pair.sender.displayName)}${hook}`,
      },
    })
  }
  /**
   * Replies as HISTORY, and therefore every reply in the window — not just the unhandled ones.
   *
   * This iterated `unreadReplies`, which is filtered `replyHandledAt: null`. So the moment
   * someone pressed "I have replied", that reply disappeared from "What happened" — a record of
   * what happened that changes depending on whether a box has been ticked. Handling a reply is
   * explicitly NOT erasing it: `repliedAt`, `replyText` and status REPLIED all survive by
   * design, and the feed was the one place that contradicted it.
   *
   * The SENTENCE differs by state, because "outreach is on hold" stops being true once a person
   * has taken over, and a history entry asserting a halt that has been released is worse than no
   * entry at all.
   */
  /*
    THE SENTENCE MUST ASK THE HALT, NOT THE HANDLED COLUMN (2026-08-25).

    This read `replyHandledAt === null ? 'on hold' : 'taken over'`, which never asked whether
    the seven days had ELAPSED. That was accidentally correct for its entire life: measured on
    the live database on 25 Aug, 0 of 71 halts had expired, because the seven-day window only
    shipped on 19 Aug and the oldest reply frees on the 26th. From that morning it would have
    printed "all outreach to them is on hold" about recipients the fleet had already resumed
    writing to, for the feed's full fourteen-day window — a history entry asserting a halt that
    has released, which the previous docblock here already called worse than no entry at all.

    `replyHandledAt` is now VESTIGIAL: the control that wrote it was removed with the reply
    card's buttons and nothing writes it any more. It is still read here so the 0 rows that
    could ever carry it keep their meaning, and so re-adding an early release is one UI change.
  */
  const replyFloor = replyHaltFloor(settings.replyResumeHours)
  for (const r of repliesInWindow) {
    if (!r.repliedAt) continue
    const holding =
      r.replyHandledAt === null && r.replyPostedAt !== null && r.replyPostedAt >= replyFloor
    events.push({
      at: r.repliedAt,
      event: {
        timeLabel: timeOnly(r.repliedAt),
        kind: 'reply',
        sentence: holding
          ? `${operatorName(r.pair.target.displayName)} replied — all outreach to them is on hold`
          : `${operatorName(r.pair.target.displayName)} replied — the seven-day pause has since released`,
      },
    })
  }

  events.sort((a, b) => b.at.getTime() - a.at.getTime())

  const byDay = new Map<string, ActivityEvent[]>()
  for (const e of events) {
    const key = istDateKey(e.at)
    const list = byDay.get(key) ?? []
    list.push(e.event)
    byDay.set(key, list)
  }
  /**
   * The TRUE delivered count per IST day, so each day can state what the feed is not
   * showing. One `groupBy` over the same 14-day window the feed reads — never derived from
   * `recentSends`, which is the capped list whose bottom row started this.
   */
  const perDayDelivered = new Map<string, number>()
  for (const row of await prisma.outreachAttempt.findMany({
    where: { status: { in: [...DELIVERED_STATUSES] }, sentAt: { gte: daysAgo(14) } },
    select: { sentAt: true },
  })) {
    if (!row.sentAt) continue
    const key = istDateKey(row.sentAt)
    perDayDelivered.set(key, (perDayDelivered.get(key) ?? 0) + 1)
  }

  const activity: ActivityDay[] = [...byDay.entries()].slice(0, 7).map(([key, evs]) => ({
    dayLabel: dayLabel(key),
    events: evs,
    /* Sends only, both sides: the total is deliveries, so count the delivery events. */
    shown: evs.filter((e) => e.kind === 'sent').length,
    total: perDayDelivered.get(key) ?? evs.filter((e) => e.kind === 'sent').length,
  }))

  // ── Channels ──────────────────────────────────────────────────────────────
  // Lives in `buildChannelCards` since step C of the redesign moved the cards to their own
  // page. Today still needs the LIST — the coverage line counts channels, and the on-demand
  // dialog needs the reachable ones — so this is the same function, called from two builders
  // rather than two queries that could disagree about what a channel is.
  const channels = await buildChannelCards(targets, weekStart)

  // ── Our accounts ──────────────────────────────────────────────────────────
  const accounts: AccountCard[] = []
  for (const s of senders) {
    const sentThisWeek = await prisma.outreachAttempt.count({
      where: { pair: { senderId: s.id }, status: { in: [...DELIVERED_STATUSES] }, sentAt: { gte: weekStart } },
    })
    const problems = validatePersona(s)
    let state: AccountCard['state']
    let note: string

    // §3.5: a cookie on disk AND nothing has since proved it dead — read HOST-AWARE
    // (sessionIsUsable): on the Linode there is no disk truth, the device's DB record is it.
    const hasProfile = sessionIsUsable(s)

    if (s.status === 'CHALLENGED') {
      state = 'broken'
      note = 'locked by Instagram — needs you'
    } else if (problems.length > 0) {
      state = 'broken'
      note = 'contact details invalid'
    } else if (s.sessionInvalidAt !== null) {
      state = 'setup'
      note = `logged out ${relative(s.sessionInvalidAt)} — press Connect and sign in again`
    } else if (!hasProfile) {
      // The most common outstanding step, and the dashboard now owns it — pointing
      // at a terminal command from a button-driven page just sends people away.
      state = 'setup'
      note = 'not connected — press Connect'
    } else if (s.status === 'PAUSED') {
      state = 'setup'
      note = 'paused'
    } else {
      state = 'ready'
      /**
       * ONE SWITCH, 2026-08-08. This read "armed — will send by itself" off `autoSendEnabled`,
       * and there is no arming left to report. What differs between these two is EVIDENCE —
       * this account has actually delivered something this week, or it has not yet — which is
       * the distinction the old wording only appeared to make.
       */
      note = sentThisWeek > 0 ? 'sending by itself' : 'ready to send'
    }

    accounts.push({
      handle: s.handle,
      name: operatorName(s.displayName),
      canSendAutomatically: hasProfile,
      connecting: isConnecting(s.handle),
      routes: s.pairs
        .map((p) => ({
          targetHandle: p.target.handle,
          targetName: operatorName(p.target.displayName),
          enabled: p.enabled,
          targetRetired: p.target.optedOut,
        }))
        .sort((a, b) => a.targetHandle.localeCompare(b.targetHandle)),
      sentThisWeek,
      status: s.status,
      state,
      note,
    })
  }

  const brands = await buildBrandsPanel(settings)

  const hb = heartbeat
  const autopilot: AutopilotState = {
    /**
     * The FLEET-WIDE setting, not this machine's effective value. `settings.autopilotEnabled`
     * is env-floored (`env.AUTOPILOT_ENABLED && setting`), so the hosted dashboard read
     * "OFF" about a fleet that was actively sending — which is what Tabish saw (2026-09-02).
     * Enforcement still uses the floored value everywhere; only the DISPLAY is fleet truth.
     */
    on: settings.autopilotFleetWide,
    // `from === to` is the zero-width window `withinActiveHours` reads as "always on".
    paceClause:
      ACTIVE_FROM_HOUR === ACTIVE_TO_HOUR
        ? 'paced, around the clock'
        : `paced, and only between ${ACTIVE_FROM_HOUR}:00 and ${ACTIVE_TO_HOUR}:00 IST`,
    allowedByEnv: env.AUTOPILOT_ENABLED,
    scheduler: {
      running: hb?.fresh ?? false,
      host: hb?.beat.host ?? null,
      machine: hb?.beat.machine ?? null,
      // Same comparison `startScheduler` makes before it trusts a pid, for the same reason:
      // a beat from elsewhere is a fact about another kernel. An absent machine is "not here".
      here: hb ? (hb.beat.machine ?? null) === machineId() : false,
      lastBeatLabel: hb ? relative(new Date(hb.beat.at)) : null,
    },
    nextSlotLabel: nextSlotLabel(),
    /**
     * ONE SWITCH, 2026-08-08. Both of these used to require `s.autoSendEnabled`.
     *
     * `readyHandles` is what the switch's own sentence names as covered, so it has to mean
     * "would send" and nothing else. With the per-account bit gone that is session + status,
     * and the ladder — asked by `gate.ts` at delivery, never mirrored here, because a page
     * computing a rule its own way is how a dashboard comes to disagree with the enforcer.
     *
     * `needLoginHandles` widened in the safe direction and that is the point: it used to
     * report only accounts somebody had ARMED, so a signed-out account nobody had flipped
     * was invisible on the one card that explains why nothing is sending. Every session-less
     * account is now named there.
     */
    /**
     * HOST-AWARE since 2026-09-02. These read `profileStatus` (LOCAL DISK) directly, so on
     * the hosted dashboard — no Chrome profiles — every signed-in, actively-sending account
     * rendered "not signed in, so they cannot send" on the landing page while the fleet was
     * delivering 9/hour. Tabish caught it from the live page. Same defect class the
     * /senders fix closed; the shared rule is `sessionIsUsable` (session-view.ts).
     */
    readyHandles: senders.filter((s) => s.status === 'ACTIVE' && sessionIsUsable(s)).map((s) => s.handle),
    needLoginHandles: senders.filter((s) => !sessionIsUsable(s)).map((s) => s.handle),
  }


  /**
   * A run in progress must not be reported as a finished one.
   *
   * `ScrapeRun` is created with zeros at the start of a slot and updated at the end,
   * and this reads the newest row by `startedAt` — so for the ~60s a slot takes, the
   * header rendered "Last check read 0 posts · 0 new". Zero posts parsed is supposed
   * to be an ALARM (60 parsed / 0 paid is a quiet day; 0 parsed means the parser
   * broke), so the one number that must never appear falsely was appearing four
   * times a day. Observed 2026-08-03: the same row read 0 at 11:01 and 168 at 11:03.
   */
  const lastCheckLabel = lastCheckLabelFor(lastRun)

  const detection = await buildDetectionHealth(targets, degradedRuns)

  return {
    health,
    headline,
    lastCheckLabel,
    nextSlotLabel: nextSlotLabel(),
    nowLabel: istStamp(),
    replies,
    week: { detected: weekDetected, sent: weekSent, replies: weekReplies, checked: weekChecked },
    activity,
    channels,
    accounts,
    brands,
    awaitingCount: awaitingRaw.length,
    autopilot,
    detection,
  }
}

/**
 * The unhandled replies, as cards. ONE mapping, two callers.
 *
 * `preview` reads `replyText` and nothing else. It used to read `OutreachAttempt.error` — a
 * column for send failures — because no field for reply content existed, so a message that
 * failed and was later marked replied would have displayed its own error string as the
 * recipient's words. A second copy of this mapping is how that comes back.
 */
export function toReplyCards(
  rows: Array<{
    id: string
    repliedAt: Date | null
    /** The WRITTEN clock. The halt counts from this, never from `repliedAt`. */
    replyPostedAt: Date | null
    replyText: string | null
    threadUrl: string | null
    pair: { target: { displayName: string; handle: string }; sender: { displayName: string; handle: string } }
  }>,
  /** `settings.replyResumeHours` — passed in so this shares the enforcer's number, never a literal. */
  resumeHours: number,
): ReplyCard[] {
  return rows.map((r) => ({
    attemptId: r.id,
    targetName: operatorName(r.pair.target.displayName),
    targetHandle: r.pair.target.handle,
    senderName: operatorName(r.pair.sender.displayName),
    senderHandle: r.pair.sender.handle,
    threadUrl: r.threadUrl,
    whenLabel: relative(r.repliedAt),
    /*
      Same arithmetic as `replyHaltActive` and as the Resting list, from the SAME column the
      gate filters on. `replyPostedAt: null` cannot reach here — every query feeding this is
      windowed `replyPostedAt: { gte: floor }`, which never matches NULL — but an undatable
      reply does not halt at all, so if one ever did arrive the honest sentence is that
      nothing is being held.
    */
    freesLabel:
      r.replyPostedAt === null
        ? 'not holding anything — no date on the reply'
        : `frees ${istStamp(new Date(r.replyPostedAt.getTime() + resumeHours * 3_600_000))} IST`,
    preview: r.replyText && r.replyText.length > 0 ? r.replyText : null,
  }))
}

// ── the three projections ────────────────────────────────────────────────────

/**
 * **Today** — is it working, and what needs me.
 *
 * What it deliberately does NOT carry, and where each went:
 *
 *   the channel cards      -> `/channels`. Five cards of per-channel detail is a reference
 *                             table, not an answer to "is it working".
 *   the brands panel       -> `/paid-posts`. Both halves are detection output: a confirmed
 *                             brand names the campaign it was found in, and an undecided
 *                             handle is a detection result awaiting a person.
 *   the accounts panel     -> `/accounts`, which already rendered its own copy of it.
 *   the full draft list    -> `/messages`, which also already rendered its own copy. Today
 *                             keeps the COUNT, because "3 waiting" is the answer to "what
 *                             needs me" and three full message bodies is not.
 *   "send a message now"   -> `/messages`. It is an action, not a place.
 *
 * The three metrics and the coverage line stay TOGETHER and stay here. "5 paid campaigns
 * spotted" describes one channel out of five, and *a metric that covers part of the data must
 * say which part* — putting the number on one page and its qualifier on another is the same
 * defect as omitting the qualifier.
 */
export interface TodayView {
  health: Health
  headline: string
  /** Neutral fact, and it must render OUTSIDE the health card — see the page. */
  lastCheckLabel: string
  nextSlotLabel: string
  nowLabel: string
  /**
   * How many replies are waiting for a person, NOT the cards themselves.
   *
   * The cards moved to `/conversations` in step D. Before that the same reply appeared three
   * times on this one page: in the health headline, as a full card with its text and buttons,
   * and again as a row in "What happened". The headline is a summary and the feed row is
   * history; the card was the duplicate, and it belongs beside the control that releases the
   * halt. Handing this projection only a COUNT is what stops it being rendered here again.
   */
  repliesWaiting: number
  week: { detected: number; sent: number; replies: number; checked: number }
  activity: ActivityDay[]
  detection: DetectionHealth
  channelCount: number
  autopilot: AutopilotState
  accounts: AccountCard[]
  /** How many drafts are waiting. The bodies live on `/messages`. */
  waitingCount: number
}

/**
 * NOT wrapped in `memoView` on purpose: this is a cheap projection of `buildCeoView`, which
 * IS memoised, so wrapping it again would cache the same answer twice and let the two copies
 * disagree for up to ten seconds. `tests/view-memo.test.ts` lists it as a projection.
 */
export async function buildTodayView(): Promise<TodayView> {
  const v = await buildCeoView()
  return {
    health: v.health,
    headline: v.headline,
    lastCheckLabel: v.lastCheckLabel,
    nextSlotLabel: v.nextSlotLabel,
    nowLabel: v.nowLabel,
    repliesWaiting: v.replies.length,
    week: v.week,
    activity: v.activity,
    detection: v.detection,
    channelCount: v.channels.length,
    autopilot: v.autopilot,
    accounts: v.accounts,
    waitingCount: v.awaitingCount,
  }
}

/**
 * **Channels** — what we watch, and whether reading works.
 *
 * `lastCheckLabel` and `degradedRuns` belong here as well as on Today, and that is not
 * duplication for its own sake: Today answers "is the watch alive" in one line, and this page
 * is where an operator finds out WHICH channel is failing. Both read `lastCheckLabelFor`, so
 * the two cannot word it differently.
 */
export interface ChannelsView {
  channels: ChannelCard[]
  lastCheckLabel: string
  nextSlotLabel: string
  /**
   * Degraded checks in the last two days.
   *
   * A health signal read from ONE sample cannot show a trend: the old blocker looked only at
   * the newest run, so a channel failing at every slot for two days read exactly like one
   * unlucky fetch, and the next success read like nothing had ever been wrong. Measured
   * 2026-08-03: 8 of 12 consecutive slots PARTIAL and the page never said so.
   */
  degradedRuns: number
}

/** A projection of the memoised `buildCeoView` — deliberately not memoised twice (see `buildTodayView`). */
export async function buildChannelsView(): Promise<ChannelsView> {
  const v = await buildCeoView()
  return {
    channels: v.channels,
    lastCheckLabel: v.lastCheckLabel,
    nextSlotLabel: v.nextSlotLabel,
    degradedRuns: v.detection.degradedRuns,
  }
}

/**
 * **Paid posts** — what detection found, and what it cost.
 *
 * The cost is on screen because it is the only spending this system does, and because a rising
 * FAILURE rate is exactly what a cost table hides by leaving failed calls out. `ModelCall`
 * records them, so this counts them.
 */
export interface PaidPostsView {
  /** CAMPAIGN verdicts in the last 7 days, and ever. */
  weekDetected: number
  totalDetected: number
  /**
   * The window every figure on this page covers — the detection cutoff. Reported on
   * screen, because a number that silently describes part of the data is the failure
   * this codebase keeps rediscovering.
   */
  since: Date
  /** Posts held from BEFORE the window: kept for the vocabulary, never judged, not a task. */
  storedBeforeCutoff: number
  /** Every verdict IN THE WINDOW, including UNCLASSIFIED — NOT JUDGED, never "organic". */
  byVerdict: { verdict: string; count: number }[]
  /**
   * FROM PAID POSTS TO MESSAGES — the funnel, in live counts (2026-08-19, Tabish asked
   * why 319 paid posts had produced only 75 waiting messages; the honest answer is a
   * chain of counts, and it belongs on the screen the question starts from).
   *
   * A paid post yields a prospect ONLY when Instagram itself names a company on the
   * post (caption @mentions, media tags, collabs) — a guessed handle was measured wrong
   * 4 times in 10, and 3 of those 4 wrong handles exist. Many posts name nobody, many
   * name the same company, and people are refused. So paid posts ≫ companies ≫ queue,
   * by design rather than by fault.
   */
  funnel: { paidPosts: number; prospectsLive: number; queued: number; contacted: number; retired: number }
  /** Per channel: how much we have stored, and how much of it has been judged. */
  perChannel: {
    name: string
    handle: string
    postsLogged: number
    campaignsThisWeek: number
    unclassified: boolean
    unclassifiedReason: string | null
    /**
     * HAS ANYONE EVER CHECKED WHETHER THIS CHANNEL'S JUDGING IS RIGHT? (repair plan 5.4)
     *
     * A channel with no labels has NO accuracy — not a good one, not a bad one. The figure
     * this project quotes (98% correct, 100% recall) is measured on @madovermarketing_mom
     * and belongs to @madovermarketing_mom, and it is measured on the one channel where the
     * classifier never runs in production. MEASURED: @bollywoodchronicle has **0 labels
     * across 937 stored posts**, and @viralbhayani has 4 across 1,005.
     *
     * Said per row, because the alternative is a reader assuming the headline figure covers
     * everything — the same failure the "counted from 1 of 5 channels" caveat exists for.
     */
    accuracyNote: string
  }[]
  detection: DetectionHealth
  brands: BrandsPanel
  /**
   * The verdicts themselves, newest first — date, channel, brand, a LINK to the post,
   * verdict. Nothing in the system could link a verdict to the post it judged before
   * 2026-08-06; `postUrl()` in `lib/urls.ts` is the four-line helper that fixed it.
   */
  posts: PaidPostRow[]
  /**
   * WHERE THIS PAGE IS IN THE RECORD (2026-08-25, Tabish: *"There must be a filter to show
   * in a list (with back button to go further back and see data page wise)"*).
   *
   * This was a flat `take: 100` with a "Showing the newest 100 of N" line under it — the
   * fourth face of *a bounded list read as a complete record*, and the one that had been an
   * open item in CLAUDE.md since 21 August. `total` is its OWN count over the SAME predicate
   * the rows use; deriving it from `posts.length` would report "100 of 100" and agree with
   * the truncation, which is a check verifying its own symmetry.
   *
   * Same shape as `buildSentHistory`, deliberately: one pagination idea in this product, not
   * two that drift.
   */
  postsPaging: { page: number; pageCount: number; total: number; from: number; to: number }
  /**
   * The watched channel this page is filtered to, echoed back so the dropdown can render its
   * own state — and NULL when the filter is off or the URL named a channel we do not watch.
   * A `?channel=` anyone can type must not produce an empty table with no explanation.
   */
  channelFilter: string | null
  /** Every channel the dropdown may offer. The visible ones only — see visibleChannels.ts. */
  channelOptions: { handle: string; name: string }[]
  /** The search term in force, echoed back so the box keeps what was typed. */
  searchQuery: string | null
  /**
   * The frame check, counted separately from caption verdicts — a flagged frame ASKED a
   * person to look, it did not decide, and adding it to "paid" would overstate a
   * judgement nobody made (the verdictSource rule, one modality over).
   */
  /** Read, and the frame carried legible text. The only state that can move a verdict. */
  framesRead: number
  /**
   * The four states that are NOT "the footage was read and said nothing". Kept apart
   * because they have four different remedies, and because a single low number reading
   * "few frames read" cannot distinguish a clean corpus from a broken engine — the second
   * is an outage wearing the costume of a quiet day.
   */
  framesNotSaved: number
  framesNoEngine: number
  framesFailed: number
  frameFlagged: number
  /**
   * The review queue and the settled list are GONE (Tabish, 2026-08-17). There is one
   * table, it carries every post the system calls paid plus the ones a person crossed off,
   * and the cross lives on the row. Three lists showing the same posts taught a reader to
   * skip all three.
   */
}

export interface PaidPostRow {
  shortcode: string
  url: string
  dayLabel: string
  /**
   * WHEN THE POST WENT UP — "12 Aug (16:42)", IST. Formatted here rather than in the page,
   * like every other interpretation on this dashboard.
   *
   * The bare date was ambiguous in the way that matters: @viralbhayani's commercial posting
   * starts around 09:00 IST and peaks 16:00-20:00, and over 14 days it published 84 posts
   * before 09:00 of which ZERO were paid. An operator judging a verdict needs the hour.
   */
  postedLabel: string
  /** The full stamp, for the cell's `title`. Precision without a wider column. */
  postedExact: string
  /**
   * "found 15h later" — set ONLY when detection was far behind publication, which on the
   * measured data means the watch had a GAP rather than a slow pass. Null on the common
   * path so the column stays quiet; see `latenessLabel`.
   */
  lateness: string | null
  channelName: string
  channelHandle: string
  /** Display names from the caption. Empty when extraction found none. */
  brands: string[]
  verdict: string
  /** A person has crossed this off as ordinary. Drives the undo state of the cross. */
  dismissed: boolean
  /**
   * Set when this row is here because the FOOTAGE flagged it — the caption said
   * ordinary. Carries what the model saw, because a review request that does not say
   * what to look at is a nag, not information.
   */
  frameEvidence: string | null
  /**
   * The prospect(s) this post earns a message to — via the post's own @mentions/tags
   * (materialAllowance's linkage) or via a prospect DISCOVERED from this post. Empty
   * means the post named nobody we could verify, which is the honest answer, not a gap.
   */
  recipients: { handle: string }[]
  /**
   * THE MESSAGES THIS POST ACTUALLY CAUSED (Tabish, 2026-08-31: *"nowhere does a person
   * know why that particular message was sent to that person, for which paid post"*).
   *
   * `recipients` is who this post EARNS a message to; this is who was actually written to
   * BECAUSE of it. Attribution is a stored fact in both arms and every delivered message
   * belongs to at most one post, so a reader can add these up without double counting:
   * `attempt.campaignId === this post` (what the planner claimed for that message), or —
   * only when the message claimed nothing — the recipient was DISCOVERED from this post.
   * See `messageProvenance.ts` for why nothing is reconstructed when neither answers.
   */
  /**
   * `followUp` since 2026-09-01: a message to a company this page had already written to,
   * permitted by THIS post and naming it. "We wrote to them" and "we wrote to them again,
   * about this post" are different facts about one row, and the column showed one sentence
   * for both — which would have made the follow-up ship invisible on the screen it is most
   * legible from. Read from `OutreachAttempt.touchNumber`, a column that already existed.
   */
  messagesSent: {
    targetHandle: string
    senderHandle: string
    whenLabel: string
    basis: 'claimed' | 'discovered'
    followUp: boolean
  }[]
  /**
   * ── THERE IS NO "candidateNote" ANY MORE (2026-08-25, Tabish) ──────────────
   *
   * *"I don't want '1 name with no verified account yet', 'nobody named', etc type of
   * nonsensical stuff to be written here … we need definite targets, no need to mention these
   * things, also, what does 'yet' even mean?"*
   *
   * He is right on both counts. The disposition was added on 21 August because the column
   * then collapsed everything into a false "nobody verified" — but the answer to that was to
   * FIND the accounts, not to narrate the search on a screen a person reads for decisions.
   * "Badge check pending" is a fact about our queue, not about the post; "yet" is a promise
   * with no date on it. The column now lists the recipients and nothing else.
   *
   * The honest half of that complaint is fixed in `captionEntities.ts`, not here: the reason
   * so many posts had nobody to show is that only the model's `brands` were being read, so
   * every person and production company a caption named was invisible to discovery.
   */
}

/** Rows per page of the posts table. Bounded so a page render stays a page render. */
export const PAID_POSTS_PAGE_SIZE = 50

export interface PaidPostsInput {
  /** A watched channel's handle, from `?channel=`. Validated against the visible set. */
  channel?: string | null
  /** 1-based, from `?page=`. Clamped into range — `?page=999` shows the last page. */
  page?: number
  /** Free text from `?q=` — matched against the caption, the brand names and the shortcode. */
  query?: string | null
}

/**
 * Memoised on EVERY input (channel, page, query): this builder issues its own posts query
 * and count on top of the shared CEO view, so it is not a free projection, and each distinct
 * filter is its own answer. The key carries the RAW inputs, not the validated ones — an
 * unknown `?channel=` falls back to no filter inside the computation, and two spellings of
 * "no filter" costing two computations is cheaper than validating before the memo.
 */
export async function buildPaidPostsView(input?: PaidPostsInput): Promise<PaidPostsView> {
  return memoView(viewKey('paidPostsView', input ?? {}), () => computePaidPostsView(input))
}

async function computePaidPostsView(input?: PaidPostsInput): Promise<PaidPostsView> {
  const v = await buildCeoView()

  /**
   * What counts as "paid" on this page. One value since 2026-08-17 — REVIEW is gone and a
   * post is paid or it is ordinary. Kept as a named list rather than inlined, because the
   * table's `OR` also pulls in rows a person has crossed off and the two conditions being
   * separately readable is the point.
   */
  const PAID_VERDICTS = ['CAMPAIGN']

  /**
   * ── THE DROPDOWN'S OPTIONS, AND WHY THE FILTER IS VALIDATED AGAINST THEM ──
   *
   * `v.channels` is already loaded and already scoped to the VISIBLE channels, so the
   * dropdown costs no query — and it cannot offer one of our own pages, which
   * `visibleChannels.ts` excludes from every figure on this screen.
   *
   * A `?channel=` is a string anyone can type. An unrecognised one falls back to NO filter
   * rather than to an empty table: a screen that silently shows nothing is indistinguishable
   * from a channel that posted nothing, and this page's whole job is telling those apart.
   */
  const channelOptions = v.channels.map((c) => ({ handle: c.handle, name: operatorName(c.name) }))
  const wanted = input?.channel?.trim().replace(/^@/, '').toLowerCase() || null
  const channelFilter = wanted && channelOptions.some((c) => c.handle === wanted) ? wanted : null

  /**
   * ── THIS PAGE COUNTS THE WINDOW THE SYSTEM ACTUALLY JUDGES ────────────────
   *
   * Every figure here is scoped to `detectionCutoff()` (1 Aug 00:00 IST, Tabish's
   * decision). Before this, the breakdown counted the WHOLE corpus, so it reported ~370
   * posts as "not judged" — and every one of those was pre-cutoff history the classifier
   * is deliberately never asked to read. A permanent, un-clearable backlog on a screen
   * where "not judged" means A JOB TO DO.
   *
   * The rows are NOT deleted, and must not be: `buildVocabulary` learns how a channel
   * writes from every stored caption, and shrinking that baseline would make ordinary
   * vocabulary look novel and degrade the free filter. History is worth keeping precisely
   * because it is history — it is just not something to report as an outstanding task.
   *
   * So the fix is scope, not deletion: the page states its window, and inside that window
   * "not judged" is a real number that real work can drive to zero.
   */
  const since = detectionCutoff()
  /**
   * ── AND THE WINDOW IS SCOPED TO CHANNELS A PERSON SHOULD SEE ─────────────
   *
   * Our own pages are watched for ground truth and their posts must not appear on a screen.
   * MEASURED before this line existed: 1,555 of the 2,608 in-window posts were ours — 59.6%
   * of every figure on this page — and 5 of the 26 open review rows were @bollywoodsocietyy,
   * i.e. the dashboard asking a person to judge whether our own post was paid.
   *
   * Folded into `inWindow` rather than added per query ON PURPOSE. Every site below already
   * spreads this object, so one definition covers all of them and a query added later
   * inherits it. `tests/visible-channels.test.ts` greps for the ones that do not.
   */
  const inWindow = { postedAt: { gte: since }, ...(await visibleChannelFilter()) }

  /**
   * THE TABLE'S OWN PREDICATE, named once and used by BOTH the rows and their count.
   *
   * The count used to be `verdict: CAMPAIGN` while the rows were `CAMPAIGN OR humanLabel:
   * false` — so the old "showing the newest 100 of N" line already counted a different set
   * than it was describing. Harmless as a footnote; fatal as a pager, which computes where
   * the END is from that number. One predicate, two consumers.
   */
  /**
   * ── SEARCH, AND WHY IT DOES NOT USE `mode: 'insensitive'` ─────────────────
   *
   * Tabish, 2026-08-25: *"There must also be a simple 'search' button for users to search the
   * paid post from our huge and growing library."* 887 rows in the window and climbing.
   *
   * Prisma's case-insensitive `contains` is POSTGRES-ONLY — on the SQLite client the argument
   * does not exist and the call throws. That is the `skipDuplicates` trap verbatim, and it is
   * invisible to `pnpm typecheck`, which runs against the Postgres schema while the suite runs
   * against SQLite. Rather than depend on which provider generated the client, the term is
   * matched in the three casings a person actually types. Portable by construction; the cost
   * is a longer `OR`, evaluated once, inside a window that is already bounded.
   */
  /**
   * ── WHAT THIS MISSED, MEASURED 2026-08-26 ─────────────────────────────────
   *
   * Tabish searched `arshad warsi` and got 2 rows while 3 paid posts name him. Two
   * independent failures, and neither fix alone finds the third post:
   *
   *  1. **`taggedAccounts` was not searched at all.** It is in the same query's `select`
   *     (the "We message" column runs `mentionsHandleExactly` over it), so the page could
   *     DISPLAY a recipient on a row the search could not FIND. The column was in the
   *     SELECT and not in the WHERE.
   *  2. **A SPACE is not an UNDERSCORE.** `contains` is a literal `LIKE`, and nothing here
   *     normalised separators — so `arshad warsi` could never match `arshad_warsi` or
   *     `@arshad_warsi`, which is how every handle in this corpus is spelled.
   *
   * A third, found while fixing: the casing fan-out generated lower and Title case but never
   * ALL CAPS, and `captionEntities`' own work records that trade captions routinely open in
   * caps.
   *
   * SEPARATOR VARIANTS RATHER THAN A STORED SEARCH COLUMN. The honest long-term answer is a
   * lower-cased, separator-squashed column written at detection time and matched once. That
   * is a schema change plus a backfill of 2,700 rows, and this is a search box: the variants
   * below are a handful more `contains` terms over a window that is already bounded, and
   * they are portable across both providers, which `mode: 'insensitive'` is not.
   */
  const rawQuery = input?.query?.trim() ?? ''
  const searchQuery = rawQuery.length >= 2 ? rawQuery : null
  /** The same words with the separators a handle uses: "arshad warsi" -> "arshad_warsi", "arshadwarsi". */
  const separatorVariants = (t: string): string[] =>
    /\s/.test(t) ? [t.replace(/\s+/g, '_'), t.replace(/\s+/g, '.'), t.replace(/\s+/g, '')] : [t]
  const terms = searchQuery
    ? [...new Set(
        [
          searchQuery,
          searchQuery.toLowerCase(),
          searchQuery.toUpperCase(),
          searchQuery.replace(/\b[a-z]/g, (c) => c.toUpperCase()),
        ].flatMap(separatorVariants),
      )]
    : []
  const searchWhere = searchQuery
    ? {
        OR: [
          ...terms.flatMap((t) => [
            { caption: { contains: t } },
            { brands: { contains: t } },
            /* The column the "We message" cell is built from. Searching what the page
               displays is the floor, not a feature. */
            { taggedAccounts: { contains: t } },
          ]),
          /* A shortcode is an exact identifier, so it is matched as one — pasting a post's
             own code is the fastest way to find the row somebody is asking about. */
          { shortcode: searchQuery },
        ],
      }
    : null

  const postsWhere = {
    /* `AND` rather than spreading both, because two bare `OR` keys on one object would
       silently overwrite each other and the search would replace the paid filter. */
    AND: [
      { OR: [{ verdict: { in: PAID_VERDICTS } }, { humanLabel: false }] },
      ...(searchWhere ? [searchWhere] : []),
    ],
    ...inWindow,
    ...(channelFilter ? { target: { handle: channelFilter } } : {}),
  }

  /**
   * COUNTED BEFORE THE ROWS, sequentially and on purpose: `skip` cannot be clamped into range
   * without knowing the range, and an unclamped `?page=999` returns an empty table on a
   * channel that has plenty of posts. One extra round trip against a page that is already
   * `force-dynamic`; the alternative is fetching twice when someone edits the URL.
   */
  const postsTotal = await prisma.detectedCampaign.count({ where: postsWhere })
  const postsPageCount = Math.max(1, Math.ceil(postsTotal / PAID_POSTS_PAGE_SIZE))
  const postsPage = Math.min(Math.max(1, Math.floor(input?.page ?? 1)), postsPageCount)

  const [
    byVerdictRaw,
    totalDetected,
    paidRows,
    storedBefore,
    framesRead,
    framesNotSaved,
    framesNoEngine,
    framesFailed,
    frameFlagged,
    prospectsLive,
    prospectsRetired,
    prospectsQueued,
    prospectsContacted,
  ] = await Promise.all([
    prisma.detectedCampaign.groupBy({ by: ['verdict'], where: inWindow, _count: { _all: true } }),
    prisma.detectedCampaign.count({ where: { verdict: 'CAMPAIGN', ...inWindow } }),
    /**
     * Every post the system calls paid — and, since 2026-08-17, the ones a person has
     * CROSSED OFF as well, which is what makes the cross undoable.
     *
     * REVIEW used to be on this list too, because "the classifier was not confident" was a
     * request for someone to look. There is no such state any more: a post is paid or it is
     * ordinary, and the cross is how a person says which.
     *
     * Including dismissed rows is the release half of the control. The 8 August bulk write
     * showed what happens without one — 21 posts answered and then reachable from no screen
     * at all, permanently, with no way back. A correction a person can see and reverse is
     * the whole difference.
     */
    prisma.detectedCampaign.findMany({
      where: postsWhere,
      /**
       * `id` IS THE TIEBREAK, and it is not decoration. Detection stores a whole feed page in
       * one pass, so many rows share a `postedAt` to the second — with an unstable sort a row
       * silently repeats or vanishes across a page boundary, which is the quiet wrongness a
       * paginated record must not have. Same reasoning as `buildSentHistory`.
       */
      orderBy: [{ postedAt: 'desc' }, { id: 'desc' }],
      skip: (postsPage - 1) * PAID_POSTS_PAGE_SIZE,
      take: PAID_POSTS_PAGE_SIZE,
      select: {
        id: true,
        rawPayload: true,
        shortcode: true,
        postedAt: true,
        // For the lateness note: how far behind publication detection actually was.
        detectedAt: true,
        brands: true,
        verdict: true,
        humanLabel: true,
        signals: true,
        frameText: true,
        // For the "we message" column: the same Instagram-asserted evidence that links a
        // campaign to a prospect everywhere else (materialAllowance's own predicate).
        caption: true,
        taggedAccounts: true,
        target: { select: { handle: true, displayName: true } },
      },
    }),
    // Reported, never hidden: a corpus we hold but do not judge is a fact worth one line.
    // Beside the in-window figures on the same page, so it carries the same scope.
    prisma.detectedCampaign.count({ where: { postedAt: { lt: since }, ...(await visibleChannelFilter()) } }),
    /**
     * FIVE STATES, NOT ONE NUMBER.
     *
     * This was `count({ frameText: { not: null } })` and reported as "N posts had the text
     * in their video read as well as their caption" — a single figure standing in for five
     * situations with five different remedies:
     *
     *   read, with text     the footage spoke, and was judged
     *   read, no text       a frame with nothing legible on it. A real finding.
     *   no frame saved      the post predates capture, or its CDN URL had already expired
     *   no OCR engine       nothing on this machine CAN look
     *   the engine failed   something ran and errored
     *
     * Collapsing them means an operator reading a low number cannot tell whether the
     * footage is clean, the frames are missing, or OCR is broken — and the last of those
     * is an outage wearing the costume of a quiet day. It is the same shape as the
     * `unreadable` / `incomplete` distinction in the reply check, and the four-outcome
     * `OcrOutcome` type this very module already keeps apart at the point of reading.
     *
     * The signals are the evidence: `applyFrameSignal` writes exactly one per post, so
     * these counts are what the permission table actually recorded rather than a guess
     * reconstructed from a nullable column.
     */
    prisma.detectedCampaign.count({ where: { frameText: { not: null }, ...inWindow } }),
    prisma.detectedCampaign.count({ where: { signals: { contains: 'frame:not-saved' }, ...inWindow } }),
    prisma.detectedCampaign.count({ where: { signals: { contains: 'frame:no-ocr-engine' }, ...inWindow } }),
    prisma.detectedCampaign.count({ where: { signals: { contains: 'frame:ocr-failed' }, ...inWindow } }),
    // `signals` is a JSON string; this marker is written by applyFrameSignal alone.
    prisma.detectedCampaign.count({ where: { signals: { contains: 'frame:flagged-for-review' }, ...inWindow } }),
    /**
     * The funnel's prospect side. Counted from `TargetAccount` the way the planner sees
     * it: PROSPECT rows only, retirement respected, a "queued" company being one that
     * holds a waiting draft and a "contacted" one having a delivered message.
     */
    prisma.targetAccount.count({ where: { role: 'PROSPECT', optedOut: false } }),
    prisma.targetAccount.count({ where: { role: 'PROSPECT', optedOut: true } }),
    prisma.targetAccount.count({
      where: { role: 'PROSPECT', optedOut: false, attempts: { some: { status: { in: ['READY', 'QUEUED'] } } } },
    }),
    prisma.targetAccount.count({
      where: { role: 'PROSPECT', optedOut: false, attempts: { some: { status: { in: [...DELIVERED_STATUSES] } } } },
    }),
  ])

  /**
   * How many labels each channel has, for `accuracyNote`. From `readLabelledSet` — the SAME
   * function `pnpm ig:accuracy` scores against, so the page cannot claim a channel is
   * measured when the harness would call it unmeasured. Three queries, once per render.
   */
  const labelled = await readLabelledSet()
  const labelsByChannel = new Map<string, number>()
  for (const r of labelled.rows) labelsByChannel.set(r.channel, (labelsByChannel.get(r.channel) ?? 0) + 1)

  /**
   * Every prospect once, for the per-post "we message" column — matched in JS with
   * `mentionsHandleExactly` rather than a query per row, because this page has a query
   * budget and a loop over a list whose size is a product decision must not cost
   * queries per row (the buildChannelCards lesson, one panel over).
   */
  const prospectRefs = await prisma.targetAccount.findMany({
    where: { role: 'PROSPECT' },
    select: { handle: true, displayName: true, optedOut: true, discoveredFromCampaignId: true },
  })

  /*
   * The candidate DISPOSITION machinery that used to live here (excludedHandles →
   * brandCandidatesFor per row → a BrandLookup read) fed the "N unverified, refused ·
   * M badge check pending" line that Tabish removed on 2026-08-25 ("the column is the
   * recipients and an em-dash"). The computation outlived its only reader — two queries
   * and a per-row extractor pass on every render of /paid-posts, feeding nothing —
   * found by the 2026-08-27 audit and deleted rather than left as furniture.
   */

  /**
   * WHICH MESSAGES EACH POST ON THIS PAGE CAUSED — ONE query for the whole table.
   *
   * The `OR` is the attribution partition, not a widening: a message is attributed to the
   * post it CLAIMED (`campaignId`), and only a message that claimed nothing falls through
   * to the post its recipient was discovered from. So no message is counted against two
   * posts, and a reader can add the column up.
   *
   * A query per rendered row is what `buildChannelCards` was killed for; the page has a
   * budget of 120 and this must stay a constant, not 50.
   */
  const pageIds = paidRows.map((p) => p.id)
  const causedRaw = await prisma.outreachAttempt.findMany({
    where: {
      status: { in: [...DELIVERED_STATUSES] },
      sentAt: { not: null },
      OR: [
        { campaignId: { in: pageIds } },
        { campaignId: null, target: { discoveredFromCampaignId: { in: pageIds } } },
      ],
    },
    orderBy: { sentAt: { sort: 'desc', nulls: 'last' } },
    select: {
      sentAt: true,
      campaignId: true,
      /* A scalar on a query already being made — see PaidPostRow.messagesSent. */
      touchNumber: true,
      sender: { select: { handle: true } },
      target: { select: { handle: true, discoveredFromCampaignId: true } },
    },
  })
  const causedByPost = new Map<string, PaidPostRow['messagesSent']>()
  for (const a of causedRaw) {
    const claimed = a.campaignId !== null
    const postId = claimed ? a.campaignId! : a.target.discoveredFromCampaignId
    if (!postId) continue
    const list = causedByPost.get(postId) ?? []
    list.push({
      targetHandle: a.target.handle,
      senderHandle: a.sender.handle,
      whenLabel: relative(a.sentAt),
      basis: claimed ? 'claimed' : 'discovered',
      followUp: a.touchNumber > 1,
    })
    causedByPost.set(postId, list)
  }

  return {
    weekDetected: v.week.detected,
    totalDetected,
    since,
    storedBeforeCutoff: storedBefore,
    funnel: {
      paidPosts: totalDetected,
      prospectsLive,
      queued: prospectsQueued,
      contacted: prospectsContacted,
      retired: prospectsRetired,
    },
    byVerdict: byVerdictRaw
      .map((r) => ({ verdict: r.verdict, count: r._count._all }))
      .sort((a, b) => b.count - a.count),
    perChannel: v.channels.map((c) => ({
      name: c.name,
      handle: c.handle,
      postsLogged: c.postsLogged,
      campaignsThisWeek: c.campaignsThisWeek,
      unclassified: c.unclassified,
      unclassifiedReason: c.unclassifiedReason,
      accuracyNote: accuracyNoteFor(labelsByChannel.get(c.handle) ?? 0, c.postsLogged),
    })),
    detection: v.detection,
    brands: v.brands,
    posts: paidRows.map((p) => ({
      /**
       * WHO THIS POST EARNS A MESSAGE TO (Tabish, 2026-08-21: "right next to them depict
       * in a column … the instagram target which is going to send a message to — the one
       * we detected even if they were not mentioned in caption").
       *
       * Two linkages, and they are the SYSTEM'S OWN, not a UI mirror:
       *   - `mentionsHandleExactly` — the same Instagram-asserted evidence (caption
       *     @mentions + media tags) that `materialAllowance` counts when deciding whether
       *     a recipient has earned another message;
       *   - `discoveredFromCampaignId` — a prospect minted FROM this post by discovery,
       *     which covers exactly the "not mentioned in caption" case he named
       *     (`discoverOfficialPages` resolving an untagged post).
       */
      /**
       * RETIRED PROSPECTS ARE NOT LISTED (2026-08-25, Tabish: *"just do not show retired
       * targets in this column or anywhere"*). The column used to render "@deepakmukut
       * (retired)" on the reasoning that "we found them and chose not to write" and "we
       * found nobody" are different facts — true, and it made a reader decode a state they
       * cannot act on. `optedOut` is still enforced at the governor, the gate and
       * `routes.ts`; only the screen stops mentioning it.
       */
      recipients: prospectRefs
        .filter(
          (t) =>
            !t.optedOut &&
            (t.discoveredFromCampaignId === p.id ||
              mentionsHandleExactly({ caption: p.caption, taggedAccounts: p.taggedAccounts }, t.handle) ||
              /* A brand STRING that IS a verified prospect's name links too (2026-08-21) —
                 the same arm campaignsNamingHandle counts, so column and enforcer agree. */
              brandStringsNameProspect(p.brands, { handle: t.handle, displayName: t.displayName })),
        )
        .map((t) => ({ handle: t.handle })),
      messagesSent: causedByPost.get(p.id) ?? [],
      shortcode: p.shortcode,
      url: postUrl(p.shortcode),
      dayLabel: istDateKey(p.postedAt),
      postedLabel: istPostedLabel(p.postedAt),
      postedExact: istStamp(p.postedAt),
      lateness: latenessLabel(p.postedAt, p.detectedAt),
      channelName: operatorName(p.target.displayName),
      channelHandle: p.target.handle,
      /*
        OWN MARKS ARE NOT BRANDS, AND THE COLUMN WAS SHOWING THEM (2026-08-25, Tabish:
        *"filmigyan issue of fg2 abbreviations is still an issue, these are internal tags"*).

        MEASURED: 668 @filmygyan rows and 178 @bollywoodsocietyy rows carry a code like `fg2`,
        `bs2`, `fg14` — 49 of them stored TODAY, so this is live, not history. `ownMarks`
        stops a code reaching a VERDICT and `harvestBrandNames` stops it spending a lookup
        (verified: zero `fg*` handles in `BrandLookup`), but nothing stopped it being PRINTED.
        Stripped here so every stored row is covered, not just the ones judged from now on.
      */
      brands: stripOwnMarksFromBrands(readStringArray(p.brands), {
        handle: p.target.handle,
        displayName: p.target.displayName,
      }),
      verdict: p.verdict,
      /**
       * Has a person already crossed this off? Drives the control's two states — the cross,
       * or "marked ordinary — undo". `humanLabel === false` and not `verdict === 'ORGANIC'`,
       * because only a PERSON's answer is undoable here; a classifier ORGANIC never reaches
       * this table.
       */
      dismissed: p.humanLabel === false,
      /**
       * What the FOOTAGE said, when the footage is why this row is here at all. The signal
       * changed name with the escalation target: `frame:flagged-for-review` became
       * `frame:escalated-to-campaign`. Both are read, because rows judged before the change
       * still carry the old one and dropping them would silently blank the evidence column
       * on exactly the posts most likely to be wrong.
       */
      frameEvidence: (() => {
        const sig = readStringArray(p.signals)
        return sig.includes('frame:escalated-to-campaign') || sig.includes('frame:flagged-for-review')
          ? p.frameText
          : null
      })(),
    })),
    postsPaging: {
      page: postsPage,
      pageCount: postsPageCount,
      total: postsTotal,
      from: postsTotal === 0 ? 0 : (postsPage - 1) * PAID_POSTS_PAGE_SIZE + 1,
      to: Math.min(postsPage * PAID_POSTS_PAGE_SIZE, postsTotal),
    },
    channelFilter,
    channelOptions,
    searchQuery,
    framesRead,
    framesNotSaved,
    framesNoEngine,
    framesFailed,
    frameFlagged,
  }
}

/**
 * **Cost** — what detection costs, on its own page since the simple-sender redesign.
 *
 * The only spending this system does. Failed calls are counted deliberately: a rising
 * failure rate is exactly what a cost table hides by leaving them out, and a failed call
 * is never recorded as a verdict.
 */
export interface CostView {
  spend: { calls: number; failed: number; usd: number; cachedShare: number | null }
  byPurpose: { purpose: string; calls: number; usd: number }[]
  /** Classify calls attributed to the channel whose post was judged. */
  perChannel: { handle: string; calls: number; usd: number }[]
}

export async function buildCostView(): Promise<CostView> {
  return memoView(viewKey('costView'), computeCostView)
}

async function computeCostView(): Promise<CostView> {
  /**
   * AGGREGATED IN THE DATABASE, 2026-09-02. This was a `findMany` over EVERY ModelCall row —
   * fine when the ledger was small, and at 50,753 rows it loaded the whole table into memory
   * (plus an IN-clause join over every distinct classify shortcode) on each render. On the
   * hosted dashboard that pushed /cost past Cloudflare's 100-second origin ceiling: the page
   * answered 502/504/524, one of the seven pages simply did not load (found live,
   * 2026-09-02). The ledger only grows (~2,800 calls/day), so the fix is aggregation where
   * the rows live — the SUM measured 597ms over the tunnel against 33s for one bare count.
   * Note for the query budget: `ig:layout` counts QUERIES, so the old single fat findMany
   * passed the budget while being the slowest read in the product — a budget over query
   * COUNT cannot see payload size.
   */
  const [agg, failed, purposeRows, channelRows] = await Promise.all([
    prisma.modelCall.aggregate({
      _count: { _all: true },
      _sum: { costUsd: true, inputTokens: true, cachedInputTokens: true },
    }),
    prisma.modelCall.count({ where: { ok: false } }),
    prisma.modelCall.groupBy({ by: ['purpose'], _count: { _all: true }, _sum: { costUsd: true } }),
    /**
     * A classify call's subject is the post's shortcode, so the channel it was spent on is
     * one join away — done IN SQL so tens of thousands of rows never cross the wire. Calls
     * whose subject no longer resolves are reported under 'no longer stored', never dropped.
     * Written to run on BOTH providers (the two-provider trap): quoted identifiers and
     * CAST(... AS INTEGER) are Postgres AND SQLite; no `::` casts, no provider functions.
     */
    prisma.$queryRaw<Array<{ handle: string; calls: number | bigint; usd: number }>>`
      SELECT COALESCE(t."handle", 'no longer stored') AS handle,
             CAST(COUNT(*) AS INTEGER) AS calls,
             COALESCE(SUM(m."costUsd"), 0) AS usd
      FROM "ModelCall" m
      LEFT JOIN "DetectedCampaign" dc ON dc."shortcode" = m."subject"
      LEFT JOIN "TargetAccount" t ON t."id" = dc."targetId"
      WHERE m."purpose" = 'classify'
      GROUP BY COALESCE(t."handle", 'no longer stored')
    `,
  ])

  const input = agg._sum.inputTokens ?? 0
  const cached = agg._sum.cachedInputTokens ?? 0

  return {
    spend: {
      calls: agg._count._all,
      failed,
      usd: agg._sum.costUsd ?? 0,
      // Null rather than 0 when nothing has been sent: "no calls yet" and "the cache never
      // hits" are different facts, and a bare 0% would report the second.
      cachedShare: input + cached > 0 ? cached / (input + cached) : null,
    },
    byPurpose: purposeRows
      .map((r) => ({ purpose: r.purpose, calls: r._count._all, usd: r._sum.costUsd ?? 0 }))
      .sort((a, b) => b.usd - a.usd),
    // Raw drivers disagree on integer width (Postgres bigint vs SQLite integer) — coerce.
    perChannel: channelRows
      .map((r) => ({ handle: r.handle, calls: Number(r.calls), usd: Number(r.usd) }))
      .sort((a, b) => b.usd - a.usd),
  }
}

/**
 * The channel cards, extracted in step C of the redesign so `/channels` and `/` can share ONE
 * definition of what a channel card is. Two pages computing "paid campaigns found" their own
 * way is how a hardcoded `detectorKey === 'passthrough'` came to render a misleading zero.
 */
async function buildChannelCards(
  targets: Array<{ id: string; handle: string; displayName: string; optedOut: boolean; detectorKey: string }>,
  weekStart: Date,
): Promise<ChannelCard[]> {
  /**
   * ── FIVE QUERIES TOTAL, NOT FIVE PER CHANNEL (2026-08-20) ────────────────
   *
   * This was a `for (const t of targets)` issuing five queries per row — the exact N+1 the
   * `buildBrandsPanel` docblock below records being killed on 2026-08-13, one function up
   * from it. It survived here because the channel list was 2 rows for its whole life:
   * 10 queries, invisible. The day Tabish added his 11 watch pages it became 65, and FOUR
   * pages blew their `ig:layout` query budgets at once, because `/`, `/targets`,
   * `/analytics` and `/paid-posts` all render these cards through `buildTodayView`.
   *
   * A loop over a list whose size is a PRODUCT DECISION (how many pages to watch) must not
   * cost queries per row — the whole point of adding channels is that the list grows.
   * Budgets are ceilings over a bounded design; the fix is batching, never raising them.
   */
  /* Named so the visible-channels grep can accept exactly this scope and nothing looser:
     these ids are the card rows the caller already chose, not a survey of the corpus. */
  const cardTargetIds = targets.map((t) => t.id)
  const [campaignCounts, weekCounts, loggedCounts, lastSents, repliedCounts] = await Promise.all([
    prisma.detectedCampaign.groupBy({
      by: ['targetId'],
      where: { targetId: { in: cardTargetIds }, verdict: 'CAMPAIGN', detectedAt: { gte: weekStart } },
      _count: { _all: true },
    }),
    prisma.detectedCampaign.groupBy({
      by: ['targetId'],
      where: { targetId: { in: cardTargetIds }, detectedAt: { gte: weekStart } },
      _count: { _all: true },
    }),
    prisma.detectedCampaign.groupBy({
      by: ['targetId'],
      where: { targetId: { in: cardTargetIds } },
      _count: { _all: true },
    }),
    /**
     * Newest delivery per target in ONE query: ordered newest-first, `distinct` keeps the
     * first row seen per targetId. `targetId` is the attempt's own column — the same value
     * the old `pair: { targetId }` join reached, written from the same pair at draft time.
     */
    prisma.outreachAttempt.findMany({
      where: { targetId: { in: cardTargetIds }, status: { in: ['SENT', 'REPLIED'] } },
      orderBy: { sentAt: { sort: 'desc', nulls: 'last' } },
      distinct: ['targetId'],
      select: { targetId: true, sentAt: true },
    }),
    prisma.outreachAttempt.groupBy({
      by: ['targetId'],
      where: { targetId: { in: cardTargetIds }, repliedAt: { not: null } },
      _count: { _all: true },
    }),
  ])
  const campaignBy = new Map(campaignCounts.map((r) => [r.targetId, r._count._all]))
  const weekBy = new Map(weekCounts.map((r) => [r.targetId, r._count._all]))
  const loggedBy = new Map(loggedCounts.map((r) => [r.targetId, r._count._all]))
  const lastSentBy = new Map(lastSents.map((r) => [r.targetId, r.sentAt]))
  const repliedBy = new Map(repliedCounts.map((r) => [r.targetId, r._count._all]))

  const channels: ChannelCard[] = []
  for (const t of targets) {
    const lastSentAt = lastSentBy.get(t.id) ?? null
    channels.push({
      name: operatorName(t.displayName),
      handle: t.handle,
      followers: FOLLOWER_SNAPSHOT[t.handle] ?? '—',
      campaignsThisWeek: campaignBy.get(t.id) ?? 0,
      postsThisWeek: weekBy.get(t.id) ?? 0,
      postsLogged: loggedBy.get(t.id) ?? 0,
      lastContactedLabel: lastSentAt ? relative(lastSentAt) : 'not yet',
      halted: (repliedBy.get(t.id) ?? 0) > 0 || t.optedOut,
      /**
       * Ask the detector, never the key.
       *
       * This read `detectorKey === 'passthrough'`, and switching @viralbhayani to the
       * semantic detector turned it false — so the card immediately rendered "Paid
       * campaigns found: 0" for a channel where roughly half of ~62 posts/day are
       * commercial and the classifier has no API key. The exact misleading zero this
       * flag exists to prevent, reintroduced by a hardcoded key comparison.
       *
       * `readiness()` is the detector's own statement about whether it can judge, so
       * it stays true when a classifier is present but unconfigured, and becomes false
       * the moment one actually works.
       */
      unclassified: !(getDetector(t.detectorKey).readiness?.() ?? { ready: true }).ready,
      unclassifiedReason: (getDetector(t.detectorKey).readiness?.() ?? { ready: true }).reason ?? null,
      retired: t.optedOut,
      everContacted: lastSentAt !== null,
    })
  }
  return channels
}

/**
 * The brands panel.
 *
 * Two lists, and the split changed meaning on 2026-08-08 without changing shape. It used to be
 * "what we KNOW is a buyer" beside "what a HUMAN still has to decide". The second list is now
 * "what the MODEL decided", and it is a record rather than a work queue — nothing in it is
 * waiting on anybody.
 *
 * The lists stay separate for the original reason, which survived the change: a confirmed buyer
 * and an automatic judgement are different kinds of claim, and merging them would present a
 * guess as a verdict.
 */
async function buildBrandsPanel(settings: Awaited<ReturnType<typeof getSettings>>): Promise<BrandsPanel> {
  /**
   * ── THE N+1 THAT MADE THIS PAGE TEN SECONDS LONG (fixed 2026-08-13) ──────
   *
   * This read every BRAND target with NO `take`, then ran TWO SERIAL awaits inside the loop
   * — a count and a campaign lookup, per brand. MEASURED: `buildCeoView` took **9.9 s** and
   * issued **174 queries**, of which **145 came from here**.
   *
   * NEITHER CAUSE IS SUFFICIENT ALONE, and that is the part worth keeping. On SQLite at ~1 ms
   * a query the N+1 cost 0.2 s and was invisible for months. Hosting made a `select 1` through
   * the SSH tunnel **28-37 ms** (raw ping to the Linode is 4.4 ms), and SSH multiplexes every
   * channel over ONE TCP stream, so 20 concurrent queries on a pool of 10 still take 305 ms —
   * concurrency barely helps, which rules out the obvious `Promise.all` fix. Then brand
   * discovery finally worked on 2026-08-12 and 9 brands became 68. A latent design flaw, a
   * slow link and a feature succeeding: the page got slow because things went RIGHT.
   *
   * It is now THREE queries regardless of how many brands exist: the rows, one `groupBy` for
   * the delivered counts, one `findMany` for the discovery campaigns. Joined in memory.
   */
  const brandTargets = await prisma.targetAccount.findMany({
    where: { kind: 'BRAND' },
    /**
     * BOUNDED, with the total reported beside it — the posts table already does this
     * ("showing the newest 100 of 223"). An unbounded list is a page that degrades silently
     * as the system succeeds, which is exactly how this one reached ten seconds.
     *
     * NEWEST first, not oldest: the useful question on a CEO's page is "what has been found
     * lately", and the oldest rows are the ones already known about.
     */
    take: BRAND_CARDS_SHOWN,
    include: { pairs: { select: { enabled: true } } },
    orderBy: { createdAt: 'desc' },
  })
  const brandTotal = await prisma.targetAccount.count({ where: { kind: 'BRAND' } })

  const campaignIds = brandTargets
    .map((b) => b.discoveredFromCampaignId)
    .filter((id): id is string => id !== null)

  const [sentRows, campaigns] = await Promise.all([
    prisma.outreachAttempt.groupBy({
      by: ['targetId'],
      where: { targetId: { in: brandTargets.map((b) => b.id) }, status: { in: [...DELIVERED_STATUSES] } },
      _count: { _all: true },
    }),
    campaignIds.length === 0
      ? Promise.resolve([])
      : prisma.detectedCampaign.findMany({
          where: { id: { in: campaignIds } },
          select: { id: true, target: { select: { displayName: true } } },
        }),
  ])
  const sentByTarget = new Map(sentRows.map((r) => [r.targetId, r._count._all]))
  /**
   * `operatorName` applied HERE, at extraction, not at the point of use.
   *
   * Both spellings render the same string, and only this one satisfies the rule that no view
   * model holds a raw `displayName` — `tests/labels.test.ts` is a grep and cannot see a wrap
   * applied three lines later. It caught exactly that in this refactor, which is its job: a
   * raw label in a map is one careless read away from the screen.
   */
  const publisherByCampaign = new Map(campaigns.map((c) => [c.id, operatorName(c.target.displayName)]))

  const confirmed: BrandCard[] = brandTargets.map((b) => ({
    handle: b.handle,
    name: operatorName(b.displayName),
    category: b.brandCategory,
    // Which publisher's post surfaced this company. Prose, never a handle.
    discoveredOn:
      b.discoveredFromCampaignId !== null ? (publisherByCampaign.get(b.discoveredFromCampaignId) ?? null) : null,
    enabled: b.pairs.some((p) => p.enabled),
    sent: sentByTarget.get(b.id) ?? 0,
    retired: b.optedOut,
  }))

  /**
   * WHAT THE MODEL DECIDED, newest first — a record of automatic work, not a queue.
   *
   * `decidedBy: 'model'` is the whole filter, and it is the honest one: rows settled by
   * Instagram's own category data are not the model's opinion and must not be reported as
   * though they were, exactly as `verdictSource` keeps a `#Collaboration` fact apart from a
   * classifier's judgement. Historic `'human'` rows are excluded for the same reason — those
   * buttons are gone, and attributing an operator's decision to the model would be a lie in
   * the audit direction.
   *
   * Capped at 30. This is context for "where did these prospects come from", not an inventory,
   * and an unbounded list on a CEO's page becomes something nobody reads.
   */
  const recentDecisions = await prisma.brandLookup.findMany({
    where: { decidedBy: 'model' },
    orderBy: { updatedAt: 'desc' },
    take: 30,
  })
  const autoDecided: AutoDecidedBrandCard[] = recentDecisions.map((r) => ({
    handle: r.handle,
    /**
     * BRAND is the only outcome that creates a prospect, so everything else is "left alone".
     *
     * Deliberately NOT reported as "not a company": PERSON and UNRESOLVED are different facts
     * and neither is proof of a negative. What an operator needs to know is that nothing was
     * messaged and nothing is waiting on them — which is true of both, and which is the safe
     * direction this codebase has failed to hold five times.
     */
    outcome: r.kind === 'BRAND' ? ('company' as const) : ('left-alone' as const),
    reason: r.modelReason,
    confidence: r.modelConfidence,
  }))

  const newBrandTouchesUsed = await prisma.outreachAttempt.count({
    where: {
      touchNumber: 1,
      status: { in: [...DELIVERED_STATUSES] },
      sentAt: { gte: istDayStart() },
      pair: { target: { kind: 'BRAND' } },
    },
  })

  return {
    confirmed,
    confirmedTotal: brandTotal,
    autoDecided,
    newTouchCap: settings.maxNewBrandTouchesPerDay,
    newTouchesUsedToday: newBrandTouchesUsed,
  }
}

/**
 * Which channels are stored but never judged, and WHY.
 *
 * The reason string comes from the detector's own `readiness()`, so a channel whose
 * classifier lacks an API key says exactly that instead of contributing a silent 0
 * to "paid campaigns spotted". A metric of 5 that describes one channel out of five
 * is not wrong so much as unreadable, and the page has to be able to say so.
 */
async function buildDetectionHealth(
  targets: Array<{ handle: string; displayName: string; detectorKey: string }>,
  degradedRuns: number,
): Promise<DetectionHealth> {
  const unclassifiedChannels: DetectionHealth['unclassifiedChannels'] = []
  for (const t of targets) {
    // Asks the detector, rather than special-casing `key === 'passthrough'` here.
    // A hardcoded key check is a fact stated in the wrong file, and it stops being
    // true the moment a second non-judging detector exists.
    const r = getDetector(t.detectorKey).readiness?.() ?? { ready: true }
    if (!r.ready) {
      unclassifiedChannels.push({ name: operatorName(t.displayName), handle: t.handle, reason: r.reason ?? 'not configured' })
    }
  }
  return {
    unclassifiedChannels,
    degradedRuns,
    anyClassifying: unclassifiedChannels.length < targets.length,
  }
}

/**
 * A run in progress must not be reported as a finished one.
 *
 * `ScrapeRun` is created with zeros at the start of a slot and updated at the end, and the
 * caller reads the newest row by `startedAt` — so for the ~60s a slot takes, the header
 * rendered "Last check read 0 posts · 0 new". Zero posts parsed is supposed to be an ALARM
 * (60 parsed / 0 paid is a quiet day; 0 parsed means the parser broke), so the one number
 * that must never appear falsely was appearing four times a day. Observed 2026-08-03: the
 * same row read 0 at 11:01 and 168 at 11:03.
 *
 * Extracted in step C so Today and Channels cannot phrase this differently.
 */
function lastCheckLabelFor(run: { finishedAt: Date | null; postsSeen: number; newPosts: number } | null): string {
  return !run
    ? 'No check has run yet'
    : run.finishedAt === null
      ? 'Checking the channels now…'
      : `Last check read ${run.postsSeen} posts · ${run.newPosts} new`
}

// ── formatting ───────────────────────────────────────────────────────────────

function timeOnly(at: Date): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: env.TZ,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(at)
}


function dayLabel(dateKey: string): string {
  const today = istDateKey()
  const yesterday = istDateKey(daysAgo(1))
  if (dateKey === today) return 'Today'
  if (dateKey === yesterday) return 'Yesterday'
  const [y, m, d] = dateKey.split('-').map(Number)
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' }).format(
    new Date(Date.UTC(y!, m! - 1, d!)),
  )
}

function nextSlotLabel(): string {
  const now = new Date()
  const dayStart = istDayStart(now)
  const mins = Math.floor((now.getTime() - dayStart.getTime()) / 60_000)
  const parsed = env.SLOTS.map((s) => {
    const [hh, mm] = s.split(':').map(Number)
    return { slot: s, minutes: hh! * 60 + mm! }
  }).sort((a, b) => a.minutes - b.minutes)

  const upcoming = parsed.find((p) => p.minutes > mins)
  if (upcoming) {
    const delta = upcoming.minutes - mins
    const inWords = delta >= 60 ? `${Math.floor(delta / 60)}h ${delta % 60}m` : `${delta}m`
    return `Next check today at ${upcoming.slot} · in ${inWords}`
  }
  return `Next check tomorrow at ${parsed[0]!.slot}`
}
