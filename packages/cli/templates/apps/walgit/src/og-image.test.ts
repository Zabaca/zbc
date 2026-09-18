/**
 * The card's picture (`shared/og-image.ts`).
 *
 * The raster itself is a committed asset the Worker bundles; what is decided
 * here is everything around it — which path answers, which methods, and the
 * headers a crawler is served. Pure, so it is tested with the rest of the
 * suite rather than behind a Workers runtime, the same arrangement as
 * `robots.test.ts`.
 */

import { describe, expect, test } from 'bun:test'

import {
  OG_IMAGE_CACHE_CONTROL,
  OG_IMAGE_CONTENT_TYPE,
  OG_IMAGE_HEIGHT,
  OG_IMAGE_PATH,
  OG_IMAGE_WIDTH,
  wantsOgImage,
} from '../shared/og-image'

describe('wantsOgImage', () => {
  test('answers GET and HEAD on the one path', () => {
    expect(wantsOgImage('GET', '/agentgit-og.png')).toBe(true)
    expect(wantsOgImage('HEAD', '/agentgit-og.png')).toBe(true)
  })

  test('answers nothing else', () => {
    // A push is a POST, and it must reach git rather than a picture.
    expect(wantsOgImage('POST', '/agentgit-og.png')).toBe(false)
    expect(wantsOgImage('GET', '/')).toBe(false)
    expect(wantsOgImage('GET', '/agentgit-og.png/')).toBe(false)
    // A repository called `agentgit-og.png` is reached at
    // `/agentgit-og.png.git/…`, so the picture cannot shadow one.
    expect(wantsOgImage('GET', '/agentgit-og.png.git/info/refs')).toBe(false)
    expect(wantsOgImage('POST', '/agentgit-og.png.git/git-receive-pack')).toBe(false)
  })
})

describe('the served card picture', () => {
  // The dimensions are the ones a large-summary card is specified at, and the
  // ones the head advertises; the rendered PNG is asserted against the same
  // two numbers in `landing.test.ts`'s head assertions.
  test('is a 1200×630 PNG at a stable path', () => {
    expect(OG_IMAGE_PATH).toBe('/agentgit-og.png')
    expect(OG_IMAGE_WIDTH).toBe(1200)
    expect(OG_IMAGE_HEIGHT).toBe(630)
    expect(OG_IMAGE_CONTENT_TYPE).toBe('image/png')
  })

  // Unlike the page and the manual, the picture states no capability and no
  // limit, so nothing in it can outlive a config change — it is cacheable for
  // a day rather than for the page's minute.
  test('and is cacheable for a day, publicly', () => {
    expect(OG_IMAGE_CACHE_CONTROL).toBe('public, max-age=86400')
  })
})
