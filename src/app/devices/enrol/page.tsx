import { redirect } from 'next/navigation'
import { currentUser } from '@/lib/session'
import { findByUserCode, enrolmentExpired, keyBlob, keyFingerprint, pairedKeyLines } from '@/lib/deviceEnrol'
import { getSettings } from '@/lib/settings'
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
  const sp = await searchParams
  const code = (sp.code ?? '').trim().toUpperCase()

  /**
   * ── SIGNING IN MUST NOT LOSE THE CODE (2026-09-04) ────────────────────────
   *
   * This used to be a bare `redirect('/sign-in')`, and the code went with it. That is the
   * common path rather than an edge case: the installer opens this URL in the operator's
   * browser, and a NEW operator — the whole reason the DMG exists — is by definition not
   * signed in yet. They signed in, landed on `/`, and the Mac waiting to be approved was
   * reachable from nowhere, because nothing else has ever listed a pending pairing.
   *
   * MEASURED after a second operator installed the agent: 0 devices paired, 0 rows pending
   * (they expire after fifteen minutes), and no trace on any screen.
   *
   * `?next=` is carried, and the sign-in page already honours it through `safe-next.ts`,
   * which refuses an off-site target.
   */
  const user = await currentUser()
  if (!user) {
    redirect(code ? `/sign-in?next=${encodeURIComponent(`/devices/enrol?code=${code}`)}` : '/sign-in')
  }
  const e = code ? await findByUserCode(code) : null

  let body
  if (!code || !e) {
    body = (
      <p>
        No Mac is waiting under that code. Requests expire after 15 minutes — run the installer on the
        Mac again and approve promptly.
      </p>
    )
  } else if (e.withdrawnAt) {
    body = (
      <p>
        This request was withdrawn rather than approved: another Mac on this dashboard already uses the name{' '}
        <strong>{e.deviceName}</strong>. The Mac that asked is told why the next time it checks.
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
    const alreadyPaired = pairedKeyLines().some((l) => l.blob === keyBlob(e.publicKey))
    const activeDevice = alreadyPaired && e.requestedName ? (await getSettings()).activeDevice : null
    body = (
      <>
        <p>
          A Mac called <strong>{e.deviceName}</strong> asked to join{' '}
          {minutesAgo === 0 ? 'just now' : `${minutesAgo} min ago`}. Approving gives it the shared database
          through a tunnel that can do nothing else — no shell, no files, one port — and it can be removed from
          the Senders page at any time.
        </p>
        {/*
          WHICH KIND OF APPROVAL THIS IS (2026-10-09). A key already in authorized_keys is a Mac
          re-running its installer; it keeps its paired name. Said here because approving re-sends
          the connection details to whoever holds that key — and `start` cannot prove it is them.
        */}
        {alreadyPaired && (
          <p>
            This key is already paired as <strong>{e.deviceName}</strong> — approving re-sends it the connection
            details. Approve only if you just re-ran the installer on {e.deviceName}.
            {e.requestedName && e.requestedName !== e.deviceName && (
              <>
                {' '}It asked to be called {e.requestedName} and keeps the name {e.deviceName}
                {activeDevice === e.requestedName
                  ? `; ${e.requestedName} is the selected sending Mac, so choose ${e.deviceName} on Senders → Sending Mac after approving, or nothing sends.`
                  : '.'}
              </>
            )}
          </p>
        )}
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
