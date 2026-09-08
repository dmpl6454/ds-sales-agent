/**
 * buildVersion.ts — WHICH BUILD IS THIS PROCESS RUNNING? One answer, four places it can come from.
 *
 * ── WHY (2026-09-08) ─────────────────────────────────────────────────────────
 * The hosted dashboard served yesterday's build for a day while the worker ran today's, a paired
 * Mac ran the DMG it was handed a week ago, and nothing on any screen said which. "Is the fix
 * live?" was answerable only by ssh. The DMG's own docblock already warns that installed Macs do
 * NOT auto-update; the missing half was a screen that shows the drift.
 *
 * Precedence, and why each rung exists:
 *   1. DS_BUILD_SHA — baked into the Next bundle at BUILD time (next.config.ts). The web tier
 *      may be built on a machine other than the one serving it (the Linode cannot build it any
 *      more — OOM-killed three times on 8 Sept), so the running process's cwd says nothing about
 *      which commit its bundle came from. Only the build knows.
 *   2. a `.version` file in the working directory — written by the installer from the image's
 *      VERSION stamp, and by deploy.sh on the server. This is how a tsx-run process (the device
 *      agent, the worker) answers on a machine with no git.
 *   3. `git rev-parse --short HEAD` — the maintainer's checkout.
 *   4. 'unknown' — never a guess, never a stale constant.
 *
 * Cached after the first read: it cannot change while the process lives, and the nav asks on
 * every render.
 */
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * WHERE the answer came from matters as much as the answer: a Mac whose version came from the
 * installer's `.version` STAMP is on some image and can be told "re-run the installer"; one whose
 * version came from GIT is a development checkout and is deliberately ahead of any image.
 */
export type BuildVersionSource = 'baked' | 'stamp' | 'git' | 'unknown'
export interface BuildVersionInfo {
  version: string
  source: BuildVersionSource
}

let cached: BuildVersionInfo | null = null

export function buildVersionInfo(): BuildVersionInfo {
  if (cached) return cached
  cached = readBuildVersionAt(process.cwd(), process.env.DS_BUILD_SHA)
  return cached
}

export function buildVersion(): string {
  return buildVersionInfo().version
}

/** The precedence, with its inputs explicit so a test can drive every rung. */
export function readBuildVersionAt(cwd: string, bakedSha: string | undefined): BuildVersionInfo {
  const baked = bakedSha?.trim()
  if (baked) return { version: baked, source: 'baked' }
  try {
    const v = readFileSync(join(cwd, '.version'), 'utf8').trim()
    if (v) return { version: v, source: 'stamp' }
  } catch {
    // no stamp on disk
  }
  try {
    const v = execSync('git rev-parse --short HEAD', { cwd, stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 })
      .toString()
      .trim()
    if (v) return { version: v, source: 'git' }
  } catch {
    // no git here
  }
  return { version: 'unknown', source: 'unknown' }
}

/** Tests only. */
export function resetBuildVersionForTests(): void {
  cached = null
}
