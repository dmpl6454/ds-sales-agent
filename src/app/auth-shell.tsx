import { AuthForm } from './auth-form'

/**
 * THE FRONT DOOR. Two columns: what this is on the left, the form on the right.
 *
 * The left half exists because of what the right half unlocks. This dashboard has a Send
 * button that DMs real companies from revenue-generating accounts, so someone arriving at
 * this URL — from a bookmark, a shared link, a browser's history — should be able to tell
 * within one line whether they are in the right place. A bare centred form on a dark page
 * says nothing about what it guards.
 *
 * It stays deliberately plain in the parts that matter: a login page that looks clever is
 * a login page people hesitate to type a password into. No illustration, no gradient, no
 * marketing. One claim, a fact underneath it, and the form.
 */
export function AuthShell({ mode, next }: { mode: 'sign-in' | 'sign-up'; next?: string }) {
  const isSignUp = mode === 'sign-up'

  return (
    <div className="auth">
      <aside className="auth-aside">
        <p className="eyebrow">Instagram Outreach</p>
        <p className="auth-claim">A standing watch on two publisher channels.</p>
        {/*
          What it actually does, in one sentence, with no promise attached. "Sends
          partnership pitches" would overstate it — nothing sends unless someone has signed
          an account in by hand and turned the one switch on.
        */}
        <p className="page-sub" style={{ maxWidth: '46ch' }}>
          It watches for paid posts, writes a pitch for each one, and sends them under rules that
          cannot be crossed from this screen.
        </p>
      </aside>

      <main className="auth-main">
        <div className="auth-form-wrap">
          <AuthForm mode={mode} next={next} />
          {/*
            SIGNUP IS INVITE-ONLY AND AN UNSET CODE MEANS CLOSED, never "no gate". Said
            here rather than only in an error message, because a person who has not been
            given a code should learn that from the page instead of from a refusal after
            typing a password.
          */}
          {isSignUp ? (
            <p className="blurb" style={{ textAlign: 'center' }}>
              Accounts are invite-only, and a new one can only look — sending needs an operator to
              approve it.
            </p>
          ) : null}
        </div>
      </main>
    </div>
  )
}
