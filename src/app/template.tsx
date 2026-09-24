/**
 * `template.tsx` — a per-navigation wrapper around every route's content.
 *
 * Unlike `layout.tsx`, a template creates a fresh instance on each NAVIGATION rather than
 * persisting across it, and it sits inside the same Suspense boundary `loading.tsx` is the
 * fallback for — so an `await` here holds up that boundary exactly the way real data-fetching
 * would, and the boot screen stays on screen for the full wait rather than however long the
 * page's own queries happened to take.
 *
 * WHY THIS AND NOT A LONGER ANIMATION IN `loading.tsx` ITSELF: Next unmounts `loading.tsx`
 * the instant the page's data is ready, whatever the animation is doing — nothing inside that
 * file can keep it on screen longer, since it does not control its own unmount. Delaying the
 * content it is a fallback for is the only lever that actually works.
 *
 * VERIFIED NOT TO FIRE ON `router.refresh()`: a template only remounts on navigation, not on
 * an in-place refresh of the current route — checked directly against this app's own
 * `auto-refresh.tsx` poller (which calls `router.refresh()` every 30–45 s) and against a
 * server-action mutation with `revalidatePath`, both driven live for 40+ seconds with the
 * account's own dashboard open: zero extra renders here from either. So the pages that
 * refresh themselves while sends are in flight are untouched; only an actual page change —
 * clicking a nav link, typing a URL, a hard reload — gets the held boot screen.
 */
const MIN_VISIBLE_MS = 2500

export default async function RootTemplate({ children }: { children: React.ReactNode }) {
  await new Promise((resolve) => setTimeout(resolve, MIN_VISIBLE_MS))
  return <>{children}</>
}
