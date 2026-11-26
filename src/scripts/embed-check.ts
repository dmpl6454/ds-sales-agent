/**
 * `pnpm ig:embed-check` — READ-ONLY. Does the READER a Mac build would ship read Instagram's embed pages
 * correctly, from this machine, through the client it would really use?
 *
 * `scripts/embed-badge-probe.sh` (26 Nov) showed the pages answer curl from the Mac Studio and carry the badge and
 * a caption's @mentions. That was a shell script looking at tallies. This runs the real thing — `embedFetch.ts`
 * and `embedParse.ts`, the files the agent will import — against accounts whose answer we already hold, and says
 * plainly whether each came back as held. It is the step between "a parser can be built" and "a parser is right".
 *
 * It imports only those two files and Node itself, so `scripts/embed-check-on-mac.sh` can run it from an installed
 * tree before any new build exists. No database, no setting, no login, no cookie. It changes nothing.
 *
 *   pnpm ig:embed-check                          the control accounts and posts below (at most 9 requests, 2 s apart)
 *   pnpm ig:embed-check name:v other:u gone:x    these accounts instead — v we hold as verified, u as NOT, x missing
 *   pnpm ig:embed-check --posts a,b              these post shortcodes instead        (--no-posts asks about none)
 *   pnpm ig:embed-check --transport node|curl    only this client (default: both are tried on the first account)
 *   pnpm ig:embed-check --evidence               also print cuts of the pages for a person to read
 *
 * STOP RULES, the probe's: a client that is sent to a login page, or answered 429/401, or served a login page is
 * not asked again in this run. Nothing is retried. The pages are kept in a temporary folder (public pages only),
 * named at the end, so a follow-up question needs no new request.
 *
 * Exit: 0 every control read as held · 1 something did not · 2 bad arguments.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  fetchEmbed,
  embedUserAgent,
  installedChromeMajor,
  profileEmbedUrl,
  postEmbedUrl,
  type EmbedAnswer,
  type EmbedPlatform,
  type EmbedTransportName,
} from '../detection/embedFetch'
import {
  parseProfileEmbed,
  parsePostEmbed,
  ownObjectsFor,
  usernameKeyEvidence,
  collaboratorEvidence,
  normaliseHandle,
  type ProfileEmbedReading,
  type PostEmbedReading,
} from '../detection/embedParse'

type Held = 'v' | 'u' | 'x' | '-'
interface Control {
  handle: string
  held: Held
}

const DEFAULT_CONTROLS: Control[] = [
  { handle: 'netflix_in', held: 'v' },
  { handle: 'sonytvofficial', held: 'v' },
  { handle: 'marketingmentalist', held: 'u' },
  { handle: 'chumbak_official', held: 'u' },
  { handle: 'qqqq_nope_nope_12345', held: 'x' },
]
/** Dcc4pQ8sX0N: twelve media tags and no "@" in its caption. DcyE65LPYMj: five "@" the probe saw linked. */
const DEFAULT_POSTS = ['Dcc4pQ8sX0N', 'DcyE65LPYMj']
const SPACING_MS = 2_000
const MAX_CONTROLS = 12
const MAX_POSTS = 6

const out = (line = ''): void => {
  process.stdout.write(`${line}\n`)
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}...` : s)
const printable = (s: string): string => s.replace(/[^\x20-\x7e]/g, '~')
const heldWords = (h: Held): string =>
  h === 'v' ? 'held as verified' : h === 'u' ? 'held as NOT verified' : h === 'x' ? 'does not exist' : 'nothing held'

function stop2(message: string): never {
  out(`-- STOPPED: ${message}`)
  process.exit(2)
}

interface Args {
  controls: Control[]
  posts: string[]
  transports: EmbedTransportName[]
  evidence: boolean
}

function parseArgs(argv: string[]): Args {
  const controls: Control[] = []
  let posts: string[] | null = null
  let transports: EmbedTransportName[] = ['node', 'curl']
  let evidence = false
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? ''
    if (a === '--evidence') evidence = true
    else if (a === '--no-posts') posts = []
    else if (a === '--posts') {
      const list = argv[++i] ?? ''
      posts = list.split(',').filter((p) => p !== '')
      for (const p of posts) if (postEmbedUrl(p) === null) stop2(`'${p}' is not a post shortcode.`)
      if (posts.length === 0) stop2('--posts needs a list of shortcodes, for example --posts Dcc4pQ8sX0N,DcyE65LPYMj')
    } else if (a === '--transport') {
      const t = argv[++i] ?? ''
      if (t !== 'node' && t !== 'curl') stop2("--transport takes 'node' or 'curl'.")
      transports = [t]
    } else if (a === '--help' || a === '-h') {
      out('See the top of src/scripts/embed-check.ts. Read-only: it asks Instagram’s embed pages and prints what the reader read.')
      process.exit(0)
    } else if (a.startsWith('--')) stop2(`unknown option ${a}`)
    else {
      const [rawHandle, label = '-'] = a.split(':')
      const handle = normaliseHandle(rawHandle ?? '')
      if (handle === null) stop2(`'${rawHandle ?? ''}' is not an Instagram handle.`)
      if (label !== 'v' && label !== 'u' && label !== 'x' && label !== '-') stop2(`'${a}': after the colon write v, u or x.`)
      if (!controls.some((c) => c.handle === handle)) controls.push({ handle, held: label })
    }
  }
  const finalControls = controls.length > 0 ? controls : DEFAULT_CONTROLS
  const finalPosts = posts ?? DEFAULT_POSTS
  if (finalControls.length > MAX_CONTROLS) stop2(`at most ${MAX_CONTROLS} accounts in one run.`)
  if (finalPosts.length > MAX_POSTS) stop2(`at most ${MAX_POSTS} posts in one run.`)
  return { controls: finalControls, posts: finalPosts, transports, evidence }
}

/** Why a client is not asked again, or null while it may be. */
type Refusal = string | null

function refusalOf(a: EmbedAnswer): Refusal {
  if (a.kind === 'login-redirect') return `sent to the login page (HTTP ${a.status})`
  if (a.kind === 'page' && (a.status === 429 || a.status === 401)) return `HTTP ${a.status}, told to stop`
  return null
}

function answerLine(a: EmbedAnswer): string {
  if (a.kind === 'page') return `HTTP ${a.status} | ${a.contentType ?? 'no content type'} | ${Buffer.byteLength(a.body)} bytes${a.capped ? ' (cut at the 3 MB cap)' : ''}${a.hops > 0 ? ` | after ${a.hops} redirect(s)` : ''}`
  if (a.kind === 'login-redirect') return `HTTP ${a.status} -> ${clip(a.location, 110)} = SENT TO THE LOGIN PAGE`
  if (a.kind === 'redirect-refused') return `HTTP ${a.status} -> ${clip(a.location, 110)} = a redirect this does not follow`
  return `NO ANSWER: ${clip(a.error, 140)}`
}

function profileLine(r: ProfileEmbedReading): string {
  if (r.kind === 'wall') return `   reads: A LOGIN PAGE (${r.reason})`
  if (r.kind === 'no-profile-data') return `   reads: NO PROFILE DATA (${r.reason})`
  const verdict = r.isVerified === true ? 'VERIFIED' : r.isVerified === false ? 'NOT VERIFIED' : `COULD NOT TELL (${r.undecided ?? 'no reason'})`
  const name = r.fullName === null ? 'no name read' : `name "${clip(printable(r.fullName), 50)}"`
  const followers = r.followers === null ? 'no follower count read' : `followers ${r.followers}`
  return (
    `   reads: ${verdict} | read by: ${r.basis} | ${name} | ${followers}\n` +
    `   exact: ${r.exact.objects} own object(s) of ${r.exact.keysSeen} username key(s), ${r.exact.trusted} trusted (in a script, shallowest), ${r.exact.withBadge} with a badge (true x${r.exact.trueCount}, false x${r.exact.falseCount}), ` +
    `${r.exact.undecodable} not readable, depth ${r.exact.depths.join(',') || '-'} | flat: ${r.flat.usernameKeys} key(s), true x${r.flat.ownTrue}, false x${r.flat.ownFalse}`
  )
}

function postLine(r: PostEmbedReading): string {
  if (r.kind === 'wall') return `   reads: A LOGIN PAGE (${r.reason})`
  if (r.kind === 'no-caption') return `   reads: NO CAPTION (${r.reason})`
  const list = (xs: string[]): string => (xs.length === 0 ? 'none' : xs.map((h) => `@${h}`).join(' '))
  return (
    `   reads: caption of ${r.captionChars} chars (class "${clip(r.captionClass, 40)}") | signed by ${r.owner === null ? 'nobody we could read' : `@${r.owner}`} | "@" in the text x${r.atSigns}\n` +
    `   mentions, linked as "@handle" to that account: x${r.mentions.length} (${list(r.mentions)})\n` +
    `   the looser count the probe used: x${r.looseMentions.length} (${list(r.looseMentions)}) | every account the caption links: x${r.linked.length} (${list(r.linked)})\n` +
    `   "@" words no link goes to: x${r.unlinkedAt.length} (${list(r.unlinkedAt)}) | the caption element ended on the page: ${r.closed ? 'yes' : 'NO'}`
  )
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const platform: EmbedPlatform = process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'windows' : 'linux'
  const chromeMajor = await installedChromeMajor(platform)
  const userAgent = embedUserAgent(platform, chromeMajor)
  const keepDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-embed-check-'))
  // Test-only: a stand-in for Instagram on this machine. A real run sets nothing, and the report says when it is set.
  const testOrigin = process.env.DS_EMBED_TEST_ORIGIN || undefined
  const refused: Record<EmbedTransportName, Refusal> = { node: null, curl: null }
  const servedProfile: Record<EmbedTransportName, boolean | null> = { node: null, curl: null }
  const servedPost: Record<EmbedTransportName, boolean | null> = { node: null, curl: null }
  let requests = 0

  out(`-- embed-check — read-only — ${platform} — ${new Date().toISOString().slice(0, 19).replace('T', ' ')} UTC`)
  out(`   asking as desktop Chrome ${chromeMajor}, no login, no cookie; clients: ${args.transports.join(', ')}; ${SPACING_MS / 1000} s apart`)
  if (testOrigin !== undefined) out(`   TEST ORIGIN IN USE — this is NOT Instagram: ${testOrigin}`)
  out()

  const ask = async (url: string, transport: EmbedTransportName, saveAs: string): Promise<EmbedAnswer> => {
    if (requests > 0) await sleep(testOrigin !== undefined ? 50 : SPACING_MS)
    requests++
    const a = await fetchEmbed(url, { userAgent, transport, testOrigin, curlPath: platform === 'mac' ? '/usr/bin/curl' : 'curl' })
    if (a.kind === 'page') {
      try {
        fs.writeFileSync(path.join(keepDir, saveAs), a.body)
      } catch {
        /* keeping the page is a convenience; the reading does not depend on it */
      }
    }
    const r = refusalOf(a)
    if (r !== null) refused[transport] = r
    return a
  }

  // ── the accounts ──────────────────────────────────────────────────────────────────────────────
  interface ProfileResult {
    control: Control
    transport: EmbedTransportName
    reading: ProfileEmbedReading | null
  }
  const profileResults: ProfileResult[] = []
  let chosen: EmbedTransportName | null = null

  for (let i = 0; i < args.controls.length; i++) {
    const control = args.controls[i] as Control
    const url = profileEmbedUrl(control.handle, testOrigin)
    if (url === null) continue
    // The first account is asked through every client, so we learn which of them Instagram answers.
    if (i > 0 && (chosen === null || refused[chosen] !== null)) chosen = args.transports.find((t) => servedProfile[t] === true && refused[t] === null) ?? null
    const through: EmbedTransportName[] = i === 0 ? args.transports : chosen === null ? [] : [chosen]
    if (through.length === 0) {
      out(`[profile] @${control.handle} (${heldWords(control.held)}) -> not asked: no client is being answered`)
      continue
    }
    for (const transport of through) {
      if (refused[transport] !== null) {
        out(`[profile] @${control.handle} (${heldWords(control.held)}) via ${transport} -> not asked: ${refused[transport]}`)
        continue
      }
      const a = await ask(url, transport, `profile.${control.handle}.${transport}.html`)
      out(`[profile] @${control.handle} (${heldWords(control.held)}) via ${transport} -> ${answerLine(a)}`)
      let reading: ProfileEmbedReading | null = null
      if (a.kind === 'page' && a.status === 200) {
        reading = parseProfileEmbed(a.body, control.handle)
        out(profileLine(reading))
        if (reading.kind === 'wall') refused[transport] = 'served a login page'
        if (reading.kind === 'profile') {
          const own = ownObjectsFor(a.body, control.handle)
          const shown = own.objects.find((o) => o.inScript && o.isVerified !== null) ?? own.objects.find((o) => o.isVerified !== null) ?? own.objects[0]
          if (shown && shown.keys.length > 0) {
            out(`   one own object (depth ${shown.depth}, ${shown.inScript ? 'inside a script' : 'NOT inside a script'}) has the keys: ${clip(printable(shown.keys.join(', ')), 300)}`)
          }
          const outside = own.objects.filter((o) => !o.inScript).length
          if (outside > 0) out(`   ${outside} own object(s) sit OUTSIDE any script element and are not trusted`)
        }
        if (args.evidence || i === 0 || control.held === 'u') {
          const ev = usernameKeyEvidence(a.body, control.handle)
          if (ev !== null) out(`   the page at its first username key: ${printable(clip(ev, 640))}`)
        }
      }
      if (i === 0) servedProfile[transport] = reading !== null && reading.kind === 'profile'
      profileResults.push({ control, transport, reading })
    }
    if (i === 0) chosen = args.transports.find((t) => servedProfile[t] === true) ?? null
  }
  out()

  // ── the posts ─────────────────────────────────────────────────────────────────────────────────
  interface PostResult {
    shortcode: string
    transport: EmbedTransportName
    reading: PostEmbedReading | null
  }
  const postResults: PostResult[] = []
  for (let i = 0; i < args.posts.length; i++) {
    const shortcode = args.posts[i] as string
    const url = postEmbedUrl(shortcode, testOrigin)
    if (url === null) continue
    // The first post goes through every client that is still being answered; the rest through the chosen one.
    const postChosen: EmbedTransportName | null = args.transports.find((t) => servedPost[t] === true && refused[t] === null) ?? null
    const through: EmbedTransportName[] = i === 0 ? args.transports.filter((t) => refused[t] === null) : postChosen === null ? [] : [postChosen]
    if (through.length === 0) {
      out(`[post] p/${shortcode} -> not asked: no client is being answered`)
      continue
    }
    for (const transport of through) {
      if (refused[transport] !== null) {
        out(`[post] p/${shortcode} via ${transport} -> not asked: ${refused[transport]}`)
        continue
      }
      const a = await ask(url, transport, `post.${shortcode}.${transport}.html`)
      out(`[post] p/${shortcode} via ${transport} -> ${answerLine(a)}`)
      let reading: PostEmbedReading | null = null
      if (a.kind === 'page' && a.status === 200) {
        reading = parsePostEmbed(a.body)
        out(postLine(reading))
        if (reading.kind === 'wall') refused[transport] = 'served a login page'
        const collab = collaboratorEvidence(a.body, args.evidence ? 3 : 1)
        collab.forEach((cut, n) => out(`   collaborator markup, cut ${n + 1}: ${printable(clip(cut, 680))}`))
      }
      if (i === 0) servedPost[transport] = reading !== null && reading.kind === 'post'
      postResults.push({ shortcode, transport, reading })
    }
  }
  out()

  // ── the answer ────────────────────────────────────────────────────────────────────────────────
  out('== ANSWER')
  for (const t of args.transports) {
    const p = servedProfile[t] === null ? 'not asked' : servedProfile[t] ? 'ANSWERED' : 'not answered'
    const q = servedPost[t] === null ? 'not asked' : servedPost[t] ? 'ANSWERED' : 'not answered'
    out(`   client ${t}: account page ${p}, post page ${q}${refused[t] !== null ? ` — ${refused[t]}` : ''}`)
  }

  let problems = 0
  const lines: string[] = []
  for (const control of args.controls) {
    const results = profileResults.filter((r) => r.control.handle === control.handle)
    if (results.length === 0) {
      if (control.held !== '-') problems++
      lines.push(`@${control.handle}: not asked`)
      continue
    }
    for (const r of results) {
      const reading = r.reading
      let ok: boolean
      let saw: string
      if (reading === null) {
        ok = false
        saw = 'no page'
      } else if (reading.kind !== 'profile') {
        /* A login page is never "as held", not even for the account that does not exist (review, 26 Nov 2026): in
           production a login page closes the door, and most of what official-page discovery asks about are guessed
           handles that do not exist — so a login page here would close the door on nearly every pass. */
        ok = reading.kind === 'no-profile-data' && (control.held === 'x' || control.held === '-')
        saw =
          reading.kind === 'wall'
            ? `a login page${control.held === 'x' ? ' (production would close the door on every handle that does not exist)' : ''}`
            : 'no profile data'
      } else {
        saw = reading.isVerified === true ? `verified (${reading.basis})` : reading.isVerified === false ? `not verified (${reading.basis})` : 'could not tell'
        ok = control.held === '-' || (control.held === 'v' && reading.isVerified === true) || (control.held === 'u' && reading.isVerified === false)
      }
      if (!ok) problems++
      lines.push(`@${control.handle} via ${r.transport}: ${saw}${ok ? '' : `  <-- NOT as held (${heldWords(control.held)})`}`)
    }
  }
  out(`   THE BADGE READER: ${problems === 0 ? 'every account read as we hold it' : `${problems} account reading(s) NOT as held`}`)
  for (const l of lines) out(`      ${l}`)

  let postProblems = 0
  const postLines: string[] = []
  for (const r of postResults) {
    const reading = r.reading
    if (reading === null || reading.kind !== 'post') {
      postProblems++
      postLines.push(`p/${r.shortcode} via ${r.transport}: ${reading === null ? 'no page' : reading.kind === 'wall' ? 'a login page' : 'no caption found'}  <-- NOT READ`)
      continue
    }
    // The strict reading must not be missing a mention the looser one saw, and must not exceed the "@" in the text.
    const missed = reading.looseMentions.filter((h) => h !== reading.owner && !reading.mentions.includes(h))
    const tooMany = reading.mentions.length > reading.atSigns
    // Either of these means production would never count the read as whole, and would ask about the post again.
    const unlinked = reading.unlinkedAt.filter((h) => h !== reading.owner)
    if (missed.length > 0 || tooMany || unlinked.length > 0 || !reading.closed) postProblems++
    postLines.push(
      `p/${r.shortcode} via ${r.transport}: ${reading.mentions.length} mention(s) of ${reading.atSigns} "@"` +
        (missed.length > 0 ? `  <-- the looser count also had ${missed.map((h) => `@${h}`).join(' ')}` : '') +
        (tooMany ? '  <-- more mentions than "@" signs' : '') +
        (unlinked.length > 0 ? `  <-- "@" words no link goes to: ${unlinked.map((h) => `@${h}`).join(' ')}` : '') +
        (!reading.closed ? '  <-- the page stopped before the caption ended' : ''),
    )
  }
  // A post asked for and never read (its client was refused, or none was answered) is a problem too: a check that
  // read no post cannot say the post reader works (review, 26 Nov 2026).
  for (const shortcode of args.posts) {
    if (postResults.some((r) => r.shortcode === shortcode)) continue
    postProblems++
    postLines.push(`p/${shortcode}: not asked  <-- NOT READ`)
  }
  if (args.posts.length > 0) {
    out(`   THE MENTION READER: ${postProblems === 0 ? 'every post read, and the two counts agree' : `${postProblems} post reading(s) to look at`}`)
    for (const l of postLines) out(`      ${l}`)
  }
  out(`-- ${requests} request(s) made. Pages kept in ${keepDir} (public pages only; delete it when done). Nothing was changed anywhere.`)
  process.exit(problems + postProblems === 0 && profileResults.length > 0 ? 0 : 1)
}

main().catch((err: unknown) => {
  out(`-- STOPPED: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(2)
})
