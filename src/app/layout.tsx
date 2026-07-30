import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Instagram Outreach',
  description: 'Paid-campaign watch and partnership outreach',
}

/**
 * No navigation, because there is only one page. Anything an engineer needs that
 * is not here lives in `pnpm db:studio`.
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
