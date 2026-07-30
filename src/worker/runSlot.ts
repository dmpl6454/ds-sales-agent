import { prisma } from '@/lib/db'
import { env } from '@/lib/env'
import { log } from '@/lib/logger'
import { writeRecord } from '@/lib/json'
import { istStamp } from '@/lib/time'
import { runDetection } from '@/detection/pipeline'
import { closeBrowser } from '@/detection/discover'
import { runOutreach } from '@/outreach/plan'
import { sweepForReplies } from '@/outreach/replies'

/**
 * One complete slot — the whole agent loop:
 *
 *   1. READ    both channels   → detect paid campaigns
 *   2. LISTEN  our DM threads  → did a target reply? halt them
 *   3. DECIDE  governor        → who is eligible right now
 *   4. SEND    logged-in browser
 *
 * Order matters. Reply detection runs BEFORE outreach planning so that a reply
 * received since the last slot halts a target in the same run it is discovered,
 * rather than one slot later — otherwise we could answer someone's reply with
 * another templated pitch.
 *
 * Neither detection nor reply-checking can abort outreach. If either breaks,
 * messages still go out (with a generic opener, and without new reply
 * information). A monitoring subsystem must never be able to silence the thing it
 * monitors. The run is marked PARTIAL so it surfaces, and the pipeline keeps
 * working.
 */

export interface SlotResult {
  runId: string
  status: 'OK' | 'PARTIAL' | 'FAILED'
  postsSeen: number
  newPosts: number
  detected: number
  queued: number
  sent: number
  repliesFound: number
}

export async function runSlot(slot: string): Promise<SlotResult> {
  const started = Date.now()
  log.info(`▶ slot ${slot} starting`, { at: istStamp(), dryRun: env.DRY_RUN })

  const run = await prisma.scrapeRun.create({ data: { slot } })

  let status: SlotResult['status'] = 'OK'
  let postsSeen = 0
  let newPosts = 0
  let detected = 0
  let queued = 0
  let sent = 0
  let repliesFound = 0
  const detail: Record<string, unknown> = {}
  const errors: string[] = []

  // ── 1. Detection ───────────────────────────────────────────────────────────
  try {
    const d = await runDetection()
    postsSeen = d.postsSeen
    newPosts = d.newPosts
    detected = d.detected
    detail.channels = d.channels

    if (d.hadParseFailure) {
      status = 'PARTIAL'
      errors.push('parse failure — see ALARM above')
    } else if (d.hadError) {
      status = 'PARTIAL'
      errors.push('one or more channels failed')
    }
  } catch (err) {
    status = 'PARTIAL'
    const message = err instanceof Error ? err.message : String(err)
    errors.push(`detection: ${message}`)
    log.alarm('detection stage threw — continuing to outreach anyway', { error: message })
  } finally {
    await closeBrowser().catch(() => undefined)
  }

  // ── 2. Replies (before planning, so a reply halts in the same run) ─────────
  try {
    const r = await sweepForReplies()
    repliesFound = r.newReplies
    detail.replies = { checked: r.checked, found: r.newReplies, errors: r.errors }

    // Missing sessions are the expected state before autopilot is set up, not a
    // failure — only surface as PARTIAL once sessions exist and checking breaks.
    const realErrors = r.errors.filter((e) => !e.includes('no session') && !e.includes('session file missing'))
    if (realErrors.length > 0) {
      status = status === 'OK' ? 'PARTIAL' : status
      errors.push(`reply check: ${realErrors.join('; ')}`)
    }
  } catch (err) {
    status = status === 'OK' ? 'PARTIAL' : status
    const message = err instanceof Error ? err.message : String(err)
    errors.push(`replies: ${message}`)
    log.alarm('reply sweep threw — outreach continues without new reply info', { error: message })
  }

  // ── 3 & 4. Decide and send ────────────────────────────────────────────────
  try {
    const o = await runOutreach()
    queued = o.queued
    sent = o.sent
    detail.outreach = o.outcomes
    if (o.failed > 0) {
      status = status === 'OK' ? 'PARTIAL' : status
      errors.push(`${o.failed} outreach failure(s)`)
    }
  } catch (err) {
    status = 'FAILED'
    const message = err instanceof Error ? err.message : String(err)
    errors.push(`outreach: ${message}`)
    log.alarm('outreach stage threw — no messages queued this slot', { error: message })
  }

  await prisma.scrapeRun.update({
    where: { id: run.id },
    data: {
      finishedAt: new Date(),
      postsSeen,
      newPosts,
      detected,
      queued,
      sent,
      status,
      error: errors.length > 0 ? errors.join(' | ') : null,
      detail: writeRecord(detail),
    },
  })

  const seconds = ((Date.now() - started) / 1000).toFixed(1)
  log.info(`■ slot ${slot} ${status}`, { seconds, postsSeen, newPosts, detected, repliesFound, queued, sent })

  return { runId: run.id, status, postsSeen, newPosts, detected, queued, sent, repliesFound }
}
