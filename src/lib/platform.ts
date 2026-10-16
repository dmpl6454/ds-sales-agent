import { spawn } from 'node:child_process'
import { accessSync, constants, existsSync } from 'node:fs'
import { join as joinPath } from 'node:path'

const { X_OK } = constants

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

/**
 * Which OCR engine reads a post's cover frame — the free, local alternative to a paid
 * vision API (see src/detection/ocr.ts for why the frame is read at all).
 *
 * `vision` is Apple's Vision framework, via a Swift helper this repo compiles once. It is
 * the MEASURED best: on the founding frame it read `SWITCH` off the bus bumper at
 * confidence 1.00, which tesseract missed entirely while reading the same title card.
 *
 * `tesseract` is the cross-platform fallback, used when it is on PATH. It is genuinely
 * worse, so the engine that answered is recorded on every result — comparing verdicts
 * across engines without knowing which read the frame would be its own bug.
 *
 * `none` is a REASON, never a silent zero. This is the whole reason the branch lives here:
 * on Windows there is no Vision framework, and an OCR path that quietly returned "no text
 * found" would tell the operator the footage is clean when nothing looked at it. Windows
 * gets tesseract if installed and an honest refusal otherwise — a Windows-native engine
 * (`Windows.Media.Ocr`) exists and is deliberately NOT guessed at here, because untested
 * OCR that returns empty is worse than an engine that says it is absent.
 */
export type OcrEngine = 'vision' | 'rapidocr' | 'tesseract'

/**
 * MEASURED 2026-08-08 across all 321 saved frames, RapidOCR against Vision's own answers.
 * Recorded here because the numbers are the reason for the ORDER below, and a preference
 * with no measurement attached is how tesseract nearly shipped to the server.
 *
 *   engine     content recall   founding case (`SWITCH` on the bumper)
 *   vision     baseline         reads it, confidence 1.00
 *   rapidocr   87.1%            READS IT, confidence 0.83
 *   tesseract  71%              MISSES IT ENTIRELY
 *
 * The recall figure needs its own note, because the first attempt at it said **27.1%** and
 * was wrong. RapidOCR emits `THANE'sFirstDoubleDeckerBusInsideView!` where Vision emits the
 * same words spaced — so splitting on whitespace made one engine's single token
 * unmatchable against the other's seven, and a FORMATTING difference read as a reading
 * failure. Comparing normalised CONTENT instead gives 87.1%. Measure the property that
 * matters (are the characters recoverable by the classifier?), not an artefact of how an
 * engine chunks its output.
 *
 * What RapidOCR actually loses is dense small text — cast lists, fine print — and several
 * of the "missed" Vision words are themselves garbage (`siltd`, `sisis`, `froccer`), so
 * recall on MEANINGFUL text is higher than 87%. On the founding case and both control
 * frames it recovered every decisive token: SWITCH, THANE, Double Decker, DESSANGE,
 * Sambhal, SONY, GAME SHOW.
 */
export const OCR_ENGINE_RECALL: Readonly<Record<OcrEngine, number>> = {
  vision: 1,
  rapidocr: 0.871,
  tesseract: 0.71,
} as const

/**
 * Which engine reads a cover frame, in measured order of quality.
 *
 * `vision` — Apple's Vision framework via a Swift helper this repo compiles once. Best
 * measured, and macOS only.
 *
 * `rapidocr` — ONNX Runtime, offline, no API and no key. What the LINUX SERVER uses, and
 * it exists because detection moved there and Vision does not. It ships only because it
 * was measured on the same 321 frames AND answered the founding question; tesseract was
 * rejected on exactly that question rather than on preference.
 *
 * `tesseract` — last resort, kept because it is the one engine likely to already be
 * installed on an arbitrary machine. Genuinely worse, and the engine that answered is
 * recorded on every result: comparing verdicts across engines without knowing which read
 * the frame would be its own bug.
 *
 * `none` is a REASON, never a silent zero. An OCR path that quietly returned "no text
 * found" would tell an operator the footage is clean when nothing looked at it — absence
 * of data hardening into a claim, which this codebase has produced four times.
 */
export function ocrEngineCommand(
  platform: Platform = process.platform,
  hasTesseract: boolean = commandExists('tesseract'),
  hasRapidOcr: boolean = commandExists(RAPIDOCR_PYTHON),
): { engine: OcrEngine } | { engine: 'none'; reason: string } {
  if (platform === 'darwin') return { engine: 'vision' }
  if (hasRapidOcr) return { engine: 'rapidocr' }
  if (hasTesseract) return { engine: 'tesseract' }
  return {
    engine: 'none',
    reason:
      `no OCR engine on "${platform}" — cover frames are still saved and can be read later. ` +
      `Apple's Vision framework is used on macOS; elsewhere install RapidOCR ` +
      `(87% of Vision's content, measured) or tesseract (71%, and it misses brand marks ` +
      `Vision reads). Whichever answers is recorded with every result.`,
  }
}

/**
 * The interpreter holding RapidOCR. A dedicated venv rather than the system Python: it
 * pulls in ONNX Runtime and OpenCV (~387 MB), and a server that also runs other Python
 * work must not have those versions forced on it.
 */
export const RAPIDOCR_PYTHON = process.env.RAPIDOCR_PYTHON ?? '/opt/ds-ocr-venv/bin/python'

/**
 * ── HOW AN OVER-SIZE COVER FRAME IS MADE SMALL ENOUGH TO KEEP (16 Oct 2026) ─────────────────
 *
 * MEASURED IN PRODUCTION: with the anonymous feed walled, every post arrives through the official
 * Graph API, whose cover frame is a FULL-SIZE file — the box's backfill log refused most of them
 * (`frame size out of bounds — not saved bytes=1052612 / 748357 / 591056 / 870691 / 571895`), so
 * their footage was never read. `saveFrame` now shrinks such a file before saving it, and this is
 * the one place that decides WHAT shrinks it on this host — the same rule as the OCR engine above:
 * one platform branch, in one file.
 *
 *   sips    macOS's built-in image tool. File in, file out — it cannot read stdin — so the caller
 *           stages the bytes in a temp file, asks for the dimensions first (`sipsProbeArgs`), and
 *           passes `-Z` only when the frame is larger than the box, so sips is never asked to
 *           upscale. NOT EXERCISED in the container this was written in; its arguments are pure
 *           and tested, the run is not.
 *   python  `scripts/frame-shrink.py` under the RapidOCR interpreter: OpenCV is already in that
 *           venv because RapidOCR imports it. Stdin to stdout. This is the server's path.
 *   none    a REASON, never a silent skip — the frame is then refused exactly as before, and the
 *           log says why, so "nothing could shrink it here" never reads as "the post had no frame".
 *
 * No new dependency on purpose: the box is updated by `scripts/deploy-worker-on-box.sh`, which
 * refuses a lockfile change, and `sharp` is only in node_modules as Next's optional transitive.
 */
export type FrameShrinkTool =
  | { engine: 'sips'; command: string }
  | { engine: 'python'; command: string; script: string }
  | { engine: 'none'; reason: string }

/**
 * PURE in its injected facts, like `ocrEngineCommand`: tests pass the platform and what exists.
 *
 * THE SCRIPT MUST EXIST TOO (review, 16 Oct 2026). The Python engine was chosen whenever the RapidOCR
 * interpreter existed, so a deploy that shipped without `scripts/frame-shrink.py` would have run
 * `python <missing file>` for every over-size frame and logged `exited 2: can't open file` — a reason
 * that reads like a broken image rather than a missing file. Now that is `none`, naming the file.
 * MUTATION (applied once, seen red, restored): dropping the `hasScript` check fails
 * tests/frame-shrink.test.ts "a missing scripts/frame-shrink.py is a reason naming the file…".
 */
export function frameShrinkTool(
  platform: Platform = process.platform,
  hasSips: boolean = commandExists('sips'),
  hasShrinkPython: boolean = commandExists(RAPIDOCR_PYTHON),
  script: string = joinPath(process.cwd(), 'scripts', 'frame-shrink.py'),
  hasScript: boolean = existsSync(script),
): FrameShrinkTool {
  if (platform === 'darwin' && hasSips) return { engine: 'sips', command: 'sips' }
  if (hasShrinkPython && !hasScript) {
    return {
      engine: 'none',
      reason: `the shrink script ${script} is missing on this host (the RapidOCR Python at ${RAPIDOCR_PYTHON} is here) — redeploy so scripts/frame-shrink.py is present`,
    }
  }
  if (hasShrinkPython) return { engine: 'python', command: RAPIDOCR_PYTHON, script }
  return {
    engine: 'none',
    reason:
      platform === 'darwin'
        ? `no image tool to shrink an over-size frame on "${platform}" — macOS ships sips at /usr/bin/sips; ` +
          `restore it, or set RAPIDOCR_PYTHON to a Python with OpenCV or Pillow`
        : `no image tool to shrink an over-size frame on "${platform}" — install the RapidOCR venv ` +
          `(RAPIDOCR_PYTHON, default /opt/ds-ocr-venv/bin/python, which brings OpenCV) or point ` +
          `RAPIDOCR_PYTHON at a Python with Pillow`,
  }
}

/** `sips` arguments that print a file's pixel size. PURE. */
export function sipsProbeArgs(path: string): string[] {
  return ['-g', 'pixelWidth', '-g', 'pixelHeight', path]
}

/**
 * PURE: sips's dimension report → `{ width, height }`, or null when it is not one. The output is
 * the path on one line, then `  pixelWidth: 1080` and `  pixelHeight: 1920`.
 */
export function parseSipsDimensions(stdout: string): { width: number; height: number } | null {
  const w = /pixelWidth:\s*(\d+)/.exec(stdout)
  const h = /pixelHeight:\s*(\d+)/.exec(stdout)
  const width = w ? Number(w[1]) : 0
  const height = h ? Number(h[1]) : 0
  return width > 0 && height > 0 ? { width, height } : null
}

/**
 * `sips` arguments that write `out` as a JPEG at `quality`, resampled so neither side exceeds
 * `longSide` (`-Z` keeps the aspect ratio). `longSide: null` re-encodes without resampling — the
 * caller passes null whenever the frame already fits, so whether `-Z` would ENLARGE a smaller
 * image (reports differ; not checked here) is never something this code depends on. Nothing here
 * may upscale. PURE.
 */
export function sipsShrinkArgs(input: string, out: string, longSide: number | null, quality: number): string[] {
  return [
    ...(longSide !== null ? ['-Z', String(longSide)] : []),
    '-s', 'format', 'jpeg',
    '-s', 'formatOptions', String(quality),
    input,
    '--out', out,
  ]
}

/** Is a command on PATH? Synchronous and cheap; used only to choose an engine. */
function commandExists(command: string): boolean {
  /**
   * AN ABSOLUTE PATH IS NOT SEARCHED FOR — it is checked where it points.
   *
   * FOUND ON THE SERVER, 2026-08-08. `RAPIDOCR_PYTHON` is `/opt/ds-ocr-venv/bin/python`,
   * and this function used to join every `PATH` entry to it — producing
   * `/usr/bin//opt/ds-ocr-venv/bin/python`, which of course never matched. So a correctly
   * installed RapidOCR reported `engine: none` and the server would have saved frames and
   * read none of them.
   *
   * The refusal itself behaved exactly as designed: it said so, in a sentence naming what
   * to install, rather than silently returning "no text found". That is the whole reason
   * this was caught in one command instead of showing up weeks later as a corpus of
   * unread frames — which is precisely the failure the 166-frame finding was about.
   */
  if (command.includes('/') || command.includes('\\')) {
    try {
      accessSync(command, X_OK)
      return true
    } catch {
      return false
    }
  }

  const dirs = (process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':')
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : ['']
  for (const dir of dirs) {
    if (!dir) continue
    for (const ext of exts) {
      try {
        accessSync(joinPath(dir, command + ext), X_OK)
        return true
      } catch {
        // keep looking
      }
    }
  }
  return false
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
    /**
     * LANG is forced to UTF-8, and this is load-bearing, not cosmetic. FOUND LIVE
     * 2026-08-18, first non-ASCII template: `pbcopy` interprets its stdin using the
     * locale, and the launchd-spawned device agent has NO locale set — so the U+2019
     * apostrophes in the standard message (bytes E2 80 99) were read as MacRoman and
     * staged in Instagram's composer as `‚Äô`, three characters each. The composer
     * read-back correctly refused every send (242 chars staged vs 238 drafted), from
     * the agent only: a terminal shell exports LANG, which is why the identical code
     * delivered when run from the CLI. Same trap as Windows' clip.exe corrupting
     * em-dashes, one platform over — the reason clip.exe was already rejected.
     */
    const p = spawn(cmd.command, cmd.args, {
      env: { ...process.env, LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' },
    })
    p.on('error', reject)
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd.command} exited ${code}`))))
    if (stdin !== undefined) {
      p.stdin.write(stdin, 'utf8')
    }
    p.stdin.end()
  })
}
