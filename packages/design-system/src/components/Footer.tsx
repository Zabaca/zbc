/**
 * Footer.tsx — multi-column footer.
 * Mobile (default): 1 col. narrow (≥480px): 2 cols, brand spans both,
 * tagline hidden. wide (≥960px): 5 cols (brand 2fr + 4 link cols),
 * tagline visible.
 */

const COLS = [
  { h: 'System', links: ['Manual', 'Stylesheet', 'Components', 'Changelog'] },
  { h: 'Examples', links: ['Hero set', 'Editorial', 'Pricing patterns', 'Showcase'] },
  { h: 'Studio', links: ['Pricing', 'Licensing', 'Contact'] },
  { h: 'Elsewhere', links: ['GitHub ↗', 'Twitter ↗', 'RSS'] },
]

export function Footer() {
  return (
    <footer className="bg-paper-1 border-t border-paper-3 pt-9 pb-6">
      <div
        className={
          'max-w-page mx-auto px-[var(--page-gutter)] ' +
          'grid grid-cols-1 narrow:grid-cols-2 wide:grid-cols-[2fr_1fr_1fr_1fr_1fr] ' +
          'gap-6 narrow:gap-y-7 narrow:gap-x-6 wide:gap-7'
        }
      >
        <div className="narrow:col-span-2 wide:col-span-1">
          <span
            className={'block mb-3 font-display text-2xl tracking-tighter font-medium text-ink-0'}
          >
            Prose<span className="text-accent">.</span>
          </span>
          <p className={'hidden wide:block font-text text-sm italic text-ink-2 max-w-[30ch] m-0'}>
            A text-only design system for landing pages.
          </p>
        </div>

        {COLS.map((col) => (
          <div key={col.h}>
            <h3 className={'font-mono text-xs font-medium tracking-wide uppercase text-ink-2 mb-4'}>
              {col.h}
            </h3>
            <ul className="list-none p-0 m-0 flex flex-col gap-3">
              {col.links.map((l) => (
                <li key={l} className="m-0">
                  <a
                    href="#"
                    className="font-text text-sm text-ink-1 no-underline hover:text-accent hover:underline"
                  >
                    {l}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      <div
        className={
          'max-w-page mx-auto mt-7 px-[var(--page-gutter)] pt-5 ' +
          'border-t border-paper-3 ' +
          'flex justify-between flex-wrap gap-4 ' +
          'font-mono text-xs text-ink-2'
        }
      >
        <span>© 2026 Prose Studio · Set in Newsreader, Inter Tight, JetBrains Mono</span>
        <span>v1.0.0 — Made with words.</span>
      </div>
    </footer>
  )
}
