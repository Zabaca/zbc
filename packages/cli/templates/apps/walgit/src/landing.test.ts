/**
 * The landing page lives in `worker/`, because the edge is where it has to be
 * answered: a link on an aggregator points at `/`, and none of that traffic
 * should reach the one container serving git. Rendering it is pure, though, so
 * it is tested here with the rest of the suite rather than behind a Workers
 * runtime — the same arrangement as `telemetry.test.ts`.
 */

import { describe, expect, test } from 'bun:test'

import { describeBytes as describeBytesFromLimits } from './limits'
import { describeBytes, renderLanding, wantsLanding } from '../worker/landing'

const FACTS = {
  host: 'agentgit.zabaca.com',
  retentionHours: null,
  maxPushBytes: null,
  maxRepoBytes: null,
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

// The duplication is deliberate (the two halves compile against conflicting
// ambient types), so the thing worth testing is that it stayed a copy: a cap
// read on the page and a refusal read from a hook must never round differently.
test('the page and the push path describe a size the same way', () => {
  for (const bytes of [512, 1024 ** 2, 99 * 1024 * 1024, 250 * 1024 * 1024, 4 * 1024 ** 3]) {
    expect(describeBytes(bytes)).toBe(describeBytesFromLimits(bytes))
  }
})
