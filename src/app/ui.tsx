import { istStamp } from '@/lib/time'

/** Small presentational helpers shared across pages. Server components. */

export function Stat({ label, value, note }: { label: string; value: string | number; note?: string }) {
  return (
    <div className="card stat">
      <div className="k">{label}</div>
      <div className="v">{value}</div>
      {note ? <div className="n">{note}</div> : null}
    </div>
  )
}

const VERDICT_TONE: Record<string, string> = {
  CAMPAIGN: 'good',
  REVIEW: 'warn',
  ORGANIC: '',
  UNCLASSIFIED: 'info',
}

export function VerdictPill({ verdict }: { verdict: string }) {
  return <span className={`pill ${VERDICT_TONE[verdict] ?? ''}`}>{verdict}</span>
}

const STATUS_TONE: Record<string, string> = {
  SENT: 'good',
  READY: 'info',
  QUEUED: 'info',
  REPLIED: 'good',
  FAILED: 'bad',
  SKIPPED: '',
  ACTIVE: 'good',
  PAUSED: 'warn',
  CHALLENGED: 'bad',
  OK: 'good',
  PARTIAL: 'warn',
}

export function StatusPill({ status }: { status: string }) {
  return <span className={`pill ${STATUS_TONE[status] ?? ''}`}>{status}</span>
}

export function When({ at }: { at: Date | null | undefined }) {
  if (!at) return <span className="dim">—</span>
  return (
    <span className="nowrap mono" title={at.toISOString()}>
      {istStamp(at)}
    </span>
  )
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <div className="empty">{children}</div>
}

/** Relative age, IST-agnostic ("4h ago"). Used where exact stamps are noise. */
export function Ago({ at }: { at: Date | null | undefined }) {
  if (!at) return <span className="dim">—</span>
  const mins = Math.floor((Date.now() - at.getTime()) / 60_000)
  const text =
    mins < 1 ? 'just now' : mins < 60 ? `${mins}m ago` : mins < 1440 ? `${Math.floor(mins / 60)}h ago` : `${Math.floor(mins / 1440)}d ago`
  return (
    <span className="nowrap dim" title={istStamp(at)}>
      {text}
    </span>
  )
}
