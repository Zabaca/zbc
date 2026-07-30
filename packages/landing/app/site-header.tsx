'use client'

/**
 * The landing page's own header. The design system's <Header> is hardcoded to
 * the Prose wordmark and its own nav, so it can't carry zbc's. This composes
 * the same shell (sticky, paper ground, hairline rule) from tokens.
 */

import { useEffect, useState } from 'react'

const NAV = [
  { label: 'Run', href: '#run' },
  { label: 'Modules', href: '#modules' },
  { label: 'Live', href: '#live' },
]

const REPO = 'https://github.com/Zabaca/zbc'

export function SiteHeader() {
  // The inline script in layout.tsx has already applied the class before paint,
  // so read it back rather than assuming light, or a dark-mode visitor
  // sees the sun icon (and an aria-label that lies) until hydration lands.
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    if (typeof document === 'undefined') return 'light'
    return document.documentElement.classList.contains('dark') ? 'dark' : 'light'
  })
  const [open, setOpen] = useState(false)

  useEffect(() => {
    const mq = window.matchMedia('(min-width: 45rem)')
    const onChange = () => {
      if (mq.matches) setOpen(false)
    }
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  function toggleTheme() {
    const next = theme === 'dark' ? 'light' : 'dark'
    setTheme(next)
    document.documentElement.classList.toggle('dark', next === 'dark')
    try {
      localStorage.setItem('zbc-theme', next)
    } catch {
      // private mode; the toggle still works for this page view
    }
  }

  const linkClass = 'font-ui text-sm font-medium text-ink-1 no-underline hover:text-accent'

  return (
    <header className="sticky top-0 z-40 border-b border-paper-3 bg-paper-0">
      <div className="mx-auto flex max-w-page items-center justify-between gap-5 px-[var(--page-gutter)] py-4">
        <a
          href="#top"
          className="shrink-0 font-mono text-md font-medium text-ink-0 no-underline tracking-tight"
        >
          zbc<span className="text-accent">_</span>
        </a>

        <nav className="hidden items-center gap-6 mid:flex" aria-label="Primary">
          {NAV.map((item) => (
            <a key={item.href} href={item.href} className={linkClass}>
              {item.label}
            </a>
          ))}
          <a href={REPO} className={linkClass}>
            GitHub ↗
          </a>
          <button
            type="button"
            onClick={toggleTheme}
            aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
            className="inline-flex h-[36px] w-[36px] shrink-0 cursor-pointer items-center justify-center rounded-full border border-ink-4 bg-transparent p-0 font-mono text-sm text-ink-1 hover:border-accent hover:text-accent"
          >
            {theme === 'dark' ? '☾' : '☼'}
          </button>
        </nav>

        <button
          type="button"
          className="inline-flex h-[36px] cursor-pointer items-center rounded-full border border-ink-4 bg-transparent px-[14px] py-0 font-ui text-xs font-semibold uppercase tracking-wide text-ink-1 mid:hidden hover:border-accent hover:text-accent"
          aria-expanded={open}
          aria-controls="zbc-nav-panel"
          onClick={() => setOpen((o) => !o)}
        >
          {open ? 'Close' : 'Menu'}
        </button>
      </div>

      <div
        id="zbc-nav-panel"
        className={`${open ? 'block' : 'hidden'} divide-y divide-paper-2 border-t border-paper-3 bg-paper-0 px-[var(--page-gutter)] py-5 mid:hidden`}
      >
        {NAV.map((item) => (
          <a
            key={item.href}
            href={item.href}
            onClick={() => setOpen(false)}
            className="block w-full py-3 text-left font-ui text-md font-medium text-ink-0 no-underline"
          >
            {item.label}
          </a>
        ))}
        <a
          href={REPO}
          className="block w-full py-3 text-left font-ui text-md font-medium text-ink-0 no-underline"
        >
          GitHub ↗
        </a>
        <button
          type="button"
          onClick={toggleTheme}
          aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
          className="block w-full cursor-pointer border-0 bg-transparent py-3 text-left font-ui text-md font-medium text-ink-0"
        >
          {theme === 'dark' ? '☼ light' : '☾ dark'}
        </button>
      </div>
    </header>
  )
}
