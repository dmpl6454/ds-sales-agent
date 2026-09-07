import { prisma } from '@/lib/db'
import { getSettings } from '@/lib/settings'
import { log } from '@/lib/logger'
import { writeStringArray } from '@/lib/json'
import { fetchFeed, FeedFetchError, type FeedPost } from './feed'
import { anonGateCheck, hydrateAnonGate, DETECT_FEED_OK_KEY, DETECT_THROTTLED_KEY } from './anonGate'
import { getDetector } from './detectors'
import { setChannelVocabulary } from './detectors/semantic'
import { buildVocabulary } from './detectors/novelty'
import { saveFrame } from './media'
import { buildRawPayload, evidenceRefresh } from './evidence'
import { tagsForPost } from './tagEvidence'
import { judgeWithFrame } from './judge'
import { hoursAgo } from '@/lib/time'
import { DETECT_LOOKBACK_HOURS } from './cadence'
import { autoResolveBrands, type AutoResolveSummary } from './autoResolve'
import { rejudgeUnusedEvidence, type RejudgeSummary } from './rejudge'

/**
 * Detection: read each watched channel's recent posts and classify them.
 *
 * One anonymous HTTP request per page, no browser, no credentials. See feed.ts
 * for why that matters — anything that attaches a session here would turn an
 * IP-level risk into an account-ban risk.
 *
 * Idempotency comes free from `DetectedCampaign.shortcode @unique`: four checks a
 * day means each post is seen repeatedly, so known shortcodes are filtered before
 * any work and the rest are upserted. Re-running a slot is safe.
 */

export interface ChannelOutcome {
  handle: string
  fetched: number
  alreadyKnown: number
  stored: number
  campaigns: number
  unclassified: number
  organic: number
  officiallyPaid: number
  /**
   * Posts whose FOOTAGE changed the answer — a caption that read ordinary, raised to
   * REVIEW because the frame's text said otherwise. Counted separately because it is the
   * only number that says whether reading the video is earning its keep, and because a
   * frame-driven judgement is measured by nothing in `ig:accuracy` (its labels are
   * caption-derived), so it must stay visible as its own thing rather than merge into
   * the campaign count.
   */
  frameFlagged: number
  /**
   * Posts already stored whose TAGS, COLLABORATORS or sponsor flag had changed since we
   * captured them. Counted rather than merged into `stored`, because a post editing itself
   * after publication is a different event from a post arriving, and the number is the only
   * evidence that refreshing is worth doing at all — a permanent zero would say the
   * comparison is buying nothing, which is a finding rather than a quiet success.
   */
  evidenceRefreshed: number
  pagesFetched: number
  error?: string
  parseFailure?: boolean
  /** Not read at all this pass: Instagram had told this host to stop (see anonGate.ts). */
  skipped?: 'throttled'
}

export interface DetectionSummary {
  channels: ChannelOutcome[]
  postsSeen: number
  newPosts: number
  detected: number
  hadParseFailure: boolean
  hadError: boolean
  /** Set when the host is in an anonymous-read cooldown; the pass read nothing after it began. */
  throttledUntil: Date | null
  /** Channels this pass did not read because of that cooldown. */
  channelsUnread: number
  pagesFetched: number
  /**
   * What the automatic brand resolver did in this pass — lookups spent, prospects created,
   * and whether a throttle cut it short.
   *
   * Surfaced rather than logged, because a number that silently falls as the endpoint
   * degrades is exactly the failure this project keeps finding late. `haltedEarly` in
   * particular is the difference between "no new brands today" and "we have been blocked
   * and have found nothing since".
   */
  brandsResolved: AutoResolveSummary
}

/**
 * How far back to look. The DEFAULT is the fast-cadence window; a catch-up pass after a
 * restart passes the longer one explicitly. See src/detection/cadence.ts for both, and
 * for why detection no longer runs on the sending schedule.
 */
export async function runDetection(
  opts: { lookbackHours?: number; channelSpacingMs?: number; role?: DetectionRole } = {},
): Promise<DetectionSummary> {
  const role: DetectionRole = opts.role ?? 'primary'
  const lookbackHours = opts.lookbackHours ?? DETECT_LOOKBACK_HOURS
  // A restart must not forget a cooldown (pm2 recycles the worker on its memory ceiling),
  // or the pass resumes the exact hammering the cooldown exists to stop.
  await hydrateAnonGate()
  /**
   * Only channels we have chosen to WATCH.
   *
   * Reading a feed and messaging an account became separate decisions in Phase 7. Four
   * pages per target per slot is 16 requests at four channels — measured healthy, 48/48
   * HTTP 200 — and ~240 a slot once a provided prospect list lands, against an anonymous
   * endpoint whose only risk is IP rate limiting. A cold first touch does not need a hook
   * from the recipient's own feed, so that cost buys almost nothing.
   *
   * `watchEnabled` defaults TRUE, so every channel that was being read still is. It is
   * imported prospects that arrive unwatched, and turning one on is one toggle.
   */
  const targets = await prisma.targetAccount.findMany({
    where: { kind: 'CHANNEL', watchEnabled: true },
    orderBy: { handle: 'asc' },
  })

  /**
   * ROTATE the start so a pass cut short by a throttle does not read the same alphabetical
   * head every time and never reach @viralbhayani. MEASURED 7 Sept 2026: under the throttle
   * the only channel ever fetched was one, and it was the same one all day.
   */
  const offset = targets.length > 0 ? passCounter++ % targets.length : 0
  const ordered = [...targets.slice(offset), ...targets.slice(0, offset)]
  /**
   * ONE page per channel in the steady state. Paging stops at the newest post we already
   * hold (plus a minute of overlap), so a channel whose 12 newest posts we have costs one
   * request. Only a channel with a real gap — nothing stored inside the lookback — pages
   * deeper. Volume is what earned the throttle; this roughly halves it.
   */
  const newestStored = new Map<string, number>()
  for (const row of await prisma.detectedCampaign.groupBy({ by: ['targetId'], _max: { postedAt: true } })) {
    const at = row._max.postedAt
    if (at) newestStored.set(row.targetId, Math.floor(at.getTime() / 1000))
  }
  const spacingMs = opts.channelSpacingMs ?? DETECT_CHANNEL_SPACING_MS
  let requestsMade = 0
  let throttledUntil: Date | null = null
  /**
   * A cooldown that ends a second after the cron fires would otherwise cost a whole extra
   * pass: the 15-minute steps and the 15-minute cron share a grid. MEASURED on the first
   * live pass — until=07:30:00.571Z against a cron at 07:30:00.000Z. If the gate reopens
   * within two minutes, wait for it; two minutes of patience against fifteen of blindness.
   */
  const early = anonGateCheck()
  if (!early.ok) {
    const waitMs = early.until.getTime() - Date.now()
    if (waitMs > 0 && waitMs <= GATE_REOPEN_WAIT_MAX_MS) {
      log.step('the anonymous-read cooldown ends shortly — waiting for it before reading', { waitSeconds: Math.ceil(waitMs / 1000) })
      await new Promise((r) => setTimeout(r, waitMs + 500))
    }
  }

  const channels: ChannelOutcome[] = []
  const floorUnix = Math.floor(hoursAgo(lookbackHours).getTime() / 1000)

  for (const target of ordered) {
    const outcome: ChannelOutcome = {
      handle: target.handle,
      fetched: 0,
      alreadyKnown: 0,
      stored: 0,
      campaigns: 0,
      unclassified: 0,
      organic: 0,
      officiallyPaid: 0,
      frameFlagged: 0,
      evidenceRefreshed: 0,
      pagesFetched: 0,
    }

    const gate = anonGateCheck()
    if (!gate.ok) {
      // No request is made. Every remaining channel lands here until the cooldown ends.
      outcome.skipped = 'throttled'
      outcome.error = `throttled until ${gate.until.toISOString()}`
      throttledUntil = gate.until
      channels.push(outcome)
      continue
    }
    if (requestsMade > 0 && spacingMs > 0) {
      // Space channels out instead of a 19-request burst — bursts are what a throttle counts.
      await new Promise((r) => setTimeout(r, spacingMs + Math.floor(Math.random() * spacingMs)))
    }
    try {
      const sinceUnix = Math.max(floorUnix, (newestStored.get(target.id) ?? 0) - 60)
      requestsMade += 1
      const { posts, pagesFetched } = await fetchFeed(target.handle, { maxPosts: 48, sinceUnix })
      outcome.fetched = posts.length
      outcome.pagesFetched = pagesFetched

      if (posts.length === 0) {
        // The endpoint returned 200 with nothing. Either the account is empty or
        // the response shape changed — both warrant a shout, because "0 posts" is
        // indistinguishable from "quiet day" downstream.
        outcome.parseFailure = true
        log.alarm('feed returned zero posts — shape change or blocked', { handle: target.handle })
        channels.push(outcome)
        continue
      }

      const known = await prisma.detectedCampaign.findMany({
        where: { shortcode: { in: posts.map((p) => p.shortcode) } },
        /**
         * The stored EVIDENCE comes back with the shortcode, so a re-observation can tell
         * whether anything actually moved. Two extra columns on a query that already runs
         * every pass; no extra round trip.
         */
        select: { shortcode: true, taggedAccounts: true, rawPayload: true },
      })
      const knownSet = new Set(known.map((k) => k.shortcode))
      const storedByShortcode = new Map(known.map((k) => [k.shortcode, k]))
      outcome.alreadyKnown = knownSet.size

      const fresh = posts.filter((p) => !knownSet.has(p.shortcode))
      const detector = getDetector(target.detectorKey)

      /**
       * KNOWN posts can still be missing their FRAME — everything detected before the
       * frame store existed (2026-08-07), plus any save that failed. This re-observation
       * carries the only thumbnail URL that is still alive, so bank the bytes now:
       * `saveFrame` is idempotent (a frame already on disk costs one stat()) and never
       * throws. This is how `DbtNU9UzWYU`'s class of post stays re-examinable after its
       * CDN URL rotates — the corpus keeps the evidence, not a pointer to it.
       *
       * ── AND THE TAGS ARE REFRESHED HERE, FOR THE SAME REASON THE FRAME IS ──
       *
       * Tags and collaborators are stored at first sighting and were never looked at
       * again, because `persist` is reached only for posts in `fresh`. A publisher can add
       * a brand tag AFTER posting — that is an ordinary thing for a paid placement whose
       * paperwork lands late — and until now that edit was invisible to us forever.
       *
       * `evidenceRefresh` is PURE and returns null when nothing moved, which is nearly
       * always. Without that comparison this loop would write ~18,000 rows a day to record
       * that nothing had happened. A change is LOGGED, because a row that rewrites itself
       * with no explanation is a row nobody can audit — and because a tag appearing on a
       * post we already judged ORGANIC is exactly the event worth seeing.
       */
      for (const post of posts) {
        const stored = storedByShortcode.get(post.shortcode)
        if (!stored) continue
        await saveFrame(post.shortcode, post.thumbnailUrl)

        const refreshed = evidenceRefresh(stored, post, new Date())
        if (!refreshed) continue
        await prisma.detectedCampaign.update({
          where: { shortcode: post.shortcode },
          data: { taggedAccounts: refreshed.taggedAccounts, rawPayload: refreshed.rawPayload },
        })
        outcome.evidenceRefreshed += 1
        log.step('a stored post changed its own evidence', {
          shortcode: post.shortcode,
          handle: target.handle,
          changed: refreshed.changed.join(', '),
        })
      }

      /**
       * The channel's own hashtag history, so stage 1 can tell "unusual for THIS
       * channel" from "unusual in general". Built from everything stored for this
       * target — which is exactly what the 690-post corpus was accumulated for.
       *
       * Only for the semantic detector; the rule-based ones ignore it. Cleared in the
       * `finally` so one channel's vocabulary can never be applied to another's posts.
       */
      if (detector.key === 'semantic') {
        const captions = await prisma.detectedCampaign.findMany({
          where: { targetId: target.id },
          select: { caption: true },
        })
        setChannelVocabulary(buildVocabulary(captions.map((c) => c.caption)))
      }

      for (const post of fresh) {
        /**
         * SAVE THE COVER FRAME FIRST — before classification, because the classifier now
         * READS it (src/detection/ocr.ts runs local OCR and hands the frame's text to the
         * same model that reads the caption). Ordering these the other way round would
         * leave every first sighting judged on its caption alone, and a post is only
         * classified once.
         *
         * It is also the only reliable moment to save it at all: the thumbnail is a CDN URL
         * with a lifetime, and a post that scrolls out of the feed window can never be
         * re-fetched. Saved for EVERY channel, including the ones whose frames are never
         * used for a verdict — @madovermarketing_mom's disclosed posts are exactly the
         * labelled set any measurement of frame reading has to be built from.
         *
         * `saveFrame` never throws: a frame that fails to save costs one piece of evidence,
         * never a detection pass.
         */
        await saveFrame(post.shortcode, post.thumbnailUrl)

        // Awaited: the semantic detector calls a model. Rule detectors return
        // synchronously and `await` on a non-promise costs a microtask.
        const cls = await detector.classify(post)

        // Instagram's own Paid Partnership label overrides any heuristic. Neither
        // Phase 1 target uses it today, but when one does this becomes the truth.
        const officiallyPaid = post.isPaidPartnership
        if (officiallyPaid) outcome.officiallyPaid += 1

        const captionVerdict = officiallyPaid ? 'CAMPAIGN' : cls.verdict
        const confidence = officiallyPaid ? 100 : cls.confidence
        const captionSignals = officiallyPaid ? [...cls.signals, 'official:is_paid_partnership'] : cls.signals

        /**
         * NOW READ THE FOOTAGE — and this is the fix for a feature that was built and
         * then never ran.
         *
         * MEASURED 2026-08-08: 166 posts detected that day had a cover frame sitting on
         * disk that nothing had read. This loop saved the frame (above) and classified
         * the CAPTION ALONE, while the only frame-aware code lived in
         * `scripts/ocr.ts --reclassify`. So the Thane class of paid post — the entire
         * reason the OCR work exists — was still being missed in normal operation, and
         * `DbtNU9UzWYU` was escalated only because a person ran a command by hand.
         *
         * `judgeWithFrame` is the ONE judging path, shared with the backfill and the
         * classify CLI. It decides on its own whether a call is worth making (retired
         * target, unsupported detector, a caption verdict a frame cannot move) and the
         * footage may only ever raise ORGANIC to REVIEW.
         */
        const judged = await judgeWithFrame(
          {
            shortcode: post.shortcode,
            caption: post.caption,
            /**
             * Retired channels still get their FRAME SAVED above — those are the labelled
             * set any future measurement is built from — but not a classifier call.
             * MEASURED: 64% of OCR runs were against our own retired pages.
             */
            optedOut: target.optedOut,
            /* Whose post this is — a publisher's own watermark is not evidence about it. */
            publisher: { handle: target.handle, displayName: target.displayName },
            publisherAsContext: (await getSettings()).publisherAsContext,
            // judge.ts owns what each detector permits — including the M.O.M second look.
            detectorKey: detector.key,
            /**
             * The SAME tag block the caption verdict was reached with. Built here from the
             * same post the detector saw, so the frame call differs from the caption call
             * in exactly one thing — the frame — which is what `applyFrameSignal` is about
             * to attribute the difference to.
             */
            tagText: await tagsForPost(
              {
                taggedAccounts: post.taggedAccounts,
                collabHandles: post.collabHandles,
                isPaidPartnership: post.isPaidPartnership,
              },
              post.shortcode.slice(0, 6),
            ),
          },
          captionVerdict,
        )

        const verdict = judged.verdict
        const signals = [...captionSignals, ...judged.signals]
        if (judged.secondLook) {
          log.step('the second look re-judged a rule-negative', {
            shortcode: post.shortcode,
            channel: target.handle,
            verdict,
          })
        }
        if (judged.changedByFrame) {
          outcome.frameFlagged += 1
          log.step('the footage changed the answer', {
            shortcode: post.shortcode,
            from: captionVerdict,
            to: verdict,
            footage: judged.frameSummary ?? '',
          })
        }

        const brands = dedupe([
          ...post.sponsorHandles.map((h) => `@${h}`),
          ...post.collabHandles.map((h) => `@${h}`),
          ...cls.brands,
          // Caption-derived only: the second look's caption call may name brands, its
          // frame call never does — "brands come from the caption-only call, always".
          ...(judged.secondLook?.brands ?? []),
        ])

        if (verdict === 'CAMPAIGN') outcome.campaigns += 1
        else if (verdict === 'UNCLASSIFIED') outcome.unclassified += 1
        else outcome.organic += 1

        await persist(target.id, post, verdict, judged.secondLook?.confidence ?? confidence, signals, brands, {
          // Instagram's own label is a fact, not a judgement, so it is recorded as
          // 'rules' regardless of which detector ran. When the SECOND LOOK ran, the
          // verdict is the model's and the row must say so — filing a semantic answer
          // under 'rules' would make it label-grade for every future measurement.
          verdictSource: officiallyPaid ? 'rules' : judged.secondLook ? 'semantic' : cls.verdictSource,
          classifierModel: judged.secondLook ? 'deepseek-v4-flash' : (cls.classifierModel ?? null),
          classifierReason: judged.secondLook?.reason ?? cls.classifierReason ?? null,
          taggedAccounts: post.taggedAccounts ?? [],
          /**
           * What the footage said, from the ONE writer of that sentence
           * (`frameTextSummaryLine`), falling back to whatever the detector recorded.
           * The screen and the stored record must not be able to describe the same
           * evidence differently.
           */
          frameText: judged.frameText ?? cls.frameText ?? null,
        })
        outcome.stored += 1
      }

      log.info('channel done', {
        handle: target.handle,
        detector: detector.key,
        fetched: posts.length,
        new: outcome.stored,
        campaigns: outcome.campaigns,
        officiallyPaid: outcome.officiallyPaid,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      outcome.error = message
      if (err instanceof FeedFetchError && err.isParseFailure) {
        outcome.parseFailure = true
        log.alarm('feed shape changed — detection is blind until fixed', { handle: target.handle, message })
      } else if (err instanceof FeedFetchError && err.isThrottle) {
        // The gate has already alarmed once; here we only record that this channel was cut.
        outcome.skipped = 'throttled'
        throttledUntil = err.until
      } else {
        log.error('channel failed', { handle: target.handle, error: message })
      }
    } finally {
      // Never let one channel's vocabulary leak into the next channel's scoring.
      setChannelVocabulary(null)
    }

    channels.push(outcome)
  }

  /**
   * RESOLVE THE BRANDS IN WHAT WE JUST CLASSIFIED — the step that makes brand discovery
   * something that RUNS rather than something a command can do.
   *
   * After classification, deliberately: a CAMPAIGN verdict written moments ago is what makes
   * its caption's @mentions worth a lookup, and `autoResolveBrands` reads the verdict from
   * the database rather than from this loop's state.
   *
   * NEVER FATAL. Detection must never gate on brand resolution — decision 5 in CLAUDE.md is
   * that a monitoring subsystem must not be able to silence the thing it monitors, and the
   * same reasoning applies one layer along: a scarce third-party endpoint failing must not
   * cost us the posts we already read and stored. Every lookup is cached UNKNOWN and the
   * next pass retries.
   */
  const pagesFetched = channels.reduce((n, c) => n + c.pagesFetched, 0)
  const channelsUnread = channels.filter((c) => c.skipped === 'throttled').length
  if (channelsUnread > 0) {
    log.alarm('detection halted early — Instagram is refusing anonymous reads from this host', {
      channelsUnread,
      channelsRead: channels.length - channelsUnread,
      resumesAt: throttledUntil?.toISOString() ?? 'unknown',
    })
  }
  await recordDetectionOutput({ pagesFetched, throttledUntil, role })
  /**
   * A FAILOVER pass (an operator's Mac reading because the server cannot) stops here: brand
   * discovery and the frame re-judge run on that machine's own timers already, and the
   * evidence they need — frames on disk, a classifier key — is the server's. Doubling the
   * lookups from a home IP is how that IP gets throttled too.
   */
  if (role === 'failover') {
    return {
      channels,
      throttledUntil,
      channelsUnread,
      pagesFetched,
      postsSeen: channels.reduce((n, c) => n + c.fetched, 0),
      newPosts: channels.reduce((n, c) => n + c.stored, 0),
      detected: channels.reduce((n, c) => n + c.campaigns, 0),
      hadParseFailure: channels.some((c) => c.parseFailure === true),
      hadError: channels.some((c) => c.error !== undefined),
      brandsResolved: { looked: 0, decided: 0, skippedUnsure: 0, haltedEarly: false, unreached: 0, backingOff: 0, awaitingRetry: 0 },
    }
  }
  const brandsResolved = await autoResolveBrands().catch((err): AutoResolveSummary => {
    log.warn('brand auto-resolve failed — next pass retries', {
      error: err instanceof Error ? err.message : String(err),
    })
    return {
      looked: 0,
      decided: 0,
      skippedUnsure: 0,
      haltedEarly: false,
      unreached: 0,
      backingOff: 0,
      awaitingRetry: 0,
    }
  })

  /**
   * ── AND EVIDENCE THAT WAS READ BUT NEVER REACHED A VERDICT (repair plan 6.4) ─────────
   *
   * MEASURED: 65 in-window posts carry `frame:call-failed` — the footage was read, the
   * words extracted, and the classifier call that would have folded them in failed. Correct
   * at the time (*a failed call is never recorded as a verdict*), and wrong forever after,
   * because nothing tried again. Bounded per pass, never overriding a human answer, and
   * only ever through `judgeWithFrame` so the permission table still applies.
   *
   * Caught separately from the brand resolver and from detection itself: this is the least
   * urgent thing in the pass, and a post that scrolls out of the feed window can never be
   * re-scraped, so it must not be able to take the run down with it.
   */
  const rejudged = await rejudgeUnusedEvidence().catch((err): RejudgeSummary => {
    log.warn('re-judging unused evidence failed — next pass retries', {
      error: err instanceof Error ? err.message : String(err),
    })
    return { examined: 0, changed: 0, remaining: 0, skippedNoEvidence: 0, skippedCallFailed: 0, proposals: [] }
  })
  // `remaining` is in the condition too: a drained backlog must go quiet, and a STUCK one
  // must not — examined=0 with remaining>0 is the state worth a line.
  if (rejudged.examined > 0 || rejudged.remaining > 0) {
    log.info('re-judged evidence read earlier', {
      examined: rejudged.examined,
      changed: rejudged.changed,
      // Named, because "examined 10, changed 0" on a host with no frame store is a
      // different fact from "examined 10, changed 0" on the host that has them.
      //
      // TWO NUMBERS, NOT ONE. This line used to print `noFrameHere` for BOTH skip reasons,
      // and on 2026-08-17 it read `noFrameHere=10 remaining=83` on the very host holding
      // all 83 frames — a counter asserting a cause that was false, which sent a diagnosis
      // through the OCR engine, the frames directory and the API key before the real cause
      // (the classifier was never asked) turned up. A number that names a reason must be
      // true about that reason.
      noFrameHere: rejudged.skippedNoEvidence,
      callDidNotAnswer: rejudged.skippedCallFailed,
      remaining: rejudged.remaining,
    })
  }

  /**
   * `awaitingRetry` is in the CONDITION as well as the body, deliberately: a pass that looked
   * at nothing because every candidate is backing off is precisely the state worth a line, and
   * `looked > 0` alone would render it as silence — the same shape as a stale latch reporting
   * nothing four times an hour.
   */
  if (
    brandsResolved.looked > 0 ||
    brandsResolved.awaitingRetry > 0 ||
    brandsResolved.backingOff > 0 ||
    brandsResolved.unreached > 0
  ) {
    /**
     * `unreached` and `backingOff` are in the CONDITION as well as the body, for the same
     * reason `awaitingRetry` already was: the state worth a line is a pass that looked at
     * almost nothing because a queue is stuck behind a halt, and `looked > 0` alone rendered
     * exactly that as `looked=1 haltedEarly=true` — four times an hour, for hours, while one
     * handle held the head of the queue and nothing else was ever asked about.
     */
    log.info('brand auto-resolve', {
      looked: brandsResolved.looked,
      created: brandsResolved.decided,
      needsAHuman: brandsResolved.skippedUnsure,
      // Eligible and not asked about this pass. A halt with a backlog behind it is a
      // problem; a halt with nothing behind it is an ordinary quiet pass.
      unreached: brandsResolved.unreached,
      backingOff: brandsResolved.backingOff,
      awaitingRetry: brandsResolved.awaitingRetry,
      haltedEarly: brandsResolved.haltedEarly,
    })
  }

  return {
    channels,
    throttledUntil,
    channelsUnread,
    pagesFetched,
    postsSeen: channels.reduce((n, c) => n + c.fetched, 0),
    newPosts: channels.reduce((n, c) => n + c.stored, 0),
    detected: channels.reduce((n, c) => n + c.campaigns, 0),
    hadParseFailure: channels.some((c) => c.parseFailure === true),
    hadError: channels.some((c) => c.error !== undefined),
    brandsResolved,
  }
}

/**
 * Who is running the pass. The PRIMARY is the server's worker; a FAILOVER pass is an
 * operator's Mac reading because the server cannot (src/detection/failover.ts). The
 * distinction matters for one write: `detectThrottledUntil` describes the SERVER's cooldown
 * and only the server may set or clear it — a Mac writing its own cooldown there would tell
 * the dashboard the wrong host's story, and a Mac clearing it would hide a server still
 * being refused, which is exactly the condition that makes the Mac's reading necessary.
 */
export type DetectionRole = 'primary' | 'failover'

/** Rotates the channel order between passes — see the note in `runDetection`. */
let passCounter = 0

/** Gap between channel fetches within one pass, plus up to the same again as jitter. */
export const DETECT_CHANNEL_SPACING_MS = 2500

/** Wait for a cooldown that ends this soon rather than skipping the pass — see `runDetection`. */
export const GATE_REOPEN_WAIT_MAX_MS = 2 * 60_000

/**
 * What the dashboard reads to tell "the pass ran" from "the pass READ something".
 * `detectLastOkAt` is stamped when the pass does not throw, and a pass refused on every
 * channel does not throw — that is how three blind days looked healthy (4-7 Sept 2026).
 * Best-effort like every other stamp: recording output must never fail the pass.
 */
async function recordDetectionOutput(input: {
  pagesFetched: number
  throttledUntil: Date | null
  role: DetectionRole
}): Promise<void> {
  const writes: Promise<unknown>[] = []
  if (input.pagesFetched > 0) {
    const value = new Date().toISOString()
    writes.push(
      prisma.setting.upsert({ where: { key: DETECT_FEED_OK_KEY }, update: { value }, create: { key: DETECT_FEED_OK_KEY, value } }),
    )
  }
  if (input.role !== 'primary') {
    // A failover pass reports what it READ and nothing about the server's cooldown.
  } else if (input.throttledUntil) {
    const value = input.throttledUntil.toISOString()
    writes.push(
      prisma.setting.upsert({ where: { key: DETECT_THROTTLED_KEY }, update: { value }, create: { key: DETECT_THROTTLED_KEY, value } }),
    )
  } else {
    writes.push(prisma.setting.deleteMany({ where: { key: DETECT_THROTTLED_KEY } }))
  }
  await Promise.all(writes.map((w) => w.catch(() => undefined)))
}

function dedupe(values: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const v of values) {
    const k = v.toLowerCase().replace(/^[@#]/, '')
    if (!k || seen.has(k)) continue
    seen.add(k)
    out.push(v)
  }
  return out.slice(0, 6)
}

async function persist(
  targetId: string,
  post: FeedPost,
  verdict: string,
  confidence: number,
  signals: string[],
  brands: string[],
  provenance: {
    verdictSource: string
    classifierModel: string | null
    classifierReason: string | null
    taggedAccounts: string[]
    /** What OCR read off the cover frame, or null when no frame was read. */
    frameText: string | null
  },
): Promise<void> {
  const data = {
    targetId,
    permalink: post.permalink,
    postedAt: post.postedAt,
    caption: post.caption,
    likeCount: post.likeCount,
    commentCount: post.commentCount,
    mediaType: post.mediaType,
    brands: writeStringArray(brands),
    signals: writeStringArray(signals),
    confidence,
    verdict,
    verdictSource: provenance.verdictSource,
    classifierModel: provenance.classifierModel,
    classifierReason: provenance.classifierReason,
    taggedAccounts: writeStringArray(provenance.taggedAccounts),
    /**
     * MEDIA URLS ARE STORED HERE, and the reason is that they EXPIRE.
     *
     * `rawPayload` rather than new columns, deliberately: this is captured evidence about
     * one observation, it is not queried, and no guard reads it — exactly what this
     * column already holds.
     *
     * ── AND THE URL IS NOT THE EVIDENCE. THE BYTES ARE ─────────────────────
     *
     * This docblock used to claim these URLs were "REFRESHED on every re-observation", so
     * that "the newest sighting carries the only ones still fetchable". THAT WAS NEVER
     * TRUE. `persist` is reached only from `for (const post of fresh)`, and `fresh`
     * excludes every shortcode already stored — so the `update:` branch below has never
     * run for a re-observed post in normal operation, and the refresh never happened.
     * MEASURED on the live database: 48 of 1,310 in-window posts hold a thumbnail URL,
     * while 156 frames are on disk. The claim was "verified" by checking that NEW posts
     * carried URLs, which cannot test a claim about re-observation.
     *
     * That is why the frame is now saved as BYTES at scrape time
     * (`src/detection/media.ts`), before classification, on every channel. A stored URL is
     * a promise that something else will still be there later; the file is the evidence.
     * The URLs stay because they cost nothing and record what the CDN offered.
     *
     * The SHAPE is built by `buildRawPayload` (src/detection/evidence.ts) rather than
     * inline here, because the known-post loop now refreshes this same payload when a
     * publisher edits its tags — and two object literals producing one shape is exactly
     * how the seven keys and the `taggedAccounts` column came to disagree.
     */
    rawPayload: buildRawPayload(post, new Date()),
    frameText: provenance.frameText,
  }

  await prisma.detectedCampaign.upsert({
    where: { shortcode: post.shortcode },
    /**
     * NOT DEAD CODE, and this was measured before anyone deleted it: the update branch
     * fired 16 times on 2026-08-07 alone.
     *
     * Callers filter known shortcodes out before getting here, so it looks unreachable —
     * but the four IST slots run detection at minute 0, always a multiple of 15, so they
     * COLLIDE with the 15-minute detect cron four times a day. `noOverlap` is per-task and
     * the slot lock is slot-vs-slot, so nothing stops the two overlapping; both passes
     * compute their known-set before either writes, both see a post as fresh, and the
     * loser lands here. This branch is the reconciler that makes that safe, which is also
     * why `pnpm ig:detect` alongside the scheduler is safe.
     *
     * Never overwrites a human's REVIEW-queue label.
     *
     * `taggedAccounts` is in here now. It was the one captured field the reconciler left
     * behind, so a post that landed on this branch kept whichever tags the losing pass had
     * — a silent, invisible divergence between the column and the payload beside it.
     */
    update: {
      likeCount: data.likeCount,
      commentCount: data.commentCount,
      confidence: data.confidence,
      verdict: data.verdict,
      signals: data.signals,
      brands: data.brands,
      taggedAccounts: data.taggedAccounts,
      rawPayload: data.rawPayload,
      frameText: data.frameText,
    },
    create: { ...data, shortcode: post.shortcode },
  })
}
