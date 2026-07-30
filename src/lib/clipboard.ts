import { spawn } from 'node:child_process'

/**
 * Puts text on the macOS clipboard.
 *
 * Used by two callers for different reasons: `pnpm send` so you can paste by hand,
 * and the automated sender so it can paste with a real Cmd+V. The second is why
 * this matters more than convenience — a paste event from the OS clipboard is a
 * genuine user action carrying `isTrusted: true`, whereas setting the composer's
 * value directly is not.
 *
 * `pbcopy` takes its input on stdin, which `promisify(execFile)` does not expose,
 * hence spawn.
 */
export function copyToClipboard(text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn('pbcopy')
    p.on('error', reject)
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`pbcopy exited ${code}`))))
    p.stdin.write(text)
    p.stdin.end()
  })
}
