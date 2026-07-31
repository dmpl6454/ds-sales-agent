'use server'

import { revalidatePath } from 'next/cache'
import { prisma } from '@/lib/db'
import { env } from '@/lib/env'
import { runSlot } from '@/worker/runSlot'
import { browserSender } from '@/outreach/senders/browser'
import { profileStatus } from '@/outreach/browser/profile'
import { setSetting, SETTING_KEYS } from '@/lib/settings'
import { startConnect, pollConnect, cancelConnect, type ConnectState } from '@/outreach/browser/connect'
import { handleExists } from '@/detection/exists'
import { assertSafeHandle } from '@/lib/urls'
import { MESSAGE_VARIANTS } from '../../prisma/variants'

/**
 * Everything the dashboard can do.
 *
 * Connecting accounts and managing channels moved here from the terminal
 * deliberately: `pnpm ig:login` is a developer flow, and the person who runs this
 * day to day should never need a shell. The safety properties are unchanged — the
 * password is still typed into Chrome's own form, and nothing here reads it.
 *
 * Deeper operator surgery (personas, cooldowns, reclassification) stays in
 * `pnpm agent` and `pnpm db:studio`. Controls that can quietly break outreach do
 * not belong on the page a CEO reads.
 *
 * Every state change writes an AuditLog row.
 */

async function audit(action: string, entity: string, detail?: string) {
  await prisma.auditLog.create({
    data: { actor: env.OPERATOR_NAME, action, entity, detail: detail ?? null },
  })
}

/** Run a slot immediately rather than waiting for the schedule. Takes ~15s. */
export async function syncNow() {
  const result = await runSlot('manual')
  await audit('sync.now', 'ScrapeRun', `status=${result.status} detected=${result.detected}`)
  revalidatePath('/')
  return result
}

export interface SendNowResult {
  ok: boolean
  message: string
  /** true when the account hit an Instagram checkpoint. Nothing may retry. */
  challenged?: boolean
}

/**
 * Send it. For real.
 *
 * Opens the sending account's own logged-in Chrome profile, navigates feed →
 * profile → Message, pastes the drafted body, verifies the composer contains
 * exactly that body, presses Enter, and confirms the message appears in the thread.
 * Takes roughly 30-60 seconds and a Chrome window will be visible while it runs —
 * that visibility is deliberate, not a debug leftover.
 *
 * Guards, in the order they bite:
 *
 *   1. The attempt must still be awaiting send. A double click cannot double send.
 *   2. The Chrome profile must exist and be logged in as exactly this sender.
 *   3. The composer must contain our message before Enter is pressed.
 *   4. The message must appear in the thread before it is recorded as SENT.
 *
 * A checkpoint marks the sender CHALLENGED and halts it. That state is cleared by a
 * human who has looked at the account, never automatically.
 */
export async function sendNow(attemptId: string): Promise<SendNowResult> {
  const attempt = await prisma.outreachAttempt.findUniqueOrThrow({
    where: { id: attemptId },
    include: { pair: { include: { sender: true, target: true } } },
  })
  const { sender, target } = attempt.pair

  // Guard 1 — idempotency. Two clicks, or a click racing the worker, must not
  // produce two messages to a real prospect.
  if (attempt.status !== 'READY' && attempt.status !== 'QUEUED') {
    return { ok: false, message: `already ${attempt.status.toLowerCase()} — nothing sent` }
  }
  if (sender.status !== 'ACTIVE') {
    return { ok: false, message: `@${sender.handle} is ${sender.status} — sending is halted for this account` }
  }

  // Guard 2 — a profile that was never logged into by hand cannot send, and must
  // not be "fixed" by importing a session from somewhere else.
  const profile = profileStatus(sender.handle)
  if (!profile.hasSession) {
    return {
      ok: false,
      message: `@${sender.handle} is not connected yet. Press Connect on its row, and log in in the Chrome window that opens.`,
    }
  }

  await prisma.outreachAttempt.update({ where: { id: attemptId }, data: { status: 'SENDING' } })
  await audit('attempt.send.start', `OutreachAttempt:${attemptId}`, `@${sender.handle} → @${target.handle}`)

  const outcome = await browserSender.send({
    attemptId,
    senderHandle: sender.handle,
    sessionPath: profile.dir,
    targetHandle: target.handle,
    body: attempt.renderedBody,
  })

  if (outcome.status === 'SENT') {
    await prisma.$transaction([
      prisma.outreachAttempt.update({
        where: { id: attemptId },
        data: {
          status: 'SENT',
          sentAt: new Date(),
          sentBy: `auto:${sender.handle}`,
          threadUrl: outcome.threadUrl ?? null,
          error: null,
        },
      }),
      prisma.messageVariant.update({
        where: { id: attempt.variantId },
        data: { timesUsed: { increment: 1 }, lastUsedAt: new Date() },
      }),
    ])
    await audit('attempt.sent.auto', `OutreachAttempt:${attemptId}`, outcome.threadUrl ?? 'delivered')
    revalidatePath('/')
    return { ok: true, message: `Sent to @${target.handle} from @${sender.handle}.` }
  }

  const error = outcome.status === 'FAILED' ? outcome.error : 'sender returned no outcome'

  if (outcome.status === 'FAILED' && outcome.challenged) {
    // Halt the account. Not a retry, not a backoff — a stop.
    await prisma.$transaction([
      prisma.senderAccount.update({ where: { id: sender.id }, data: { status: 'CHALLENGED' } }),
      prisma.outreachAttempt.update({ where: { id: attemptId }, data: { status: 'READY', error } }),
    ])
    await audit('sender.challenged', `SenderAccount:${sender.handle}`, error)
    revalidatePath('/')
    return {
      ok: false,
      challenged: true,
      message: `Instagram showed a checkpoint for @${sender.handle}. Sending is halted for that account and nothing was retried. Open the account by hand before doing anything else.`,
    }
  }

  // Everything else: leave the draft intact so it can be retried or sent by hand.
  await prisma.outreachAttempt.update({ where: { id: attemptId }, data: { status: 'READY', error } })
  await audit('attempt.send.failed', `OutreachAttempt:${attemptId}`, error)
  revalidatePath('/')
  return { ok: false, message: error }
}

/**
 * Confirm a message was sent by hand. Still needed: if you send from your phone, or
 * the automated path fails and you finish it yourself, the record has to catch up
 * or the agent will prepare a duplicate.
 */
export async function markSent(attemptId: string) {
  const attempt = await prisma.outreachAttempt.findUniqueOrThrow({
    where: { id: attemptId },
    include: { pair: { include: { sender: true, target: true } } },
  })
  if (attempt.status === 'SENT') return

  await prisma.$transaction([
    prisma.outreachAttempt.update({
      where: { id: attemptId },
      data: { status: 'SENT', sentAt: new Date(), sentBy: env.OPERATOR_NAME },
    }),
    prisma.messageVariant.update({
      where: { id: attempt.variantId },
      data: { timesUsed: { increment: 1 }, lastUsedAt: new Date() },
    }),
  ])
  await audit(
    'attempt.sent',
    `OutreachAttempt:${attemptId}`,
    `@${attempt.pair.sender.handle} → @${attempt.pair.target.handle}`,
  )
  revalidatePath('/')
}

/** Longest body we will hand to the composer. Well above any real pitch. */
const MAX_BODY_CHARS = 4000

/**
 * Edit a drafted message before it goes.
 *
 * Allowed because the agent writing every message from scratch is a safety control,
 * not a claim that it writes them perfectly — and a human who spots a wrong detail
 * should be able to fix it rather than discard and hope the next draft is better.
 *
 * Only while the message is still waiting. Once it is SENDING a browser is already
 * typing it, and once SENT the recipient has it; editing the record afterwards would
 * make the audit trail describe a message nobody received.
 *
 * The stored body is the single source of truth downstream: the composer read-back
 * compares against exactly this text, so an edit is carried through the send guard
 * automatically rather than needing to be taught about.
 */
export async function editAttemptBody(attemptId: string, body: string): Promise<MutationResult> {
  const attempt = await prisma.outreachAttempt.findUniqueOrThrow({
    where: { id: attemptId },
    include: { pair: { include: { sender: true, target: true } } },
  })

  if (attempt.status !== 'READY' && attempt.status !== 'QUEUED') {
    return {
      ok: false,
      message:
        attempt.status === 'SENDING'
          ? 'That message is being sent right now — too late to edit.'
          : `That message is already ${attempt.status.toLowerCase()} and cannot be changed.`,
    }
  }

  const next = body.replace(/\r\n/g, '\n').trim()
  if (next.length === 0) return { ok: false, message: 'A message cannot be empty. Discard it instead.' }
  if (next.length > MAX_BODY_CHARS) {
    return { ok: false, message: `That is ${next.length} characters; the limit is ${MAX_BODY_CHARS}.` }
  }
  if (next === attempt.renderedBody.trim()) return { ok: true, message: 'No changes.' }

  await prisma.outreachAttempt.update({ where: { id: attemptId }, data: { renderedBody: next } })
  await audit(
    'attempt.edited',
    `OutreachAttempt:${attemptId}`,
    `@${attempt.pair.sender.handle} → @${attempt.pair.target.handle}, ${attempt.renderedBody.length} → ${next.length} chars`,
  )
  revalidatePath('/')
  return { ok: true, message: `Saved. ${next.length} characters.` }
}

/**
 * The autopilot toggle.
 *
 * Turning it ON means: at each slot, any armed account with a logged-in Chrome
 * profile sends its permitted message by itself, with no human present.
 *
 * `AUTOPILOT_ENABLED` in `.env` is a hard floor and is checked here rather than
 * only in the reader. A dashboard is a web page: anyone who can reach it can call
 * this action. The environment variable is the boundary a page cannot cross.
 */
export async function setAutopilot(on: boolean): Promise<{ ok: boolean; message: string }> {
  if (on && !env.AUTOPILOT_ENABLED) {
    return {
      ok: false,
      message:
        'Autopilot is disabled for this deployment. Set AUTOPILOT_ENABLED=true in .env and restart — that switch is deliberately not changeable from this page.',
    }
  }
  await setSetting(SETTING_KEYS.autopilotEnabled, on ? 'true' : 'false')
  await audit('autopilot.set', 'Setting:autopilotEnabled', on ? 'ON' : 'OFF')
  revalidatePath('/')
  return {
    ok: true,
    message: on ? 'Autopilot on — armed accounts will send at each slot.' : 'Autopilot off — messages will wait for you.',
  }
}

/**
 * Arm or disarm one account for unattended sending.
 *
 * Per-account rather than global-only because these three accounts are not
 * interchangeable and should graduate one at a time: prove it on one, watch it,
 * then arm the next. A single global switch would move all three at once, which is
 * exactly the change nobody should be able to make casually.
 */
export async function setAccountAutopilot(handle: string, on: boolean): Promise<{ ok: boolean; message: string }> {
  const sender = await prisma.senderAccount.findUniqueOrThrow({ where: { handle } })

  if (on && !profileStatus(handle).hasSession) {
    return { ok: false, message: `@${handle} is not connected yet — press Connect on its row first.` }
  }
  if (on && sender.status !== 'ACTIVE') {
    return { ok: false, message: `@${handle} is ${sender.status} — clear that before arming it` }
  }

  await prisma.senderAccount.update({ where: { handle }, data: { autoSendEnabled: on } })
  await audit('sender.autopilot.set', `SenderAccount:${handle}`, on ? 'ARMED' : 'DISARMED')
  revalidatePath('/')
  return { ok: true, message: on ? `@${handle} will send by itself.` : `@${handle} will wait for you.` }
}

// ── Connecting an account ───────────────────────────────────────────────────

/**
 * Open the Chrome window so the operator can log this account in.
 *
 * This is the dashboard equivalent of `pnpm ig:login`, and it is deliberately the
 * same underlying flow: the account's own persistent profile, a real Chrome window,
 * a human typing the password into Instagram's own form. What is NOT happening here
 * is worth stating because it is the whole safety argument — no credential is read
 * by this process, and no session is imported from anywhere.
 */
export async function connectAccount(handle: string): Promise<ConnectState> {
  const sender = await prisma.senderAccount.findUnique({ where: { handle } })
  if (!sender) return { state: 'error', message: `@${handle} is not one of your accounts` }
  await audit('sender.connect.start', `SenderAccount:${handle}`)
  return startConnect(handle)
}

/** Polled by the page every few seconds while the Chrome window is open. */
export async function checkConnect(handle: string): Promise<ConnectState> {
  const result = await pollConnect(handle)
  if (result.state === 'connected') {
    const st = profileStatus(handle)
    await prisma.senderAccount.update({
      where: { handle },
      // status back to ACTIVE: a fresh hand login is exactly what clears a
      // CHALLENGED account, and it is the only thing that should.
      data: { sessionPath: st.dir, sessionSavedAt: new Date(), status: 'ACTIVE' },
    })
    await audit('sender.login', `SenderAccount:${handle}`, `connected via dashboard into ${st.dir}`)
    revalidatePath('/')
  }
  return result
}

export async function abortConnect(handle: string): Promise<{ ok: true }> {
  await cancelConnect(handle)
  await audit('sender.connect.cancel', `SenderAccount:${handle}`)
  revalidatePath('/')
  return { ok: true }
}

// ── Managing sending accounts ───────────────────────────────────────────────

export interface MutationResult {
  ok: boolean
  message: string
}

/**
 * Add a sending account.
 *
 * Three things have to happen together or the account is broken in a way that only
 * shows up at send time:
 *   - the persona, because rendering refuses to build a message without one
 *   - the follow-up variants, because the planner throws if a sender has none
 *   - a routing pair to every channel, because a sender with no pairs is inert
 *
 * New pairs start DISABLED. Adding an account should never, by itself, cause a
 * message to be sent — arming is a separate, deliberate act.
 */
export async function addSender(handleRaw: string, displayNameRaw: string): Promise<MutationResult> {
  const handle = handleRaw.trim().replace(/^@/, '').toLowerCase()
  const displayName = displayNameRaw.trim() || handle

  try {
    assertSafeHandle(handle)
  } catch {
    return { ok: false, message: 'That is not a valid Instagram handle (letters, numbers, dots, underscores).' }
  }
  if (await prisma.senderAccount.findUnique({ where: { handle } })) {
    return { ok: false, message: `@${handle} is already one of your accounts.` }
  }
  if (await prisma.targetAccount.findUnique({ where: { handle } })) {
    return { ok: false, message: `@${handle} is already a channel you watch — it cannot also send.` }
  }

  const exists = await handleExists(handle)
  if (exists === 'missing') return { ok: false, message: `@${handle} does not exist on Instagram.` }

  // Persona is constant across senders per the brief. Copied from an existing
  // account so a new one cannot drift from the others.
  const template = await prisma.senderAccount.findFirst({ orderBy: { createdAt: 'asc' } })
  if (!template) return { ok: false, message: 'No existing account to copy the persona from. Run pnpm db:seed.' }

  const sender = await prisma.senderAccount.create({
    data: {
      handle,
      displayName,
      personaName: template.personaName,
      personaRole: template.personaRole,
      personaBrand: template.personaBrand,
      personaPhone: template.personaPhone,
      personaEmail: template.personaEmail,
      autoSendEnabled: false,
      dailyCap: template.dailyCap,
      status: 'ACTIVE',
    },
  })

  await prisma.messageVariant.createMany({
    data: MESSAGE_VARIANTS.map((v) => ({ senderId: sender.id, label: v.label, body: v.body })),
  })

  // Same rule as addTarget: never a pair from an account to itself.
  const targets = await prisma.targetAccount.findMany()
  for (const t of targets) {
    if (t.handle === handle) continue
    await prisma.outreachPair.create({
      data: { senderId: sender.id, targetId: t.id, cooldownDays: env.DEFAULT_COOLDOWN_DAYS, enabled: false },
    })
  }

  await audit('sender.added', `SenderAccount:${handle}`, `${targets.length} pairs created, all disabled`)
  revalidatePath('/')
  return {
    ok: true,
    message:
      exists === 'unknown'
        ? `Added @${handle}. Could not reach Instagram to confirm it exists — check the spelling. Connect it next.`
        : `Added @${handle}. Connect it next, then enable the channels you want it to message.`,
  }
}

/**
 * Remove a sending account.
 *
 * History is never deleted. Attempts record what was actually sent to real people,
 * and that record is what spacing, the unanswered-touch cap and the new-material
 * rule are computed from — deleting it would let the system re-contact someone it
 * has already written to. So an account with send history is retired (disabled,
 * disarmed, PAUSED) rather than destroyed; only a never-used account is deleted
 * outright.
 *
 * The Chrome profile is deliberately left on disk. Deleting it would throw away the
 * device identity built up by the hand login, which is unrecoverable and would make
 * a future re-add look like new hardware to Instagram.
 */
export async function removeSender(handle: string): Promise<MutationResult> {
  const sender = await prisma.senderAccount.findUnique({
    where: { handle },
    include: { pairs: { include: { attempts: { where: { status: { in: ['SENT', 'REPLIED'] } } } } } },
  })
  if (!sender) return { ok: false, message: `@${handle} not found.` }

  await cancelConnect(handle)
  const sentCount = sender.pairs.reduce((n, p) => n + p.attempts.length, 0)

  if (sentCount === 0) {
    await prisma.senderAccount.delete({ where: { handle } })
    await audit('sender.deleted', `SenderAccount:${handle}`, 'no send history')
    revalidatePath('/')
    return { ok: true, message: `Removed @${handle}. Its Chrome profile is left on disk in case you re-add it.` }
  }

  await prisma.$transaction([
    prisma.senderAccount.update({ where: { handle }, data: { autoSendEnabled: false, status: 'PAUSED' } }),
    prisma.outreachPair.updateMany({ where: { senderId: sender.id }, data: { enabled: false } }),
  ])
  await audit('sender.retired', `SenderAccount:${handle}`, `${sentCount} sent messages kept`)
  revalidatePath('/')
  return {
    ok: true,
    message: `@${handle} has sent ${sentCount} message${sentCount === 1 ? '' : 's'}, so it is retired rather than deleted — that history is what stops anyone being contacted twice.`,
  }
}

// ── Managing channels ───────────────────────────────────────────────────────

/**
 * Add a channel to watch.
 *
 * `passthrough` is the only honest default detector: `mom` is a hand-written rule
 * set for one specific publisher's `#Collaboration` convention, and applying it to
 * an arbitrary channel would silently mislabel posts. Passthrough records every post
 * and classifies nothing, which is what we can actually stand behind.
 *
 * Pairs start DISABLED, for the same reason as a new sender: adding something must
 * never be the same act as starting to message it.
 */
export async function addTarget(
  handleRaw: string,
  displayNameRaw: string,
  greetingRaw: string,
): Promise<MutationResult> {
  const handle = handleRaw.trim().replace(/^@/, '').toLowerCase()
  const displayName = displayNameRaw.trim() || handle
  // The greeting is what the recipient literally reads first ("Hi <this>,").
  const greeting = greetingRaw.trim() || displayName

  try {
    assertSafeHandle(handle)
  } catch {
    return { ok: false, message: 'That is not a valid Instagram handle (letters, numbers, dots, underscores).' }
  }
  if (await prisma.targetAccount.findUnique({ where: { handle } })) {
    return { ok: false, message: `@${handle} is already a channel you watch.` }
  }

  const exists = await handleExists(handle)
  if (exists === 'missing') return { ok: false, message: `@${handle} does not exist on Instagram.` }

  const target = await prisma.targetAccount.create({
    data: { handle, displayName, contactFirstName: greeting, kind: 'CHANNEL', detectorKey: 'passthrough' },
  })

  /**
   * An account can be both a sender and a target. That is not a mistake — messaging
   * one account you own from another is the safest possible end-to-end test, and it
   * was previously refused outright.
   *
   * The invariant that actually matters is narrower: a sender must never message
   * ITSELF. Instagram's own "message yourself" thread is a different surface and the
   * send path would not survive it, so that pair is simply not created.
   */
  const senders = await prisma.senderAccount.findMany()
  for (const s of senders) {
    if (s.handle === handle) continue
    await prisma.outreachPair.create({
      data: { senderId: s.id, targetId: target.id, cooldownDays: env.DEFAULT_COOLDOWN_DAYS, enabled: false },
    })
  }

  await audit('target.added', `TargetAccount:${handle}`, `${senders.length} pairs created, all disabled`)
  revalidatePath('/')
  return {
    ok: true,
    message:
      exists === 'unknown'
        ? `Added @${handle}, but Instagram could not be reached to confirm it exists — check the spelling.`
        : `Watching @${handle}. Turn on the accounts you want to message it from.`,
  }
}

/**
 * Stop watching a channel.
 *
 * Same rule as senders: a channel we have written to is retired, not deleted.
 * `optedOut` is a hard stop the governor checks independently of pairs, so it holds
 * even if a pair is re-enabled later by accident.
 */
export async function removeTarget(handle: string): Promise<MutationResult> {
  const target = await prisma.targetAccount.findUnique({
    where: { handle },
    include: { pairs: { include: { attempts: { where: { status: { in: ['SENT', 'REPLIED'] } } } } } },
  })
  if (!target) return { ok: false, message: `@${handle} not found.` }

  const sentCount = target.pairs.reduce((n, p) => n + p.attempts.length, 0)

  if (sentCount === 0) {
    await prisma.targetAccount.delete({ where: { handle } })
    await audit('target.deleted', `TargetAccount:${handle}`, 'never contacted')
    revalidatePath('/')
    return { ok: true, message: `Stopped watching @${handle} and removed it.` }
  }

  await prisma.$transaction([
    prisma.targetAccount.update({ where: { handle }, data: { optedOut: true } }),
    prisma.outreachPair.updateMany({ where: { targetId: target.id }, data: { enabled: false } }),
  ])
  await audit('target.retired', `TargetAccount:${handle}`, `${sentCount} sent messages kept`)
  revalidatePath('/')
  return {
    ok: true,
    message: `Stopped messaging @${handle}. ${sentCount} sent message${sentCount === 1 ? '' : 's'} kept, so it can never be contacted again by accident.`,
  }
}

/** Turn a single sender→channel route on or off. */
export async function setPairEnabled(senderHandle: string, targetHandle: string, on: boolean): Promise<MutationResult> {
  const sender = await prisma.senderAccount.findUnique({ where: { handle: senderHandle } })
  const target = await prisma.targetAccount.findUnique({ where: { handle: targetHandle } })
  if (!sender || !target) return { ok: false, message: 'That route no longer exists.' }

  if (senderHandle === targetHandle) {
    return { ok: false, message: 'An account cannot message itself.' }
  }
  if (on && target.optedOut) {
    return { ok: false, message: `@${targetHandle} is marked never-contact. Re-add it first.` }
  }

  await prisma.outreachPair.update({
    where: { senderId_targetId: { senderId: sender.id, targetId: target.id } },
    data: { enabled: on },
  })
  await audit('pair.enabled', `${senderHandle}→${targetHandle}`, on ? 'on' : 'off')
  revalidatePath('/')
  return { ok: true, message: on ? `@${senderHandle} will message @${targetHandle}.` : `Route turned off.` }
}

/** Discard a queued message without sending. Does not start the cooldown. */
export async function skipAttempt(attemptId: string, reason: string) {
  await prisma.outreachAttempt.update({
    where: { id: attemptId },
    data: { status: 'SKIPPED', error: reason || 'skipped by operator' },
  })
  await audit('attempt.skipped', `OutreachAttempt:${attemptId}`, reason)
  revalidatePath('/')
}
