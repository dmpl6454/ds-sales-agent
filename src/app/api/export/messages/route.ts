import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireUser } from '@/lib/session'
import { DELIVERED_STATUSES } from '@/lib/constants'

export const dynamic = 'force-dynamic'

/**
 * CSV EXPORT OF SENT MESSAGES (2026-08-18, Tabish's instruction: "after messages are sent
 * and their time sender and account sent from recorded, make sure there is an export button
 * to export that data into csv file and we can also select the data via filters").
 *
 * GET /api/export/messages?from=YYYY-MM-DD&to=YYYY-MM-DD&sender=<handle>&status=<sent|replied|all>
 *
 * - Dates are IST calendar days, inclusive, matching every other day boundary here.
 * - Defaults to DELIVERED messages (SENT + REPLIED — a reply must never make a delivery
 *   vanish from an export, the `ig:audit` lesson).
 * - Auth: middleware already protects this path (deny-by-default), and `requireUser()` is
 *   still called first — a route handler is an endpoint, exactly like a server action.
 * - Times are exported twice: ISO UTC (unambiguous, sortable) and IST (what a person
 *   reading it expects).
 */

/** RFC-4180 quoting: doubled quotes, wrap when the field carries a comma/quote/newline. */
function csvField(v: string | null | undefined): string {
  const s = v ?? ''
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

function istLabel(d: Date | null): string {
  if (!d) return ''
  return d.toLocaleString('en-GB', { timeZone: 'Asia/Kolkata', hour12: false })
}

/** An IST calendar date, as the UTC instant it begins/ends. */
function istBoundary(day: string, endOfDay: boolean): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null
  return new Date(`${day}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}+05:30`)
}

export async function GET(req: NextRequest) {
  try {
    await requireUser()
  } catch {
    return new NextResponse('sign in first', { status: 401 })
  }

  const q = req.nextUrl.searchParams
  const from = q.get('from') ? istBoundary(q.get('from')!, false) : null
  const to = q.get('to') ? istBoundary(q.get('to')!, true) : null
  const sender = q.get('sender')?.trim().replace(/^@/, '') || null
  const status = q.get('status') ?? 'delivered'

  const statuses =
    status === 'all'
      ? ['SENT', 'REPLIED', 'READY', 'QUEUED', 'SENDING', 'FAILED', 'SKIPPED']
      : status === 'replied'
        ? ['REPLIED']
        : [...DELIVERED_STATUSES]

  const rows = await prisma.outreachAttempt.findMany({
    where: {
      status: { in: statuses },
      ...(from || to ? { sentAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}),
      ...(sender ? { sender: { handle: sender } } : {}),
    },
    include: {
      sender: { select: { handle: true } },
      target: { select: { handle: true, displayName: true } },
    },
    orderBy: { sentAt: 'desc' },
    // A bound so a stray click cannot stream the whole table forever; the UI says so.
    take: 10_000,
  })

  const header = [
    'sent_at_ist',
    'sent_at_utc',
    'sender_account',
    'recipient',
    'recipient_name',
    'status',
    'sent_by',
    'message_number',
    'replied',
    'replied_at_ist',
    'thread_url',
  ].join(',')

  const lines = rows.map((r) =>
    [
      csvField(istLabel(r.sentAt)),
      csvField(r.sentAt?.toISOString() ?? ''),
      csvField(`@${r.sender.handle}`),
      csvField(`@${r.target.handle}`),
      csvField(r.target.displayName),
      csvField(r.status),
      csvField(r.sentBy),
      String(r.touchNumber),
      r.repliedAt ? 'yes' : 'no',
      csvField(istLabel(r.repliedAt)),
      csvField(r.threadUrl),
    ].join(','),
  )

  const today = new Date().toISOString().slice(0, 10)
  return new NextResponse([header, ...lines].join('\r\n') + '\r\n', {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="messages-${today}.csv"`,
      'Cache-Control': 'no-store',
    },
  })
}
