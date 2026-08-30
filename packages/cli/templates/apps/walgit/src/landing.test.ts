/**
 * The landing page is answered at the edge, because a link on an aggregator
 * points at `/` and none of that traffic should reach the one container serving
 * git. Rendering it is pure, so the module lives in `shared/` and is tested
 * here with the rest of the suite rather than behind a Workers runtime — the
 * same arrangement as `telemetry.test.ts`.
 */

import { describe, expect, test } from 'bun:test'

import { renderLanding, wantsLanding } from '../shared/landing'

const FACTS = {
  host: 'agentgit.zabaca.com',
  retentionHours: null,
  maxPushBytes: null,
  maxRepoBytes: null,
  events: false,
}

describe('wantsLanding', () => {
  test('a browser asking for HTML at the root gets the page', () => {
    expect(wantsLanding('GET', '/', 'text/html,application/xhtml+xml,*/*;q=0.8')).toBe(true)
    expect(wantsLanding('HEAD', '/', 'text/html')).toBe(true)
  })

  // The whole safety property of serving two things at one URL: git must never
  // be handed markup where it expects the protocol.
  test('git and curl keep the plain-text instructions', () => {
    expect(wantsLanding('GET', '/', '*/*')).toBe(false)
    expect(wantsLanding('GET', '/', '')).toBe(false)
    expect(wantsLanding('GET', '/', 'application/x-git-upload-pack-advertisement')).toBe(false)
  })

  test('only the root, and only a read', () => {
    expect(wantsLanding('GET', '/repo.git/info/refs', 'text/html')).toBe(false)
    expect(wantsLanding('POST', '/', 'text/html')).toBe(false)
    expect(wantsLanding('GET', '/_walgit/health', 'text/html')).toBe(false)
  })
})

describe('renderLanding', () => {
  test('every command names the host the request arrived on', () => {
    const page = renderLanding({ ...FACTS, host: 'walgit.zabaca.com' })
    expect(page).toContain('https://walgit.zabaca.com/my-thing.git')
    expect(page).not.toContain('agentgit.zabaca.com')
  })

  test('no placeholder survives into the page', () => {
    const page = renderLanding({ ...FACTS, retentionHours: 24, maxPushBytes: 1024 ** 2 })
    expect(page).not.toContain('{{')
  })

  // The point of rendering from the env rather than from copy: a page that
  // promised a window nothing collects would be a lie told at the top of the
  // funnel.
  test('with no retention set, the page promises no window', () => {
    const page = renderLanding(FACTS)
    expect(page).not.toContain('24 hours')
    expect(page).not.toContain('is collected')
    expect(page).toContain('nothing about this service is a promise to keep your history')
  })

  test('with retention set, the window is stated twice and agrees with itself', () => {
    const page = renderLanding({ ...FACTS, retentionHours: 24 })
    expect(page).toContain('A repository lives 24 hours from its last push.')
    expect(page).toContain('Not permanent: 24 hours from the last push, a repository is collected.')
  })

  test('with no retention but caps set, the third claim becomes the caps', () => {
    const page = renderLanding({ ...FACTS, maxPushBytes: 99 * 1024 * 1024 })
    expect(page).toContain('99 MiB (103809024 bytes) per push')
  })

  test('a deployment that enforces nothing makes no third claim at all', () => {
    const page = renderLanding(FACTS)
    expect(page).not.toContain('per push')
    expect(page).not.toContain('per repository')
  })
})

describe('the ref-event stream on the page', () => {
  test('with events on, the page describes the same capability', () => {
    const page = renderLanding({ ...FACTS, events: true, host: 'agentgit.zabaca.com' })
    expect(page).toContain('And nobody configures a webhook.')
    expect(page).toContain('wss://agentgit.zabaca.com/_walgit/events')
    expect(page).toContain('&lt;- {"ok":true')
    expect(page).not.toContain('{{')
  })

  // The same rule the limits follow: a page describing a socket the deployment
  // does not claim would 404 whoever believed it.
  test('with events off, the page does not mention it', () => {
    const page = renderLanding(FACTS)
    expect(page).not.toContain('_walgit/events')
    expect(page).not.toContain('WebSocket')
    expect(page).not.toContain('{{')
  })
})

/**
 * The client on the page.
 *
 * `GET /` is the whole API surface, and the answer to "how do I use this" has
 * to be on it: an agent that cannot find the client from here will poll, which
 * is the cost the stream exists to remove.
 */
describe('the events section carries a runnable client', () => {
  test('with events on, the page shows a client that fetches', () => {
    const html = renderLanding({ ...FACTS, events: true })
    expect(html).toContain('new WebSocket("wss://agentgit.zabaca.com/_walgit/events")')
    expect(html).toContain('git","fetch"')
    // Escaped, because the page is HTML and an unescaped arrow would close the
    // <pre> in the middle of the one thing a reader is meant to copy.
    expect(html).not.toContain('=>w.send')
  })

  test('with events off, no client is shown', () => {
    const html = renderLanding({ ...FACTS, events: false })
    expect(html).not.toContain('_walgit/events')
    expect(html).not.toContain('git","fetch"')
  })
})

describe('the page shows how to tell if it landed on your work', () => {
  test('with events on, the collision check is on the page', () => {
    const html = renderLanding({ ...FACTS, events: true })
    expect(html).toContain('git stash create')
    expect(html).toContain('merge-tree --write-tree --name-only')
  })

  test('with events off, it is absent with everything else', () => {
    const html = renderLanding({ ...FACTS, events: false })
    expect(html).not.toContain('merge-tree')
  })
})
