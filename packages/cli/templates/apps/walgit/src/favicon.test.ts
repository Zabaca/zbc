/**
 * The icon routes (`shared/favicon.ts`).
 *
 * Pure, so they are tested with the rest of the suite rather than behind a
 * Workers runtime — the same arrangement as `og-image.test.ts` and
 * `robots.test.ts`. What matters here is what the route does NOT claim: a
 * repository named `favicon.ico` must still be reachable.
 */

import { describe, expect, test } from 'bun:test'

import {
  FAVICON_BODY,
  FAVICON_CONTENT_TYPE,
  FAVICON_PATH,
  ICON_CACHE_CONTROL,
  TOUCH_ICON_PATHS,
  TOUCH_ICON_STATUS,
  wantsFavicon,
  wantsTouchIcon,
} from '../shared/favicon'
import { MARK_SVG } from '../shared/landing'

describe('wantsFavicon', () => {
  test('answers GET and HEAD on the one path', () => {
    expect(wantsFavicon('GET', FAVICON_PATH)).toBe(true)
    expect(wantsFavicon('HEAD', FAVICON_PATH)).toBe(true)
  })

  test('answers nothing else', () => {
    // A push is a POST, and it must reach git rather than a picture.
    expect(wantsFavicon('POST', FAVICON_PATH)).toBe(false)
    expect(wantsFavicon('GET', '/')).toBe(false)
    expect(wantsFavicon('GET', '/favicon.ico/')).toBe(false)
  })

  test('cannot shadow a repository called favicon.ico', () => {
    // smart-HTTP paths are `/<name>.git/…`, so the repository is reached at
    // `/favicon.ico.git/…` and this route never sees it.
    expect(wantsFavicon('GET', '/favicon.ico.git/info/refs')).toBe(false)
    expect(wantsFavicon('POST', '/favicon.ico.git/git-receive-pack')).toBe(false)
    expect(wantsTouchIcon('GET', '/apple-touch-icon.png.git/info/refs')).toBe(false)
  })
})

describe('wantsTouchIcon', () => {
  test('answers GET and HEAD on both touch-icon paths', () => {
    for (const path of TOUCH_ICON_PATHS) {
      expect(wantsTouchIcon('GET', path)).toBe(true)
      expect(wantsTouchIcon('HEAD', path)).toBe(true)
      expect(wantsTouchIcon('POST', path)).toBe(false)
    }
    expect(TOUCH_ICON_PATHS).toEqual([
      '/apple-touch-icon.png',
      '/apple-touch-icon-precomposed.png',
    ])
  })
})

describe('what the edge serves', () => {
  test('the icon is the mark the head inlines, from one constant', () => {
    expect(FAVICON_BODY).toBe(MARK_SVG)
    expect(FAVICON_BODY).toContain('<svg')
    expect(FAVICON_CONTENT_TYPE).toBe('image/svg+xml')
  })

  test('a touch icon is a no-content answer, not a 404 the client retries', () => {
    expect(TOUCH_ICON_STATUS).toBe(204)
  })

  test('and both are cacheable for a day, publicly', () => {
    // The mark states no capability and no limit, so nothing in it can outlive
    // a config change — unlike the page and the manual, which get a minute.
    expect(ICON_CACHE_CONTROL).toBe('public, max-age=86400')
  })
})
