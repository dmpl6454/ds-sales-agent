/**
 * The session cookie's NAME, and nothing else.
 *
 * This file exists solely so `src/middleware.ts` can name the cookie without importing
 * anything Node-only. Middleware runs in Next's **Edge** runtime, where `node:crypto`
 * does not exist — importing `lib/session.ts` there compiled fine and then failed at
 * runtime with `Native module not found: node:crypto` on EVERY request, including
 * `/sign-in`, so the whole dashboard returned 500 and nobody could even sign in.
 *
 * It is the same shape as the `require()` gotcha in CLAUDE.md: code that resolves in one
 * runtime and throws in another, invisible to `pnpm build` and to `pnpm typecheck`. The
 * only reliable defence is that the module reachable from middleware imports nothing at
 * all — so keep this file dependency-free. A single import here can take the dashboard
 * down.
 */
export const SESSION_COOKIE = 'ds_session'
