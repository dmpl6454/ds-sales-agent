import { NextResponse } from 'next/server'
import { requireUser } from '@/lib/session'
import { queryCountingEnabled, takeQueryCount } from '@/lib/queryCount'

/**
 * How many database queries has this server issued since the last time anyone asked?
 *
 * Read by `pnpm ig:layout` to enforce a per-page query budget — the check that would have
 * caught `buildBrandsPanel`'s N+1 before it became a ten-second page. See
 * `src/lib/queryCount.ts` for the full reasoning.
 *
 * ── WHY AN ENDPOINT AND NOT SOMETHING CLEVERER ────────────────────────────────────────
 *
 * The count lives in the SERVER process; the checker drives a BROWSER. Nothing the page
 * renders can carry the number, because the queries that matter are the ones the server
 * ran to produce it. The alternative — have `ig:layout` spawn its own server and parse its
 * stdout — would make the check unable to run against a server that is already up, which is
 * the normal case and the one where a regression would actually be noticed.
 *
 * ── WHAT IT IS NOT ────────────────────────────────────────────────────────────────────
 *
 * Not a metrics API. It reads AND ZEROES, because the question is always "how many did that
 * page cost", never "how many since boot"; two readers would interfere and there is exactly
 * one. `middleware.ts` is deny-by-default so this sits behind the front door for free, and
 * `requireUser()` is asked here as well — middleware is a router filter and this is an
 * endpoint, the same reasoning that puts `requireUser()` at the top of every server action.
 *
 * When counting is OFF it says so rather than returning 0. A budget that silently passes
 * because nobody was counting is the reassuring falsehood this whole check exists to catch,
 * and `ig:layout` fails on `enabled: false` rather than reading the zero.
 */
export const dynamic = 'force-dynamic'

export async function GET() {
  await requireUser()
  if (!queryCountingEnabled()) {
    return NextResponse.json({
      enabled: false,
      reason: 'Query counting is off. Start the server with DS_QUERY_COUNT=1.',
    })
  }
  return NextResponse.json({ enabled: true, queries: takeQueryCount() })
}
