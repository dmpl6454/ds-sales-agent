import { describe, it, expect, afterAll, vi } from 'vitest'
import { openOutreachDb, seedSender, senderId, setSetting } from './helpers/outreach-db'

/**
 * THE SCREENS ASK THE SAME HOLDER VERDICT ROTATION DOES (review, 17 Oct 2026).
 *
 * After the presence rule, rotation skips @bollywoodchronicle (signed in on no Mac seen in 3 days)
 * and the planner releases its drafts — while /senders filed it under "Sending on their own" and
 * /targets counted it among the accounts that "can send right now", because both read the session
 * record alone. The drift `availability.ts` exists to prevent. Driven on the HOSTED shape
 * (`SEND_ENABLED=false`: the session record is the witness), against real builders.
 */

vi.mock('@/outreach/browser/profile', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/outreach/browser/profile')>()),
  profileStatus: (handle: string) => ({ handle, dir: `/tmp/profiles/${handle}`, initialised: false, hasSession: false }),
}))

process.env.SEND_ENABLED = 'false'
process.env.AUTOPILOT_ENABLED = 'false'

const db = await openOutreachDb('unheld-screens')
const { prisma } = await import('@/lib/db')
const { buildAccountsPage } = await import('@/app/view-model/accounts-page')
const { buildProspectsPage } = await import('@/app/view-model/prospects-page')

afterAll(async () => {
  await db.close(prisma)
})

for (const handle of ['bollywoodchronicle', 'bollywoodpaparazzii', 'totalfilmii']) await seedSender(prisma, { handle })

const rowOf = async (handle: string) => {
  const page = await buildAccountsPage()
  for (const g of page.groups) for (const r of g.rows) if (r.handle === handle) return { group: g.key, row: r, page }
  throw new Error(`no row for ${handle}`)
}

describe('no presence row — no witness, every screen unchanged', () => {
  it('all three read as sending on their own, and /targets counts three', async () => {
    expect((await rowOf('bollywoodchronicle')).group).toBe('ready')
    expect((await buildProspectsPage()).sendersAble).toBe(3)
  })
})

describe('the Studio lists two of the three; chronicle only on a Mac gone a month', () => {
  it('/senders files chronicle as needing a sign-in, naming the sending Mac — not "Sending on their own"', async () => {
    await setSetting(prisma, 'activeDevice', 'DMPLs Mac Studio')
    await setSetting(
      prisma,
      'devicePresence',
      JSON.stringify([
        { device: 'tabish-mac', at: new Date(Date.now() - 30 * 86_400_000).toISOString(), handles: ['bollywoodchronicle', 'bollywoodpaparazzii', 'totalfilmii'] },
        { device: 'DMPLs Mac Studio', at: new Date(Date.now() - 30_000).toISOString(), handles: ['bollywoodpaparazzii', 'totalfilmii'] },
      ]),
    )
    const { group, row, page } = await rowOf('bollywoodchronicle')
    expect(group).toBe('needs-login')
    expect(row.state).toBe('setup')
    expect(row.connected).toBe(false)
    expect(row.todo).toContain('no Mac that has been online in the last 3 days')
    expect(row.todo).toContain('DMPLs Mac Studio')
    expect(page.summary.ready).toBe(2)
    expect((await rowOf('totalfilmii')).group).toBe('ready')
  })

  it('/targets counts only the accounts rotation will elect', async () => {
    expect((await buildProspectsPage()).sendersAble).toBe(2)
  })

  it('the landing switch card does not count chronicle as ready, and names it as needing a sign-in', async () => {
    const { buildCeoView } = await import('@/app/view-model')
    const v = await buildCeoView()
    expect([...v.autopilot.readyHandles].sort()).toEqual(['bollywoodpaparazzii', 'totalfilmii'])
    expect(v.autopilot.needLoginHandles).toEqual(['bollywoodchronicle'])
    expect(v.accounts.find((a) => a.handle === 'bollywoodchronicle')?.state).toBe('setup')
  })

  it('the sender ids are what availability names, so the screen and rotation agree', async () => {
    const { readSenderAvailability } = await import('@/outreach/availability')
    expect([...(await readSenderAvailability()).keys()]).toEqual([senderId('bollywoodchronicle')])
  })
})
