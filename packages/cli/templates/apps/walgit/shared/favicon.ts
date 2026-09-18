/**
 * `/favicon.ico` and the touch icons — the requests a browser makes without
 * being asked.
 *
 * The head already carries the mark as a data URI (`shared/landing.ts`), which
 * is enough for Chrome and Firefox and is not enough for anyone else: Safari,
 * most link unfurlers and every feed reader ask for `/favicon.ico` regardless.
 * Until this module existed those requests fell through to the container and
 * came back 404 — during the 2026-09-18 launch burst, ~282 of them in two
 * hours, tracking landing page views nearly one for one. Every one was a
 * container round trip for a file the edge can answer from a string constant.
 *
 * So the same shape `shared/robots.ts` and `shared/og-image.ts` have: this
 * module states the paths, the methods and the headers, the Worker owns the
 * response. Runtime-neutral (docs/adr/0010), so a test reaches it with no
 * runtime.
 *
 * No collision with a repository, the same argument the other two make:
 * smart-HTTP paths are `/<name>.git/…`, so a repository literally called
 * `favicon.ico` is reached at `/favicon.ico.git/…` and is untouched by this
 * route.
 */

import { MARK_SVG } from './landing'

/** The one icon path every client asks for whatever the head says. */
export const FAVICON_PATH = '/favicon.ico'

/**
 * The two paths iOS and macOS ask for when a page is bookmarked, neither of
 * which is declared in the head. There is no raster to serve them, and a
 * missing one is not an error worth a body — see `TOUCH_ICON_STATUS`.
 */
export const TOUCH_ICON_PATHS = ['/apple-touch-icon.png', '/apple-touch-icon-precomposed.png']

/**
 * The bytes are the mark the head inlines, read from the one constant, so the
 * tab icon and the masthead cannot drift apart.
 *
 * Served as SVG under a `.ico` name deliberately: the extension is what clients
 * request, and every client that requests it honours the `content-type` over
 * the name. An actual ICO would be a second rendering of the same mark to keep
 * in sync, which is the thing this whole file exists to avoid.
 */
export const FAVICON_BODY = MARK_SVG
export const FAVICON_CONTENT_TYPE = 'image/svg+xml'

/**
 * 204: there is no raster, and a 404 is what the browser retries. A no-content
 * answer is the cheapest way to say "there is nothing here, stop asking", and
 * with the cache header below it is asked once a day rather than once a page.
 */
export const TOUCH_ICON_STATUS = 204

/**
 * A day, for the same reason the card's picture gets one (`shared/og-image.ts`):
 * the mark states no capability and no limit, so nothing in it can outlive a
 * config change, and this is exactly the traffic worth absorbing at the edge.
 */
export const ICON_CACHE_CONTROL = 'public, max-age=86400'

/** Only GET or HEAD on the one path. A POST to it is git, and falls through. */
export function wantsFavicon(method: string, pathname: string): boolean {
  if (method !== 'GET' && method !== 'HEAD') return false
  return pathname === FAVICON_PATH
}

/** Only GET or HEAD on the two touch-icon paths. */
export function wantsTouchIcon(method: string, pathname: string): boolean {
  if (method !== 'GET' && method !== 'HEAD') return false
  return TOUCH_ICON_PATHS.includes(pathname)
}
