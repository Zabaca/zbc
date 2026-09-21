/**
 * The step between the command line and the watcher: what it fills in, and the
 * seven ways it refuses.
 *
 * Every assertion here used to need a subprocess, because each refusal was an
 * exit. None of them do now — discovery, the environment and the working
 * directory are all passed in.
 */

import { describe, expect, test } from 'bun:test'

import { parseArgs } from './args'
import type { CloneDiscovery } from './clone'
import type { Authorize } from './credential'
import { type ResolveDeps, resolveWatch } from './resolve'

const options = (argv: string[]) => {
  const parsed = parseArgs(argv)
  if (parsed.kind !== 'watch') throw new Error(`expected watch, got ${parsed.kind}`)
  return parsed.options
}

/** A clone of `study-42` on `walgit.example`, standing on `main`. */
const aClone: CloneDiscovery = {
  kind: 'clone',
  root: '/work/study',
  remoteName: 'origin',
  host: 'walgit.example',
  origin: 'https://walgit.example',
  repo: 'study-42',
  ref: 'refs/heads/main',
}

const deps = (over: Partial<ResolveDeps> = {}): ResolveDeps => ({
  env: {},
  cwd: '/work/study',
  discover: () => aClone,
  authorize: () => async () => ({ kind: 'none' }),
  ...over,
})

const resolved = (argv: string[], over: Partial<ResolveDeps> = {}) => {
  const answer = resolveWatch(options(argv), deps(over))
  if (answer.kind !== 'watch') throw new Error(`expected watch, got ${answer.message}`)
  return answer.config
}

const refused = (argv: string[], over: Partial<ResolveDeps> = {}) => {
  const answer = resolveWatch(options(argv), deps(over))
  if (answer.kind !== 'refusal') throw new Error('expected a refusal')
  return answer
}

describe('resolveWatch, filling in what was not said', () => {
  test('bare `watch` in a clone takes the host, the repository, the directory and the ref', () => {
    const config = resolved(['watch'])
    expect(config.origin).toBe('https://walgit.example')
    expect(config.remoteName).toBe('origin')
    expect([...config.targets]).toEqual([['study-42', '/work/study']])
    expect(config.refs).toEqual(['refs/heads/main'])
  })

  test('what was said is never overridden by what git says', () => {
    const config = resolved([
      'watch',
      'other=/elsewhere',
      '--host',
      'walgit.internal',
      '--ref',
      'refs/heads/review',
    ])
    expect(config.origin).toBe('https://walgit.internal')
    expect([...config.targets]).toEqual([['other', '/elsewhere']])
    expect(config.refs).toEqual(['refs/heads/review'])
  })

  test('a named repository with no directory fetches into the clone this is', () => {
    expect([...resolved(['watch', 'other']).targets]).toEqual([['other', '/work/study']])
  })

  test('$AGENTGIT_HOST answers where the clone has no walgit remote', () => {
    const config = resolved(['watch', 'study-42=/work/study', '--ref', 'refs/heads/main'], {
      env: { AGENTGIT_HOST: 'walgit.example' },
      discover: () => ({ kind: 'no-repository' }),
    })
    expect(config.origin).toBe('https://walgit.example')
  })

  test('a detached HEAD watches the repository rather than a branch nobody is on', () => {
    expect(resolved(['watch'], { discover: () => ({ ...aClone, ref: null }) }).refs).toEqual([])
  })

  test('--all-refs keeps the subscription empty even in a clone on a branch', () => {
    expect(resolved(['watch', '--all-refs']).refs).toEqual([])
  })

  test('a token given anywhere is handed to the one authorization, not to a field beside it', () => {
    // Which of a token and a Read Challenge signature is presented is the
    // authorization's decision now; this step only says what was given.
    const asked: (string | null)[] = []
    const authorize = (_origin: string, token: string | null) => {
      asked.push(token)
      return async () => ({ kind: 'none' }) as const
    }
    resolved(['watch', '--token', 'deploy-token'], { authorize })
    resolved(['watch'], { env: { AGENTGIT_TOKEN: 'from-env' }, authorize })
    resolved(['watch'], { authorize })
    expect(asked).toEqual(['deploy-token', 'from-env', null])
  })

  test('discovery is conditional: an invocation that names everything asks git nothing', () => {
    let asked = 0
    resolved(
      ['watch', 'study-42=/work/study', '--host', 'walgit.example', '--ref', 'refs/heads/main'],
      {
        discover: () => {
          asked += 1
          return aClone
        },
      },
    )
    expect(asked).toBe(0)
  })

  test('the pusher lookup is wired only under --proposals', () => {
    expect(resolved(['watch']).pusher).toBeNull()
    expect(typeof resolved(['watch', '--proposals']).pusher).toBe('function')
  })

  test('with no token the authorization is built for the clone’s own origin', () => {
    const asked: string[] = []
    const config = resolved(['watch'], {
      authorize: (origin) => {
        asked.push(origin)
        return async () => ({ kind: 'none' })
      },
    })
    expect(config.authorize).not.toBeNull()
    expect(asked).toEqual(['https://walgit.example'])
  })

  test('the socket and the Proposals read share one authorization, never two', async () => {
    const built: Authorize[] = []
    const config = resolved(['watch', '--proposals'], {
      authorize: () => {
        const one = async () => ({ kind: 'none' }) as const
        built.push(one)
        return one
      },
    })
    expect(built).toHaveLength(1)
    expect(config.authorize).toBe(built[0]!)
  })
})

/**
 * The origin is the host, spelled with a scheme — never a second opinion about
 * which machine is being talked to.
 *
 * The defect this pins: an explicit `--host` won over the clone for the socket
 * while the clone's origin was adopted unconditionally, so the Read Challenge
 * was signed against a host nobody was connected to. The rule is a comparison,
 * not a provenance test — naming a local plain-http node by flag from inside a
 * clone of that node still keeps its scheme.
 */
describe('resolveWatch, deciding the origin', () => {
  /** A clone of a self-hosted node served over plain http, on a port. */
  const localClone: CloneDiscovery = {
    ...aClone,
    host: 'node.local:8080',
    origin: 'http://node.local:8080',
  }

  test('a host that is the clone’s own keeps the clone’s scheme', () => {
    const config = resolved(['watch', '--host', 'node.local:8080'], {
      discover: () => localClone,
    })
    expect(config.origin).toBe('http://node.local:8080')
  })

  test('the comparison ignores case, as host names do', () => {
    const config = resolved(['watch', '--host', 'Node.Local:8080'], {
      discover: () => localClone,
    })
    expect(config.origin).toBe('http://node.local:8080')
  })

  test('a host that is not the clone’s gets an https origin of its own', () => {
    const config = resolved(['watch', '--host', 'walgit.internal'], {
      discover: () => localClone,
    })
    expect(config.origin).toBe('https://walgit.internal')
  })

  test('a port is part of the host: the same name on another port is another host', () => {
    const config = resolved(['watch', '--host', 'node.local'], { discover: () => localClone })
    expect(config.origin).toBe('https://node.local')
  })

  test('$AGENTGIT_HOST is an effective host too, and takes part in the comparison', () => {
    expect(
      resolved(['watch'], { env: { AGENTGIT_HOST: 'node.local:8080' }, discover: () => localClone })
        .origin,
    ).toBe('http://node.local:8080')
    expect(
      resolved(['watch'], { env: { AGENTGIT_HOST: 'walgit.internal' }, discover: () => localClone })
        .origin,
    ).toBe('https://walgit.internal')
  })

  test('outside a clone there is no origin to adopt, so https is derived', () => {
    const config = resolved(['watch', 'study-42=/work/study', '--host', 'walgit.example'], {
      discover: () => ({ kind: 'no-repository' }),
    })
    expect(config.origin).toBe('https://walgit.example')
  })

  test('the authorization is built for the origin the socket will use', () => {
    const asked: string[] = []
    resolved(['watch', '--host', 'walgit.internal'], {
      discover: () => localClone,
      authorize: (origin) => {
        asked.push(origin)
        return async () => ({ kind: 'none' })
      },
    })
    expect(asked).toEqual(['https://walgit.internal'])
  })
})

/**
 * The seven. Each is a returned value now, so each is asserted on its code —
 * which is what a later exit-code split would read — and on the sentence the
 * agent is shown.
 */
describe('resolveWatch, refusing', () => {
  const outside: CloneDiscovery = { kind: 'no-repository' }
  const foreign: CloneDiscovery = {
    kind: 'no-remote',
    root: '/work/github-only',
    ref: 'refs/heads/main',
    remotes: [],
  }

  test('outside a checkout, with nothing named, says so in those words', () => {
    const answer = refused(['watch'], { discover: () => outside })
    expect(answer.code).toBe('no-repository')
    expect(answer.message).toBe(
      'not inside a git repository — name a repository, or run this in a clone',
    )
  })

  test('outside a checkout, with a repository named and no host to send it to', () => {
    const answer = refused(['watch', 'study-42=/work/study'], { discover: () => outside })
    expect(answer.code).toBe('no-host-outside-clone')
    expect(answer.message).toBe(
      'no --host and no $AGENTGIT_HOST, and not inside a clone to read one from',
    )
  })

  test('in a checkout whose remotes are not walgit, with nothing named', () => {
    const answer = refused(['watch'], { discover: () => foreign })
    expect(answer.code).toBe('no-walgit-remote')
    expect(answer.message).toBe(
      'no https remote here that looks like a walgit repository — pass <repo> and --host',
    )
  })

  test('in such a checkout a named repository still needs a host', () => {
    const answer = refused(['watch', 'study-42'], { discover: () => foreign })
    expect(answer.code).toBe('no-host')
    expect(answer.message).toBe('no host: pass --host or set $AGENTGIT_HOST')
  })

  test('--proposals with a detached HEAD has no branch to aim at', () => {
    const answer = refused(['watch', '--proposals'], {
      discover: () => ({ ...aClone, ref: null }),
    })
    expect(answer.code).toBe('proposals-detached-head')
    expect(answer.message).toContain('--proposals needs a branch to aim at')
  })

  test('a repository whose directory could not be filled in is named', () => {
    const answer = refused(['watch', 'study-42', '--host', 'walgit.example'], {
      discover: () => outside,
    })
    expect(answer.code).toBe('no-directory')
    expect(answer.message).toBe('no directory for study-42: pass study-42=<dir>')
  })

  test('a host that is a URL is named rather than concatenated into nonsense', () => {
    const answer = refused(['watch', '--host', 'https://walgit.example'])
    expect(answer.code).toBe('host-is-url')
    expect(answer.message).toBe(
      'host is a URL: pass the host name alone, not https://walgit.example',
    )
  })

  test('the same is true of a host with a path, and of one out of the environment', () => {
    expect(refused(['watch', '--host', 'walgit.example/study-42']).code).toBe('host-is-url')
    expect(refused(['watch'], { env: { AGENTGIT_HOST: 'https://walgit.example' } }).code).toBe(
      'host-is-url',
    )
  })

  test('first one wins: no repository outranks the missing host', () => {
    expect(refused(['watch'], { discover: () => outside, env: {} }).code).toBe('no-repository')
  })

  test('first one wins: a missing host outranks a missing directory', () => {
    const answer = refused(['watch', 'study-42'], { discover: () => outside })
    expect(answer.code).toBe('no-host-outside-clone')
  })
})
