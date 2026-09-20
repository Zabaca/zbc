/**
 * What the two web-view pages share: the look, and the one cache rule.
 *
 * `shared/repo-list.ts` and `shared/browse.ts` are one product — a reader moves
 * between them by clicking — and they were each carrying their own copy of the
 * stylesheet and of the "cachable only where a read takes no credential" line.
 * A token change then needed two edits, and the second one is the edit nobody
 * makes: the review of the list itself found four such copies (`shortBytes`,
 * `escapeHtml`, the pool, the store reading) and ended them, so a fifth is not
 * a thing to start.
 *
 * Runtime-neutral like everything here (docs/adr/0010): a stylesheet is a
 * string and a cache header is a string.
 */

import type { Capabilities } from './capabilities'

/**
 * The web view's stylesheet — one inline block, no build step, no request.
 *
 * Every page that uses it carries a CSP that permits `style-src 'unsafe-inline'`
 * and nothing else, which is what makes an inline block the whole of the
 * styling rather than the first of several resources.
 */
export const WEB_STYLE = `  :root { color-scheme: light dark; --ink: #14100e; --ground: #ede6de; --muted: #6b635c; --accent: #c56a3e; }
  @media (prefers-color-scheme: dark) { :root { --ink: #ede6de; --ground: #14100e; --muted: #9a9088; } }
  body { margin: 0; padding: 2rem 1.25rem 4rem; background: var(--ground); color: var(--ink);
    font: 15px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
  main { max-width: 52rem; margin: 0 auto; }
  h1 { font-size: 1rem; font-weight: 600; margin: 0 0 1rem; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: .35rem .5rem; border-bottom: 1px solid color-mix(in srgb, var(--muted) 30%, transparent); }
  th { font-weight: 600; color: var(--muted); }
  td.f, th.f { text-align: right; white-space: nowrap; color: var(--muted); }
  a { color: var(--accent); }
  .tag { font-size: .8em; color: var(--muted); border: 1px solid var(--muted); border-radius: 3px; padding: 0 .3em; }
  .note { color: var(--muted); }`

/**
 * A minute where a read takes no credential, nothing otherwise.
 *
 * The second half is the one that matters: a shared cache must not hold a
 * document that exists only because THIS request presented a token.
 */
export const webCacheControl = (caps: Capabilities): string =>
  caps.publicAccess ? 'public, max-age=60' : 'private, no-store'
