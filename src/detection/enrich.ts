import { EnrichedPostSchema, type DiscoveredPost, type EnrichedPost } from './types'
import { log } from '@/lib/logger'

/**
 * Enrichment: one plain HTTP GET per post, no browser, no login.
 *
 * Verified 2026-07-29 across 22 posts on both target channels: a logged-out GET
 * of /p/{shortcode}/ returns an `og:description` meta tag containing the FULL
 * caption (untruncated at 1,368 chars), like count, comment count, owner handle
 * and post date. That is everything detection needs.
 *
 * Observed formats:
 *   513 likes, 0 comments - madovermarketing_mom on July 29, 2026: "Good ol' advertising 🤌🏻".
 *   56K likes, 389 comments - madovermarketing_mom on March 12, 2025: "Lewis moving to Ferrari...".
 *   1,856 likes, 46 comments - viralbhayani on July 29, 2026: "The ageless diva #malaikaarora...".
 *
 * Counts appear both comma-grouped ("1,856") and abbreviated ("56K", "173K"),
 * and the caption may contain newlines and escaped entities.
 */

const IG_ORIGIN = 'https://www.instagram.com'

/**
 * A self-identifying crawler UA.
 *
 * Measured 2026-07-29 against a live post:
 *   Chrome UA + minimal headers ....... og:description ABSENT  (604 KB app shell)
 *   Chrome UA + full Sec-Fetch set .... og:description present (917 KB)
 *   self-identifying bot UA ........... og:description present (650 KB)
 *   curl / no UA ...................... og:description present (650 KB)
 *
 * A half-dressed browser (Chrome UA without the Sec-Fetch/client-hint headers a
 * real Chrome always sends) gets the JS app shell. An obvious crawler gets the
 * server-rendered metadata page — which is exactly what og: tags exist for.
 *
 * So we identify honestly rather than impersonating Chrome, Twitterbot, or
 * facebookexternalhit. It is accurate, it is the smaller response, and it is the
 * one that reliably works.
 */
const HEADERS: Record<string, string> = {
  'User-Agent': 'Mozilla/5.0 (compatible; DSSalesAgentBot/0.1; +https://digitalsukoon.com)',
  Accept: 'text/html,application/xhtml+xml',
  'Accept-Language': 'en-US,en;q=0.9',
}

export class EnrichParseError extends Error {
  constructor(
    public readonly shortcode: string,
    message: string,
  ) {
    super(`[${shortcode}] ${message}`)
    this.name = 'EnrichParseError'
  }
}

/**
 * Matches the og:description structure. `[\s\S]` rather than the `s` flag so the
 * caption may span newlines. Non-greedy up to the final `".` so captions
 * containing quotes still parse.
 */
const OG_PATTERN =
  /^([\d.,]+[KMB]?)\s+likes?,\s*([\d.,]+[KMB]?)\s+comments?\s+-\s+([A-Za-z0-9._]+)\s+on\s+([A-Z][a-z]+ \d{1,2}, \d{4}):\s*"([\s\S]*)"\.?\s*$/

/** "1,856" -> 1856 · "56K" -> 56000 · "1.2M" -> 1200000 */
export function parseCount(raw: string): number | null {
  const cleaned = raw.replace(/,/g, '').trim()
  const m = /^([\d.]+)([KMB])?$/.exec(cleaned)
  if (!m) return null
  const n = Number(m[1])
  if (!Number.isFinite(n)) return null
  const mult = m[2] === 'B' ? 1e9 : m[2] === 'M' ? 1e6 : m[2] === 'K' ? 1e3 : 1
  return Math.round(n * mult)
}

/** Decode the HTML entities Instagram uses in meta content. */
export function decodeEntities(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => safeCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => safeCodePoint(Number(dec)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&') // last, so "&amp;#x2764;" does not double-decode
}

function safeCodePoint(cp: number): string {
  try {
    return String.fromCodePoint(cp)
  } catch {
    return ''
  }
}

/** Pull the og:description content out of raw HTML, attribute order agnostic. */
export function extractOgDescription(html: string): string | null {
  const patterns = [
    /<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']*)["']/i,
    /<meta[^>]+content=["']([^"']*)["'][^>]+property=["']og:description["']/i,
    /<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i,
  ]
  for (const p of patterns) {
    const m = p.exec(html)
    if (m?.[1]) return m[1]
  }
  return null
}

/** Parse an og:description string into the structured fields. Pure — unit tested. */
export function parseOgDescription(
  shortcode: string,
  ogRaw: string,
  gridIndex: number,
): EnrichedPost {
  const og = decodeEntities(ogRaw).trim()
  const m = OG_PATTERN.exec(og)
  if (!m) {
    throw new EnrichParseError(
      shortcode,
      `og:description did not match the expected shape. Instagram may have changed it. Got: ${og.slice(0, 160)}`,
    )
  }
  const [, likesRaw, commentsRaw, ownerHandle, dateRaw, captionRaw] = m

  const postedAt = new Date(`${dateRaw} 12:00:00 UTC`)
  if (Number.isNaN(postedAt.getTime())) {
    throw new EnrichParseError(shortcode, `unparseable date: ${dateRaw}`)
  }

  return EnrichedPostSchema.parse({
    shortcode,
    permalink: `${IG_ORIGIN}/p/${shortcode}/`,
    ownerHandle: ownerHandle!,
    caption: captionRaw ?? '',
    likeCount: parseCount(likesRaw!),
    commentCount: parseCount(commentsRaw!),
    postedAt,
    gridIndex,
  })
}

/** Fetch and parse a single post. Throws EnrichParseError on shape change. */
export async function enrichPost(post: DiscoveredPost, timeoutMs = 15_000): Promise<EnrichedPost> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(`${IG_ORIGIN}/p/${post.shortcode}/`, {
      headers: HEADERS,
      signal: controller.signal,
      redirect: 'follow',
    })
    if (!res.ok) {
      throw new EnrichParseError(post.shortcode, `HTTP ${res.status}`)
    }
    const html = await res.text()
    const og = extractOgDescription(html)
    if (!og) {
      throw new EnrichParseError(
        post.shortcode,
        'no og:description meta tag found — page shape changed or the post was removed',
      )
    }
    return parseOgDescription(post.shortcode, og, post.gridIndex)
  } finally {
    clearTimeout(timer)
  }
}

export interface EnrichResult {
  posts: EnrichedPost[]
  failures: { shortcode: string; reason: string }[]
}

/**
 * Enrich many posts with light concurrency and a small delay between batches.
 *
 * Sequential-ish on purpose: at ~12 posts per channel per slot there is nothing
 * to gain from hammering, and a steady trickle looks like a person reading.
 */
export async function enrichAll(
  posts: DiscoveredPost[],
  opts: { concurrency?: number; delayMs?: number } = {},
): Promise<EnrichResult> {
  const concurrency = opts.concurrency ?? 3
  const delayMs = opts.delayMs ?? 400
  const out: EnrichedPost[] = []
  const failures: EnrichResult['failures'] = []

  for (let i = 0; i < posts.length; i += concurrency) {
    const batch = posts.slice(i, i + concurrency)
    const settled = await Promise.allSettled(batch.map((p) => enrichPost(p)))
    settled.forEach((r, idx) => {
      const sc = batch[idx]!.shortcode
      if (r.status === 'fulfilled') out.push(r.value)
      else {
        const reason = r.reason instanceof Error ? r.reason.message : String(r.reason)
        failures.push({ shortcode: sc, reason })
        log.warn('enrich failed', { shortcode: sc, reason })
      }
    })
    if (i + concurrency < posts.length && delayMs > 0) {
      await new Promise((r) => setTimeout(r, delayMs))
    }
  }
  return { posts: out, failures }
}
