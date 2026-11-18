import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * A DRIVE INTERRUPTED AFTER ENTER IS "MAY HAVE IT", NEVER A RETRY (18 Nov 2026).
 *
 * Found by the pre-update review of the sending Mac's build. The agent drains on SIGTERM — waits
 * for the drive holding the send lock — but Patchright closed every browser on the same signal by
 * default, so Chrome could be closed between Enter and the thread check. The drive then threw, and
 * `senders/browser.ts` files an unrecognised throw as `unknown`: retryable, back to READY, and the
 * next process sends the same message again. Two fixes, both pinned here by driving the real
 * `sendDm` through a fake page:
 *
 *   1. anything that interrupts the drive after Enter is `not-in-thread` (parked for a person);
 *      a checkpoint still propagates, and a throw before Enter is unchanged;
 *   2. a process with its own handler for a signal keeps the library off that signal.
 *
 * And one found while writing them: `context.close()` in the `finally` could throw after the drive
 * had returned, and a throw in `finally` REPLACES the return value — so even a delivered message
 * could come back as a throw, i.e. a retry.
 */

const fake = vi.hoisted(() => ({
  context: null as unknown,
  enforcementAfterEnter: false,
  enterPressed: false,
  launchOptions: null as Record<string, unknown> | null,
}))

vi.mock('@/lib/logger', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/logger')>()),
  log: { info: vi.fn(), step: vi.fn(), warn: vi.fn(), error: vi.fn(), alarm: vi.fn() },
}))
vi.mock('@/lib/clipboard', () => ({ copyToClipboard: async () => undefined }))
vi.mock('@/outreach/browser/session', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/outreach/browser/session')>()
  return {
    ...real,
    launchProfile: async () => fake.context,
    assertNoCheckpoint: () => undefined,
    assertLoggedInAs: async () => undefined,
    assertNoEnforcement: async () => {
      if (fake.enterPressed && fake.enforcementAfterEnter) {
        throw new real.CheckpointError('https://www.instagram.com/direct/t/1', 'in-page enforcement notice')
      }
    },
  }
})
vi.mock('@/outreach/browser/messageEntry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/outreach/browser/messageEntry')>()),
  clickMessageEntry: async () => ({ ok: true }),
  openThreadViaInbox: async () => false,
  dismissBlockingDialog: async () => false,
  passBusinessInterstitial: async () => undefined,
  acceptMessageRequest: async () => false,
  clickPastDialogs: async () => true,
  jitter: async () => undefined,
}))

const BODY = 'Hi,We’re an Entertainment & Pop Culture Media Network generating over 300M views every day. Let’s connect - Kapil'

interface Scenario {
  /** Throw from the profile navigation, i.e. BEFORE Enter. */
  failBeforeEnter?: boolean
  /** Throw from the Enter keypress itself — Chrome closed under the drive. */
  failOnEnter?: boolean
  /** Throw from reading the thread after Enter. */
  failReadingThread?: boolean
  /** Chrome closing throws in the finally. */
  failOnClose?: boolean
}

function fakeContext(s: Scenario) {
  let staged = ''
  let thread = 'earlier conversation'
  const composer = {
    first: () => composer,
    isVisible: async () => true,
    textContent: async () => staged,
    click: async () => undefined,
  }
  const page = {
    goto: vi.fn(async (url: string) => {
      if (s.failBeforeEnter && !url.endsWith('instagram.com/')) throw new Error('net::ERR_CONNECTION_RESET')
      return null
    }),
    url: () => 'https://www.instagram.com/direct/t/123/',
    mouse: { wheel: async () => undefined },
    keyboard: {
      press: vi.fn(async (key: string) => {
        if (key === 'Enter') {
          fake.enterPressed = true
          if (s.failOnEnter) throw new Error('Target page, context or browser has been closed')
          thread = `${thread}\n${staged}`
          staged = ''
          return
        }
        staged = BODY // the paste
      }),
    },
    getByRole: () => composer,
    getByText: () => ({ first: () => ({ isVisible: async () => false }) }),
    locator: (sel: string) => {
      if (sel === 'body') {
        return {
          textContent: async () => {
            if (fake.enterPressed && s.failReadingThread) throw new Error('Target page, context or browser has been closed')
            return thread
          },
        }
      }
      if (sel.includes('/direct/t/')) return { first: () => ({ getAttribute: async () => null }) }
      return composer
    },
  }
  const context = {
    pages: () => [page],
    newPage: async () => page,
    close: vi.fn(async () => {
      if (s.failOnClose) throw new Error('Browser has been closed')
    }),
  }
  fake.context = context
  return { page, context }
}

/** sendDm keeps its own human pauses (real setTimeouts), so time is faked and advanced. */
async function drive<T>(run: () => Promise<T>): Promise<T> {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  try {
    const p = run()
    p.catch(() => undefined) // observed below; avoid an unhandled-rejection report while time advances
    await vi.advanceTimersByTimeAsync(180_000)
    return await p
  } finally {
    vi.useRealTimers()
  }
}

const params = { senderHandle: 'bollywoodpaparazzii', targetHandle: 'sonytvofficial', body: BODY, dryRun: false }

describe('sendDm: an interruption after Enter is "may have it"', () => {
  beforeEach(() => {
    fake.enterPressed = false
    fake.enforcementAfterEnter = false
  })

  it('control: the fake page delivers, so the scenarios below reach the step they claim to', async () => {
    fakeContext({})
    const { sendDm } = await import('@/outreach/browser/sendDm')
    const r = await drive(() => sendDm(params))
    expect(r).toMatchObject({ ok: true })
    expect(fake.enterPressed).toBe(true)
  })

  it('Chrome closed by the Enter keypress → not-in-thread, never a throw (a throw is a retry)', async () => {
    const { context } = fakeContext({ failOnEnter: true })
    const { sendDm } = await import('@/outreach/browser/sendDm')
    const r = await drive(() => sendDm(params))
    expect(r).toMatchObject({ ok: false, failureCode: 'not-in-thread' })
    expect(r.ok === false && r.reason).toMatch(/may have it/)
    expect(context.close).toHaveBeenCalled()
  })

  it('Chrome closed while reading the thread after Enter → not-in-thread', async () => {
    fakeContext({ failReadingThread: true })
    const { sendDm } = await import('@/outreach/browser/sendDm')
    const r = await drive(() => sendDm(params))
    expect(r).toMatchObject({ ok: false, failureCode: 'not-in-thread' })
  })

  it('an enforcement notice after Enter still propagates as a checkpoint — it is about the ACCOUNT', async () => {
    fakeContext({})
    fake.enforcementAfterEnter = true
    const { sendDm } = await import('@/outreach/browser/sendDm')
    const { CheckpointError } = await import('@/outreach/browser/session')
    await expect(drive(() => sendDm(params))).rejects.toBeInstanceOf(CheckpointError)
  })

  it('a failure BEFORE Enter is unchanged: it propagates, and nothing calls it "may have it"', async () => {
    fakeContext({ failBeforeEnter: true })
    const { sendDm } = await import('@/outreach/browser/sendDm')
    await expect(drive(() => sendDm(params))).rejects.toThrow(/ERR_CONNECTION_RESET/)
    expect(fake.enterPressed).toBe(false)
  })

  it('a close that throws after a delivered message does not turn the delivery into a throw', async () => {
    fakeContext({ failOnClose: true })
    const { sendDm } = await import('@/outreach/browser/sendDm')
    const r = await drive(() => sendDm(params))
    expect(r).toMatchObject({ ok: true })
  })

  it('a close that throws after an interruption keeps the not-in-thread answer', async () => {
    fakeContext({ failOnEnter: true, failOnClose: true })
    const { sendDm } = await import('@/outreach/browser/sendDm')
    const r = await drive(() => sendDm(params))
    expect(r).toMatchObject({ ok: false, failureCode: 'not-in-thread' })
  })
})

describe('launchProfile: a process that drains on a signal owns that signal', () => {
  const launched: Array<Record<string, unknown>> = []
  const added: Array<[NodeJS.Signals, () => void]> = []

  beforeEach(() => {
    launched.length = 0
  })
  afterEach(() => {
    for (const [sig, fn] of added.splice(0)) process.off(sig, fn)
    vi.doUnmock('patchright')
    vi.doUnmock('@/outreach/browser/profile')
    vi.resetModules()
  })

  async function launchWith(listen: NodeJS.Signals[]) {
    for (const sig of listen) {
      const fn = () => undefined
      process.on(sig, fn)
      added.push([sig, fn])
    }
    vi.resetModules()
    vi.doMock('patchright', () => ({
      chromium: {
        launchPersistentContext: async (_dir: string, opts: Record<string, unknown>) => {
          launched.push(opts)
          return {}
        },
      },
    }))
    vi.doMock('@/outreach/browser/profile', () => ({ ensureProfileDir: () => '/tmp/ds-test-profile' }))
    const session = await vi.importActual<typeof import('@/outreach/browser/session')>('@/outreach/browser/session')
    await session.launchProfile('bollywoodpaparazzii')
    return launched[launched.length - 1]!
  }

  it('with its own SIGTERM and SIGINT handlers (the device agent), the library handles neither', async () => {
    const opts = await launchWith(['SIGTERM', 'SIGINT'])
    expect(opts.handleSIGTERM).toBe(false)
    expect(opts.handleSIGINT).toBe(false)
  })

  it('a signal the process does not handle stays the library’s, so a killed script still closes Chrome', async () => {
    const before = process.listenerCount('SIGHUP')
    const opts = await launchWith(['SIGTERM'])
    expect(opts.handleSIGTERM).toBe(false)
    expect(opts.handleSIGHUP).toBe(before === 0)
  })
})
