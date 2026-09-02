/**
 * `WALGIT_PUBLIC` means the same thing everywhere.
 *
 * The variable used to be read three ways: `flagEnabled` (`1` or `true`) fed
 * `/llms.txt`'s access claim, while `=== '1'` fed the ref-event socket at the
 * edge AND the container's git auth. A deployment spelling it `true` therefore
 * told an agent that reads and writes needed no credential while every clone,
 * push and subscribe answered 401 — the agent wrote the client before finding
 * out.
 *
 * This file is the contract that replaced those three reads: one
 * `capabilitiesFrom` derivation, and the two authorization sites plus the three
 * documents all take their answer from it. It is written as a MATRIX over the
 * spellings rather than as one test per site, because the defect was never in
 * any single site — it was that two of them disagreed, which only a test asking
 * both the same question can catch.
 */
import { describe, expect, test } from 'bun:test'
import { capabilitiesFrom, type CapabilityEnv } from '../shared/capabilities'
import { authorizeSubscribe } from '../shared/events'
import { renderLanding } from '../shared/landing'
import { renderLlms } from '../shared/llms'
import { createHttpHandler } from './http'
import { renderInstructions } from './instructions'

const TOKEN = 's3cret'
const TOKENS = [TOKEN]
const CREDENTIAL = `Bearer ${TOKEN}`

/**
 * Every endpoint a clone or a push actually touches. All three, not one: the
 * gate is a single branch today, and asserting on all three is what would catch
 * a future reader that put reads and writes on different sides of it.
 */
const GIT_ENDPOINTS = [
  ['/alpha.git/info/refs?service=git-upload-pack', 'GET'],
  ['/alpha.git/git-upload-pack', 'POST'],
  ['/alpha.git/git-receive-pack', 'POST'],
] as const

/**
 * One deployment, wired exactly as the two halves wire themselves.
 *
 * The container's `public:` comes from `caps.publicAccess` (`src/server.ts`)
 * and the edge's `isPublic:` comes from the same field (`worker/index.ts`), so
 * asking both here asks the question the ticket is about: do the socket and the
 * git endpoints reach the same verdict from one `Capabilities`?
 */
function deployment(env: CapabilityEnv, tokens: string[] = TOKENS) {
  const caps = capabilitiesFrom(env)
  const handler = createHttpHandler({
    reposDir: '/srv/repos',
    tokens,
    public: caps.publicAccess,
    ensureRepo: (repo) => repo,
    runBackend: async () => new Response('backend ran', { status: 200 }),
    capabilities: caps,
  })

  return {
    caps,
    /**
     * Whether git is served at all, as ONE boolean — the three endpoints are
     * asserted to agree on the way past, so a caller comparing this against the
     * socket is comparing the whole front door and not a sample of it.
     */
    async git(authorization: string | null): Promise<boolean> {
      const verdicts = await Promise.all(
        GIT_ENDPOINTS.map(async ([path, method]) => {
          const res = await handler(
            new Request(`https://walgit.test${path}`, {
              method,
              headers: authorization ? { authorization } : undefined,
            }),
          )
          return res.status !== 401
        }),
      )
      expect(new Set(verdicts).size).toBe(1)
      return verdicts[0]!
    },
    socket: (authorization: string | null): boolean =>
      authorizeSubscribe({ authorization, tokens, isPublic: caps.publicAccess }),
  }
}

/**
 * The four spellings that matter, and what each one is worth.
 *
 * `true` is the behaviour change and the only row whose `open` value moved:
 * everything else here asserts that the widening stayed exactly as wide as
 * `flagEnabled` already was, and did not become "anything truthy".
 */
const SPELLINGS = [
  { label: 'WALGIT_PUBLIC=1', env: { WALGIT_PUBLIC: '1' }, open: true },
  { label: 'WALGIT_PUBLIC=true', env: { WALGIT_PUBLIC: 'true' }, open: true },
  { label: 'WALGIT_PUBLIC unset', env: {}, open: false },
  { label: 'WALGIT_PUBLIC=yes', env: { WALGIT_PUBLIC: 'yes' }, open: false },
] satisfies { label: string; env: CapabilityEnv; open: boolean }[]

describe('the two authorization sites read one value', () => {
  for (const { label, env, open } of SPELLINGS) {
    test(`${label}: git and the socket agree, and both are ${open ? 'open' : 'closed'}`, async () => {
      const it = deployment(env)
      expect(it.caps.publicAccess).toBe(open)

      // The point of the ticket, in one line: the same question, asked of the
      // container's front door and of the edge's socket, gets the same answer.
      const anonymousGit = await it.git(null)
      expect(anonymousGit).toBe(open)
      expect(it.socket(null)).toBe(anonymousGit)
    })

    test(`${label}: a credential is always enough`, async () => {
      const it = deployment(env)
      // Including on the two open rows. The widening must not have cost the
      // token-gated path anything: a deployment that opens up still serves the
      // clients that were already sending a credential.
      expect(await it.git(CREDENTIAL)).toBe(true)
      expect(it.socket(CREDENTIAL)).toBe(true)
    })
  }

  test('a wrong credential is refused wherever a credential is required', async () => {
    const wrong = 'Bearer nope'
    for (const { env, open } of SPELLINGS) {
      const it = deployment(env)
      expect(await it.git(wrong)).toBe(open)
      expect(it.socket(wrong)).toBe(open)
    }
  })
})

describe('failing closed', () => {
  test('no tokens and no public flag still refuses to boot', () => {
    // The guarantee whose regression would be silent and severe: a deployment
    // that loses its secrets must not open to the world.
    expect(() => deployment({}, [])).toThrow(/no tokens configured and public mode is off/)
  })

  test('an unrecognised value does not satisfy the opt-in either', () => {
    // `yes` reads as closed, so it lands in the same refusal — which is the
    // safe direction and the reason the widening stops at `flagEnabled`.
    expect(() => deployment({ WALGIT_PUBLIC: 'yes' }, [])).toThrow(
      /no tokens configured and public mode is off/,
    )
  })

  test('`true` is a real opt-in, so it serves with no tokens', async () => {
    // The widening, stated as a boot decision rather than as a request: a
    // deployment spelling it `true` is now a deployment that CHOSE to be open,
    // and no longer one that is refused for having neither.
    const it = deployment({ WALGIT_PUBLIC: 'true' }, [])
    expect(await it.git(null)).toBe(true)
    expect(it.socket(null)).toBe(true)
  })
})

describe('the documents say what the gate does', () => {
  const HOST = 'walgit.test'
  const ORIGIN = `https://${HOST}`

  /** All three agent-facing documents, rendered from one environment. */
  const documents = (env: CapabilityEnv) => {
    const caps = capabilitiesFrom(env)
    return {
      instructions: renderInstructions(ORIGIN, caps),
      llms: renderLlms(HOST, caps),
      landing: renderLanding(HOST, caps),
    }
  }

  const open = documents({ WALGIT_PUBLIC: '1' })
  const spelledTrue = documents({ WALGIT_PUBLIC: 'true' })
  const closed = documents({})
  const unrecognised = documents({ WALGIT_PUBLIC: 'yes' })

  /**
   * Compared byte-for-byte against the `1` rendering rather than by looking for
   * a sentence. The claim under test is "these are the same deployment", and an
   * assertion on wording would have to be rewritten every time the copy is —
   * which is how a document drifts out of a test's reach in the first place.
   */
  test('`true` renders every document identically to `1`', () => {
    expect(spelledTrue.instructions).toBe(open.instructions)
    expect(spelledTrue.llms).toBe(open.llms)
    expect(spelledTrue.landing).toBe(open.landing)
  })

  test('`yes` renders every document identically to unset', () => {
    expect(unrecognised.instructions).toBe(closed.instructions)
    expect(unrecognised.llms).toBe(closed.llms)
    expect(unrecognised.landing).toBe(closed.landing)
  })

  /**
   * Without this the two equalities above would pass on a renderer that ignored
   * `publicAccess` entirely.
   *
   * The landing page is deliberately NOT asserted here, because today it IS
   * such a renderer: it claims world-readable and world-writable whatever the
   * flag says, which is a separate defect with its own ticket. Its two
   * equalities above are therefore vacuous for now and become load-bearing the
   * moment the page starts reading the field — which is the point of leaving
   * them in.
   */
  test('the two renderings differ, so the equality above is not vacuous', () => {
    expect(open.instructions).not.toBe(closed.instructions)
    expect(open.llms).not.toBe(closed.llms)
  })

  test('a closed deployment teaches an agent how to present a credential', () => {
    // Honest is only half the job: a document that stops claiming public access
    // and says nothing else has told an agent it is locked out without telling
    // it where the key goes.
    expect(closed.instructions).toContain('requires a credential')
    expect(closed.llms).toContain(`https://walgit:$TOKEN@${HOST}/`)
  })
})
