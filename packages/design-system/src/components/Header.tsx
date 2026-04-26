'use client'

/**
 * Header.tsx — wordmark + nav + theme toggle.
 * Sticky, solid paper, hairline bottom rule.
 * Below mid (720px): nav collapses, hamburger/panel appears.
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

  useEffect(() => {
    if (theme === 'dark') {
      document.documentElement.classList.add('dark')
    } else {
      document.documentElement.classList.remove('dark')
    }
  }, [theme])

  // Close mobile panel on resize to desktop
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 45rem)')
    const onChange = () => {
      if (mq.matches) setOpen(false)
    }
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  const toggleTheme = () => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))

  const navLinkClass =
    'font-ui text-sm font-medium no-underline whitespace-nowrap hover:text-accent'

  return (
    <header className="sticky top-0 z-50 bg-paper-0 border-b border-paper-3">
      <div
        className={
          'max-w-page mx-auto px-[var(--page-gutter)] py-4 ' +
          'flex items-center justify-between gap-5'
        }
      >
        <a
          href="#top"
          className={
            'font-display text-lg font-medium tracking-tight text-ink-0 ' + 'no-underline shrink-0'
          }
        >
          Prose<span className="text-accent">.</span>
        </a>

        {/* Desktop nav */}
        <nav className="hidden mid:flex items-center gap-6" aria-label="Primary">
          {NAV_ITEMS.map((item) => (
            <a
              key={item}
              href={`#${item.toLowerCase()}`}
              className={`${navLinkClass} ${item === active ? 'text-ink-0' : 'text-ink-1'}`}
            >
              {item}
            </a>
          ))}
          <a href="#start" className={`${navLinkClass} !text-ink-0`}>
            Get started →
          </a>
          <button
            onClick={toggleTheme}
            aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
            className={
              'bg-transparent border border-ink-4 rounded-full ' +
              'w-[36px] h-[36px] inline-flex items-center justify-center ' +
              'font-mono text-[14px] text-ink-1 cursor-pointer shrink-0 p-0 ' +
              'hover:text-accent hover:border-accent'
            }
          >
            {theme === 'dark' ? '☾' : '☼'}
          </button>
        </nav>

        {/* Mobile trigger */}
        <button
          className={
            'inline-flex mid:hidden items-center ' +
            'bg-transparent border border-ink-4 rounded-full ' +
            'h-[36px] py-0 px-[14px] ' +
            'font-ui text-xs font-semibold tracking-wide uppercase ' +
            'text-ink-1 cursor-pointer hover:text-accent hover:border-accent'
          }
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
        className={
          (open ? 'block' : 'hidden') +
          ' mid:hidden ' +
          'border-t border-paper-3 bg-paper-0 ' +
          'py-5 px-[var(--page-gutter)] ' +
          'divide-y divide-paper-2'
        }
        role="navigation"
        aria-label="Mobile"
      >
        {NAV_ITEMS.map((item) => (
          <a
            key={item}
            href={`#${item.toLowerCase()}`}
            onClick={() => setOpen(false)}
            className={
              'block py-3 font-ui text-md font-medium text-ink-0 ' + 'no-underline text-left w-full'
            }
          >
            {item}
          </a>
        ))}
        <a
          href="#start"
          onClick={() => setOpen(false)}
          className={
            'block py-3 font-ui text-md font-medium text-ink-0 ' + 'no-underline text-left w-full'
          }
        >
          Get started →
        </a>
        <button
          onClick={toggleTheme}
          className={
            'block py-3 font-ui text-md font-medium text-ink-0 ' +
            'border-0 bg-transparent cursor-pointer text-left w-full'
          }
        >
          {theme === 'dark' ? '☼ light' : '☾ dark'}
        </button>
      </div>
    </header>
  )
}
