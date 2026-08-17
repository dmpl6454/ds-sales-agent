import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3'
import { PrismaClient } from '../src/generated/prisma/client'
import { MESSAGE_VARIANTS } from './variants'
import { BRAND_MESSAGE_VARIANTS } from './brandVariants'
import { BESPOKE_DRAFTS } from './bespoke'

/**
 * Idempotent seed. Safe to re-run: upserts by natural key and never deletes
 * history (attempts, campaigns, runs).
 *
 * Values marked NEEDS-CONFIRMATION are placeholders. The seed prints a loud
 * checklist of them at the end, and `validatePersona()` in the outreach planner
 * will refuse to send while the phone number is malformed — so a wrong number
 * cannot reach a recipient, it can only block the send.
 */

const adapter = new PrismaBetterSqlite3({
  url: process.env.DATABASE_URL ?? 'file:./prisma/dev.db',
})
const prisma = new PrismaClient({ adapter })

/**
 * The persona is identical across all three senders, per the brief: "Kapil Jain
 * and his details are constant." It lives per-sender in the schema so it CAN be
 * varied later without a migration.
 */
const PERSONA = {
  personaName: 'Kapil Jain',
  personaRole: 'Co-founder',
  personaBrand: 'Bollywood Society',
  // Confirmed correct as written (2026-07-29), including the 11th digit.
  personaPhone: '+91 60000 189766',
  personaEmail: 'kapil@digitalsukoon.com',
}

const SENDERS = [
  {
    handle: 'madaboutmarketingg',
    displayName: 'Mad About Marketing',
  },
  {
    handle: 'bollywoodsocietyy',
    displayName: 'Bollywood Society',
  },
  {
    handle: 'bollywoodchronicle',
    displayName: 'Bollywood Chronicle',
  },
] as const

/**
 * Handles seeded before the real ones were confirmed. Renamed in place rather than
 * re-inserted, so history already attached to them is kept and no duplicate sender
 * rows appear.
 *
 * The handle must be byte-exact: it is the Chrome profile directory name, and the
 * send path refuses to type anything if the profile's logged-in username does not
 * match. Both of the 2026-07-30 corrections were a doubled final letter
 * (`bollywoodsociety` → `bollywoodsocietyy`, `maraboutmarketing` →
 * `madaboutmarketingg`), which is exactly the kind of thing that reads as correct.
 * Confirmed against the accounts' own saved logins.
 */
const HANDLE_RENAMES: Record<string, string> = {
  bollywood_society: 'bollywoodsocietyy',
  bollywood_chronicle: 'bollywoodchronicle',
  bollywoodsociety: 'bollywoodsocietyy',
  maraboutmarketing: 'madaboutmarketingg',
}

const TARGETS = [
  {
    handle: 'madovermarketing_mom',
    displayName: 'Mad Over Marketing (M.O.M)',
    // Greeting is the channel/brand name, not a personal name — so the message
    // opens "Hi Mad Over Marketing," rather than guessing at a person.
    contactFirstName: 'Mad Over Marketing',
    detectorKey: 'mom',
  },
  /**
   * `semantic`, not `passthrough`.
   *
   * This channel discloses NOTHING — measured 2026-08-03 across 48 live posts:
   * is_paid_partnership 0/48, sponsor_tags absent, branded_content_tag_info absent,
   * #ad / #sponsored / #collaboration 0/48 — while roughly half its ~62 posts/day are
   * commercial. `passthrough` recorded them all and judged none, so every paid post
   * on the higher-volume of the two channels was invisible.
   *
   * The semantic detector filters on hashtags atypical for this channel (free) and
   * sends only the survivors to a model. With no DEEPSEEK_API_KEY it stores posts and
   * reports "not configured" rather than a silent zero, so switching this key on
   * before the key exists changes nothing except what the dashboard admits.
   */
  {
    handle: 'viralbhayani',
    displayName: 'Viral Bhayani',
    contactFirstName: 'Viral Bhayani',
    detectorKey: 'semantic',
  },
  /**
   * A burner Tabish controls, used to prove the send path end to end before it
   * touches a real prospect. This is the throwaway-account rehearsal the research
   * recommended, and it is the difference between "the first live send is the test"
   * and "the first live send is a delivery".
   *
   * `passthrough` because it publishes no campaigns — outreach is never blocked on
   * detection, so a target with nothing to hook onto still gets a message.
   */
  {
    handle: 'priyanshu123321123',
    displayName: 'Burner (test target)',
    contactFirstName: 'Priyanshu',
    detectorKey: 'passthrough',
  },
] as const

/**
 * The routing matrix from the brief, plus the burner.
 *
 * Every sender routes to the burner so each account's Chrome profile can be proven
 * separately — a login that works for one account says nothing about the other two.
 */
const ROUTING: Record<string, string[]> = {
  madaboutmarketingg: ['madovermarketing_mom', 'priyanshu123321123'],
  bollywoodsocietyy: ['madovermarketing_mom', 'viralbhayani', 'priyanshu123321123'],
  bollywoodchronicle: ['viralbhayani', 'priyanshu123321123'],
}

/** Pairs whose target is the burner. Used by `pnpm burner` to isolate the test. */
export const BURNER_TARGET = 'priyanshu123321123'

async function main() {
  console.log('\nSeeding DS AI Sales Agent (Phase 1)\n')

  // Rename before upserting, so a placeholder row is updated rather than left
  // orphaned beside a new one.
  for (const [from, to] of Object.entries(HANDLE_RENAMES)) {
    const legacy = await prisma.senderAccount.findUnique({ where: { handle: from } })
    if (!legacy) continue
    const collision = await prisma.senderAccount.findUnique({ where: { handle: to } })
    if (collision) {
      await prisma.senderAccount.delete({ where: { id: legacy.id } })
      console.log(`  renamed  @${from} → @${to} (target already existed; dropped placeholder)`)
    } else {
      await prisma.senderAccount.update({ where: { id: legacy.id }, data: { handle: to } })
      console.log(`  renamed  @${from} → @${to}`)
    }
  }

  for (const s of SENDERS) {
    await prisma.senderAccount.upsert({
      where: { handle: s.handle },
      update: { displayName: s.displayName, ...PERSONA },
      create: {
        handle: s.handle,
        displayName: s.displayName,
        ...PERSONA,
        autoSendEnabled: false, // graduation is deliberate, never a default
        dailyCap: 5,
        status: 'ACTIVE',
      },
    })
    console.log(`  sender   @${s.handle}`)
  }

  for (const t of TARGETS) {
    await prisma.targetAccount.upsert({
      where: { handle: t.handle },
      update: { displayName: t.displayName, detectorKey: t.detectorKey, contactFirstName: t.contactFirstName },
      create: {
        handle: t.handle,
        displayName: t.displayName,
        contactFirstName: t.contactFirstName,
        kind: 'CHANNEL',
        // Seeded channels are watched publishers, never recipients.
        role: 'WATCH',
        detectorKey: t.detectorKey,
      },
    })
    console.log(`  target   @${t.handle}  (detector: ${t.detectorKey})`)
  }

  let pairCount = 0
  for (const [senderHandle, targetHandles] of Object.entries(ROUTING)) {
    const sender = await prisma.senderAccount.findUniqueOrThrow({ where: { handle: senderHandle } })
    for (const targetHandle of targetHandles) {
      const target = await prisma.targetAccount.findUniqueOrThrow({ where: { handle: targetHandle } })
      await prisma.outreachPair.upsert({
        where: { senderId_targetId: { senderId: sender.id, targetId: target.id } },
        update: {},
        create: { senderId: sender.id, targetId: target.id, cooldownDays: 7, enabled: true },
      })
      pairCount += 1
      console.log(`  pair     @${senderHandle} → @${targetHandle}`)
    }
  }

  // Bespoke first messages, one written from scratch per recipient. Preferred over
  // the rotating variants — Meta's spam policy makes uniqueness the top safety
  // control at this volume, and a shared skeleton does not count as variation.
  for (const d of BESPOKE_DRAFTS) {
    const sender = await prisma.senderAccount.findUnique({ where: { handle: d.sender } })
    const target = await prisma.targetAccount.findUnique({ where: { handle: d.target } })
    if (!sender || !target) continue
    await prisma.outreachPair.update({
      where: { senderId_targetId: { senderId: sender.id, targetId: target.id } },
      data: { bespokeBody: d.body, bespokeNote: d.note },
    })
    console.log(`  bespoke  @${d.sender} → @${d.target}`)
  }

  /**
   * Variants are per-sender so reply rates can be compared per account later, and per
   * POOL so a brand never receives the publisher-partnership pitch.
   *
   * `targetKind` is matched in the lookup as well as written on create. Without it the
   * two pools collide on `label`: a brand variant and a channel variant sharing a name
   * would overwrite each other, and the LRU in `plan.ts` would hand a media-buying body
   * to a publisher.
   */
  let variantCount = 0
  let brandVariantCount = 0

  /**
   * EVERY sender in the database, not just the hardcoded SENDERS list above.
   *
   * This iterated `SENDERS` and so silently skipped any account added through the
   * dashboard — including `@tabishmukaddam1`, the throwaway designated for brand
   * outreach, which ended up with 12 channel variants and **zero** brand variants.
   * `plan.ts` throws when a sender has no variant for the pool it needs, so the first
   * brand pair would have failed with "no enabled BRAND message variants" for the one
   * account meant to send them.
   *
   * `addSender` in actions.ts copies the channel pool for new accounts; this is the
   * backfill that makes an existing account whole. Both are needed: the seed cannot see
   * the future and `addSender` cannot see a pool added after the account was.
   */
  const everySender = await prisma.senderAccount.findMany({ select: { handle: true } })
  for (const s of everySender) {
    const sender = await prisma.senderAccount.findUniqueOrThrow({ where: { handle: s.handle } })

    for (const [kind, pool] of [
      ['CHANNEL', MESSAGE_VARIANTS],
      ['BRAND', BRAND_MESSAGE_VARIANTS],
    ] as const) {
      for (const v of pool) {
        const existing = await prisma.messageVariant.findFirst({
          where: { senderId: sender.id, label: v.label, targetKind: kind },
        })
        if (existing) {
          await prisma.messageVariant.update({ where: { id: existing.id }, data: { body: v.body } })
        } else {
          await prisma.messageVariant.create({
            data: { senderId: sender.id, label: v.label, body: v.body, targetKind: kind },
          })
        }
        if (kind === 'BRAND') brandVariantCount += 1
        else variantCount += 1
      }
    }
  }
  console.log(`  variants ${variantCount} channel (${MESSAGE_VARIANTS.length} × ${SENDERS.length} senders)`)
  console.log(`           ${brandVariantCount} brand   (${BRAND_MESSAGE_VARIANTS.length} × ${SENDERS.length} senders)`)

  console.log(`\n  ${SENDERS.length} senders · ${TARGETS.length} targets · ${pairCount} routing pairs\n`)

  console.log('─'.repeat(74))
  console.log('  CONFIRMED 2026-07-29')
  console.log('─'.repeat(74))
  console.log(`  phone     ${PERSONA.personaPhone}  (11 digits, confirmed correct as written)`)
  console.log('  senders   @madaboutmarketingg, @bollywoodsocietyy, @bollywoodchronicle')
  console.log('  greeting  channel/brand name — "Hi Mad Over Marketing," / "Hi Viral Bhayani,"')
  console.log('─'.repeat(74))
  console.log('\n  Edit any of this in the dashboard (/senders, /targets) or Prisma Studio.')
  console.log('  Bespoke first messages are seeded per recipient. Review with: pnpm queued\n')
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
