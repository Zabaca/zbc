/**
 * Footer.tsx — multi-column footer.
 * Desktop:        5 cols (brand wide + 4 link cols).
 * Tablet ≤960px:  2 cols, brand spans full width.
 * Mobile ≤480px:  single column.
 * Layout lives in globals.css (.prose-footer).
 */

const COLS = [
  { h: 'System', links: ['Manual', 'Stylesheet', 'Components', 'Changelog'] },
  { h: 'Examples', links: ['Hero set', 'Editorial', 'Pricing patterns', 'Showcase'] },
  { h: 'Studio', links: ['Pricing', 'Licensing', 'Contact'] },
  { h: 'Elsewhere', links: ['GitHub ↗', 'Twitter ↗', 'RSS'] },
]

export function Footer() {
  return (
    <footer className="prose-footer">
      <div className="prose-footer__grid">
        <div className="prose-footer__brand">
          <span
            style={{
              fontFamily: 'var(--font-display)',
              fontSize: 'var(--fs-2xl)',
              letterSpacing: 'var(--tr-tighter)',
              fontWeight: 500,
              color: 'var(--ink-0)',
              display: 'block',
              marginBottom: 'var(--sp-3)',
            }}
          >
            Prose<span style={{ color: 'var(--accent)' }}>.</span>
          </span>
          <p
            style={{
              fontFamily: 'var(--font-text)',
              fontSize: 'var(--fs-sm)',
              fontStyle: 'italic',
              color: 'var(--ink-2)',
              maxWidth: '30ch',
              margin: 0,
            }}
          >
            A text-only design system for landing pages.
          </p>
        </div>

        {COLS.map((col) => (
          <div key={col.h}>
            <h3 className="prose-footer__col-title">{col.h}</h3>
            <ul className="prose-footer__list">
              {col.links.map((l) => (
                <li key={l}>
                  <a href="#">{l}</a>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      <div className="prose-footer__meta">
        <span>© 2026 Prose Studio · Set in Newsreader, Inter Tight, JetBrains Mono</span>
        <span>v1.0.0 — Made with words.</span>
      </div>
    </footer>
  )
}
