'use client'

/**
 * DS viewer chrome — left sidebar.
 * Nav: Foundations, Components, Pages.
 * Footer: Dark / Light toggle only.
 *
 * Fixed chrome toggle (top-left viewport, always visible):
 *   ← = sidebar shown (click to collapse)
 *   → = sidebar hidden (click to expand)
 *
 * Theme persisted in localStorage under 'prose-ds-theme'.
 * Sidebar visibility persisted under 'prose-ds-sidebar'.
 * ready flag suppresses symbol during SSR to avoid hydration mismatch.
 */

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'

const THEME_KEY = 'prose-ds-theme'
const SIDEBAR_KEY = 'prose-ds-sidebar'

const FOUNDATIONS = [
  { slug: 'colors', label: 'Colors' },
  { slug: 'typography', label: 'Typography' },
  { slug: 'spacing', label: 'Spacing' },
  { slug: 'brand', label: 'Brand' },
  { slug: 'motion', label: 'Motion' },
]

const COMPONENTS = [
  { slug: 'header', label: 'Header' },
  { slug: 'hero', label: 'Hero' },
  { slug: 'manifesto', label: 'Manifesto' },
  { slug: 'editorial', label: 'Editorial' },
  { slug: 'features', label: 'Features' },
  { slug: 'pricing', label: 'Pricing' },
  { slug: 'faq', label: 'FAQ' },
  { slug: 'newsletter', label: 'Newsletter' },
  { slug: 'footer', label: 'Footer' },
  { slug: 'primary-button', label: 'PrimaryButton' },
]

const PAGES = [{ slug: 'prose', label: 'Prose landing' }]

// ---- Sub-components --------------------------------------------------------

interface NavSectionProps {
  label: string
  items: { slug: string; label: string }[]
  basePath: string
  pathname: string
}

function NavSection({ label, items, basePath, pathname }: NavSectionProps) {
  return (
    <div className="ds-sidebar__section">
      <span className="ds-sidebar__section-label">{label}</span>
      <ul className="ds-sidebar__links">
        {items.map((item) => {
          const href = `${basePath}/${item.slug}`
          const isActive = pathname === href
          return (
            <li key={item.slug}>
              <Link
                href={href}
                className={`ds-sidebar__link${isActive ? ' ds-sidebar__link--active' : ''}`}
              >
                {item.label}
              </Link>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

// ---- Chrome ----------------------------------------------------------------

export function Chrome({ children }: { children: React.ReactNode }) {
  const [dark, setDark] = useState(false)
  const [sidebarVisible, setSidebarVisible] = useState(true) // true = SSR default
  const [ready, setReady] = useState(false)
  const pathname = usePathname()

  useEffect(() => {
    const storedTheme = localStorage.getItem(THEME_KEY)
    const isDark = storedTheme === 'dark'
    setDark(isDark)
    document.documentElement.classList.toggle('dark', isDark)

    const storedSidebar = localStorage.getItem(SIDEBAR_KEY)
    setSidebarVisible(storedSidebar !== 'hidden')

    setReady(true)
  }, [])

  function toggleTheme() {
    const next = !dark
    setDark(next)
    document.documentElement.classList.toggle('dark', next)
    localStorage.setItem(THEME_KEY, next ? 'dark' : 'light')
  }

  function toggleSidebar() {
    const next = !sidebarVisible
    setSidebarVisible(next)
    localStorage.setItem(SIDEBAR_KEY, next ? 'visible' : 'hidden')
  }

  return (
    <>
      {/* ---- Fixed chrome toggle — single position, always rendered ---- */}
      {/* Symbol changes: ← = collapse, → = expand. Space during SSR. */}
      <button
        className="ds-chrome-toggle"
        onClick={toggleSidebar}
        aria-label={
          ready ? (sidebarVisible ? 'Hide navigation' : 'Show navigation') : 'Toggle navigation'
        }
      >
        {ready ? (sidebarVisible ? '←' : '→') : ' '}
      </button>

      <div className={`ds-layout${sidebarVisible ? '' : ' ds-layout--sidebar-hidden'}`}>
        {/* ---- Sidebar ---- */}
        <aside className="ds-sidebar" aria-label="Design system navigation">
          <div className="ds-sidebar__inner">
            {/* Brand mark — display serif "Prose." with accent period, mono "viewer" below.
                paddingTop clears the fixed ds-chrome-toggle (top:16 + height:32 + gap:16 = 64px). */}
            <Link href="/" className="ds-sidebar__logo" style={{ paddingTop: 'var(--sp-8)' }}>
              <span
                style={{
                  display: 'block',
                  fontFamily: 'var(--font-display)',
                  fontSize: 'var(--fs-xl)',
                  fontWeight: 500,
                  lineHeight: 1,
                  letterSpacing: 'var(--tr-tighter)',
                  color: 'var(--ink-0)',
                }}
              >
                Prose<span style={{ color: 'var(--accent)' }}>.</span>
              </span>
              <span
                style={{
                  display: 'block',
                  fontFamily: 'var(--font-mono)',
                  fontSize: 'var(--fs-3xs)',
                  letterSpacing: 'var(--tr-widest)',
                  textTransform: 'uppercase',
                  color: 'var(--ink-3)',
                  marginTop: 'var(--sp-1)',
                }}
              >
                viewer
              </span>
            </Link>

            <nav>
              <NavSection
                label="Foundations"
                items={FOUNDATIONS}
                basePath="/foundations"
                pathname={pathname}
              />
              <NavSection
                label="Components"
                items={COMPONENTS}
                basePath="/components"
                pathname={pathname}
              />
              <NavSection label="Pages" items={PAGES} basePath="/pages" pathname={pathname} />
            </nav>
          </div>

          {/* Footer: Dark / Light only — hide toggle moved to fixed chrome button above */}
          <div className="ds-sidebar__footer">
            <button
              className="ds-sidebar__toggle"
              onClick={toggleTheme}
              aria-label="Toggle colour scheme"
            >
              {ready ? (dark ? 'Light' : 'Dark') : ' '}
            </button>
          </div>
        </aside>

        {/* ---- Main content ---- */}
        <div className="ds-main">{children}</div>
      </div>
    </>
  )
}
