import { prisma } from './db'
import { REPLY_RESUME_HOURS_DEFAULT } from '@/outreach/replyHalt'
import { env } from './env'
import {
  FLEET_MAX_PER_DAY,
  FLEET_MAX_PER_HOUR,
  FLEET_MIN_GAP_MINUTES,
  MAX_SENDS_PER_TICK,
} from '@/outreach/pacing'

/**
 * Runtime-editable settings, stored in the Setting table so /settings can change
 * behaviour without a redeploy. Env provides the defaults.
 *
 * Cooldown lives here rather than only in env because it is the knob most likely
 * to be tuned after watching real replies — and tuning it should not require SSH.
 */

export const SETTING_KEYS = {
  defaultCooldownDays: 'defaultCooldownDays',
  maxPerTargetPerDay: 'maxPerTargetPerDay',
  hookMaxAgeHours: 'hookMaxAgeHours',
  autopilotEnabled: 'autopilotEnabled',
  maxNewBrandTouchesPerDay: 'maxNewBrandTouchesPerDay',
  maxWaitingNewBrandDrafts: 'maxWaitingNewBrandDrafts',
  personaGateChannels: 'personaGateChannels',
  fleetMaxPerHour: 'fleetMaxPerHour',
  fleetMaxPerDay: 'fleetMaxPerDay',
  fleetMinGapMinutes: 'fleetMinGapMinutes',
  maxSendsPerTick: 'maxSendsPerTick',
  generateMessages: 'generateMessages',
  singleTemplate: 'singleTemplate',
  tagsAsEvidence: 'tagsAsEvidence',
  replyResumeHours: 'replyResumeHours',
} as const

export interface RuntimeSettings {
  defaultCooldownDays: number
  maxPerTargetPerDay: number
  hookMaxAgeHours: number
  /**
   * THE switch. ONE SWITCH, 2026-08-08 — this comment used to read "a sender also needs its
   * own autoSendEnabled", and that per-account bit is no longer consulted by anything.
   * Autopilot on plus a usable session is the whole contract now; the only per-account gate
   * left is the cohort ladder, asked at delivery by `gate.ts`.
   */
  autopilotEnabled: boolean
  /**
   * How many brands may be contacted for the FIRST time in one IST day.
   *
   * Separate from `SenderAccount.dailyCap` because they protect different things:
   * dailyCap protects the ACCOUNT (Instagram's per-sender spam heuristics), this protects
   * the PATTERN. Ten first-touches in an afternoon and ten across ten days are the same
   * volume and look nothing alike — the first is indistinguishable from a scraped list
   * being worked through.
   *
   * It exists because brand outreach is the first thing here that grows its own target
   * list: two channels today, then one more prospect for every paid post, forever.
   */
  maxNewBrandTouchesPerDay: number
  /**
   * How many first-touch brand drafts may WAIT at once. A DEPTH, not a daily rate.
   *
   * Separate from `maxNewBrandTouchesPerDay` since 2026-08-17. A draft reaches nobody, so a
   * daily cap on writing guards nothing a recipient sees — and while the two shared one
   * number, the delivery cap could never be reached, because creation was checked first and
   * stopped the queue growing before any of it went out.
   *
   * Generous on purpose: discovering two hundred companies should fill the queue and stop,
   * not stall drafting for a day. It is a runaway backstop for a planner that runs 96 times
   * a day, not a safety rule about strangers' inboxes — that one is the delivery cap.
   */
  maxWaitingNewBrandDrafts: number

  /**
   * Does the persona gate cover CHANNEL sends, not just brand sends?
   *
   * Decision 6, taken by Tabish 2026-08-04. At 65 accounts, 63 pages emitting one
   * byte-identical contact block is the cross-account fingerprint decision 3 exists to
   * prevent — and rotation makes it worse in the specific way that matters, because the
   * whole point is that a recipient hears from a different page each time and an
   * identical signature underneath every one announces they are one operation.
   *
   * Defaults ON, which currently halts ALL outreach: every account still says *Kapil
   * Jain, Co-founder, Bollywood Society*. Tabish accepted that consequence. It is a
   * setting rather than a constant so whoever is mid-way through editing 63 personas can
   * finish without the gate whipsawing.
   */
  personaGateChannels: boolean

  /**
   * ── FLEET PACING, Phase 5 ─────────────────────────────────────────────
   *
   * `fleetMaxPerHour` shapes WHEN messages go out. Nothing is refused by it — a draft it
   * declines stays READY with its Send button and the next hour takes it. At 3/hour
   * across the 10:00-21:00 window that is ~33/day of headroom against a measured need of
   * 11-14, so at today's volume it never binds; it exists so fourteen drafts cannot leave
   * inside one hour from fourteen different pages into one inbox.
   *
   * `fleetMaxPerDay` is a SYSTEM-WIDE CAP, and Tabish decided there is none — so it
   * defaults to unlimited and the number is his to set, not mine to choose. The mechanism
   * is built and wired because the alternative is needing a code change to stop the fleet.
   */
  fleetMaxPerHour: number
  fleetMaxPerDay: number
  /** Minimum minutes between two fleet sends. Stops serialised sends becoming a cluster. */
  fleetMinGapMinutes: number
  /** Sends per dispatcher tick. 1 means spacing is a property of the schedule. */
  maxSendsPerTick: number
  /**
   * Hours a reply pauses its target before automated messaging resumes on its own.
   * Tabish's decision, 2026-08-07, made after the risk was stated: no manual release —
   * a reply halts for a day, then outreach resumes. "Mark as handled" survives only as
   * an early release. The old behaviour (halt until a human acts) is one Setting row
   * away: any very large number.
   */
  replyResumeHours: number

  /**
   * ── PHASE 8: may a MODEL write the message body? ──────────────────────
   *
   * Defaults FALSE, so Phase 8 ships as a no-op: with it off, `composeForPair` behaves
   * byte-for-byte as it did before, taking a hand-written variant from the pool. Phase 3
   * shipped the same way and that is deliberate — a change to what a real prospect reads
   * should be switched on by a person, on a day they chose, not arrive with a deployment.
   *
   * The decision is not about money. Measured, generation is ~$0.0002/message and under
   * $10/year at 65x60. It is about a model writing the words in a DM to a real company,
   * where decision 3 has until now rested entirely on Tabish's own copy.
   *
   * When it IS on, a rejected or failed generation falls back to a hand-written variant.
   * There is no path where a body the gate refused gets sent anyway.
   */
  generateMessages: boolean

  /**
   * ── THE SINGLE TEMPLATE — NOW THE DEFAULT (2026-08-17, Tabish) ─────────
   *
   * *"The drafts sent today are undesired, no custom message is required whatsoever. Same
   * standard template message to be sent to them … The custom part must only be the target
   * name being mentioned."*
   *
   * Defaults TRUE since 2026-08-17. It was built in the simple-sender plan and left off for
   * Tabish to decide; he has decided. Turning it on knowingly reverses part of decision 3 —
   * Meta's written spam policy penalises REPETITION and merge-field templates do not count
   * as variation. **That risk is real and is stated rather than smoothed over:** at 1-2
   * messages a day it is small; at 65 accounts writing one template to overlapping
   * recipients it is the cross-account fingerprint decision 3 exists to prevent. Raise it
   * again before volume rises.
   *
   * When ON, every body is ONE template. Exactly two things vary: the recipient's name and
   * the sending page's name.
   *
   * THE OBSERVATION LINE WAS REMOVED IN THE SAME CHANGE. It named the paid post we saw, and
   * "the custom part must only be the target name" excludes it. Its docblock also claimed
   * that line was "what keeps the send guards working" — that was **false**, and measured
   * so: the hook line is matched by `ENVELOPE_PATTERNS` and can never be the needle, so the
   * guards never depended on it. What they actually depend on is the template having at
   * least two prose paragraphs, which `tests/single-template.test.ts` now asserts.
   *
   * With it OFF, composing behaves byte-for-byte as it did before the flag existed.
   */
  singleTemplate: boolean

  /**
   * ── TAGS AND CO-AUTHORS AS CLASSIFIER EVIDENCE — BUILT, MEASURED, OFF ──
   *
   * Defaults FALSE, and it is off because the harness said so, not because it is
   * unfinished. Turning it on is Tabish's decision and should be recorded as his.
   *
   * MEASURED 2026-08-13 with `pnpm ig:accuracy`, three runs on the same 77 posts:
   *
   *   | run                          | correct | recall | precision | false alarms |
   *   |------------------------------|---------|--------|-----------|--------------|
   *   | baseline, before any change  | 96%     | 100%   | 86%       | 3            |
   *   | new prompt, tags OFF         | 97%     | 100%   | 90%       | 2            |
   *   | new prompt, tags ON          | 95%     | 100%   | 83%       | 4            |
   *
   * RECALL NEVER MOVED — the one thing this project does not trade. What moved was
   * PRECISION, and it moved the WRONG WAY: 90% to 83% against the identical prompt, which
   * makes the tag INPUT the cause rather than the prompt edit. The mechanism is visible in
   * the model's own reasons for the two extra false alarms — *"American Eagle tagged"* and
   * *"co-authored by brand"*. That is the documented failure mode reproducing: treating
   * "@-tags the brand" as sufficient once cratered precision 85% to 71%, and it is smaller
   * here only because the prompt now explicitly forbids it.
   *
   * A false CAMPAIGN is not free. It becomes the hook of a real message to a real
   * prospect — "saw your X campaign" about something that was never a campaign — so this
   * failed the goal it was built for, which was to IMPROVE precision.
   *
   * ── WHY IT IS KEPT RATHER THAN DELETED ────────────────────────────────
   *
   * The measurement is on @madovermarketing_mom, the only channel with ground truth — and
   * `verdictSource` is `'rules'` on 79 of 79 of its posts, so THE MODEL NEVER RUNS THERE
   * IN PRODUCTION. The channels this input would actually affect are the semantic ones,
   * where tagging correlates with paid posts on two (@viralbhayani 21% of CAMPAIGN against
   * 6.9% of ORGANIC) and INVERTS on the third (@bollywoodchronicle 20% against 46.3%) —
   * and where there is no ground truth to measure any of it.
   *
   * So the honest position is: measured harm on a proxy, unmeasured effect where it would
   * run. Off is the conservative reading of that, and the code, the tests and the
   * `--tags` control on the harness stay so the question can be re-asked in one row rather
   * than re-implemented.
   *
   * With it OFF the user message is BYTE-IDENTICAL to what it was before any of this
   * existed, so nothing about classification changes — the same shipping shape as
   * `generateMessages` and `singleTemplate`.
   */
  tagsAsEvidence: boolean
}

function defaults(): RuntimeSettings {
  return {
    defaultCooldownDays: env.DEFAULT_COOLDOWN_DAYS,
    maxPerTargetPerDay: env.MAX_PER_TARGET_PER_DAY,
    hookMaxAgeHours: env.HOOK_MAX_AGE_HOURS,
    autopilotEnabled: env.AUTOPILOT_ENABLED,
    // 2, chosen by Tabish. At ~20 brands discovered per month the queue drains faster
    // than it fills, so queue depth on the dashboard stays a real signal.
    maxNewBrandTouchesPerDay: 2,
    maxWaitingNewBrandDrafts: 150,
    // ON. The safe direction is the one that refuses to send.
    personaGateChannels: true,
    fleetMaxPerHour: FLEET_MAX_PER_HOUR,
    // Unlimited. Tabish's decision, not an oversight — see the interface comment.
    fleetMaxPerDay: FLEET_MAX_PER_DAY,
    fleetMinGapMinutes: FLEET_MIN_GAP_MINUTES,
    maxSendsPerTick: MAX_SENDS_PER_TICK,
    // OFF. A model writing the words is Tabish's decision, and `pnpm ig:generate` is how to
    // read real generated messages before making it.
    generateMessages: false,
    // OFF. One template for every recipient reverses decision 3, so switching it on is
    // Tabish's call — recorded as his when he makes it.
    singleTemplate: true,
    // OFF, because the harness measured precision falling 90% -> 83% with it on while
    // recall held. See the interface comment for all three runs and why it is kept.
    tagsAsEvidence: false,
    // One day. Tabish's decision, 2026-08-07 — see the interface comment.
    replyResumeHours: REPLY_RESUME_HOURS_DEFAULT,
  }
}

/**
 * Values that mean "no ceiling". Accepted so the cap can be removed from the dashboard
 * or with one row, WITHOUT a code change — which is exactly what was asked for.
 *
 * Represented as `Infinity` rather than `null` on purpose: every consumer already reads
 * a `number` and compares with `>=`, so `count >= Infinity` is false forever and no
 * guard, type or call site changes shape. A `null` would have made "unlimited" and
 * "somebody forgot to set this" the same value in eleven places.
 */
const UNLIMITED_WORDS = ['unlimited', 'none', 'off', 'no', 'infinity']

/**
 * Read a numeric setting, and REFUSE a value that is not a sane one.
 *
 * `env` range-checks every one of these (`intish(1, 1, 10)` and friends) and the Setting
 * row that OVERRIDES it was checked for nothing at all beyond `Number.isFinite` — so
 * `maxPerTargetPerDay = 1000`, `= -5` or `= 2.5` were all accepted silently, and the
 * validated env value they replaced never applied. Validation on the default and none on
 * the override is worse than no validation, because it reads as though the range is
 * enforced.
 *
 * NO UPPER CEILING is imposed. That is deliberate and it is Tabish's decision, not an
 * oversight: he considers a per-recipient cap of 1/day "laughingly low", so this function
 * clamps the SHAPE (a positive whole number, or an explicit "unlimited") and leaves the
 * magnitude to the operator. What it will not do is accept a shape it cannot mean, and
 * it never does so quietly.
 */
export function readNumericSetting(
  key: string,
  raw: string | undefined,
  fallback: number,
  opts: { allowUnlimited?: boolean } = {},
): number {
  if (raw === undefined) return fallback
  const trimmed = raw.trim()

  if (opts.allowUnlimited && UNLIMITED_WORDS.includes(trimmed.toLowerCase())) return Number.POSITIVE_INFINITY

  const n = Number(trimmed)
  const problem =
    trimmed === '' || !Number.isFinite(n)
      ? 'not a number'
      : !Number.isInteger(n)
        ? 'not a whole number'
        : n < 1
          ? 'below 1'
          : null

  if (problem === null) return n

  // LOUDLY. A setting silently reverting to its default is indistinguishable from the
  // setting having been applied, and this one governs how often a real person is DMed.
  console.warn(
    `[settings] ignoring ${key}="${raw}" — ${problem}. Using ${fallback}. ` +
      `Set a whole number of 1 or more${opts.allowUnlimited ? ', or "unlimited"' : ''}.`,
  )
  return fallback
}

/** For display: `Infinity` must never reach a screen as the word "Infinity". */
export function describeCap(n: number): string {
  return Number.isFinite(n) ? String(n) : 'unlimited'
}

export async function getSettings(): Promise<RuntimeSettings> {
  const rows = await prisma.setting.findMany()
  const map = new Map(rows.map((r) => [r.key, r.value]))
  const d = defaults()

  const num = (key: string, fallback: number, opts?: { allowUnlimited?: boolean }): number =>
    readNumericSetting(key, map.get(key), fallback, opts)
  const bool = (key: string, fallback: boolean): boolean => {
    const raw = map.get(key)
    if (raw === undefined) return fallback
    return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase())
  }

  return {
    defaultCooldownDays: num(SETTING_KEYS.defaultCooldownDays, d.defaultCooldownDays),
    /**
     * The only cap that may be set to "unlimited" from a Setting row.
     *
     * Tabish reversed the earlier 1/day choice on 2026-08-04 — he considers it
     * "laughingly low" — so this must be removable without a code change. It is NOT
     * removed here: the effective value still comes from `MAX_PER_TARGET_PER_DAY` in
     * `.env` (2 today), because switching the cap off changes who receives messages and
     * Phase 0 changes nothing about that. Writing the row is now all it takes.
     *
     * The risk it protects against is stated rather than waved away: measured,
     * @viralbhayani posts 11-14 paid posts a day, and uncapped rotation across 65 senders
     * puts all of that into ONE inbox from a different page each time. Rotation solves
     * SENDER risk and does nothing for RECIPIENT risk, and a recipient's spam report is
     * what gets accounts banned.
     */
    maxPerTargetPerDay: num(SETTING_KEYS.maxPerTargetPerDay, d.maxPerTargetPerDay, { allowUnlimited: true }),
    hookMaxAgeHours: num(SETTING_KEYS.hookMaxAgeHours, d.hookMaxAgeHours),
    /**
     * Two different questions, deliberately not conflated:
     *
     *   AUTOPILOT_ENABLED (env)  — MAY this deployment send unattended?  Hard floor.
     *   the DB row               — IS it switched on right now?           Defaults OFF.
     *
     * The fallback here is a literal `false`, not `d.autopilotEnabled`. It used to be
     * the latter, and the consequence was found the moment the toggle appeared on
     * screen: flipping AUTOPILOT_ENABLED=true to *permit* autopilot also silently
     * *armed* it, and the dashboard read "Autopilot is ON" with nobody having
     * chosen that. Granting permission must never be the same act as switching on.
     */
    autopilotEnabled: d.autopilotEnabled && bool(SETTING_KEYS.autopilotEnabled, false),
    maxNewBrandTouchesPerDay: num(SETTING_KEYS.maxNewBrandTouchesPerDay, d.maxNewBrandTouchesPerDay),
    maxWaitingNewBrandDrafts: num(SETTING_KEYS.maxWaitingNewBrandDrafts, d.maxWaitingNewBrandDrafts),
    personaGateChannels: bool(SETTING_KEYS.personaGateChannels, d.personaGateChannels),
    generateMessages: bool(SETTING_KEYS.generateMessages, d.generateMessages),
    singleTemplate: bool(SETTING_KEYS.singleTemplate, d.singleTemplate),
    tagsAsEvidence: bool(SETTING_KEYS.tagsAsEvidence, d.tagsAsEvidence),
    /**
     * Both fleet ceilings accept "unlimited", and for opposite reasons.
     *
     * `fleetMaxPerDay` because its default IS unlimited and it must be settable back.
     * `fleetMaxPerHour` because pacing is a judgement about clustering, and an operator
     * draining a backlog deliberately should not need a code change — the send lock and
     * the minimum gap still serialise and space whatever it permits.
     */
    fleetMaxPerHour: num(SETTING_KEYS.fleetMaxPerHour, d.fleetMaxPerHour, { allowUnlimited: true }),
    fleetMaxPerDay: num(SETTING_KEYS.fleetMaxPerDay, d.fleetMaxPerDay, { allowUnlimited: true }),
    fleetMinGapMinutes: num(SETTING_KEYS.fleetMinGapMinutes, d.fleetMinGapMinutes),
    maxSendsPerTick: num(SETTING_KEYS.maxSendsPerTick, d.maxSendsPerTick),
    replyResumeHours: num(SETTING_KEYS.replyResumeHours, d.replyResumeHours),
  }
}

export async function setSetting(key: string, value: string): Promise<void> {
  await prisma.setting.upsert({
    where: { key },
    update: { value },
    create: { key, value },
  })
}
