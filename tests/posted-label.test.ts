import { describe, expect, it } from 'vitest'
import {
  istPostedLabel,
  detectionLatenessMinutes,
  latenessLabel,
  LATE_DETECTION_MINUTES,
} from '@/lib/time'

/**
 * The post's own clock, and how far behind it detection was.
 *
 * Both are IST, like every other date boundary here. The load-bearing case is the NEGATIVE
 * one: 14 rows on the live database have `detectedAt` before `postedAt` — physically
 * impossible, and the residue of the timezone bug that stored 6,291 timestamps 5.5 hours
 * ahead. A latency feature that renders a number for those would carry a bad measurement
 * forward under a confident label, which is the exact failure the negative age exposed in
 * the first place.
 */

describe('istPostedLabel — the date, then the IST hour in brackets', () => {
  it('puts an evening IST post on its IST day, not its UTC one', () => {
    // 20:12 IST on 12 Aug is 14:42 UTC the same day.
    expect(istPostedLabel(new Date('2026-08-12T14:42:00.000Z'))).toBe('12 Aug (20:12)')
  })

  it('keeps a late-evening post on the correct IST date when UTC has not turned over', () => {
    // 23:30 IST on 12 Aug is 18:00 UTC 12 Aug — same day both ways.
    expect(istPostedLabel(new Date('2026-08-12T18:00:00.000Z'))).toBe('12 Aug (23:30)')
  })

  it('rolls a post published after 18:30 UTC onto the NEXT IST day', () => {
    // 19:00 UTC on 12 Aug is 00:30 IST on 13 Aug. A UTC hour here would show the wrong day.
    expect(istPostedLabel(new Date('2026-08-12T19:00:00.000Z'))).toBe('13 Aug (00:30)')
  })

  it('pads the hour so the column stays aligned', () => {
    expect(istPostedLabel(new Date('2026-08-12T01:35:00.000Z'))).toBe('12 Aug (07:05)')
  })
})

describe('detectionLatenessMinutes', () => {
  it('measures the gap between publication and detection', () => {
    expect(
      detectionLatenessMinutes(new Date('2026-08-12T10:00:00Z'), new Date('2026-08-12T10:12:00Z')),
    ).toBe(12)
  })

  it('returns NULL for an impossible negative age rather than a number', () => {
    // 14 live rows look like this. "We cannot say" is the honest answer; a computed
    // number would launder a known-bad timestamp into a confident measurement.
    expect(
      detectionLatenessMinutes(new Date('2026-08-12T10:00:00Z'), new Date('2026-08-12T04:30:00Z')),
    ).toBeNull()
  })
})

describe('latenessLabel — silent on the common path', () => {
  it('says nothing about a post found on the routine cadence', () => {
    expect(latenessLabel(new Date('2026-08-12T10:00:00Z'), new Date('2026-08-12T10:08:00Z'))).toBeNull()
  })

  it('says nothing exactly AT the bound, only past it', () => {
    const posted = new Date('2026-08-12T10:00:00Z')
    const atBound = new Date(posted.getTime() + LATE_DETECTION_MINUTES * 60_000)
    expect(latenessLabel(posted, atBound)).toBeNull()
    expect(latenessLabel(posted, new Date(atBound.getTime() + 60_000))).not.toBeNull()
  })

  it('reports hours for a gap of hours', () => {
    expect(latenessLabel(new Date('2026-08-12T10:00:00Z'), new Date('2026-08-13T01:00:00Z'))).toBe(
      'found 15h later',
    )
  })

  it('reports days for a longer gap, in the singular where that reads properly', () => {
    expect(latenessLabel(new Date('2026-08-10T10:00:00Z'), new Date('2026-08-11T12:00:00Z'))).toBe(
      'found a day later',
    )
    expect(latenessLabel(new Date('2026-08-08T10:00:00Z'), new Date('2026-08-11T12:00:00Z'))).toBe(
      'found 3 days later',
    )
  })

  it('stays silent on a negative age instead of reporting a wild number', () => {
    expect(latenessLabel(new Date('2026-08-12T10:00:00Z'), new Date('2026-08-11T10:00:00Z'))).toBeNull()
  })
})
