import { describe, expect, it } from 'vitest'
import { buildRawPayload, evidenceRefresh, type StoredEvidence } from '@/detection/evidence'
import type { FeedPost } from '@/detection/feed'

/**
 * Tags and collaborators are captured at first sighting and, until now, never looked at
 * again — `persist` is reached only for posts NOT already stored. A publisher can add a
 * brand tag after posting, and that edit was invisible to us forever.
 *
 * Both directions are tested, and the NEGATIVE one carries the weight here: this runs over
 * every post in the window on every 15-minute pass, so a comparison that reports a change
 * when nothing changed is not a cosmetic bug — it is ~18,000 pointless row updates a day
 * against a database two hosts share. "Returns null when nothing moved" is the property
 * that makes this affordable, and it is asserted before anything else.
 */

const NOW = new Date('2026-08-13T10:00:00.000Z')

function post(over: Partial<FeedPost> = {}): FeedPost {
  return {
    shortcode: 'Dbtest00001',
    permalink: 'https://www.instagram.com/p/Dbtest00001/',
    caption: 'a caption long enough to be judged',
    postedAt: new Date('2026-08-13T09:00:00.000Z'),
    likeCount: 10,
    commentCount: 2,
    hashtags: [],
    mentions: [],
    isPaidPartnership: false,
    sponsorHandles: [],
    collabHandles: [],
    taggedAccounts: [],
    mediaType: 'clips',
    thumbnailUrl: 'https://cdn.example/frame.jpg',
    videoUrl: 'https://cdn.example/video.mp4',
    videoDurationSeconds: 30,
    ...over,
  } as FeedPost
}

function stored(over: Partial<StoredEvidence> = {}): StoredEvidence {
  return {
    taggedAccounts: '[]',
    rawPayload: buildRawPayload(post(), new Date('2026-08-13T09:05:00.000Z')),
    ...over,
  }
}

describe('evidenceRefresh — nothing moved', () => {
  it('returns null when the post is byte-identical to what is stored', () => {
    expect(evidenceRefresh(stored(), post(), NOW)).toBeNull()
  })

  it('ignores a rotated CDN url — the bytes on disk are the evidence, not the link', () => {
    const changedUrls = post({
      thumbnailUrl: 'https://cdn.example/frame-ROTATED.jpg',
      videoUrl: 'https://cdn.example/video-ROTATED.mp4',
    })
    expect(evidenceRefresh(stored(), changedUrls, NOW)).toBeNull()
  })

  it('ignores tag ORDER and case — a reordered list is the same set of accounts', () => {
    const s = stored({ taggedAccounts: JSON.stringify(['RoyalCanin.India', 'karanjohar']) })
    const p = post({ taggedAccounts: ['karanjohar', 'royalcanin.india'] })
    expect(evidenceRefresh(s, p, NOW)).toBeNull()
  })

  it('does not report a change when the stored payload predates the flag', () => {
    // A row with no payload knows nothing about is_paid_partnership. Absence must not
    // read as `false` and produce a spurious "the flag changed" on every single pass.
    const s = stored({ rawPayload: null })
    expect(evidenceRefresh(s, post({ isPaidPartnership: false }), NOW)).toBeNull()
  })

  it('survives a corrupt payload without reporting a change', () => {
    const s = stored({ rawPayload: '{not json at all' })
    expect(evidenceRefresh(s, post(), NOW)).toBeNull()
  })
})

describe('evidenceRefresh — the evidence actually moved', () => {
  it('catches a brand tag added to a post AFTER it went up', () => {
    const out = evidenceRefresh(stored(), post({ taggedAccounts: ['royalcanin.india'] }), NOW)
    expect(out).not.toBeNull()
    expect(out!.changed).toEqual(['tags'])
    expect(JSON.parse(out!.taggedAccounts)).toEqual(['royalcanin.india'])
  })

  it('catches a collaborator added later — both parties opted in, so it is stronger evidence', () => {
    const out = evidenceRefresh(stored(), post({ collabHandles: ['thechitthi'] }), NOW)
    expect(out!.changed).toEqual(['collaborators'])
    expect(JSON.parse(out!.rawPayload).collabHandles).toEqual(['thechitthi'])
  })

  it('catches a tag being REMOVED, not only added', () => {
    const s = stored({ taggedAccounts: JSON.stringify(['royalcanin.india']) })
    const out = evidenceRefresh(s, post({ taggedAccounts: [] }), NOW)
    expect(out!.changed).toEqual(['tags'])
    expect(JSON.parse(out!.taggedAccounts)).toEqual([])
  })

  it('catches the publisher turning ON Instagram’s own paid-partnership flag', () => {
    const out = evidenceRefresh(stored(), post({ isPaidPartnership: true }), NOW)
    expect(out!.changed).toEqual(['paid-partnership-flag'])
  })

  it('reports every field that moved, so the log names the real reason', () => {
    const out = evidenceRefresh(
      stored(),
      post({ taggedAccounts: ['nutellaindia'], collabHandles: ['thechitthi'], sponsorHandles: ['crocsindia'] }),
      NOW,
    )
    expect(out!.changed).toEqual(['tags', 'collaborators', 'sponsors'])
  })

  it('writes the freshest CDN urls once a row is being updated anyway', () => {
    const p = post({ taggedAccounts: ['nutellaindia'], thumbnailUrl: 'https://cdn.example/NEW.jpg' })
    const out = evidenceRefresh(stored(), p, NOW)
    expect(JSON.parse(out!.rawPayload).thumbnailUrl).toBe('https://cdn.example/NEW.jpg')
    expect(JSON.parse(out!.rawPayload).capturedAt).toBe(NOW.toISOString())
  })
})

describe('buildRawPayload is the ONE writer of the payload shape', () => {
  it('does not carry taggedAccounts — that fact has a column, and two stores would drift', () => {
    const payload = JSON.parse(buildRawPayload(post({ taggedAccounts: ['nutellaindia'] }), NOW))
    expect(payload).not.toHaveProperty('taggedAccounts')
  })

  it('carries exactly the seven keys the corpus was built with', () => {
    expect(Object.keys(JSON.parse(buildRawPayload(post(), NOW))).sort()).toEqual([
      'capturedAt',
      'collabHandles',
      'isPaidPartnership',
      'sponsorHandles',
      'thumbnailUrl',
      'videoDurationSeconds',
      'videoUrl',
    ])
  })
})
