/**
 * THE AGENT'S CHROME WINDOWS HAD SHRUNK TO 500x232, AND INSTAGRAM DRAWS NO MESSAGES IN THEM.
 *
 *   pnpm exec tsx scripts/fix-chrome-window.ts <handle> [<handle> ...] [--width 1280] [--height 860]
 *   pnpm exec tsx scripts/fix-chrome-window.ts <handle> ... --check      only report the size
 *
 * MEASURED on the sending Mac, 16 Nov (scripts/capture-dm-dom.ts): every account's window opened
 * at an inner size of 500x232. At that size Instagram renders a conversation's bubbles for about a
 * second, then its list virtualisation finds no room and unmounts them — the thread's one message
 * matched the reader at 2-3 s and was gone from the DOM by 4 s; the inbox listed 15 conversations
 * at 1 s and none from 2 s. So every unattended read since at least 27 Oct came back `unreadable`
 * and every follow-up that earned material was parked, while a read run by hand, which happened to
 * look at the 2-second mark, worked. The reading code was never wrong.
 *
 * WHY A WINDOW SIZE PERSISTS. `launchProfile` passes `viewport: null`, so a page is the size of the
 * real window, and Chrome restores each profile's last window placement from its own Preferences.
 * One session that left the window small (a Screen Sharing session at a small resolution is the
 * likely way) makes every later launch small too.
 *
 * WHAT THIS DOES, per handle: opens that account's own Chrome profile exactly as every send and read
 * does (launchProfile — same flags), on a blank page; asks Chrome for the window and the screen;
 * sets the window to a normal state at the requested size (clamped to the screen) through Chrome's
 * own window API; closes Chrome normally, which is when Chrome saves the placement; then opens the
 * profile once more and reports the size it came back at. It visits NO Instagram page, types
 * nothing, and touches no database. Chrome itself writes its Preferences — no file is edited here.
 *
 * It must not run while the agent is using that profile: Chrome then refuses a second instance
 * ("Opening in existing browser session") and this reports it and moves on — run it again a
 * minute later for that handle.
 */
import type { BrowserContext, Page } from 'patchright'
import { launchProfile } from '@/outreach/browser/session'

interface Sizes {
  inner: string
  outer: string
  screen: string
}

const SIZES = `(() => ({
  inner: window.innerWidth + 'x' + window.innerHeight,
  outer: window.outerWidth + 'x' + window.outerHeight,
  screen: screen.availWidth + 'x' + screen.availHeight,
  availW: screen.availWidth,
  availH: screen.availHeight,
}))()`

/** The size to ask for: what was requested, never larger than the screen leaves room for. PURE. */
export function targetBounds(
  want: { width: number; height: number },
  screen: { availW: number; availH: number },
): { left: number; top: number; width: number; height: number } {
  const width = Math.max(800, Math.min(want.width, screen.availW - 40))
  const height = Math.max(600, Math.min(want.height, screen.availH - 40))
  return { left: 20, top: 20, width, height }
}

function profileInUse(e: unknown): boolean {
  const m = e instanceof Error ? e.message : String(e)
  return /existing browser session|already in use|ProcessSingleton|SingletonLock/i.test(m)
}

async function open(handle: string): Promise<{ context: BrowserContext; page: Page } | null> {
  try {
    const context = await launchProfile(handle)
    const page = context.pages()[0] ?? (await context.newPage())
    return { context, page }
  } catch (e) {
    if (profileInUse(e)) {
      console.log(`  @${handle}: the agent is using this profile right now — run this again in a minute for @${handle}.`)
    } else {
      console.log(`  @${handle}: could not open the profile — ${(e as Error).message.split('\n')[0]}`)
    }
    return null
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const num = (flag: string, dflt: number) => {
    const i = argv.indexOf(flag)
    const v = i >= 0 ? Number(argv[i + 1]) : NaN
    return Number.isFinite(v) && v > 0 ? v : dflt
  }
  const want = { width: num('--width', 1280), height: num('--height', 860) }
  const checkOnly = argv.includes('--check')
  const handles = argv.filter((a, i) => !a.startsWith('--') && !['--width', '--height'].includes(argv[i - 1] ?? ''))
  if (handles.length === 0) {
    console.log('\n  Usage: pnpm exec tsx scripts/fix-chrome-window.ts <handle> [<handle> ...] [--width 1280] [--height 860] [--check]\n')
    process.exitCode = 1
    return
  }

  for (const raw of handles) {
    const handle = raw.replace(/^@/, '').toLowerCase()
    console.log('')
    const first = await open(handle)
    if (!first) continue
    try {
      const before = (await first.page.evaluate(SIZES)) as Sizes & { availW: number; availH: number }
      console.log(`  @${handle}: window opened at ${before.inner} (outer ${before.outer}); the screen leaves ${before.screen}`)
      if (checkOnly) continue

      const b = targetBounds(want, { availW: before.availW, availH: before.availH })
      const cdp = await first.context.newCDPSession(first.page)
      const { windowId } = (await cdp.send('Browser.getWindowForTarget')) as { windowId: number }
      // A maximised, minimised or full-screen window refuses new bounds; make it normal first.
      await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } })
      await cdp.send('Browser.setWindowBounds', { windowId, bounds: { ...b, windowState: 'normal' } })
      await first.page.waitForTimeout(1_500)
      const after = (await first.page.evaluate(SIZES)) as Sizes
      console.log(`  @${handle}: set to ${b.width}x${b.height} — the page is now ${after.inner}`)
    } finally {
      // A normal close is when Chrome writes the window placement into the profile's Preferences.
      await first.context.close()
    }
    if (checkOnly) continue

    const again = await open(handle)
    if (!again) continue
    try {
      const reopened = (await again.page.evaluate(SIZES)) as Sizes
      const [w, h] = reopened.inner.split('x').map(Number)
      const ok = (w ?? 0) >= 900 && (h ?? 0) >= 600
      console.log(`  @${handle}: reopened at ${reopened.inner} — ${ok ? 'the new size stuck' : 'STILL SMALL: Chrome did not keep the size'}`)
    } finally {
      await again.context.close()
    }
  }
  console.log('')
}

// Run only when invoked as a script, so targetBounds can be imported by a test.
if ((process.argv[1] ?? '').endsWith('fix-chrome-window.ts')) {
  main().catch((e: Error) => {
    console.log('\n  failed: ' + e.message.split('\n')[0] + '\n')
    process.exitCode = 1
  })
}
