import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Page, Locator } from 'playwright'
import { log } from '@/lib/logger'

/**
 * Selector diagnostics for the send path.
 *
 * PlaywrightSender's locators were written from documented structure — Instagram's
 * DM interface is unreachable logged out, so they have never met a real page. The
 * first live attempt will either work or fail on a selector, and a one-line error
 * would cost several round-trips to diagnose.
 *
 * So every candidate locator is tried through `findFirst()`, which records what
 * each one matched. On failure `dumpDiagnostic()` writes a screenshot, the
 * relevant HTML, and the full candidate report — turning selector validation into
 * a single pass instead of a guessing loop.
 *
 * Output lands in diagnostics/ (gitignored: it contains screenshots of a
 * logged-in account).
 */

const DIAGNOSTICS_DIR = resolve(process.cwd(), 'diagnostics')

export interface CandidateResult {
  label: string
  matched: number
  visible: boolean
  error?: string
}

export interface LocatorAttempt {
  /** What we were looking for, e.g. "message-button". */
  goal: string
  candidates: CandidateResult[]
  /** Label of the candidate that won, if any. */
  chosen?: string
}

/**
 * Try each named candidate in order and return the first that resolves to a
 * single visible element. Records every attempt either way.
 *
 * Deliberately does NOT accept an already-`.or()`-chained locator: chaining hides
 * which strategy actually matched, which is precisely the information needed when
 * Instagram changes its DOM.
 */
export async function findFirst(
  goal: string,
  candidates: { label: string; locator: Locator }[],
  opts: { timeoutMs?: number } = {},
): Promise<{ locator: Locator | null; attempt: LocatorAttempt }> {
  const timeoutMs = opts.timeoutMs ?? 8_000
  const attempt: LocatorAttempt = { goal, candidates: [] }

  for (const { label, locator } of candidates) {
    const result: CandidateResult = { label, matched: 0, visible: false }
    try {
      // Give the first candidate the full timeout to allow for render, then move
      // fast through the rest — the page is already loaded by then.
      const isFirst = attempt.candidates.length === 0
      await locator
        .first()
        .waitFor({ state: 'visible', timeout: isFirst ? timeoutMs : 1_500 })
        .catch(() => undefined)

      result.matched = await locator.count()
      if (result.matched > 0) {
        result.visible = await locator.first().isVisible()
      }
    } catch (err) {
      result.error = err instanceof Error ? err.message.slice(0, 120) : String(err)
    }
    attempt.candidates.push(result)

    if (result.matched > 0 && result.visible) {
      attempt.chosen = label
      return { locator: locator.first(), attempt }
    }
  }

  return { locator: null, attempt }
}

/**
 * Write everything needed to fix a broken selector without another live run.
 *
 * Returns the directory written, so the caller can put it in the error message —
 * a failure that tells you where to look is worth several that don't.
 */
export async function dumpDiagnostic(
  page: Page,
  context: {
    stage: string
    senderHandle: string
    targetHandle: string
    attempts: LocatorAttempt[]
    error?: string
  },
): Promise<string> {
  // Timestamp is derived from the page, not Date.now(), only for readability;
  // collisions are avoided by including the stage.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const dir = resolve(DIAGNOSTICS_DIR, `${stamp}_${context.senderHandle}_${context.stage}`)

  try {
    mkdirSync(dir, { recursive: true })

    await page.screenshot({ path: resolve(dir, 'screenshot.png'), fullPage: false }).catch(() => undefined)

    const html = await page.content().catch(() => '<failed to capture>')
    writeFileSync(resolve(dir, 'page.html'), html)

    // Every button and role=button on the page with its visible text. When a
    // label changes ("Message" -> "Send message"), this is the file that shows it.
    //
    // NOTE: `$$eval` is Playwright's DOM-query helper — it serialises the callback
    // and runs it against matched elements inside the page. It is not JavaScript
    // `eval()`; no string is executed and no external input reaches it.
    const buttons = await page
      .$$eval('button, [role="button"], a[role="link"]', (els) =>
        els
          .map((e) => ({
            tag: e.tagName.toLowerCase(),
            role: e.getAttribute('role'),
            text: (e.textContent ?? '').trim().slice(0, 60),
            ariaLabel: e.getAttribute('aria-label'),
          }))
          .filter((b) => b.text.length > 0 || b.ariaLabel),
      )
      .catch(() => [])

    // Anything that could plausibly be a text composer.
    const editables = await page
      .$$eval('[contenteditable="true"], textarea, input[type="text"]', (els) =>
        els.map((e) => ({
          tag: e.tagName.toLowerCase(),
          role: e.getAttribute('role'),
          ariaLabel: e.getAttribute('aria-label'),
          placeholder: e.getAttribute('placeholder'),
          contenteditable: e.getAttribute('contenteditable'),
        })),
      )
      .catch(() => [])

    const report = {
      stage: context.stage,
      url: page.url(),
      sender: context.senderHandle,
      target: context.targetHandle,
      error: context.error,
      locatorAttempts: context.attempts,
      pageButtons: buttons,
      pageEditables: editables,
    }
    writeFileSync(resolve(dir, 'report.json'), JSON.stringify(report, null, 2))

    // A human-readable summary so the common case needs no JSON reading.
    const lines: string[] = [
      `stage:  ${context.stage}`,
      `url:    ${page.url()}`,
      `sender: @${context.senderHandle}  ->  target: @${context.targetHandle}`,
      context.error ? `error:  ${context.error}` : '',
      '',
      'LOCATOR ATTEMPTS',
    ]
    for (const a of context.attempts) {
      lines.push(`  goal: ${a.goal}${a.chosen ? `  -> matched via "${a.chosen}"` : '  -> NO MATCH'}`)
      for (const c of a.candidates) {
        lines.push(
          `    ${c.label.padEnd(34)} matched=${String(c.matched).padEnd(3)} visible=${String(c.visible).padEnd(5)}${c.error ? ` err=${c.error}` : ''}`,
        )
      }
    }
    lines.push('', `BUTTONS ON PAGE (${buttons.length})`)
    for (const b of buttons.slice(0, 40)) {
      lines.push(`    <${b.tag}${b.role ? ` role=${b.role}` : ''}>  "${b.text}"${b.ariaLabel ? `  aria-label="${b.ariaLabel}"` : ''}`)
    }
    lines.push('', `EDITABLES ON PAGE (${editables.length})`)
    for (const e of editables) {
      lines.push(
        `    <${e.tag}${e.role ? ` role=${e.role}` : ''}${e.contenteditable ? ' contenteditable' : ''}>${e.ariaLabel ? ` aria-label="${e.ariaLabel}"` : ''}${e.placeholder ? ` placeholder="${e.placeholder}"` : ''}`,
      )
    }
    writeFileSync(resolve(dir, 'summary.txt'), lines.filter((l) => l !== undefined).join('\n'))

    log.warn('diagnostic written', { dir: dir.replace(process.cwd(), '.'), stage: context.stage })
  } catch (err) {
    log.error('failed to write diagnostic', { error: err instanceof Error ? err.message : String(err) })
  }

  return dir.replace(process.cwd(), '.')
}
