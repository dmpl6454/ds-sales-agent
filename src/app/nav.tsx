'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

const LINKS = [
  { href: '/', label: 'Overview' },
  { href: '/campaigns', label: 'Campaigns' },
  { href: '/targets', label: 'Targets' },
  { href: '/senders', label: 'Senders' },
  { href: '/runs', label: 'Runs' },
  { href: '/settings', label: 'Settings' },
] as const

export function Nav() {
  const path = usePathname()
  return (
    <nav className="top">
      <div className="inner">
        <div className="brand">
          DS Sales Agent <small>Phase 1</small>
        </div>
        {LINKS.map((l) => (
          <Link
            key={l.href}
            href={l.href}
            className="link"
            data-active={l.href === '/' ? path === '/' : path.startsWith(l.href)}
          >
            {l.label}
          </Link>
        ))}
      </div>
    </nav>
  )
}
