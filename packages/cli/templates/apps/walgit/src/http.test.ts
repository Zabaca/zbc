import { describe, expect, test } from 'bun:test'
import { INTERNAL_HEADER, REJECT_HEADER, SERVED_HEADER } from '../shared/protocol'
import { createHttpHandler, type ProvenanceRead } from './http'

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

describe('the provenance read', () => {
  const signed = {
    'refs/heads/main': {
      signer: 'SHA256:BMBEMXbMBsnjXwgNs+86IiJrPgYlZEsWxaKZW/2/1dw',
      ts: '2026-08-30T19:00:00.000Z',
    },
  }

  const claimed = {
    signers: ['SHA256:BMBEMXbMBsnjXwgNs+86IiJrPgYlZEsWxaKZW/2/1dw'],
    ts: '2026-08-30T19:00:00.000Z',
  }

  const provenanceHandler = (
    overrides: {
      readProvenance?: (repoId: string) => Promise<ProvenanceRead>
      tokens?: string[]
      public?: boolean
    } = {},
  ) =>
    createHttpHandler({
      reposDir: '/srv/repos',
      tokens: overrides.tokens ?? ['s3cret'],
      public: overrides.public,
      ensureRepo: (repo) => repo,
      runBackend: async () => new Response('backend ran'),
      readProvenance:
        'readProvenance' in overrides
          ? overrides.readProvenance
          : async () => ({ provenance: signed }),
    })

  const ask = (h: (req: Request) => Promise<Response>, repo = 'alpha', auth = 'Bearer s3cret') =>
    h(
      new Request(`https://walgit.test/_walgit/provenance?repo=${repo}`, {
        headers: auth ? { authorization: auth } : {},
      }),
    )

  test('names the Signer recorded for each ref that has one', async () => {
    const res = await ask(provenanceHandler())
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8')
    expect(await res.json()).toEqual({ repo: 'alpha', provenance: signed })
  })

  test('reads the repository the caller asked for, not a fixed one', async () => {
    const asked: string[] = []
    const res = await ask(
      provenanceHandler({
        readProvenance: async (repoId) => {
          asked.push(repoId)
          return { provenance: {} }
        },
      }),
      'beta',
    )
    expect(asked).toEqual(['beta'])
    expect(await res.json()).toEqual({ repo: 'beta', provenance: {} })
  })

  test('a repository nobody signed a push to answers empty, not an error', async () => {
    // The ordinary case on a host where signing is opt-in: the Index carries no
    // `provenance` field at all. A 404 or a 500 here would make every consumer
    // special-case the common answer.
    const res = await ask(provenanceHandler({ readProvenance: async () => ({ provenance: {} }) }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ repo: 'alpha', provenance: {} })
  })

  test('names the repository’s Signer List beside the provenance', async () => {
    // Same Index, same credential, same route (docs/adr/0012): a client that
    // wants to know who may push a name reads it where it already reads who
    // did push it.
    const res = await ask(
      provenanceHandler({
        readProvenance: async () => ({ provenance: signed, claim: claimed }),
      }),
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ repo: 'alpha', provenance: signed, claim: claimed })
  })

  test('an unclaimed repository has no claim field at all, not a null one', async () => {
    // Absence is the answer, and it has exactly one spelling — the same one the
    // Index uses. A `claim: null` would be a second way to say "unclaimed" that
    // every consumer would then have to test for as well.
    const res = await ask(provenanceHandler({ readProvenance: async () => ({ provenance: {} }) }))
    expect(await res.text()).toBe(`${JSON.stringify({ repo: 'alpha', provenance: {} })}\n`)
  })

  test('demands exactly the credential a clone of the repository demands', async () => {
    const missing = await ask(provenanceHandler(), 'alpha', '')
    expect(missing.status).toBe(401)
    expect(missing.headers.get(REJECT_HEADER)).toBe('unauthorized')
    // The same challenge git is sent, so the same client can satisfy it.
    expect(missing.headers.get('www-authenticate')).toBe('Basic realm="walgit"')

    expect((await ask(provenanceHandler(), 'alpha', 'Bearer wrong')).status).toBe(401)

    // And the form CI actually sends, which is the same one `authorizedBy`
    // accepts for a clone — there is no second authorization model here.
    const basic = `Basic ${Buffer.from('walgit:s3cret').toString('base64')}`
    expect((await ask(provenanceHandler(), 'alpha', basic)).status).toBe(200)
  })

  test('a public instance answers anyone, like every other read on it', async () => {
    const res = await ask(provenanceHandler({ tokens: [], public: true }), 'alpha', '')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ repo: 'alpha', provenance: signed })
  })

  test('is not the internal refs endpoint: no INTERNAL_HEADER is needed or accepted as one', async () => {
    // `/_walgit/refs` is the Worker's; this one is a client's. Carrying the
    // internal marker neither helps nor substitutes for the credential.
    const res = await provenanceHandler()(
      new Request('https://walgit.test/_walgit/provenance?repo=alpha', {
        headers: { [INTERNAL_HEADER]: '1' },
      }),
    )
    expect(res.status).toBe(401)
  })

  test('does not exist without a store to read the Index from', async () => {
    // Absent reader means no authoritative answer. Answering `{}` out of a
    // missing log would report "nobody signed anything", which is the one
    // wrong answer this endpoint can give.
    const res = await ask(provenanceHandler({ readProvenance: undefined }))
    expect(res.status).toBe(404)
  })

  test('is a read; nothing else is routed there', async () => {
    const res = await provenanceHandler()(
      new Request('https://walgit.test/_walgit/provenance?repo=alpha', {
        method: 'POST',
        headers: { authorization: 'Bearer s3cret' },
      }),
    )
    expect(res.status).toBe(404)
  })

  test('a bad repo name is refused by the same gate a path goes through', async () => {
    for (const repo of ['..%2f..%2fetc', '', '.hidden']) {
      const res = await ask(provenanceHandler(), repo)
      expect(res.status).toBe(404)
    }
  })
})
