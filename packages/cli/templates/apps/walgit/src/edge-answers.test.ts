/**
 * What the edge answers without waking the container must be what the
 * container would have answered (worker/index.ts). The Worker cannot run here,
 * so these hold its two inputs — `containerRoutes` and `renderInstructions` —
 * against the container's handler instead.
 */
import { describe, expect, test } from 'bun:test'
import { capabilitiesFrom } from '../shared/capabilities'
import { renderInstructions } from '../shared/instructions'
import {
  BROWSE_PATH,
  CHALLENGE_PATH,
  EXPIRE_PATH,
  HEALTH_PATH,
  PROVENANCE_PATH,
  READ_VERDICT_PATH,
  REFS_PATH,
  containerRoutes,
} from '../shared/protocol'
import { classifyRequest } from '../shared/telemetry'
import { createHttpHandler } from './http'

const caps = capabilitiesFrom({ WALGIT_PUBLIC: '1', WALGIT_WEB: '1' })

const publicContainer = () =>
  createHttpHandler({
    reposDir: '/srv/repos',
    tokens: [],
    public: true,
    capabilities: caps,
    ensureRepo: (repo) => repo,
    runBackend: async () => new Response('backend ran'),
  })

describe('containerRoutes', () => {
  test('claims every path the container routes', () => {
    for (const path of [
      '/',
      HEALTH_PATH,
      EXPIRE_PATH,
      REFS_PATH,
      PROVENANCE_PATH,
      CHALLENGE_PATH,
      READ_VERDICT_PATH,
      BROWSE_PATH,
      '/alpha.git/info/refs',
      '/alpha.git/git-upload-pack',
      '/alpha.git/git-receive-pack',
      '/alpha.git/proposals',
    ]) {
      expect(containerRoutes(path)).toBe(true)
    }
  })

  // The scanner baseline from production telemetry, one of each bucket.
  const UNROUTED = [
    '/.env',
    '/.git/config',
    '/wp-login.php',
    '/xmlrpc.php',
    '/.well-known/security.txt',
    '/wp-admin/setup-config.php',
    '/assets/js/app.js',
    '/alpha.git/HEAD',
    '/alpha.git/objects/info/packs',
  ]

  test('a path it disclaims is one the edge would answer as `other`', () => {
    for (const path of UNROUTED) {
      expect(containerRoutes(path)).toBe(false)
      expect(classifyRequest('GET', path, '').kind).toBe('other')
    }
  })

  test('…and the public container answers it with the 404 the edge repeats', async () => {
    const handler = publicContainer()
    for (const path of UNROUTED) {
      for (const method of ['GET', 'POST']) {
        const res = await handler(new Request(`https://walgit.test${path}`, { method }))
        expect(res.status).toBe(404)
        expect(await res.text()).toBe('not found\n')
      }
    }
  })
})

describe('the plain-text `/`', () => {
  test('is the same document whichever half renders it', async () => {
    const res = await publicContainer()(new Request('https://walgit.test/'))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8')
    expect(await res.text()).toBe(renderInstructions('https://walgit.test', caps))
  })
})
