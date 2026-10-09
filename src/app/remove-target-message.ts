/**
 * REMOVING A TARGET: what happens to it, and the sentences that say so — PURE, so the card
 * and the server action ask ONE rule and both directions can be tested.
 *
 * ── REMOVE ON A WATCHED CHANNEL DELETED ITS CORPUS (2026-10-09) ───────────
 *
 * `removeTarget` decided delete-or-retire on DELIVERED messages alone, and a watched page is
 * never messaged — so Remove on @viralbhayani ran `targetAccount.delete`, and
 * `DetectedCampaign.target` is ON DELETE CASCADE. Every stored post went with it: its human
 * label, the text read off its footage, and the claim every OTHER recipient's message made on
 * one of those posts (`OutreachAttempt.campaign` is SET NULL). Instagram's feed only reaches
 * back 48 posts, so none of it could ever be fetched again. And the row itself is a safety
 * input: `excludedHandles()` reads every WATCH row, so a deleted competitor stopped being one,
 * and discovery was free to mint it as a PROSPECT with live routes.
 *
 * The card said the same wrong thing from its own copy of the wrong rule: *"has never been
 * messaged, so it will be deleted outright"*, on every watched page, whatever it held.
 *
 * ── THE RULE ──────────────────────────────────────────────────────────────
 *
 *   a WATCH row with no stored posts and no attempts → deleted. Undoing a wrong add (the
 *     @afaqs case) loses nothing, and the server checks that inside the delete statement
 *   any other WATCH row → retired: no longer read, posts kept, still on the competitor list
 *   a PROSPECT, or any role this does not recognise → ALWAYS retired, never deleted. A
 *     deleted prospect is not a stopped one: the badge door, official discovery and an
 *     import all mint a handle that has no row, with live routes and none of its history.
 *     `optedOut` on a row that stays is the only durable "never message".
 *
 * Strict equality on purpose: NaN, undefined or a negative count all read as "something is
 * there", which is the direction that keeps data.
 */
export type RemovalVerdict = 'delete' | 'retire'

export function removalVerdict(f: { role: string; campaigns: number; attempts: number }): RemovalVerdict {
  return f.role === 'WATCH' && f.campaigns === 0 && f.attempts === 0 ? 'delete' : 'retire'
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/**
 * WHAT A RETIRED WATCH PAGE'S POSTS STILL DO, said rather than implied.
 *
 * Retiring stops the READING. The posts already stored still count, until they age out of the
 * window: a paid post naming a company still funds a message to it, and discovery still reads
 * them for companies to add. Whether a removed page's posts should stop counting is Tabish's
 * call, not a side effect of this fix — so until he makes it, the screen says what is true.
 */
const STILL_COUNTS =
  'Posts already found from it still count toward who we message until they age out, and nothing new is read.'

/** The confirmation on a channel card, before anything is written. */
export function removeTargetConfirm(c: {
  handle: string
  postsLogged: number
  attemptsLogged: number
  removal: RemovalVerdict
}): { text: string; button: string } {
  if (c.removal === 'delete') {
    return {
      text: `Nothing has been stored from @${c.handle} yet — no posts, no messages — so it will be deleted outright.`,
      button: 'Yes, delete',
    }
  }
  const kept =
    c.postsLogged > 0
      ? `Its ${plural(c.postsLogged, 'stored post')} — with any labels and the text read off their footage — ` +
        `${c.postsLogged === 1 ? 'is' : 'are'} kept, because Instagram's feed only reaches back 48 posts and ` +
        `${c.postsLogged === 1 ? 'it' : 'they'} could never be fetched again.`
      : `Messages were once recorded to it, so it is retired rather than deleted and that record is kept.`
  return {
    text:
      `Stop reading @${c.handle} and take it off the list. ${kept} ${STILL_COUNTS} ` +
      `@${c.handle} stays on the list of pages we never message. To pause reading but keep it listed, ` +
      `use "stop reading their posts" on its row instead. Add it again to read it again.`,
    button: 'Yes, stop reading',
  }
}

/** The sentence the server returns — authoritative over the card's, which was written earlier. */
export function removeTargetResult(r: {
  handle: string
  outcome: 'deleted' | 'watch-retired' | 'retired'
  posts: number
  attempts: number
  delivered: number
}): string {
  switch (r.outcome) {
    case 'deleted':
      return `Stopped watching @${r.handle} and removed it — nothing had been stored from it.`
    case 'watch-retired':
      return (
        `Stopped reading @${r.handle} and took it off the list. ` +
        (r.posts > 0
          ? `Its ${plural(r.posts, 'stored post')} ${r.posts === 1 ? 'is' : 'are'} kept. ${STILL_COUNTS} `
          : `Messages were once recorded under it, so it is retired rather than deleted and that record is kept. `) +
        `It is still never messaged. Add it again to read it again.`
      )
    case 'retired':
      return (
        `Retired @${r.handle}: it will never be messaged.` +
        (r.attempts > 0
          ? ` Its ${plural(r.attempts, 'recorded message')} (${r.delivered} delivered) ` +
            `${r.attempts === 1 ? 'is' : 'are'} kept, so nobody there is written to twice.`
          : '') +
        ` To message it again, \`pnpm ig:unretire-target @${r.handle}\` re-reads its badge first.`
      )
  }
}
