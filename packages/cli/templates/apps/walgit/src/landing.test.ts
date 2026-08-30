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
  signedPushes: false,
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
 * is the cost the stream exists to remove. What the page names is the published
 * command rather than the four lines it wraps — those moved to `/llms.txt`,
 * which the page links to, because a page is read once and a manual is read
 * when it is needed.
 */
describe('the events section carries a runnable client', () => {
  test('with events on, the page names the published client and how to get it', () => {
    const html = renderLanding({ ...FACTS, events: true })
    expect(html).toContain('bunx @zabaca/agentgit watch')
    expect(html).toContain('npx @zabaca/agentgit watch')
    // The claim that survives publishing a client: it is a convenience over the
    // protocol, and the protocol is still one socket and one message.
    expect(html).toContain('There is still no SDK')
    expect(html).toContain('/llms.txt')
  })

  test('with events off, no client is shown', () => {
    const html = renderLanding({ ...FACTS, events: false })
    expect(html).not.toContain('_walgit/events')
    expect(html).not.toContain('@zabaca/agentgit')
  })
})

describe('the page says a push can land on work in progress', () => {
  // Not the git incantation any more — that is the client's job and the
  // manual's. What the page owes a reader is that the question is answered at
  // all, and what the answer looks like when it is yes.
  test('with events on, the collision the client reports is shown', () => {
    const html = renderLanding({ ...FACTS, events: true })
    expect(html).toContain('collide with what you are in the middle of')
    expect(html).toContain('"event":"collides"')
  })

  test('with events off, it is absent with everything else', () => {
    const html = renderLanding({ ...FACTS, events: false })
    expect(html).not.toContain('collides')
  })
})

/**
 * Signing, which is a term rather than an argument.
 *
 * It changes nothing about how anyone uses the service — an unsigned push is
 * accepted exactly as it was — so it belongs in the list of what is true here.
 * And it follows the same rule every limit on this page follows: git refuses
 * `--signed` client-side against a host with no seed, so a page inviting
 * somebody to sign a deployment that cannot accept one would be sending them
 * to a refusal it caused.
 */
describe('the signing term', () => {
  test('with signing on, the page says what a signature buys and what it does not', () => {
    const page = renderLanding({ ...FACTS, signedPushes: true })
    expect(page).toContain('records that key')
    expect(page).toContain('--signed=if-asked')
    // The line the whole design turns on. Losing it would make the page read
    // as a host that prefers signed pushes, which it is not.
    expect(page).toContain('Nothing is refused for being unsigned')
    expect(page).not.toContain('{{')
  })

  test('with signing off, the page never mentions it', () => {
    const page = renderLanding(FACTS)
    expect(page).not.toContain('--signed')
    expect(page).not.toContain('Attributed')
    expect(page).not.toContain('{{')
  })
})

/**
 * The roadmap replaced a "what it is not" section, and the difference matters:
 * the old one listed absences as settled facts, and three of the four were
 * things being built. A page that calls them absences is out of date the day
 * one lands.
 */
describe('the roadmap', () => {
  test('names what is missing, in every deployment', () => {
    const html = renderLanding({ ...FACTS, events: true })
    for (const row of ['Ownership', 'Private', 'Pull requests', 'CI']) {
      expect(html).toContain(row)
    }
  })

  // The one promise on the page that is not rendered from config, so it is the
  // one that has to say it is not a promise.
  test('promises no date', () => {
    expect(renderLanding(FACTS)).toContain('Nothing here is a date')
  })
})
