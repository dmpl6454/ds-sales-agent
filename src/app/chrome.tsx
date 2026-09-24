'use client'

import { useEffect, useState } from 'react'

/**
 * The one piece of shell state that lives in the BROWSER rather than in the
 * database: which theme you are reading in. (There were two; the rail's
 * collapsed state went with the rail.)
 *
 * It is written to `document.documentElement.dataset` and persisted to
 * `localStorage`, and applied before first paint by the boot script in
 * `layout.tsx`. Nothing here talks to the server, and deliberately so — a
 * preference about how a screen looks is not a fact about the fleet, and
 * round-tripping it would put a database write on the path of a button that
 * should respond in the same frame.
 *
 * ── WHY EVERY CONTROL HERE IS `mounted`-GUARDED ─────────────────────────────
 *
 * The server cannot know what `localStorage` says, so the first render must not
 * claim to. Rendering `aria-pressed="true"` on Dark from the server and then
 * finding Light in storage is a hydration mismatch AND a lie told to a screen
 * reader in between. Until mounted, the control renders in its unknown state
 * and announces nothing.
 */

type Theme = 'dark' | 'light'

function readTheme(): Theme | null {
  const t = document.documentElement.dataset.theme
  return t === 'dark' || t === 'light' ? t : null
}

/** Never let a storage failure break a control that otherwise works fine. */
function remember(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key)
    else localStorage.setItem(key, value)
  } catch {
    /* private mode, storage disabled — the toggle still works for this session */
  }
}

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme | null>(null)
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    setTheme(readTheme())
    setMounted(true)
  }, [])

  const pick = (next: Theme) => {
    document.documentElement.dataset.theme = next
    remember('ds-theme', next)
    setTheme(next)
  }

  return (
    <div className="seg" role="group" aria-label="Theme">
      <button type="button" onClick={() => pick('dark')} aria-pressed={mounted ? theme === 'dark' : undefined}>
        Dark
      </button>
      <button type="button" onClick={() => pick('light')} aria-pressed={mounted ? theme === 'light' : undefined}>
        Light
      </button>
    </div>
  )
}

