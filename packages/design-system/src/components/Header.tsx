'use client'

/**
 * Header.tsx — wordmark + nav + theme toggle.
 * Sticky, solid paper, hairline bottom rule.
 * At ≤720px: nav collapses, hamburger/panel appears.
 * Theme toggle: adds/removes .dark on <html>.
 */

import { useState, useEffect } from 'react'

export interface HeaderProps {
  /** Which nav item is highlighted as active. */
  active?: string
}

const NAV_ITEMS = ['Manual', 'Examples', 'Pricing', 'Journal']

export function Header({ active = 'Manual' }: HeaderProps) {
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    if (typeof document === 'undefined') return 'light'
    return document.documentElement.classList.contains('dark') ? 'dark' : 'light'
  })
  const [open, setOpen] = useState(false)

  // Apply .dark class to <html>
  useEffect(() => {
    if (theme === 'dark') {
      document.documentElement.classList.add('dark')
    } else {
      document.documentElement.classList.remove('dark')
    }
  }, [theme])

  // Close mobile panel on resize to desktop
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 721px)')
    const onChange = () => {
      if (mq.matches) setOpen(false)
    }
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  const toggleTheme = () => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))

  return (
    <header className="prose-header" data-open={open}>
      <div className="prose-header__inner">
        <a href="#top" className="prose-header__wordmark">
          Prose<span className="prose-header__wordmark-accent">.</span>
        </a>

        {/* Desktop nav */}
        <nav className="prose-header__nav" aria-label="Primary">
          {NAV_ITEMS.map((item) => (
            <a
              key={item}
              href={`#${item.toLowerCase()}`}
              className={item === active ? 'is-active' : ''}
            >
              {item}
            </a>
          ))}
          <a href="#start" className="prose-header__cta">
            Get started →
          </a>
          <button
            onClick={toggleTheme}
            aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
            className="prose-header__theme-btn"
          >
            {theme === 'dark' ? '☾' : '☼'}
          </button>
        </nav>

        {/* Mobile trigger */}
        <button
          className="prose-header__menu-btn"
          aria-expanded={open}
          aria-controls="prose-header-panel"
          onClick={() => setOpen((o) => !o)}
        >
          {open ? 'Close' : 'Menu'}
        </button>
      </div>

      {/* Mobile panel */}
      <div
        id="prose-header-panel"
        className="prose-header__panel"
        role="navigation"
        aria-label="Mobile"
      >
        {NAV_ITEMS.map((item) => (
          <a key={item} href={`#${item.toLowerCase()}`} onClick={() => setOpen(false)}>
            {item}
          </a>
        ))}
        <a href="#start" onClick={() => setOpen(false)}>
          Get started →
        </a>
        <button onClick={toggleTheme}>{theme === 'dark' ? '☼ light' : '☾ dark'}</button>
      </div>
    </header>
  )
}
