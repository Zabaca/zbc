/**
 * The step between the command line and the watcher: what it fills in, and the
 * six ways it refuses.
 *
 * Every assertion here used to need a subprocess, because each refusal was an
 * exit. None of them do now — discovery, the environment and the working
 * directory are all passed in.
 */

import { describe, expect, test } from 'bun:test'

import { parseArgs } from './args'
import type { CloneDiscovery } from './clone'
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
  credential: () => async () => null,
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
    expect(config.host).toBe('walgit.example')
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
    expect(config.host).toBe('walgit.internal')
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
    expect(config.host).toBe('walgit.example')
  })

  test('a detached HEAD watches the repository rather than a branch nobody is on', () => {
    expect(resolved(['watch'], { discover: () => ({ ...aClone, ref: null }) }).refs).toEqual([])
  })

  test('--all-refs keeps the subscription empty even in a clone on a branch', () => {
    expect(resolved(['watch', '--all-refs']).refs).toEqual([])
  })

  test('a token given anywhere means no Read Challenge credential to present', () => {
    expect(resolved(['watch', '--token', 'deploy-token']).credential).toBeNull()
    expect(resolved(['watch'], { env: { AGENTGIT_TOKEN: 'from-env' } }).token).toBe('from-env')
    expect(resolved(['watch'], { env: { AGENTGIT_TOKEN: 'from-env' } }).credential).toBeNull()
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

  test('with no token the credential is built for the clone’s own origin', () => {
    const asked: string[] = []
    const config = resolved(['watch'], {
      credential: (origin) => {
        asked.push(origin)
        return async () => `signature for ${origin}`
      },
    })
    expect(config.credential).not.toBeNull()
    expect(asked).toEqual(['https://walgit.example'])
  })
})

/**
 * The six. Each is a returned value now, so each is asserted on its code —
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

  test('first one wins: no repository outranks the missing host', () => {
    expect(refused(['watch'], { discover: () => outside, env: {} }).code).toBe('no-repository')
  })

  test('first one wins: a missing host outranks a missing directory', () => {
    const answer = refused(['watch', 'study-42'], { discover: () => outside })
    expect(answer.code).toBe('no-host-outside-clone')
  })
})
