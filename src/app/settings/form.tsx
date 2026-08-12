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
 * Each control carries WHAT IT COSTS to change it, not just a label.
 *
 * A number on a form with no consequence attached invites tuning toward throughput, and
 * that is the one direction this system must not drift. The text beside each field is
 * the argument for its current value, so raising it is a decision rather than a
 * keystroke.
 */
export function SettingsForm({ initial }: { initial: SettingsFormValues }) {
  const [v, setV] = useState(initial)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  const set = <K extends keyof SettingsFormValues>(k: K, value: SettingsFormValues[K]) =>
    setV((prev) => ({ ...prev, [k]: value }))

  return (
    <section className="group">
      <h2>Volume and spacing</h2>

      <div className="setting">
        <label htmlFor="maxPerTargetPerDay">Most messages one recipient may get in a day</label>
        <input
          id="maxPerTargetPerDay"
          value={v.maxPerTargetPerDay}
          onChange={(e) => set('maxPerTargetPerDay', e.target.value)}
        />
        <p className="setting-why">
          <strong>The one control that protects the inbox.</strong> Spacing is set per sender–recipient pair, so with
          many accounts rotating, a recipient can hear from a different page every day while no single pair breaks
          its own 7-day rule. This is the only rule that sees the total. Measured: @viralbhayani posts 11–14 paid
          posts a day, so an uncapped setting means all of that lands in one inbox. Type a whole number, or{' '}
          <code>unlimited</code>.
        </p>
      </div>

      <div className="setting">
        <label htmlFor="defaultCooldownDays">Days between messages to the same recipient from the same account</label>
        <input
          id="defaultCooldownDays"
          value={v.defaultCooldownDays}
          onChange={(e) => set('defaultCooldownDays', e.target.value)}
        />
        <p className="setting-why">
          Applies per sender–recipient pair. It does not and cannot limit what a recipient receives in total once
          several accounts are rotating — that is what the setting above is for.
        </p>
      </div>

      <div className="setting">
        <label htmlFor="hookMaxAgeHours">How recent a post must be to be worth writing about (hours)</label>
        <input
          id="hookMaxAgeHours"
          value={v.hookMaxAgeHours}
          onChange={(e) => set('hookMaxAgeHours', e.target.value)}
        />
        <p className="setting-why">
          A follow-up must reference something the recipient has not been written to about before — that is what makes
          it a new message rather than a repeat, which is the specific thing Instagram’s spam policy penalises. The 1
          August detection cutoff also applies, and whichever is more recent wins.
        </p>
      </div>

      <div className="setting">
        <label htmlFor="maxNewBrandTouchesPerDay">New companies contacted for the first time each day</label>
        <input
          id="maxNewBrandTouchesPerDay"
          value={v.maxNewBrandTouchesPerDay}
          onChange={(e) => set('maxNewBrandTouchesPerDay', e.target.value)}
        />
        <p className="setting-why">
          Protects the PATTERN rather than any one account. Ten first approaches in an afternoon and ten across ten
          days are the same volume and look nothing alike — the first is indistinguishable from a bought list being
          worked through. Follow-ups are not counted.
        </p>
      </div>

      <h2>Identity</h2>

      <div className="setting">
        <label className="setting-check">
          <input
            type="checkbox"
            checked={v.personaGateChannels}
            onChange={(e) => set('personaGateChannels', e.target.checked)}
          />
          Hold back messages from accounts that share a persona
        </label>
        <p className="setting-why">
          <strong>Currently the strongest brake in the system.</strong> Every message carries the sending account’s
          name, role, company, phone and email. If several of your pages carry the same block, a recipient who hears
          from two of them sees one identical signature — which tells them the pages are one operation. With this on,
          nothing sends from any account until each has its own identity. Turning it off releases messages from
          accounts that still share one.
        </p>
      </div>

      <div className="account-actions">
        <button
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
            setBusy(false)
          }}
        >
          {busy ? 'Saving…' : 'Save'}
        </button>
      </div>
      {message && <p className="account-message">{message}</p>}
    </section>
  )
}
