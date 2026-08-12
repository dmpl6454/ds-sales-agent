import type { Metadata } from 'next'
import { Public_Sans, Martian_Mono } from 'next/font/google'
import './globals.css'

/**
 * THE FONTS ARE SELF-HOSTED, and that is not a preference.
 *
 * The design file references `fonts.googleapis.com` directly. Three reasons that
 * cannot ship here: this dashboard binds `127.0.0.1` and is also served behind
 * nginx on a box whose whole security argument is that it reaches nothing it
 * does not need to; a webfont fetched at render time is a render-blocking
 * round trip on pages whose measured problem is already time-to-first-byte; and
 * a page that silently falls back to a system stack when a CDN is slow is a page
 * whose typography is decided by someone else's uptime.
 *
 * `next/font/google` downloads at BUILD time and serves from our own origin, so
 * the bytes are identical and the request is not.
 */
const sans = Public_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-sans',
  display: 'swap',
})

const mono = Martian_Mono({
  subsets: ['latin'],
  weight: ['400', '500'],
  variable: '--font-mono',
  display: 'swap',
})

export const metadata: Metadata = {
  title: 'Instagram Outreach',
  description: 'Paid-campaign watch and partnership outreach',
}

/**
 * Applied before first paint, which is the entire reason it is a raw string in
 * `<head>` rather than a `useEffect`.
 *
 * A theme read after hydration means the page paints in the DEFAULT theme and
 * then swaps — a white flash on a console someone is reading at 6am, and worse,
 * a status colour that is briefly the wrong one. Reading `localStorage`
 * synchronously here costs a fraction of a millisecond and removes the flash
 * entirely.
 *
 * It fails SILENTLY and correctly: in private mode, or with storage blocked,
 * `localStorage` throws and the catch leaves `data-theme` unset — which is the
 * "follow the system" state, the right default. An exception here must never be
 * able to take the shell down.
 *
 * ON `dangerouslySetInnerHTML`, since a scanner will flag it and someone will
 * try to "fix" it: this string is a MODULE-LEVEL CONSTANT with nothing
 * interpolated into it, ever. There is no request data, no user input and no
 * database value anywhere in it, so there is no injection surface — exactly the
 * same reasoning that keeps the classifier's system prompt a constant. If you
 * ever need this script to vary, it must not be built by concatenation; write
 * the value to a `data-` attribute and have the script read it from the DOM.
 */
const BOOT = `
try {
  var t = localStorage.getItem('ds-theme');
  if (t === 'dark' || t === 'light') document.documentElement.dataset.theme = t;
  if (localStorage.getItem('ds-rail') === 'collapsed') document.documentElement.dataset.rail = 'collapsed';
} catch (e) {}
`

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: BOOT }} />
      </head>
      {/*
        `main` wraps everything, the rail included. That looks odd and is deliberate: the
        rail is `position: fixed`, so it is out of flow wherever it sits, and keeping the
        structure the pages already produce means `pnpm ig:layout`'s geometry assertions
        keep testing the same thing they were written against.

        `main` is NOT a grid or a flex container, and must not become one. It was given
        `grid-template-columns: 15rem 1fr` once, and every page rendered two children
        except `/`, which rendered eleven — so children 3, 5, 7, 9 and 11 landed in column
        one underneath a full-height rail. A fixed rail plus a margin cannot care how many
        children a page renders.
      */}
      <body>
        <main>{children}</main>
      </body>
    </html>
  )
}