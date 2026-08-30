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
    // The repository name is a field the visitor edits, so the URL in the
    // command is split around it. The host is not: it is whichever hostname
    // this request arrived on, and a page naming a different one would hand a
    // visitor a command that pushes somewhere they have never been.
    expect(page).toContain('https://walgit.zabaca.com/<span id="repo-echo">')
    expect(page).not.toContain('agentgit.zabaca.com')
  })

  /**
   * The name field.
   *
   * Creating a repository here IS naming it, so the name is the only decision
   * the front of the page asks anyone to make, and the only editable thing on
   * it. Everything below is about the command staying true to the field: what a
   * visitor copies has to be what they can see.
   */
  test('the command carries a name a visitor can change', () => {
    const page = renderLanding(FACTS)
    expect(page).toContain('id="repo"')
    expect(page).toContain('<span id="repo-echo">my-thing</span>')
    // Rendered rather than filled in by script, so a page with no JavaScript
    // still offers a command that works.
    expect(page).toContain('value="my-thing"')
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
    expect(page).toContain('Stop asking whether main moved.')
    // The socket's address, in the scheme a socket dials. The frames it
    // exchanges are the manual's — a reader who is going to run the command
    // does not need to see them, and a reader who wants them wants /llms.txt.
    expect(page).toContain('wss://agentgit.zabaca.com/_walgit/events')
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
 * is the cost the stream exists to remove. One command, and what it prints.
 * Everything a reader would need next — the flags, the frames, the four lines
 * the command replaces — is a document away, and naming that document here
 * only spends space on a signpost.
 */
describe('the events section carries a runnable client', () => {
  test('with events on, the page names the published client and how to get it', () => {
    const html = renderLanding({ ...FACTS, events: true })
    expect(html).toContain('bunx @zabaca/agentgit watch')
    // Named, not spelled out twice: what a reader on node needs from this page
    // is that their runtime is not excluded.
    expect(html).toContain('npx')
  })

  // The page argues; it does not index. Every one of these earned its place
  // somewhere else — the manual, the README — and none of them earned it here.
  test('it sells nothing and links nowhere', () => {
    const html = renderLanding({ ...FACTS, events: true })
    expect(html).not.toContain('llms.txt')
    expect(html).not.toContain('SDK: ')
    expect(html).not.toContain('--json')
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
    expect(html).toContain('flags what collides with your uncommitted work')
    expect(html).toContain('COLLIDES with your work in')
  })

  test('with events off, it is absent with everything else', () => {
    const html = renderLanding({ ...FACTS, events: false })
    expect(html).not.toContain('COLLIDES')
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
describe('the rules', () => {
  // Every row makes the reader do something differently: refuse a force push,
  // withhold a secret, copy the work out, sign if they want credit. Durability
  // was the one row that did not — it described the server's disks, which is
  // walgit's business and not a visitor's — so it is stated in the ADR and in
  // the README, and not here.
  test('says nothing about how the server stores anything', () => {
    const page = renderLanding({ ...FACTS, events: true, signedPushes: true })
    expect(page).not.toContain('object storage')
    expect(page).not.toContain('Durable')
  })
})

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
