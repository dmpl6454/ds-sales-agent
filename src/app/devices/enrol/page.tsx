import { redirect } from 'next/navigation'
import { currentUser } from '@/lib/session'
import { findByUserCode, enrolmentExpired, keyFingerprint } from '@/lib/deviceEnrol'
import { approveDevice } from '../../actions'
import { Nav } from '../../nav'
import { PageHead } from '../../page-head'

export const dynamic = 'force-dynamic'

/**
 * "Approve this Mac." The installer on a new Mac opened this page; the person reading it is
 * signed in (middleware sent them through /sign-in if not) and sees the Mac's name and the key
 * fingerprint the installer is showing at the same moment. One button. Everything it grants
 * is the forward-only database tunnel — no shell, no files, one port.
 */
export default async function EnrolPage({
  searchParams,
}: {
  searchParams: Promise<{ code?: string; error?: string }>
}) {
  const user = await currentUser()
  if (!user) redirect('/sign-in')
  const sp = await searchParams
  const code = (sp.code ?? '').trim().toUpperCase()
  const e = code ? await findByUserCode(code) : null

  let body
  if (!code || !e) {
    body = (
      <p>
        No Mac is waiting under that code. Requests expire after 15 minutes — run the installer on the
        Mac again and approve promptly.
      </p>
    )
  } else if (enrolmentExpired(e.createdAt)) {
    body = <p>This request expired (15 minutes). Run the installer on the Mac again and approve promptly.</p>
  } else if (e.approvedAt) {
    body = (
      <p>
        <strong>{e.deviceName}</strong> was already approved. Its installer is finishing on its own; the Mac
        appears on the Senders page once its agent is running.
      </p>
    )
  } else {
    const minutesAgo = Math.max(0, Math.round((Date.now() - new Date(e.createdAt).getTime()) / 60000))
    body = (
      <>
        <p>
          A Mac called <strong>{e.deviceName}</strong> asked to join{' '}
          {minutesAgo === 0 ? 'just now' : `${minutesAgo} min ago`}. Approving gives it the shared database
          through a tunnel that can do nothing else — no shell, no files, one port — and it can be removed from
          the Senders page at any time.
        </p>
        <p className="muted">
          The installer on that Mac is showing this code: <code>{e.userCode}</code> and this key:{' '}
          <code>{keyFingerprint(e.publicKey)}</code>. If they do not match what you see on the Mac, do not
          approve.
        </p>
        <form action={approveDevice}>
          <input type="hidden" name="code" value={e.userCode} />
          <button className="btn" type="submit">
            Approve this Mac
          </button>
        </form>
      </>
    )
  }

  return (
    <>
      <Nav current="/devices/enrol" email={user.email} />
      <div className="page">
        <PageHead title="Pair a Mac" sub="A new sending Mac is asking to join" />
        <section className="group">
          {sp.error && <p className="warn">{sp.error}</p>}
          {body}
        </section>
      </div>
    </>
  )
}
