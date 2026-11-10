// The Forms tab's sections as a tree under the tab in the rail, in the same look as the inbox's views under Conversations, and the click that moves inside the page.
// Not in FormsTab.tsx: that file brings every screen with it and is loaded when the tab is first opened, while the rail is there on every tab.
import type { MouseEvent, ReactNode } from 'react'
import { BASE, href, placeOf } from './route'
import { NAV, isOn } from './sections'

type Go = (path: string) => void

/** The prefixes of /forms that are the Worker's, not screens (src/forms.ts): a link to one is a file or an image and is left to the browser. */
const WORKER_OWNED = [`${BASE}/api/`, `${BASE}/logo/`]

/** A plain click on a link to a screen of the tab moves inside the page; anything else (a new tab, a download, the API) is the browser's. */
export function followForms(e: MouseEvent<HTMLElement>, go: Go): void {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
  const a = (e.target as HTMLElement).closest?.('a')
  if (!a || !e.currentTarget.contains(a) || a.target || a.hasAttribute('download')) return
  const url = new URL(a.href, window.location.href)
  if (url.origin !== window.location.origin || WORKER_OWNED.some((p) => url.pathname.startsWith(p))) return
  if (placeOf(url.pathname, url.search) === null) return
  e.preventDefault()
  go(`${url.pathname}${url.search}`)
}

/** The sections as a tree under the Forms tab in the rail, in the same look as the inbox's views under Conversations. */
export function FormsTree({ pathname, search, go }: { pathname: string; search: string; go: Go }): ReactNode {
  const place = placeOf(pathname, search) ?? '/'
  return (
    <div className="tree" data-testid="forms-tree" onClick={(e) => followForms(e, go)}>
      {NAV.map((n) => (
        <a key={n.to} href={href(n.to)} className={`t-item${isOn(n, place) ? ' on' : ''}`} aria-current={isOn(n, place) ? 'page' : undefined} data-testid="forms-section">
          <span className="t-label">{n.label}</span>
        </a>
      ))}
    </div>
  )
}
