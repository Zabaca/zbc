// The Forms tab: forms' admin screens, drawn as part of the space's own page (ADR 0007). They are React components of this bundle,
// in the space's look, and they ask forms' operator API at /forms/api, which the Worker hands to forms (src/forms.ts).
//
// The tab's sections are a tree in the rail on a computer (FormsTree, under the Forms tab as Conversations has its views) and a row
// across the top of the screen on a phone, where the rail is a strip of four tabs and has no room. A screen's own links are the
// admin's links (`href()` in route.ts); a click on one moves inside the page, like the rail's, unless it means "open it elsewhere".
import { type ReactNode, useEffect } from 'react'
import './forms.css'
import { followForms } from './FormsTree'
import { Notice } from './kit'
import { ROUTES } from './routes'
import { BASE, href, legacyPlace, placeOf } from './route'
import { NAV, isOn } from './sections'

type Go = (path: string) => void

function Screen({ place }: { place: string }) {
  const [path = '/', query = ''] = place.split('?')
  for (const r of ROUTES) {
    const m = r.match.exec(path)
    if (m) return <>{r.screen(m, new URLSearchParams(query))}</>
  }
  return (
    <Notice kind="info">
      There is nothing at this address. <a className="underline" href={href('/clients')}>Back to clients</a>
    </Notice>
  )
}

/** The screen the path is on, with the sections across the top on a phone. */
export function FormsTab({ pathname, search, go }: { pathname: string; search: string; go: Go }): ReactNode {
  const place = placeOf(pathname, search) ?? '/'

  // An address from before the screens moved in (/forms#/clients/abc) names its place in the fragment: say it in the path.
  useEffect(() => {
    const legacy = pathname === BASE ? legacyPlace(window.location.hash) : null
    if (!legacy) return
    window.history.replaceState(null, '', href(legacy))
    window.dispatchEvent(new PopStateEvent('popstate'))
  }, [pathname])

  // A move to another screen starts at its top: the page scrolls inside `main`, not the window.
  useEffect(() => {
    document.querySelector('main.main')?.scrollTo?.(0, 0)
  }, [pathname])

  return (
    <div className="forms-tab" data-testid="forms-tab" onClick={(e) => followForms(e, go)}>
      <nav aria-label="Forms sections" className="forms-sections" data-testid="forms-sections">
        {NAV.map((n) => (
          <a key={n.to} href={href(n.to)} className={`forms-section${isOn(n, place) ? ' on' : ''}`} aria-current={isOn(n, place) ? 'page' : undefined}>
            {n.label}
          </a>
        ))}
      </nav>
      <div className="mx-auto grid max-w-5xl gap-4 px-4 py-5 sm:px-7 sm:py-6" data-testid="forms-screen">
        <Screen place={place} />
      </div>
    </div>
  )
}
