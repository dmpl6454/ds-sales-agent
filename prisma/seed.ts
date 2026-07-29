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
  // NEEDS-CONFIRMATION: the brief gave "+91 60000 189766" — 11 digits, where
  // Indian mobiles are 10. Best guess written here; validatePersona() rejects it
  // until corrected, which blocks sending rather than sending it wrong.
  personaPhone: '+91 60001 89766',
  personaEmail: 'kapil@digitalsukoon.com',
}

const SENDERS = [
  {
    handle: 'maraboutmarketing',
    displayName: 'Mar About Marketing',
    // NEEDS-CONFIRMATION: one character-class away from madovermarketing_mom,
    // which can trip Meta's impersonation detection and reads oddly when
    // pitching that exact target.
    note: 'confirm handle spelling',
  },
  {
    handle: 'bollywood_society',
    displayName: 'Bollywood Society',
    note: 'NEEDS-CONFIRMATION: real @handle unknown — placeholder',
  },
  {
    handle: 'bollywood_chronicle',
    displayName: 'Bollywood Chronicle',
    note: 'NEEDS-CONFIRMATION: real @handle unknown — placeholder',
  },
] as const

const TARGETS = [
  {
    handle: 'madovermarketing_mom',
    displayName: 'Mad Over Marketing (M.O.M)',
    // NEEDS-CONFIRMATION. null renders "Hi Mad Over Marketing (M.O.M) team,"
    // which is safe. Never guess a real person's first name.
    contactFirstName: null,
    detectorKey: 'mom',
  },
  {
    handle: 'viralbhayani',
    displayName: 'Viral Bhayani',
    contactFirstName: null,
    detectorKey: 'passthrough',
  },
] as const

/** The routing matrix from the brief. sender handle -> target handles. */
const ROUTING: Record<string, string[]> = {
  maraboutmarketing: ['madovermarketing_mom'],
  bollywood_society: ['madovermarketing_mom', 'viralbhayani'],
  bollywood_chronicle: ['viralbhayani'],
}

async function main() {
  console.log('\nSeeding DS AI Sales Agent (Phase 1)\n')

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
      update: { displayName: t.displayName, detectorKey: t.detectorKey },
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
  console.log('  ⚠  NEEDS CONFIRMATION BEFORE THE FIRST REAL SEND')
  console.log('─'.repeat(74))
  console.log(`  1. Kapil's phone. Brief gave "+91 60000 189766" (11 digits; Indian`)
  console.log(`     mobiles are 10). Seeded as "${PERSONA.personaPhone}" — a guess.`)
  console.log('     The planner REFUSES to send until this validates.')
  console.log('  2. Real @handles for Bollywood Society and Bollywood Chronicle')
  console.log('     (seeded as bollywood_society / bollywood_chronicle placeholders).')
  console.log('  3. Confirm @maraboutmarketing is spelled correctly.')
  console.log('  4. contactFirstName for both targets — currently null, so messages')
  console.log('     address the publication rather than guessing a person.')
  console.log('─'.repeat(74))
  console.log('\n  Fix these in the dashboard (/senders, /targets) or Prisma Studio.')
  console.log('  DRY_RUN=1 is the default — nothing sends until you turn it off.\n')
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
