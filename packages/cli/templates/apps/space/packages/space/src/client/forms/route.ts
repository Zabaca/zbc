// Where the Forms tab's screens are. They are paths of the space, under the tab's own: /forms is the clients, /forms/envelopes/<id> an
// envelope. A screen names its places the way it always has (`href('/envelopes')`); this file says where on the address that is.
//
// /forms/api and /forms/logo are the Worker's (src/forms.ts), never a screen: no screen is called "api" or "logo".

/** The Forms tab's own path on the space's address (the company layer's `tabPath('forms')`). */
export const BASE = '/forms'

/** The address of a place in the tab: `/` is the tab itself, `/clients/abc` is `/forms/clients/abc`. A query stays on the end. */
export const href = (to: string): string => (to === '/' ? BASE : `${BASE}${to}`)

/** The place in the tab an address names, with its query: `/forms/envelopes?x=1` is `/envelopes?x=1`; the tab itself is `/`. Null when the address is not in the tab. */
export function placeOf(pathname: string, search = ''): string | null {
  if (pathname === BASE || pathname === `${BASE}/`) return `/${search}`
  if (!pathname.startsWith(`${BASE}/`)) return null
  return `${pathname.slice(BASE.length).replace(/\/+$/, '')}${search}`
}

/**
 * Move to a place in the tab without loading the page again. The space's page listens for `popstate` and reads the address, so a move
 * made here is the same as the browser's own back: one place keeps the address and the screen in step.
 */
export const go = (to: string): void => {
  window.history.pushState(null, '', href(to))
  window.dispatchEvent(new PopStateEvent('popstate'))
}

/**
 * An address from before the screens moved into the space: the admin kept its place in the fragment (`/forms#/clients/abc`, which is
 * where a bookmark of the old forms.northfield.example/admin/#/clients/abc, kept as a hash route, lands). The place it names, or null.
 */
export function legacyPlace(hash: string): string | null {
  if (!hash.startsWith('#/')) return null
  const place = hash.slice(1)
  return place.startsWith('//') ? null : place
}
