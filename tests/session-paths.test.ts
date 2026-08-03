import { describe, expect, it } from 'vitest'
import { classifyUrl, looksLikeEnforcement } from '@/outreach/browser/session'

describe('classifyUrl', () => {
  it('treats a challenge as enforcement', () => {
    expect(classifyUrl('https://www.instagram.com/challenge/?next=/')).toBe('checkpoint')
  })

  it('treats a suspension as enforcement', () => {
    expect(classifyUrl('https://www.instagram.com/accounts/suspended/')).toBe('checkpoint')
  })

  it('treats a disabled account as enforcement', () => {
    expect(classifyUrl('https://www.instagram.com/accounts/disabled/')).toBe('checkpoint')
  })

  /**
   * The point of this file.
   *
   * A 2FA prompt is routine on accounts that have 2FA enabled — it means an existing
   * session is being re-verified, not that Instagram has acted. Marking the account
   * CHALLENGED halts every pair using it and by design nothing retries, so a routine
   * re-prompt took a revenue account offline until someone noticed. Exactly the mistake
   * already fixed for /accounts/login: "an operator who sees CHALLENGED three times for
   * something that just needed a fresh login learns to dismiss it, and then dismisses
   * the one that matters."
   */
  it('treats a 2FA prompt as needing a code, NOT as enforcement', () => {
    expect(classifyUrl('https://www.instagram.com/accounts/login/two_factor?next=/')).toBe('needs-2fa')
  })

  it('treats a login form as needing a login, not enforcement', () => {
    expect(classifyUrl('https://www.instagram.com/accounts/login/')).toBe('needs-login')
  })

  it('treats an ordinary page as fine', () => {
    expect(classifyUrl('https://www.instagram.com/bollywoodsocietyy/')).toBe('ok')
  })

  it('treats the feed as fine', () => {
    expect(classifyUrl('https://www.instagram.com/')).toBe('ok')
  })

  /** IG's 2FA URL lives under /accounts/login/, so the order of the checks matters. */
  it('classifies 2FA ahead of the login form when the URL contains both', () => {
    expect(classifyUrl('https://www.instagram.com/accounts/login/two_factor')).toBe('needs-2fa')
  })
})

describe('looksLikeEnforcement', () => {
  it('recognises Action Blocked', () => {
    expect(looksLikeEnforcement('Action Blocked  We restrict certain activity to protect our community')).toBe(true)
  })

  it('recognises a temporary block', () => {
    expect(looksLikeEnforcement('Your account has been temporarily blocked')).toBe(true)
  })

  it('recognises a try-again-later throttle', () => {
    expect(looksLikeEnforcement('Please wait a few minutes before you try again.')).toBe(true)
  })

  it('recognises a failed message send', () => {
    expect(looksLikeEnforcement('Message could not be sent. Tap to retry.')).toBe(true)
  })

  it('is case- and whitespace-insensitive', () => {
    expect(looksLikeEnforcement('  action   BLOCKED  ')).toBe(true)
  })

  /**
   * The direction that matters most. A false positive halts a healthy revenue account,
   * so ordinary conversation and our own pitch copy must not trip this.
   */
  it('does NOT fire on an ordinary conversation', () => {
    expect(looksLikeEnforcement('Bollywood Chronicle  Active now  Hi, thanks for reaching out  Message')).toBe(false)
  })

  it('does NOT fire on a normal pitch body', () => {
    const body =
      'We generate over 30 crore views a day — I would love 20 minutes to walk you through a plan. Looking forward to connecting.'
    expect(looksLikeEnforcement(body)).toBe(false)
  })

  it('does NOT fire on an empty page', () => {
    expect(looksLikeEnforcement('')).toBe(false)
  })
})
