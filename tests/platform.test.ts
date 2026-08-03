import { describe, expect, it } from 'vitest'
import { clipboardCommand, openUrlCommand, pasteShortcut } from '@/lib/platform'

describe('pasteShortcut', () => {
  /**
   * `sendDm` used the literal 'Meta+V'. In Playwright, Meta is Command on macOS and the
   * SUPER key on Windows, where paste is Control+V — so the paste silently did nothing.
   * It failed safe (the composer read-back found an empty box and refused) but nothing
   * could ever be sent, and the error pointed at a paste bug rather than the platform.
   * `ControlOrMeta` resolves per platform.
   */
  it('is ControlOrMeta+V so Playwright resolves it per platform', () => {
    expect(pasteShortcut()).toBe('ControlOrMeta+V')
  })
})

describe('clipboardCommand', () => {
  it('uses pbcopy on macOS', () => {
    expect(clipboardCommand('darwin')).toMatchObject({ command: 'pbcopy', args: [] })
  })

  /**
   * NOT clip.exe. It encodes from the active console code page, which corrupts U+2014 —
   * and the message bodies contain 48 em-dashes. A corrupted needle line makes the
   * composer read-back refuse the send, and only when the needle happens to contain one,
   * so the failure would be intermittent rather than clean. Set-Clipboard is UTF-16.
   */
  it('uses PowerShell Set-Clipboard on Windows, not clip.exe', () => {
    const c = clipboardCommand('win32')
    expect(c.command).toBe('powershell.exe')
    expect(c.args.join(' ')).toContain('Set-Clipboard')
    expect(c.args.join(' ')).not.toContain('clip.exe')
  })

  it('refuses an unsupported platform rather than silently doing nothing', () => {
    expect(() => clipboardCommand('linux')).toThrow(/not supported/i)
  })
})

describe('openUrlCommand', () => {
  it('uses open on macOS', () => {
    expect(openUrlCommand('darwin', 'https://x.test', null)).toMatchObject({
      command: 'open',
      args: ['https://x.test'],
    })
  })

  it('targets a named browser on macOS', () => {
    expect(openUrlCommand('darwin', 'https://x.test', 'Google Chrome').args).toEqual([
      '-a',
      'Google Chrome',
      'https://x.test',
    ])
  })

  it('uses cmd start on Windows', () => {
    const c = openUrlCommand('win32', 'https://x.test', null)
    expect(c.command).toBe('cmd')
    // The empty "" is the window title `start` requires before a URL — without it,
    // start treats the URL as the title and opens nothing.
    expect(c.args).toEqual(['/c', 'start', '', 'https://x.test'])
  })

  it('refuses an unsupported platform', () => {
    expect(() => openUrlCommand('linux', 'https://x.test', null)).toThrow(/not supported/i)
  })
})
