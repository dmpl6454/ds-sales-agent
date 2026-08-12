import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from 'node:crypto'

/**
 * Password hashing for DASHBOARD operators.
 *
 * This does not contradict "nothing in this repo stores, reads, or transmits a
 * password". That rule is about INSTAGRAM credentials — there is still no field for
 * one, detection is anonymous, and sending drives a browser profile a human logged
 * into. This is our own dashboard's password, and it is stored only as a hash that
 * cannot be reversed.
 *
 * WHY scrypt FROM node:crypto RATHER THAN bcrypt OR argon2
 *
 * Not a preference — three specific constraints in this repo:
 *
 *  1. `serverExternalPackages` in next.config.ts exists BECAUSE native bindings break
 *     this build (Prisma, better-sqlite3, patchright). `bcrypt` and `@node-rs/argon2`
 *     are both native. Each one added is another entry there and another way for
 *     `pnpm build` to fail.
 *  2. This code must run in the Next server bundle AND under tsx (scripts, worker).
 *     That is exactly the boundary where a lazy `require('better-sqlite3')` reported
 *     every account as "not connected" — see the ESM gotcha in CLAUDE.md.
 *  3. scrypt is memory-hard and in OWASP's recommended set. At N=2^16 it is a
 *     genuinely slow KDF, not a fast digest.
 *
 * Nothing here is novel cryptography: it is the standard salt + slow-KDF +
 * constant-time-compare construction, using the platform's own primitives.
 */

/**
 * Hand-wrapped rather than `promisify(scryptCb)`: promisify picks the 3-argument
 * overload, which drops the options object — and the options are where N, r, p and
 * maxmem live, so the cost parameters would silently fall back to Node's weak defaults
 * (N=16384, and an 8 MB memory cap these parameters exceed). A KDF quietly running at
 * a quarter of the intended cost is exactly the kind of guard-shaped no-op this
 * codebase keeps finding.
 */
function scrypt(password: string, salt: Buffer, keylen: number, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(password, salt, keylen, options, (err, derived) => {
      if (err) reject(err)
      else resolve(derived)
    })
  })
}

/**
 * N=65536, r=8, p=1 — OWASP's minimum for scrypt, ~100ms per hash on this hardware.
 *
 * The cost is stored IN the hash string, so raising these later does not invalidate
 * existing passwords: an old hash is still verified with the parameters it was made
 * with. A hardcoded cost would mean every increase locks every user out.
 */
const N = 65536
const R = 8
const P = 1
const KEY_LENGTH = 32
const SALT_LENGTH = 16

/**
 * scrypt's memory use is roughly 128 * N * r bytes ≈ 64 MB at these parameters, which
 * exceeds Node's default 8 MB cap for this call and throws without it.
 */
const MAX_MEMORY = 192 * 1024 * 1024

/** Minimum password length. Short enough not to be theatre, long enough to matter. */
export const MIN_PASSWORD_LENGTH = 10

/**
 * "scrypt$N$r$p$salt$hash", all base64url.
 *
 * Self-describing on purpose. A bare digest cannot say what produced it, so changing
 * the algorithm later would mean guessing per row, and rejecting a correct password
 * because the format changed is indistinguishable to the user from being locked out.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH)
  const derived = await scrypt(password.normalize('NFKC'), salt, KEY_LENGTH, {
    N,
    r: R,
    p: P,
    maxmem: MAX_MEMORY,
  })

  return ['scrypt', N, R, P, salt.toString('base64url'), derived.toString('base64url')].join('$')
}

/**
 * Constant-time verification. Returns false for a malformed hash rather than throwing —
 * a corrupt row must read as "wrong password", never as a 500 that reveals the row
 * exists.
 *
 * `timingSafeEqual`, not `===`: comparing digests with `===` returns early on the first
 * differing byte, which leaks how much of a guess was correct.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algo, nRaw, rRaw, pRaw, saltRaw, hashRaw] = stored.split('$')
  if (algo !== 'scrypt') return false
  // Explicit undefined checks: a string with too few `$` yields undefined here, and
  // `Number(undefined)` is NaN while `Buffer.from(undefined)` throws.
  if (nRaw === undefined || rRaw === undefined || pRaw === undefined) return false
  if (saltRaw === undefined || hashRaw === undefined) return false

  const n = Number(nRaw)
  const r = Number(rRaw)
  const p = Number(pRaw)
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false
  // Bound the work a stored row can ask for. Without this a tampered row could name
  // N=2^30 and turn one sign-in attempt into a memory-exhaustion denial of service.
  if (n < 1024 || n > 1_048_576 || r < 1 || r > 32 || p < 1 || p > 16) return false

  let salt: Buffer
  let expected: Buffer
  try {
    salt = Buffer.from(saltRaw, 'base64url')
    expected = Buffer.from(hashRaw, 'base64url')
  } catch {
    return false
  }
  if (salt.length === 0 || expected.length === 0) return false

  let derived: Buffer
  try {
    derived = await scrypt(password.normalize('NFKC'), salt, expected.length, {
      N: n,
      r,
      p,
      maxmem: MAX_MEMORY,
    })
  } catch {
    return false
  }

  // Lengths are equal by construction (we derived `expected.length`), but
  // timingSafeEqual throws on a mismatch, so this stays defensive.
  if (derived.length !== expected.length) return false
  return timingSafeEqual(derived, expected)
}

/**
 * Why a password is unacceptable, or null if it is fine.
 *
 * Deliberately only a length floor. Composition rules ("one capital, one symbol") push
 * people toward `Password1!` and are not what stops a guess; length is.
 */
export function passwordProblem(password: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`
  }
  if (password.length > 1024) {
    // Bounded so a megabyte-long password cannot be used to burn CPU in the KDF.
    return 'Password must be at most 1024 characters.'
  }
  return null
}

/** Lowercased and trimmed. The stored identity, used in `sentBy` and audit rows. */
export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase()
}

/** Shape check only — deliberately permissive, since we send no mail to verify it. */
export function emailProblem(email: string): string | null {
  const e = normaliseEmail(email)
  if (e.length === 0) return 'Email is required.'
  if (e.length > 320) return 'Email is too long.'
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) return 'That does not look like an email address.'
  return null
}
