import type { Metadata } from 'next'
import './globals.css'
import { Nav } from './nav'

export const metadata: Metadata = {
  title: 'DS Sales Agent',
  description: 'Instagram paid-campaign watch and partnership outreach — Phase 1',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Nav />
        <div className="wrap">{children}</div>
      </body>
    </html>
  )
}
