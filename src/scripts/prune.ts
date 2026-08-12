import { prisma } from '@/lib/db'
import { withSendLock } from '@/outreach/dispatcher'
import { pruneProfile, type PruneReport } from '@/outreach/browser/pruneProfile'
import { profileStatus } from '@/outreach/browser/profile'

/**
 * `pnpm ig:prune` — reclaim disposable browser cache from the sending profiles.
 *
 * DRY RUN BY DEFAULT. `--run` deletes. `--handle <h>` narrows to one account.
 *
 * ── WHY THIS SHARES THE SEND LOCK ─────────────────────────────────────────
 *
 * Deleting 481 MB out from under a running browser can corrupt the cookie database, which
 * holds the one thing in this repo that cannot be rebuilt. `pruneProfile` already refuses
 * when a Chrome process holds the directory, but that check and the delete are two separate
 * moments — a dispatch tick starting in between would walk straight into it.
 *
 * `withSendLock` is exactly the mutual exclusion needed and it already covers every path
 * that drives a browser. CLAUDE.md's instruction is explicit: do not add a second mechanism.
 * Taken PER PROFILE rather than for the whole run, so a waiting tick is delayed by one
 * profile's delete rather than by sixty-five.
 */

const args = process.argv.slice(2)
const run = args.includes('--run')
const only = args[args.indexOf('--handle') + 1]
const onlyHandle = args.includes('--handle') && only && !only.startsWith('--') ? only : null

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`

function describe(r: PruneReport): void {
  if (r.missing) {
    console.log(`@${r.handle}  no profile directory — nothing to prune`)
    return
  }
  console.log(`@${r.handle}`)
  console.log(`  profile        ${mb(r.bytesBefore)}${r.bytesAfter === null ? '' : ` -> ${mb(r.bytesAfter)}`}`)
  for (const c of r.candidates) {
    console.log(`  ${c.subpath.padEnd(20)} ${c.exists ? mb(c.bytes) : '(absent)'}`)
  }
  console.log(`  reclaimable    ${mb(r.bytesReclaimable)}`)

  if (r.refused) {
    console.log(`  REFUSED        ${r.refused}`)
    return
  }
  if (!r.deleted) {
    console.log(`  dry run        nothing deleted. Re-run with --run.`)
    return
  }
  console.log(`  freed          ${mb(r.bytesBefore - (r.bytesAfter ?? r.bytesBefore))}`)
  if (r.identityIntact) {
    console.log(`  identity       INTACT (Cookies + Local State byte-identical)`)
  } else {
    // Vanished and altered are different disasters; say which.
    if (r.identityMissing.length > 0) console.log(`  identity       *** MISSING: ${r.identityMissing.join(', ')} — restore from the backup below ***`)
    if (r.identityChanged.length > 0) console.log(`  identity       *** CHANGED: ${r.identityChanged.join(', ')} — something wrote while we worked ***`)
  }
  console.log(`  session        ${r.sessionBefore ? 'present' : 'absent'} -> ${r.sessionAfter ? 'present' : 'absent'}`)
  console.log(`  backup         ${r.backupDir}`)
}

async function main() {
  const senders = await prisma.senderAccount.findMany({
    where: onlyHandle ? { handle: onlyHandle } : {},
    orderBy: { handle: 'asc' },
    select: { handle: true },
  })
  if (senders.length === 0) {
    console.log(onlyHandle ? `no sender @${onlyHandle}` : 'no senders')
    return
  }

  console.log(run ? '── PRUNING (--run) ──\n' : '── DRY RUN — nothing will be deleted ──\n')

  const reports: PruneReport[] = []
  for (const { handle } of senders) {
    if (!run) {
      reports.push(pruneProfile({ handle, dryRun: true }))
      continue
    }
    /**
     * `withSendLock` returns null when it could not take the lock. That is NOT a failure to
     * report as an error — something is legitimately driving a browser, and the right answer
     * is to say so and leave the profile alone.
     */
    const report = await withSendLock(`prune @${handle}`, async () => pruneProfile({ handle, dryRun: false }))
    if (report === null) {
      console.log(`@${handle}  skipped — a send is in progress (the fleet send lock is held)\n`)
      continue
    }
    reports.push(report)
  }

  for (const r of reports) {
    describe(r)
    console.log('')
  }

  const before = reports.reduce((n, r) => n + r.bytesBefore, 0)
  const after = reports.reduce((n, r) => n + (r.bytesAfter ?? r.bytesBefore), 0)
  const reclaimable = reports.reduce((n, r) => n + r.bytesReclaimable, 0)
  const withProfile = reports.filter((r) => !r.missing).length

  console.log('── totals ──')
  console.log(`profiles with a directory : ${withProfile} of ${reports.length}`)
  if (run) {
    console.log(`freed                     : ${mb(before - after)}  (${mb(before)} -> ${mb(after)})`)
    const broken = reports.filter((r) => r.deleted && r.identityIntact === false)
    const lostSession = reports.filter((r) => r.deleted && r.sessionBefore && !r.sessionAfter)
    console.log(`identity intact           : ${reports.filter((r) => r.identityIntact).length} of ${reports.filter((r) => r.deleted).length} pruned`)
    if (broken.length > 0) console.log(`*** IDENTITY CHANGED on: ${broken.map((r) => '@' + r.handle).join(', ')}`)
    if (lostSession.length > 0) console.log(`*** SESSION LOST on: ${lostSession.map((r) => '@' + r.handle).join(', ')}`)
  } else {
    console.log(`reclaimable               : ${mb(reclaimable)} of ${mb(before)}`)
  }

  /**
   * The projection is the whole reason this exists, so it is printed rather than left in a
   * doc.
   *
   * Two figures, because ONE would mislead. The mean across current profiles is dragged down
   * by accounts that have barely been used; the heaviest is what every profile becomes once
   * it actually does the work. The first version printed "24.3 GB unpruned, 24.3 GB pruned"
   * — identical, because in a dry run `bytesAfter` is null and fell back to `bytesBefore`. A
   * number that is quietly wrong is worse here than no number at all.
   */
  const sized = reports.filter((r) => !r.missing)
  if (sized.length > 0) {
    const gb = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GB`
    const prunedOf = (r: PruneReport) => r.bytesAfter ?? r.bytesBefore - r.bytesReclaimable
    const meanBefore = before / sized.length
    const meanPruned = sized.reduce((n, r) => n + prunedOf(r), 0) / sized.length
    const heaviestBefore = Math.max(...sized.map((r) => r.bytesBefore))
    const heaviestPruned = Math.max(...sized.map(prunedOf))

    console.log('')
    console.log(`projection at 65 profiles, from ${sized.length} real ${sized.length === 1 ? 'profile' : 'profiles'}:`)
    console.log(`  at the current mean   ${gb(65 * meanBefore)} unpruned  ->  ${gb(65 * meanPruned)} pruned`)
    console.log(`  at the heaviest       ${gb(65 * heaviestBefore)} unpruned  ->  ${gb(65 * heaviestPruned)} pruned`)
    console.log(`  (the heaviest is what a profile becomes once it has done the work)`)
  }

  // Anything with a profile but no session still needs a hand login; say so here because
  // this is the command someone runs while thinking about profiles.
  const needsLogin = senders.filter(({ handle }) => {
    const s = profileStatus(handle)
    return s.initialised && !s.hasSession
  })
  if (needsLogin.length > 0) {
    console.log('')
    console.log(`device identity present, session gone (re-login is a device Instagram knows): ${needsLogin.map((s) => '@' + s.handle).join(', ')}`)
  }
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e)
    await prisma.$disconnect()
    process.exit(1)
  })
