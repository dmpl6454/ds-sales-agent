import { spawn } from 'node:child_process'

/**
 * The ONLY place this codebase branches on operating system.
 *
 * Three things in the send path were macOS-only, and each was a total blocker on
 * Windows: `pbcopy`, the `Meta+V` paste shortcut, and `open` for a URL. Keeping the
 * branch in one file means the next platform question has one obvious home rather than
 * three scattered `process.platform` checks.
 *
 * Supported: darwin and win32. Anything else throws rather than half-working — a
 * clipboard that silently does nothing produces an intermittent "composer content does
 * not match the drafted message", which points at a paste bug instead of the platform
 * and is exactly the kind of misdirection that costs a day.
 */

export type Platform = 'darwin' | 'win32' | (string & {})

export interface Cmd {
  command: string
  args: string[]
}

/**
 * Playwright's platform-resolving modifier: Meta on macOS, Control elsewhere.
 *
 * `sendDm` hardcoded 'Meta+V'. On Windows, Meta is the Super key, so the paste did
 * nothing at all.
 */
export function pasteShortcut(): string {
  return 'ControlOrMeta+V'
}

/**
 * How to put text on the clipboard.
 *
 * On Windows this is PowerShell's `Set-Clipboard`, NOT `clip.exe`. `clip.exe` encodes
 * from the active console code page, which corrupts U+2014 — and the message bodies
 * contain 48 em-dashes. A corrupted needle line makes the composer read-back refuse the
 * send, and only when the needle happens to contain one, so the failure is intermittent
 * rather than clean. `Set-Clipboard` reads UTF-16 from stdin and round-trips correctly.
 *
 * `-NoProfile` matters: a user's PowerShell profile can print banners into stdout and
 * slow startup, neither of which belongs in the send path.
 */
export function clipboardCommand(platform: Platform = process.platform): Cmd {
  if (platform === 'darwin') return { command: 'pbcopy', args: [] }
  if (platform === 'win32') {
    return {
      command: 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-Command', '$input | Set-Clipboard'],
    }
  }
  throw new Error(
    `clipboard is not supported on "${platform}" — this project runs on macOS and Windows only`,
  )
}

/** How to open a URL in the operator's browser. */
export function openUrlCommand(platform: Platform, url: string, browser: string | null): Cmd {
  if (platform === 'darwin') {
    // `open -a <app>` targets a named browser; bare `open` uses the default https
    // handler, which may not be the browser holding the Instagram session.
    return { command: 'open', args: browser ? ['-a', browser, url] : [url] }
  }
  if (platform === 'win32') {
    // `start` is a cmd builtin, and its first quoted argument is a window title —
    // omitting it makes start treat the URL as the title and open nothing.
    return { command: 'cmd', args: ['/c', 'start', '', url] }
  }
  throw new Error(`opening a URL is not supported on "${platform}"`)
}

/** Runs a Cmd, piping `stdin` when supplied. Explicit utf8 so multi-byte survives. */
export function run(cmd: Cmd, stdin?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd.command, cmd.args)
    p.on('error', reject)
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd.command} exited ${code}`))))
    if (stdin !== undefined) {
      p.stdin.write(stdin, 'utf8')
    }
    p.stdin.end()
  })
}
