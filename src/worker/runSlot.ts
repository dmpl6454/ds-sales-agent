import { prisma } from '@/lib/db'
import { env } from '@/lib/env'
import { log } from '@/lib/logger'
import { writeRecord } from '@/lib/json'
import { istStamp } from '@/lib/time'
import { runDetection } from '@/detection/pipeline'
import { runOutreach } from '@/outreach/plan'

/**
 * One complete slot:
 *
 *   1. READ    both channels  → detect paid campaigns (anonymous, no login)
 *   2. DECIDE  safety gate    → is any pair permitted a message
 *   3. PREPARE draft          → queue it for a human to send
 *
 * Detection cannot abort step 2. If the feed endpoint breaks, a permitted message
 * is still prepared, just without a specific hook. A monitoring subsystem must
 * never be able to silence the thing it monitors — the run is marked PARTIAL so it
 * surfaces, and the rest keeps working.
 *
 * There is no automated reply-detection stage: reading the inbox requires a
 * logged-in session, which is exactly the exposure detection is built to avoid.
 *
 * A reply IS load-bearing, though — the governor halts every sender to a target
 * that has answered, so an unrecorded reply means the agent keeps preparing cold
 * follow-ups to a live conversation. So it is marked by hand on the dashboard, and
 * that is currently the weakest link in the loop.
 */

export interface SlotResult {
  runId: string
  status: 'OK' | 'PARTIAL' | 'FAILED'
  postsSeen: number
  newPosts: number
  detected: number
  queued: number
  sent: number
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
  }

  // ── 2. Decide and prepare ─────────────────────────────────────────────────
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
  log.info(`■ slot ${slot} ${status}`, { seconds, postsSeen, newPosts, detected, queued, sent })

  return { runId: run.id, status, postsSeen, newPosts, detected, queued, sent }
}
