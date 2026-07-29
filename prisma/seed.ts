import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3'
import { PrismaClient } from '../src/generated/prisma/client'
import { MESSAGE_VARIANTS } from './variants'

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
    handle: 'maraboutmarketing',
    displayName: 'Mar About Marketing',
  },
  {
    handle: 'bollywoodsociety',
    displayName: 'Bollywood Society',
  },
  {
    handle: 'bollywoodchronicle',
    displayName: 'Bollywood Chronicle',
  },
] as const

/**
 * Placeholder handles seeded before the real ones were known. Renamed in place
 * rather than re-inserted, so any history already attached to them is kept and
 * no duplicate sender rows appear.
 */
const HANDLE_RENAMES: Record<string, string> = {
  bollywood_society: 'bollywoodsociety',
  bollywood_chronicle: 'bollywoodchronicle',
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
  {
    handle: 'viralbhayani',
    displayName: 'Viral Bhayani',
    contactFirstName: 'Viral Bhayani',
    detectorKey: 'passthrough',
  },
] as const

/** The routing matrix from the brief. sender handle -> target handles. */
const ROUTING: Record<string, string[]> = {
  maraboutmarketing: ['madovermarketing_mom'],
  bollywoodsociety: ['madovermarketing_mom', 'viralbhayani'],
  bollywoodchronicle: ['viralbhayani'],
}

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

  // Variants are per-sender so reply rates can be compared per account later.
  let variantCount = 0
  for (const s of SENDERS) {
    const sender = await prisma.senderAccount.findUniqueOrThrow({ where: { handle: s.handle } })
    for (const v of MESSAGE_VARIANTS) {
      const existing = await prisma.messageVariant.findFirst({
        where: { senderId: sender.id, label: v.label },
      })
      if (existing) {
        await prisma.messageVariant.update({ where: { id: existing.id }, data: { body: v.body } })
      } else {
        await prisma.messageVariant.create({
          data: { senderId: sender.id, label: v.label, body: v.body },
        })
      }
      variantCount += 1
    }
  }
  console.log(`  variants ${variantCount} (${MESSAGE_VARIANTS.length} × ${SENDERS.length} senders)`)

  console.log(`\n  ${SENDERS.length} senders · ${TARGETS.length} targets · ${pairCount} routing pairs\n`)

  console.log('─'.repeat(74))
  console.log('  CONFIRMED 2026-07-29')
  console.log('─'.repeat(74))
  console.log(`  phone     ${PERSONA.personaPhone}  (11 digits, confirmed correct as written)`)
  console.log('  senders   @maraboutmarketing, @bollywoodsociety, @bollywoodchronicle')
  console.log('  greeting  channel/brand name — "Hi Mad Over Marketing," / "Hi Viral Bhayani,"')
  console.log('─'.repeat(74))
  console.log('\n  Edit any of this in the dashboard (/senders, /targets) or Prisma Studio.')
  console.log('  Sessions are still required before autopilot: pnpm session:add --sender=<handle>\n')
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
