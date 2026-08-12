import { describe, expect, it } from 'vitest'
import {
  MIN_PASSWORD_LENGTH,
  emailProblem,
  hashPassword,
  normaliseEmail,
  passwordProblem,
  verifyPassword,
} from '@/lib/password'
import { hashToken, safeEqual } from '@/lib/session'

/**
 * Both directions for every guard, per the rule this codebase learned the hard way:
 * eight guards here were verified only where they pass. A password check that always
 * returns true passes any "correct password is accepted" test on its own.
 */

describe('hashPassword / verifyPassword', () => {
  it('accepts the correct password', async () => {
    const hash = await hashPassword('correct horse battery')
    expect(await verifyPassword('correct horse battery', hash)).toBe(true)
  })

  it('REJECTS a wrong password', async () => {
    const hash = await hashPassword('correct horse battery')
    expect(await verifyPassword('correct horse batteries', hash)).toBe(false)
    expect(await verifyPassword('', hash)).toBe(false)
    expect(await verifyPassword('CORRECT HORSE BATTERY', hash)).toBe(false)
  })

  it('never stores the password in the hash', async () => {
    const hash = await hashPassword('super-secret-value')
    expect(hash).not.toContain('super-secret-value')
  })

  it('salts, so the same password hashes differently every time', async () => {
    const a = await hashPassword('same-password-twice')
    const b = await hashPassword('same-password-twice')
    expect(a).not.toBe(b)
    // ...and both still verify. A salt that broke verification would be caught here.
    expect(await verifyPassword('same-password-twice', a)).toBe(true)
    expect(await verifyPassword('same-password-twice', b)).toBe(true)
  })

  it('records its own cost parameters, so raising them later cannot lock anyone out', async () => {
    const hash = await hashPassword('parameterised')
    const [algo, n, r, p] = hash.split('$')
    expect(algo).toBe('scrypt')
    expect(Number(n)).toBeGreaterThanOrEqual(65536)
    expect(Number(r)).toBeGreaterThanOrEqual(8)
    expect(Number(p)).toBeGreaterThanOrEqual(1)
  })

  it('treats a malformed stored hash as a wrong password, not an exception', async () => {
    for (const bad of [
      '',
      'not-a-hash',
      'scrypt$65536$8$1$onlyfiveparts',
      'bcrypt$65536$8$1$c2FsdA$aGFzaA',
      'scrypt$notanumber$8$1$c2FsdA$aGFzaA',
      'scrypt$65536$8$1$$aGFzaA',
      'scrypt$65536$8$1$c2FsdA$',
    ]) {
      expect(await verifyPassword('anything', bad)).toBe(false)
    }
  })

  it('refuses absurd cost parameters from a tampered row instead of exhausting memory', async () => {
    // N=2^30 would ask for gigabytes. A stored row must not be able to turn one
    // sign-in attempt into a denial of service.
    expect(await verifyPassword('x', 'scrypt$1073741824$8$1$c2FsdA$aGFzaA')).toBe(false)
    expect(await verifyPassword('x', 'scrypt$512$8$1$c2FsdA$aGFzaA')).toBe(false)
    expect(await verifyPassword('x', 'scrypt$65536$99$1$c2FsdA$aGFzaA')).toBe(false)
  })

  it('normalises unicode, so a password typed on a different keyboard still works', async () => {
    // "é" as one codepoint vs "e" + combining accent. Visually identical; different bytes.
    const composed = 'passwordé-long'
    const decomposed = 'passwordé-long'
    const hash = await hashPassword(composed)
    expect(await verifyPassword(decomposed, hash)).toBe(true)
  })
})

describe('passwordProblem', () => {
  it('rejects a short password', () => {
    expect(passwordProblem('short')).toContain(String(MIN_PASSWORD_LENGTH))
    expect(passwordProblem('a'.repeat(MIN_PASSWORD_LENGTH - 1))).not.toBeNull()
  })

  it('ACCEPTS a password at the boundary', () => {
    expect(passwordProblem('a'.repeat(MIN_PASSWORD_LENGTH))).toBeNull()
  })

  it('rejects an absurdly long password so the KDF cannot be used to burn CPU', () => {
    expect(passwordProblem('a'.repeat(1025))).not.toBeNull()
    expect(passwordProblem('a'.repeat(1024))).toBeNull()
  })
})

describe('email handling', () => {
  it('lowercases and trims, so one person cannot register twice', () => {
    expect(normaliseEmail('  Tabish@Dashmani.COM ')).toBe('tabish@dashmani.com')
  })

  it('accepts a real address and rejects malformed ones', () => {
    expect(emailProblem('tabish@dashmani.com')).toBeNull()
    expect(emailProblem('')).not.toBeNull()
    expect(emailProblem('no-at-sign')).not.toBeNull()
    expect(emailProblem('no@tld')).not.toBeNull()
    expect(emailProblem('two@at@signs.com')).not.toBeNull()
    expect(emailProblem('spaces in@email.com')).not.toBeNull()
  })
})

describe('session tokens', () => {
  it('hashes tokens, so a database read does not reveal a live session', () => {
    const raw = 'a-raw-session-token'
    const hashed = hashToken(raw)
    expect(hashed).not.toBe(raw)
    expect(hashed).not.toContain(raw)
    expect(hashed).toMatch(/^[0-9a-f]{64}$/)
  })

  it('hashes deterministically, or no session could ever be looked up', () => {
    expect(hashToken('same-input')).toBe(hashToken('same-input'))
    expect(hashToken('one-input')).not.toBe(hashToken('another-input'))
  })

  it('safeEqual matches equal strings and rejects different ones', () => {
    expect(safeEqual('abc', 'abc')).toBe(true)
    expect(safeEqual('abc', 'abd')).toBe(false)
    // Different lengths must return false rather than throwing, which is what
    // timingSafeEqual does on its own.
    expect(safeEqual('abc', 'abcd')).toBe(false)
    expect(safeEqual('', '')).toBe(true)
  })
})
