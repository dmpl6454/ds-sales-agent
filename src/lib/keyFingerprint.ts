import { createHash } from 'node:crypto'

/**
 * `SHA256:…` exactly as `ssh-keygen -lf` prints it, so a person can compare the two.
 *
 * A LEAF MODULE (2026-10-09) because two different processes need it: the server, which names
 * paired Macs by it in `deviceEnrol.ts`, and every device agent, which now writes its own tunnel
 * key's fingerprint into its presence entry so the server can tell "this Mac, re-pairing" from
 * "another Mac with the same name". `deviceEnrol.ts` imports the database and the env schema; the
 * presence module must not drag those into whatever merely wants to know who this Mac is.
 */
export function keyFingerprint(publicKey: string): string {
  const b64 = publicKey.trim().split(/\s+/)[1] ?? ''
  const digest = createHash('sha256').update(Buffer.from(b64, 'base64')).digest('base64').replace(/=+$/, '')
  return `SHA256:${digest}`
}
