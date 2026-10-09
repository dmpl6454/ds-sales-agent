import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { ENV_KEYS } from '@/lib/env'

const ROOT = resolve(__dirname, '..')
const EXAMPLE = readFileSync(join(ROOT, '.env.example'), 'utf8')

/**
 * ── `.env.example` MUST COVER EVERY KEY THE SCHEMA GOVERNS ────────────────────────────
 *
 * MEASURED 2026-08-17 by cloning this repository into a temporary directory and setting it
 * up exactly as a second operator would. `pnpm install`, `cp .env.example .env`,
 * `pnpm db:push`, `pnpm db:seed` and `pnpm test` all worked — and the app was still
 * unusable, because **`SIGNUP_INVITE_CODE` was absent from `.env.example`** and an unset
 * invite code means signup is CLOSED.
 *
 * That is correct behaviour on a server and a dead end on a laptop: you start the app, open
 * /sign-up, and can never create the account that would let you in. Nothing on screen
 * explains it, because from the code's point of view nothing is wrong.
 *
 * `SEND_ENABLED` and `MAX_TOTAL_SENDS` were missing too, and both are safety-relevant:
 * `SEND_ENABLED` DEFAULTS TRUE, so a fresh clone on someone's Mac can drive a browser and
 * send, and the file that is supposed to tell them so did not mention it.
 *
 * This is a totality test for the same reason `tests/stopInventory.test.ts` is total over
 * `RESEND_BLOCKS` and `messages/remedy.ts` is total over its stops: the failure mode is a
 * key somebody adds to the schema and forgets to document, and no behavioural test can fail
 * for a line of documentation nobody wrote.
 */

/** Keys read directly from `process.env` rather than through the schema, but still needed. */
const ALSO_REQUIRED = ['DEEPSEEK_API_KEY', 'DS_DEVICE_NAME', 'EMBEDDED_SCHEDULER', 'COOKIE_SECURE']

function documents(key: string): boolean {
  // Either assigned (`KEY=…`) or shown commented-out as an optional (`# KEY=…`).
  return new RegExp(`^\\s*#?\\s*${key}=`, 'm').test(EXAMPLE)
}

describe('.env.example documents the whole environment', () => {
  it('the schema declares keys at all (or this test proves nothing)', () => {
    expect(ENV_KEYS.length).toBeGreaterThan(10)
    expect(ENV_KEYS).toContain('DATABASE_URL')
  })

  it.each(ENV_KEYS)('documents %s', (key) => {
    expect(documents(key), `${key} is in src/lib/env.ts but not in .env.example`).toBe(true)
  })

  it.each(ALSO_REQUIRED)('documents %s, which is read directly from process.env', (key) => {
    expect(documents(key), `${key} is read by the code but not in .env.example`).toBe(true)
  })

  /**
   * THE ONE THAT LOCKED A NEW OPERATOR OUT. Asserted by name as well as by the loop above,
   * because the loop would still pass if somebody removed it from the schema — and the
   * behaviour (signup closed) would then be reached by a different route.
   */
  it('spells out that an unset invite code CLOSES signup', () => {
    expect(documents('SIGNUP_INVITE_CODE')).toBe(true)
    expect(EXAMPLE).toMatch(/signup is CLOSED/i)
  })

  /** `SEND_ENABLED` defaults TRUE, so the file must say so rather than imply a safe default. */
  it('says that SEND_ENABLED defaults to true', () => {
    expect(EXAMPLE).toMatch(/SEND_ENABLED/)
    expect(EXAMPLE).toMatch(/DEFAULTS TO TRUE/i)
  })

  /**
   * MUTATION-TESTED: the matcher must not be satisfied by the key merely appearing in prose.
   * An earlier version used a bare `includes`, which passed on any mention of the word
   * anywhere in a file that is mostly commentary.
   */
  it('does not count a bare mention in prose as documentation', () => {
    expect(documents('DEFINITELY_NOT_A_REAL_KEY')).toBe(false)
    // The word appears in a comment in the file; that must not count as documenting it.
    expect(/^\s*#?\s*Instagram=/m.test(EXAMPLE)).toBe(false)
  })

  /**
   * THE PLACEHOLDER NAME WAS A SHARED NAME (2026-10-09). `DS_DEVICE_NAME="my-mac"` was assigned,
   * and the setup doc says `cp .env.example .env` — so every machine set up by hand was "my-mac",
   * and the sending Mac is chosen by name. Documented, commented out: unset means the hostname.
   */
  it('documents DS_DEVICE_NAME without assigning a placeholder every copy would share', () => {
    expect(documents('DS_DEVICE_NAME')).toBe(true)
    expect(EXAMPLE).not.toMatch(/^\s*DS_DEVICE_NAME=/m)
  })

  /** No real secret may sit in a file that is committed. */
  it('carries no credential-shaped values', () => {
    expect(EXAMPLE).not.toMatch(/sk-[A-Za-z0-9]{16,}/)
    expect(EXAMPLE).not.toMatch(/DEEPSEEK_API_KEY="[^"]{12,}"/)
    expect(EXAMPLE).not.toMatch(/postgresql:\/\/[^:]+:[^@\s]{6,}@/)
    expect(EXAMPLE).not.toMatch(/BEGIN (RSA|OPENSSH) PRIVATE KEY/)
  })
})
