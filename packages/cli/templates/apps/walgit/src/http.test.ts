import { describe, expect, test } from 'bun:test'
import { createHttpHandler, INTERNAL_HEADER, REJECT_HEADER, SERVED_HEADER } from './http'

const handler = () =>
  createHttpHandler({
    reposDir: '/srv/repos',
    tokens: ['s3cret'],
    ensureRepo: (repo) => repo,
    runBackend: async () => new Response('backend ran', { status: 200 }),
  })

describe('createHttpHandler', () => {
  test('demands a credential, in the form git knows how to supply', async () => {
    const res = await handler()(
      new Request('https://walgit.test/alpha.git/info/refs?service=git-upload-pack'),
    )
    expect(res.status).toBe(401)
    // git only prompts for credentials when the server asks in this scheme.
    expect(res.headers.get('www-authenticate')).toBe('Basic realm="walgit"')
  })

  test('accepts either credential form git and CI actually send', async () => {
    for (const authorization of [
      'Bearer s3cret',
      `Basic ${Buffer.from('walgit:s3cret').toString('base64')}`,
    ]) {
      const res = await handler()(
        new Request('https://walgit.test/alpha.git/info/refs?service=git-upload-pack', {
          headers: { authorization },
        }),
      )
      expect(res.status).toBe(200)
      expect(await res.text()).toBe('backend ran')
    }
  })

  test('a wrong credential is 401, not 404 — the repo list is not a discovery oracle', async () => {
    const res = await handler()(
      new Request('https://walgit.test/alpha.git/info/refs?service=git-upload-pack', {
        headers: { authorization: 'Bearer wrong' },
      }),
    )
    expect(res.status).toBe(401)
  })

  test('serves only the three smart-HTTP endpoints', async () => {
    const authorized = (path: string, method = 'GET') =>
      handler()(
        new Request(`https://walgit.test${path}`, {
          method,
          headers: { authorization: 'Bearer s3cret' },
        }),
      )

    for (const path of [
      '/alpha.git/info/refs?service=git-upload-pack',
      '/alpha.git/git-upload-pack',
      '/alpha.git/git-receive-pack',
    ]) {
      expect((await authorized(path, path.includes('info/refs') ? 'GET' : 'POST')).status).toBe(200)
    }

    // Dumb-HTTP object paths would serve raw loose objects and packs straight
    // off the cache directory, bypassing everything walgit is going to put in
    // front of the repo. Refused.
    for (const path of ['/alpha.git/objects/info/packs', '/alpha.git/HEAD', '/alpha.git']) {
      expect((await authorized(path)).status).toBe(404)
    }
  })

  test('an unresolvable repo name is refused before anything touches the disk', async () => {
    let created = 0
    const h = createHttpHandler({
      reposDir: '/srv/repos',
      tokens: ['s3cret'],
      ensureRepo: (repo) => {
        created++
        return repo
      },
      runBackend: async () => new Response('backend ran'),
    })
    const res = await h(
      new Request('https://walgit.test/..%2f..%2fetc.git/info/refs?service=git-upload-pack', {
        headers: { authorization: 'Bearer s3cret' },
      }),
    )
    expect(res.status).toBe(404)
    expect(created).toBe(0)
  })

  test('serves the instructions at the root, without a credential', async () => {
    // An agent that had to authenticate to learn how to authenticate would
    // have nowhere to start, so this route sits in front of the auth check.
    const res = await handler()(new Request('https://walgit.test/'))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8')
    expect(await res.text()).toContain('git push https://walgit.test/$NAME.git')
  })

  test('the instructions name the host the client actually reached', async () => {
    const res = await handler()(
      new Request('http://10.0.0.3:8080/', {
        headers: { 'x-forwarded-host': 'walgit.zabaca.com', 'x-forwarded-proto': 'https' },
      }),
    )
    expect(await res.text()).toContain('https://walgit.zabaca.com/$NAME.git')
  })

  test('the root is instructions only for a read; nothing else is routed there', async () => {
    const res = await handler()(new Request('https://walgit.test/', { method: 'POST' }))
    expect(res.status).toBe(401)
  })

  test('reports health without a credential, so the platform can probe it', async () => {
    const res = await handler()(new Request('https://walgit.test/_walgit/health'))
    expect(res.status).toBe(200)
  })

  test('stamps every response as its own, so an edge refusal is detectable', async () => {
    for (const request of [
      new Request('https://walgit.test/'),
      new Request('https://walgit.test/_walgit/health'),
      new Request('https://walgit.test/alpha.git/git-upload-pack', {
        method: 'POST',
        headers: { authorization: 'Bearer s3cret' },
      }),
    ]) {
      expect((await handler()(request)).headers.get(SERVED_HEADER)).toBe('1')
    }
  })

  test('names the kind of each refusal it makes, for counting by kind', async () => {
    const unauthorized = await handler()(
      new Request('https://walgit.test/alpha.git/git-upload-pack'),
    )
    expect(unauthorized.headers.get(REJECT_HEADER)).toBe('unauthorized')

    const notFound = await handler()(
      new Request('https://walgit.test/alpha.git/objects/info/packs', {
        headers: { authorization: 'Bearer s3cret' },
      }),
    )
    expect(notFound.headers.get(REJECT_HEADER)).toBe('not-found')

    const unavailable = await createHttpHandler({
      reposDir: '/srv/repos',
      tokens: ['s3cret'],
      ensureRepo: (repo) => repo,
      syncRepo: async () => {
        throw new Error('log unreachable')
      },
      runBackend: async () => new Response('backend ran'),
    })(
      new Request('https://walgit.test/alpha.git/git-upload-pack', {
        method: 'POST',
        headers: { authorization: 'Bearer s3cret' },
      }),
    )
    expect(unavailable.status).toBe(503)
    expect(unavailable.headers.get(REJECT_HEADER)).toBe('unavailable')
  })
})

describe('public mode', () => {
  const publicHandler = () =>
    createHttpHandler({
      reposDir: '/srv/repos',
      tokens: [],
      public: true,
      ensureRepo: (repo) => repo,
      runBackend: async () => new Response('backend ran', { status: 200 }),
    })

  test('serves reads and writes with no Authorization header at all', async () => {
    for (const [path, method] of [
      ['/alpha.git/info/refs?service=git-upload-pack', 'GET'],
      ['/alpha.git/git-upload-pack', 'POST'],
      ['/alpha.git/git-receive-pack', 'POST'],
    ] as const) {
      const res = await publicHandler()(new Request(`https://walgit.test${path}`, { method }))
      expect(res.status).toBe(200)
      expect(await res.text()).toBe('backend ran')
    }
  })

  test('an unknown path is still 404, not an open door', async () => {
    const res = await publicHandler()(
      new Request('https://walgit.test/alpha.git/objects/info/packs'),
    )
    expect(res.status).toBe(404)
  })

  test('health is unauthenticated in both modes', async () => {
    for (const h of [handler(), publicHandler()]) {
      const res = await h(new Request('https://walgit.test/_walgit/health'))
      expect(res.status).toBe(200)
    }
  })

  test('no tokens and no public flag refuses to serve, naming the misconfiguration', async () => {
    expect(() =>
      createHttpHandler({
        reposDir: '/srv/repos',
        tokens: [],
        ensureRepo: (repo) => repo,
        runBackend: async () => new Response('backend ran'),
      }),
    ).toThrow(/no tokens configured and public mode is off/)
  })
})

describe('the internal refs endpoint', () => {
  const refsHandler = (readRefs?: (repoId: string) => Promise<Record<string, string>>) =>
    createHttpHandler({
      reposDir: '/srv/repos',
      tokens: ['s3cret'],
      ensureRepo: (repo) => repo,
      runBackend: async () => new Response('backend ran'),
      readRefs,
    })

  const refs = { 'refs/heads/main': 'a'.repeat(40) }

  test('answers the Worker, with the ref state a handshake is built from', async () => {
    const res = await refsHandler(async () => refs)(
      new Request('https://walgit.test/_walgit/refs?repo=alpha', {
        headers: { [INTERNAL_HEADER]: '1' },
      }),
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ repo: 'alpha', refs })
  })

  test('is unreachable from the internet', async () => {
    // The Worker strips INTERNAL_HEADER from everything it proxies, so a
    // request carrying it can only have been originated by the Worker itself.
    const res = await refsHandler(async () => refs)(
      new Request('https://walgit.test/_walgit/refs?repo=alpha', {
        headers: { authorization: 'Bearer s3cret' },
      }),
    )
    expect(res.status).toBe(404)
  })

  test('does not exist without a store to read the Index from', async () => {
    const res = await refsHandler(undefined)(
      new Request('https://walgit.test/_walgit/refs?repo=alpha', {
        headers: { [INTERNAL_HEADER]: '1' },
      }),
    )
    expect(res.status).toBe(404)
  })

  test('a bad repo name is refused by the same gate a path goes through', async () => {
    const res = await refsHandler(async () => refs)(
      new Request('https://walgit.test/_walgit/refs?repo=../etc', {
        headers: { [INTERNAL_HEADER]: '1' },
      }),
    )
    expect(res.status).toBe(404)
  })
})
