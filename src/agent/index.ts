import { prisma } from '@/lib/db'
import { env } from '@/lib/env'
import { log, describeError } from '@/lib/logger'
import { dispatchTick, withSendLock } from '@/outreach/dispatcher'
import { deviceId } from './claim'
import { profileStatus } from '@/outreach/browser/profile'
import { reconcileSessionRecords } from './reconcile'
import { autoResolveBrands } from '@/detection/autoResolve'
import { discoverOfficialPages } from '@/detection/officialDiscovery'
import { badgeDoorPass } from '@/detection/badgeDoor'
import { checkForReplies } from '@/outreach/replyCheck'
import { getSettings } from '@/lib/settings'

/**
 *   pnpm agent:device
 *
 * THE PROCESS THAT RUNS ON A USER'S OWN MACHINE AND DOES THE SENDING.
 *
 * ── IT IS A LOOP AROUND `dispatchTick`, NOT A SECOND SEND PATH ──────────────
 *
 * The obvious shape — poll for work, claim it, drive a browser, write back — would be a
 * FIFTH implementation of "may this message be sent now", after `deliverWaiting`,
 * `sendNow`, the planner and the on-demand dialog. This codebase has watched that exact
 * drift four times (`gate.ts` where deliverWaiting checked eight conditions and sendNow
 * three; `readThread.ts`; the two Connect buttons; the frame check that 166 saved frames
 * proved was never running). A fifth copy on the machine that actually talks to Instagram
 * would be the worst place yet for it.
 *
 * So the agent adds NO send logic. `dispatchTick` already: asks whether the fleet may send
 * at all (circuit breaker, autopilot, active hours, the gap), decides whose turn it is,
 * reads the conversation before a follow-up, claims atomically, holds the fleet-wide send
 * lock, and re-runs `gate.ts` at delivery. Every one of those guards applies here for
 * free, and a change to any of them reaches the device without anyone remembering to
 * copy it.
 *
 * What the agent contributes is exactly two things the server cannot do:
 *
 *   1. It runs where the Chrome profiles are.
 *   2. It says so, so the dashboard can tell a user their device is offline rather than
 *      leaving "nothing has sent" unexplained — the failure this project keeps finding.
 *
 * ── WHY THE SERVER CANNOT DO THIS ───────────────────────────────────────────
 *
 * A send drives a Chrome profile logged in BY HAND from a home IP. That login wrote
 * durable device identifiers (`mid`, `ig_did`, `ig-u-rur`) and a login event binding the
 * browser to the account from that network. Copying the profile to a datacenter is a
 * session transplant in all but name: `sessionid` is a bearer token with no channel
 * binding, so it WORKS — right up until enforcement lands silently. Research established
 * device + network continuity as a pass/fail gate, not a score.
 *
 * `SEND_ENABLED=false` on the server is the hard floor that makes this structural rather
 * than a convention, and it is checked here before anything else.
 *
 * ── A POWERED-OFF DEVICE CANNOT SEND, AND NOTHING PRETENDS OTHERWISE ────────
 *
 * Closing the dashboard tab is fine; the tab was never the sender. A machine that is off
 * has no browser and no session, and the only ways around that are the transplant above.
 * So drafts WAIT — they stay READY, the dashboard shows when this device was last seen,
 * and they go out when it comes back, under the ordinary pacing rules. Nothing is lost,
 * nothing is dropped, and nothing is rushed on return: a device reconnecting after a day
 * must not empty its queue into one inbox, which is the recipient-side pattern the whole
 * dispatcher design exists to avoid. `dispatchTick` enforces that for us.
 */

/**
 * How often the device asks whether there is anything to send.
 *
 * 30 SECONDS SINCE 2026-08-19, because the fleet gap became ONE minute the same day and
 * the poll interval is the real ceiling: one send per tick means a 60-second poll delivers
 * at best every 60s, and on average waits half a poll past the moment the gap clears.
 *
 * ── AND THE CLAIM THIS DOCBLOCK USED TO MAKE WAS FALSE (measured 2026-08-22) ──
 *
 * It said "at 30s the gap is what paces the fleet rather than this timer, which is where
 * the decision belongs". It was not: the loop slept 30 s AFTER each tick, so the wait was
 * additive to the ~47 s a send spends driving a browser, and the true period was **77 s**
 * (473 intervals: min 73, p50 77, p90 81). The timer was pacing the fleet and the gap was
 * inert — a false invariant stated in a comment, which is why nobody looked.
 *
 * The loop now sleeps only the REMAINDER of this interval, so a tick that took longer than
 * 30 s comes straight back and `pacing.ts` decides — which is what this paragraph always
 * claimed. Keep it that way; the number here is a POLL FLOOR for idle ticks, not the pace.
 *
 * It does NOT widen anything: `dispatchTick` still sends at most one message, still asks
 * every guard, and still refuses anything inside `fleetMinGapMinutes` of the last send's
 * start. A tick with nothing to do is a handful of cheap queries.
 */
const POLL_INTERVAL_MS = 30_000

/** Written this often so the dashboard can say how long a device has been away. */
const PRESENCE_INTERVAL_MS = 30_000

/**
 * ── BRAND DISCOVERY RUNS HERE NOW, BECAUSE HERE IS THE HOME IP ─────────────
 *
 * MEASURED 2026-08-12 and unchanged since: Instagram 429s the Linode on the profile
 * endpoint while answering the same handles from this Mac seconds later. So
 * `autoResolveBrands` at the end of every server detect pass halts on its first lookup,
 * forever, and the only thing that ever created a prospect was a person typing
 * `pnpm ig:brands --run` here.
 *
 * That is the shape this codebase has been bitten by repeatedly — *a feature that works
 * only when someone runs a command is not running* (166 cover frames saved and never
 * read). Tabish, 2026-08-18: *"this should run automatically, nothing should be manually
 * run."* So the device agent runs the pass on its own clock.
 *
 * It is the SAME function the server calls, not a copy: one bound, one ordering, one
 * cache, one set of safety rules. It spends no browser and drives nothing — HTTP lookups
 * against a public endpoint — so it runs on its own timer rather than inside the send
 * tick, where six-second spacing would delay delivery by minutes.
 */
const BRAND_INTERVAL_MS = 30 * 60_000

/**
 * Lookups per pass. Higher than the server's 10 because this host is not throttled and
 * the pass is half-hourly rather than every fifteen minutes — but still BOUNDED, because
 * the endpoint is undocumented, politeness is a 6s gap between lookups, and an unbounded
 * pass here would be a burst against the one IP every account also logs in from.
 */
const BRAND_LOOKUPS_PER_PASS = 25
/**
 * ── THE OLD JUSTIFICATION FOR 5 WAS MEASURABLY WRONG, AND IT BOUNDED THE LEAD FUNNEL ──
 *
 * This used to read "shares the same throttled endpoint as the brand pass above". It does
 * not. MEASURED 2026-08-23: the brand pass calls `resolveBrand` → `web_profile_info`, the
 * endpoint that 429s a datacenter IP; official discovery calls `enrichHandle` → the anonymous
 * FEED endpoint (`i.instagram.com/api/v1/feed/user/<h>/username/`), which answers on ANY host
 * and is the same one detection already hits ~5,000 times a day across 13 channels. The
 * badge door, right below, was given 10 on that same feed endpoint.
 *
 * So a false premise had been capping the one pass whose whole job is recovering leads —
 * "paid posts are blatantly missing company tags", in Tabish's words.
 *
 * The population also grew when discovery stopped skipping posts that assert a handle:
 * **303 brand names per pass → 947**. At 5 lookups per 30 minutes that is ~240 a day and
 * about four days to work through once; at 15 it is ~720 a day and under a day and a half.
 * The drain is one-off — a name that resolves or fails leaves the pool — so this buys the
 * initial sweep, not a permanently higher rate.
 *
 * THE EXPOSURE, STATED: ~480 extra anonymous feed requests a day on top of detection's
 * ~5,000. Nothing about the SAFETY of what gets created changes — `isOfficialMatch` is
 * untouched, so the badge bar still decides, and a junk name still costs one lookup and a
 * printed line. **If a 429 ever appears on the feed endpoint, lower this first.**
 */
/*
  RAISED 15 → 40 on 2026-08-25, and the reason is that the queue behind it got much deeper.
  `captionEntities` took the harvest from 987 distinct names to **2,810** across the in-window
  corpus — every person and production company a paid post names, not just the film being
  sold. Tabish: *"Monitoring must be aggressive and accurate."*

  THE TRADE, STATED: 40 lookups every 30 minutes is ~1,920/day against an undocumented,
  throttled profile endpoint, from the one home IP every account also logs in from. Politeness
  is still a 6s gap, so a full pass is ~4 minutes of lookups inside a 30-minute window, and
  `autoResolveBrands` (25) shares the same endpoint. A real 429 HALTS the pass rather than
  continuing — that guard is what makes raising this recoverable rather than a gamble.

  **If a 429 ever appears, lower this first.** Frequency ordering is what makes the raise worth
  it rather than just louder: a name on 56 paid posts is looked up before one named once, so
  the budget buys the best leads first however long the tail is.
*/
const OFFICIAL_LOOKUPS_PER_PASS = 40
/** Badge checks per brand pass — the FEED endpoint, 6s spacing inside the pass. */
const BADGE_ENRICHMENTS_PER_PASS = 10

/**
 * ── THE REPLY SWEEP RUNS HERE NOW, BECAUSE HERE IS WHERE THE SESSIONS ARE ──
 *
 * MEASURED 2026-08-18 and again 2026-08-19: `replyCheckedAt` was non-null on ZERO
 * attempts, ever. The 11:00/20:00 sweep is scheduled inside `runSlot` on the LINODE,
 * which has no `~/.ds-sales-agent` at all — so it fired twice a day, found every
 * account signed out, and skipped every conversation. The same hosted-split shape as
 * brand discovery above, fixed the same way: the SAME function the server calls
 * (`checkForReplies` — one implementation, its caps and checkpoint handling intact),
 * on the machine whose disk actually holds the profiles. Tabish, 2026-08-19: "Make
 * sure replies are being detected."
 *
 * Three properties keep it from costing sends:
 *
 *   1. It holds the fleet-wide SEND LOCK while it reads. Reading drives the same
 *      Chrome profiles the send path drives, and two contexts on one profile is how
 *      cookies get corrupted. A dispatch tick that lands mid-sweep returns
 *      `lockBusy` and loses nothing — the next tick is sixty seconds away.
 *   2. It is bounded (MAX_REPLY_CHECKS_PER_RUN conversations per pass) and half-hourly,
 *      so the worst case is a few minutes of read time per half hour.
 *   3. It runs inside active hours only. Reading is lower-risk than sending, but a
 *      browser touring conversations at 03:00 from an Indian business page is a
 *      behavioural signal for no benefit — the old slot times were daytime too.
 */
const REPLY_INTERVAL_MS = 30 * 60_000

/** `Setting` key holding the last time each device checked in. */
export const DEVICE_PRESENCE_KEY = 'devicePresence'

export interface DevicePresence {
  device: string
  at: string
  /** Which accounts this device holds a logged-in Chrome profile for. */
  handles: string[]
}

/**
 * Which sending accounts THIS machine can actually drive.
 *
 * Asked of the disk, not of the database. `SenderAccount.status` is what the server
 * believes; a profile directory with a session in it is what this machine can prove. When
 * they disagree the disk wins here, because the disk is what the browser will find.
 */
export async function localSenderHandles(): Promise<string[]> {
  const senders = await prisma.senderAccount.findMany({ select: { handle: true } })
  return senders.filter((s) => profileStatus(s.handle).hasSession).map((s) => s.handle)
}

/**
 * Record that this device is here, and which accounts it can send from.
 *
 * Merged into one Setting row keyed by device name, so several people's machines can be
 * present at once without a schema change. A device that stops writing simply goes stale,
 * exactly like the scheduler heartbeat — and staleness is reported rather than inferred,
 * because "no message has gone out" with no reason is the failure this project keeps
 * rediscovering.
 */
export async function writePresence(handles: string[]): Promise<void> {
  const me: DevicePresence = { device: deviceId(), at: new Date().toISOString(), handles }
  const row = await prisma.setting.findUnique({ where: { key: DEVICE_PRESENCE_KEY } })

  let all: DevicePresence[] = []
  if (row) {
    try {
      const parsed = JSON.parse(row.value)
      if (Array.isArray(parsed)) all = parsed as DevicePresence[]
    } catch {
      // A corrupt row is replaced rather than allowed to stop this device reporting in.
      all = []
    }
  }

  const next = [...all.filter((d) => d.device !== me.device), me]
  const value = JSON.stringify(next)
  await prisma.setting
    .upsert({ where: { key: DEVICE_PRESENCE_KEY }, update: { value }, create: { key: DEVICE_PRESENCE_KEY, value } })
    .catch(() => undefined) // presence must never take the agent down
}

/** Every device the dashboard knows about, freshest first. */
export async function readPresence(): Promise<DevicePresence[]> {
  const row = await prisma.setting.findUnique({ where: { key: DEVICE_PRESENCE_KEY } })
  if (!row) return []
  try {
    const parsed = JSON.parse(row.value)
    if (!Array.isArray(parsed)) return []
    return (parsed as DevicePresence[]).sort((a, b) => b.at.localeCompare(a.at))
  } catch {
    return []
  }
}

let stopping = false

/**
 * One brand pass at a time on this machine.
 *
 * A pass can outlive its interval — 25 lookups at 6s spacing is up to 2.5 minutes, and a
 * slow endpoint makes it longer — so without this a stalled pass would have a second one
 * started on top of it, both spending the same lookup budget against the same throttled
 * endpoint. In-process is the right scope: the bound this protects is per host.
 */
let brandPassRunning = false

async function brandPass(): Promise<void> {
  if (brandPassRunning) {
    log.step('brand discovery is still running from the last pass — skipping this one')
    return
  }
  brandPassRunning = true
  try {
    const summary = await autoResolveBrands({ maxLookups: BRAND_LOOKUPS_PER_PASS })
    /**
     * Logged EVERY pass, including the empty one. "Nothing was discovered" and "the pass
     * never ran" are different facts and this is the only place that can tell them apart —
     * the same reason the dispatcher reports what it held rather than going quiet.
     */
    log.info('brand discovery pass', {
      looked: summary.looked,
      created: summary.decided,
      unsure: summary.skippedUnsure,
      unreached: summary.unreached,
      haltedEarly: summary.haltedEarly,
      awaitingRetry: summary.awaitingRetry,
    })

    /**
     * AND THE LEADS NOBODY TAGGED, on the same timer (Tabish, 2026-08-20: "we cannot lose
     * leads in posts with no tags").
     *
     * MEASURED that morning: 172 in-window CAMPAIGN posts assert no handle at all and by
     * design produced no prospect. It runs HERE rather than behind `pnpm ig:find-official`
     * alone for the reason this repo has paid for twice — a feature that works only when
     * someone runs a command is not running — and on THIS host because the profile endpoint
     * answers a home IP and 429s the Linode.
     *
     * Bounded small (5 lookups) because it shares one scarce endpoint with the pass above
     * and runs every 30 minutes; the badge bar means a pass that finds nothing is the normal
     * case, not a fault. It can never fail the agent: the catch below covers both passes.
     */
    const official = await discoverOfficialPages({ maxLookups: OFFICIAL_LOOKUPS_PER_PASS })
    if (official.needsHuman.length > 0) {
      log.step('untagged paid posts resolved to accounts that FAILED the verified bar — a person decides', {
        count: official.needsHuman.length,
        examples: official.needsHuman.slice(0, 3).join(' | '),
      })
    }

    /**
     * AND THE BADGE DOOR, same timer, same reasoning (2026-08-21). Handles a paid post
     * ASSERTED whose lookup settled as PERSON/UNRESOLVED/MISSING never had their badge
     * actually checked — measured: 192 of 280 asserted handles sat permanently refused,
     * @amazonmgmstudiosin among them, while the column Tabish read said "nobody
     * verified". Bounded small; the FEED endpoint it uses answers on any host, but it
     * runs here beside its siblings so one timer owns the lead funnel. It admits only on
     * the badge (VERIFIED ONLY), so a pass that admits nobody is the normal case.
     */
    const badge = await badgeDoorPass({ maxEnrichments: BADGE_ENRICHMENTS_PER_PASS })
    if (badge.enriched > 0 || badge.admitted > 0) {
      log.info('badge-door pass', {
        candidates: badge.candidates,
        enriched: badge.enriched,
        admitted: badge.admitted,
        refusedUnverified: badge.refusedUnverified,
        unreachable: badge.unreachable,
        // A bounded pass that hides what it skipped reads as "covered everything" —
        // this is how many eligible candidates sat out the pass on a failure cooldown.
        coolingOff: badge.coolingOff,
      })
    }
  } catch (err) {
    /**
     * Never allowed to take the agent down, exactly like the detect-pass rule: discovering
     * prospects is upstream of sending, and a failure here must not stop messages that are
     * already written from going out.
     */
    log.error('brand discovery pass failed', { error: describeError(err) })
  } finally {
    brandPassRunning = false
  }
}

/** One reply sweep at a time on this machine — same reasoning as `brandPassRunning`. */
let replyPassRunning = false

/**
 * EXPORTED FOR ONE REASON: `tests/autopilot-off-drives-no-browser.test.ts` drives this
 * function directly and asserts that `checkForReplies` is NEVER reached with the switch
 * off. The first version of that test was a source grep, and mutation-testing it showed
 * the grep passing against the exact edit that matters — deleting the early return still
 * left the word `autopilotEnabled` above the read. A grep proves a fact is CONSULTED; only
 * calling the function proves it GATES. Exporting it is the cheaper of the two costs.
 */
export async function replyPass(): Promise<void> {
  if (replyPassRunning) {
    log.step('the reply sweep is still running from the last pass — skipping this one')
    return
  }

  /**
   * ── AUTOPILOT OFF MEANS NO UNATTENDED BROWSER, NOT JUST NO SEND (2026-08-20) ──
   *
   * OBSERVED BY TABISH, and it is the only report that matters here: he switched autopilot
   * off, and Chrome windows kept opening on his revenue accounts in front of him. He was
   * right, and every layer below was behaving "correctly": the dispatcher held with
   * `autopilot-off` on every tick, ZERO messages were delivered after the switch — and
   * this sweep drove a real browser into a real account every thirty minutes anyway,
   * around the clock, because reading is not sending and nothing here asked the switch.
   *
   * That distinction is real inside the code and worthless outside it. The one control the
   * product offers has to mean *"stop touching my accounts"*, because that is what a person
   * pressing it believes it means — and a browser touring conversations from a revenue page
   * is exactly the unattended activity they were stopping. CLAUDE.md predicted this exact
   * exposure when the sweep was still on the server: moving it to the device "means
   * unattended browser sessions against revenue accounts, which is an exposure change to
   * decide rather than to slip in". It was slipped in.
   *
   * NOTHING IS LOST BY GATING IT, and that is what makes this the conservative direction
   * rather than a trade:
   *
   *   - The sweep exists to stop a queued follow-up landing in a live conversation. With
   *     autopilot off no follow-up can land at all, so the guard has nothing to guard.
   *   - `ensureConversationChecked` still reads the exact thread immediately before every
   *     follow-up once autopilot is back on. That is the design's own "real answer" —
   *     coverage proportional to messages sent rather than to prospects held.
   *   - A reply that arrives while the switch is off is still recorded by the first sweep
   *     after it goes back on, before anything is delivered.
   *
   * FAILS CLOSED. An unreadable settings row means the switch cannot be confirmed ON, and
   * "we could not ask" must never authorise driving a browser — the same direction as
   * `identify()`'s `no-answer`, which this codebase already paid for once by recording a
   * live session as dead.
   */
  let autopilotOn = false
  try {
    autopilotOn = (await getSettings()).autopilotEnabled
  } catch (err) {
    log.warn('could not read the autopilot switch — the reply sweep stays put', {
      error: err instanceof Error ? err.message : String(err),
    })
    return
  }
  if (!autopilotOn) {
    log.step('autopilot is off — the reply sweep opens no browser (replies are read again when it is on)')
    return
  }

  // No active-hours gate since 2026-08-19: Tabish removed the time window for sending AND
  // checking, so replies are read around the clock too.
  replyPassRunning = true
  try {
    const summary = await withSendLock('reply-sweep', () => checkForReplies())
    if (summary === null) {
      // A send holds the lock. Nothing is lost: the next pass is half an hour away and
      // the just-in-time check still reads any thread a follow-up is about to land in.
      log.step('a send is in progress — the reply sweep waits for the next pass')
      return
    }
    /**
     * Logged every pass, including the empty one — "nothing new" and "the sweep never
     * ran" are different facts, and for reply detection that difference was invisible
     * for eleven days.
     */
    log.info('reply sweep', {
      checked: summary.checked,
      repliesFound: summary.repliesFound,
      unreadable: summary.unreadable,
      incomplete: summary.incomplete,
      deferred: summary.deferred,
    })
  } catch (err) {
    // Never allowed to take the agent down: reply reading is a guard, and a guard
    // failing must not stop the deliveries it guards.
    log.error('reply sweep failed', { error: err instanceof Error ? err.message : String(err) })
  } finally {
    replyPassRunning = false
  }
}

async function tick(): Promise<{ retryInMs?: number }> {
  const handles = await localSenderHandles()
  await writePresence(handles)

  /**
   * A hand login the Connect poll missed is recorded here, by the machine that can prove
   * it — otherwise /senders says "signed in" (filesystem) while rotation says "never
   * signed in" (database) and no draft is ever written for the account. Measured, not
   * hypothetical: @madaboutmarketingg, 2026-08-17. See src/agent/reconcile.ts.
   */
  await reconcileSessionRecords(handles)

  if (handles.length === 0) {
    // Not an error, and said plainly: a machine with no signed-in profile has nothing to
    // do, and the dashboard will show it as present-but-empty rather than silently idle.
    log.step('no signed-in Instagram profiles on this device — nothing to send from')
    return {}
  }

  /**
   * `dispatchTick` decides everything else, including whether now is a permitted time and
   * whether any of it is this device's business. It sends AT MOST ONE message, which is
   * the fleet's pacing rule and not something the agent may relax.
   */
  const result = await dispatchTick('device')
  return { retryInMs: result.retryInMs }
}

export async function runDeviceAgent(): Promise<void> {
  /**
   * THE HARD FLOOR, CHECKED FIRST. A server must never reach the browser code — not
   * because it would work badly, but because the profiles that make it work cannot
   * legitimately be there. Environment only, exactly like `AUTOPILOT_ENABLED`, so a
   * dashboard cannot switch it on.
   */
  if (!env.SEND_ENABLED) {
    log.alarm('SEND_ENABLED=false — this machine is not allowed to send, and the agent will not start')
    log.info('that is correct on the server: Instagram sessions live on a person\'s own machine, never here')
    return
  }

  const handles = await localSenderHandles()
  log.info('device agent starting', {
    device: deviceId(),
    accounts: handles.length > 0 ? handles.join(', ') : '(none signed in yet)',
    pollSeconds: POLL_INTERVAL_MS / 1000,
  })

  const presence = setInterval(() => {
    void localSenderHandles().then(writePresence).catch(() => undefined)
  }, PRESENCE_INTERVAL_MS)
  presence.unref?.()

  /**
   * Brand discovery, on its own clock and NOT gated on autopilot: finding out which
   * companies bought a placement is reading public data, not writing to anyone. The
   * queue can only grow when a prospect exists, so gating discovery on the send switch
   * would mean turning autopilot on to a queue that had stopped being filled hours ago.
   *
   * Fired once at startup as well as on the interval, so a restart does not mean waiting
   * half an hour for the first pass.
   */
  void brandPass()
  const brands = setInterval(() => void brandPass(), BRAND_INTERVAL_MS)
  brands.unref?.()

  /**
   * The reply sweep, on its own clock like brand discovery, and NOT gated on autopilot:
   * a reply to a hand-sent message halts outreach exactly the same way, and the halt is
   * only as good as the last time anything looked. Fired once at startup so a restart
   * does not mean half an hour of unwatched conversations.
   */
  void replyPass()
  const replies = setInterval(() => void replyPass(), REPLY_INTERVAL_MS)
  replies.unref?.()

  while (!stopping) {
    /**
     * ── THE POLL IS A PERIOD, NOT IDLE TIME AFTER A SEND (2026-08-22) ────────
     *
     * This was `await tick()` then an unconditional `sleep(POLL_INTERVAL_MS)`, which makes
     * the wait ADDITIVE to whatever the tick just did. A tick that delivers a message takes
     * ~47 s of browser driving, so the real period was 47 + 30 = **77 s** — measured over
     * 473 consecutive intervals: min 73 s, p50 77 s, p90 81 s, 439 of them inside 90 s. A
     * distribution that tight is an equation, not jitter.
     *
     * So `fleetMinGapMinutes = 1` could not produce a one-minute cadence at any value: the
     * loop added half a minute to every send after the gap had already been satisfied. That
     * is EXACTLY the defect fixed one layer up the day before — the gap was being measured
     * from a send's completion instead of its start — surviving in the sleep that wraps it,
     * and this file's own docblock claimed the opposite ("at 30s the gap is what paces the
     * fleet rather than this timer"). A false invariant in a comment is how it went unseen.
     *
     * Sleeping only the REMAINDER fixes it structurally rather than by picking a smaller
     * number: after a 47 s send the remainder is zero, the loop comes straight back, and
     * `dispatchTick` — which still refuses anything inside `fleetMinGapMinutes` of the last
     * send's START — becomes the thing that decides, which is where the decision belongs.
     * An idle tick costs a handful of queries and still waits its full 30 s, so polling gets
     * no busier when there is nothing to send.
     *
     * ── AND THE REMAINDER ALONE WAS STILL 77 s, MEASURED THE SAME DAY ────────
     *
     * The first live interval after the remainder fix: 77 s again. The additive sleep was
     * gone; the GRID remained. A ~47 s drive puts the immediate next tick at +47 s — held,
     * 13 s before the gap clears — and the tick after on the 30 s grid at +77 s. "Expected
     * ~60 s" had been written without walking that arithmetic, and one measured interval
     * disproved it. So on a `too-soon` hold the dispatcher now RETURNS when the gap clears
     * (`retryInMs`, computed from the same clock the refusal read), and the loop sleeps
     * exactly that long instead of its grid step. The decision still lives in the
     * dispatcher; the loop just stops overshooting the boundary it cannot see.
     *
     * IT CANNOT SEND FASTER THAN THE GAP. The gap is a hard refusal inside the tick, not a
     * property of this sleep; waking exactly at the boundary cannot cross it — the tick at
     * the boundary re-asks every rule. `fleetMinGapMinutes = 2` remains the one-write
     * lever back to a slower fleet, and autopilot OFF still stops everything.
     */
    const startedAt = Date.now()
    let retryInMs: number | undefined
    try {
      const r = await tick()
      retryInMs = r.retryInMs
    } catch (err) {
      // One bad tick must never end the loop: the device going quiet is the failure this
      // whole process exists to prevent.
      log.error('device tick failed', { error: describeError(err) })
    }
    const remaining = POLL_INTERVAL_MS - (Date.now() - startedAt)
    /* The dispatcher's own boundary wins when it is sooner than the grid — never later:
       a hint may only ever wake us EARLIER, so a wrong hint degrades to the plain poll. */
    const wait = retryInMs !== undefined ? Math.min(Math.max(remaining, 0), Math.max(retryInMs, 0)) : remaining
    if (wait > 0) await new Promise((r) => setTimeout(r, wait))
  }

  clearInterval(presence)
  clearInterval(brands)
  clearInterval(replies)
}

export function stopDeviceAgent(): void {
  stopping = true
}
