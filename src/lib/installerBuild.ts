/**
 * installerBuild.ts — which commit the DMG the dashboard serves was built from.
 *
 * `scripts/build-dmg.sh` writes `<dmg>.version` beside the image and `deploy.sh` uploads it to
 * the data dir beside the DMG the download route serves (2026-09-08). /senders shows it next to
 * the download button and beside each paired Mac's own agent build, so "is that Mac on the
 * current installer?" is a glance and not an ssh. Absent → null, never a guess.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { env } from '@/lib/env'
import { DATA_ROOT } from '@/lib/paths'

export function readInstallerBuild(): string | null {
  const dmg = env.AGENT_DMG_PATH ?? join(DATA_ROOT, 'DS-Sales-Agent.dmg')
  try {
    const v = readFileSync(`${dmg}.version`, 'utf8').trim()
    return v || null
  } catch {
    return null
  }
}
