import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, writeFile, unlink, rmdir, access, stat, chmod } from 'node:fs/promises'
import { join } from 'node:path'
import { CREDENTIAL_ROOT, DATA_ROOT, FRAMES_DIR, BIN_DIR } from '@/lib/paths'

/**
 *   pnpm ig:migrate-data        (dry run — the default, like every other spending or
 *   pnpm ig:migrate-data --run   destructive command here)
 *
 * Moves the two NON-CREDENTIAL directories out of `~/.ds-sales-agent`.
 *
 * ── WHY ─────────────────────────────────────────────────────────────────────
 *
 * `~/.ds-sales-agent` holds Chrome profiles that decrypt OFFLINE — Patchright hardcodes
 * `--password-store=basic`, so the cookie key is a public constant, not a Keychain entry.
 * CLAUDE.md therefore treats the whole directory as a password file. That instruction is
 * only followable if the directory holds nothing else, and two things had accumulated in
 * it that are not secret at all: post cover frames (public CDN images) and a Swift helper
 * this repo compiles itself. Both are things a future feature — a contact sheet, a
 * support bundle, an rsync to the server — wants to touch casually, which is safe for
 * frames and catastrophic for profiles. See src/lib/paths.ts.
 *
 * ── COPY, VERIFY BY HASH, THEN UNLINK ───────────────────────────────────────
 *
 * In that order, and the middle step is not optional. `ig:prune` learned this the hard
 * way: "this does not touch the cookies" was a CLAIM, and only a hash is EVIDENCE — and
 * mutation testing then showed its verification could be replaced with a constant `true`
 * and break no test. So every file is re-read from its destination and compared by
 * SHA-256 against the source, and a single mismatch aborts the whole run with the
 * original still in place. Losing a frame is not catastrophic (the founding case
 * `DbtNU9UzWYU` aside, they are re-fetchable while the CDN URL lives) but a migration
 * that silently drops evidence is exactly the failure this codebase keeps finding late.
 *
 * NOTHING under `chrome-profiles/` or `identity-backups/` is read, moved, or opened.
 * This script never touches a credential.
 */

interface Moved {
  from: string
  to: string
  files: number
  bytes: number
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}

/**
 * One directory, non-recursive. Both directories being moved are flat by construction —
 * frames are `<shortcode>.jpg` and bin holds one compiled binary — and a recursive walk
 * would be a general-purpose file mover, which is more power than this needs and more
 * blast radius than it should have next to a credential directory.
 */
async function moveDirectory(from: string, to: string, apply: boolean): Promise<Moved | null> {
  if (!(await exists(from))) return null

  const entries = await readdir(from, { withFileTypes: true })
  const files = entries.filter((e) => e.isFile())
  let bytes = 0

  if (apply) await mkdir(to, { recursive: true })

  for (const entry of files) {
    const src = join(from, entry.name)
    const dst = join(to, entry.name)
    const data = await readFile(src)
    const mode = (await stat(src)).mode
    bytes += data.length

    if (!apply) continue

    await writeFile(dst, data)

    /**
     * THE MODE MATTERS, AND A HASH CANNOT SEE IT.
     *
     * Found by running this: the first version copied every byte, verified all 322 files
     * by SHA-256, reported success — and the Swift OCR binary landed as 644 because
     * `writeFile` creates a new file with default permissions. The bytes were perfect and
     * the file was unrunnable; `pnpm ig:ocr` immediately reported "1 could not be read"
     * on the founding case.
     *
     * The verification was not wrong, it was INCOMPLETE: it checked the property I
     * thought to check. Same shape as the pruner's mutation-testing lesson one directory
     * over — ask what the check would MISS, not whether it passes.
     */
    await chmod(dst, mode)

    // EVIDENCE, not a claim. Re-read what actually landed on disk — content AND mode.
    const written = await readFile(dst)
    if (sha256(written) !== sha256(data)) {
      throw new Error(
        `hash mismatch after copying ${entry.name} — the original is untouched at ${src}. ` +
          `Nothing further was moved.`,
      )
    }
    const writtenMode = (await stat(dst)).mode
    if (writtenMode !== mode) {
      throw new Error(
        `permissions differ after copying ${entry.name} ` +
          `(${mode.toString(8)} -> ${writtenMode.toString(8)}) — the original is untouched at ${src}. ` +
          `A binary that copies perfectly and loses its executable bit is silently useless.`,
      )
    }
  }

  // Only now, with every byte verified at the destination, is it safe to remove the source.
  if (apply) {
    for (const entry of files) await unlink(join(from, entry.name))
    // Fails harmlessly if anything unexpected remains, which is the safe direction.
    await rmdir(from).catch(() => undefined)
  }

  return { from, to, files: files.length, bytes }
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--run')

  const jobs: Array<[string, string]> = [
    [join(CREDENTIAL_ROOT, 'frames'), FRAMES_DIR],
    [join(CREDENTIAL_ROOT, 'bin'), BIN_DIR],
  ]

  console.log(apply ? 'MOVING non-credential data out of the profile directory' : 'DRY RUN — nothing will be moved')
  console.log(`  credentials stay in: ${CREDENTIAL_ROOT}`)
  console.log(`  data moves to:       ${DATA_ROOT}`)
  console.log()

  let moved = 0
  for (const [from, to] of jobs) {
    const result = await moveDirectory(from, to, apply)
    if (!result) {
      console.log(`  ${from}`)
      console.log(`    nothing there — already moved, or never created`)
      continue
    }
    moved += result.files
    const mb = (result.bytes / 1_048_576).toFixed(1)
    console.log(`  ${result.from}`)
    console.log(`    -> ${result.to}`)
    console.log(`       ${result.files} files, ${mb} MB${apply ? ' — copied, hash-verified, originals removed' : ''}`)
  }

  console.log()
  if (!apply) {
    console.log('Re-run with --run to move them. Every file is hash-verified at the destination')
    console.log('before any original is deleted, and a single mismatch aborts with nothing lost.')
  } else {
    console.log(`Done — ${moved} files moved.`)
    console.log(`${CREDENTIAL_ROOT} now holds credentials only: Chrome profiles and identity backups.`)
  }
}

main().catch((err) => {
  console.error('migration failed:', err instanceof Error ? err.message : String(err))
  process.exit(1)
})
