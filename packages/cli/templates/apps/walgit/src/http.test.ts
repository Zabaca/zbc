import { describe, expect, test } from 'bun:test'
import { INTERNAL_HEADER, REJECT_HEADER, SERVED_HEADER } from '../shared/protocol'
import { capabilitiesFrom } from '../shared/capabilities'
import { createHttpHandler, type HttpHandlerDeps, type ProvenanceRead } from './http'

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

  test('a Private repository states its Reader List beside its signers', async () => {
    // The Reader List is derived and stored on the same Claim (docs/adr/0013),
    // so it reaches the Provenance Read the same way the signers do — one
    // field, one route, no second document to go and read.
    const private_ = { ...claimed, readers: ['SHA256:' + 'C'.repeat(43)] }
    const res = await ask(
      provenanceHandler({ readProvenance: async () => ({ provenance: signed, claim: private_ }) }),
    )
    expect(await res.json()).toEqual({ repo: 'alpha', provenance: signed, claim: private_ })
  })

  test('a world-readable repository has no readers field at all', async () => {
    const res = await ask(
      provenanceHandler({ readProvenance: async () => ({ provenance: {}, claim: claimed }) }),
    )
    expect(await res.text()).toBe(
      `${JSON.stringify({ repo: 'alpha', provenance: {}, claim: claimed })}\n`,
    )
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

describe('a read of a repository with no refs', () => {
  /**
   * The bytes below are not this module's own arithmetic played back: each one
   * was captured from `git upload-pack --stateless-rpc` against a real empty
   * bare repository on 2026-09-14 (git 2.43.0), which is what a client is
   * entitled to receive here.
   */
  const ACK_NAK = '0014acknowledgments\n0008NAK\n0000'

  const emptyHandler = (
    overrides: Partial<Parameters<typeof createHttpHandler>[0]> = {},
    onEnsure?: () => void,
  ) =>
    createHttpHandler({
      reposDir: '/srv/repos',
      tokens: ['s3cret'],
      ensureRepo: (repo) => {
        onEnsure?.()
        return repo
      },
      runBackend: async () => new Response('backend ran'),
      readRefs: async () => ({}),
      ...overrides,
    })

  const v2Fetch = (repo = 'fresh', body = '0012command=fetch\n00010012wait-for-done\n0000') =>
    new Request(`https://walgit.test/${repo}.git/git-upload-pack`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer s3cret',
        'git-protocol': 'version=2',
        'content-type': 'application/x-git-upload-pack-request',
      },
      body,
    })

  test('answers a v2 fetch with an acknowledgments section, never a packfile', async () => {
    // The round git actually dies on: `wait-for-done` with every `have`
    // already spent, which real upload-pack answers by opening `packfile`.
    let created = 0
    const res = await emptyHandler({}, () => created++)(v2Fetch())
    expect(res.status).toBe(200)
    expect(await res.text()).toBe(ACK_NAK)
    expect(created).toBe(0)
  })

  test('advertises v2 capabilities for a free name, and creates nothing', async () => {
    let created = 0
    const res = await emptyHandler(
      {},
      () => created++,
    )(
      new Request('https://walgit.test/free.git/info/refs?service=git-upload-pack', {
        headers: { authorization: 'Bearer s3cret', 'git-protocol': 'version=2' },
      }),
    )
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/x-git-upload-pack-advertisement')
    const text = await res.text()
    // `version 2` first and a flush last is what a v2 client parses; the middle
    // is capabilities, and only ones this handler goes on to honour.
    expect(text.startsWith('000eversion 2\n')).toBe(true)
    expect(text.endsWith('0000')).toBe(true)
    expect(text).toContain('ls-refs=unborn')
    expect(text).toContain('fetch=wait-for-done')
    expect(created).toBe(0)
  })

  test('reports no refs, and the unborn HEAD a first push would create', async () => {
    const res = await emptyHandler()(
      v2Fetch('free', '0014command=ls-refs\n0001000bunborn\n000csymrefs\n0000'),
    )
    // Captured from real `upload-pack` against an empty bare repo initialised
    // with `--initial-branch=main`, which is how `cache.ts` creates every one.
    expect(await res.text()).toBe('002eunborn HEAD symref-target:refs/heads/main\n0000')
  })

  test('a repository that holds a ref is served by git, not from here', async () => {
    let created = 0
    const h = emptyHandler(
      { readRefs: async () => ({ 'refs/heads/main': 'a'.repeat(40) }) },
      () => created++,
    )
    expect(await (await h(v2Fetch('alpha'))).text()).toBe('backend ran')
    expect(created).toBe(1)
  })

  test('an Index that cannot be read is served the ordinary way, not as empty', async () => {
    const h = emptyHandler({
      readRefs: async () => {
        throw new Error('store unreachable')
      },
    })
    expect(await (await h(v2Fetch())).text()).toBe('backend ran')
  })

  test('a push to a free name still creates it — only reads are answered here', async () => {
    let created = 0
    const res = await emptyHandler(
      {},
      () => created++,
    )(
      new Request('https://walgit.test/free.git/git-receive-pack', {
        method: 'POST',
        headers: { authorization: 'Bearer s3cret' },
        body: '0000',
      }),
    )
    expect(await res.text()).toBe('backend ran')
    expect(created).toBe(1)
  })

  test('a shape this module will not answer is handed back with its body intact', async () => {
    // `want` against a repository with no objects: not ours to answer, and the
    // hand-back has to leave the request readable by `git http-backend`.
    const request = v2Fetch(
      'fresh',
      `0012command=fetch\n00010032want ${'a'.repeat(40)}\n0009done\n0000`,
    )
    const h = emptyHandler({
      runBackend: async (req) => new Response(await req.request.text()),
    })
    expect(await (await h(request)).text()).toBe(
      `0012command=fetch\n00010032want ${'a'.repeat(40)}\n0009done\n0000`,
    )
  })
})

/**
 * Per-source rate limits (ticket ZBC-YBCWKQ).
 *
 * At this seam because this is the only place that sees BOTH the source the
 * Worker attributed the request to and the repository it names — the hooks see
 * neither. What the handler produces is a verdict; the refusal itself is spoken
 * by `pre-receive`, which is why what is asserted here is the per-request
 * environment the backend is handed rather than a status code.
 */
describe('createHttpHandler: per-source limits', () => {
  const push = (repo: string, ip?: string, bytes = 0) =>
    new Request(`https://walgit.test/${repo}.git/git-receive-pack`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer s3cret',
        ...(ip ? { 'cf-connecting-ip': ip } : {}),
        ...(bytes ? { 'content-length': String(bytes) } : {}),
      },
      body: '0000',
    })

  /** The handler plus what the backend was actually handed, per request. */
  const limited = (env: Record<string, string>, extra: Partial<HttpHandlerDeps> = {}) => {
    const seen: (Record<string, string> | undefined)[] = []
    const h = createHttpHandler({
      reposDir: '/srv/repos',
      tokens: ['s3cret'],
      ensureRepo: (repo) => repo,
      runBackend: async (req) => {
        seen.push(req.env)
        return new Response('backend ran')
      },
      capabilities: capabilitiesFrom(env),
      ...extra,
    })
    return { h, seen }
  }

  test('off by default: nothing about a push changes', async () => {
    const { h, seen } = limited({})
    for (let i = 0; i < 10; i++) {
      expect(await (await h(push('alpha', '203.0.113.7'))).text()).toBe('backend ran')
    }
    expect(seen.every((env) => env?.WALGIT_REFUSE === undefined)).toBe(true)
  })

  test('over the push limit, one source is refused and another is not', async () => {
    const { h, seen } = limited({ WALGIT_MAX_PUSHES_PER_SOURCE: '2' })
    await h(push('alpha', '203.0.113.7'))
    await h(push('alpha', '203.0.113.7'))
    await h(push('alpha', '203.0.113.7'))
    await h(push('alpha', '198.51.100.4'))

    expect(seen[0]?.WALGIT_REFUSE).toBeUndefined()
    expect(seen[1]?.WALGIT_REFUSE).toBeUndefined()
    expect(seen[2]?.WALGIT_REFUSE).toContain('walgit: refused')
    expect(seen[2]?.WALGIT_REFUSE).toContain('2 pushes')
    expect(seen[3]?.WALGIT_REFUSE).toBeUndefined()
  })

  test('the window passes and the source may push again', async () => {
    let now = 1_000_000
    const { h, seen } = limited(
      { WALGIT_MAX_PUSHES_PER_SOURCE: '1', WALGIT_RATE_WINDOW_SECONDS: '60' },
      { now: () => now },
    )
    await h(push('alpha', '203.0.113.7'))
    await h(push('alpha', '203.0.113.7'))
    now += 61_000
    await h(push('alpha', '203.0.113.7'))

    expect(seen[1]?.WALGIT_REFUSE).toContain('walgit: refused')
    expect(seen[2]?.WALGIT_REFUSE).toBeUndefined()
  })

  test('a request walgit cannot attribute to a source is not limited', async () => {
    const { h, seen } = limited({ WALGIT_MAX_PUSHES_PER_SOURCE: '1' })
    await h(push('alpha'))
    await h(push('alpha'))
    expect(seen.every((env) => env?.WALGIT_REFUSE === undefined)).toBe(true)
  })

  test('a read is never rate limited', async () => {
    const { h } = limited({ WALGIT_MAX_PUSHES_PER_SOURCE: '1' })
    const read = () =>
      h(
        new Request('https://walgit.test/alpha.git/git-upload-pack', {
          method: 'POST',
          headers: { authorization: 'Bearer s3cret', 'cf-connecting-ip': '203.0.113.7' },
          body: '0000',
        }),
      )
    await read()
    expect(await (await read()).text()).toBe('backend ran')
  })
  test('a source may create only so many new names, and may still push to its own', async () => {
    // "New" is read from the INDEX — a name holding no ref is one being
    // created — so this handler answers refs for `taken` and none for the rest.
    const { h, seen } = limited(
      { WALGIT_MAX_NEW_REPOS_PER_SOURCE: '1' },
      {
        readRefs: async (repoId): Promise<Record<string, string>> =>
          repoId === 'taken' ? { 'refs/heads/main': 'a'.repeat(40) } : {},
      },
    )
    await h(push('one', '203.0.113.7'))
    await h(push('two', '203.0.113.7'))
    await h(push('taken', '203.0.113.7'))

    expect(seen[0]?.WALGIT_REFUSE).toBeUndefined()
    expect(seen[1]?.WALGIT_REFUSE).toContain('two would be your 2nd new repository this hour')
    expect(seen[2]?.WALGIT_REFUSE).toBeUndefined()
  })

  test('an Index that cannot be read never invents a creation refusal', async () => {
    const { h, seen } = limited(
      { WALGIT_MAX_NEW_REPOS_PER_SOURCE: '1' },
      {
        readRefs: async () => {
          throw new Error('store unreachable')
        },
      },
    )
    await h(push('one', '203.0.113.7'))
    await h(push('two', '203.0.113.7'))
    expect(seen.every((env) => env?.WALGIT_REFUSE === undefined)).toBe(true)
  })

  test('a source may push only so many bytes in the window', async () => {
    const { h, seen } = limited({ WALGIT_MAX_PUSH_BYTES_PER_SOURCE: '1000' })
    await h(push('alpha', '203.0.113.7', 600))
    await h(push('alpha', '203.0.113.7', 600))
    await h(push('alpha', '203.0.113.7', 400))

    expect(seen[0]?.WALGIT_REFUSE).toBeUndefined()
    // Refused, and NOT charged: the third push still fits in what the first
    // one left, so a client is never refused for traffic walgit did not serve.
    expect(seen[1]?.WALGIT_REFUSE).toContain('1000 bytes')
    expect(seen[2]?.WALGIT_REFUSE).toBeUndefined()
  })
})
