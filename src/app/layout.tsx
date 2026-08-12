import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Instagram Outreach',
  description: 'Paid-campaign watch and partnership outreach',
}

/**
 * The shell. Navigation lives in `nav.tsx` and is rendered per page rather than here,
 * so `/sign-in` and `/sign-up` — the only two public pages — do not show links to
 * places a signed-out visitor cannot reach.
 *
 * Anything an engineer needs that is not on a page lives in `pnpm db:studio`.
 */
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <main>{children}</main>
      </body>
    </html>
  )
}
