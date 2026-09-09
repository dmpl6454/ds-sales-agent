import { describe, expect, it } from 'vitest'
import { killLiveOcrChildren, runCapture } from '@/detection/ocr'

/**
 * AN OCR CHILD MUST NOT OUTLIVE THE WORKER.
 *
 * Until 9 Sept 2026 pm2 managed the detection worker through `pnpm worker`, so its SIGINT
 * reached a shell and never node; each restart escalated to SIGKILL and the RapidOCR child
 * that was mid-frame was orphaned, still reading, on a 961 MB box. The worker is a direct node
 * process now and its shutdown calls `killLiveOcrChildren()`. This drives the real spawn path
 * with a process that would otherwise live 30 seconds, in both directions: a live child is
 * killed and counted, a finished child is forgotten.
 */
describe('an OCR child does not outlive the worker', () => {
  it('kills a live child on shutdown and reports the count', async () => {
    const pending = runCapture('sleep', ['30'], 60_000)
    await new Promise((r) => setTimeout(r, 100))
    expect(killLiveOcrChildren()).toBe(1)
    const result = await pending
    expect(result.ok).toBe(false)
    expect(killLiveOcrChildren()).toBe(0)
  })

  it('forgets a child that finished by itself', async () => {
    const result = await runCapture('true', [], 5_000)
    expect(result.ok).toBe(true)
    expect(killLiveOcrChildren()).toBe(0)
  })
})
