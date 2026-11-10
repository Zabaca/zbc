// Every screen is a pure function of one Route, parsed from the URL. The
// Worker's asset binding answers every non-API path with index.html, so this
// parse decides what renders. `/w` is the guests' door.

import { normalizeRoomName } from '../model'

export type Route =
  | { view: 'home' }
  | { view: 'guest' }
  | { view: 'call'; name: string; forceRelay: boolean; blurPath: 'auto' | 'canvas'; debug: boolean }

export function parseRoute(pathname: string, search: string): Route {
  if (/^\/w\/?$/.test(pathname)) return { view: 'guest' }
  const m = /^\/r\/([^/]+)\/?$/.exec(pathname)
  let name: string | null = null
  try {
    name = m?.[1] ? normalizeRoomName(decodeURIComponent(m[1])) : null
  } catch {
    name = null
  }
  if (!name) return { view: 'home' }
  const q = new URLSearchParams(search)
  // Three switches: `relay=1` makes the connection use the TURN relay only, `blur=canvas` takes the
  // canvas path for background blur even where the processor path exists, `debug=1` shows the
  // diagnostics panel (what the sound is doing) in the lobby and the call.
  return {
    view: 'call',
    name,
    forceRelay: q.get('relay') === '1',
    blurPath: q.get('blur') === 'canvas' ? 'canvas' : 'auto',
    debug: q.get('debug') === '1',
  }
}

export function hrefFor(route: Route): string {
  switch (route.view) {
    case 'home':
      return '/'
    case 'guest':
      return '/w'
    case 'call':
      return `/r/${route.name}${route.forceRelay ? '?relay=1' : ''}`
  }
}
