import { describe, expect, it } from 'vitest'
import { interpretDecision } from '@/detection/decideBrand'
import {
  guardDecisionSubject,
  handleClaimsBusiness,
  reasonAboutDifferentAccount,
  reasonSubject,
  subjectTraceableToHandle,
} from '@/detection/reasonSubject'

/**
 * THE SUBSTITUTED-SUBJECT GUARD, driven from the REAL verdicts that found the defect.
 *
 * The table below is the actual output of `pnpm ig:brands --stuck --run` on 2026-08-11 —
 * 23 decided verdicts, of which 21 are excellent and two answered about a different
 * account entirely. It is here verbatim rather than paraphrased because the whole
 * difficulty of this guard is that the two bad rows are structurally almost identical to
 * two GOOD ones (`iamzahero → Sonakshi Sinha`, `nowitsabhi → Abhishek Banerjee` are the
 * real people behind pseudonymous handles, which is exactly what a `person` verdict should
 * say). A guard tuned on the two failures alone rejects those too and is useless.
 *
 * So the assertion is over all 23 at once: 21 must survive, 2 must be caught. A change
 * that catches a third row fails this file, which is the point — the cost of a false
 * rejection is a real prospect quietly discarded.
 */

interface RealVerdict {
  handle: string
  kind: 'company' | 'person'
  reason: string
  /** True for the two rows where the model answered about a different account. */
  substituted?: true
}

const REAL_VERDICTS: RealVerdict[] = [
  { handle: 'adidas', kind: 'company', reason: 'Adidas is a well-known multinational corporation and sports brand.' },
  {
    handle: 'adidasindia',
    kind: 'company',
    reason: 'Adidas India is the official corporate account of a major consumer brand.',
  },
  {
    handle: 'fastrackworld',
    kind: 'company',
    reason: 'Fastrack is a well-known Indian watch and accessories brand, a consumer company.',
  },
  {
    handle: 'kfcindia',
    kind: 'company',
    reason: 'KFC India is the official corporate account of the KFC fast-food chain in India, a consumer brand',
  },
  {
    handle: 'kfcindia_official',
    kind: 'company',
    reason: 'KFC India is the official corporate account of the KFC fast-food chain in India, a consumer brand',
  },
  {
    handle: 'netflix_in',
    kind: 'company',
    reason:
      'Netflix India is the corporate account of the streaming service Netflix in India, a company that buys advertising.',
  },
  { handle: 'nutella', kind: 'company', reason: 'Nutella is a well-known consumer food brand owned by Ferrero.' },
  {
    handle: 'rungtasteel',
    kind: 'company',
    reason: 'The display name and verified professional account indicate a steel company, not a person.',
  },
  {
    handle: 'theleela',
    kind: 'company',
    reason: 'The Leela is a well-known Indian luxury hotel chain, a corporate entity.',
  },
  {
    handle: 'tseries.official',
    kind: 'company',
    reason: 'T-Series is a major Indian music and film production company.',
  },
  {
    handle: 'uspoloassnindia',
    kind: 'company',
    reason: 'U.S. Polo Assn. India is the official brand account of a clothing retailer, clearly a company.',
  },
  {
    handle: 'adityathackeray',
    kind: 'person',
    reason: 'Aditya Thackeray is a well-known Indian politician, not a company.',
  },
  {
    handle: 'ananyabirla',
    kind: 'person',
    reason: 'Ananya Birla is a well-known Indian singer and entrepreneur, not a company buying ad placements',
  },
  {
    handle: 'crocs',
    kind: 'person',
    reason: 'instylemagazine is a publisher/media page, not a buyer of placements.',
    substituted: true,
  },
  {
    handle: 'farhadsamji',
    kind: 'person',
    reason: 'Farhad Samji is a well-known Indian film director, screenwriter, and actor, not a company.',
  },
  // CORRECT: the real person behind a pseudonymous handle. Must NOT be rejected.
  { handle: 'iamzahero', kind: 'person', reason: 'Sonakshi Sinha is a well-known Indian actress, not a company.' },
  { handle: 'janhvikapoor', kind: 'person', reason: 'Janhvi Kapoor is a well-known Indian actress, not a company.' },
  {
    handle: 'jas_manchester',
    kind: 'person',
    reason: "The name and handle suggest an individual, and 'professional account' alone does not indicate a",
  },
  // CORRECT: likewise. Structurally identical to the titaneyeplus mistake.
  { handle: 'nowitsabhi', kind: 'person', reason: 'Abhishek Banerjee is a well-known Indian actor, not a company.' },
  {
    handle: 'realvickyjain',
    kind: 'person',
    reason: "The handle and display name suggest an individual, and 'professional account' alone does not in",
  },
  {
    handle: 'remodsouza',
    kind: 'person',
    reason: "The display name is a personal name and the handle appears to be an individual's account, despi",
  },
  {
    handle: 'tigerjackoeshroff',
    kind: 'person',
    reason: 'The display name is a personal name and the profile is not verified, indicating an individual a',
  },
  {
    handle: 'titaneyeplus',
    kind: 'person',
    reason: 'Vikas Khanna is a famous Indian chef and author, not a company.',
    substituted: true,
  },
]

describe('reasonAboutDifferentAccount, against all 23 real verdicts', () => {
  it('the whole table: 21 survive, 2 are caught, and nothing else moves', () => {
    const caught = REAL_VERDICTS.filter(
      (v) => reasonAboutDifferentAccount({ handle: v.handle, kind: v.kind, reason: v.reason }) !== null,
    ).map((v) => v.handle)

    // Named explicitly rather than counted, so a swap of one for another cannot pass.
    expect(caught).toEqual(['crocs', 'titaneyeplus'])
    expect(REAL_VERDICTS).toHaveLength(23)
  })

  // Row by row, so a failure names the handle that regressed rather than a count.
  for (const v of REAL_VERDICTS) {
    it(`@${v.handle} is ${v.substituted ? 'CAUGHT' : 'accepted'}`, () => {
      const problem = reasonAboutDifferentAccount({ handle: v.handle, kind: v.kind, reason: v.reason })
      if (v.substituted) expect(problem).not.toBeNull()
      else expect(problem).toBeNull()
    })
  }

  it('names the intruding subject, so the confabulation is readable in a log', () => {
    expect(
      reasonAboutDifferentAccount({
        handle: 'crocs',
        kind: 'person',
        reason: 'instylemagazine is a publisher/media page, not a buyer of placements.',
      }),
    ).toContain('instylemagazine')
    expect(
      reasonAboutDifferentAccount({
        handle: 'titaneyeplus',
        kind: 'person',
        reason: 'Vikas Khanna is a famous Indian chef and author, not a company.',
      }),
    ).toContain('Vikas Khanna')
  })
})

/**
 * THE DISCRIMINATOR ITSELF, stated as tests because it is a judgement call and the next
 * person will want to know which cases were considered rather than inferring it from a
 * regex. The pair that matters is `titaneyeplus`/`iamzahero`: same shape of reason,
 * opposite correct answers, separated only by whether the HANDLE claims to be a business.
 */
describe('the discriminator', () => {
  it('an @mention that is not this handle is always a substitution', () => {
    expect(
      reasonAboutDifferentAccount({ handle: 'crocs', kind: 'company', reason: '@instylemagazine is a media page.' }),
    ).toContain('@instylemagazine')
  })

  it('an @mention OF this handle is fine', () => {
    expect(
      reasonAboutDifferentAccount({ handle: 'adidas', kind: 'company', reason: '@adidas is a sportswear company.' }),
    ).toBeNull()
  })

  it('a personal name is allowed for a person verdict about a pseudonymous handle', () => {
    expect(
      reasonAboutDifferentAccount({
        handle: 'iamzahero',
        kind: 'person',
        reason: 'Sonakshi Sinha is a well-known Indian actress, not a company.',
      }),
    ).toBeNull()
  })

  it('...and REFUSED for the same shape of reason about a business-shaped handle', () => {
    expect(
      reasonAboutDifferentAccount({
        handle: 'titaneyeplus',
        kind: 'person',
        reason: 'Vikas Khanna is a famous Indian chef and author, not a company.',
      }),
    ).not.toBeNull()
  })

  it('a person NAME is not an excuse when the verdict is company', () => {
    // "Vikas Khanna is a company" about a brand handle is incoherent either way; the
    // exception is scoped to `person` deliberately.
    expect(
      reasonAboutDifferentAccount({ handle: 'somebrand', kind: 'company', reason: 'Vikas Khanna is a chef.' }),
    ).not.toBeNull()
  })

  it('descriptive reasons assert no subject and are always allowed', () => {
    for (const reason of [
      'The display name is a personal name and the handle appears to be an individual.',
      'The handle and display name suggest an individual.',
      'No category is available and the account is not marked as a business.',
      'Nothing in the facts settles whether this is a business.',
    ]) {
      expect(reasonAboutDifferentAccount({ handle: 'whoever', kind: 'person', reason })).toBeNull()
    }
  })

  it('an empty reason asserts nothing — the floor and the prompt still apply', () => {
    expect(reasonAboutDifferentAccount({ handle: 'x', kind: 'company', reason: '   ' })).toBeNull()
  })

  it('subject traceability is loose in the safe direction', () => {
    expect(subjectTraceableToHandle('Adidas India', 'adidasindia')).toBe(true)
    expect(subjectTraceableToHandle('KFC India', 'kfcindia_official')).toBe(true)
    expect(subjectTraceableToHandle('Fastrack', 'fastrackworld')).toBe(true)
    expect(subjectTraceableToHandle('T-Series', 'tseries.official')).toBe(true)
    expect(subjectTraceableToHandle('Netflix India', 'netflix_in')).toBe(true)
    expect(subjectTraceableToHandle('Vikas Khanna', 'titaneyeplus')).toBe(false)
    expect(subjectTraceableToHandle('instylemagazine', 'crocs')).toBe(false)
  })

  it('reasonSubject strips a leading article but keeps the name', () => {
    expect(reasonSubject('The Leela is a luxury hotel chain.')?.text).toBe('Leela')
    expect(reasonSubject('The display name is a personal name.')).toBeNull()
    expect(reasonSubject('instylemagazine is a publisher.')).toMatchObject({ text: 'instylemagazine', bare: true })
  })

  it('handleClaimsBusiness separates the measured pair', () => {
    expect(handleClaimsBusiness('titaneyeplus')).toBe(true)
    expect(handleClaimsBusiness('iamzahero')).toBe(false)
    expect(handleClaimsBusiness('nowitsabhi')).toBe(false)
  })
})

/**
 * THE SAFETY PROPERTY, end to end: a rejected decision must reach UNRESOLVED and can never
 * become BRAND or PERSON. This is the assertion that actually protects the prospect —
 * everything above is about WHEN the guard fires, and this is about what firing means.
 */
describe('a guarded decision can never be filed as an answer', () => {
  it('a substituted PERSON verdict yields UNRESOLVED, not PERSON', () => {
    const guarded = guardDecisionSubject('titaneyeplus', {
      kind: 'person' as const,
      confidence: 95,
      reason: 'Vikas Khanna is a famous Indian chef and author, not a company.',
    })
    expect(guarded.kind).toBe('unsure')

    const verdict = interpretDecision({ handle: 'titaneyeplus', decision: guarded })
    expect(verdict).toMatchObject({ kind: 'UNRESOLVED' })
    expect(verdict?.kind).not.toBe('PERSON')
    expect(verdict?.kind).not.toBe('BRAND')
  })

  it('the crocs case likewise — a real brand is never filed PERSON on a confabulation', () => {
    const guarded = guardDecisionSubject('crocs', {
      kind: 'person' as const,
      confidence: 95,
      reason: 'instylemagazine is a publisher/media page, not a buyer of placements.',
    })
    expect(interpretDecision({ handle: 'crocs', decision: guarded })).toMatchObject({ kind: 'UNRESOLVED' })
  })

  it('a substituted COMPANY verdict is degraded too — the guard is not person-only', () => {
    const guarded = guardDecisionSubject('somelocalshop', {
      kind: 'company' as const,
      confidence: 99,
      reason: 'Reliance Industries is a large Indian conglomerate.',
    })
    expect(guarded.kind).toBe('unsure')
    expect(interpretDecision({ handle: 'somelocalshop', decision: guarded })).toMatchObject({ kind: 'UNRESOLVED' })
  })

  it('a good decision passes through BYTE-IDENTICAL — the guard must not rewrite good answers', () => {
    const decision = {
      kind: 'company' as const,
      confidence: 98,
      reason: 'Adidas is a well-known multinational corporation and sports brand.',
    }
    expect(guardDecisionSubject('adidas', decision)).toEqual(decision)
    expect(interpretDecision({ handle: 'adidas', decision: guardDecisionSubject('adidas', decision) })).toMatchObject({
      kind: 'BRAND',
    })
  })

  it('the original wording survives a rejection, so it stays auditable', () => {
    const guarded = guardDecisionSubject('crocs', {
      kind: 'person' as const,
      confidence: 95,
      reason: 'instylemagazine is a publisher/media page, not a buyer of placements.',
    })
    expect(guarded.reason).toContain('instylemagazine')
    expect(guarded.reason).toContain('different account')
    expect(guarded.reason.length).toBeLessThanOrEqual(200)
  })

  it('every one of the 21 good verdicts still reaches a real answer, not UNRESOLVED', () => {
    // The failure mode a too-aggressive guard produces: everything degrades to unsure and
    // brand discovery silently stops. Asserted rather than assumed.
    const good = REAL_VERDICTS.filter((v) => !v.substituted)
    for (const v of good) {
      const guarded = guardDecisionSubject(v.handle, { kind: v.kind, confidence: 96, reason: v.reason })
      const verdict = interpretDecision({ handle: v.handle, decision: guarded })
      expect(verdict?.kind, `@${v.handle} should not have been degraded`).toBe(v.kind === 'company' ? 'BRAND' : 'PERSON')
    }
  })
})
