import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Page } from 'playwright'
import { prisma } from '@/lib/db'
import { log } from '@/lib/logger'
import { sleep, randomInt } from '@/lib/time'
import { openBrowserForSender, humanisedApproach } from './senders/browser'
import { findFirst, dumpDiagnostic, type LocatorAttempt } from './senders/diagnose'
import { messageButtonCandidates, composerCandidates } from './senders/playwright'
import { matchesAnyOfOurs } from './matching'

/**
 * Reply detection — the difference between an autonomous agent and an
 * unsupervised loop.
 *
 * The governor already halts every sender to a target the moment `repliedAt` is
 * set. Until now, nothing ever set it: a human had to notice and click a button.
 * An autopilot without this keeps pitching someone who already answered, on a
 * 7-day drumbeat, which is worse than not messaging at all.
 *
 * ── How authorship is determined ──────────────────────────────────────────────
 *
 * Reading "who sent the last message" out of Instagram's DOM means depending on
 * incoming-vs-outgoing markup, which is exactly the sort of thing that changes
 * without notice.
 *
 * So this uses a signal that does not depend on DOM structure at all: we know the
 * exact text of every message we have sent, because `OutreachAttempt.renderedBody`
 * stores it. Each (sender, target) pair has its own private thread. Therefore —
 * if the last message in that thread is not one of ours, it is theirs.
 *
 * That holds regardless of how Instagram styles message bubbles, and it degrades
 * safely: an unrecognised final message is treated as a reply, so the failure mode
 * is "stops messaging and asks a human" rather than "keeps messaging someone who
 * answered".
 */

export interface ReplyFinding {
  pairId: string
  senderHandle: string
  targetHandle: string
  targetId: string
  replied: boolean
  /** Why we concluded what we did — shown in logs and the audit trail. */
  evidence: string
  /** First part of their message, for the dashboard. */
  preview?: string
}

export interface ReplySweepResult {
  findings: ReplyFinding[]
  newReplies: number
  checked: number
  errors: string[]
}

/**
 * Check every thread where we have sent something and the target has not already
 * been marked as replied.
 *
 * Bounded work: at Phase 1 scale this is at most four threads, and in practice
 * fewer, because a target that has already replied is skipped entirely.
 */
export async function sweepForReplies(): Promise<ReplySweepResult> {
  const result: ReplySweepResult = { findings: [], newReplies: 0, checked: 0, errors: [] }

  // Targets already known to have replied need no further checking — the halt is
  // permanent until a human lifts it.
  const halted = await prisma.outreachAttempt.findMany({
    where: { repliedAt: { not: null } },
    select: { pair: { select: { targetId: true } } },
  })
  const haltedTargets = new Set(halted.map((h) => h.pair.targetId))

  const pairs = await prisma.outreachPair.findMany({
    where: { attempts: { some: { status: 'SENT' } } },
    include: { sender: true, target: true },
  })

  const toCheck = pairs.filter((p) => !haltedTargets.has(p.targetId))
  if (toCheck.length === 0) {
    log.step('reply sweep: nothing to check', { pairsWithSends: pairs.length, halted: haltedTargets.size })
    return result
  }

  // Group by sender so each browser profile opens once, not once per thread.
  const bySender = new Map<string, typeof toCheck>()
  for (const p of toCheck) {
    const list = bySender.get(p.senderId) ?? []
    list.push(p)
    bySender.set(p.senderId, list)
  }

  for (const [, group] of bySender) {
    const sender = group[0]!.sender

    if (!sender.sessionPath) {
      result.errors.push(`@${sender.handle}: no session — cannot check for replies`)
      continue
    }
    const sessionFile = resolve(process.cwd(), sender.sessionPath)
    if (!existsSync(sessionFile)) {
      result.errors.push(`@${sender.handle}: session file missing`)
      continue
    }
    if (sender.status !== 'ACTIVE') {
      // A challenged sender should not be driven at all, even read-only.
      result.errors.push(`@${sender.handle}: status is ${sender.status} — skipped`)
      continue
    }

    let context = null
    try {
      context = await openBrowserForSender(sender.handle, sessionFile)
      const page = await context.newPage()

      for (const pair of group) {
        result.checked += 1
        try {
          const ourBodies = await prisma.outreachAttempt.findMany({
            where: { pairId: pair.id, status: { in: ['SENT', 'REPLIED'] } },
            select: { renderedBody: true },
          })

          const finding = await checkThread(page, {
            pairId: pair.id,
            senderHandle: sender.handle,
            targetHandle: pair.target.handle,
            targetId: pair.targetId,
            ourBodies: ourBodies.map((a) => a.renderedBody),
          })
          result.findings.push(finding)

          if (finding.replied) {
            await recordReply(pair.id, finding)
            result.newReplies += 1
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          result.errors.push(`@${sender.handle} → @${pair.target.handle}: ${message}`)
          log.warn('reply check failed', { sender: sender.handle, target: pair.target.handle, error: message })
        }

        await sleep(randomInt(1_500, 4_000))
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      result.errors.push(`@${sender.handle}: ${message}`)
    } finally {
      await context?.close().catch(() => undefined)
    }
  }

  if (result.newReplies > 0) {
    log.info(`reply sweep found ${result.newReplies} new reply(ies)`, { checked: result.checked })
  } else {
    log.step('reply sweep: no new replies', { checked: result.checked })
  }

  return result
}

/** Open one thread and decide whether the final message is theirs. */
async function checkThread(
  page: Page,
  args: {
    pairId: string
    senderHandle: string
    targetHandle: string
    targetId: string
    ourBodies: string[]
  },
): Promise<ReplyFinding> {
  const attempts: LocatorAttempt[] = []
  const base = {
    pairId: args.pairId,
    senderHandle: args.senderHandle,
    targetHandle: args.targetHandle,
    targetId: args.targetId,
  }

  await humanisedApproach(page, args.targetHandle)

  const btn = await findFirst('message-button', messageButtonCandidates(page), { timeoutMs: 20_000 })
  attempts.push(btn.attempt)
  if (!btn.locator) {
    const dir = await dumpDiagnostic(page, {
      stage: 'reply-check:message-button',
      senderHandle: args.senderHandle,
      targetHandle: args.targetHandle,
      attempts,
      error: 'no Message button matched',
    })
    throw new Error(`could not open the thread. Diagnostic: ${dir}/summary.txt`)
  }
  await btn.locator.click()

  // Wait for the thread to render by waiting for the composer, which we already
  // have well-understood candidates for.
  const composer = await findFirst('composer', composerCandidates(page), { timeoutMs: 25_000 })
  attempts.push(composer.attempt)
  if (!composer.locator) {
    const dir = await dumpDiagnostic(page, {
      stage: 'reply-check:composer',
      senderHandle: args.senderHandle,
      targetHandle: args.targetHandle,
      attempts,
      error: 'thread did not render a composer',
    })
    throw new Error(`thread did not load. Diagnostic: ${dir}/summary.txt`)
  }

  await sleep(randomInt(800, 2_000))

  const messages = await readMessageTexts(page)

  if (messages.length === 0) {
    // We have sent at least one message to this pair, so an empty thread means we
    // are not reading it correctly. Report rather than silently conclude no reply.
    const dir = await dumpDiagnostic(page, {
      stage: 'reply-check:no-messages',
      senderHandle: args.senderHandle,
      targetHandle: args.targetHandle,
      attempts,
      error: 'thread rendered but no message text was extracted',
    })
    throw new Error(`could not read messages from the thread. Diagnostic: ${dir}/summary.txt`)
  }

  const last = messages[messages.length - 1]!
  const isOurs = matchesAnyOfOurs(last, args.ourBodies)

  if (isOurs) {
    return { ...base, replied: false, evidence: `last message in thread is ours (${messages.length} messages)` }
  }

  return {
    ...base,
    replied: true,
    evidence: `last of ${messages.length} messages does not match anything we sent`,
    preview: last.slice(0, 280),
  }
}

/**
 * Extract the text of each message in the open thread.
 *
 * Tries several container strategies and keeps whichever yields the most blocks;
 * message markup is the least stable part of the page, so this favours resilience
 * over precision. Ordering follows DOM order, which is chronological.
 */
async function readMessageTexts(page: Page): Promise<string[]> {
  const strategies: { label: string; selector: string }[] = [
    { label: 'div[role="row"]', selector: 'div[role="row"]' },
    { label: '[data-testid*="message"]', selector: '[data-testid*="message" i]' },
    { label: 'div[role="listitem"]', selector: 'div[role="listitem"]' },
    { label: 'div[role="grid"] div[dir="auto"]', selector: 'div[role="grid"] div[dir="auto"]' },
  ]

  let best: string[] = []
  for (const s of strategies) {
    // NOTE: `$$eval` is Playwright's DOM-query helper — it serialises the callback
    // and runs it against matched elements inside the page. It is not JavaScript
    // `eval()`; no string is executed and no external input reaches it.
    const texts = await page
      .$$eval(s.selector, (els) =>
        els
          .map((e) => (e.textContent ?? '').replace(/\s+/g, ' ').trim())
          .filter((t) => t.length > 12),
      )
      .catch(() => [] as string[])

    if (texts.length > best.length) best = texts
  }
  return best
}


/**
 * Mark the reply. Sets `repliedAt` on our most recent SENT attempt for the pair,
 * which is what the governor reads — and because it checks replies per TARGET
 * rather than per pair, this halts every sender to that target at once.
 */
async function recordReply(pairId: string, finding: ReplyFinding): Promise<void> {
  const latest = await prisma.outreachAttempt.findFirst({
    where: { pairId, status: 'SENT' },
    orderBy: { sentAt: 'desc' },
  })
  if (!latest) return

  await prisma.outreachAttempt.update({
    where: { id: latest.id },
    data: { status: 'REPLIED', repliedAt: new Date(), error: finding.preview ?? null },
  })

  await prisma.auditLog.create({
    data: {
      actor: 'agent',
      action: 'reply.detected',
      entity: `OutreachAttempt:${latest.id}`,
      detail: `@${finding.targetHandle} replied to @${finding.senderHandle} — ${finding.evidence}. All senders to this target are now halted.`,
    },
  })

  log.info('🎉 reply detected — halting all senders to this target', {
    target: finding.targetHandle,
    sender: finding.senderHandle,
  })
}
