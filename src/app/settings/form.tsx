'use client'

import { useState } from 'react'
import { saveSettings } from './actions'

export interface SettingsFormValues {
  maxPerTargetPerDay: string
  defaultCooldownDays: string
  hookMaxAgeHours: string
  maxNewBrandTouchesPerDay: string
  personaGateChannels: boolean
  autopilotEnabled: boolean
}

/**
 * ── ONE LINE OF CONSEQUENCE, THE FULL ARGUMENT ONE CLICK AWAY ───────────────
 *
 * Every control here carries what it COSTS to change it. That is deliberate and it stays:
 * a number on a form with no consequence attached invites tuning toward throughput, and
 * that is the one direction this system must not drift.
 *
 * What changed is the shape, not the content. This page used to stack four four-line
 * essays, so the argument for the most important cap and the argument for the least
 * important one shouted at exactly the same volume — which is a wall, and a wall is read
 * by nobody. Now the CONSEQUENCE is always visible in one sentence and the full argument
 * sits behind a disclosure. Nothing was deleted; a reader who wants the reasoning still
 * gets every word of it, and a reader who does not can see all four caps at once.
 *
 * ── THE VALUES ARE NOT FREE TEXT ANY MORE ───────────────────────────────────
 *
 * They were `<input>` elements, so the only thing standing between a typo and the guard
 * was server-side clamping. Steppers make the reachable set the legal set. The exception
 * is `unlimited`, which is a REAL value for the per-recipient cap and is reached by
 * stepping past the top rather than by typing a word — a magic string a person has to
 * spell correctly is a worse interface than a step.
 */

type Flag = { text: string; tone: 'idle' | 'warn' } | null

interface NumericSetting {
  key: 'maxPerTargetPerDay' | 'defaultCooldownDays' | 'hookMaxAgeHours' | 'maxNewBrandTouchesPerDay'
  label: string
  unit: string
  min: number
  max: number
  /** Stepping above `max` yields "unlimited" rather than clamping. Only one cap allows it. */
  unlimited?: boolean
  /** Always visible. What happens if you change it. */
  consequence: string
  /** Behind the disclosure. Why the current value is what it is. */
  argument: React.ReactNode
  /** How to describe a value that is not the recommended one. */
  flag: (v: string) => Flag
}

const NUMERIC: NumericSetting[] = [
  {
    key: 'maxPerTargetPerDay',
    label: 'Most messages one recipient may get in a day',
    unit: 'a day',
    min: 1,
    max: 10,
    unlimited: true,
    consequence:
      'The only rule that sees a recipient’s total across every account. Raising it puts more in one inbox.',
    argument: (
      <>
        Spacing is set per sender–recipient pair, so with many accounts rotating, a recipient can hear
        from a different page every day while no single pair breaks its own 7-day rule. This is the only
        rule that sees the total. Measured: @viralbhayani posts 11–14 paid posts a day, so an uncapped
        setting means all of that can land in one inbox. Rotation solves <em>sender</em> risk and does
        nothing for <em>recipient</em> risk — and a recipient’s spam report is what gets accounts banned.
      </>
    ),
    flag: (v) => (v === 'unlimited' ? { text: 'no ceiling', tone: 'warn' } : null),
  },
  {
    key: 'defaultCooldownDays',
    label: 'Days between messages to the same recipient from the same account',
    unit: 'days',
    min: 1,
    max: 30,
    consequence: 'Applies per sender–recipient pair. It cannot limit what a recipient receives in total.',
    argument: (
      <>
        Per pair, which is exactly why it is not the control that protects an inbox: 63 accounts rotating
        through one recipient can write every single day while every individual pair sits comfortably
        inside its 7-day spacing. The cap above is what closes that.
      </>
    ),
    flag: (v) => (Number(v) < 7 ? { text: 'below the seeded 7', tone: 'warn' } : null),
  },
  {
    key: 'hookMaxAgeHours',
    label: 'How recent a post must be to be worth writing about',
    unit: 'hours',
    min: 6,
    max: 168,
    consequence: 'Older material stops counting as something new to say, so follow-ups stop being written.',
    argument: (
      <>
        A follow-up must reference something the recipient has not been written to about before — that is
        what makes it a new message rather than a repeat, which is the specific thing Instagram’s spam
        policy penalises. The 1 August detection cutoff also applies, and whichever is more recent wins.
      </>
    ),
    flag: () => null,
  },
  {
    key: 'maxNewBrandTouchesPerDay',
    label: 'New companies contacted for the first time each day',
    unit: 'a day',
    min: 1,
    max: 20,
    consequence: 'Protects the pattern rather than any one account. Follow-ups are not counted.',
    argument: (
      <>
        Ten first approaches in an afternoon and ten across ten days are the same volume and look nothing
        alike — the first is indistinguishable from a bought list being worked through. This guards the
        shape of the outreach; the per-account daily cap guards the account.
      </>
    ),
    flag: (v) => (Number(v) > 5 ? { text: 'well above the default 2', tone: 'warn' } : null),
  },
]

const STEPS: Record<string, number> = { hookMaxAgeHours: 6 }

export function SettingsForm({ initial }: { initial: SettingsFormValues }) {
  const [v, setV] = useState(initial)
  const [saved, setSaved] = useState(initial)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [open, setOpen] = useState<string | null>(null)

  const set = <K extends keyof SettingsFormValues>(k: K, value: SettingsFormValues[K]) => {
    setV((prev) => ({ ...prev, [k]: value }))
    setMessage(null)
  }

  /* Which keys differ from what is stored. Drives the save bar AND its sentence — a bar
     that says "unsaved changes" without saying how many is a nag, not information. */
  const changed = (Object.keys(v) as Array<keyof SettingsFormValues>).filter((k) => v[k] !== saved[k])

  const step = (s: NumericSetting, dir: 1 | -1) => {
    const by = STEPS[s.key] ?? 1
    const current = v[s.key]
    if (current === 'unlimited') {
      // Stepping DOWN from unlimited lands on the top of the numeric range, not on nothing.
      return set(s.key, dir === -1 ? String(s.max) : 'unlimited')
    }
    const next = Number(current) + by * dir
    if (s.unlimited && next > s.max) return set(s.key, 'unlimited')
    set(s.key, String(Math.min(s.max, Math.max(s.min, next))))
  }

  return (
    <>
      <section id="volume">
        <h2>Volume and spacing</h2>
        <p className="blurb">
          Each one is a safety control. The sentence beside it is what changes if you move it.
        </p>

        <div className="stack">
          {NUMERIC.map((s) => {
            const value = v[s.key]
            const flag = s.flag(value)
            const isOpen = open === s.key
            return (
              <div className="settingrow" key={s.key}>
                <div className="stack-sm">
                  <label htmlFor={s.key} className="settingrow-label">
                    {s.label}
                  </label>
                  <div className="stepper">
                    <button type="button" onClick={() => step(s, -1)} aria-label={`Decrease ${s.label}`}>
                      −
                    </button>
                    {/*
                      `<output>` rather than a disabled input: this is a computed value being
                      reported, not a field being typed into, and a disabled input announces
                      itself as unavailable when it is simply not the way you change this.
                    */}
                    <output id={s.key} className="stepper-value">
                      {value === 'unlimited' ? 'unlimited' : `${value} ${s.unit}`}
                    </output>
                    <button type="button" onClick={() => step(s, 1)} aria-label={`Increase ${s.label}`}>
                      +
                    </button>
                    {flag ? <span className={`pill pill-${flag.tone === 'warn' ? 'warn' : 'idle'}`}>{flag.text}</span> : null}
                  </div>
                </div>

                <div>
                  <p className="settingrow-consequence">{s.consequence}</p>
                  <button
                    type="button"
                    className="btn-quiet"
                    aria-expanded={isOpen}
                    onClick={() => setOpen(isOpen ? null : s.key)}
                  >
                    {isOpen ? 'Hide the reasoning' : 'Why this value'}
                  </button>
                  {isOpen ? <div className="settingrow-argument">{s.argument}</div> : null}
                </div>
              </div>
            )
          })}
        </div>
      </section>

      <section id="identity">
        <h2>Identity</h2>
        <div className="card settingrow">
          <div>
            <label className="setting-check">
              <input
                type="checkbox"
                checked={v.personaGateChannels}
                onChange={(e) => set('personaGateChannels', e.target.checked)}
              />
              <span>Hold back messages from accounts that share a signature</span>
            </label>
            <p className="settingrow-consequence" style={{ marginLeft: 25 }}>
              {v.personaGateChannels
                ? 'On. Nothing sends from an account whose signature matches another account’s.'
                : 'Off. Accounts that share a signature can send — a recipient hearing from two of them sees the same contact block twice.'}
            </p>
          </div>
          <div>
            <p className="settingrow-consequence">
              Every message ends with the page name, phone and email. If several pages carry the same
              block, a recipient who hears from two of them can see they are one operation — which is the
              specific thing this refuses. Turning it off releases those accounts.
            </p>
            <p className="blurb">
              <strong>Do not satisfy this by inventing a person.</strong> Who fronts each page is a
              business decision; a plausible invented name in a real DM is worse than a blocked send.
            </p>
          </div>
        </div>
      </section>

      {/*
        THE SAVE BAR IS STICKY AND ONLY EXISTS WHEN SOMETHING CHANGED.

        It also names WHAT changed rather than saying "unsaved changes", and it offers Undo
        beside Save. The old form had one button and a string that read "Saving…" — no dirty
        state, no way back, and no way to tell which of four numbers you had touched.
      */}
      {changed.length > 0 ? (
        <div className="savebar" role="status">
          <span className="savebar-text">
            {changed.length === 1 ? '1 change, not saved yet' : `${changed.length} changes, not saved yet`}
          </span>
          <button type="button" onClick={() => { setV(saved); setMessage(null) }} disabled={busy}>
            Undo
          </button>
          <button
            type="button"
            className="btn-primary"
            disabled={busy}
            onClick={async () => {
              setBusy(true)
              const r = await saveSettings({
                maxPerTargetPerDay: v.maxPerTargetPerDay,
                defaultCooldownDays: v.defaultCooldownDays,
                hookMaxAgeHours: v.hookMaxAgeHours,
                maxNewBrandTouchesPerDay: v.maxNewBrandTouchesPerDay,
                personaGateChannels: v.personaGateChannels,
              })
              setMessage(r.message)
              // Only treat it as saved if the server said so. Clearing the dirty state on a
              // failed write would hide the fact that the change never landed.
              if (r.ok) setSaved(v)
              setBusy(false)
            }}
          >
            {busy ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      ) : null}

      {message ? <p className="blurb">{message}</p> : null}
    </>
  )
}
