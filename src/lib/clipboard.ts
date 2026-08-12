import { clipboardCommand, run } from './platform'

/**
 * Puts text on the clipboard.
 *
 * Used by two callers for different reasons: `pnpm send` so you can paste by hand, and
 * the automated sender so it can paste with a real key press. The second is why this
 * matters beyond convenience — a paste event from the OS clipboard is a genuine user
 * action carrying `isTrusted: true`, whereas setting the composer's value directly is
 * not.
 *
 * This was `spawn('pbcopy')` inline, which made every send fail on Windows with ENOENT.
 * Platform selection now lives in `./platform.ts`; see the note there on why Windows
 * uses PowerShell rather than `clip.exe` (em-dash corruption).
 */
export function copyToClipboard(text: string): Promise<void> {
  return run(clipboardCommand(), text)
}
