/**
 * What a watcher does with a ref that moved, decided before anything happens.
 *
 * `route` is the whole of the Proposals feature that is a decision: which of
 * the three things a Ref Event is — the branch this clone follows, a Proposal
 * aimed at it, or somebody else's business — and what a move of it merged.
 * Everything around it (the socket, the fetch, the emission) acts on that
 * answer, which is why this is the seam and not the process.
 */

import { describe, expect, test } from 'bun:test'

import type { Authorization } from './credential'
import { credentialProblems } from './problem'
import { type Emit, credentialDir, eventsUrl, route, watch } from './watch'

const BRANCH = ['refs/heads/main']

describe('route: without --proposals', () => {
  test('the watched branch is followed, and its merged ids are not reported', () => {
    expect(
      route({ refs: BRANCH, proposals: false }, { ref: 'refs/heads/main', merged: ['fix-auth'] }),
    ).toEqual({ kind: 'ref', merged: [] })
  })

  test('a Proposal is not this watcher’s business', () => {
    expect(
      route({ refs: BRANCH, proposals: false }, { ref: 'refs/walgit/proposals/main/fix-auth' }),
    ).toEqual({ kind: 'ignore' })
  })
})

describe('route: with --proposals', () => {
  const interest = { refs: BRANCH, proposals: true }

  test('a Proposal aimed at the watched branch is reported, with its id and target', () => {
    expect(route(interest, { ref: 'refs/walgit/proposals/main/fix-auth' })).toEqual({
      kind: 'proposal',
      id: 'fix-auth',
      target: 'main',
    })
  })

  test('a Proposal aimed at another branch is ignored', () => {
    expect(route(interest, { ref: 'refs/walgit/proposals/release/fix-auth' })).toEqual({
      kind: 'ignore',
    })
  })

  test('the branch’s own move carries what it merged', () => {
    expect(route(interest, { ref: 'refs/heads/main', merged: ['fix-auth', 'add-cache'] })).toEqual({
      kind: 'ref',
      merged: ['fix-auth', 'add-cache'],
    })
  })

  test('a branch move that merged nothing says so', () => {
    expect(route(interest, { ref: 'refs/heads/main' })).toEqual({ kind: 'ref', merged: [] })
  })

  test('another branch is still ignored — the flag widens the namespace, not the watch', () => {
    expect(route(interest, { ref: 'refs/heads/release', merged: ['fix-auth'] })).toEqual({
      kind: 'ignore',
    })
  })

  test('a malformed Proposal ref — no id segment — is ignored rather than guessed at', () => {
    expect(route(interest, { ref: 'refs/walgit/proposals/main' })).toEqual({ kind: 'ignore' })
  })

  test('a target whose branch name has a slash is matched whole', () => {
    expect(
      route(
        { refs: ['refs/heads/feat/thing'], proposals: true },
        { ref: 'refs/walgit/proposals/feat/thing/fix-auth' },
      ),
    ).toEqual({ kind: 'proposal', id: 'fix-auth', target: 'feat/thing' })
  })

  test('an empty ref list follows everything, and scopes no Proposal namespace', () => {
    expect(route({ refs: [], proposals: true }, { ref: 'refs/heads/anything' })).toEqual({
      kind: 'ref',
      merged: [],
    })
    expect(
      route({ refs: [], proposals: true }, { ref: 'refs/walgit/proposals/main/fix-auth' }),
    ).toEqual({ kind: 'ignore' })
  })
})

/**
 * Where the socket goes, which is the origin and nothing else.
 *
 * The scheme rides across: a deployment served over plain http has a plain-ws
 * event stream, and a subscriber that assumed TLS against it never connects.
 * The hostname is derived here rather than carried alongside, because two
 * fields that must agree are two fields an edit can make disagree.
 */
describe('eventsUrl', () => {
  test('an https origin is a wss socket', () => {
    expect(eventsUrl('https://agentgit.co')).toBe('wss://agentgit.co/_walgit/events')
  })

  test('a plain-http origin is a plain-ws socket, port and all', () => {
    expect(eventsUrl('http://node.local:8080')).toBe('ws://node.local:8080/_walgit/events')
  })
})

/**
 * Which clone's git config decides the authorization this watcher presents.
 *
 * `user.signingkey` is git config, and a repository-local one wins for a push,
 * so it has to win for the read a watch is — but only where there IS one
 * repository to mean. This is the whole of that rule, and the socket is the
 * only thing around it.
 */
describe('credentialDir', () => {
  test('one target means that checkout, so a repository-local key decides it', () => {
    expect(credentialDir(new Map([['study-42', '/work/study']]), '/elsewhere')).toBe('/work/study')
  })

  test('several checkouts mean none of them: the invocation directory answers', () => {
    const many = new Map([
      ['a', '/work/a'],
      ['b', '/work/b'],
    ])
    expect(credentialDir(many, '/elsewhere')).toBe('/elsewhere')
  })

  test('no targets at all is the invocation directory too', () => {
    expect(credentialDir(new Map(), '/elsewhere')).toBe('/elsewhere')
  })
})

describe('watch: the authorization it got', () => {
  /**
   * A watcher that cannot present a credential says why, through the emitter
   * every other line goes through — the whole point of reporting it as an event
   * rather than on stderr. Closed immediately, so the socket is never opened:
   * the report is made before that decision, which is what makes the diagnosis
   * survive a host that is not there.
   */
  const said = async (answer: Authorization): Promise<Record<string, unknown>[]> => {
    const events: Record<string, unknown>[] = []
    const emit: Emit = (event, fields) => void events.push({ event, ...fields })
    const problems = credentialProblems()
    const watcher = watch({
      origin: 'https://walgit.example',
      cwd: '/work/study',
      authorize: async () => answer,
      targets: new Map([['study-42', '/work/study']]),
      refs: ['refs/heads/main'],
      remoteName: 'origin',
      fetch: false,
      once: false,
      onChange: null,
      ffOnClean: false,
      json: false,
      proposals: false,
      emit,
      problems,
    })
    watcher.close()
    await Promise.resolve()
    await Promise.resolve()
    return events
  }

  test('a credential problem reaches the emitter, with the origin it is about', async () => {
    expect(
      await said({ kind: 'problem', code: 'no-signing-key', message: 'no key to prove' }),
    ).toEqual([
      {
        event: 'credential-problem',
        origin: 'https://walgit.example',
        code: 'no-signing-key',
        problem: 'no key to prove',
      },
    ])
  })

  test('an ordinary public watch says nothing about credentials', async () => {
    expect(await said({ kind: 'none' })).toEqual([])
  })
})
