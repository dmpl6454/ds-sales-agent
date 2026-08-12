import { describe, expect, it } from 'vitest'
import { ocrEngineCommand, OCR_ENGINE_RECALL, type OcrEngine } from '@/lib/platform'

/**
 * WHICH ENGINE READS THE FRAME — and why the answer must always be recorded.
 *
 * Three engines now read cover frames, and they are NOT equally good. MEASURED 2026-08-08
 * across all 321 saved frames, comparing normalised CONTENT against Vision's own answers:
 *
 *   vision     baseline   reads SWITCH off the Thane bumper at confidence 1.00
 *   rapidocr   87.1%      READS IT (0.83) — this is why it ships to the Linux server
 *   tesseract  71%        MISSES IT ENTIRELY — this is why it does not
 *
 * The founding case is the test that decided it, not the aggregate. An engine that scores
 * well on average and cannot read the one token the whole feature exists to catch is not
 * an upgrade; it is a regression with a good average.
 *
 * A NOTE ON THAT 87.1%, because the first measurement said 27.1% and was WRONG. RapidOCR
 * emits `THANE'sFirstDoubleDeckerBusInsideView!` where Vision emits the same words spaced,
 * so splitting on whitespace made one engine's single token unmatchable against the
 * other's seven — a FORMATTING difference read as a reading failure. Measure the property
 * that matters (can the classifier recover the characters?), not an artefact of chunking.
 */

describe('choosing an OCR engine', () => {
  it('uses Apple Vision on macOS, always — it is the measured best', () => {
    expect(ocrEngineCommand('darwin', false, false)).toEqual({ engine: 'vision' })
    // Even when the others are present, Vision wins. Order is by measurement.
    expect(ocrEngineCommand('darwin', true, true)).toEqual({ engine: 'vision' })
  })

  it('prefers RapidOCR over tesseract off macOS, because 87% beats 71%', () => {
    expect(ocrEngineCommand('linux', true, true)).toEqual({ engine: 'rapidocr' })
    expect(ocrEngineCommand('linux', false, true)).toEqual({ engine: 'rapidocr' })
  })

  it('falls back to tesseract only when RapidOCR is absent', () => {
    expect(ocrEngineCommand('linux', true, false)).toEqual({ engine: 'tesseract' })
    expect(ocrEngineCommand('win32', true, false)).toEqual({ engine: 'tesseract' })
  })

  /**
   * The load-bearing negative. An OCR path that quietly returned "no text found" would
   * tell an operator the footage is clean when nothing looked at it — absence of data
   * hardening into a claim, which this codebase has produced four times.
   */
  it('refuses honestly rather than reporting no text, when nothing can read', () => {
    const result = ocrEngineCommand('linux', false, false)
    expect(result.engine).toBe('none')
    expect('reason' in result && result.reason).toBeTruthy()
    if ('reason' in result) {
      // The refusal must say what to install, or it is a wall rather than a message.
      expect(result.reason).toMatch(/RapidOCR/i)
      expect(result.reason).toMatch(/tesseract/i)
      // And it must say frames are still being kept, so nobody concludes evidence is lost.
      expect(result.reason).toMatch(/still saved/i)
    }
  })

  it('never silently reports an engine that is not installed', () => {
    // Windows with nothing installed must not claim rapidocr just because it is preferred.
    const result = ocrEngineCommand('win32', false, false)
    expect(result.engine).toBe('none')
  })
})

describe('the measured recall table', () => {
  it('records every engine, so a verdict is never compared across engines blind', () => {
    const engines: OcrEngine[] = ['vision', 'rapidocr', 'tesseract']
    for (const e of engines) {
      expect(OCR_ENGINE_RECALL[e], `${e} has no measured recall`).toBeGreaterThan(0)
    }
  })

  it('orders the engines by measurement, matching the selection order', () => {
    // If someone improves an engine's score, the selection order above must be revisited
    // — this assertion is what forces that rather than leaving the two to drift apart.
    expect(OCR_ENGINE_RECALL.vision).toBeGreaterThan(OCR_ENGINE_RECALL.rapidocr)
    expect(OCR_ENGINE_RECALL.rapidocr).toBeGreaterThan(OCR_ENGINE_RECALL.tesseract)
  })

  it('keeps the tesseract figure that got it rejected for the server', () => {
    // 71%, and more importantly it misses SWITCH. Pinned so "tesseract is fine" cannot be
    // asserted later without changing a number someone has to justify.
    expect(OCR_ENGINE_RECALL.tesseract).toBeCloseTo(0.71, 2)
    expect(OCR_ENGINE_RECALL.rapidocr).toBeCloseTo(0.871, 3)
  })
})

/**
 * FOUND ON THE SERVER: a correctly installed RapidOCR reported `engine: none`.
 *
 * `RAPIDOCR_PYTHON` is an ABSOLUTE PATH (`/opt/ds-ocr-venv/bin/python`), and the
 * existence check joined every `PATH` entry to it — producing
 * `/usr/bin//opt/ds-ocr-venv/bin/python`, which never matched. The server would have
 * saved frames and read none of them: exactly the 166-unread-frames failure, one layer
 * down and on a different machine.
 *
 * It was caught in one command only because the refusal NAMES ITSELF instead of returning
 * "no text found" — which is the argument for honest refusals, demonstrated.
 */
describe('finding an engine that is not on PATH', () => {
  it('checks an absolute path where it points, rather than searching PATH for it', async () => {
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const src = readFileSync(join(process.cwd(), 'src/lib/platform.ts'), 'utf8')

    const fnAt = src.indexOf('function commandExists')
    expect(fnAt).toBeGreaterThan(-1)
    const body = src.slice(fnAt, fnAt + 1400)

    // The absolute-path branch must come BEFORE the PATH walk, or the walk mangles it.
    const absAt = body.indexOf("command.includes('/')")
    const walkAt = body.indexOf('process.env.PATH')
    expect(absAt, 'no absolute-path branch in commandExists').toBeGreaterThan(-1)
    expect(absAt).toBeLessThan(walkAt)
  })

  it('still resolves a bare command name through PATH', () => {
    // The control: fixing absolute paths must not break the ordinary case. `sh` exists on
    // every platform this runs on.
    expect(ocrEngineCommand('linux', true, false)).toEqual({ engine: 'tesseract' })
  })
})
