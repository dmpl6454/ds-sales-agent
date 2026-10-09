import { describe, it, expect } from 'vitest'
import { readSource, stripComments, callsOf } from './fixtures/sourceScan'

/**
 * `pnpm ig:rejudge-channel` MAY NOT OVERTURN A DISCLOSURE (2026-10-09).
 *
 * It re-asks a post's caption of the SEMANTIC model and hands the answer to `judgeWithFrame`.
 * On a `mom` channel that answer would be a model's ORGANIC for a post the `#Collaboration`
 * rule called paid; judge's second look accepts it, and `--run` writes it — a model opinion
 * replacing the publisher's own disclosure, which `judge.ts` promises never happens ("the rule
 * POSITIVE is never touched"). And the cleanup of watermark escalations was going to be routed
 * through this very command.
 *
 * A source assertion, because the script runs `main()` against a live database on import.
 * What it pins is ORDER: the refusal must come before the model is asked and before anything
 * is written.
 */
const src = stripComments(readSource('src/scripts/rejudgeChannel.ts'))

describe('ig:rejudge-channel refuses a non-semantic channel', () => {
  it('refuses before any classifier call or write', () => {
    const guard = src.search(/if \(target\.detectorKey !== 'semantic'\) \{[\s\S]{0,600}?process\.exit\(1\)/)
    expect(guard, 'the detectorKey guard is gone').toBeGreaterThan(0)
    const firstCall = src.indexOf('classifyCaption(')
    const firstWrite = src.indexOf('prisma.detectedCampaign.update(')
    const rowsRead = src.indexOf('prisma.detectedCampaign.findMany(')
    expect(firstCall).toBeGreaterThan(0)
    expect(firstWrite).toBeGreaterThan(0)
    expect(guard).toBeLessThan(firstCall)
    expect(guard).toBeLessThan(firstWrite)
    expect(guard).toBeLessThan(rowsRead)
    expect(src.slice(guard, firstCall)).toMatch(/ig:second-look/)
  })

  /** One construction of each block, handed to both calls — the both-or-neither rule. */
  it('builds the tag block once', () => {
    expect(callsOf(src, 'tagsForStoredPost').length).toBe(1)
  })

  /**
   * Its write used to REPLACE every signal on the row, erasing `detector:semantic`, the model
   * name and the novelty scores. Only the footage evidence is this command's to replace.
   */
  it('keeps the row\'s non-frame signals on write', () => {
    const write = src.slice(src.indexOf('prisma.detectedCampaign.update('))
    expect(write).toMatch(/readStringArray\(post\.signals\)\.filter\(\(sig\) => !sig\.startsWith\('frame:'\)\)/)
  })
})
