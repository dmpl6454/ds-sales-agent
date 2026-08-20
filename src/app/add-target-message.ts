import type { HandleCheck, HandleFacts } from '@/detection/exists'

/**
 * The sentence a person reads after adding a target — PURE, because it has to be tested in
 * every direction and a server action cannot be.
 *
 * Two rules, both learned the expensive way on 2026-08-20:
 *
 * 1. **The sentence must match the ROLE.** The old copy said "The fleet will write to them
 *    while Autopilot is on" for every add — flatly false for a WATCH page, whose whole
 *    definition is that it is never written to. A screen asserting a rule the enforcer does
 *    not hold is this repo's most-documented failure; this was the fifth of the family.
 *
 * 2. **The add must SAY WHO WAS ADDED, in Instagram's words.** "filmigyan" exists (a
 *    219-follower fan page); the page Tabish meant is @filmygyan, 31.6M, verified. A bare
 *    "Watching @filmigyan" reads as success for both, so the wrong one is only ever
 *    discovered weeks later in the corpus. The identity line makes the mistake visible at
 *    the moment it is made, to the person who just typed it — the isOfficialMatch
 *    philosophy applied to the manual door: facts on screen, a person decides.
 *
 * A null fact renders as "could not read who this is" — never silently omitted, because
 * absence-of-data reading as normality is the other documented trap.
 */
export function addTargetMessage(
  role: 'WATCH' | 'PROSPECT',
  handle: string,
  check: HandleCheck,
  facts: HandleFacts | null,
): string {
  const identity = facts
    ? `Instagram says this is ${facts.name ? `“${facts.name}”` : 'an account with no display name'}` +
      (facts.followers !== null ? `, ${facts.followers.toLocaleString('en-US')} followers` : '') +
      (facts.verified === true ? ', verified' : facts.verified === false ? ', NOT verified' : '') +
      ' — if that is not who you meant, remove it and check the handle.'
    : check === 'unknown'
      ? 'Instagram could not be reached to confirm who this is — check the spelling and what the card shows.'
      : 'Instagram could not say who this is (its profile data is unreadable) — check the card shows the posts you expect.'

  return role === 'WATCH'
    ? `Watching @${handle} for paid posts — read every few minutes, judged by the classifier, never messaged. ${identity}`
    : `Added @${handle} as a company to message. The fleet will write to them while Autopilot is on. ${identity}`
}
