/**
 * `/robots.txt` (`shared/robots.ts`).
 *
 * The document exists to say one thing explicitly that Cloudflare's managed
 * file left unsaid, so what is asserted here is that it keeps saying it: an
 * `Allow: /`, a `Content-Signal:` line, and the manual an agent should read
 * next. Rendering is pure, so it is tested with the rest of the suite rather
 * than behind a Workers runtime — the same arrangement as `llms.test.ts`.
 */

import { describe, expect, test } from 'bun:test'

import { CONTENT_SIGNAL, renderRobots, wantsRobots } from '../shared/robots'

const HOST = 'agentgit.zabaca.com'

describe('wantsRobots', () => {
  test('answers GET and HEAD on the one path', () => {
    expect(wantsRobots('GET', '/robots.txt')).toBe(true)
    expect(wantsRobots('HEAD', '/robots.txt')).toBe(true)
  })

  test('answers nothing else', () => {
    expect(wantsRobots('POST', '/robots.txt')).toBe(false)
    expect(wantsRobots('GET', '/')).toBe(false)
    expect(wantsRobots('GET', '/robots.txt/')).toBe(false)
    // A repository called `robots.txt` is reached at `/robots.txt.git/...`, so
    // the document cannot shadow one.
    expect(wantsRobots('GET', '/robots.txt.git/info/refs')).toBe(false)
  })
})

describe('renderRobots', () => {
  test('allows everything, to every agent', () => {
    const doc = renderRobots(HOST)
    expect(doc).toContain('User-agent: *')
    expect(doc).toContain('Allow: /')
    // Silence is what the managed file said and what some crawlers read as no.
    expect(doc).not.toContain('Disallow:')
  })

  test('states the content signal explicitly rather than omitting it', () => {
    expect(renderRobots(HOST)).toContain(`Content-Signal: ${CONTENT_SIGNAL}`)
    expect(CONTENT_SIGNAL).toBe('search=yes, ai-input=yes, ai-train=yes')
  })

  test('points at the manual, on the host the request arrived on', () => {
    const doc = renderRobots('walgit.example')
    expect(doc).toContain('Sitemap: https://walgit.example/llms.txt')
    expect(doc).not.toContain(HOST)
  })

  test('is plain text a crawler parses line by line', () => {
    const doc = renderRobots(HOST)
    expect(doc.endsWith('\n')).toBe(true)
    // Every non-blank line is either a comment or a `Field: value` directive.
    for (const line of doc.split('\n').filter((l) => l !== '')) {
      expect(line.startsWith('#') || /^[A-Za-z-]+: \S/.test(line)).toBe(true)
    }
  })
})
