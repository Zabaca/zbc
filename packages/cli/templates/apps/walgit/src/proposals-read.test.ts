/**
 * The Proposal read surface (docs/adr/0018): `GET /<name>.git/proposals`.
 *
 * Tested at `createHttpHandler`, the seam the whole front door lives behind and
 * the one `src/private-read.test.ts` uses — routing, the deployment credential
 * and the Private gate are one ordering question, and only a test that asks the
 * real handler can catch the three being put on the wrong sides of each other.
 *
 * What is NOT stubbed is the part the feature is about. `merged` is
 * `merge-base --is-ancestor` against the Cache, so the handler's reader is
 * wired to the real `listProposals` over a REAL temporary repository: a
 * fast-forward, a true merge and a squash are claims about what git answers,
 * and none of them is observable against a double that returns whatever the
 * test already believes.
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { capabilitiesFrom, type CapabilityEnv } from '../shared/capabilities'
import { createHttpHandler, type HttpHandlerDeps } from './http'
import { gitAncestry, listProposals } from './proposals'
import type { Claim, Provenance } from './wal-index'

const SEED = 'read-seed'
const NOW = 1_757_000_000_000
const SIGNER = 'SHA256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
const READER = 'SHA256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const PROPOSER = 'SHA256:ddddddddddddddddddddddddddddddddddddddddddd'

/** Everything a Proposal needs to be offered at all (`shared/capabilities.ts`). */
const PROPOSALS_ON: CapabilityEnv = {
  WALGIT_PUBLIC: '1',
  WALGIT_SIGNER_LISTS: '1',
  WALGIT_PUSH_CERT_SEED: 'cert-seed',
  WALGIT_PROPOSALS: '1',
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'walgit-proposals-read-'))
afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }))

const git = (cwd: string, ...args: string[]) => {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (res.status !== 0) throw new Error(`git ${args.join(' ')}: ${res.stderr}`)
  return res.stdout.trim()
}

/**
 * A repository as the host holds one: a bare repo on disk (the Cache, which
 * ancestry is computed against) and the refs the Index records.
 *
 * `main` holds one commit; `fix-auth` is a Proposal branch two commits further
 * on, pushed to `refs/walgit/proposals/main/fix-auth` and not merged.
 */
let bare: string
let work: string
let refs: Record<string, string>
let proposalTip: string

beforeEach(() => {
  const root = fs.mkdtempSync(path.join(scratch, 'case-'))
  bare = path.join(root, 'alpha.git')
  git(root, 'init', '--bare', '--quiet', '--initial-branch=main', bare)

  work = path.join(root, 'work')
  git(root, 'init', '--quiet', '-b', 'main', work)
  git(work, 'config', 'user.email', 'walgit@example.test')
  git(work, 'config', 'user.name', 'walgit')
  fs.writeFileSync(path.join(work, 'a'), 'one\n')
  git(work, 'add', 'a')
  git(work, 'commit', '--quiet', '-m', 'one')
  const mainOid = git(work, 'rev-parse', 'HEAD')
  git(work, 'push', '--quiet', bare, 'main:refs/heads/main')

  git(work, 'checkout', '--quiet', '-b', 'fix-auth')
  fs.writeFileSync(path.join(work, 'b'), 'two\n')
  git(work, 'add', 'b')
  git(work, 'commit', '--quiet', '-m', 'two')
  fs.writeFileSync(path.join(work, 'b'), 'three\n')
  git(work, 'commit', '--quiet', '-am', 'three')
  proposalTip = git(work, 'rev-parse', 'HEAD')
  git(work, 'push', '--quiet', bare, 'fix-auth:refs/walgit/proposals/main/fix-auth')

  refs = {
    'refs/heads/main': mainOid,
    'refs/walgit/proposals/main/fix-auth': proposalTip,
  }
})

/** Move `refs/heads/main` in the Cache and in the Index, as a push would. */
function pushTarget(branch: string) {
  git(work, 'push', '--quiet', '--force', bare, `${branch}:refs/heads/main`)
  refs['refs/heads/main'] = git(work, 'rev-parse', branch)
}

const provenance: Record<string, Provenance> = {
  'refs/walgit/proposals/main/fix-auth': {
    signer: PROPOSER,
    ts: '2026-09-14T00:00:00.000Z',
  },
}

/**
 * A signature, as this test spells one: `<key> over <nonce>` — the shape
 * `src/private-read.test.ts` uses, and for the same reason: it carries no
 * colon, exactly as an armoured SSH signature carries none.
 */
const signature = (fingerprint: string, nonce: string) =>
  `${fingerprint.replace('SHA256:', '')} over ${nonce}`

const verifyRead = (message: string, sig: string): string | null => {
  const [key, nonce] = sig.split(' over ')
  return key && nonce === message ? `SHA256:${key}` : null
}

const credentialFor = (fingerprint: string, nonce: string) =>
  `Basic ${btoa(`${fingerprint}:${signature(fingerprint, nonce)}`)}`

function deployment(
  overrides: Partial<HttpHandlerDeps> = {},
  env: CapabilityEnv = PROPOSALS_ON,
): (path: string, authorization?: string | null, method?: string) => Promise<Response> {
  const handler = createHttpHandler({
    reposDir: path.dirname(bare),
    tokens: [],
    public: true,
    ensureRepo: (repo) => repo,
    runBackend: async () => new Response('backend ran', { status: 200 }),
    capabilities: capabilitiesFrom(env),
    readProposals: async () => listProposals(refs, provenance, gitAncestry(bare)),
    ...overrides,
  })
  return (p, authorization = null, method = 'GET') =>
    handler(
      new Request(`https://walgit.test${p}`, {
        method,
        headers: authorization ? { authorization } : undefined,
      }),
    )
}

const PATH = '/alpha.git/proposals'

describe('the listing', () => {
  test('names each open Proposal, its target and tip, and who pushed it', async () => {
    const res = await deployment()(PATH)

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      repo: 'alpha',
      proposals: [
        {
          id: 'fix-auth',
          target: 'main',
          tip: proposalTip,
          pusher: PROPOSER,
          merged: false,
        },
      ],
    })
  })

  test('is not cachable: the next push changes every answer in it', async () => {
    const res = await deployment()(PATH)
    expect(res.headers.get('cache-control')).toBe('no-store')
  })

  test('reads `null` for a Proposal the Index records no Signer for', async () => {
    const res = await deployment({
      readProposals: async () => listProposals(refs, {}, gitAncestry(bare)),
    })(PATH)

    expect(await res.json()).toMatchObject({ proposals: [{ pusher: null }] })
  })

  test('is a GET: anything else is not a route', async () => {
    expect((await deployment()(PATH, null, 'POST')).status).toBe(404)
  })

  test('404s a name walgit would not serve', async () => {
    // A leading dot is outside `REPO_ID`, so it is a name no other endpoint
    // would resolve either — refused here before anything is read.
    expect((await deployment()('/.hidden.git/proposals')).status).toBe(404)
  })
})

describe('merged', () => {
  test('is true once the target fast-forwards onto the Proposal tip', async () => {
    pushTarget('fix-auth')

    const res = await deployment()(PATH)

    expect(await res.json()).toMatchObject({ proposals: [{ merged: true }] })
  })

  test('is true once the target takes a true merge of the Proposal', async () => {
    git(work, 'checkout', '--quiet', 'main')
    fs.writeFileSync(path.join(work, 'c'), 'elsewhere\n')
    git(work, 'add', 'c')
    git(work, 'commit', '--quiet', '-m', 'elsewhere')
    git(work, 'merge', '--quiet', '--no-ff', '-m', 'merge fix-auth', 'fix-auth')
    pushTarget('main')

    const res = await deployment()(PATH)

    expect(await res.json()).toMatchObject({ proposals: [{ merged: true }] })
  })

  test('stays false when the same commits land as a squash', async () => {
    git(work, 'checkout', '--quiet', 'main')
    git(work, 'merge', '--quiet', '--squash', 'fix-auth')
    git(work, 'commit', '--quiet', '-m', 'squashed fix-auth')
    pushTarget('main')

    // The content landed and the Proposal is still open: merged is ancestry and
    // a squash produces a commit the Proposal's tip is no ancestor of.
    const res = await deployment()(PATH)

    expect(await res.json()).toMatchObject({
      proposals: [{ tip: proposalTip, merged: false }],
    })
  })
})

describe('a Private name', () => {
  const PRIVATE_CLAIM: Claim = {
    signers: [SIGNER],
    readers: [READER],
    ts: '2026-09-12T00:00:00.000Z',
  }

  const gated = (claim: Claim | undefined) =>
    deployment({
      privateReads: {
        seed: SEED,
        readClaim: async () => claim,
        verifyRead,
        now: () => NOW,
      },
    })

  test('refuses a stranger with the Read Challenge rather than hiding the name', async () => {
    const res = await gated(PRIVATE_CLAIM)(PATH)

    expect(res.status).toBe(401)
    expect(res.headers.get('www-authenticate')).toContain('walgit-ssh nonce=')
  })

  test('serves a listed Reader that answered it', async () => {
    const { nonce } = (await (await gated(PRIVATE_CLAIM)('/_walgit/challenge')).json()) as {
      nonce: string
    }

    const res = await gated(PRIVATE_CLAIM)(PATH, credentialFor(READER, nonce))

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ proposals: [{ id: 'fix-auth' }] })
  })

  test('refuses everyone when the Reader List cannot be read', async () => {
    const res = await deployment({
      privateReads: {
        seed: SEED,
        readClaim: async () => {
          throw new Error('store down')
        },
        verifyRead,
        now: () => NOW,
      },
    })(PATH)

    expect(res.status).toBe(401)
  })
})

describe('the deployment', () => {
  test('does not answer at all with the Proposals capability off', async () => {
    const res = await deployment({}, { ...PROPOSALS_ON, WALGIT_PROPOSALS: undefined })(PATH)
    expect(res.status).toBe(404)
  })

  test('does not answer with no store to read an Index from', async () => {
    const res = await deployment({ readProposals: undefined })(PATH)
    expect(res.status).toBe(404)
  })

  test('refuses rather than inventing an empty list when the Index is unreachable', async () => {
    const res = await deployment({
      readProposals: async () => {
        throw new Error('store down')
      },
    })(PATH)

    expect(res.status).toBe(503)
  })
})
